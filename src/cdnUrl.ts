/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Builds a Discord CDN URL for an avatar, optionally an archived one
 *  (`/avatars/:userId/archived/:avatarId/` vs plain `/avatars/:userId/`). */
export function buildAvatarUrl(userId: string, hash: string, format: "png" | "gif" | "webp", size: number, avatarId?: string): string {
    const ext = format === "gif" ? "gif" : format === "webp" ? "webp" : "png";
    if (avatarId) return `https://cdn.discordapp.com/avatars/${userId}/archived/${avatarId}/${hash}.${ext}?size=${size}`;
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=${size}`;
}
