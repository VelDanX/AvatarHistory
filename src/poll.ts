/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RelationshipStore, UserStore } from "@webpack/common";

import { MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from "./config";
import { getLastSeenAt, trackedUsers } from "./store";
import { DEFAULT_STAGGER_MS } from "./sync/bgSync";

/** Target ids for the sweep (friends + tracked, minus self), stalest first.
 *  Sorting by `lastSeenAt` beats a rotating offset: a checked user moves to the
 *  back automatically, and a client that was closed for a while still checks
 *  the stalest users first.
 *
 *  `includeFriends` is passed in so this module stays free of settings. */
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

/** Auto interval, whole seconds: one request per `DEFAULT_STAGGER_MS` across
 *  the tracked set, clamped to 30 s – 30 min. Computed on demand, never
 *  persisted (see settings.tsx onChange). */
export function smartPollIntervalSeconds(includeFriends: boolean): number {
    const pacedMs = Math.max(1, sweepTargetIds(includeFriends).length) * DEFAULT_STAGGER_MS;
    const clampedMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, pacedMs));
    return Math.max(1, Math.round(clampedMs / 1000));
}
