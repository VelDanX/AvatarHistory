/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import { migratePollIntervalSetting, settings } from "./settings";
import { clearBlobUrls, flushHistory, loadStore, setTracked } from "./store";
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

/**
 * Bumped by every startAvatarHistory() and stopAvatarHistory(). It is what
 * makes the readiness gate survive a restart: a stop() reopens the window this
 * gate protects (the next start() has its own loadStore() in flight again), so
 * a store bootstrap or a whenStoreLoaded() callback belonging to a superseded
 * start() must be dropped instead of flipping storeLoaded or landing its record
 * on a store the fresh start() has not (re)loaded yet.
 */
let generation = 0;

/** Runs `run` once the store has been read — immediately if it already has.
 *  A deferred callback is dropped if the plugin is stopped or restarted before
 *  the store of *its* generation finished reading, and a synchronous throw in
 *  `run` is caught here: a deferred run has no plugin-manager try/catch around
 *  it, so an escaped throw would surface only as an unhandled rejection. */
export function whenStoreLoaded(run: () => void): void {
    const guarded = () => {
        try {
            run();
        } catch (e) {
            log.warn("whenStoreLoaded: deferred record failed", e);
        }
    };
    if (storeLoaded) {
        guarded();
        return;
    }
    const ready = storeReady;
    // A null storeReady means start() has not run yet: there is no store to
    // wait on and none to write through, so drop rather than fire blind.
    if (!ready) return;
    const gen = generation;
    void ready.then(() => {
        if (gen !== generation) return;
        guarded();
    });
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

    // Distinct generation for this start(); a stop()/restart bumps `generation`
    // to supersede this bootstrap and everything it deferred.
    const myGen = ++generation;
    let resolveReady!: () => void;
    storeReady = new Promise<void>(r => resolveReady = r);

    startRecentSync(isAnyTrackingActive, storeReady, shouldTrack);
    startBackgroundSync(storeReady);
    // Taps the WebSocket the client already holds; gated on storeReady inside.
    startGatewayTracking(storeReady);

    void loadStore().then(() => {
        // A stop() (or a fast stop→start) supersedes this bootstrap before the
        // read finishes: skip recording self and back-filling gaps into a store
        // the next start() has not (re)loaded yet.
        if (myGen !== generation) return;
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
        // Gate the *effects*, not the resolution. The other awaiters of this
        // storeReady (sniffer, BackgroundSync, gateway) settle on their own
        // stopped/null checks, so resolving unconditionally keeps a superseded
        // storeReady from dangling. What must not happen is a superseded start()
        // flipping storeLoaded or running pullRecent/purge against a store the
        // fresh start() has not reloaded yet.
        if (myGen === generation) {
            storeLoaded = true;
            const self = UserStore.getCurrentUser();
            void pullRecentFromServer();
            // Self only: other users' records are still back-fill candidates,
            // and purgeInvalidRecords would eat the ones whose CDN copy is
            // already gone.
            if (self) void purgeInvalidRecords(self.id);
        }
        resolveReady();
    });
}

export function stopAvatarHistory(): void {
    // Supersede any store bootstrap still in flight and drop everything
    // whenStoreLoaded() deferred. A restart reopens the exact window this gate
    // protects, so bumping the generation here is what stops a stale record or
    // a superseded bootstrap tail from landing on the store the next start()
    // has not reloaded yet.
    generation++;
    storeLoaded = false;
    storeReady = null;
    log.info("Stopped");
    stopGatewayTracking();
    stopRecentSync();
    stopBackgroundSync();
    clearBlobUrls();
    // A sweep may have touched the store moments before shutdown.
    void flushHistory();
}
