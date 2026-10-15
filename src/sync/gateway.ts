/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { FluxDispatcher } from "@webpack/common";

import { settings } from "../settings";
import { getHistory, sameHash } from "../store";
import { recordUserIfChanged, shouldTrack } from "../tracking";

const log = new Logger("AvatarHistory");

/**
 * Which gateway dispatches carry a user's avatar, and where to read it.
 *
 * Discord's client already holds the gateway WebSocket open; FluxDispatcher
 * re-emits every dispatch it receives, so this taps the stream that is already
 * there — no connection, no requests, no intents of our own.
 *
 * - `USER_UPDATE` — the payload *is* the user object (self and contacts).
 * - `GUILD_MEMBER_UPDATE` — a member payload, so the global avatar sits on
 *   `user`. The top-level `avatar` on it is the *guild* avatar, served from
 *   `/guilds/<guild>/users/<user>/` on the CDN, which is not what this store
 *   keeps — deliberately ignored.
 * - `MESSAGE_CREATE` — `author`. The only source for messages the client never
 *   painted: virtualized lists do not render what you do not scroll to.
 * - `PRESENCE_UPDATES` — `updates`, an array of `{ user, ... }`. This is the
 *   flux action Discord batches the raw `PRESENCE_UPDATE` gateway dispatch
 *   into; there is no `PRESENCE_UPDATE` action to subscribe to. It is the only
 *   source that reaches a tracked user you share no guild with (USER_UPDATE is
 *   about yourself, GUILD_MEMBER_UPDATE is per guild). The docs allow each
 *   `user` to be as partial as `{ id }`.
 *
 * Every event still goes through `recordUserIfChanged()`, so only tracked
 * users, friends (when enabled) and self are ever recorded.
 *
 * These four are the *only* subscribers of USER_UPDATE, PRESENCE_UPDATES and
 * GUILD_MEMBER_UPDATE in the plugin. The flux hooks in index.tsx used to
 * subscribe to the same three as well: every event then ran both paths, only
 * claimAvatarAttempt in tracking.ts kept the second from probing again, and
 * turning gatewaySync off merely silenced this file while the flux copies kept
 * recording. Do not re-subscribe them anywhere else — the setting that gates
 * this listener must be the single switch for these events.
 */
const SOURCES = {
    USER_UPDATE: (payload: any) => [payload],
    GUILD_MEMBER_UPDATE: (payload: any) => [payload?.user],
    MESSAGE_CREATE: (payload: any) => [payload?.author],
    PRESENCE_UPDATES: (payload: any) => payload?.updates?.map((update: any) => update?.user) ?? [],
} satisfies Record<string, (payload: any) => Array<Partial<User> | undefined>>;

let unsubscribeAll: Array<() => void> | null = null;
let storeReady = false;

/**
 * Last logged state per user, so a line is written on a transition only.
 *
 * A tracked user on Discord's default avatar emits `null` from
 * `GUILD_MEMBER_UPDATE` on every nick or role change, and a tracked user with a
 * known hash emits `known` on every event — logging the state rather than the
 * change buries the transitions that matter. Keyed like `avatarAttempts` in
 * tracking.ts, and cleared with the subscription on stop.
 */
const lastLoggedState = new Map<string, string>();

export function startGatewayTracking(ready: Promise<void>): void {
    if (unsubscribeAll) return;
    unsubscribeAll = [];
    void ready.then(() => {
        if (unsubscribeAll) storeReady = true;
    });

    for (const event of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
        const pick = SOURCES[event];
        const listener = (payload: unknown) => {
            // A record arriving before loadStore() would be persisted over a
            // store that has not been read yet, dropping everyone else's
            // history — the startup gap fill covers this window instead.
            if (!storeReady || !settings.store.gatewaySync) return;
            for (const user of pick(payload)) {
                // Cheap Set lookup first: MESSAGE_CREATE volume, the whole
                // `updates` array of a presence batch, and payloads with no user
                // at all must not reach the history read below.
                if (!user?.id || !shouldTrack(user.id)) continue;
                // A presence `user` may be `{ id }` and nothing else (docs):
                // taken as "no avatar" it would log a null on every status ping
                // of that user.
                if (event === "PRESENCE_UPDATES" && !("avatar" in user)) continue;

                // `avatar` may be null — the user is on Discord's default avatar,
                // there is no hash to store — so it is reported and dropped
                // rather than recorded. `known` means the store already has this
                // exact hash: only the last-seen timestamp gets refreshed.
                const newest = getHistory(user.id)[0];
                const state = !user.avatar ? "null" : newest && sameHash(newest.hash, user.avatar) ? "known" : "new";
                // Log transitions, not states. `log.debug` is not an option here:
                // console.debug does not reach renderer_js.log, so these lines
                // only exist in DevTools. Instead the first sighting of a state is
                // written and repeats are dropped — a user whose hash is already
                // known, or who has no avatar at all, leaves one line and then
                // silence, while every actual change still logs.
                if (lastLoggedState.get(user.id) !== state) {
                    lastLoggedState.set(user.id, state);
                    log.info(`Gateway ${event}: ${user.id} avatar ${state}`);
                }

                // Caught rather than dropped: there is no sweep here to count the
                // error, so an escaping rejection would surface as an unhandled
                // promise with nothing to connect it to this user's hash.
                recordUserIfChanged(user)?.catch(e => log.warn(`Gateway ${event}: failed to record ${user.id}`, e));
            }
        };
        FluxDispatcher.subscribe(event, listener);
        unsubscribeAll.push(() => FluxDispatcher.unsubscribe(event, listener));
    }
    log.info(`Gateway collection active: ${Object.keys(SOURCES).join(", ")}`);
}

export function stopGatewayTracking(): void {
    if (!unsubscribeAll) return;
    for (const off of unsubscribeAll) off();
    unsubscribeAll = null;
    storeReady = false;
    lastLoggedState.clear();
}
