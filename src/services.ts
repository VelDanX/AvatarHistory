/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import { migratePollIntervalSetting, settings } from "./settings";
import { clearBlobUrls, loadStore, setTracked } from "./store";
import { purgeInvalidRecords } from "./sync/cdn";
import { pullRecentFromServer } from "./sync/recentSync";
import { startRecentSync, stopRecentSync } from "./sync/sniffer";
import {
    fillHistoryGaps,
    isAnyTrackingActive,
    recordUserAvatar,
    shouldTrack,
    startBackgroundSync,
    stopBackgroundSync
} from "./tracking";

const log = new Logger("AvatarHistory");

/**
 * Owns the plugin's background machinery: settings migration, the recent-avatar
 * sniffer, the periodic sweep and the one-time store bootstrap (self tracking,
 * gap fill, CDN purge). Returns once everything is wired up; index.tsx just
 * calls start/stop.
 */
export function startAvatarHistory(): void {
    migratePollIntervalSetting();

    let resolveReady!: () => void;
    const storeReady = new Promise<void>(r => resolveReady = r);

    startRecentSync(isAnyTrackingActive, storeReady, shouldTrack);
    startBackgroundSync(storeReady);

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

    log.info("AvatarHistory started");
}

export function stopAvatarHistory(): void {
    stopRecentSync();
    stopBackgroundSync();
    clearBlobUrls();
}
