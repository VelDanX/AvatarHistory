/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { buildAvatarUrlFallbacks, sizesCappedToNative } from "../cdnUrl";
import { CDN_CHECK_TIMEOUT_MS } from "../config";
import { AvatarRecord, getBlobObjectUrl } from "../store";
import { unavailableAvatarDataUrl } from "./avatarPlaceholder";

/** CDN sizes tried for a thumbnail, smallest first (it renders at ~96px). */
export const THUMB_SIZES = [96, 256, 512, 1024];
/** CDN sizes tried for the lightbox stage, largest first (it renders at 1024px).
 *  A record whose measured size is smaller is asked for that size instead — see
 *  sizesCappedToNative. */
export const STAGE_SIZES = [1024, 512, 256, 96];

/** The record's measured resolution, 0 until its blob has been decoded. */
function nativeSizeOf(rec: AvatarRecord): number {
    return Math.max(rec.width || 0, rec.height || 0);
}

/** CDN size to ask for a record, capped at `target`: an avatar smaller than the
 *  target is requested at its own bucket so the request (and any copied URL or
 *  saved file built from it) never claims more than the source has. */
export function recordCdnSize(rec: AvatarRecord, target: number): number {
    return sizesCappedToNative([target], nativeSizeOf(rec))[0];
}

/** 1x1 transparent GIF. Reassigning it to an Image() aborts that image's
 *  in-flight download — used to cut probe losers off once a winner is known. */
const ABORT_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** How many candidates may be in flight at once. */
const CONCURRENT = 3;

/**
 * Probe candidates on detached `Image()`s — a failed attempt never repaints
 * anything the user can see — and resolve with the first that works *in
 * preference order*: a candidate only wins once every better one has failed, so
 * how many run at once never changes which size is picked.
 *
 * At most `CONCURRENT` are in flight. A record with an avatarId yields up to
 * eight URLs (four sizes x two paths), and a lightbox rail can hold dozens of
 * dead records at once; firing everything would put hundreds of requests at the
 * CDN the moment a modal opens.
 *
 * `cancel()` is the teardown: it aborts what is in flight and resolves null.
 * Without it a probe outlives the component that started it, holding its
 * requests for up to `CDN_CHECK_TIMEOUT_MS` after a closed lightbox. Each
 * candidate also carries its own timeout, so a hanging CDN cannot wedge the
 * caller even un-cancelled.
 */
export function probeCandidates(urls: string[]): { result: Promise<string | null>; cancel(): void } {
    let abort: (winner: string | null) => void = () => { };
    const result = new Promise<string | null>(resolve => {
        const results: Array<boolean | undefined> = new Array(urls.length).fill(undefined);
        const imgs: HTMLImageElement[] = [];
        const timers: ReturnType<typeof setTimeout>[] = [];
        let started = 0;
        let inFlight = 0;
        let decided = false;

        // Also what cancel() runs: losers are cut off as soon as the winner is known,
        // rather than left to finish against a CDN that has already answered.
        const abortAll = (): void => {
            for (const timer of timers) clearTimeout(timer);
            for (const img of imgs) {
                img.onload = null;
                img.onerror = null;
                img.src = ABORT_SRC;
            }
        };

        const decide = (winner: string | null) => {
            if (decided) return;
            decided = true;
            abortAll();
            resolve(winner);
        };

        // The first index still in doubt decides. An unstarted candidate counts as in
        // doubt, which is what makes the bounded window below safe: a later hit
        // arriving early cannot win over a better one that has not run yet.
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

        const settle = (i: number, ok: boolean): void => {
            // Guarded: a timeout can mark a candidate dead and the abort below
            // can still deliver its event afterwards.
            if (results[i] !== undefined) return;
            results[i] = ok;
            inFlight--;
            maybeDecide();
            launch();
        };

        const launch = (): void => {
            while (!decided && started < urls.length && inFlight < CONCURRENT) {
                const i = started++;
                const img = new Image();
                inFlight++;
                imgs.push(img);
                timers.push(setTimeout(() => settle(i, false), CDN_CHECK_TIMEOUT_MS));
                img.onload = () => settle(i, true);
                img.onerror = () => settle(i, false);
                img.src = urls[i];
            }
        };

        launch();
        abort = decide;
    });

    return { result, cancel: () => abort(null) };
}

/**
 * `<img>` source for one record, degrading without ever stepping through the
 * visible element (that stepping was the flicker):
 *
 * - The element starts on the best CDN guess, so a healthy record paints with
 *   zero extra requests — nothing is probed until the element actually errors
 *   (or nothing settles for CDN_CHECK_TIMEOUT_MS).
 * - On failure the candidates are probed off-screen and the element jumps
 *   exactly once: to the first working URL, or to the dated placeholder once
 *   every source is dead. A record that already has a stored copy never probes
 *   at all (see startProbe).
 * - Once a real image has loaded, later results are ignored: the stored copy
 *   arriving must not re-flash a picture that already rendered. The
 *   placeholder never freezes anything, so a stored copy or a late probe can
 *   still replace it.
 * - The placeholder also waits for the stored-copy lookup when the record has
 *   one (a local read is fast) — otherwise a record with a copy but a dead
 *   CDN would flash the placeholder first. The same wait gates the probe
 *   itself, so a record with a copy costs the CDN nothing.
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
    const fallbacks = buildAvatarUrlFallbacks(userId, rec.hash, rec.format, rec.avatarId, sizesCappedToNative(sizes, nativeSizeOf(rec)));
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
        /** Set by onError; the probe waits on the blob lookup before it runs
         * when the record is known to have a copy. */
        let wantsCdn = false;
        let cancelProbe: (() => void) | null = null;

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

        const runProbe = () => {
            if (cancelled || probing || cdn !== undefined || loadedRef.current) return;
            probing = true;
            const probe = probeCandidates(fallbacks);
            cancelProbe = probe.cancel;
            void probe.result.then(url => {
                cdn = url;
                settle();
            });
        };

        // A record that already has a stored copy resolves it from DataStore in
        // milliseconds, and a working copy beats every CDN candidate — so the
        // probe would be pure waste. Gated on `hasBlob` alone: without it
        // `getBlobObjectUrl` falls back to fetchAvatarBlob, which walks the CDN
        // itself, and waiting on that would delay the probe precisely when the
        // CDN is dead and the chain is needed.
        const startProbe = () => {
            if (rec.hasBlob && blob === undefined) {
                wantsCdn = true;
                return;
            }
            runProbe();
        };

        hangTimerRef.current = setTimeout(startProbe, CDN_CHECK_TIMEOUT_MS);
        startProbeRef.current = startProbe;
        settleRef.current = settle;

        void getBlobObjectUrl(userId, rec).then(url => {
            if (cancelled) return;
            blob = url ?? null;
            settle();
            // The copy did not arrive — the probe was waiting on it.
            if (wantsCdn && blob === null) runProbe();
        });

        return () => {
            cancelled = true;
            if (hangTimerRef.current) clearTimeout(hangTimerRef.current);
            startProbeRef.current = null;
            settleRef.current = null;
            // Without this an in-flight probe kept its requests alive for up to
            // CDN_CHECK_TIMEOUT_MS after the lightbox closed. Cancelling resolves
            // it null, which `settle` ignores: cancelled is already true.
            cancelProbe?.();
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
