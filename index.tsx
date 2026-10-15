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
import { startAvatarHistory, stopAvatarHistory, whenStoreLoaded } from "./src/services";
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

    // This plugin owns exactly two flux events. USER_UPDATE, PRESENCE_UPDATES
    // and GUILD_MEMBER_UPDATE are deliberately NOT here: they used to be, and
    // every one of them then fired twice — once here and once from the gateway
    // listener of the same event in sync/gateway.ts, which subscribes inside
    // start() and therefore always first. Only claimAvatarAttempt (tracking.ts)
    // kept the second pass from probing the CDN again, so the duplicate cost
    // was pure overhead and no fallback at all: a failed first record stayed
    // suppressed for the attempt TTL. Those three now live solely in
    // sync/gateway.ts, gated on the gatewaySync setting, so the flag finally
    // means what the settings and README say it means. Do not re-add them.
    //
    // What remains are the two events the gateway listeners do not read:
    flux: {
        CURRENT_USER_UPDATE({ user }: { user?: User }) {
            if (!user?.avatar || !settings.store.trackSelf) return;
            whenStoreLoaded(() =>
                // Not via recordUserIfChanged: that one compares against the newest
                // stored hash, and this path is the one that has to notice a change
                // of *your own* avatar — which is precisely a hash the store does not
                // have yet. Direct, and caught: this is the hottest recording path in
                // the plugin, firing on every swap you make.
                recordUserAvatar(user).catch(e => log.warn("CURRENT_USER_UPDATE: failed to record", e)));
        },
        // Guild member data carries the current avatar hash without any
        // rendering, so a swap is visible before that avatar hits the screen.
        // A bulk snapshot rather than a per-change event: it fires once per
        // guild on (re)connect and fans out over every member, which is also
        // why it is the one event that can land before loadStore() has read
        // anything — whenStoreLoaded() below defers it out of that window
        // instead of persisting over a not-yet-read store.
        GUILD_MEMBERS_CHUNK_BATCH({ chunks }: { chunks?: Array<{ members?: Array<{ user?: Partial<User> }> }> }) {
            whenStoreLoaded(() => {
                for (const chunk of chunks ?? []) {
                    for (const member of chunk?.members ?? []) recordUserQuietly(member?.user, "GUILD_MEMBERS_CHUNK_BATCH");
                }
            });
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
