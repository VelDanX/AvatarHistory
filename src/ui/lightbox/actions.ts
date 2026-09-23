/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast } from "@utils/discord";
import { saveFile } from "@utils/web";
import { User } from "@vencord/discord-types";
import { FluxDispatcher, moment, RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

import {
    AvatarRecord,
    avatarToDataUrl,
    buildAvatarUrl,
    exportHistory,
    fetchAvatarBlob,
    getHistory,
    parseImport,
    recordAvatarSeen
} from "../../store";

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

/** Sets the given historical avatar on the current user's profile. Shows its own toasts. */
export async function applyAvatar(userId: string, rec: AvatarRecord): Promise<void> {
    const dataUrl = await avatarToDataUrl(userId, rec);
    if (!dataUrl) {
        showToast("Could not load the avatar image", Toasts.Type.FAILURE);
        return;
    }
    try {
        const res = await RestAPI.patch({ url: "/users/@me", body: { avatar: dataUrl } });
        const self = (res as { body?: User })?.body;
        if (self?.id) FluxDispatcher.dispatch({ type: "CURRENT_USER_UPDATE", user: self });
        showToast("Avatar updated", Toasts.Type.SUCCESS);
    } catch (err) {
        const e = err as { body?: { message?: string; }; };
        const message = e?.body?.message;
        if (rec.format === "gif" || /nitro|premium/i.test(message ?? "")) {
            showToast("Animated avatars require Nitro", Toasts.Type.FAILURE);
        } else {
            showToast("Failed to set avatar", Toasts.Type.FAILURE);
        }
    }
}

/** Exports all history to a JSON file download. */
export async function exportHistoryFile(): Promise<void> {
    const blob = await exportHistory();
    saveFile(new File([blob], `avatar-history-${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" }));
}

/** Imports an avatar-history JSON file. Shows its own toasts. */
export async function importHistoryFile(file: File): Promise<void> {
    try {
        const imported = await parseImport(await file.text());
        showToast(
            imported ? `Imported ${imported} new record${imported === 1 ? "" : "s"}` : "No new records in file",
            imported ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
        );
    } catch {
        showToast("Invalid avatar history file", Toasts.Type.FAILURE);
    }
}
