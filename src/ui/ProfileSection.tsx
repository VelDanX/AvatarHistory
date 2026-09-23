/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RightArrow } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { useEffect, useState } from "@webpack/common";

import { AvatarRecord, buildAvatarUrl, getBlobObjectUrl, useHistory } from "../store";
import { openAvatarLightbox } from "./lightbox/Lightbox";

const cl = classNameFactory("vc-avh-");
const PREVIEW_COUNT = 4;

function ProfileThumb({ userId, rec, index }: { userId: string; rec: AvatarRecord; index: number }) {
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!rec.hasBlob) return;
        void getBlobObjectUrl(userId, rec).then(url => setBlobUrl(url));
    }, [userId, rec.hash, rec.hasBlob]);

    return (
        <img
            className={`${cl("profile-thumb")} ${cl(`profile-thumb-${index}`)}`}
            src={blobUrl ?? buildAvatarUrl(userId, rec.hash, rec.format, 96, rec.avatarId)}
            alt=""
            loading="lazy"
            onClick={() => openAvatarLightbox(userId, index)}
        />
    );
}

export function AvatarHistoryProfileSection({ userId }: { userId: string }) {
    const recs = useHistory(userId);

    if (!recs.length) return null;

    return (
        <div className={cl("profile-section")}>
            <div
                className={cl("profile-header")}
                role="button"
                tabIndex={0}
                onClick={() => openAvatarLightbox(userId, 0)}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openAvatarLightbox(userId, 0);
                    }
                }}
            >
                <span className={cl("profile-title")}>Avatar history</span>
                <span className={cl("profile-count")}>{recs.length} recorded</span>
                <RightArrow width={14} height={14} className={cl("profile-open-arrow")} />
            </div>
            <div className={cl("profile-grid")}>
                {recs.slice(0, PREVIEW_COUNT).map((rec, i) => (
                    <ProfileThumb key={rec.hash} userId={userId} rec={rec} index={i} />
                ))}
            </div>
        </div>
    );
}
