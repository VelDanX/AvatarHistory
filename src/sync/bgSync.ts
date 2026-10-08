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

/**
 * Describes one failed check in a single short line.
 *
 * Discord's RestAPI rejects with a plain object, which the log renders as
 * `[object Object]`. Dumping it whole is worse than useless: the response
 * headers come first alphabetically and fill any budget before `status` and
 * `body` are reached, so the line got cut mid-header and said nothing about
 * which status came back. Those fields are picked instead, and an Error keeps
 * its own message.
 */
function describeCheckError(e: unknown): string {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    const err = e as { status?: number; code?: number; message?: string; body?: unknown } | undefined;
    const parts = [
        err?.status != null ? `status=${err.status}` : undefined,
        err?.code != null ? `code=${err.code}` : undefined,
        err?.message ? `message=${err.message}` : undefined,
        err?.body != null ? `body=${JSON.stringify(err.body).slice(0, 120)}` : undefined,
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : JSON.stringify(e)?.slice(0, 120) ?? "unknown";
}

export class BackgroundSync {
    private timer: number | null = null;
    private sweeping = false;
    private stopped = false;
    private pausedUntil = 0;
    // EWMA of a single REST check (ms). Without it cap = interval/stagger only
    // accounts for the stagger, while every check also costs ~200–500ms of REST.
    private avgCheckMs = 0;
    // When the current sweep started — the anchor for the schedule.
    private lastSweepStartedAt = 0;

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

    /**
     * Schedules the next sweep.
     *
     * Without an explicit delay the next sweep is anchored to the *start* of
     * the previous one rather than to its end — otherwise the effective period
     * is interval + sweep duration (346s instead of 300s with a 46s sweep).
     * A pause (429) calls this with its own deadline: anchoring to the interval
     * there could yield 0 and turn the wait into a busy-loop.
     */
    private scheduleNext(delayMs?: number): void {
        if (this.stopped) return;
        // The quick-start sweep runs outside this timer, so a stale timer may
        // still be pending — drop it, or a second sweep would be scheduled.
        if (this.timer != null) window.clearTimeout(this.timer);
        const remaining = this.getIntervalMs()
            - (this.lastSweepStartedAt ? Date.now() - this.lastSweepStartedAt : 0);
        this.timer = window.setTimeout(() => void this.sweep(), delayMs ?? Math.max(0, remaining));
    }

    /** Plain EWMA: absorbs outliers (429s, timeouts) so the cap stays stable. */
    private noteCheck(ms: number): void {
        this.avgCheckMs = this.avgCheckMs === 0 ? ms : Math.round(this.avgCheckMs * 0.7 + ms * 0.3);
    }

    private async sweep(sizeOverride?: number, staggerOverride?: number): Promise<void> {
        if (this.sweeping || this.stopped) return;
        // Reschedule *before* bailing out: the pending timer is already consumed
        // here, so returning without a new one would kill the sweep chain.
        if (Date.now() < this.pausedUntil) {
            this.scheduleNext(Math.max(0, this.pausedUntil - Date.now()) + 1000);
            return;
        }
        const stagger = staggerOverride ?? this.staggerMs;
        this.sweeping = true;
        // Anchor for scheduleNext — counted from here, not from the end of the sweep.
        this.lastSweepStartedAt = Date.now();
        try {
            const ids = await this.getSweepIds();
            if (!ids.length) {
                log.info("Sweep: no users to check");
                return;
            }

            const intervalMs = this.getIntervalMs();
            // Pace the batch so it *fits* into the interval: a user costs the
            // stagger plus the REST call, so cap = interval/stagger always
            // overran the interval — with a large list the sweep became nearly
            // continuous. A hard floor would defeat pacing just the same.
            const perUserMs = Math.max(1, stagger + this.avgCheckMs);
            const cap = Math.max(1, Math.floor(intervalMs / perUserMs));
            const size = Math.min(sizeOverride ?? cap, ids.length);
            // `log.debug` would be invisible here: console.debug never reaches
            // renderer_js.log, so cadence diagnostics stay plain info lines.
            log.info(`Sweep start: ${size}/${ids.length} users, interval=${Math.round(intervalMs / 1000)}s, stagger=${stagger}ms, cap=${cap}`);
            const startedAt = Date.now();
            let checked = 0;
            let errors = 0;
            let lastError = "";
            for (let i = 0; i < size; i++) {
                // Breaks rather than returns, so the sweep still reports what it
                // managed before a stop (plugin reload, disabling the sweep).
                if (this.stopped) break;
                // Ids arrive stalest-first (sweepTargetIds), so the head is always
                // the longest-unconfirmed user — no rotation needed.
                const id = ids[i];
                checked++;
                const checkStartedAt = Date.now();
                try {
                    // checkUser returns true to abort the batch (e.g. after a 429).
                    if (await this.checkUser(id)) break;
                } catch (e) {
                    errors++;
                    lastError = describeCheckError(e);
                    if (this.stopped) break;
                    await sleep(stagger * 2);
                    continue;
                } finally {
                    // Counted either way, and on the way out: a check that throws
                    // still cost its REST round trip.
                    this.noteCheck(Date.now() - checkStartedAt);
                }
                if (this.stopped) break;
                await sleep(stagger);
            }
            // One verdict per sweep. A per-user line for each failure was noise
            // (a dead network produced 29), and the last one is kept here because
            // it is usually the one that explains the first.
            const verdict = `Sweep done: ${checked}/${size} checked, ${errors} error(s), ${Date.now() - startedAt}ms (check≈${this.avgCheckMs}ms)`;
            log.info(this.stopped ? `${verdict} — interrupted` : verdict + (lastError ? `, last: ${lastError}` : ""));
        } catch (e) {
            log.info("Background avatar sweep aborted", e);
        } finally {
            this.sweeping = false;
            this.scheduleNext();
        }
    }
}
