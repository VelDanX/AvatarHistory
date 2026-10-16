/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { buildAvatarUrlFallbacks } from "../cdnUrl";
import { BLOB_BUDGET_BYTES, BLOB_FETCH_SIZES, BLOB_FETCH_TIMEOUT_MS } from "../config";
// Intentional cycle with ./history: runtime-only use of hoisted declarations, safe under ESM.
import { updateRecord } from "./history";
import { AvatarRecord, blobKeyFor } from "./types";

const log = new Logger("AvatarHistory");

const pendingBlobs = new Map<string, Promise<Blob | null>>();
const blobObjectUrls = new Map<string, string>();

export async function fetchAvatarBlob(userId: string, rec: AvatarRecord): Promise<Blob | null> {
    const key = blobKeyFor(userId, rec.hash);
    const inflight = pendingBlobs.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
        try {
            const cached = await get<Blob>(key);
            if (cached) {
                // A blob read back out of the store is a real persisted copy.
                measureIfNeeded(userId, rec, cached);
                updateRecord(userId, rec, { hasBlob: true, size: cached.size });
                return cached;
            }
            // Best quality first, per path: the archived path is the only one
            // that exists for hashes that are no longer the user's current
            // avatar, and a stored copy outlives the CDN entry entirely.
            const urls = buildAvatarUrlFallbacks(userId, rec.hash, rec.format, rec.avatarId, BLOB_FETCH_SIZES);
            let blob: Blob | null = null;
            for (const url of urls) {
                // Bounded: a request that never settles would pin its key in
                // `pendingBlobs` for the session, and dedup would hand that dead
                // promise to every later caller.
                const control = new AbortController();
                const timer = setTimeout(() => control.abort(), BLOB_FETCH_TIMEOUT_MS);
                try {
                    const res = await fetch(url, { credentials: "omit", signal: control.signal });
                    if (res.ok) {
                        blob = await res.blob();
                        break;
                    }
                } catch (e) {
                    // Timeout / abort / network failure: try the next URL shape.
                    log.debug("fetchAvatarBlob fetch failed", userId, rec.hash, url, e);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (!blob) return null;
            // A 200 is not proof of an image: storing an error page would become a
            // permanently broken thumbnail that never re-fetches.
            const bt = (blob.type ?? "").toLowerCase();
            if (bt && !bt.startsWith("image/") && bt !== "application/octet-stream") {
                log.debug("fetchAvatarBlob got a non-image body", userId, rec.hash, bt);
                return null;
            }
            // Metadata is recorded even for an oversized blob; only the *persisted
            // copy* is skipped, since that is what the budget is about.
            measureIfNeeded(userId, rec, blob);
            if (blob.size > BLOB_BUDGET_BYTES) {
                // hasBlob stays false: nothing was written under the blob key, and
                // marking it would make purgeInvalidRecords and the sniffer's
                // repair pass skip the record forever.
                log.debug(`Not caching oversized avatar blob (${blob.size} > ${BLOB_BUDGET_BYTES})`, userId, rec.hash);
                updateRecord(userId, rec, { size: blob.size });
                return blob;
            }
            await set(key, blob);
            updateRecord(userId, rec, { hasBlob: true, size: blob.size });
            return blob;
        } catch (e) {
            log.debug("fetchAvatarBlob failed", userId, rec.hash, e);
            return null;
        } finally {
            pendingBlobs.delete(key);
        }
    })();

    pendingBlobs.set(key, promise);
    return promise;
}

export async function getBlobObjectUrl(userId: string, rec: AvatarRecord): Promise<string | null> {
    const key = `${userId}:${rec.hash}`;
    const existing = blobObjectUrls.get(key);
    if (existing) return existing;
    const blob = await fetchAvatarBlob(userId, rec);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    blobObjectUrls.set(key, url);
    return url;
}

export function revokeBlobObjectUrl(userId: string, rec: AvatarRecord): void {
    const key = `${userId}:${rec.hash}`;
    const url = blobObjectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    blobObjectUrls.delete(key);
}

export function clearBlobUrls(): void {
    for (const url of blobObjectUrls.values()) URL.revokeObjectURL(url);
    blobObjectUrls.clear();
}

// Starts an async decode to fill in `width`/`height` if they are still unknown,
// and patches the result through updateRecord. It deliberately mutates nothing:
// size and hasBlob travel in the caller's patch, so nothing is lost if `rec`
// goes stale during the decode.
export function measureIfNeeded(userId: string, rec: AvatarRecord, blob: Blob): void {
    if (!rec.width || !rec.height) void measureBlob(userId, rec, blob);
}

async function measureBlob(userId: string, rec: AvatarRecord, blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        // Bounded like every other remote wait in the plugin (fetchAvatarBlob,
        // probeCandidates): an Image that fires neither onload nor onerror
        // would otherwise leave this object URL un-revoked forever — the
        // revoke below sits in a finally that only runs once the promise settles.
        const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
        await new Promise<void>(resolve => {
            const finish = (): void => {
                clearTimeout(state.timer);
                img.onload = null;
                img.onerror = null;
                resolve();
            };
            state.timer = setTimeout(finish, BLOB_FETCH_TIMEOUT_MS);
            img.onload = finish;
            img.onerror = finish;
            img.src = url;
        });
        // naturalWidth stays 0 until a real decode, so an error or the timeout
        // leaves the record's dimensions unpatched instead of writing 0, 0.
        if (img.naturalWidth) updateRecord(userId, rec, { width: img.naturalWidth, height: img.naturalHeight });
    } catch (e) {
        log.debug("measureBlob failed", userId, rec.hash, e);
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export async function avatarToDataUrl(userId: string, rec: AvatarRecord): Promise<string | null> {
    let blob = await fetchAvatarBlob(userId, rec);
    if (!blob) {
        // No stored copy: walk the same candidates as fetchAvatarBlob, best
        // quality first. Bounded per URL for the same reason as above: a hang
        // here leaves the button spinning.
        for (const url of buildAvatarUrlFallbacks(userId, rec.hash, rec.format, rec.avatarId, BLOB_FETCH_SIZES)) {
            const control = new AbortController();
            const timer = setTimeout(() => control.abort(), BLOB_FETCH_TIMEOUT_MS);
            try {
                const res = await fetch(url, { credentials: "omit", signal: control.signal });
                if (res.ok) {
                    blob = await res.blob();
                    break;
                }
            } catch (e) {
                log.debug("avatarToDataUrl fetch failed", userId, rec.hash, url, e);
            } finally {
                clearTimeout(timer);
            }
        }
        if (!blob) return null;
    }
    if (blob.type === "image/webp") {
        return blobToPngDataUrl(blob);
    }
    return blobToDataUrl(blob);
}

function blobToPngDataUrl(blob: Blob): Promise<string | null> {
    return new Promise(resolve => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            URL.revokeObjectURL(url);
            if (!ctx) {
                resolve(null);
                return;
            }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };
        img.src = url;
    });
}
