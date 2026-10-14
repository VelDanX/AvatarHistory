/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { Constants, RelationshipStore, RestAPI, Toasts, UserStore } from "@webpack/common";

import {
    AVATAR_ATTEMPT_LIMIT,
    AVATAR_ATTEMPT_TTL_MS,
    CDN_RETRY_DELAY_MS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    GAP_FILL_STAGGER_MS
} from "./config";
import { autoPollIntervalMs, sweepTargetIds } from "./poll";
import { settings } from "./settings";
import {
    AvatarRecord,
    fetchAvatarBlob,
    getHistory,
    getTrackedUsers,
    isTracked,
    recordAvatarSeen,
    resetAllHistory,
    sameHash,
    setLastSeen,
    setTracked,
    trackedUsers
} from "./store";
import { BackgroundSync } from "./sync/bgSync";
import { checkCdnExists, purgeInvalidRecords } from "./sync/cdn";
import { pullRecentFromServer } from "./sync/recentSync";

const log = new Logger("AvatarHistory");

let backgroundSync: BackgroundSync | null = null;

function buildRecord(avatar: string): AvatarRecord {
    return {
        hash: avatar,
        timestamp: Date.now(),
        format: avatar.startsWith("a_") ? "gif" : "png",
        size: 0,
        hasBlob: false,
        width: 0,
        height: 0,
    };
}

/**
 * Remembered attempts at recording a hash that is *not* in history yet. Only
 * the probing path consults it: a hash that made it into history is `known` on
 * the next event and skips this entirely.
 *
 * Eviction runs before the insert, so the key just claimed is never the one
 * dropped on the spot. Map order is insertion order, which is what makes the
 * cap an oldest-first one.
 */
const avatarAttempts = new Map<string, number>();

function claimAvatarAttempt(userId: string, hash: string): boolean {
    const now = Date.now();
    const key = `${userId}:${hash}`;
    const last = avatarAttempts.get(key);
    if (last != null && now - last < AVATAR_ATTEMPT_TTL_MS) return false;

    if (avatarAttempts.size >= AVATAR_ATTEMPT_LIMIT) {
        for (const [staleKey, at] of avatarAttempts) {
            if (now - at >= AVATAR_ATTEMPT_TTL_MS) avatarAttempts.delete(staleKey);
        }
        while (avatarAttempts.size >= AVATAR_ATTEMPT_LIMIT) {
            const oldest = avatarAttempts.keys().next().value;
            if (oldest == null) break;
            avatarAttempts.delete(oldest);
        }
    }

    avatarAttempts.set(key, now);
    return true;
}

export async function recordUserAvatar(user: User): Promise<void> {
    if (!user.avatar) return;
    const rec = buildRecord(user.avatar);
    const known = getHistory(user.id).some(r => sameHash(r.hash, rec.hash));
    // checkCdnExists is tri-state: false = confirmed missing, null = inconclusive
    // (record optimistically; purge cleans up later).
    let cdn = "known";
    if (!known) {
        // Claim before probing, or one dead hash turns every gateway event
        // from that user into a burst of CDN requests.
        if (!claimAvatarAttempt(user.id, rec.hash)) return;
        const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp", "png"] : ["png", "webp", "gif"];
        let ok = await checkCdnExists(user.id, rec.hash, formats);
        if (ok === false) {
            await new Promise(r => setTimeout(r, CDN_RETRY_DELAY_MS));
            ok = await checkCdnExists(user.id, rec.hash, formats);
        }
        if (ok === false) {
            log.info(`Skipped avatar ${rec.hash}: rejected by Discord (not on CDN)`);
            return;
        }
        cdn = ok === null ? "inconclusive" : "ok";
    }
    await recordAvatarSeen(user.id, rec);
    // A hash seen on a live user object is a confirmation, new or known.
    setLastSeen(user.id);
    // Only a hash that was not in the history before is worth a line — the
    // "already known" path runs on every other gateway event of that user.
    if (!known) log.info(`Recorded avatar ${rec.hash} for ${user.id} (fmt=${rec.format}, cdn=${cdn})`);
    const newest = getHistory(user.id)[0];
    if (newest) void fetchAvatarBlob(user.id, newest);
}

export function shouldTrack(userId: string): boolean {
    // Self is decided by the toggle alone, before the tracked set is consulted:
    // startAvatarHistory() adds self and nothing removed it again, so an
    // `isTracked()` shortcut made the toggle a one-way switch.
    const self = UserStore.getCurrentUser();
    if (self && userId === self.id) return settings.store.trackSelf;
    if (isTracked(userId)) return true;
    return settings.store.trackFriends && RelationshipStore.isFriend(userId);
}

export function isAnyTrackingActive(): boolean {
    return settings.store.trackSelf || settings.store.trackFriends || trackedUsers.size > 0;
}

/** Background sweep interval, ms. Pure function of the settings: the Auto value
 *  is derived (poll.ts) and never written back, so `pollIntervalSeconds` stays
 *  the user's own number. Manual intervals are honoured as written — the user
 *  picked that number; only Auto yields to the gateway stream.
 *  Exported for the startup config line in services.ts. */
export function resolvePollIntervalMs(): number {
    if (settings.store.pollIntervalMode === "manual") {
        const seconds = settings.store.pollIntervalSeconds;
        return (seconds > 0 ? seconds : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
    }
    return autoPollIntervalMs(settings.store.trackFriends, settings.store.gatewaySync);
}

async function getSweepIds(): Promise<string[]> {
    if (!settings.store.pollTracked) return [];
    return sweepTargetIds(settings.store.trackFriends);
}

export async function fillHistoryGaps(): Promise<void> {
    const self = UserStore.getCurrentUser();
    const ids = new Set(await getTrackedUsers());
    if (settings.store.trackFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of ids) {
        if (self && id === self.id) continue;
        const user = UserStore.getUser(id);
        if (!user?.avatar) continue;
        // Skipping the call (and the stagger) keeps startup free: 300ms per
        // already-known user is ~90s of no-op work on a 300-friend list.
        if (getHistory(id)[0]?.hash && sameHash(getHistory(id)[0].hash, user.avatar)) {
            setLastSeen(id);
            continue;
        }
        await recordUserAvatar(user);
        await new Promise(r => setTimeout(r, GAP_FILL_STAGGER_MS));
    }
}

export async function resetAndResync(): Promise<void> {
    const self = UserStore.getCurrentUser();
    await resetAllHistory();
    // The attempt ledger outlives a reset: without clearing it, the same
    // user+hash would be silently skipped for up to AVATAR_ATTEMPT_TTL_MS
    // right after the history it guarded was erased. resetAllHistory cannot
    // reach it (different module), so it is cleared here, next to the reset.
    avatarAttempts.clear();
    Toasts.show({ message: "AvatarHistory: history cleared", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    if (settings.store.trackSelf && self) {
        // resetAllHistory also cleared the tracked set — restore self.
        await setTracked(self.id, true);
        const added = await pullRecentFromServer();
        void purgeInvalidRecords(self.id);
        if (added) Toasts.show({ message: `AvatarHistory: ${added} recent avatar(s) restored`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    }
}

/** Re-checks one user against the API. Returns true to abort the batch
 *  (rate limited; BackgroundSync.pause() already invoked). */
export async function checkUserOnServer(userId: string): Promise<boolean> {
    if (!shouldTrack(userId)) return false;
    try {
        const res: any = await RestAPI.get({ url: Constants.Endpoints.USER(userId) });
        if (res?.status === 429) return onRateLimited(res);

        const user = res?.body ?? res;
        if (!user || user.id !== userId || typeof user.avatar !== "string") return false;

        const newest = getHistory(userId)[0];
        if (newest && sameHash(newest.hash, user.avatar)) {
            setLastSeen(userId);
            return false;
        }

        // Record directly — no synthetic USER_UPDATE dispatch into Flux.
        // Awaited: this catch is the only thing that can log and count a
        // failing record, so a fire-and-forget rejection would slip past it
        // entirely and the sweep would report a clean batch.
        await recordUserIfChanged(user);
        return false;
    } catch (e) {
        // Discord's REST layer *rejects* on error statuses rather than resolving
        // with them, so a 429 lands here and not on the branch above — both paths
        // must handle it, or every remaining user earns a 429 of its own.
        const err = e as { status?: number; body?: { retry_after?: number; } } | undefined;
        if (err?.status === 429) return onRateLimited(err);
        // Re-throw: the caller (BackgroundSync) logs and counts it. Swallowing it
        // here made `Sweep done` report `0 error(s)` for a batch that had failed
        // entirely — seen live: 27/27 checks, "0 error(s)".
        throw e;
    }
}

/** Shared 429 handling: pause the sweep instead of sleeping in the loop, and tell the caller to abandon the batch. */
function onRateLimited(payload: { body?: { retry_after?: number; } }): true {
    const waitSeconds = Math.min(Number(payload?.body?.retry_after ?? 5), 30);
    backgroundSync?.pause(waitSeconds * 1000);
    return true;
}

/**
 * Records a user only if their avatar hash is not the newest one we have.
 *
 * Returns the recording promise so a caller that awaits it — the sweep, which
 * has a catch to feed its error count — actually observes the outcome. It used
 * to be `void` with a bare `void recordUserAvatar(...)` inside, so `await`ing
 * it here awaited `undefined` and a failed record reached nobody: no log, no
 * `Sweep done … error(s)` count, and an unhandled rejection in every
 * fire-and-forget caller.
 *
 * The early returns resolve to `undefined` rather than a promise; awaiting
 * `undefined` is fine, and the return type stays `Promise<void> | undefined`
 * so callers are forced to notice whether there is anything to await.
 */
export function recordUserIfChanged(user?: Partial<User>): Promise<void> | undefined {
    if (!user || typeof user.id !== "string" || typeof user.avatar !== "string") return;
    if (!shouldTrack(user.id)) return;
    const newest = getHistory(user.id)[0];
    if (newest && sameHash(newest.hash, user.avatar)) {
        setLastSeen(user.id);
        return;
    }
    return recordUserAvatar(user as User);
}

export function startBackgroundSync(ready: Promise<void>): void {
    backgroundSync = new BackgroundSync(
        ready,
        getSweepIds,
        checkUserOnServer,
        resolvePollIntervalMs,
    );
    backgroundSync.start();
}

export function stopBackgroundSync(): void {
    backgroundSync?.stop();
    backgroundSync = null;
}
