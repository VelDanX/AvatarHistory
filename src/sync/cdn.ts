/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { buildAvatarUrl } from "../cdnUrl";
import { CDN_HEAD_TIMEOUT_MS } from "../config";
import { getHistory, removeRecord } from "../store/history";

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
 * Tri-state CDN check:
 *  - true  — confirmed: the URL returns an actual image
 *  - false — confirmed missing / not an image
 *  - null  — inconclusive (network error, timeout, 5xx) — callers must decide:
 *            recording flow treats it as "record optimistically", purge flow
 *            treats it as "keep the record".
 */
export async function checkCdnExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean | null> {
    const key = `${userId}:${hash}:${avatarId ?? ""}`;
    const existing = pendingCdnChecks.get(key);
    if (existing) return existing;
    const promise = cdnAvatarExists(userId, hash, formats, avatarId).finally(() => {
        pendingCdnChecks.delete(key);
    });
    pendingCdnChecks.set(key, promise);
    return promise;
}

export async function cdnAvatarExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean | null> {
    for (const fmt of formats) {
        const urls = avatarId
            ? [buildAvatarUrl(userId, hash, fmt, 256, avatarId), buildAvatarUrl(userId, hash, fmt, 256)]
            : [buildAvatarUrl(userId, hash, fmt, 256)];
        for (const url of urls) {
            try {
                const control = new AbortController();
                const timer = setTimeout(() => control.abort(), CDN_HEAD_TIMEOUT_MS);
                const res = await fetch(url, {
                    method: "HEAD",
                    credentials: "omit",
                    signal: control.signal,
                });
                clearTimeout(timer);
                if (!res.ok) {
                    // 5xx is "unknown", not "missing" — never treat as confirmed-absent.
                    if (res.status >= 500) return null;
                    continue;
                }
                const ct = (res.headers.get("Content-Type") ?? "").toLowerCase();
                if (!ct.startsWith("image/")) return false;
                const cl = Number(res.headers.get("Content-Length") ?? "0");
                if (cl > 0 && cl < 1000) return false;
                return true;
            } catch {
                // Timeout / abort / network failure — inconclusive.
                return null;
            }
        }
    }
    return false;
}

export async function purgeInvalidRecords(userId: string, checker: CdnExistsChecker = defaultCdnExistsChecker): Promise<number> {
    const recs = getHistory(userId).filter(r => !r.hasBlob);
    let removed = 0;
    for (const rec of recs) {
        const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp"] : ["png", "webp", "gif"];
        // Only remove when the CDN check is *definitively* negative — never
        // delete a valid record because of a flaky network.
        if ((await checker(userId, rec.hash, formats, rec.avatarId)) !== false) continue;
        await removeRecord(userId, rec);
        removed++;
        log.info(`Removed invalid avatar ${rec.hash} for ${userId}`);
    }
    if (removed) log.info(`Purged ${removed} invalid avatar record(s) for ${userId}`);
    return removed;
}
