/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Max size of a single cached avatar blob (per-avatar limit). */
export const BLOB_BUDGET_BYTES = 10 * 1024 * 1024;

/** Max entries in the sniffer's "already seen" dedup set. */
export const SEEN_LIMIT = 10_000;

/** Abort timeout for a single CDN HEAD request. */
export const CDN_HEAD_TIMEOUT_MS = 5_000;

/**
 * Abort timeout for downloading an avatar blob. Generous compared to the HEAD
 * check: the body transfer has to actually finish, and an animated avatar can
 * be a few MB. It still has to exist — an unbounded fetch that hangs leaves its
 * key in `pendingBlobs` forever, and every later caller is handed the dead
 * promise, so that avatar is never downloaded again for the rest of the session.
 */
export const BLOB_FETCH_TIMEOUT_MS = 20_000;

/** How often the sniffer rescans resource timings / page images. */
export const RESOURCE_SWEEP_INTERVAL_MS = 30_000;

/** Cheap substring pre-filter before running the avatar regex. */
export const CDN_AVATAR_MARKER = "cdn.discordapp.com/avatars/";

/** Re-check delay when Discord's CDN rejects an avatar hash. */
export const CDN_RETRY_DELAY_MS = 10_000;

/** Delay between users when backfilling history on plugin start. */
export const GAP_FILL_STAGGER_MS = 300;

/** Upper bound on how often the coalesced `lastSeenAt` writes hit the store. */
export const SEEN_FLUSH_INTERVAL_MS = 5_000;

/** Poll interval defaults (minutes kept only for settings migration). */
export const DEFAULT_POLL_INTERVAL_MINUTES = 10;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;

export const MIN_POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_INTERVAL_MS = 30 * 60_000;
