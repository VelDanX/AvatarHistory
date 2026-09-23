/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CloudDownloadIcon, CopyIcon, MainSettingsIcon, PencilSparkleIcon, TrashIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";

import { AvatarRecord } from "../../store";
import { IconButton } from "./IconButton";

const cl = classNameFactory("vc-avh-");

export function LightboxToolbar({
    rec,
    isSelf,
    setting,
    onSet,
    onDownload,
    onCopy,
    onDelete,
    onMoreClick,
    onMoreContextMenu
}: {
    rec: AvatarRecord;
    isSelf: boolean;
    setting: boolean;
    onSet(): void;
    onDownload(): void;
    onCopy(): void;
    onDelete(): void;
    onMoreClick(e: React.MouseEvent<HTMLButtonElement>): void;
    onMoreContextMenu(e: React.MouseEvent<HTMLButtonElement>): void;
}) {
    return (
        <div className={cl("lb-toolbar")}>
            {isSelf && (
                <IconButton
                    tooltip="Set as avatar"
                    className={cl("lb-btn")}
                    disabled={setting}
                    onClick={onSet}
                >
                    <PencilSparkleIcon width={24} height={24} />
                </IconButton>
            )}
            <IconButton
                tooltip={rec.hasBlob ? "Download (offline copy saved)" : "Download"}
                className={cl("lb-btn", rec.hasBlob && "has-blob")}
                onClick={onDownload}
            >
                <CloudDownloadIcon width={24} height={24} />
            </IconButton>
            <IconButton
                tooltip="Copy URL"
                className={cl("lb-btn")}
                onClick={onCopy}
            >
                <CopyIcon width={24} height={24} />
            </IconButton>
            <IconButton
                tooltip="Delete"
                className={cl("lb-btn", "danger")}
                onClick={onDelete}
            >
                <TrashIcon width={24} height={24} />
            </IconButton>
            <IconButton
                tooltip="More"
                className={cl("lb-btn")}
                onClick={onMoreClick}
                onContextMenu={onMoreContextMenu}
            >
                <MainSettingsIcon width={24} height={24} />
            </IconButton>
        </div>
    );
}
