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
        startAvatarHistory();
        addProfileSection("avatarHistory", props => <AvatarHistoryProfileSection {...props} />);
        log.info("AvatarHistory started");
    },

    stop() {
        stopAvatarHistory();
        removeProfileSection("avatarHistory");
    },
});
