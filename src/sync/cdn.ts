/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { buildAvatarUrl } from "../cdnUrl";
import { CDN_CHECK_TIMEOUT_MS, CDN_CONTROL_TTL_MS, GAP_FILL_STAGGER_MS } from "../config";
import { getHistory, removeRecord } from "../store";

const log = new Logger("AvatarHistory");

const pendingCdnChecks = new Map<string, Promise<boolean | null>>();

export type CdnExistsChecker = (
    userId: string,
    hash: string,
    formats: Array<"png" | "gif" | "webp">,
    avatarId?: string
) => Promise<boolean | null>;

/** Injectable default — tests can pass their own checker to purgeInvalidRecords. */
export const defaultCdnExistsChecker: CdnExistsChecker = (userId, hash, formats, avatarId) =>
    checkCdnExists(userId, hash, formats, avatarId);

/**
 * Tri-state CDN check: true = confirmed image, false = confirmed missing,
 * null = inconclusive (timeout, or the CDN itself is unreachable). On null the
 * recording flow records optimistically and the purge flow keeps the record.
 */
export async function checkCdnExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean | null> {
    // The format list belongs in the key: the same hash is probed with
    // different lists (tracking vs sniffer/purge) and the verdict follows
    // the list probed — a shared entry would hand one caller the other's.
    const key = `${userId}:${hash}:${avatarId ?? ""}:${formats.join(",")}`;
    const existing = pendingCdnChecks.get(key);
    if (existing) return existing;
    const promise = cdnAvatarExists(userId, hash, formats, avatarId).finally(() => {
        pendingCdnChecks.delete(key);
    });
    pendingCdnChecks.set(key, promise);
    return promise;
}

/**
 * A long-lived asset on the same CDN, used to tell "the avatar is gone" from
 * "the network is gone".
 *
 * Discord's CDN only sends `Access-Control-Allow-Origin` on success, so a
 * `fetch()` of a missing avatar *rejects* instead of returning 404 — an outage
 * and a deleted hash were indistinguishable, which is why this check used to
 * return `null` for everything and purge never removed anything. `<img>` loads
 * are not subject to CORS and a 404 body (`application/json`) fails to decode,
 * so `onerror` here really does mean "not an image".
 *
 * Known limit: `<img>` exposes no status code, so a 5xx that hits one avatar
 * URL while the control asset is still healthy reads as "missing". Real
 * avatars are edge-cached for a year and purge only ever drops records without
 * a local blob, so the worst case is losing one history row.
 */
const CDN_CONTROL_URL = "https://cdn.discordapp.com/embed/avatars/0.png";

type ProbeResult = "ok" | "error" | "timeout";

/** Loads `url` through a throwaway `<img>`: CORS-free, and only a decodable
 *  image resolves. */
function probeImage(url: string): Promise<ProbeResult> {
    return new Promise(resolve => {
        const img = new Image();
        // One mutable holder: `finish` has to clear the timer, and the timer has
        // to call `finish`, so neither can be a `const` declared first.
        const state = { settled: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        const finish = (result: ProbeResult): void => {
            if (state.settled) return;
            state.settled = true;
            clearTimeout(state.timer);
            img.onload = null;
            img.onerror = null;
            resolve(result);
        };
        state.timer = setTimeout(() => finish("timeout"), CDN_CHECK_TIMEOUT_MS);
        img.onload = () => finish("ok");
        img.onerror = () => finish("error");
        img.src = url;
    });
}

let controlCheckedAt = 0;
let controlAlive = false;

/** Whether the CDN is reachable at all, cached for `CDN_CONTROL_TTL_MS`. */
async function cdnReachable(): Promise<boolean> {
    const now = Date.now();
    if (now - controlCheckedAt < CDN_CONTROL_TTL_MS) return controlAlive;
    // Cache-busted: an answer cached from before the network dropped would make
    // every later failure look like a confirmed 404.
    controlAlive = await probeImage(`${CDN_CONTROL_URL}?cb=${now}`) === "ok";
    controlCheckedAt = now;
    log.info(`CDN control asset: ${controlAlive ? "alive" : "dead"}`);
    return controlAlive;
}

export async function cdnAvatarExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean | null> {
    const startedAt = Date.now();
    // One line per verdict instead of one per URL: a check can walk up to six
    // URL shapes, and this is what tells "CDN said no" from "network said no".
    const verdict = (result: string): void => {
        log.info(`CDN ${userId}/${hash}: ${result} (${Date.now() - startedAt}ms)`);
    };
    for (const fmt of formats) {
        const urls = avatarId
            ? [buildAvatarUrl(userId, hash, fmt, 256, avatarId), buildAvatarUrl(userId, hash, fmt, 256)]
            : [buildAvatarUrl(userId, hash, fmt, 256)];
        for (const url of urls) {
            const probe = await probeImage(url);
            if (probe === "ok") {
                verdict("exists");
                return true;
            }
            // Timeout is inconclusive on its own, and so is `error` while the
            // control asset is failing too — never call a flaky network "missing".
            if (probe === "timeout" || !await cdnReachable()) {
                verdict(probe === "timeout" ? "timeout → inconclusive" : "control asset unreachable → inconclusive");
                return null;
            }
            // Confirmed not-an-image: try the remaining formats/URL shapes.
        }
    }
    verdict("missing");
    return false;
}

export async function purgeInvalidRecords(userId: string, checker: CdnExistsChecker = defaultCdnExistsChecker): Promise<number> {
    const recs = getHistory(userId).filter(r => !r.hasBlob);
    let removed = 0;
    // Paced like every other record walk (fillHistoryGaps, the sweep): one
    // blob-less record can cost six back-to-back CDN probes, and purge runs
    // at startup and after every server pull. Between records, not after —
    // a kept record `continue`s past any sleep at the tail of the loop.
    let paced = false;
    for (const rec of recs) {
        if (paced) await new Promise(r => setTimeout(r, GAP_FILL_STAGGER_MS));
        paced = true;
        const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp"] : ["png", "webp", "gif"];
        // Only remove on a definitively negative check — never drop a valid
        // record over a flaky network.
        if ((await checker(userId, rec.hash, formats, rec.avatarId)) !== false) continue;
        await removeRecord(userId, rec);
        removed++;
        log.info(`Removed invalid avatar ${rec.hash} for ${userId}`);
    }
    if (removed) log.info(`Purged ${removed} invalid avatar record(s) for ${userId}`);
    return removed;
}
