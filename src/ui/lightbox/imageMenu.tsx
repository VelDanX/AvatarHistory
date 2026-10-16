/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { ContextMenuApi, Menu } from "@webpack/common";

const cl = classNameFactory("vc-avh-");

export function openImageContextMenu(
    e: React.MouseEvent,
    deps: {
        isSelf: boolean;
        onSet(): void;
        onDownload(): void;
        onCopy(): void;
        onDelete(): void;
    }
): void {
    e.preventDefault();
    e.stopPropagation();
    const { isSelf, onSet, onDownload, onCopy, onDelete } = deps;
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu
            navId="vc-avh-lb-img-menu"
            className={cl("lb-menu")}
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Avatar options"
        >
            {isSelf && <Menu.MenuItem id="set-avatar" label="Set as avatar" action={onSet} />}
            <Menu.MenuItem
                id="download"
                label="Download"
                action={onDownload}
            />
            <Menu.MenuItem
                id="copy-url"
                label="Copy URL"
                action={onCopy}
            />
            <Menu.MenuItem
                id="delete"
                label="Delete"
                color="danger"
                action={onDelete}
            />
        </Menu.Menu>
    ));
}
