/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const log = new Logger("AvatarHistory");

/** Minimum gap between two API requests during a sweep. */
const DEFAULT_STAGGER_MS = 1500;
/** How many users the startup pass verifies right away. */
const QUICK_START_COUNT = 30;
const QUICK_START_STAGGER_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Periodically re-checks tracked users' avatars against Discord in the
 * background, so avatar changes are recorded even when the user's profile
 * is never opened.
 *
 * Deliberately gentle to the API:
 * - requests are paced (never faster than `staggerMs` apart),
 * - a sweep processes at most one interval's worth of users and rotates
 *   through very large lists,
 * - after a failure (e.g. a rate limit) the sweep backs off.
 *
 * A small quick pass runs shortly after startup so results appear fast,
 * while the full rotation stays slow and polite.
 */
export class BackgroundSync {
    private timer: number | null = null;
    private sweeping = false;
    private stopped = false;
    private offset = 0;

    constructor(
        private readonly ready: Promise<void>,
        private readonly getSweepIds: () => Promise<string[]>,
        private readonly checkUser: (userId: string) => Promise<void>,
        private readonly intervalMs: number,
        private readonly staggerMs = DEFAULT_STAGGER_MS,
    ) {}

    public start(): void {
        if (this.timer != null) return;
        this.timer = window.setInterval(() => void this.sweep(), this.intervalMs);
        // Quick first pass: verify a handful of users right after startup so
        // changes made while the client was closed show up promptly.
        this.ready.then(() => {
            setTimeout(() => void this.sweep(QUICK_START_COUNT, QUICK_START_STAGGER_MS), 2000);
        });
    }

    public stop(): void {
        this.stopped = true;
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async sweep(sizeOverride?: number, staggerOverride?: number): Promise<void> {
        if (this.sweeping || this.stopped) return;
        const stagger = staggerOverride ?? this.staggerMs;
        this.sweeping = true;
        try {
            const ids = await this.getSweepIds();
            if (!ids.length) {
                this.offset = 0;
                return;
            }
            // Cover the whole list within a single interval when possible,
            // but never issue requests faster than one per `staggerMs`.
            const cap = Math.max(100, Math.floor(this.intervalMs / this.staggerMs));
            const size = Math.min(sizeOverride ?? cap, ids.length);
            for (let i = 0; i < size; i++) {
                if (this.stopped) return;
                const id = ids[(this.offset + i) % ids.length];
                try {
                    await this.checkUser(id);
                } catch (e) {
                    log.warn(`Background avatar check failed for ${id}`, e);
                    if (this.stopped) return;
                    await sleep(stagger * 2);
                    continue;
                }
                if (this.stopped) return;
                await sleep(stagger);
            }
            this.offset = (this.offset + size) % ids.length;
        } catch (e) {
            log.info("Background avatar sweep aborted", e);
        } finally {
            this.sweeping = false;
        }
    }
}