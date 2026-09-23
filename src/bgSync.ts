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
    private offset = 0;

    constructor(
        private readonly ready: Promise<void>,
        private readonly getSweepIds: () => Promise<string[]>,
        private readonly checkUser: (userId: string) => Promise<void>,
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

    private scheduleNext(): void {
        this.timer = window.setTimeout(() => void this.sweep(), this.getIntervalMs());
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

            const intervalMs = this.getIntervalMs();
            const cap = Math.max(100, Math.floor(intervalMs / this.staggerMs));
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
            if (!this.stopped) this.scheduleNext();
        }
    }
}
