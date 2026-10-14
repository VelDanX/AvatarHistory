/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord & Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";

import { DEFAULT_POLL_INTERVAL_MINUTES, DEFAULT_POLL_INTERVAL_SECONDS } from "./config";
import { autoPollIntervalMs } from "./poll";
// Intentional cycle settings <-> TrackedUsersOverview. Both sides touch the other
// only at runtime, never at module evaluation. Same rule as store/history.ts.
import { TrackedUsersOverview } from "./ui/TrackedUsersOverview";

const log = new Logger("AvatarHistory");

export const settings = definePluginSettings({
    trackedOverview: {
        type: OptionType.COMPONENT,
        component: () => <TrackedUsersOverview />,
    },
    trackSelf: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Automatically track your own avatar changes",
        onChange(value) {
            log.info(`Setting trackSelf → ${value ? "on" : "off"}`);
        },
    },
    trackFriends: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Automatically track avatar changes of all your friends",
        onChange(value) {
            log.info(`Setting trackFriends → ${value ? "on" : "off"}`);
        },
    },
    pollTracked: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Periodically re-check tracked users' avatars in the background. If disabled, avatars of other tracked users only update when you view their profile",
        onChange(value) {
            log.info(`Setting pollTracked → ${value ? "on" : "off"}`);
        },
    },
    gatewaySync: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Also read avatars off Discord's gateway stream (USER_UPDATE, GUILD_MEMBER_UPDATE, MESSAGE_CREATE, PRESENCE_UPDATES): changes of tracked users are caught in the background, even for profiles you never open and messages you never scroll to. With this on, the Auto poll interval becomes a floor of 5 minutes — the sweep is a safety net for what events miss, not the primary source",
        onChange(value) {
            log.info(`Setting gatewaySync → ${value ? "on" : "off"}`);
        },
    },
    pollIntervalMode: {
        type: OptionType.SELECT,
        options: [
            { label: "Auto", value: "auto", default: true },
            { label: "Manual", value: "manual" },
        ],
        description: "How the background re-check interval is chosen. Auto (default) tunes it to the number of tracked users (30 s – 30 min); Manual lets you set a fixed interval",
        onChange(value) {
            // The one place the derived Auto value becomes a setting. Freeze the
            // interval actually in effect (gateway floor included), not the raw
            // pace — otherwise switching to Manual would silently un-slow the
            // sweep the gateway stream had taken over from.
            if (value === "manual") {
                const frozen = Math.round(autoPollIntervalMs(settings.store.trackFriends, settings.store.gatewaySync) / 1000);
                settings.store.pollIntervalSeconds = frozen;
                log.info(`Setting pollIntervalMode → manual, froze ${frozen}s`);
            } else {
                log.info("Setting pollIntervalMode → auto");
            }
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
    // Migrations go through the plain store: one markAsChanged() at the end
    // instead of a settings write per key. The one place we bypass the proxy.
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
