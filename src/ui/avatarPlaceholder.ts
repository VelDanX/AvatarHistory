/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AvatarRecord } from "../store";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Stand-in for a record whose image is gone from the CDN and that has no local
 *  copy: a 512x512 SVG with the record's date instead of a broken-image glyph.
 *  It is a data URI on purpose — the real `<img>` element survives, so refs,
 *  keyboard navigation and context menus stay attached, and unlike a network
 *  image it can never fail again. */
export function unavailableAvatarDataUrl(rec: AvatarRecord): string {
    const d = new Date(rec.timestamp);
    const when = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const year = String(d.getFullYear());
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'>"
        + "<defs><linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'>"
        + "<stop offset='0' stop-color='#7f9c8b'/><stop offset='0.55' stop-color='#456b58'/>"
        + "<stop offset='1' stop-color='#2c4f4e'/></linearGradient>"
        + "<clipPath id='c'><rect width='512' height='512' rx='40'/></clipPath></defs>"
        + "<g clip-path='url(#c)'>"
        + "<rect width='512' height='512' fill='url(#bg)'/>"
        + "<circle cx='350' cy='150' r='74' fill='#c9b06e' opacity='0.18'/>"
        + "<circle cx='350' cy='150' r='46' fill='#c9b06e'/>"
        + "<path d='M0 512 L0 330 L130 240 L250 330 L340 268 L470 352 L512 318 L512 512 Z' fill='#2c4a3e'/>"
        + "<path d='M0 512 L0 402 L110 312 L240 412 L330 352 L460 432 L512 396 L512 512 Z' fill='#1f332d'/>"
        + "<text x='256' y='374' fill='#d7e3db' font-family='Arial, sans-serif' font-size='30' font-weight='600' letter-spacing='4' text-anchor='middle' dominant-baseline='central'>Invalid image</text>"
        + `<text x='256' y='434' fill='#eef4f0' font-family='Arial, sans-serif' font-size='46' font-weight='600' text-anchor='middle' dominant-baseline='central'>${when}</text>`
        + `<text x='256' y='480' fill='#b9c9c0' font-family='Arial, sans-serif' font-size='28' text-anchor='middle' dominant-baseline='central'>${year}</text>`
        + "</g></svg>";
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
