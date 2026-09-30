/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RelationshipStore, UserStore } from "@webpack/common";

import { MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from "./config";
import { getLastSeenAt, trackedUsers } from "./store";
import { DEFAULT_STAGGER_MS } from "./sync/bgSync";

/**
 * Target ids for the background sweep (friends + manually tracked, minus self),
 * ordered stalest-confirmation-first.
 *
 * Sorting by `lastSeenAt` replaces a rotating offset: a checked user moves to
 * the back automatically, so the list is self-balancing. That also makes the
 * sweep survive the client being closed — on the next launch nobody has been
 * confirmed recently, so the stalest users are checked first instead of whoever
 * happens to sit at the head of a static array.
 *
 * `includeFriends` is passed in rather than read from settings, so this module
 * stays free of the settings module: callers (the sweep, the settings UI) read
 * the flag themselves.
 */
export function sweepTargetIds(includeFriends: boolean): string[] {
    const ids = new Set<string>();
    if (includeFriends) {
        for (const id of RelationshipStore.getFriendIDs()) ids.add(id);
    }
    for (const id of trackedUsers) ids.add(id);
    const self = UserStore.getCurrentUser();
    if (self) ids.delete(self.id);
    return [...ids].sort((a, b) => getLastSeenAt(a) - getLastSeenAt(b));
}

/**
 * Auto interval, in whole seconds: pace one request per `DEFAULT_STAGGER_MS`
 * across the tracked set, clamped to 30 s – 30 min.
 *
 * Pure by design — the Auto interval is a derived value, so it is computed on
 * demand and never persisted. Nothing here writes to settings; the only place
 * that value becomes a setting is the manual-mode switch in settings.tsx.
 */
export function smartPollIntervalSeconds(includeFriends: boolean): number {
    const pacedMs = Math.max(1, sweepTargetIds(includeFriends).length) * DEFAULT_STAGGER_MS;
    const clampedMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pacedMs));
    return Math.max(1, Math.round(clampedMs / 1000));
}
