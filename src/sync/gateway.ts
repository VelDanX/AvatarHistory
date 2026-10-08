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
 * - `PRESENCE_UPDATE` — `user`, and the only one that reaches a tracked user you
 *   share no guild with (USER_UPDATE is about yourself, GUILD_MEMBER_UPDATE is
 *   per guild). The docs allow this `user` to be as partial as `{ id }`.
 *
 * Every event still goes through `recordUserIfChanged()`, so only tracked
 * users, friends (when enabled) and self are ever recorded.
 */
const SOURCES = {
    USER_UPDATE: (payload: any) => payload ?? undefined,
    GUILD_MEMBER_UPDATE: (payload: any) => payload?.user ?? undefined,
    MESSAGE_CREATE: (payload: any) => payload?.author ?? undefined,
    PRESENCE_UPDATE: (payload: any) => payload?.user ?? undefined,
} satisfies Record<string, (payload: any) => Partial<User> | undefined>;

let unsubscribeAll: Array<() => void> | null = null;
let storeReady = false;

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
            const user = pick(payload);
            // Cheap Set lookup first: MESSAGE_CREATE volume and payloads with no
            // user at all must not reach the history read below.
            if (!user?.id || !shouldTrack(user.id)) return;
            // A presence `user` may be `{ id }` and nothing else (docs): taken as
            // "no avatar" it would log a null on every status ping of that user.
            if (event === "PRESENCE_UPDATE" && !("avatar" in user)) return;

            // `avatar` may be null — the user is on Discord's default avatar,
            // there is no hash to store — so it is reported and dropped rather
            // than recorded. `known` means the store already has this exact
            // hash: only the last-seen timestamp gets refreshed.
            const newest = getHistory(user.id)[0];
            const state = !user.avatar ? "null" : newest && sameHash(newest.hash, user.avatar) ? "known" : "new";
            // Noise budget: profile events are rare, so they always leave a
            // trace; MESSAGE_CREATE and PRESENCE_UPDATE fire constantly and only
            // earn a line when they bring a hash we have not seen yet.
            const quiet = event === "MESSAGE_CREATE" || event === "PRESENCE_UPDATE";
            if (state === "new" || !quiet)
                log.info(`Gateway ${event}: ${user.id} avatar ${state}`);

            recordUserIfChanged(user);
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
}
