/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Max size of a single cached avatar blob (per-avatar limit). */
export const BLOB_BUDGET_BYTES = 10 * 1024 * 1024;

/** Max entries in the sniffer's "already seen" dedup set. */
export const SEEN_LIMIT = 10_000;

/** Timeout for a single CDN existence probe (one <img> load attempt). */
export const CDN_CHECK_TIMEOUT_MS = 5_000;

/**
 * How long a successful control-asset probe stays trusted before the CDN is
 * checked again. The control answers "is the network up", so a cached answer
 * older than this could turn a real outage into a string of false 404s.
 */
export const CDN_CONTROL_TTL_MS = 30_000;

/**
 * Abort timeout for downloading an avatar blob, per URL — so a record with an
 * avatarId can take up to `2 x BLOB_FETCH_SIZES.length` of these. Generous vs
 * the HEAD check because the body transfer has to actually finish and an
 * animated avatar can be a few MB.
 *
 * It still has to exist: an unbounded fetch that hangs leaves its key in
 * `pendingBlobs` forever and every later caller gets that dead promise, so the
 * avatar is never downloaded again for the rest of the session.
 */
export const BLOB_FETCH_TIMEOUT_MS = 20_000;

/**
 * CDN sizes the blob saver tries, best quality first: a stored copy is what is
 * left once Discord drops the hash from the CDN, so keep the biggest variant
 * that still exists — Discord serves only some size variants of a replaced
 * avatar, which is why this is a list and not one URL.
 */
export const BLOB_FETCH_SIZES = [1024, 512, 256];

/** How often the sniffer rescans resource timings / page images. */
export const RESOURCE_SWEEP_INTERVAL_MS = 30_000;

/** Cheap substring pre-filter before running the avatar regex. */
export const CDN_AVATAR_MARKER = "cdn.discordapp.com/avatars/";

/** Re-check delay when Discord's CDN rejects an avatar hash. */
export const CDN_RETRY_DELAY_MS = 10_000;

/**
 * How long one user+hash attempt at recording a *new* avatar is remembered.
 *
 * The gateway stream is chatty and `MESSAGE_CREATE` fires per message: a hash
 * the CDN keeps refusing would otherwise turn every message from that user into
 * a fresh probe burst, and two events landing together would both record it.
 * Matches the 5-minute write throttle the standalone collector (discord-u-n)
 * applies to the same events.
 */
export const AVATAR_ATTEMPT_TTL_MS = 5 * 60_000;

/** Cap on that attempt log, so a churning tracked set cannot grow it forever. */
export const AVATAR_ATTEMPT_LIMIT = 2_000;

/**
 * Floor for the Auto-mode REST sweep while the gateway stream is on.
 *
 * With events delivering avatar changes as they happen, the sweep is no longer
 * the source of truth — it is the net under what events miss (disconnects,
 * users with no shared guild, records written before tracking started). Running
 * it every 30 seconds was competing with the very stream that made it redundant.
 * The paced value still wins above the floor: it exists so a large tracked set
 * cannot burst its requests.
 */
export const GATEWAY_POLL_MIN_INTERVAL_MS = 5 * 60_000;

/** Delay between users when backfilling history on plugin start. */
export const GAP_FILL_STAGGER_MS = 300;

/** Upper bound on how often the coalesced `lastSeenAt` writes hit the store. */
export const SEEN_FLUSH_INTERVAL_MS = 5_000;

/** Poll interval defaults (minutes kept only for settings migration). */
export const DEFAULT_POLL_INTERVAL_MINUTES = 10;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;

export const MIN_POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_INTERVAL_MS = 30 * 60_000;
