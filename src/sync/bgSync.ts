/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const log = new Logger("AvatarHistory");

export const DEFAULT_STAGGER_MS = 1500;

const QUICK_START_COUNT = 30;
const QUICK_START_STAGGER_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export class BackgroundSync {
    private timer: number | null = null;
    private sweeping = false;
    private stopped = false;
    private pausedUntil = 0;

    constructor(
        private readonly ready: Promise<void>,
        private readonly getSweepIds: () => Promise<string[]>,
        private readonly checkUser: (userId: string) => Promise<boolean>,
        private readonly getIntervalMs: () => number,
        private readonly staggerMs = DEFAULT_STAGGER_MS,
    ) {}

    public start(): void {
        if (this.timer != null) return;
        this.scheduleNext();

        this.ready.then(() => {
            if (this.stopped) return;
            setTimeout(() => void this.sweep(QUICK_START_COUNT, QUICK_START_STAGGER_MS), 2000);
        });
    }

    public stop(): void {
        this.stopped = true;
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Pause the whole sweep (e.g. after a 429) instead of sleeping inside the loop. */
    public pause(durationMs: number): void {
        this.pausedUntil = Date.now() + durationMs;
        log.info(`Background sweep paused for ${Math.round(durationMs / 1000)}s`);
    }

    private scheduleNext(): void {
        this.timer = window.setTimeout(() => void this.sweep(), this.getIntervalMs());
    }

    private async sweep(sizeOverride?: number, staggerOverride?: number): Promise<void> {
        if (this.sweeping || this.stopped) return;
        // Paused (e.g. after a 429): reschedule *before* bailing out. The pending
        // timer is already consumed at this point, so returning without a new one
        // would kill the sweep chain until the next plugin restart.
        if (Date.now() < this.pausedUntil) {
            this.scheduleNext();
            return;
        }
        const stagger = staggerOverride ?? this.staggerMs;
        this.sweeping = true;
        try {
            const ids = await this.getSweepIds();
            if (!ids.length) return;

            const intervalMs = this.getIntervalMs();
            // Pace the batch to the interval: at most interval/stagger users per
            // sweep. A hard floor here would defeat pacing — a 30s interval with a
            // 1500ms stagger is 20 users, not 100 requests in a row.
            const cap = Math.max(1, Math.floor(intervalMs / this.staggerMs));
            const size = Math.min(sizeOverride ?? cap, ids.length);
            for (let i = 0; i < size; i++) {
                if (this.stopped) return;
                // Ids arrive stalest-first (see sweepTargetIds), so the head of
                // the list is always whoever has gone longest unconfirmed —
                // checking them pushes them to the back, no rotation needed.
                const id = ids[i];
                try {
                    // checkUser returns true to abort the batch (e.g. after a 429).
                    if (await this.checkUser(id)) break;
                } catch (e) {
                    log.warn(`Background avatar check failed for ${id}`, e);
                    if (this.stopped) return;
                    await sleep(stagger * 2);
                    continue;
                }
                if (this.stopped) return;
                await sleep(stagger);
            }
        } catch (e) {
            log.info("Background avatar sweep aborted", e);
        } finally {
            this.sweeping = false;
            if (!this.stopped) this.scheduleNext();
        }
    }
}
