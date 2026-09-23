/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { CopyIcon, TrashIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { FluxDispatcher, IconUtils, RelationshipStore, useEffect, useReducer,UserStore } from "@webpack/common";

import { settings } from "../settings";
import { setTracked, subscribeTracked } from "../store";
import { sweepTargetIds } from "../tracking";

const cl = classNameFactory("vc-avh-");

export function TrackedUsersOverview() {
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
