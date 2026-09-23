/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./src/style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addProfileSection, removeProfileSection } from "@api/ProfileSections";
import { PlainSettings, Settings, SettingsStore, definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { Constants, FluxDispatcher, Menu, RelationshipStore, RestAPI, Toasts, UserStore } from "@webpack/common";

import { AvatarHistoryProfileSection } from "./ProfileSection";
import { BackgroundSync, DEFAULT_STAGGER_MS } from "./src/bgSync";
import { checkCdnExists, pullRecentFromServer, purgeInvalidRecords, startRecentSync, stopRecentSync, syncRecentNow } from "./src/recentSniffer";
import {
    AvatarRecord,
    clearBlobUrls,
    fetchAvatarBlob,
    getHistory,
    getTrackedUsers,
    isTracked,
    loadStore,
    recordAvatarSeen,
    resetAllHistory,
    setTracked,
    trackedUsers
} from "./src/store";

const log = new Logger("AvatarHistory");

const GAP_FILL_STAGGER_MS = 300;
/** Old (minutes) default for pollIntervalMinutes — only used during migration. */
const DEFAULT_POLL_INTERVAL_MINUTES = 10;
/** Fallback poll interval (seconds) when auto-tuning is unavailable. */
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
/** Auto-tuning range for the background poll interval. */
const MIN_POLL_INTERVAL_MS = 30_000;      // 30 s — the poll floor
const MAX_POLL_INTERVAL_MS = 30 * 60_000; // 30 min — the poll ceiling

let backgroundSync: BackgroundSync | null = null;

async function fillHistoryGaps(): Promise<void> {
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

async function resetAndResync(): Promise<void> {
    const self = UserStore.getCurrentUser();
    await resetAllHistory();
    Toasts.show({ message: "AvatarHistory: history cleared", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    if (settings.store.trackSelf && self) {
        const added = await pullRecentFromServer();
        void purgeInvalidRecords(self.id);
        if (added) Toasts.show({ message: `AvatarHistory: ${added} recent avatar(s) restored`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    }
}

const settings = definePluginSettings({
    trackSelf: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Automatically track your own avatar changes",
    },
    trackFriends: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Automatically track avatar changes of all your friends",
    },
    pollTracked: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Periodically re-check tracked users' avatars in the background. If disabled, avatars of other tracked users only update when you view their profile",
    },
    pollIntervalSeconds: {
        type: OptionType.NUMBER,
        default: 30,
        description: "How often (in seconds) tracked users' avatars are re-checked in the background. Auto-tuned to the number of tracked users (30 s – 30 min) unless you set your own value",
        onChange() {
            // A manual change disables auto-tuning.
            settings.store.pollIntervalAuto = false;
        },
    },
    pollIntervalAuto: {
        type: OptionType.BOOLEAN,
        default: true,
        hidden: true,
        description: "Auto-tune pollIntervalSeconds to the number of tracked users",
    },
});

/** Migrates the pre-0.0.3 `pollIntervalMinutes` setting (minutes) to seconds. */
function migratePollIntervalSetting(): void {
    const stored = SettingsStore.plain.plugins.AvatarHistory as Record<string, unknown> | undefined;
    if (!stored) return;
    if (!Object.hasOwn(stored, "pollIntervalMinutes") || Object.hasOwn(stored, "pollIntervalSeconds")) return;
    const minutes = stored.pollIntervalMinutes;
    if (typeof minutes === "number" && minutes > 0) {
        // A value other than the built-in default was a deliberate choice:
        // keep it manual, converted to seconds.
        stored.pollIntervalSeconds = minutes * 60;
        if (minutes !== DEFAULT_POLL_INTERVAL_MINUTES) {
            stored.pollIntervalAuto = false;
        }
    }
    delete stored.pollIntervalMinutes;
    SettingsStore.markAsChanged();
}

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

async function recordUserAvatar(user: User): Promise<void> {
    if (!user.avatar) return;
    const rec = buildRecord(user.avatar);
    const known = getHistory(user.id).some(r => r.hash === rec.hash);
    let ok = true;
    if (!known) {
        const formats: Array<"png" | "gif" | "webp"> = rec.format === "gif" ? ["gif", "webp", "png"] : ["png", "webp", "gif"];
        ok = await checkCdnExists(user.id, rec.hash, formats);
        if (!ok) {
            await new Promise(r => setTimeout(r, 10_000));
            ok = await checkCdnExists(user.id, rec.hash, formats);
        }
        if (!ok) {
            log.info(`Skipped avatar ${rec.hash}: rejected by Discord (not on CDN)`);
            return;
        }
    }
    await recordAvatarSeen(user.id, rec);
    const newest = getHistory(user.id)[0];
    if (newest) void fetchAvatarBlob(user.id, newest);
}

function shouldTrack(userId: string): boolean {
    if (isTracked(userId)) return true;
    const self = UserStore.getCurrentUser();
    if (self && userId === self.id) return settings.store.trackSelf;
    return settings.store.trackFriends && RelationshipStore.isFriend(userId);
}

function isAnyTrackingActive(): boolean {
    return settings.store.trackSelf || settings.store.trackFriends || trackedUsers.size > 0;
}

/**
 * The users the background sync actually re-checks right now:
 * friends (when trackFriends is on) + manually tracked users, excluding self
 * (self is handled separately via the recent-avatars endpoint).
 */
function sweepTargetIds(): string[] {
    const ids = new Set<string>();
    if (settings.store.trackFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of trackedUsers) ids.add(id);
    const self = UserStore.getCurrentUser();
    if (self) ids.delete(self.id);
    return [...ids];
}

async function getSweepIds(): Promise<string[]> {
    if (!settings.store.pollTracked) return [];
    return sweepTargetIds();
}

/** How many users the background sync would actually re-check right now. */
function sweepUserCount(): number {
    return sweepTargetIds().length;
}

/**
 * Smart default poll interval: scale with the number of tracked users so the
 * whole list gets one full paced pass per interval, but stay within a sane
 * range (never more aggressive than every 30 seconds, never lazier than every
 * 30 minutes). Only used when the user hasn't disabled auto-tuning.
 */
function smartPollIntervalMs(): number {
    const pacedMs = Math.max(1, sweepUserCount()) * DEFAULT_STAGGER_MS;
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pacedMs));
}

/**
 * Interval actually used for background checks.
 *
 * Auto mode (default): tune to the number of tracked users and write the
 * chosen value back into the settings so the UI shows what's really used
 * instead of a stale default. The tuning stays live until the user
 * deliberately changes pollIntervalSeconds (which flips pollIntervalAuto off).
 *
 * Called on every background cycle, so the cadence adapts when the number of
 * tracked users changes (friends added/removed, users tracked manually).
 */
function resolvePollIntervalMs(): number {
    const stored = PlainSettings.plugins.AvatarHistory as Record<string, unknown> | undefined;
    const custom = typeof stored?.pollIntervalSeconds === "number" ? stored.pollIntervalSeconds : null;
    const auto = stored?.pollIntervalAuto !== false;

    if (!auto) {
        // User picked an explicit interval: respect it.
        return (custom != null && custom > 0 ? custom : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
    }

    // Auto: tune to the number of tracked users and surface the chosen value
    // in the settings UI.
    const seconds = Math.max(1, Math.round(smartPollIntervalMs() / 1000));
    settings.store.pollIntervalSeconds = seconds;
    return seconds * 1000;
}

async function checkUserOnServer(userId: string): Promise<void> {
    if (!shouldTrack(userId)) return;
    try {
        const res: any = await RestAPI.get({ url: Constants.Endpoints.USER(userId), retries: 2 });
        // If the API layer surfaces a rate limit instead of retrying internally.
        if (res?.status === 429) {
            const waitSeconds = Math.min(Number(res?.body?.retry_after ?? 5), 30);
            log.info(`Rate limited, pausing background checks for ${waitSeconds}s`);
            await new Promise(r => setTimeout(r, waitSeconds * 1000));
            return;
        }
        const user = res?.body ?? res;
        if (!user || user.id !== userId || typeof user.avatar !== "string") return;
        // Unchanged avatar: nothing to record, avoid dispatching USER_UPDATE.
        const newest = getHistory(userId)[0];
        if (newest && newest.hash === user.avatar) return;
        // Dispatching updates Discord's own stores, which then triggers our
        // USER_UPDATE handler and records the avatar (deduplicated).
        FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
    } catch (e) {
        log.warn(`Background avatar check failed for ${userId}`, e);
    }
}

/**
 * Records the avatar of a tracked user if it differs from the latest history
 * entry. Shared by the USER_UPDATE / PRESENCE_UPDATES flux streams.
 */
function recordUserIfChanged(user?: Partial<User>): void {
    if (!user || typeof user.id !== "string" || typeof user.avatar !== "string") return;
    if (!shouldTrack(user.id)) return;
    const newest = getHistory(user.id)[0];
    if (newest && newest.hash === user.avatar) return;
    void recordUserAvatar(user as User);
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User }) => {
    if (!user) return;
    const isSelf = user.id === UserStore.getCurrentUser().id;

    const items = [
        <Menu.MenuItem
            key="vc-avh-remember"
            id="vc-avh-remember"
            label="Remember current avatar"
            action={() => void recordUserAvatar(user)}
        />
    ];

    if (!isSelf) {
        const autoTracked = settings.store.trackFriends && RelationshipStore.isFriend(user.id);
        items.push(
            <Menu.MenuItem
                key="vc-avh-toggle-track"
                id="vc-avh-toggle-track"
                label={autoTracked
                    ? "Tracked automatically (friend)"
                    : isTracked(user.id) ? "Stop tracking avatar changes" : "Track avatar changes"}
                disabled={autoTracked}
                action={() => {
                    const next = !isTracked(user.id);
                    void setTracked(user.id, next).then(() => {
                        if (next) void recordUserAvatar(user);
                    });
                }}
            />
        );
    } else {
        items.push(
            <Menu.MenuItem
                key="vc-avh-sync-recent"
                id="vc-avh-sync-recent"
                label="Sync recent avatars from Discord"
                action={() => void syncRecentNow()}
            />,
            <Menu.MenuItem
                key="vc-avh-reset"
                id="vc-avh-reset"
                label="Reset avatar history (all users)"
                action={() => void resetAndResync()}
            />
        );
    }

    children.push(
        <Menu.MenuSeparator key="vc-avh-separator" />,
        ...items
    );
};

export default definePlugin({
    name: "AvatarHistory",
    description: "Passively save avatar history of tracked users and browse it from their profile.",
    authors: [{ name: "VelDanX", id: 1348551557355933759n }],
    version: "0.0.3",
    settings,
    dependencies: ["ProfileSectionsAPI"],

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch,
        "user-profile-overflow-menu": userContextPatch,
    },

    flux: {
        USER_UPDATE({ user }: { user?: User }) {
            recordUserIfChanged(user);
        },
        PRESENCE_UPDATES({ users }: { users?: Array<Partial<User>> }) {
            for (const user of users ?? []) recordUserIfChanged(user);
        },
        CURRENT_USER_UPDATE({ user }: { user?: User }) {
            if (!user?.avatar || !settings.store.trackSelf) return;
            void recordUserAvatar(user);
        },
    },

    start() {
        migratePollIntervalSetting();
        let resolveReady!: () => void;
        const storeReady = new Promise<void>(r => resolveReady = r);
        startRecentSync(isAnyTrackingActive, storeReady, shouldTrack);
        backgroundSync = new BackgroundSync(
            storeReady,
            getSweepIds,
            checkUserOnServer,
            resolvePollIntervalMs,
        );
        backgroundSync.start();
        void loadStore().then(() => {
            if (settings.store.trackSelf) {
                const self = UserStore.getCurrentUser();
                if (self?.avatar) {
                    void setTracked(self.id, true).then(() => recordUserAvatar(self));
                }
            }
            void fillHistoryGaps();
        }).finally(() => {
            resolveReady();
            const self = UserStore.getCurrentUser();
            void pullRecentFromServer();
            if (self) void purgeInvalidRecords(self.id);
        });
        addProfileSection("avatarHistory", props => <AvatarHistoryProfileSection {...props} />);
        log.info("AvatarHistory started");
    },

    stop() {
        stopRecentSync();
        backgroundSync?.stop();
        backgroundSync = null;
        removeProfileSection("avatarHistory");
        clearBlobUrls();
    },
});
