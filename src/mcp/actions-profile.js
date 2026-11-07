/**
 * `zalo_profile`: the `profile` commands and `account devices` as MCP actions, each making its command's call.
 * This account's own profile is read with zalo_lookup_user (`self: true`), as `profile me` and `whoami` print it.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { UPDATE_LANG } from "../zalo/enums.js";
import { createTrustStore } from "../zalo/trust-store.js";
import { getAccountDir } from "../core/credentials.js";
import { summarizeCompanion } from "../core/account-devices.js";
import { dbUsedBytes } from "../core/db.js";
import { describeStorage } from "../core/storage-quota.js";
import {
    SETTING_MAP,
    describeSettings,
    profileUpdatePayload,
    settingValueError,
    updateSetting,
} from "../core/profile-settings.js";
import { confirmInput, dryRunInput, ticketInput } from "./action-tool.js";

/** A local file the server can read, or the refusal that names it. */
function localFile(path) {
    const abs = resolve(String(path).trim());
    return existsSync(abs) ? { abs } : { error: `File not found on the machine this server runs on: ${abs}` };
}

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const PROFILE_ACTIONS = {
    avatar: {
        needs: ["filePath"],
        check: (a) => localFile(a.filePath).error,
        async run(a, { api }) {
            await api.changeAccountAvatar(localFile(a.filePath).abs);
            return { success: true };
        },
    },
    bio: {
        async run(a, { api }) {
            if (a.bio === undefined) {
                const info = await api.fetchAccountInfo();
                return { bio: info?.profile?.status || "" };
            }
            await api.updateProfileBio(a.bio);
            // Read back, as `profile bio` does: Zalo may take a moment, or not support a bio on this account.
            const now = (await api.fetchAccountInfo())?.profile?.status || "";
            return { success: true, bio: now, ...(now !== a.bio && { requested: a.bio, applied: false }) };
        },
    },
    update: {
        check: (a) =>
            a.name === undefined && a.dob === undefined && a.gender === undefined
                ? "Give at least one of name, dob or gender for action='update'."
                : undefined,
        async run(a, ctx) {
            // Zalo takes the three together, so the ones not given come from the current profile.
            const current = (await ctx.api.fetchAccountInfo())?.profile || {};
            const payload = profileUpdatePayload(current, {
                name: a.name,
                dob: a.dob,
                gender: a.gender === undefined ? undefined : a.gender === "female" ? 1 : 0,
            });
            await ctx.api.updateProfile(payload);
            if (payload.profile.name) ctx.onSelfName?.(payload.profile.name);
            const p = payload.profile;
            return { success: true, name: p.name, dob: p.dob, gender: p.gender === 1 ? "female" : "male" };
        },
    },
    settings: {
        async run(_a, { api }) {
            // The same reply as `profile settings --json` (src/core/profile-settings.js).
            return describeSettings(await api.getSettings());
        },
    },
    set: {
        needs: ["setting", "value"],
        check: (a) => settingValueError(a.setting, a.value),
        async run(a, { api }) {
            return updateSetting(api, a.setting, a.value);
        },
    },
    avatars: {
        async run(a, { api }) {
            return { data: (await api.getAvatarList(a.limit ?? 50, a.page ?? 1)) ?? null };
        },
    },
    full_avatar: {
        needs: ["userId"],
        async run(a, { api }) {
            const res = await api.getFullAvatar(a.userId);
            return { userId: a.userId, avatar: res?.avatar ?? null };
        },
    },
    avatar_url: {
        needs: ["userIds"],
        async run(a, { api }) {
            return { data: (await api.getAvatarUrlProfile(a.userIds)) ?? null };
        },
    },
    delete_avatar: {
        needs: ["photoIds"],
        guard: (a) => ({ key: "profile.deleteAvatar", target: { photoIds: a.photoIds } }),
        async run(a, { api }) {
            await api.deleteAvatar(a.photoIds);
            return { success: true, photoIds: a.photoIds };
        },
    },
    reuse_avatar: {
        needs: ["photoId"],
        async run(a, { api }) {
            await api.reuseAvatar(a.photoId);
            return { success: true, photoId: a.photoId };
        },
    },
    active: {
        needs: ["enabled"],
        async run(a, { api }) {
            await api.updateActiveStatus(a.enabled);
            return { success: true, enabled: a.enabled };
        },
    },
    lang: {
        needs: ["language"],
        async run(a, { api }) {
            await api.updateLang(UPDATE_LANG[a.language.toUpperCase()]);
            return { success: true, language: a.language };
        },
    },
    devices: {
        async run(_a, { api }) {
            const devices = (await api.getListDevice())?.devices ?? null;
            // Which entry is this server: the companion identity the official QR login saved, if any. The signed
            // identity material of each entry is never returned.
            const saved = createTrustStore(getAccountDir).load(String(api.getOwnId()));
            const mine = { companionId: saved?.companionId ?? null };
            const companions = (devices?.companions || []).map((c) => {
                const { id, ...rest } = summarizeCompanion(c, mine);
                return { companionId: id === null ? null : String(id), ...rest };
            });
            return {
                primaryDevice: devices?.masterId ?? null,
                lastUpdate: devices?.lastUpdateTs ?? null,
                count: companions.length,
                companions,
            };
        },
    },
    usage: {
        // `db usage`: this account's storage on the server (database, media, outbox), its quota and retention rules,
        // and the quota state. Read-only and local: Zalo is not asked.
        async run(_a, ctx) {
            const ownId = String(ctx.ownId?.() ?? ctx.api.getOwnId());
            let dbBytes = null;
            try {
                dbBytes = dbUsedBytes();
            } catch {
                /* no open cache: the file sizes */
            }
            return { accountId: ownId, ...describeStorage(ownId, { mediaRoot: ctx.mediaRoot ?? null, dbBytes }) };
        },
    },
};

/** zalo_profile's metadata. */
export const PROFILE_META = {
    title: "Manage This Zalo Account's Profile",
    description:
        "Change this account's own profile and settings, as the `profile` commands do (read the profile itself " +
        "with zalo_lookup_user `self: true`). Actions: 'avatar' (set the avatar from a local image, `filePath`), " +
        "'bio' (read it, or set it to `bio`), 'update' (`name`, `dob`, `gender`), 'settings' (the privacy " +
        "settings, the read-only ones, and every other key Zalo sent under `other`) and 'set' (one of them: " +
        "`setting`, `value`), 'avatars' (the avatar gallery), 'full_avatar' " +
        "(a user's full-size avatar), 'avatar_url' (several users' avatar URLs), 'delete_avatar' (photos from " +
        "the gallery; asked about first: `confirm`, `dryRun`), 'reuse_avatar' (an earlier photo as the avatar), " +
        "'active' (this session's presence, active or away, as Zalo Web sends when its tab gains or " +
        "loses focus; it does not hide the online status, which is 'set' with setting 'online-status'), " +
        "'lang' (the account language), 'devices' (the phone and " +
        "the devices linked to this account) and 'usage' (read-only: this account's storage on the server, its " +
        "database, media and webhook outbox in bytes, its quota and retention rules, and the quota level ok, warn or " +
        "over with the purge date, as `db usage` prints it; the server also sends `storage_quota` system events " +
        "through zalo_get_messages and zalo_wait_for_message). Everyone who sees this account sees what changes here.",
    inputSchema: z
        .object({
            action: z
                .enum(Object.keys(PROFILE_ACTIONS))
                .describe("Profile operation to perform (the `profile` subcommand, with _ for -)"),
            filePath: z
                .string()
                .min(1)
                .optional()
                .describe("Only for 'avatar': a local image path on the machine this server runs on"),
            bio: z
                .string()
                .max(500)
                .optional()
                .describe("Only for 'bio': the new bio; leave it out to read the current one"),
            name: z.string().min(1).max(100).optional().describe("Only for 'update': the new display name"),
            dob: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .describe("Only for 'update': the date of birth, YYYY-MM-DD"),
            gender: z.enum(["male", "female"]).optional().describe("Only for 'update': male or female"),
            setting: z
                .enum(Object.keys(SETTING_MAP))
                .optional()
                .describe("Only for 'set': which privacy setting ('settings' shows each with its values)"),
            value: z
                .number()
                .int()
                .min(0)
                .max(9)
                .optional()
                .describe("Only for 'set': the setting's new value, a number 'settings' lists for it"),
            userId: z.string().min(1).optional().describe("Only for 'full_avatar': the user whose avatar to fetch"),
            userIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("Only for 'avatar_url': the users whose avatar URLs to fetch"),
            photoIds: z
                .array(z.string().min(1))
                .min(1)
                .max(50)
                .optional()
                .describe("Only for 'delete_avatar': gallery photo ids, from 'avatars'"),
            photoId: z
                .string()
                .min(1)
                .optional()
                .describe("Only for 'reuse_avatar': a gallery photo id, from 'avatars'"),
            enabled: z
                .boolean()
                .optional()
                .describe(
                    "Only for 'active': true marks this session active, false away (session presence, not the " +
                        "online-status privacy setting)",
                ),
            language: z.enum(["vi", "en"]).optional().describe("Only for 'lang': vi or en"),
            limit: z.number().int().min(1).max(200).optional().describe("Only for 'avatars': page size (default 50)"),
            page: z.number().int().min(1).optional().describe("Only for 'avatars': page number (default 1)"),
            confirm: confirmInput("'delete_avatar'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'delete_avatar'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
