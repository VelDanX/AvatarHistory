/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlainSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { Constants, RelationshipStore, RestAPI, Toasts, UserStore } from "@webpack/common";

import {
    CDN_RETRY_DELAY_MS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    GAP_FILL_STAGGER_MS,
    MAX_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS
} from "./config";
import { settings } from "./settings";
import {
    AvatarRecord,
    fetchAvatarBlob,
    getHistory,
    getLastSeenAt,
    getTrackedUsers,
    isTracked,
    recordAvatarSeen,
    resetAllHistory,
    sameHash,
    setLastSeen,
    setTracked,
    trackedUsers
} from "./store";
import { BackgroundSync, DEFAULT_STAGGER_MS } from "./sync/bgSync";
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

export async function recordUserAvatar(user: User): Promise<void> {
    if (!user.avatar) return;
    const rec = buildRecord(user.avatar);
    const known = getHistory(user.id).some(r => sameHash(r.hash, rec.hash));
    // Only CDN-verify avatars we haven't recorded yet. checkCdnExists is
    // tri-state: false = confirmed missing, null = network inconclusive
    // (record optimistically; purge will clean up later).
    if (!known) {
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
    }
    await recordAvatarSeen(user.id, rec);
    // We have just seen this hash on a live user object — that's a confirmation,
    // whether the record was new or already known.
    setLastSeen(user.id);
    const newest = getHistory(user.id)[0];
    if (newest) void fetchAvatarBlob(user.id, newest);
}

export function shouldTrack(userId: string): boolean {
    if (isTracked(userId)) return true;
    const self = UserStore.getCurrentUser();
    if (self && userId === self.id) return settings.store.trackSelf;
    return settings.store.trackFriends && RelationshipStore.isFriend(userId);
}

export function isAnyTrackingActive(): boolean {
    return settings.store.trackSelf || settings.store.trackFriends || trackedUsers.size > 0;
}

/**
 * Target ids for the background sweep (friends + manually tracked, minus self),
 * ordered stalest-confirmation-first.
 *
 * Sorting by `lastSeenAt` replaces a rotating offset: a checked user moves to
 * the back automatically, so the list is self-balancing. That also makes the
 * sweep survive the client being closed — on the next launch nobody has been
 * confirmed recently, so the stalest users are checked first instead of whoever
 * happens to sit at the head of a static array.
 */
export function sweepTargetIds(): string[] {
    const ids = new Set<string>();
    if (settings.store.trackFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of trackedUsers) ids.add(id);
    const self = UserStore.getCurrentUser();
    if (self) ids.delete(self.id);
    return [...ids].sort((a, b) => getLastSeenAt(a) - getLastSeenAt(b));
}

async function getSweepIds(): Promise<string[]> {
    if (!settings.store.pollTracked) return [];
    return sweepTargetIds();
}

function sweepUserCount(): number {
    return sweepTargetIds().length;
}

function smartPollIntervalMs(): number {
    const pacedMs = Math.max(1, sweepUserCount()) * DEFAULT_STAGGER_MS;
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pacedMs));
}

function resolvePollIntervalMs(): number {
    const stored = PlainSettings.plugins.AvatarHistory as Record<string, unknown> | undefined;
    const custom = typeof stored?.pollIntervalSeconds === "number" ? stored.pollIntervalSeconds : null;
    const mode = stored?.pollIntervalMode;

    if (mode === "manual") {
        return (custom != null && custom > 0 ? custom : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
    }

    const seconds = Math.max(1, Math.round(smartPollIntervalMs() / 1000));
    // Avoid markAsChanged/settings-write on every sweep when the value is stable.
    if (settings.store.pollIntervalSeconds !== seconds) {
        settings.store.pollIntervalSeconds = seconds;
    }
    return seconds * 1000;
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
        // Nothing to do when the cached avatar is already our newest record.
        // Skipping the call (and the stagger) is what keeps startup free for
        // large friend lists — a 300ms sleep per already-known user is ~90s of
        // serialized no-op work on every launch.
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
    Toasts.show({ message: "AvatarHistory: history cleared", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    if (settings.store.trackSelf && self) {
        // resetAllHistory also clears the tracked set — restore self so the
        // UI/tracked overview stays consistent without a plugin restart.
        await setTracked(self.id, true);
        const added = await pullRecentFromServer();
        void purgeInvalidRecords(self.id);
        if (added) Toasts.show({ message: `AvatarHistory: ${added} recent avatar(s) restored`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    }
}

/**
 * Re-check one user's avatar against the API.
 * Returns true when the caller should abort the current sweep batch
 * (rate limited — BackgroundSync.pause() has already been invoked).
 */
export async function checkUserOnServer(userId: string): Promise<boolean> {
    if (!shouldTrack(userId)) return false;
    try {
        const res: any = await RestAPI.get({ url: Constants.Endpoints.USER(userId) });

        if (res?.status === 429) {
            const waitSeconds = Math.min(Number(res?.body?.retry_after ?? 5), 30);
            // Pause the whole sweep instead of sleeping inside the loop — and abort
            // the batch, otherwise every next user in it gets a 429 of its own.
            backgroundSync?.pause(waitSeconds * 1000);
            return true;
        }
        const user = res?.body ?? res;
        if (!user || user.id !== userId || typeof user.avatar !== "string") return false;

        const newest = getHistory(userId)[0];
        if (newest && sameHash(newest.hash, user.avatar)) {
            setLastSeen(userId);
            return false;
        }

        // Record directly — no synthetic USER_UPDATE dispatch into Flux.
        recordUserIfChanged(user);
        return false;
    } catch (e) {
        log.warn(`Background avatar check failed for ${userId}`, e);
        return false;
    }
}

export function recordUserIfChanged(user?: Partial<User>): void {
    if (!user || typeof user.id !== "string" || typeof user.avatar !== "string") return;
    if (!shouldTrack(user.id)) return;
    const newest = getHistory(user.id)[0];
    if (newest && sameHash(newest.hash, user.avatar)) {
        setLastSeen(user.id);
        return;
    }
    void recordUserAvatar(user as User);
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
