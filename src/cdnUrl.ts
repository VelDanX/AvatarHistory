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

/** Ordered candidates for one record: per path (archived first when the record
 *  carries an avatarId), for each size in the caller's preference order.
 *  Discord serves only some of the size/path variants of a replaced avatar, so
 *  callers walk this list on `<img>` error instead of trusting one URL. */
export function buildAvatarUrlFallbacks(
    userId: string,
    hash: string,
    format: "png" | "gif" | "webp",
    avatarId: string | undefined,
    sizes: number[]
): string[] {
    const paths: Array<string | undefined> = avatarId ? [avatarId, undefined] : [undefined];
    return paths.flatMap(id => sizes.map(size => buildAvatarUrl(userId, hash, format, size, id)));
}
