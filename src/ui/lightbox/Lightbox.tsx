/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import { RenderModalProps } from "@vencord/discord-types";
import {
    moment,
    openModal,
    showToast,
    Toasts,
    UserStore,
    useState
} from "@webpack/common";

import {
    buildAvatarUrl,
    clearUserHistory,
    getBlobObjectUrl,
    removeRecord,
    setTracked,
    useTrackedUsers
} from "../../store";
import { applyAvatar, downloadAvatar, exportHistoryFile, importHistoryFile, rememberCurrentAvatar } from "./actions";
import { AvatarRail } from "./AvatarRail";
import { ConfirmBar } from "./ConfirmBar";
import { openGearMenu } from "./gearMenu";
import { openImageContextMenu } from "./imageMenu";
import { LightboxToolbar } from "./LightboxToolbar";
import { useLightboxState } from "./useLightboxState";

const cl = classNameFactory("vc-avh-");
const SWIPE_THRESHOLD = 48;

function ArrowWithTail({ dir }: { dir: "left" | "right" }) {
    return (
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
                d={dir === "left" ? "M7 2.5 2.5 8 7 13.5" : "M9 2.5 13.5 8 9 13.5"}
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path d="M2.5 8h11" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        </svg>
    );
}

export function openAvatarLightbox(userId: string, initialIndex = 0): void {
    openModal(modalProps => (
        <AvatarLightbox userId={userId} initialIndex={initialIndex} modalProps={modalProps} />
    ), {
        onCloseRequest() {}
    });
}

function AvatarLightbox({ userId, initialIndex, modalProps }: { userId: string; initialIndex: number; modalProps: RenderModalProps }) {
    const { onClose } = modalProps;
    const {
        recs,
        rec,
        recCount,
        index,
        setIndex,
        go,
        recRef,
        railRef,
        keySinkRef,
        touchX,
        registerActiveRef,
    } = useLightboxState(userId, initialIndex, onClose);
    const tracked = useTrackedUsers();
    const isTrackedUser = tracked.has(userId);
    const toggleTrack = () => void setTracked(userId, !isTrackedUser);

    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const [confirmSet, setConfirmSet] = useState(false);
    const [setting, setSetting] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null);

    const isSelf = userId === UserStore.getCurrentUser().id;

    // Single source of truth for confirm actions — invoked ONLY from the
    // buttons' onClick handlers. (Previously these fired twice: once via a
    // capture-phase window click listener on [data-confirm], once via the
    // React onClick, producing duplicate deletes and toasts.)
    const confirmDeleteRecord = (): void => {
        const r = recRef.current;
        setConfirmDelete(false);
        if (!r) return;
        void removeRecord(userId, r);
        showToast("Avatar deleted", Toasts.Type.SUCCESS);
    };

    const confirmClearHistory = (): void => {
        setConfirmClear(false);
        void clearUserHistory(userId, true);
        showToast("History cleared", Toasts.Type.SUCCESS);
    };

    const handleExport = async (): Promise<void> => {
        setExporting(true);
        try {
            await exportHistoryFile();
        } finally {
            setExporting(false);
        }
    };

    const handleImport = async (e: React.FormEvent<HTMLInputElement>): Promise<void> => {
        const file = e.currentTarget.files?.[0];
        if (!file) return;
        e.currentTarget.value = "";
        setImporting(true);
        try {
            await importHistoryFile(file);
        } finally {
            setImporting(false);
        }
    };

    const handleRememberCurrent = async (): Promise<void> => {
        if (await rememberCurrentAvatar(userId)) showToast("Avatar saved", Toasts.Type.SUCCESS);
        else showToast("No avatar to save", Toasts.Type.FAILURE);
    };

    const handleApplyAvatar = async (): Promise<void> => {
        const r = recRef.current;
        if (!r || setting) return;
        setSetting(true);
        setConfirmSet(false);
        try {
            await applyAvatar(userId, r);
        } finally {
            setSetting(false);
        }
    };

    const [src] = useAwaiter(
        () => (rec ? getBlobObjectUrl(userId, rec) : Promise.resolve<string | null>(null)),
        { fallbackValue: null, deps: [userId, rec?.hash, rec?.hasBlob] }
    );

    if (!rec) return null;

    const date = moment(rec.timestamp);
    const cdnUrl = buildAvatarUrl(userId, rec.hash, rec.format, 1024, rec.avatarId);
    const off = date.utcOffset();
    const tz = `${off < 0 ? "-" : "+"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, "0")}` : ""}`;

    const handleDownload = (): void => void downloadAvatar(userId, rec);
    const handleCopy = (): void => void copyWithToast(cdnUrl, "Avatar URL copied");

    const imageMenuDeps = {
        isSelf,
        rec,
        onSet: () => setConfirmSet(true),
        onDownload: handleDownload,
        onCopy: handleCopy,
        onDelete: () => setConfirmDelete(true),
    };

    const gearMenuDeps = {
        rememberCurrent: () => void handleRememberCurrent(),
        isTrackedUser,
        toggleTrack,
        exporting,
        onExport: () => void handleExport(),
        onImport: () => fileInput?.click(),
        onClear: () => setConfirmClear(true),
    };

    return (
        <div
            className={cl("lightbox-backdrop")}
            onMouseDown={() => keySinkRef.current?.focus()}
            onClick={e => {
                if (e.target === e.currentTarget) {
                    onClose();
                    return;
                }
                const el = e.target as HTMLElement;
                const nav = el.closest?.("[data-nav]") as HTMLElement | null;
                if (nav) go(nav.dataset.nav === "prev" ? -1 : 1);
            }}
            onTouchStart={e => { touchX.current = e.touches[0]?.clientX ?? null; }}
            onTouchEnd={e => {
                const start = touchX.current;
                touchX.current = null;
                if (start == null) return;
                const dx = (e.changedTouches[0]?.clientX ?? start) - start;
                if (Math.abs(dx) > SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
            }}
        >
            <div
                ref={keySinkRef}
                tabIndex={-1}
                style={{ position: "absolute", width: 0, height: 0, outline: "none", overflow: "hidden" }}
            />
            <input
                ref={setFileInput}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={e => void handleImport(e)}
            />

            <div className={cl("lb-info")}>
                <span className={cl("lb-counter")}>{index + 1} of {recCount}</span>
                <span className={cl("lb-meta")}>
                    {date.format("D MMM YYYY H:mm")} UTC{tz}
                    {rec.width && rec.height ? ` · ${rec.width}×${rec.height}` : ""}
                </span>
            </div>

            {recCount > 1 && (
                <>
                    <button
                        type="button"
                        className={cl("lb-nav-btn", "prev")}
                        aria-label="Previous"
                        data-tip="Previous (←)"
                        data-nav="prev"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); go(-1); }}
                    >
                        <ArrowWithTail dir="left" />
                    </button>
                    <button
                        type="button"
                        className={cl("lb-nav-btn", "next")}
                        aria-label="Next"
                        data-tip="Next (→)"
                        data-nav="next"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); go(1); }}
                    >
                        <ArrowWithTail dir="right" />
                    </button>
                </>
            )}

            <div className={cl("lb-stage")}>
                <img
                    key={rec.hash}
                    className={cl("lb-img")}
                    src={src ?? cdnUrl}
                    alt="avatar"
                    draggable={false}
                    onContextMenu={e => openImageContextMenu(e, imageMenuDeps)}
                />
            </div>

            <LightboxToolbar
                rec={rec}
                isSelf={isSelf}
                setting={setting}
                onSet={() => setConfirmSet(true)}
                onDownload={handleDownload}
                onCopy={handleCopy}
                onDelete={() => setConfirmDelete(true)}
                onMoreClick={e => openGearMenu(e, gearMenuDeps)}
                onMoreContextMenu={e => openGearMenu(e, gearMenuDeps)}
            />

            {confirmDelete && (
                <ConfirmBar
                    text="Delete this avatar?"
                    okLabel="Delete"
                    onOk={confirmDeleteRecord}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}

            {confirmClear && (
                <ConfirmBar
                    text="Clear all history for this user?"
                    okLabel="Clear"
                    onOk={confirmClearHistory}
                    onCancel={() => setConfirmClear(false)}
                />
            )}

            {confirmSet && (
                <ConfirmBar
                    text="Set this avatar on your Discord profile?"
                    okLabel="Set avatar"
                    busyLabel="Setting…"
                    busy={setting}
                    onOk={() => void handleApplyAvatar()}
                    onCancel={() => setConfirmSet(false)}
                />
            )}

            <AvatarRail
                userId={userId}
                recs={recs}
                index={index}
                onSelect={setIndex}
                railRef={railRef}
                registerActiveRef={registerActiveRef}
            />

            {setting && (
                <div className={cl("lb-progress")}>
                    <div className={cl("lb-progress-label")}>
                        <span className={cl("lb-progress-spinner")} />
                        Setting avatar…
                    </div>
                    <div className={cl("lb-progress-bar")}>
                        <div className={cl("lb-progress-bar-fill")} />
                    </div>
                </div>
            )}
        </div>
    );
}
