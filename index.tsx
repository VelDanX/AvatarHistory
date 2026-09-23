/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./src/style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addProfileSection, removeProfileSection } from "@api/ProfileSections";
import { definePluginSettings, PlainSettings, SettingsStore, useSettings } from "@api/Settings";
import { TrashIcon, CopyIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { Constants, FluxDispatcher, IconUtils, Menu, RelationshipStore, RestAPI, Toasts, useEffect, useReducer, UserStore } from "@webpack/common";

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
    subscribeTracked,
    trackedUsers
} from "./src/store";

const log = new Logger("AvatarHistory");

const cl = classNameFactory("vc-avh-");

const GAP_FILL_STAGGER_MS = 300;

const DEFAULT_POLL_INTERVAL_MINUTES = 10;

const DEFAULT_POLL_INTERVAL_SECONDS = 30;

const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 30 * 60_000;

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
    trackedOverview: {
        type: OptionType.COMPONENT,
        component: () => <TrackedUsersOverview />,
    },
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
    pollIntervalMode: {
        type: OptionType.SELECT,
        options: [
            { label: "Auto", value: "auto", default: true },
            { label: "Manual", value: "manual" },
        ],
        description: "How the background re-check interval is chosen. Auto (default) tunes it to the number of tracked users (30 s – 30 min); Manual lets you set a fixed interval",
        onChange(value) {
            if (value === "manual") {
                const stored = PlainSettings.plugins.AvatarHistory as Record<string, unknown> | undefined;
                const current = typeof stored?.pollIntervalSeconds === "number" && stored.pollIntervalSeconds > 0
                    ? stored.pollIntervalSeconds
                    : DEFAULT_POLL_INTERVAL_SECONDS;
                settings.store.pollIntervalSeconds = current;
            }
        },
    },
    pollIntervalSeconds: {
        type: OptionType.NUMBER,
        default: 30,
        description: "How often (in seconds) tracked users' avatars are re-checked in the background",
        hidden: () => settings.store.pollIntervalMode !== "manual",
    },
});

function migratePollIntervalSetting(): void {
    const stored = SettingsStore.plain.plugins.AvatarHistory as Record<string, unknown> | undefined;
    if (!stored) return;

    if (Object.hasOwn(stored, "pollIntervalMinutes")) {
        if (!Object.hasOwn(stored, "pollIntervalSeconds")) {
            const minutes = stored.pollIntervalMinutes;
            if (typeof minutes === "number" && minutes > 0) {
                stored.pollIntervalSeconds = minutes * 60;
                if (minutes !== DEFAULT_POLL_INTERVAL_MINUTES) {
                    stored.pollIntervalMode = "manual";
                }
            }
        }
        delete stored.pollIntervalMinutes;
    }

    if (Object.hasOwn(stored, "pollIntervalAuto") && typeof stored.pollIntervalMode !== "string") {
        if (stored.pollIntervalAuto === false) {
            stored.pollIntervalMode = "manual";
        }
        delete stored.pollIntervalAuto;
    }

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
    settings.store.pollIntervalSeconds = seconds;
    return seconds * 1000;
}

function TrackedUsersOverview() {
    useSettings(["plugins.AvatarHistory.*"]);
    const [, force] = useReducer(x => x + 1, 0);

    useEffect(() => {
        const unsubTracked = subscribeTracked(force);
        const unsubFlux = (["RELATIONSHIP_ADD", "RELATIONSHIP_REMOVE", "RELATIONSHIP_UPDATE"] as const).map(ev => {
            const cb = () => force();
            FluxDispatcher.subscribe(ev, cb);
            return () => FluxDispatcher.unsubscribe(ev, cb);
        });
        return () => {
            unsubTracked();
            for (const unsub of unsubFlux) unsub();
        };
    }, []);

    const self = UserStore.getCurrentUser();
    const ids = sweepTargetIds();
    if (self && settings.store.trackSelf) ids.push(self.id);

    const entries = [...new Set(ids)].map(id => {
        const user = UserStore.getUser(id);
        const source = self && id === self.id
            ? "self"
            : settings.store.trackFriends && RelationshipStore.isFriend(id)
                ? "friend"
                : "manual";
        return {
            id,
            user,
            source,
            name: user?.globalName ?? user?.username ?? "Unknown user",
            isSelf: source === "self",
            isFriend: source === "friend",
            isManual: source === "manual",
        };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className={cl("tracked-overview")}>
            <div className={cl("tracked-overview-header")}>
                <span className={cl("tracked-overview-title")}>Tracked users</span>
                <span className={cl("tracked-overview-count")}>{entries.length}</span>
            </div>
            {entries.length === 0 ? (
                <div className={cl("tracked-overview-empty")}>
                    Nothing tracked yet — enable a toggle above or use right-click → "Track avatar changes".
                </div>
            ) : (
                <div className={cl("tracked-overview-list")}>
                    {entries.map(entry => (
                        <div className={cl("tracked-overview-row")} key={entry.id}>
                            <img
                                className={cl("tracked-overview-avatar")}
                                src={entry.user
                                    ? entry.user.getAvatarURL(void 0, 64, true)
                                    : IconUtils.getDefaultAvatarURL(entry.id)}
                                alt=""
                            />
                            <div className={cl("tracked-overview-main")}>
                                <span className={cl("tracked-overview-name")}>{entry.name}</span>
                                <button
                                    type="button"
                                    className={cl("tracked-overview-id")}
                                    onClick={() => copyWithToast(entry.id, "User ID copied")}
                                    title="Copy User ID"
                                >
                                    <CopyIcon width={11} height={11} />
                                    {entry.id}
                                </button>
                            </div>
                            <span className={cl(`tracked-overview-source tracked-overview-source-${entry.source}`)}>
                                {entry.isSelf ? "you" : entry.isFriend ? "friend" : "manual"}
                            </span>
                            {entry.isManual && (
                                <button
                                    type="button"
                                    className={cl("tracked-overview-remove")}
                                    onClick={() => void setTracked(entry.id, false)}
                                    title="Remove from tracking"
                                    aria-label="Remove from tracking"
                                >
                                    <TrashIcon width={14} height={14} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

async function checkUserOnServer(userId: string): Promise<void> {
    if (!shouldTrack(userId)) return;
    try {
        const res: any = await RestAPI.get({ url: Constants.Endpoints.USER(userId), retries: 2 });

        if (res?.status === 429) {
            const waitSeconds = Math.min(Number(res?.body?.retry_after ?? 5), 30);
            log.info(`Rate limited, pausing background checks for ${waitSeconds}s`);
            await new Promise(r => setTimeout(r, waitSeconds * 1000));
            return;
        }
        const user = res?.body ?? res;
        if (!user || user.id !== userId || typeof user.avatar !== "string") return;

        const newest = getHistory(userId)[0];
        if (newest && newest.hash === user.avatar) return;

        FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
    } catch (e) {
        log.warn(`Background avatar check failed for ${userId}`, e);
    }
}

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
