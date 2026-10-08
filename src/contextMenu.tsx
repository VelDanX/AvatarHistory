/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { Menu, RelationshipStore, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { isTracked, setTracked } from "./store";
import { syncRecentNow } from "./sync/recentSync";
import { recordUserAvatar, resetAndResync } from "./tracking";

const log = new Logger("AvatarHistory");

/**
 * A menu action has no caller to await it, and recordUserAvatar awaits both the
 * CDN probe and the store write — so without this a failure here is an
 * unhandled rejection with no mention of what was clicked.
 */
function recordFromMenu(user: User, what: string): void {
    void recordUserAvatar(user).catch(e => log.warn(`"${what}": failed to record ${user.id}`, e));
}

export const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User }) => {
    if (!user) return;
    const me = UserStore.getCurrentUser();
    const isSelf = me != null && user.id === me.id;

    const items = [
        <Menu.MenuItem
            key="vc-avh-remember"
            id="vc-avh-remember"
            label="Remember current avatar"
            action={() => recordFromMenu(user, "Remember current avatar")}
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
                        if (next) recordFromMenu(user, "Track avatar changes");
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
