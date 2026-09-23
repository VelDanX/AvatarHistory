/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { del, delMany, get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";

// NOTE: intentional cycle history <-> blobs. Both modules only reference each
// other's *function declarations* at runtime — nothing executes at module
// evaluation time, so ESM handles this fine. Do not "fix" by inlining or
// moving state; add a comment here instead if the cycle changes.
import { revokeBlobObjectUrl } from "./blobs";
import {
    AvatarHistory,
    AvatarRecord,
    blobKeyFor,
    HISTORY_KEY,
    HISTORY_VERSION,
    TRACKED_KEY
} from "./types";

const log = new Logger("AvatarHistory");

export const history: AvatarHistory = {};
export let trackedUsers = new Set<string>();

const EMPTY_HISTORY: AvatarRecord[] = [];

/**
 * Read-only access to a user's history. Does NOT create an empty entry in the
 * store — viewing a profile must not pollute `history` with `userId: []`.
 */
export function getHistory(userId: string): AvatarRecord[] {
    return history[userId] ?? [];
}

export function isTracked(userId: string): boolean {
    return trackedUsers.has(userId);
}

/**
 * Replace a record inside a user's history with an immutable update (new array,
 * new record object). This is what makes `useSyncExternalStore` notice changes.
 */
export function updateRecord(userId: string, rec: AvatarRecord, patch?: Partial<AvatarRecord>): void {
    const recs = getHistory(userId);
    const i = recs.indexOf(rec);
    if (i === -1) return;
    const next = recs.slice();
    next[i] = patch ? { ...rec, ...patch } : { ...rec };
    history[userId] = next;
    void persistHistory();
    notifyListeners();
}

export async function setTracked(userId: string, on: boolean): Promise<void> {
    const next = new Set(trackedUsers);
    if (on) next.add(userId);
    else next.delete(userId);
    trackedUsers = next;
    await persistTrackedSet();
    notifyTrackedListeners();
}

export async function getTrackedUsers(): Promise<string[]> {
    return [...trackedUsers];
}

function migrateStoredHistory(raw: unknown): AvatarHistory | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    // Current format: { version, users }
    if ("users" in raw) {
        const { users } = raw as { version: number; users: AvatarHistory };
        return users && typeof users === "object" ? users : undefined;
    }
    // Legacy format (v0): a plain Record<userId, AvatarRecord[]> — Discord IDs
    // are numeric, so a literal "users" key cannot collide with a real user.
    return raw as AvatarHistory;
}

export async function loadStore(): Promise<void> {
    const h = await get<unknown>(HISTORY_KEY);
    const t = await get<string[] | undefined>(TRACKED_KEY);
    const users = migrateStoredHistory(h);
    if (users) {
        for (const [userId, recs] of Object.entries(users)) {
            if (Array.isArray(recs) && recs.length) history[userId] = recs;
        }
    }
    if (t) trackedUsers = new Set(t.filter(id => typeof id === "string" && id));
    notifyListeners();
    notifyTrackedListeners();
}

export async function persistHistory(): Promise<void> {
    const payload = { version: HISTORY_VERSION, users: history };
    await set(HISTORY_KEY, payload);
}

export async function persistTrackedSet(): Promise<void> {
    await set(TRACKED_KEY, [...trackedUsers]);
}

const listeners = new Set<() => void>();

export function notifyListeners(): void {
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
            updateRecord(userId, existing, { timestamp: rec.timestamp });
        }
        return;
    }
    history[userId] = [...recs, rec].sort((a, b) => b.timestamp - a.timestamp);
    await persistHistory();
    notifyListeners();
}

export async function removeRecord(userId: string, rec: AvatarRecord): Promise<void> {
    const recs = getHistory(userId);
    if (!recs.includes(rec)) return;
    const next = recs.filter(r => r !== rec);
    if (next.length) history[userId] = next;
    else delete history[userId];
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
    trackedUsers = new Set();
    await set(TRACKED_KEY, []);
    await persistHistory();
    notifyTrackedListeners();
    notifyListeners();
}

// ---------------------------------------------------------------------------
// React bindings (useSyncExternalStore) — snapshot must return a stable
// reference while nothing changed, hence the EMPTY_* constants and the
// immutable updates in updateRecord/recordAvatarSeen above.
// ---------------------------------------------------------------------------

export function useHistory(userId: string): AvatarRecord[] {
    return React.useSyncExternalStore(
        subscribeHistory,
        () => history[userId] ?? EMPTY_HISTORY
    );
}

export function useTrackedUsers(): Set<string> {
    return React.useSyncExternalStore(
        subscribeTracked,
        () => trackedUsers
    );
}
