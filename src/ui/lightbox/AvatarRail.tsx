/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { AvatarRecord } from "../../store";
import { THUMB_SIZES, useAvatarImage } from "../useAvatarImage";

const cl = classNameFactory("vc-avh-");

/** How far from an edge, in px, a rail may sit without counting as scrolled
 *  away from it. Absorbs sub-pixel positions and smooth scrolls that land a
 *  fraction short of the target. */
const OVERFLOW_EPSILON = 1;

/** Prefers the stored copy, falls back to the CDN. Opening the rail also
 *  back-fills copies for records captured without one (see ProfileThumb). */
function RailThumb({
    userId,
    rec,
    active,
    onSelect,
    innerRef
}: {
    userId: string;
    rec: AvatarRecord;
    active: boolean;
    onSelect(): void;
    innerRef?: (el: HTMLImageElement | null) => void;
}) {
    const { src, onLoad, onError } = useAvatarImage(userId, rec, THUMB_SIZES);

    return (
        <img
            ref={innerRef}
            className={cl("lb-thumb", active && "active")}
            src={src}
            alt=""
            aria-label={`Avatar from ${new Date(rec.timestamp).toLocaleString()}`}
            aria-current={active}
            role="button"
            tabIndex={0}
            // Eager on purpose: a lazy thumb inside the modal only loads once
            // something forces a re-check (the rail.scrollTo on selection), so
            // the rail looked empty until the first click.
            decoding="async"
            draggable={false}
            data-thumb="true"
            onClick={onSelect}
            onLoad={onLoad}
            onError={onError}
            onKeyDown={e => {
                // Enter/Space only. Arrows are left to the lightbox-level handler
                // in useLightboxState — handling them here too would move two
                // avatars per press once a thumb takes focus.
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect();
                }
            }}
        />
    );
}

/** Which edges of the rail currently hold content that is scrolled out of view.
 *
 *  The scrollbar is hidden on purpose, so these two booleans are the only thing
 *  CSS gets to key the edge fades off. They are read from the live
 *  scrollLeft / scrollWidth - clientWidth pair rather than derived from the
 *  record count, which says nothing about how much room the thumbnails
 *  actually need at the current window width. */
function useRailOverflow(rail: React.RefObject<HTMLDivElement | null>, itemCount: number) {
    const [overflow, setOverflow] = useState({ start: false, end: false });
    const frame = useRef(0);

    // Throttled to one read per frame: scroll fires faster than we paint, and
    // the smooth scrollTo on selection would otherwise queue a measurement for
    // every step of the animation.
    const scheduleMeasure = useCallback(() => {
        window.cancelAnimationFrame(frame.current);
        frame.current = window.requestAnimationFrame(() => {
            const el = rail.current;
            if (!el) return;
            const max = Math.max(0, el.scrollWidth - el.clientWidth);
            const left = Math.min(Math.max(el.scrollLeft, 0), max);
            setOverflow(prev => {
                const next = {
                    start: left > OVERFLOW_EPSILON,
                    end: max - left > OVERFLOW_EPSILON
                };
                return prev.start === next.start && prev.end === next.end ? prev : next;
            });
        });
    }, [rail]);

    useEffect(() => {
        const el = rail.current;
        scheduleMeasure();
        el?.addEventListener("scroll", scheduleMeasure, { passive: true });
        window.addEventListener("resize", scheduleMeasure);
        return () => {
            window.cancelAnimationFrame(frame.current);
            el?.removeEventListener("scroll", scheduleMeasure);
            window.removeEventListener("resize", scheduleMeasure);
        };
    }, [rail, scheduleMeasure]);

    // Neither a scroll nor a resize says the content changed: another user's
    // history can fill or empty the rail between two frames, and a window
    // resize that does not move the scroll position still has to re-check
    // whether it overflows at all.
    useLayoutEffect(scheduleMeasure, [itemCount, scheduleMeasure]);

    return overflow;
}

export function AvatarRail({
    userId,
    recs,
    index,
    onSelect,
    railRef,
    registerActiveRef
}: {
    userId: string;
    recs: AvatarRecord[];
    index: number;
    onSelect(i: number): void;
    railRef: React.RefObject<HTMLDivElement | null>;
    registerActiveRef(el: HTMLImageElement | null): void;
}) {
    const overflow = useRailOverflow(railRef, recs.length);

    return (
        // The outer frame hosts the fades and must not scroll itself, or they
        // would slide away together with the thumbnails; the inner scroller is
        // the element railRef scrolls (useLightboxState centers the active
        // thumbnail through it).
        <div className={cl("lb-rail", {
            "overflow-start": overflow.start,
            "overflow-end": overflow.end
        })}>
            <div className={cl("lb-rail-scroll")} ref={railRef}>
                {recs.map((r, i) => (
                    <RailThumb
                        key={r.hash}
                        userId={userId}
                        rec={r}
                        active={i === index}
                        onSelect={() => onSelect(i)}
                        innerRef={i === index ? registerActiveRef : undefined}
                    />
                ))}
            </div>
        </div>
    );
}
