/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { RestAPI, Toasts, UserStore } from "@webpack/common";

import { AvatarRecord, fetchAvatarBlob, getHistory, persistHistory, recordAvatarSeen, removeRecord } from "./store";

const log = new Logger("AvatarHistory");

const CDN_AVATAR_RE = /\/avatars\/(\d+)\/(?:archived\/(\d+)\/)?(a_)?([0-9a-f]{32})\.(?:png|gif|webp|jpe?g)/i;
const HASH_RE = /^(a_)?[0-9a-f]{32}$/i;

let observer: MutationObserver | null = null;
let sweepTimer: number | null = null;
let waitReady: Promise<void> | null = null;
let enabled: () => boolean = () => false;
let shouldTrackUser: (userId: string) => boolean = () => false;
let found = 0;
let storeWasReady = false;
const SEEN_LIMIT = 10000;
const seen = new Set<string>();
let lastResourceIndex = 0;

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

function selfId(): string | null {
    return UserStore.getCurrentUser()?.id ?? null;
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

async function recordHash(userId: string, hash: string, avatarId?: string): Promise<void> {
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
            known.avatarId = avatarId;
            await persistHistory();
        }
        return;
    }
    const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp"] : ["png", "webp", "gif"];
    if (!(await checkCdnExists(userId, rec.hash, formats, avatarId))) {
        log.info(`Skipped avatar ${rec.hash}: not a valid CDN image for ${userId}`);
        // Don't keep the key in `seen`: the CDN may simply not have propagated
        // the brand-new avatar yet. Let a later render/sweep re-check it.
        seen.delete(key);
        return;
    }
    await recordAvatarSeen(userId, rec);
    found++;
    log.info(`Synced avatar ${rec.hash} from Discord for ${userId}`);
}

function parseRecentList(body: unknown): Array<{ avatarId?: string; hash: string }> {
    const out: Array<{ avatarId?: string; hash: string }> = [];
    const hashes = new Set<string>();
    const add = (hash: string, avatarId?: string): void => {
        if (hashes.has(hash)) return;
        hashes.add(hash);
        out.push({ avatarId, hash });
    };

    // Documented shape: `{ avatars: [{ id, storage_hash, ... }] }`; a plain
    // array of entries is accepted as well. Only `storage_hash` is
    // authoritative. The old implementation greedily collected ANY string that
    // looked like a 32-hex hash anywhere in the response, which for the current
    // avatar could yield two hashes of the same picture (the canonical and a
    // smaller spec variant) and duplicate history entries after every restart.
    const list: unknown[] | null = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { avatars?: unknown }).avatars)
            ? (body as { avatars: unknown[] }).avatars
            : null;

    if (list) {
        for (const entry of list) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const obj = entry as Record<string, unknown>;
            const sh = obj.storage_hash;
            if (typeof sh === "string" && HASH_RE.test(sh)) {
                add(sh, typeof obj.id === "string" ? obj.id : undefined);
            }
        }
        return out;
    }

    // Unknown shape (defensive): still only trust `storage_hash` values, never
    // bare strings, so a future schema change can't reintroduce duplicates.
    const walk = (v: unknown): void => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) {
            for (const item of v) walk(item);
            return;
        }
        const obj = v as Record<string, unknown>;
        const sh = obj.storage_hash;
        if (typeof sh === "string" && HASH_RE.test(sh)) {
            add(sh, typeof obj.id === "string" ? obj.id : undefined);
        }
        for (const child of Object.values(v)) walk(child);
    };
    walk(body);
    return out;
}

export async function pullRecentFromServer(): Promise<number> {
    const userId = selfId();
    if (!userId || !enabled()) return 0;
    const before = found;
    try {
        const data: any = await RestAPI.get({ url: "/users/@me/avatars" });
        const body = data?.body ?? data;
        const recents = parseRecentList(body);
        const recs = getHistory(userId);
        // The newest archive entry is the current avatar. If it carries a
        // different hash than the live avatar (Discord serves the current
        // avatar under a canonical and a smaller spec hash) and the live one is
        // already recorded, the archived variant is just a twin of the current
        // avatar — don't add it as a second, visually identical entry.
        const liveHash = UserStore.getCurrentUser()?.avatar?.toLowerCase() ?? null;
        for (let i = 0; i < recents.length; i++) {
            const { hash, avatarId } = recents[i];
            if (i === 0 && liveHash && hash.toLowerCase() !== liveHash && recs.some(r => r.hash === liveHash)) continue;
            await recordHash(userId, hash, avatarId);
        }
        for (const rec of recents) {
            const known = getHistory(userId).find(r => r.hash.toLowerCase() === rec.hash.toLowerCase());
            if (known && !known.hasBlob) void fetchAvatarBlob(userId, known);
        }
    } catch (e) {
        log.warn("Failed to pull recent avatars", e);
    }
    return found - before;
}

const BG_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

const pendingCdnChecks = new Map<string, Promise<boolean>>();

/**
 * Like `cdnAvatarExists`, but dedupes concurrent checks for the same avatar,
 * so a hash that shows up in several places at once only hits the CDN once.
 */
export async function checkCdnExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean> {
    const key = `${userId}:${hash}:${avatarId ?? ""}`;
    const existing = pendingCdnChecks.get(key);
    if (existing) return existing;
    const promise = cdnAvatarExists(userId, hash, formats, avatarId).finally(() => {
        pendingCdnChecks.delete(key);
    });
    pendingCdnChecks.set(key, promise);
    return promise;
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

function handleNode(node: Node): void {
    if (!(node instanceof Element)) return;
    const scan = (url: string | undefined): void => {
        if (!url) return;
        const m = url.match(CDN_AVATAR_RE);
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
            // Catch in-place avatar swaps (e.g. Discord changing <img src> of
            // an already-mounted element on an avatar update).
            if (mut.type === "attributes") {
                scheduleHandle(mut.target);
                continue;
            }
            for (const node of mut.addedNodes) scheduleHandle(node);
        }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "style"] });
}

function sweepResourceTiming(): void {
    const entries = performance.getEntriesByType("resource");
    if (lastResourceIndex > entries.length) lastResourceIndex = 0;
    for (let i = lastResourceIndex; i < entries.length; i++) {
        const m = entries[i].name.match(CDN_AVATAR_RE);
        if (m) void recordHash(m[1], (m[3] ?? "") + m[4], m[2]);
    }
    lastResourceIndex = entries.length;

    const scan = (url: string | undefined): void => {
        if (!url) return;
        const m = url.match(CDN_AVATAR_RE);
        if (m) void recordHash(m[1], (m[3] ?? "") + m[4], m[2]);
    };
    for (const el of document.querySelectorAll<HTMLElement>("img")) scanSources(el, scan);
}

export function startRecentSync(isEnabled: () => boolean, ready: Promise<void>, isTrackedUser: (userId: string) => boolean): void {
    enabled = isEnabled;
    shouldTrackUser = isTrackedUser;
    waitReady = ready;
    if (observer) return;
    installObserver();
    sweepTimer = window.setInterval(sweepResourceTiming, 30_000);
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

export async function syncRecentNow(): Promise<number> {
    const userId = selfId();
    sweepResourceTiming();
    const added = await pullRecentFromServer();
    const removed = userId ? await purgeInvalidRecords(userId) : 0;
    const parts = [
        added > 0 ? `${added} new avatar(s)` : "",
        removed > 0 ? `${removed} invalid(s) removed` : "",
    ].filter(Boolean);
    Toasts.show({
        message: `AvatarHistory: ${parts.length ? parts.join(", ") : "nothing new"}`,
        type: added > 0 ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
        id: Toasts.genId(),
    });
    return added;
}

export async function purgeInvalidRecords(userId: string): Promise<number> {
    const recs = getHistory(userId).filter(r => !r.hasBlob);
    let removed = 0;
    for (const rec of recs) {
        const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp"] : ["png", "webp", "gif"];
        if (await checkCdnExists(userId, rec.hash, formats, rec.avatarId)) continue;
        await removeRecord(userId, rec);
        removed++;
        log.info(`Removed invalid avatar ${rec.hash} for ${userId}`);
    }
    if (removed) log.info(`Purged ${removed} invalid avatar record(s) for ${userId}`);
    return removed;
}

function avatarCdnUrl(userId: string, hash: string, fmt: "png" | "gif" | "webp", avatarId?: string): string {
    if (avatarId) return `https://cdn.discordapp.com/avatars/${userId}/archived/${avatarId}/${hash}.${fmt}?size=256`;
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${fmt}?size=256`;
}

export async function cdnAvatarExists(userId: string, hash: string, formats: Array<"png" | "gif" | "webp">, avatarId?: string): Promise<boolean> {
    for (const fmt of formats) {
        const urls = avatarId
            ? [avatarCdnUrl(userId, hash, fmt, avatarId), avatarCdnUrl(userId, hash, fmt)]
            : [avatarCdnUrl(userId, hash, fmt)];
        for (const url of urls) {
            try {
                const control = new AbortController();
                const timer = setTimeout(() => control.abort(), 5000);
                const res = await fetch(url, {
                    method: "HEAD",
                    credentials: "omit",
                    signal: control.signal,
                });
                clearTimeout(timer);
                if (!res.ok) {
                    if (res.status >= 500) return true;
                    continue;
                }
                const ct = (res.headers.get("Content-Type") ?? "").toLowerCase();
                if (!ct.startsWith("image/")) return false;
                const cl = Number(res.headers.get("Content-Length") ?? "0");
                if (cl > 0 && cl < 1000) return false;
                return true;
            } catch {
                return true;
            }
        }
    }
    return false;
}
