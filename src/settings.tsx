/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_POLL_INTERVAL_MINUTES, DEFAULT_POLL_INTERVAL_SECONDS } from "./config";
import { smartPollIntervalSeconds } from "./poll";
// NOTE: intentional cycle settings <-> TrackedUsersOverview (the overview reads
// settings.store to label its rows). Both sides only touch the other at runtime
// — component render or an onChange callback, never at module evaluation — so
// ESM handles it. Do not "fix" by moving the component out of this file; add a
// comment here instead if the cycle changes. Same rule as store/history.ts.
import { TrackedUsersOverview } from "./ui/TrackedUsersOverview";

export const settings = definePluginSettings({
    trackedOverview: {
        type: OptionType.COMPONENT,
        component: () => <TrackedUsersOverview />,
    },
    trackSelf: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Automatically track your own avatar changes",
    },
    trackFriends: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Automatically track avatar changes of all your friends",
    },
    pollTracked: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Periodically re-check tracked users' avatars in the background. If disabled, avatars of other tracked users only update when you view their profile",
    },
    pollIntervalMode: {
        type: OptionType.SELECT,
        options: [
            { label: "Auto", value: "auto", default: true },
            { label: "Manual", value: "manual" },
        ],
        description: "How the background re-check interval is chosen. Auto (default) tunes it to the number of tracked users (30 s – 30 min); Manual lets you set a fixed interval",
        onChange(value) {
            // Switching to Manual pre-fills the seconds field with the interval
            // Auto picks right now. This is the only place the computed Auto
            // value becomes a setting: the sweep derives it on every cycle and
            // never writes it back, so the setting stays the user's own number.
            if (value === "manual")
                settings.store.pollIntervalSeconds = smartPollIntervalSeconds(settings.store.trackFriends);
        },
    },
    pollIntervalSeconds: {
        type: OptionType.NUMBER,
        default: DEFAULT_POLL_INTERVAL_SECONDS,
        description: "How often (in seconds) tracked users' avatars are re-checked in the background",
        hidden: () => settings.store.pollIntervalMode !== "manual",
    },
});

export function migratePollIntervalSetting(): void {
    // Migrations go through the plain store on purpose: one markAsChanged() at the
    // end instead of a settings write (and a listener round-trip) per key. This
    // is the one place in the plugin that legitimately bypasses the proxy.
    const stored = SettingsStore.plain.plugins.AvatarHistory as Record<string, unknown> | undefined;
    if (!stored) return;

    if (Object.hasOwn(stored, "pollIntervalMinutes")) {
        if (!Object.hasOwn(stored, "pollIntervalSeconds")) {
            const minutes = stored.pollIntervalMinutes;
            if (typeof minutes === "number" && minutes > 0) {
                stored.pollIntervalSeconds = minutes * 60;
                if (minutes !== DEFAULT_POLL_INTERVAL_MINUTES) {
                    stored.pollIntervalMode = "manual";
                }
            }
        }
        delete stored.pollIntervalMinutes;
    }

    if (Object.hasOwn(stored, "pollIntervalAuto") && typeof stored.pollIntervalMode !== "string") {
        if (stored.pollIntervalAuto === false) {
            stored.pollIntervalMode = "manual";
        }
        delete stored.pollIntervalAuto;
    }

    SettingsStore.markAsChanged();
}
