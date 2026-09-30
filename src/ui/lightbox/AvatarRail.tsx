/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useEffect, useState } from "@webpack/common";

import { AvatarRecord, buildAvatarUrl, getBlobObjectUrl } from "../../store";

const cl = classNameFactory("vc-avh-");

/** Prefers the stored offline copy, falls back to the CDN. Opening the rail also
 * back-fills copies for records captured without one (see ProfileThumb). */
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
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void getBlobObjectUrl(userId, rec).then(url => {
            if (!cancelled) setBlobUrl(url);
        });
        return () => {
            cancelled = true;
        };
    }, [userId, rec.hash, rec.hasBlob]);

    return (
        <img
            ref={innerRef}
            className={cl("lb-thumb", active && "active")}
            src={blobUrl ?? buildAvatarUrl(userId, rec.hash, rec.format, 96, rec.avatarId)}
            alt=""
            aria-label={`Avatar from ${new Date(rec.timestamp).toLocaleString()}`}
            aria-current={active}
            role="button"
            tabIndex={0}
            loading="lazy"
            draggable={false}
            data-thumb="true"
            onClick={onSelect}
            onKeyDown={e => {
                // Enter/Space only. Arrow keys are left to the lightbox-level
                // handler in useLightboxState — handling them here too would
                // move two avatars per press once a thumb takes focus.
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
