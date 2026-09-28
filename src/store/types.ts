/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BLOB_BUDGET_BYTES } from "../config";

export { BLOB_BUDGET_BYTES };

export const HISTORY_KEY = "vc-avh-history";
export const TRACKED_KEY = "vc-avh-tracked";
export const BLOB_KEY_PREFIX = "vc-avh-blob:";

export const HISTORY_VERSION = 2;

export interface AvatarRecord {
    hash: string;
    avatarId?: string;
    timestamp: number;
    format: "png" | "gif" | "webp";
    size: number;
    hasBlob: boolean;
    width: number;
    height: number;
}

export interface UserHistory {
    /** Avatars, newest first. Always replaced wholesale, never mutated. */
    records: AvatarRecord[];
    /**
     * Epoch ms of the last moment we confirmed this user's *current* avatar
     * hash ourselves. 0 means "never confirmed" — those users sort first in
     * the background sweep. Deliberately not part of the export format: an
     * imported file cannot carry a meaningful observation time.
     */
    lastSeenAt: number;
}

export type AvatarHistory = Record<string, UserHistory>;

export interface StoredHistory {
    version: number;
    users: AvatarHistory;
}

export const blobKeyFor = (userId: string, hash: string) => `${BLOB_KEY_PREFIX}${userId}:${hash}`;

/**
 * Hash equality, case-insensitive. Avatar hashes are hex and Discord sends
 * them lowercased, but records written from raw `user.avatar` strings are not
 * normalized anywhere else — comparing with `===` could otherwise treat a
 * casing difference as a brand new avatar and record it twice.
 */
export const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
