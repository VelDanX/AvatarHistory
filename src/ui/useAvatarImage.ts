/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { buildAvatarUrlFallbacks } from "../cdnUrl";
import { CDN_CHECK_TIMEOUT_MS } from "../config";
import { AvatarRecord, getBlobObjectUrl } from "../store";
import { unavailableAvatarDataUrl } from "./avatarPlaceholder";

/** CDN sizes tried for a thumbnail, smallest first (it renders at ~96px). */
export const THUMB_SIZES = [96, 256, 512, 1024];
/** CDN sizes tried for the lightbox stage, largest first (it renders at 1024px). */
export const STAGE_SIZES = [1024, 512, 256, 96];

/** 1x1 transparent GIF. Reassigning it to an Image() aborts that image's
 *  in-flight download — used to cut probe losers off once a winner is known. */
const ABORT_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Fire every candidate at once on a detached `Image()` — a failed attempt
 * never repaints anything the user can see — and resolve with the first that
 * works in preference order: a candidate only wins once every better one has
 * failed, so parallelism does not change which size is preferred. Losers are
 * aborted the moment the result is decided, and each candidate has its own
 * timeout, so a hanging CDN cannot wedge the caller.
 */
export function probeCandidates(urls: string[]): Promise<string | null> {
    return new Promise(resolve => {
        const results: Array<boolean | undefined> = new Array(urls.length).fill(undefined);
        const imgs: HTMLImageElement[] = [];
        const timers: ReturnType<typeof setTimeout>[] = [];
        let decided = false;

        const decide = (winner: string | null) => {
            if (decided) return;
            decided = true;
            for (const timer of timers) clearTimeout(timer);
            for (const img of imgs) {
                img.onload = null;
                img.onerror = null;
                img.src = ABORT_SRC;
            }
            resolve(winner);
        };

        const maybeDecide = () => {
            if (decided) return;
            for (let i = 0; i < urls.length; i++) {
                const ok = results[i];
                if (ok === undefined) return; // a better candidate may still win
                if (ok) {
                    decide(urls[i]);
                    return;
                }
            }
            decide(null); // everything settled, everything dead
        };

        urls.forEach((url, i) => {
            const img = new Image();
            imgs.push(img);
            timers.push(setTimeout(() => {
                if (results[i] === undefined) {
                    results[i] = false;
                    maybeDecide();
                }
            }, CDN_CHECK_TIMEOUT_MS));
            img.onload = () => {
                results[i] = true;
                maybeDecide();
            };
            img.onerror = () => {
                results[i] = false;
                maybeDecide();
            };
            img.src = url;
        });
    });
}

/**
 * `<img>` source for one record, degrading without ever stepping through the
 * visible element (that stepping was the flicker):
 *
 * - The element starts on the best CDN guess, so a healthy record paints with
 *   zero extra requests — nothing is probed until the element actually errors
 *   (or nothing settles for CDN_CHECK_TIMEOUT_MS).
 * - On failure the candidates are probed in parallel off-screen and the
 *   element jumps exactly once: to the first working URL, or to the dated
 *   placeholder once every source is dead.
 * - Once a real image has loaded, later results are ignored: the stored copy
 *   arriving must not re-flash a picture that already rendered. The
 *   placeholder never freezes anything, so a stored copy or a late probe can
 *   still replace it.
 * - The placeholder also waits for the stored-copy lookup when the record has
 *   one (a local read is fast) — otherwise a record with a copy but a dead
 *   CDN would flash the placeholder first.
 *
 * Mount with a `key` on `rec.hash`: the state belongs to a single record.
 */
export function useAvatarImage(
    userId: string,
    rec: AvatarRecord,
    sizes: number[]
): {
    src: string;
    onLoad(e: { currentTarget: HTMLImageElement }): void;
    onError(e: { currentTarget: HTMLImageElement }): void;
} {
    const fallbacks = buildAvatarUrlFallbacks(userId, rec.hash, rec.format, rec.avatarId, sizes);
    const placeholder = unavailableAvatarDataUrl(rec);

    const [shown, setShown] = useState(() => fallbacks[0]);
    const loadedRef = useRef(false);
    const erroredOnRef = useRef<string | null>(null);
    const startProbeRef = useRef<(() => void) | null>(null);
    const settleRef = useRef<(() => void) | null>(null);
    const hangTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;
        let probing = false;
        /** undefined = not settled yet (not the same as null = dead). */
        let cdn: string | null | undefined;
        let blob: string | null | undefined;

        loadedRef.current = false;
        erroredOnRef.current = null;

        const settle = () => {
            if (cancelled || loadedRef.current) return;
            setShown(prev => {
                const best = cdn ?? blob ?? null;
                if (best == null) {
                    // Wait out the probe before giving up. A record without a
                    // stored copy need not wait for the blob repair: it walks a
                    // subset of the probed URLs, so it can only rescue a record
                    // the probe already found alive (handled below).
                    if (cdn === null && (!rec.hasBlob || blob === null)) return placeholder;
                    return prev;
                }
                if (best !== prev) return best;
                // Already showing the best candidate, yet the element failed
                // on it: give the other source a turn, then the placeholder.
                if (erroredOnRef.current === prev) {
                    const other = best === cdn ? blob : cdn;
                    if (other) return other;
                    if (cdn !== undefined && blob !== undefined) return placeholder;
                }
                return prev;
            });
        };

        const startProbe = () => {
            if (cancelled || probing || cdn !== undefined || loadedRef.current) return;
            probing = true;
            void probeCandidates(fallbacks).then(url => {
                cdn = url;
                settle();
            });
        };

        hangTimerRef.current = setTimeout(startProbe, CDN_CHECK_TIMEOUT_MS);
        startProbeRef.current = startProbe;
        settleRef.current = settle;

        void getBlobObjectUrl(userId, rec).then(url => {
            if (cancelled) return;
            blob = url ?? null;
            settle();
        });

        return () => {
            cancelled = true;
            if (hangTimerRef.current) clearTimeout(hangTimerRef.current);
            startProbeRef.current = null;
            settleRef.current = null;
        };
        // `rec.hasBlob` is deliberately not a dependency: the call above
        // repairs a missing copy anyway, and re-running would un-freeze an
        // image that already rendered.
    }, [userId, rec.hash]);

    return {
        src: shown,
        onLoad: e => {
            // The placeholder itself must not freeze the record — a stored
            // copy or a late probe may still arrive and deserves the slot.
            if (e.currentTarget.src === placeholder) return;
            loadedRef.current = true;
            if (hangTimerRef.current) {
                clearTimeout(hangTimerRef.current);
                hangTimerRef.current = null;
            }
        },
        onError: e => {
            if (loadedRef.current) return;
            // Errors from an src we have already replaced must not count
            // against the current one, so record which src actually failed.
            if (e.currentTarget.src !== shown) return;
            erroredOnRef.current = e.currentTarget.src;
            startProbeRef.current?.();
            settleRef.current?.();
        }
    };
}
