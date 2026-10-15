/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import {
    moment,
    openModal,
    showToast,
    Toasts,
    useCallback,
    useEffect,
    useRef,
    UserStore,
    useState
} from "@webpack/common";

import {
    AvatarRecord,
    buildAvatarUrl,
    clearUserHistory,
    removeRecord,
    setTracked,
    useTrackedUsers
} from "../../store";
import { recordCdnSize, STAGE_SIZES, useAvatarImage } from "../useAvatarImage";
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

/** Largest scale the stage image zooms to; 1 is the fit size. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
/** Scale a double-click jumps to from the fit size. */
const ZOOM_CLICK = 2;

function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

/** How far the image may be panned at `scale` before its edge leaves the
 *  frame. The frame is the visible square the image is clipped to. */
function panLimits(el: HTMLImageElement, scale: number): { x: number; y: number; } {
    const frame = el.parentElement;
    if (!frame) return { x: 0, y: 0 };
    return {
        x: Math.max(0, (el.offsetWidth * scale - frame.clientWidth) / 2),
        y: Math.max(0, (el.offsetHeight * scale - frame.clientHeight) / 2),
    };
}

/** Main stage image. Mounted with a `key` on `rec.hash`: the stored-copy fetch
 *  and the CDN fallback chain both belong to a single record. The wheel zooms
 *  around the cursor and a double-click jumps toward the pointer (again to
 *  reset); dragging pans. The image is magnified inside its frame and never
 *  leaves it. */
function StageImage({ userId, rec, onContextMenu }: {
    userId: string;
    rec: AvatarRecord;
    onContextMenu(e: React.MouseEvent): void;
}) {
    const { src, onLoad, onError } = useAvatarImage(userId, rec, STAGE_SIZES);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const viewRef = useRef({ s: ZOOM_MIN, x: 0, y: 0 });
    const [view, setView] = useState(viewRef.current);
    const [panning, setPanning] = useState(false);
    const drag = useRef<{ x: number; y: number; panX: number; panY: number; } | null>(null);

    const applyView = useCallback((next: { s: number; x: number; y: number; }): void => {
        viewRef.current = next;
        setView(next);
    }, []);

    // Zoom keeping the point under (px, py) fixed. The frame is never
    // transformed, so its centre is the image's untransformed centre even while
    // a transform transition is still running.
    const zoomAt = useCallback((target: number, px: number, py: number): void => {
        const el = imgRef.current;
        const frame = el?.parentElement;
        if (!el || !frame) return;
        const scale = clamp(target, ZOOM_MIN, ZOOM_MAX);
        const cur = viewRef.current;
        if (scale <= ZOOM_MIN) {
            applyView({ s: ZOOM_MIN, x: 0, y: 0 });
            return;
        }
        const rect = frame.getBoundingClientRect();
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        const k = scale / cur.s;
        const lim = panLimits(el, scale);
        // Anchor the pointer: T' = k*T + (pointer - centre)*(1 - k).
        applyView({
            s: scale,
            x: clamp(cur.x * k + (px - cx) * (1 - k), -lim.x, lim.x),
            y: clamp(cur.y * k + (py - cy) * (1 - k), -lim.y, lim.y),
        });
    }, [applyView]);

    // Native non-passive listener so zooming the wheel doesn't scroll the app.
    useEffect(() => {
        const el = imgRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent): void => {
            e.preventDefault();
            const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
            zoomAt(viewRef.current.s * Math.exp(-e.deltaY * step * 0.0015), e.clientX, e.clientY);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    const zoomed = view.s > ZOOM_MIN + 0.01;

    const onDoubleClick = (e: React.MouseEvent<HTMLImageElement>): void => {
        if (zoomed) applyView({ s: ZOOM_MIN, x: 0, y: 0 });
        else zoomAt(ZOOM_CLICK, e.clientX, e.clientY);
    };

    const onPointerDown = (e: React.PointerEvent<HTMLImageElement>): void => {
        if (!zoomed) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, panX: viewRef.current.x, panY: viewRef.current.y };
        setPanning(true);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLImageElement>): void => {
        const d = drag.current;
        if (!d) return;
        const lim = panLimits(e.currentTarget, viewRef.current.s);
        applyView({
            s: viewRef.current.s,
            x: clamp(d.panX + e.clientX - d.x, -lim.x, lim.x),
            y: clamp(d.panY + e.clientY - d.y, -lim.y, lim.y),
        });
    };

    const onPointerUp = (e: React.PointerEvent<HTMLImageElement>): void => {
        drag.current = null;
        setPanning(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    return (
        <div className={cl("lb-frame")}>
            <img
                ref={imgRef}
                className={cl("lb-img", zoomed && "zoomed", panning && "panning")}
                src={src}
                alt="avatar"
                draggable={false}
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
                onDoubleClick={onDoubleClick}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onLoad={onLoad}
                onError={onError}
                onContextMenu={onContextMenu}
            />
        </div>
    );
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

    // Single source of truth for confirm actions, invoked ONLY from the buttons'
    // onClick. (These used to fire twice: a capture-phase window click listener
    // on [data-confirm] plus the React onClick.)
    const confirmDeleteRecord = (): void => {
        const r = recRef.current;
        setConfirmDelete(false);
        if (!r) return;
        void removeRecord(userId, r);
        showToast("Avatar deleted", Toasts.Type.SUCCESS);
    };

    const confirmClearHistory = (): void => {
        setConfirmClear(false);
        void clearUserHistory(userId);
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

    if (!rec) return null;

    const date = moment(rec.timestamp);
    // For the "copy URL" action, not for display: the size the stage itself
    // asks for, capped at the avatar's own resolution, so the copied link is
    // the one on screen and never claims a size the source does not have.
    const cdnUrl = buildAvatarUrl(userId, rec.hash, rec.format, recordCdnSize(rec, STAGE_SIZES[0]), rec.avatarId);
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
                <StageImage
                    key={rec.hash}
                    userId={userId}
                    rec={rec}
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
