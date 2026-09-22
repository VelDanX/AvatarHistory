/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./src/style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addProfileSection, removeProfileSection } from "@api/ProfileSections";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { Constants, FluxDispatcher, Menu, RelationshipStore, RestAPI, Toasts, UserStore } from "@webpack/common";

import { AvatarHistoryProfileSection } from "./ProfileSection";
import { BackgroundSync } from "./src/bgSync";
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
        description: "Periodically re-check tracked users' avatars in the background (no need to open their profile)",
    },
    pollIntervalMinutes: {
        type: OptionType.NUMBER,
        default: 10,
        description: "How often (in minutes) tracked users' avatars are re-checked in the background",
    },
});

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

async function getSweepIds(): Promise<string[]> {
    if (!settings.store.pollTracked) return [];
    const ids = new Set<string>();
    if (settings.store.trackFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of trackedUsers) ids.add(id);
    // Self is handled separately via the recent-avatars endpoint
    const self = UserStore.getCurrentUser();
    if (self) ids.delete(self.id);
    return [...ids];
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
        let resolveReady!: () => void;
        const storeReady = new Promise<void>(r => resolveReady = r);
        startRecentSync(isAnyTrackingActive, storeReady, shouldTrack);
        backgroundSync = new BackgroundSync(
            storeReady,
            getSweepIds,
            checkUserOnServer,
            Math.max(1, settings.store.pollIntervalMinutes) * 60_000,
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
