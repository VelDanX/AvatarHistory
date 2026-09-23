/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CloudDownloadIcon, CopyIcon, MainSettingsIcon, PencilSparkleIcon, TrashIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import { saveFile } from "@utils/web";
import { RenderModalProps, User } from "@vencord/discord-types";
import {
    ContextMenuApi,
    FluxDispatcher,
    Menu,
    moment,
    openModal,
    RestAPI,
    showToast,
    Toasts,
    useCallback,
    useEffect,
    useReducer,
    useRef,
    UserStore,
    useState
} from "@webpack/common";

import {
    AvatarRecord,
    avatarToDataUrl,
    buildAvatarUrl,
    clearUserHistory,
    exportHistory,
    fetchAvatarBlob,
    getBlobObjectUrl,
    getHistory,
    isTracked,
    parseImport,
    recordAvatarSeen,
    removeRecord,
    setTracked,
    subscribeHistory
} from "./store";

const cl = classNameFactory("vc-avh-");
const SWIPE_THRESHOLD = 48;

const CLICK_ZONE_MARGIN = 180;

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

export async function downloadAvatar(userId: string, rec: AvatarRecord): Promise<void> {
    const blob = await fetchAvatarBlob(userId, rec);
    const url = buildAvatarUrl(userId, rec.hash, rec.format, 512, rec.avatarId);
    if (!blob) {
        copyWithToast(url, "Failed to load image, copied URL instead");
        return;
    }
    saveFile(new File(
        [blob],
        `avatar-${UserStore.getUser(userId)?.username ?? userId}-${moment(rec.timestamp).format("YYYY-MM-DD")}-${rec.hash}.${rec.format}`,
        { type: rec.format === "gif" ? "image/gif" : rec.format === "webp" ? "image/webp" : "image/png" }
    ));
}

export async function rememberCurrentAvatar(userId: string): Promise<boolean> {
    const avatar = UserStore.getUser(userId)?.avatar;
    if (!avatar) return false;
    const rec: AvatarRecord = {
        hash: avatar,
        timestamp: Date.now(),
        format: avatar.startsWith("a_") ? "gif" : "png",
        size: 0,
        hasBlob: false,
        width: 0,
        height: 0,
    };
    await recordAvatarSeen(userId, rec);
    const newest = getHistory(userId)[0];
    if (newest) void fetchAvatarBlob(userId, newest);
    return true;
}

function IconButton({
    tooltip,
    wrapClass,
    className,
    ariaLabel,
    disabled,
    onClick,
    onContextMenu,
    children
}: {
    tooltip: string;
    wrapClass?: string;
    className?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onClick(e: React.MouseEvent<HTMLButtonElement>): void;
    onContextMenu?(e: React.MouseEvent<HTMLButtonElement>): void;
    children: React.ReactNode;
}) {
    return (
        <span className={cl("lc-wrap", wrapClass)} data-tip={tooltip}>
            <button
                type="button"
                className={className}
                aria-label={ariaLabel ?? tooltip}
                disabled={disabled}
                onClick={onClick}
                onContextMenu={onContextMenu}
            >
                {children}
            </button>
        </span>
    );
}

function AvatarLightbox({ userId, initialIndex, modalProps }: { userId: string; initialIndex: number; modalProps: RenderModalProps }) {
    const [index, setIndex] = useState(initialIndex);
    const [, force] = useReducer(x => x + 1, 0);
    const recs = getHistory(userId);
    const rec = recs[index] ?? recs[0];
    const recRef = useRef(rec);
    recRef.current = rec;

    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const [confirmSet, setConfirmSet] = useState(false);
    const [setting, setSetting] = useState(false);
    const railRef = useRef<HTMLDivElement | null>(null);
    const activeRef = useRef<HTMLImageElement | null>(null);
    const keySinkRef = useRef<HTMLDivElement | null>(null);
    const touchX = useRef<number | null>(null);

    useEffect(() => subscribeHistory(force), []);

    const recCount = recs.length;
    const go = useCallback((dir: number) => {
        setIndex(i => (recCount ? (i + dir + recCount) % recCount : 0));
    }, [recCount]);

    const { onClose } = modalProps;
    useEffect(() => {
        const el = keySinkRef.current;
        if (el) el.focus();

        const handleConfirm = (action: string): void => {
            const r = recRef.current;
            switch (action) {
                case "delete":
                    setConfirmDelete(false);
                    if (r) void removeRecord(userId, r);
                    showToast("Avatar deleted", Toasts.Type.SUCCESS);
                    break;
                case "cancel-delete":
                    setConfirmDelete(false);
                    showToast("Cancelled", Toasts.Type.MESSAGE);
                    break;
                case "clear":
                    setConfirmClear(false);
                    void clearUserHistory(userId, true);
                    showToast("History cleared", Toasts.Type.SUCCESS);
                    break;
                case "cancel-clear":
                    setConfirmClear(false);
                    showToast("Cancelled", Toasts.Type.MESSAGE);
                    break;
            }
        };

        const onPointerDown = (e: PointerEvent) => {
            if (e.pointerType === "touch") return;
            const target = e.target as HTMLElement;
            const confirm = target.closest?.("[data-confirm]") as HTMLElement | null;
            if (confirm) {
                e.preventDefault();
                e.stopPropagation();
                handleConfirm(confirm.dataset.confirm ?? "");
                return;
            }
            if (target.closest?.("[data-nav]") || target.closest?.("[data-thumb]") || target.closest?.(`.${cl("lb-confirm")}`) || target.closest?.(`.${cl("lb-menu")}`)) return;
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

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowLeft" || e.key === "ArrowRight") go(e.key === "ArrowLeft" ? -1 : 1);
        };
        window.addEventListener("keydown", onKeyDown);

        const onConfirmClick = (e: MouseEvent) => {
            const action = (e.target as Element | null)?.closest?.("[data-confirm]") as HTMLElement | null;
            if (!action) return;
            e.preventDefault();
            e.stopPropagation();
            handleConfirm(action.dataset.confirm ?? "");
        };
        window.addEventListener("click", onConfirmClick, true);

        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("click", onConfirmClick, true);
        };
    }, [go, onClose]);

    useEffect(() => {
        if (!recCount) {
            onClose();
            return;
        }
        setIndex(i => (i > recCount - 1 ? recCount - 1 : i));
    }, [recCount, onClose]);

    useEffect(() => {
        const el = activeRef.current;
        const rail = railRef.current;
        if (!el || !rail) return;
        rail.scrollTo({
            left: el.offsetLeft - rail.clientWidth / 2 + el.clientWidth / 2,
            behavior: "smooth"
        });
    }, [index]);

    const [src] = useAwaiter(
        () => (rec ? getBlobObjectUrl(userId, rec) : Promise.resolve<string | null>(null)),
        { fallbackValue: null, deps: [userId, rec?.hash, rec?.hasBlob] }
    );

    const toggleTrack = () => void setTracked(userId, !isTracked(userId)).then(force);

    const [exporting, setExporting] = useState(false);
    const onExport = async (): Promise<void> => {
        setExporting(true);
        try {
            const blob = await exportHistory();
            saveFile(new File([blob], `avatar-history-${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" }));
        } finally {
            setExporting(false);
        }
    };

    const rememberCurrent = async (): Promise<void> => {
        if (await rememberCurrentAvatar(userId)) showToast("Avatar saved", Toasts.Type.SUCCESS);
        else showToast("No avatar to save", Toasts.Type.FAILURE);
        force();
    };

    const isSelf = userId === UserStore.getCurrentUser().id;

    const applyAvatar = async (): Promise<void> => {
        const r = recRef.current;
        if (!r || setting) return;
        setSetting(true);
        setConfirmSet(false);
        try {
            const dataUrl = await avatarToDataUrl(userId, r);
            if (!dataUrl) {
                showToast("Could not load the avatar image", Toasts.Type.FAILURE);
                return;
            }
            const res = await RestAPI.patch({ url: "/users/@me", body: { avatar: dataUrl } });
            const self = (res as { body?: User })?.body;
            if (self?.id) FluxDispatcher.dispatch({ type: "CURRENT_USER_UPDATE", user: self });
            showToast("Avatar updated", Toasts.Type.SUCCESS);
        } catch (err) {
            const e = err as { body?: { message?: string }; };
            const message = e?.body?.message;
            if (r.format === "gif" || /nitro|premium/i.test(message ?? "")) {
                showToast("Animated avatars require Nitro", Toasts.Type.FAILURE);
            } else {
                showToast("Failed to set avatar", Toasts.Type.FAILURE);
            }
        } finally {
            setSetting(false);
        }
    };

    const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);
    const onImportFile = async (e: React.FormEvent<HTMLInputElement>): Promise<void> => {
        const file = e.currentTarget.files?.[0];
        if (!file) return;
        e.currentTarget.value = "";
        setImporting(true);
        try {
            const imported = await parseImport(await file.text());
            force();
            showToast(
                imported ? `Imported ${imported} new record${imported === 1 ? "" : "s"}` : "No new records in file",
                imported ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
            );
        } catch {
            showToast("Invalid avatar history file", Toasts.Type.FAILURE);
        } finally {
            setImporting(false);
        }
    };

    const clearAll = () => setConfirmClear(true);

    const openGearMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="vc-avh-lb-actions" className={cl("lb-menu")} onClose={ContextMenuApi.closeContextMenu} aria-label="Avatar history actions">
                <Menu.MenuGroup label="Manage">
                    <Menu.MenuItem id="remember" label="Remember current avatar" action={() => void rememberCurrent()} />
                    <Menu.MenuItem id="track" label={isTracked(userId) ? "Stop tracking changes" : "Track avatar changes"} action={toggleTrack} />
                </Menu.MenuGroup>
                <Menu.MenuGroup label="Import / Export">
                    <Menu.MenuItem id="export" label="Export all history (.json)" disabled={exporting} action={() => void onExport()} />
                    <Menu.MenuItem id="import" label="Import (.json)" action={() => fileInput?.click()} />
                </Menu.MenuGroup>
                <Menu.MenuItem id="clear" label="Clear all history" color="danger" action={clearAll} />
            </Menu.Menu>
        ));
    };

    const openGearMenuFromClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.right,
            clientY: rect.bottom + 6,
            button: 2,
        }));
    };

    const openImageContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="vc-avh-lb-img-menu" className={cl("lb-menu")} onClose={ContextMenuApi.closeContextMenu} aria-label="Avatar options">
                {isSelf && <Menu.MenuItem id="set-avatar" label="Set as avatar" action={() => setConfirmSet(true)} />}
                <Menu.MenuItem id="download" label={rec.hasBlob ? "Download (offline copy saved)" : "Download"} action={() => void downloadAvatar(userId, rec)} />
                <Menu.MenuItem id="copy-url" label="Copy URL" action={() => void copyWithToast(cdnUrl, "Avatar URL copied")} />
                <Menu.MenuItem id="delete" label="Delete" color="danger" action={() => setConfirmDelete(true)} />
            </Menu.Menu>
        ));
    };

    if (!rec) return null;

    const date = moment(rec.timestamp);
    const cdnUrl = buildAvatarUrl(userId, rec.hash, rec.format, 1024, rec.avatarId);
    const off = date.utcOffset();
    const tz = `${off < 0 ? "-" : "+"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${String(Math.abs(off) % 60).padStart(2, "0")}` : ""}`;

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
                onChange={e => void onImportFile(e)}
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
                    onContextMenu={openImageContextMenu}
                />
            </div>

            <div className={cl("lb-toolbar")}>
                {isSelf && (
                    <IconButton
                        tooltip="Set as avatar"
                        className={cl("lb-btn")}
                        disabled={setting}
                        onClick={() => setConfirmSet(true)}
                    >
                        <PencilSparkleIcon width={24} height={24} />
                    </IconButton>
                )}
                <IconButton
                    tooltip={rec.hasBlob ? "Download (offline copy saved)" : "Download"}
                    className={cl("lb-btn", rec.hasBlob && "has-blob")}
                    onClick={() => void downloadAvatar(userId, rec)}
                >
                    <CloudDownloadIcon width={24} height={24} />
                </IconButton>
                <IconButton
                    tooltip="Copy URL"
                    className={cl("lb-btn")}
                    onClick={() => void copyWithToast(cdnUrl, "Avatar URL copied")}
                >
                    <CopyIcon width={24} height={24} />
                </IconButton>
                <IconButton
                    tooltip="Delete"
                    className={cl("lb-btn", "danger")}
                    onClick={() => setConfirmDelete(true)}
                >
                    <TrashIcon width={24} height={24} />
                </IconButton>
                <IconButton
                    tooltip="More"
                    className={cl("lb-btn")}
                    onClick={openGearMenuFromClick}
                    onContextMenu={openGearMenu}
                >
                    <MainSettingsIcon width={24} height={24} />
                </IconButton>
            </div>

            {confirmDelete && (
                <div className={cl("lb-confirm")}>
                    <span className={cl("lb-confirm-text", "muted")}>Delete this avatar?</span>
                    <button
                        type="button"
                        className={cl("lb-confirm-btn", "ok")}
                        data-confirm="delete"
                        onClick={() => { setConfirmDelete(false); void removeRecord(userId, rec); }}
                    >
                        Delete
                    </button>
                    <button type="button" className={cl("lb-confirm-btn")} data-confirm="cancel-delete" onClick={() => setConfirmDelete(false)}>
                        Cancel
                    </button>
                </div>
            )}

            {confirmClear && (
                <div className={cl("lb-confirm")}>
                    <span className={cl("lb-confirm-text", "muted")}>Clear all history for this user?</span>
                    <button
                        type="button"
                        className={cl("lb-confirm-btn", "ok")}
                        data-confirm="clear"
                        onClick={() => { setConfirmClear(false); void clearUserHistory(userId, true); }}
                    >
                        Clear
                    </button>
                    <button type="button" className={cl("lb-confirm-btn")} data-confirm="cancel-clear" onClick={() => setConfirmClear(false)}>
                        Cancel
                    </button>
                </div>
            )}

            {confirmSet && (
                <div className={cl("lb-confirm")}>
                    <span className={cl("lb-confirm-text", "muted")}>Set this avatar on your Discord profile?</span>
                    <button
                        type="button"
                        className={cl("lb-confirm-btn", "ok")}
                        disabled={setting}
                        onClick={() => void applyAvatar()}
                    >
                        {setting ? "Setting…" : "Set avatar"}
                    </button>
                    <button type="button" className={cl("lb-confirm-btn")} disabled={setting} onClick={() => setConfirmSet(false)}>
                        Cancel
                    </button>
                </div>
            )}

            <div className={cl("lb-rail")} ref={railRef}>
                {recs.map((r, i) => (
                    <img
                        key={r.hash}
                        ref={i === index ? activeRef : undefined}
                        className={cl("lb-thumb", i === index && "active")}
                        src={buildAvatarUrl(userId, r.hash, r.format, 96, r.avatarId)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        data-thumb="true"
                        onClick={() => setIndex(i)}
                    />
                ))}
            </div>

            {setting && (
                <div className={cl("lb-progress-backdrop")}>
                    <div className={cl("lb-progress")}>
                        <div className={cl("lb-progress-label")}>
                            <span className={cl("lb-progress-spinner")} />
                            Setting avatar…
                        </div>
                        <div className={cl("lb-progress-bar")}>
                            <div className={cl("lb-progress-bar-fill")} />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
