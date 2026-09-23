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

/** How often the sniffer rescans resource timings / page images. */
export const RESOURCE_SWEEP_INTERVAL_MS = 30_000;

/** Cheap substring pre-filter before running the avatar regex. */
export const CDN_AVATAR_MARKER = "cdn.discordapp.com/avatars/";

/** Re-check delay when Discord's CDN rejects an avatar hash. */
export const CDN_RETRY_DELAY_MS = 10_000;

/** Delay between users when backfilling history on plugin start. */
export const GAP_FILL_STAGGER_MS = 300;

/** Poll interval defaults (minutes kept only for settings migration). */
export const DEFAULT_POLL_INTERVAL_MINUTES = 10;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;

export const MIN_POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_INTERVAL_MS = 30 * 60_000;
