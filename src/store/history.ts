/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { del, delMany, get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { React } from "@webpack/common";

import { SEEN_FLUSH_INTERVAL_MS } from "../config";
// Intentional cycle history <-> blobs. Both modules only reference each other's
// function declarations at runtime, so ESM handles it. Do not "fix" by inlining.
import { revokeBlobObjectUrl } from "./blobs";
import {
    AvatarHistory,
    AvatarRecord,
    blobKeyFor,
    HISTORY_KEY,
    HISTORY_VERSION,
    sameHash,
    StoredHistory,
    TRACKED_KEY,
    UserHistory
} from "./types";

const log = new Logger("AvatarHistory");

export const history: AvatarHistory = {};
export let trackedUsers = new Set<string>();

const EMPTY_HISTORY: AvatarRecord[] = [];

/** Read-only: does not create an entry, so viewing a profile cannot pollute the store. */
export function getHistory(userId: string): AvatarRecord[] {
    return history[userId]?.records ?? [];
}

/** When we last confirmed this user's current avatar, or 0 if never. */
export function getLastSeenAt(userId: string): number {
    return history[userId]?.lastSeenAt ?? 0;
}

export function isTracked(userId: string): boolean {
    return trackedUsers.has(userId);
}

/**
 * Immutable update (new array, new record) — this is what makes
 * useSyncExternalStore notice.
 *
 * `patch` is required on purpose. Records are replaced wholesale, so an async
 * caller can hold a reference that is no longer in the array; hash is the
 * per-user identity, so we fall back to it and apply the patch over the *live*
 * record. Spreading the stale one instead would resurrect fields it has moved on
 * from. Requiring the patch means a caller can never silently lose an in-place
 * mutation to a record that went stale during an await — that is the only way to
 * write, so `records` is never mutated outside a freshly built import record.
 */
export function updateRecord(userId: string, rec: AvatarRecord, patch: Partial<AvatarRecord>): void {
    const entry = history[userId];
    if (!entry) return;
    const i = entry.records.findIndex(r => r === rec || sameHash(r.hash, rec.hash));
    if (i === -1) return;
    const base = entry.records[i];
    writeRecord(userId, entry, i, { ...base, ...patch });
}

function writeRecord(userId: string, entry: UserHistory, i: number, next: AvatarRecord): void {
    const records = entry.records.slice();
    records[i] = next;
    history[userId] = { records, lastSeenAt: entry.lastSeenAt };
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

/** A stored user entry in either the v2 ({records, lastSeenAt}) or the legacy (array) shape. */
function toUserHistory(value: unknown): UserHistory | null {
    if (Array.isArray(value)) {
        const records = value.filter(r => r && typeof r === "object" && typeof (r as AvatarRecord).hash === "string");
        return records.length ? { records, lastSeenAt: 0 } : null;
    }
    if (!value || typeof value !== "object") return null;
    const { records, lastSeenAt } = value as Partial<UserHistory>;
    if (!Array.isArray(records) || !records.length) return null;
    return { records, lastSeenAt: typeof lastSeenAt === "number" ? lastSeenAt : 0 };
}

/** Accepts every shape the store has held and returns v2. v0 is a bare
 *  `{ id: AvatarRecord[] }` — Discord IDs are numeric, so a literal "users" key
 *  cannot collide with a real user. */
function migrateStoredHistory(raw: unknown): AvatarHistory | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const source = "users" in raw ? (raw as { users: unknown }).users : raw;
    if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;

    const out: AvatarHistory = {};
    for (const [userId, value] of Object.entries(source as Record<string, unknown>)) {
        const entry = toUserHistory(value);
        if (entry) out[userId] = entry;
    }
    return Object.keys(out).length ? out : undefined;
}

export async function loadStore(): Promise<void> {
    const h = await get<unknown>(HISTORY_KEY);
    const t = await get<string[] | undefined>(TRACKED_KEY);
    const users = migrateStoredHistory(h);
    if (users) {
        for (const [userId, entry] of Object.entries(users)) history[userId] = entry;
        // Rewrite once so the next start reads v2 directly.
        await persistHistory();
    }
    if (t) trackedUsers = new Set(t.filter(id => typeof id === "string" && id));
    notifyListeners();
    notifyTrackedListeners();
}

let seenDirty = false;
let seenFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Confirms a user's current avatar. Writes are coalesced: in memory immediately,
 *  flushed at most once per interval. */
export function setLastSeen(userId: string, at = Date.now()): void {
    const entry = history[userId];
    if (!entry || entry.lastSeenAt === at) return;
    // Safe to mutate in place: the records array reference is untouched, so
    // useSyncExternalStore snapshots stay stable and don't re-render.
    entry.lastSeenAt = at;
    seenDirty = true;
    if (seenFlushTimer != null) return;
    seenFlushTimer = setTimeout(() => {
        seenFlushTimer = null;
        void flushLastSeen();
    }, SEEN_FLUSH_INTERVAL_MS);
}

/** Flushes pending `lastSeenAt` updates. Called on plugin stop. */
export async function flushLastSeen(): Promise<void> {
    if (seenFlushTimer != null) {
        clearTimeout(seenFlushTimer);
        seenFlushTimer = null;
    }
    if (!seenDirty) return;
    seenDirty = false;
    await persistHistory();
}

export async function persistHistory(): Promise<void> {
    const payload: StoredHistory = { version: HISTORY_VERSION, users: history };
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
    const entry = history[userId];
    const recs = entry?.records ?? [];
    const existing = recs.find(r => sameHash(r.hash, rec.hash));
    if (existing) {
        // Rewriting the timestamp keeps the record at its index, so the descending
        // order has to be restored or the newest record drops to the bottom.
        if (rec.timestamp < existing.timestamp) {
            // One pass, one notify: `updateRecord` already persists and notifies,
            // so sorting on top would render twice and leave the order unpersisted.
            const i = recs.indexOf(existing);
            const patched = { ...existing, timestamp: rec.timestamp };
            const next = recs.slice();
            next[i] = patched;
            next.sort((a, b) => b.timestamp - a.timestamp);
            history[userId] = { records: next, lastSeenAt: entry.lastSeenAt };
            await persistHistory();
            notifyListeners();
        }
        return;
    }
    const records = [...recs, rec].sort((a, b) => b.timestamp - a.timestamp);
    history[userId] = { records, lastSeenAt: entry?.lastSeenAt ?? 0 };
    await persistHistory();
    notifyListeners();
}

export async function removeRecord(userId: string, rec: AvatarRecord): Promise<void> {
    const entry = history[userId];
    if (!entry?.records.includes(rec)) return;
    const next = entry.records.filter(r => r !== rec);
    if (next.length) history[userId] = { records: next, lastSeenAt: entry.lastSeenAt };
    else delete history[userId];
    await del(blobKeyFor(userId, rec.hash));
    revokeBlobObjectUrl(userId, rec);
    await persistHistory();
    notifyListeners();
}

/** Drops a user's whole history, blobs included — an orphaned blob is unreachable. */
export async function clearUserHistory(userId: string): Promise<void> {
    const recs = getHistory(userId);
    if (!recs.length) return;
    // lastSeenAt goes with the entry: with no records there is nothing to confirm.
    await delMany(recs.map(r => blobKeyFor(userId, r.hash)));
    for (const r of recs) revokeBlobObjectUrl(userId, r);
    delete history[userId];
    await persistHistory();
    notifyListeners();
}

export async function resetAllHistory(): Promise<void> {
    const blobKeys: string[] = [];
    for (const [userId, entry] of Object.entries(history)) {
        for (const r of entry.records) {
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
// React bindings. Snapshots must stay referentially stable while nothing changes,
// hence EMPTY_HISTORY and the immutable updates above.
// ---------------------------------------------------------------------------

export function useHistory(userId: string): AvatarRecord[] {
    return React.useSyncExternalStore(
        subscribeHistory,
        () => history[userId]?.records ?? EMPTY_HISTORY
    );
}

export function useTrackedUsers(): Set<string> {
    return React.useSyncExternalStore(
        subscribeTracked,
        () => trackedUsers
    );
}
