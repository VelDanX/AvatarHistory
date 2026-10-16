/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { ContextMenuApi, Menu } from "@webpack/common";

const cl = classNameFactory("vc-avh-");

export function openGearMenu(
    e: React.MouseEvent<HTMLButtonElement>,
    deps: {
        rememberCurrent(): void;
        isTrackedUser: boolean;
        toggleTrack(): void;
        onClear(): void;
    }
): void {
    e.preventDefault();
    e.stopPropagation();
    const { rememberCurrent, isTrackedUser, toggleTrack, onClear } = deps;
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu
            navId="vc-avh-lb-actions"
            className={cl("lb-menu")}
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Avatar history actions"
        >
            <Menu.MenuGroup label="Manage">
                <Menu.MenuItem
                    id="remember"
                    label="Remember current avatar"
                    action={() => void rememberCurrent()}
                />
                <Menu.MenuItem
                    id="track"
                    label={isTrackedUser ? "Stop tracking changes" : "Track avatar changes"}
                    action={toggleTrack}
                />
            </Menu.MenuGroup>
            <Menu.MenuItem
                id="clear"
                label="Clear history for this user"
                color="danger"
                action={onClear}
            />
        </Menu.Menu>
    ));
}
