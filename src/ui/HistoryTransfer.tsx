/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useRef, useState } from "@webpack/common";

import { exportHistoryFile, importHistoryFile } from "./lightbox/actions";

const cl = classNameFactory("vc-avh-");

type Busy = "export" | "import" | null;

/** Settings block for moving the whole history out of and into the client. */
export function HistoryTransfer() {
    const [busy, setBusy] = useState<Busy>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);

    const onExport = async (): Promise<void> => {
        if (busy) return;
        setBusy("export");
        try {
            await exportHistoryFile();
        } finally {
            setBusy(null);
        }
    };

    const onPicked = async (e: React.FormEvent<HTMLInputElement>): Promise<void> => {
        const file = e.currentTarget.files?.[0];
        // Cleared in the same pass, so picking the very same file twice imports it twice.
        e.currentTarget.value = "";
        if (!file) return;
        setBusy("import");
        try {
            await importHistoryFile(file);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className={cl("transfer")}>
            <button
                type="button"
                className={cl("transfer-btn")}
                disabled={busy !== null}
                onClick={() => void onExport()}
            >
                {busy === "export" ? "Exporting…" : "Export all history (JSON)"}
            </button>
            <button
                type="button"
                className={cl("transfer-btn")}
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
            >
                Import (JSON)
            </button>
            <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className={cl("transfer-input")}
                onChange={e => void onPicked(e)}
            />
        </div>
    );
}
