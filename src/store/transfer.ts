/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { BLOB_BUDGET_BYTES } from "../config";
import { applyBlobMeta, blobToDataUrl } from "./blobs";
import { getHistory, history, notifyListeners, persistHistory, updateRecord } from "./history";
import { AvatarHistory, AvatarRecord, blobKeyFor } from "./types";

const log = new Logger("AvatarHistory");

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
        const existing = getHistory(userId);
        const fresh: AvatarRecord[] = [];
        for (const rec of recs) {
            if (!isValidRecord(rec)) continue;
            if (existing.some(r => r.hash === rec.hash) || fresh.some(r => r.hash === rec.hash)) continue;
            rec.hasBlob = false;
            rec.size = 0;
            fresh.push(rec);
        }
        if (!fresh.length) continue;
        history[userId] = [...existing, ...fresh].sort((a, b) => b.timestamp - a.timestamp);
        imported += fresh.length;
        for (const rec of fresh) {
            const dataUrl = parsed.blobs?.[`${userId}:${rec.hash}`];
            if (!dataUrl) continue;
            try {
                const blob = await (await fetch(dataUrl)).blob();
                if (blob.size <= BLOB_BUDGET_BYTES) {
                    await set(blobKeyFor(userId, rec.hash), blob);
                    applyBlobMeta(userId, rec, blob);
                    updateRecord(userId, rec);
                }
            } catch (e) {
                log.debug("parseImport blob decode failed", userId, rec.hash, e);
            }
        }
    }
    await persistHistory();
    notifyListeners();
    return imported;
}
