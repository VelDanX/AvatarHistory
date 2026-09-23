/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { RestAPI, Toasts, UserStore } from "@webpack/common";

import { fetchAvatarBlob, getHistory } from "../store";
import { purgeInvalidRecords } from "./cdn";
import { getFoundCount, isSniffingEnabled, recordHash, sweepResourceTiming } from "./sniffer";

const log = new Logger("AvatarHistory");

const HASH_RE = /^(a_)?[0-9a-f]{32}$/i;

function selfId(): string | null {
    return UserStore.getCurrentUser()?.id ?? null;
}

function parseRecentList(body: unknown): Array<{ avatarId?: string; hash: string }> {
    const out: Array<{ avatarId?: string; hash: string }> = [];
    const hashes = new Set<string>();
    const add = (hash: string, avatarId?: string): void => {
        if (hashes.has(hash)) return;
        hashes.add(hash);
        out.push({ avatarId, hash });
    };

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
    if (!userId || !isSniffingEnabled()) return 0;
    const before = getFoundCount();
    try {
        const data: any = await RestAPI.get({ url: "/users/@me/avatars" });
        const body = data?.body ?? data;
        const recents = parseRecentList(body);
        const recs = getHistory(userId);

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
    return getFoundCount() - before;
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
