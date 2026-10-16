/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RightArrow } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { moment } from "@webpack/common";

import { AvatarRecord, useHistory } from "../store";
import { openAvatarLightbox } from "./lightbox/Lightbox";
import { THUMB_SIZES, useAvatarImage } from "./useAvatarImage";

const cl = classNameFactory("vc-avh-");
const PREVIEW_COUNT = 4;

function ProfileThumb({ userId, rec, index }: { userId: string; rec: AvatarRecord; index: number; }) {
    // Deliberately no `hasBlob` guard: useAvatarImage -> getBlobObjectUrl ->
    // fetchAvatarBlob fetches and persists the copy, so opening a profile
    // repairs records that were captured without one.
    const { src, onLoad, onError } = useAvatarImage(userId, rec, THUMB_SIZES);
    // History is stored newest first (history.ts sorts descending), so the first
    // record is whatever avatar the user is wearing right now. The timestamp
    // lives in the accessible name and in the lightbox only: at 56px no caption
    // fits without turning into mush, and the preview is meant to stay clean.
    const current = index === 0;
    const date = moment(rec.timestamp).format("D MMM YYYY H:mm");
    const label = current ? `Current avatar, ${date}` : date;
    // Opens the gallery on this very avatar, so the preview is a shortcut into
    // the history rather than a second "open the latest" button.
    const open = () => openAvatarLightbox(userId, index);

    return (
        <img
            className={cl("profile-thumb")}
            src={src}
            alt=""
            role="button"
            tabIndex={0}
            aria-label={label}
            // Eager: the grid is only four 56px thumbs, and lazy loading here
            // waited for an interaction just like in the lightbox rail.
            decoding="async"
            onLoad={onLoad}
            onError={onError}
            onClick={open}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                }
            }}
        />
    );
}

export function AvatarHistoryProfileSection({ userId }: { userId: string }) {
    const recs = useHistory(userId);

    if (!recs.length) return null;

    const count = recs.length;

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
                <span className={cl("profile-count")}>
                    {count} {count === 1 ? "change" : "changes"}
                </span>
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
