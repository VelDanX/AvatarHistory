/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { buildAvatarUrl } from "../cdnUrl";
import { BLOB_BUDGET_BYTES } from "../config";
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
                applyBlobMeta(userId, rec, cached);
                return cached;
            }
            const urls = rec.avatarId
                ? [buildAvatarUrl(userId, rec.hash, rec.format, 512, rec.avatarId), buildAvatarUrl(userId, rec.hash, rec.format, 512)]
                : [buildAvatarUrl(userId, rec.hash, rec.format, 512)];
            let blob: Blob | null = null;
            for (const url of urls) {
                const res = await fetch(url, { credentials: "omit" });
                if (res.ok) {
                    blob = await res.blob();
                    break;
                }
            }
            if (!blob) return null;
            if (blob.size <= BLOB_BUDGET_BYTES) {
                applyBlobMeta(userId, rec, blob);
                await set(key, blob);
                updateRecord(userId, rec);
            }
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

export function applyBlobMeta(userId: string, rec: AvatarRecord, blob: Blob): void {
    rec.size = blob.size;
    rec.hasBlob = true;
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
        try {
            const res = await fetch(buildAvatarUrl(userId, rec.hash, rec.format, 512, rec.avatarId), { credentials: "omit" });
            if (!res.ok) return null;
            blob = await res.blob();
        } catch (e) {
            log.debug("avatarToDataUrl fetch failed", userId, rec.hash, e);
            return null;
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
