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

export const HISTORY_VERSION = 1;

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

export type AvatarHistory = Record<string, AvatarRecord[]>;

export interface StoredHistory {
    version: number;
    users: AvatarHistory;
}

export const blobKeyFor = (userId: string, hash: string) => `${BLOB_KEY_PREFIX}${userId}:${hash}`;
