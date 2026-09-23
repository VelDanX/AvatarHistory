/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import {
    CDN_AVATAR_MARKER,
    RESOURCE_SWEEP_INTERVAL_MS,
    SEEN_LIMIT
} from "../config";
import { AvatarRecord, getHistory, recordAvatarSeen, updateRecord } from "../store";
import { checkCdnExists } from "./cdn";

const log = new Logger("AvatarHistory");

const CDN_AVATAR_RE = /\/avatars\/(\d+)\/(?:archived\/(\d+)\/)?(a_)?([0-9a-f]{32})\.(?:png|gif|webp|jpe?g)/i;
const BG_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

let observer: MutationObserver | null = null;
let sweepTimer: number | null = null;
let waitReady: Promise<void> | null = null;
let enabled: () => boolean = () => false;
let shouldTrackUser: (userId: string) => boolean = () => false;
let found = 0;
let storeWasReady = false;
const seen = new Set<string>();
let lastResourceIndex = 0;

// Remembers the last scanned src/srcset signature per <img> so the periodic
// sweep skips images whose URL did not change since the previous pass.
const lastScannedSignature = new WeakMap<HTMLImageElement, string>();

function manageSeenLimit(): void {
    if (seen.size < SEEN_LIMIT) return;
    const excess = seen.size - SEEN_LIMIT;
    let dropped = 0;
    for (const key of seen) {
        if (dropped >= excess) break;
        seen.delete(key);
        dropped++;
    }
}

function makeRecord(raw: string, avatarId?: string): AvatarRecord | null {
    const match = raw.match(/^(a_)?([0-9a-f]{32})$/i);
    if (!match) return null;
    const animated = Boolean(match[1]);
    return {
        hash: (animated ? "a_" : "") + match[2].toLowerCase(),
        avatarId,
        timestamp: Date.now(),
        format: animated ? "gif" : "png",
        size: 0,
        hasBlob: false,
        width: 0,
        height: 0,
    };
}

export async function recordHash(userId: string, hash: string, avatarId?: string): Promise<void> {
    if (!enabled()) return;
    if (!storeWasReady) {
        if (waitReady) await waitReady;
        storeWasReady = true;
        if (!enabled()) return;
    }
    if (!shouldTrackUser(userId)) return;
    const key = `${userId}:${hash}`;
    if (seen.has(key)) return;
    const rec = makeRecord(hash, avatarId);
    if (!rec) return;
    seen.add(key);
    manageSeenLimit();
    const known = getHistory(userId).find(r => r.hash === rec.hash);
    if (known) {
        if (avatarId && known.avatarId !== avatarId) {
            updateRecord(userId, known, { avatarId });
        }
        return;
    }
    const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp"] : ["png", "webp", "gif"];
    const exists = await checkCdnExists(userId, rec.hash, formats, avatarId);
    if (exists === false) {
        log.info(`Skipped avatar ${rec.hash}: not a valid CDN image for ${userId}`);
        seen.delete(key);
        return;
    }
    // exists === null (network inconclusive): record optimistically — purge will
    // clean it up later if it really doesn't exist.
    await recordAvatarSeen(userId, rec);
    found++;
    log.info(`Synced avatar ${rec.hash} from Discord for ${userId}`);
}

function scanSources(el: HTMLElement, scan: (url: string | undefined) => void): void {
    if (el.tagName === "IMG") {
        const img = el as HTMLImageElement;
        scan(img.currentSrc || img.src);
        if (img.srcset) for (const part of img.srcset.split(",")) scan(part.trim().split(/\s+/)[0]);
    }
    const styleAttr = el.getAttribute("style");
    if (styleAttr?.includes("url(")) for (const m of styleAttr.matchAll(BG_URL_RE)) scan(m[1]);
}

/** Cheap pre-filter: skip URLs that cannot possibly be a Discord avatar CDN link. */
function maybeAvatarUrl(url: string | undefined): boolean {
    return !!url && url.includes(CDN_AVATAR_MARKER);
}

function handleNode(node: Node): void {
    if (!(node instanceof Element)) return;
    const scan = (url: string | undefined): void => {
        if (!maybeAvatarUrl(url)) return;
        const m = url!.match(CDN_AVATAR_RE);
        if (m) void recordHash(m[1], (m[3] ?? "") + m[4], m[2]);
    };
    scanSources(node as HTMLElement, scan);
    for (const el of node.querySelectorAll<HTMLElement>("img")) scanSources(el, scan);
}

const pendingNodes = new Set<Node>();
let observerScheduled = false;

function scheduleHandle(node: Node): void {
    pendingNodes.add(node);
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(() => {
        observerScheduled = false;
        const nodes = [...pendingNodes];
        pendingNodes.clear();
        for (const n of nodes) handleNode(n);
    });
}

function installObserver(): void {
    if (observer) return;
    observer = new MutationObserver(muts => {
        for (const mut of muts) {
            if (mut.type === "attributes") {
                scheduleHandle(mut.target);
                continue;
            }
            for (const node of mut.addedNodes) scheduleHandle(node);
        }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "style"] });
}

export function sweepResourceTiming(): void {
    const entries = performance.getEntriesByType("resource");
    if (lastResourceIndex > entries.length) lastResourceIndex = 0;
    for (let i = lastResourceIndex; i < entries.length; i++) {
        const { name } = entries[i];
        if (!name.includes(CDN_AVATAR_MARKER)) continue;
        const m = name.match(CDN_AVATAR_RE);
        if (m) void recordHash(m[1], (m[3] ?? "") + m[4], m[2]);
    }
    lastResourceIndex = entries.length;

    const scan = (url: string | undefined): void => {
        if (!maybeAvatarUrl(url)) return;
        const m = url!.match(CDN_AVATAR_RE);
        if (m) void recordHash(m[1], (m[3] ?? "") + m[4], m[2]);
    };
    for (const el of document.querySelectorAll<HTMLImageElement>("img")) {
        // Skip images whose src/srcset we already scanned in a previous sweep.
        const sig = `${el.currentSrc || el.src}|${el.srcset ?? ""}`;
        if (lastScannedSignature.get(el) === sig) continue;
        lastScannedSignature.set(el, sig);
        scanSources(el, scan);
    }
}

export function startRecentSync(isEnabled: () => boolean, ready: Promise<void>, isTrackedUser: (userId: string) => boolean): void {
    enabled = isEnabled;
    shouldTrackUser = isTrackedUser;
    waitReady = ready;
    if (observer) return;
    installObserver();
    sweepTimer = window.setInterval(sweepResourceTiming, RESOURCE_SWEEP_INTERVAL_MS);
    sweepResourceTiming();
    log.info("Recent-avatar sync active");
}

export function stopRecentSync(): void {
    observer?.disconnect();
    observer = null;
    if (sweepTimer != null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    enabled = () => false;
    shouldTrackUser = () => false;
    waitReady = null;
    storeWasReady = false;
    seen.clear();
    lastResourceIndex = 0;
}

export function isSniffingEnabled(): boolean {
    return enabled();
}

/** How many avatars `recordHash` found this session (for "added" counts). */
export function getFoundCount(): number {
    return found;
}
