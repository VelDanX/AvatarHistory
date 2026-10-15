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

/**
 * Whether loadStore() has finished reading. Flux events of a *started* plugin
 * arrive while the read is still in flight, and persistHistory() writes the
 * whole history object: a record written in that window is either clobbered
 * by the pending read, or the read is served a payload containing nothing but
 * that one user and the rest of the history is overwritten with it. The
 * gateway listeners gate on this, and so do the two flux handlers left in
 * index.tsx (CURRENT_USER_UPDATE and GUILD_MEMBERS_CHUNK_BATCH — the latter is
 * the event most likely to land here, since it fires as the member chunks of
 * a (re)connect arrive).
 */
let storeLoaded = false;
let storeReady: Promise<void> | null = null;

/** Runs `run` once the store has been read — immediately if it already has.
 *  The callback itself must stay fire-and-forget safe; it is invoked at most
 *  once per readiness, from a promise continuation. */
export function whenStoreLoaded(run: () => void): void {
    if (storeLoaded) {
        run();
        return;
    }
    void storeReady?.then(run);
}

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
    storeReady = new Promise<void>(r => resolveReady = r);

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
        storeLoaded = true;
        resolveReady();
        const self = UserStore.getCurrentUser();
        void pullRecentFromServer();
        // Self only: other users' records are still back-fill candidates, and
        // purgeInvalidRecords would eat the ones whose CDN copy is already gone.
        if (self) void purgeInvalidRecords(self.id);
    });
}

export function stopAvatarHistory(): void {
    // Anything deferred by whenStoreLoaded() would run into a store the next
    // start() has not loaded yet, and a restart is exactly when the window it
    // guards reopens.
    storeLoaded = false;
    storeReady = null;
    log.info("Stopped");
    stopGatewayTracking();
    stopRecentSync();
    stopBackgroundSync();
    clearBlobUrls();
    // A sweep may have touched lastSeenAt moments before shutdown.
    void flushLastSeen();
}
