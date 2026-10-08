/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

import { AvatarRecord } from "../../store";
import { THUMB_SIZES, useAvatarImage } from "../useAvatarImage";

const cl = classNameFactory("vc-avh-");

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
    railRef: React.Ref<HTMLDivElement>;
    registerActiveRef(el: HTMLImageElement | null): void;
}) {
    return (
        <div className={cl("lb-rail")} ref={railRef}>
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
    );
}
