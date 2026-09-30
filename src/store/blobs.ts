/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { buildAvatarUrl } from "../cdnUrl";
import { BLOB_BUDGET_BYTES, BLOB_FETCH_TIMEOUT_MS } from "../config";
// NOTE: intentional cycle with ./history (see the mirrored note there).
// Runtime-only usage of hoisted function declarations — safe under ESM.
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
                rec.hasBlob = true;
                applyBlobMeta(userId, rec, cached);
                return cached;
            }
            const urls = rec.avatarId
                ? [buildAvatarUrl(userId, rec.hash, rec.format, 512, rec.avatarId), buildAvatarUrl(userId, rec.hash, rec.format, 512)]
                : [buildAvatarUrl(userId, rec.hash, rec.format, 512)];
            let blob: Blob | null = null;
            for (const url of urls) {
                // Bounded: an unbounded request that never settles would keep its
                // key in `pendingBlobs` for the rest of the session, and the
                // dedup below would hand that dead promise to every later caller.
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
            // A 200 is not proof of an image. Storing an error page under a blob key
            // would render as a permanently broken thumbnail that never re-fetches,
            // so reject non-image bodies here instead of guessing from the size.
            const bt = (blob.type ?? "").toLowerCase();
            if (bt && !bt.startsWith("image/") && bt !== "application/octet-stream") {
                log.debug("fetchAvatarBlob got a non-image body", userId, rec.hash, bt);
                return null;
            }
            // Metadata is recorded either way, including for an oversized blob:
            // the size and dimensions are still known, and the caller gets a
            // working object URL for this session. Only the *persisted copy* is
            // skipped, since that is what the budget is about.
            applyBlobMeta(userId, rec, blob);
            if (blob.size > BLOB_BUDGET_BYTES) {
                // hasBlob deliberately stays false: nothing was written under the
                // blob key. Leaving it true would make cdn.purgeInvalidRecords and
                // the sniffer's repair pass skip the record forever, on the
                // strength of a copy that does not exist.
                log.debug(`Not caching oversized avatar blob (${blob.size} > ${BLOB_BUDGET_BYTES})`, userId, rec.hash);
                updateRecord(userId, rec);
                return blob;
            }
            await set(key, blob);
            rec.hasBlob = true;
            updateRecord(userId, rec);
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

// Records what a blob *is* (size, dimensions). It deliberately does not touch
// `hasBlob`: only the caller knows whether the blob was actually written under
// the blob key, and an oversized blob is measured but never persisted.
export function applyBlobMeta(userId: string, rec: AvatarRecord, blob: Blob): void {
    rec.size = blob.size;
    if (!rec.width || !rec.height) void measureBlob(userId, rec, blob);
}

async function measureBlob(userId: string, rec: AvatarRecord, blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("decode failed"));
            img.src = url;
        });
        updateRecord(userId, rec, { width: img.naturalWidth, height: img.naturalHeight });
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
        // Bounded for the same reason as above: this fallback runs behind a
        // "set as avatar" click, and a hang there leaves the button spinning.
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), BLOB_FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(buildAvatarUrl(userId, rec.hash, rec.format, 512, rec.avatarId), {
                credentials: "omit",
                signal: control.signal
            });
            if (!res.ok) return null;
            blob = await res.blob();
        } catch (e) {
            log.debug("avatarToDataUrl fetch failed", userId, rec.hash, e);
            return null;
        } finally {
            clearTimeout(timer);
        }
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
