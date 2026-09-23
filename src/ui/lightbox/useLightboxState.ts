/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useCallback, useEffect, useRef, useState } from "@webpack/common";

import { useHistory } from "../../store";

const cl = classNameFactory("vc-avh-");

/** Minimum distance from the screen edge before a click navigates the lightbox. */
const CLICK_ZONE_MARGIN = 180;

/**
 * Everything from the old AvatarLightbox body that is pure state/behavior:
 * the current index, the history records, the shared refs and the global
 * keydown (Esc/arrows) + pointerdown (click zones) subscriptions.
 */
export function useLightboxState(userId: string, initialIndex: number, onClose: () => void) {
    const [index, setIndex] = useState(initialIndex);
    const recs = useHistory(userId);
    const recCount = recs.length;
    const rec = recs[index] ?? recs[0];
    const recRef = useRef(rec);
    recRef.current = rec;

    const railRef = useRef<HTMLDivElement | null>(null);
    const activeRef = useRef<HTMLImageElement | null>(null);
    const keySinkRef = useRef<HTMLDivElement | null>(null);
    const touchX = useRef<number | null>(null);

    // Stable registration callback so the rail can hand the active thumbnail
    // up without re-attaching the ref on every render.
    const registerActiveRef = useCallback((el: HTMLImageElement | null): void => {
        activeRef.current = el;
    }, []);

    const go = useCallback((dir: number) => {
        setIndex(i => (recCount ? (i + dir + recCount) % recCount : 0));
    }, [recCount]);

    // Focus the key sink and wire up the global Esc/arrow + click-zone consumers.
    useEffect(() => {
        const el = keySinkRef.current;
        if (el) el.focus();

        const onPointerDown = (e: PointerEvent): void => {
            if (e.pointerType === "touch") return;
            const target = e.target as HTMLElement;
            if (
                target.closest?.("[data-nav]")
                || target.closest?.("[data-thumb]")
                || target.closest?.(`.${cl("lb-toolbar")}`)
                || target.closest?.(`.${cl("lb-confirm")}`)
                || target.closest?.(`.${cl("lb-menu")}`)
            ) return;
            const { clientX, clientY } = e;
            const w = window.innerWidth;
            const h = window.innerHeight;
            if (clientY < h * 0.2 || clientY > h - 190) return;
            const half = w / 2;
            if (clientX < half - CLICK_ZONE_MARGIN) {
                e.preventDefault();
                e.stopPropagation();
                go(-1);
            } else if (clientX > half + CLICK_ZONE_MARGIN) {
                e.preventDefault();
                e.stopPropagation();
                go(1);
            }
        };
        window.addEventListener("pointerdown", onPointerDown, true);

        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowLeft" || e.key === "ArrowRight") go(e.key === "ArrowLeft" ? -1 : 1);
        };
        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [go, onClose]);

    // Close when history becomes empty; clamp an out-of-range index.
    useEffect(() => {
        if (!recCount) {
            onClose();
            return;
        }
        setIndex(i => (i > recCount - 1 ? recCount - 1 : i));
    }, [recCount, onClose]);

    // Keep the active thumbnail scrolled into the middle of the rail.
    useEffect(() => {
        const el = activeRef.current;
        const rail = railRef.current;
        if (!el || !rail) return;
        rail.scrollTo({
            left: el.offsetLeft - rail.clientWidth / 2 + el.clientWidth / 2,
            behavior: "smooth"
        });
    }, [index]);

    return {
        recs,
        rec,
        recCount,
        index,
        setIndex,
        go,
        recRef,
        railRef,
        activeRef,
        keySinkRef,
        touchX,
        registerActiveRef,
    };
}
