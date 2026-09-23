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
    getTrackedUsers,
    isTracked,
    recordAvatarSeen,
    resetAllHistory,
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
    const known = getHistory(user.id).some(r => r.hash === rec.hash);
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

/** Target ids for the background sweep (friends + manually tracked, minus self). */
export function sweepTargetIds(): string[] {
    const ids = new Set<string>();
    if (settings.store.trackFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of trackedUsers) ids.add(id);
    const self = UserStore.getCurrentUser();
    if (self) ids.delete(self.id);
    return [...ids];
}

export async function getSweepIds(): Promise<string[]> {
    if (!settings.store.pollTracked) return [];
    return sweepTargetIds();
}

export function sweepUserCount(): number {
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

export async function checkUserOnServer(userId: string): Promise<void> {
    if (!shouldTrack(userId)) return;
    try {
        const res: any = await RestAPI.get({ url: Constants.Endpoints.USER(userId) });

        if (res?.status === 429) {
            const waitSeconds = Math.min(Number(res?.body?.retry_after ?? 5), 30);
            // Pause the whole sweep instead of sleeping inside the loop.
            backgroundSync?.pause(waitSeconds * 1000);
            return;
        }
        const user = res?.body ?? res;
        if (!user || user.id !== userId || typeof user.avatar !== "string") return;

        const newest = getHistory(userId)[0];
        if (newest && newest.hash === user.avatar) return;

        // Record directly — no synthetic USER_UPDATE dispatch into Flux.
        recordUserIfChanged(user);
    } catch (e) {
        log.warn(`Background avatar check failed for ${userId}`, e);
    }
}

export function recordUserIfChanged(user?: Partial<User>): void {
    if (!user || typeof user.id !== "string" || typeof user.avatar !== "string") return;
    if (!shouldTrack(user.id)) return;
    const newest = getHistory(user.id)[0];
    if (newest && newest.hash === user.avatar) return;
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
