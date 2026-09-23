/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

import { AvatarRecord, buildAvatarUrl } from "../../store";

const cl = classNameFactory("vc-avh-");

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
                <img
                    key={r.hash}
                    ref={i === index ? registerActiveRef : undefined}
                    className={cl("lb-thumb", i === index && "active")}
                    src={buildAvatarUrl(userId, r.hash, r.format, 96, r.avatarId)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    data-thumb="true"
                    onClick={() => onSelect(i)}
                />
            ))}
        </div>
    );
}
