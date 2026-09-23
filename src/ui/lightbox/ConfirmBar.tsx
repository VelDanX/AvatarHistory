/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

const cl = classNameFactory("vc-avh-");

export function ConfirmBar({
    text,
    okLabel,
    busyLabel,
    busy = false,
    onOk,
    onCancel
}: {
    text: string;
    okLabel: string;
    busyLabel?: string;
    busy?: boolean;
    onOk(): void;
    onCancel(): void;
}) {
    return (
        <div className={cl("lb-confirm")}>
            <span className={cl("lb-confirm-text", "muted")}>{text}</span>
            <button
                type="button"
                className={cl("lb-confirm-btn", "ok")}
                disabled={busy}
                onClick={onOk}
            >
                {busy && busyLabel ? busyLabel : okLabel}
            </button>
            <button
                type="button"
                className={cl("lb-confirm-btn")}
                disabled={busy}
                onClick={onCancel}
            >
                Cancel
            </button>
        </div>
    );
}
