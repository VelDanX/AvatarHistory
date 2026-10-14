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
import { startGatewayTracking, stopGatewayTracking } from "./sync/gateway";
import { pullRecentFromServer } from "./sync/recentSync";
import { startRecentSync, stopRecentSync } from "./sync/sniffer";
import {
    fillHistoryGaps,
    isAnyTrackingActive,
    recordUserAvatar,
    resolvePollIntervalMs,
    shouldTrack,
    startBackgroundSync,
    stopBackgroundSync
} from "./tracking";

const log = new Logger("AvatarHistory");

/** Owns the plugin's background machinery: settings migration, the sniffer, the
 *  periodic sweep and the one-time store bootstrap. */
export function startAvatarHistory(): void {
    migratePollIntervalSetting();

    log.info(
        `Config: trackSelf=${settings.store.trackSelf} trackFriends=${settings.store.trackFriends} `
        + `pollTracked=${settings.store.pollTracked} gatewaySync=${settings.store.gatewaySync} `
        + `poll=${settings.store.pollIntervalMode} ${Math.round(resolvePollIntervalMs() / 1000)}s`
    );

    let resolveReady!: () => void;
    const storeReady = new Promise<void>(r => resolveReady = r);

    startRecentSync(isAnyTrackingActive, storeReady, shouldTrack);
    startBackgroundSync(storeReady);
    // Taps the WebSocket the client already holds; gated on storeReady inside.
    startGatewayTracking(storeReady);

    void loadStore().then(() => {
        if (settings.store.trackSelf) {
            const self = UserStore.getCurrentUser();
            if (self?.avatar) {
                // Both links can reject (persistTrackedSet and the store write
                // inside recordUserAvatar) and nothing else awaits them, so the
                // chain ends in a catch — otherwise a failed startup record
                // would surface as an unhandled rejection with no attribution.
                void setTracked(self.id, true)
                    .then(() => recordUserAvatar(self))
                    .catch(e => log.warn("Startup: failed to record own avatar", e));
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
    log.info("Stopped");
    stopGatewayTracking();
    stopRecentSync();
    stopBackgroundSync();
    clearBlobUrls();
    // A sweep may have touched lastSeenAt moments before shutdown.
    void flushLastSeen();
}
