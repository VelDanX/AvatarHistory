/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./src/style.css";

import { addProfileSection, removeProfileSection } from "@api/ProfileSections";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { User } from "@vencord/discord-types";

import { userContextPatch } from "./src/contextMenu";
import { startAvatarHistory, stopAvatarHistory } from "./src/services";
import { settings } from "./src/settings";
import { recordUserAvatar, recordUserIfChanged } from "./src/tracking";
import { AvatarHistoryProfileSection } from "./src/ui/ProfileSection";

const log = new Logger("AvatarHistory");

/**
 * Records a user from a flux event, logging a failure instead of dropping it.
 *
 * Nothing awaits a dispatch handler, so a rejection from the CDN probe or the
 * store write would arrive as an unhandled rejection with no indication of
 * which event or user produced it. `GUILD_MEMBERS_CHUNK_BATCH` in particular
 * fans out over every member of every guild the client has open, so a shared
 * failure there repeats dozens of times.
 */
function recordUserQuietly(user: Partial<User> | undefined, source: string): void {
    recordUserIfChanged(user)?.catch(e => log.warn(`${source}: failed to record ${user?.id}`, e));
}

export default definePlugin({
    name: "AvatarHistory",
    description: "Passively save avatar history of tracked users and browse it from their profile.",
    authors: [{ name: "VelDanX", id: 1348551557355933759n }],
    version: "0.0.6",
    settings,
    dependencies: ["ProfileSectionsAPI"],

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch,
        "user-profile-overflow-menu": userContextPatch,
    },

    flux: {
        USER_UPDATE({ user }: { user?: User }) {
            recordUserQuietly(user, "USER_UPDATE");
        },
        PRESENCE_UPDATES({ users }: { users?: Array<Partial<User>> }) {
            for (const user of users ?? []) recordUserQuietly(user, "PRESENCE_UPDATES");
        },
        CURRENT_USER_UPDATE({ user }: { user?: User }) {
            if (!user?.avatar || !settings.store.trackSelf) return;
            // Not via recordUserIfChanged: that one compares against the newest
            // stored hash, and this path is the one that has to notice a change
            // of *your own* avatar — which is precisely a hash the store does not
            // have yet. Direct, and caught: this is the hottest recording path in
            // the plugin, firing on every swap you make.
            recordUserAvatar(user).catch(e => log.warn("CURRENT_USER_UPDATE: failed to record", e));
        },
        // Guild member data carries the current avatar hash without any
        // rendering, so a swap is visible before that avatar hits the screen.
        GUILD_MEMBER_UPDATE({ user }: { user?: Partial<User> }) {
            recordUserQuietly(user, "GUILD_MEMBER_UPDATE");
        },
        GUILD_MEMBERS_CHUNK_BATCH({ chunks }: { chunks?: Array<{ members?: Array<{ user?: Partial<User> }> }> }) {
            for (const chunk of chunks ?? []) {
                for (const member of chunk?.members ?? []) recordUserQuietly(member?.user, "GUILD_MEMBERS_CHUNK_BATCH");
            }
        },
    },

    start() {
        startAvatarHistory();
        addProfileSection("avatarHistory", props => <AvatarHistoryProfileSection {...props} />);
        log.info("AvatarHistory started");
    },

    stop() {
        stopAvatarHistory();
        removeProfileSection("avatarHistory");
        log.info("AvatarHistory stopped");
    },
});
