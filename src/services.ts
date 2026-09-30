/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import { migratePollIntervalSetting, settings } from "./settings";
import { clearBlobUrls, flushLastSeen, loadStore, setTracked } from "./store";
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

/** Owns the plugin's background machinery: settings migration, the sniffer, the
 *  periodic sweep and the one-time store bootstrap. */
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
        void fillHistoryGaps().catch(e => log.warn("Startup gap fill failed", e));
    }).finally(() => {
        resolveReady();
        const self = UserStore.getCurrentUser();
        void pullRecentFromServer();
        // Self only: other users' records are still back-fill candidates, and
        // purgeInvalidRecords would eat the ones whose CDN copy is already gone.
        if (self) void purgeInvalidRecords(self.id);
    });
}

export function stopAvatarHistory(): void {
    stopRecentSync();
    stopBackgroundSync();
    clearBlobUrls();
    // A sweep may have touched lastSeenAt moments before shutdown.
    void flushLastSeen();
}
