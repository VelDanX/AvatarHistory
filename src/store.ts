/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { del, delMany, get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

export const HISTORY_KEY = "vc-avh-history";
export const TRACKED_KEY = "vc-avh-tracked";
export const BLOB_KEY_PREFIX = "vc-avh-blob:";

export const BLOB_BUDGET_BYTES = 10 * 1024 * 1024;

export interface AvatarRecord {
    hash: string;
    avatarId?: string;
    timestamp: number;
    format: "png" | "gif" | "webp";
    size: number;
    hasBlob: boolean;
    width: number;
    height: number;
}

export type AvatarHistory = Record<string, AvatarRecord[]>;

export const history: AvatarHistory = {};
export const trackedUsers = new Set<string>();

const log = new Logger("AvatarHistory");
const pendingBlobs = new Map<string, Promise<Blob | null>>();
const blobObjectUrls = new Map<string, string>();

export const blobKeyFor = (userId: string, hash: string) => `${BLOB_KEY_PREFIX}${userId}:${hash}`;

export function getHistory(userId: string): AvatarRecord[] {
    return (history[userId] ??= []);
}

export function isTracked(userId: string): boolean {
    return trackedUsers.has(userId);
}

export async function setTracked(userId: string, on: boolean): Promise<void> {
    if (on) trackedUsers.add(userId);
    else trackedUsers.delete(userId);
    await persistTrackedSet();
    notifyTrackedListeners();
}

export async function getTrackedUsers(): Promise<string[]> {
    return [...trackedUsers];
}

export async function loadStore(): Promise<void> {
    const h = await get<AvatarHistory | undefined>(HISTORY_KEY);
    const t = await get<string[] | undefined>(TRACKED_KEY);
    if (h) {
        for (const [userId, recs] of Object.entries(h)) {
            if (recs.length) history[userId] = recs;
        }
    }
    if (t) for (const userId of t) if (userId) trackedUsers.add(userId);
    notifyListeners();
    notifyTrackedListeners();
}

export async function persistHistory(): Promise<void> {
    await set(HISTORY_KEY, history);
}

export async function persistTrackedSet(): Promise<void> {
    await set(TRACKED_KEY, [...trackedUsers]);
}

export function buildAvatarUrl(userId: string, hash: string, format: "png" | "gif" | "webp", size: number, avatarId?: string): string {
    const ext = format === "gif" ? "gif" : format === "webp" ? "webp" : "png";
    if (avatarId) return `https://cdn.discordapp.com/avatars/${userId}/archived/${avatarId}/${hash}.${ext}?size=${size}`;
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=${size}`;
}

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
                await persistHistory();
            }
            return blob;
        } catch {
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

function applyBlobMeta(userId: string, rec: AvatarRecord, blob: Blob): void {
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
        rec.width = img.naturalWidth;
        rec.height = img.naturalHeight;
        await persistHistory();
        notifyListeners();
    } catch {
    } finally {
        URL.revokeObjectURL(url);
    }
}

const listeners = new Set<() => void>();

function notifyListeners(): void {
    for (const listener of listeners) listener();
}

export function subscribeHistory(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const trackedListeners = new Set<() => void>();

function notifyTrackedListeners(): void {
    for (const listener of trackedListeners) listener();
}

export function subscribeTracked(listener: () => void): () => void {
    trackedListeners.add(listener);
    return () => {
        trackedListeners.delete(listener);
    };
}

export async function recordAvatarSeen(userId: string, rec: AvatarRecord): Promise<void> {
    const recs = getHistory(userId);
    const existing = recs.find(r => r.hash === rec.hash);
    if (existing) {
        if (rec.timestamp < existing.timestamp) {
            existing.timestamp = rec.timestamp;
            await persistHistory();
        }
        return;
    }
    recs.push(rec);
    recs.sort((a, b) => b.timestamp - a.timestamp);
    await persistHistory();
    notifyListeners();
}

export async function removeRecord(userId: string, rec: AvatarRecord): Promise<void> {
    const recs = getHistory(userId);
    const i = recs.indexOf(rec);
    if (i !== -1) recs.splice(i, 1);
    if (!recs.length) delete history[userId];
    await del(blobKeyFor(userId, rec.hash));
    revokeBlobObjectUrl(userId, rec);
    await persistHistory();
    notifyListeners();
}

export async function clearUserHistory(userId: string, clearBlob = false): Promise<void> {
    const recs = getHistory(userId);
    if (!recs.length) return;
    if (clearBlob) {
        await delMany(recs.map(r => blobKeyFor(userId, r.hash)));
        for (const r of recs) revokeBlobObjectUrl(userId, r);
    }
    delete history[userId];
    await persistHistory();
    notifyListeners();
}

export function clearBlobUrls(): void {
    for (const url of blobObjectUrls.values()) URL.revokeObjectURL(url);
    blobObjectUrls.clear();
}

export async function resetAllHistory(): Promise<void> {
    const blobKeys: string[] = [];
    for (const [userId, recs] of Object.entries(history)) {
        for (const r of recs) {
            blobKeys.push(blobKeyFor(userId, r.hash));
            revokeBlobObjectUrl(userId, r);
        }
    }
    await delMany(blobKeys);
    for (const k of Object.keys(history)) delete history[k];
    trackedUsers.clear();
    await set(TRACKED_KEY, []);
    await persistHistory();
    notifyTrackedListeners();
    notifyListeners();
}

export async function exportHistory(): Promise<Blob> {
    const payload: {
        version: number;
        exportedAt: number;
        users: AvatarHistory;
        blobs: Record<string, string>;
    } = { version: 1, exportedAt: Date.now(), users: history, blobs: {} };

    for (const [userId, recs] of Object.entries(history)) {
        for (const rec of recs) {
            if (!rec.hasBlob) continue;
            const blob = await get<Blob>(blobKeyFor(userId, rec.hash));
            if (blob) payload.blobs[`${userId}:${rec.hash}`] = await blobToDataUrl(blob);
        }
    }
    return new Blob([JSON.stringify(payload)], { type: "application/json" });
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
        } catch {
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

const IMPORT_HASH_RE = /^(a_)?[0-9a-f]{32}$/i;
const VALID_FORMATS: ReadonlySet<string> = new Set(["png", "gif", "webp"]);

function isValidRecord(v: unknown): v is AvatarRecord {
    if (!v || typeof v !== "object") return false;
    const r = v as Partial<AvatarRecord>;
    return typeof r.hash === "string" && IMPORT_HASH_RE.test(r.hash)
        && typeof r.timestamp === "number" && Number.isFinite(r.timestamp)
        && typeof r.format === "string" && VALID_FORMATS.has(r.format)
        && typeof r.size === "number"
        && typeof r.hasBlob === "boolean"
        && typeof r.width === "number"
        && typeof r.height === "number";
}

export async function parseImport(data: string): Promise<number> {
    const parsed = JSON.parse(data) as {
        version?: number;
        users?: AvatarHistory;
        blobs?: Record<string, string>;
    };
    if (parsed.version !== 1 || !parsed.users) throw new Error("Invalid avatar history file");

    let imported = 0;
    for (const [userId, recs] of Object.entries(parsed.users)) {
        if (!Array.isArray(recs)) continue;
        const target = (history[userId] ??= []);
        for (const rec of recs) {
            if (!isValidRecord(rec)) continue;
            const already = target.some(r => r.hash === rec.hash);
            if (already) continue;
            rec.hasBlob = false;
            rec.size = 0;
            target.push(rec);
            imported++;
            const dataUrl = parsed.blobs?.[`${userId}:${rec.hash}`];
            if (!dataUrl) continue;
            try {
                const blob = await (await fetch(dataUrl)).blob();
                if (blob.size <= BLOB_BUDGET_BYTES) {
                    await set(blobKeyFor(userId, rec.hash), blob);
                    applyBlobMeta(userId, rec, blob);
                }
            } catch {
            }
        }
    }
    await persistHistory();
    notifyListeners();
    return imported;
}
