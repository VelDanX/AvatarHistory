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

/** Largest `size` Discord serves for a user avatar. */
export const CDN_SIZE_MAX = 1024;

/** `size` must be a power of two; Discord clamps anything larger than the source
 *  down to the source itself, so these are request buckets, not output sizes. */
const CDN_SIZE_BUCKETS = [16, 32, 64, 128, 256, 512, 1024];

/** Smallest CDN bucket that holds `native` px, so the request is never larger
 *  than the source. Returns the CDN maximum when the native size is unknown
 *  (0) or already exceeds it. */
export function cdnSizeFor(native: number): number {
    if (!Number.isFinite(native) || native <= 0) return CDN_SIZE_MAX;
    for (const size of CDN_SIZE_BUCKETS) if (size >= native) return size;
    return CDN_SIZE_MAX;
}

/**
 * Caps a caller's preferred size (its first entry) at the record's own
 * resolution. Discord's CDN never upscales — a request above the source returns
 * the source — so this is what keeps a small avatar's URLs honest: the copied
 * link and the saved file say the size the avatar actually has, instead of
 * always claiming 1024. Larger entries stay as fallbacks (a replaced avatar may
 * only serve some variants); the original order is returned untouched when the
 * native size is unknown or already fits the preferred bucket.
 */
export function sizesCappedToNative(sizes: number[], native: number): number[] {
    if (!Number.isFinite(native) || native <= 0) return sizes;
    const best = Math.min(sizes[0], cdnSizeFor(native));
    return best === sizes[0] ? sizes : [best, ...sizes.filter(size => size !== best)];
}
