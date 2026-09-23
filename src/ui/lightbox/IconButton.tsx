/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

const cl = classNameFactory("vc-avh-");

export function IconButton({
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
