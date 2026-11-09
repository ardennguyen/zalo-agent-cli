/**
 * Profile commands — view/update profile, avatar, bio, and privacy settings.
 */

import { resolve } from "path";
import { getApi, getOwnId } from "../core/zalo-client.js";
import { updateAccountName } from "../core/accounts.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { allAvatars } from "../core/list-all.js";
import { parseIntOption } from "../utils/parse-options.js";
import { parseOnOff, parseLanguage } from "../utils/cli-args.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { SETTING_MAP, describeSettings, profileUpdatePayload, updateSetting } from "../core/profile-settings.js";

export function registerProfileCommands(program) {
    const profile = program.command("profile").description("View and update your Zalo profile and settings");

    profile
        .command("me")
        .description("Show current account profile")
        .action(async () => {
            try {
                const result = await getApi().fetchAccountInfo();
                const p = result?.profile || {};
                updateAccountName(p.userId || getOwnId(), p.displayName || p.zaloName);
                output(result, program.opts().json, () => {
                    info(`Name: ${p.displayName || p.zaloName || "?"}`);
                    info(`User ID: ${p.userId || "?"}`);
                    info(`Phone: ${p.phoneNumber || "?"}`);
                    info(`Gender: ${p.gender === 0 ? "Male" : p.gender === 1 ? "Female" : "?"}`);
                    info(`DOB: ${p.sdob || "?"}`);
                    info(`Status: ${p.status || "(none)"}`);
                    info(`Avatar: ${p.avatar || "?"}`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    profile
        .command("avatar <imagePath>")
        .description("Change your profile avatar")
        .action(async (imagePath) => {
            try {
                const absPath = resolve(imagePath);
                const result = await getApi().changeAccountAvatar(absPath);
                output(result, program.opts().json, () => success("Avatar updated"));
            } catch (e) {
                error(`Avatar update failed: ${e.message}`);
            }
        });

    profile
        .command("bio [text]")
        .description("View or update your profile bio/status")
        .action(async (text) => {
            try {
                if (text === undefined) {
                    const result = await getApi().fetchAccountInfo();
                    const bio = result?.profile?.status || "(empty)";
                    output({ bio }, program.opts().json, () => info(`Bio: ${bio}`));
                } else {
                    await getApi().updateProfileBio(text);
                    // Verify by reading back (Zalo may cache, so check)
                    const verify = await getApi().fetchAccountInfo();
                    const newBio = verify?.profile?.status || "";
                    if (newBio === text) {
                        output({ bio: newBio }, program.opts().json, () => success(`Bio updated to: "${text}"`));
                    } else {
                        output({ bio: newBio, requested: text }, program.opts().json, () => {
                            success(`Bio update request sent: "${text}"`);
                            info(
                                "Note: Zalo may take time to reflect changes, or bio may not be supported for your account type.",
                            );
                        });
                    }
                }
            } catch (e) {
                error(`Bio update failed: ${e.message}`);
            }
        });

    profile
        .command("update")
        .description("Update profile name, birthday, or gender")
        .option("-n, --name <name>", "Display name")
        .option("-d, --dob <YYYY-MM-DD>", "Date of birth")
        .option("-g, --gender <0|1>", "Gender: 0=Male, 1=Female")
        .action(async (opts) => {
            try {
                if (!opts.name && !opts.dob && !opts.gender) {
                    error("Provide at least one: --name, --dob, or --gender");
                    return;
                }
                // Fetch current profile to fill missing fields (API requires all 3)
                const current = await getApi().fetchAccountInfo();
                const p = current?.profile || {};
                const payload = profileUpdatePayload(p, opts);
                const result = await getApi().updateProfile(payload);
                updateAccountName(p.userId || getOwnId(), payload.profile.name);
                output(result, program.opts().json, () => success("Profile updated"));
            } catch (e) {
                error(`Profile update failed: ${e.message}`);
            }
        });

    profile
        .command("settings")
        .description(
            "View the privacy settings, the read-only ones (strangers' messages, two-factor, quick messages), and " +
                "with --json every other key Zalo sent, under `other`",
        )
        .action(async () => {
            try {
                // The same reply as zalo_profile `settings` (src/core/profile-settings.js).
                const result = describeSettings(await getApi().getSettings());
                output(result, program.opts().json, () => {
                    info("Privacy settings:");
                    console.log();
                    for (const row of result.settings) {
                        const label = row.meaning ?? String(row.value);
                        console.log(`  ${row.label.padEnd(32)} ${label}  (${row.setting}=${row.value})`);
                    }
                    console.log();
                    info("Read-only here:");
                    for (const row of result.readOnly) {
                        const label = row.meaning ?? String(row.value);
                        const how = row.changeWith ? `  (change with ${row.changeWith})` : "";
                        console.log(`  ${row.label.padEnd(32)} ${label}${how}`);
                    }
                    console.log();
                    info("Update: zalo-agent profile set <setting> <value>");
                    info("Example: zalo-agent profile set online-status 0");
                });
            } catch (e) {
                error(e.message);
            }
        });

    profile
        .command("avatars")
        .description("List your avatar gallery")
        .option("-c, --count <n>", "Page size (with -c or -p one page is read, 50 a page by default)", parseIntOption)
        .option("-p, --page <n>", "Read only this page (default: the whole gallery)", parseIntOption)
        .action(async (opts) => {
            try {
                let result;
                if (opts.count === undefined && opts.page === undefined) {
                    // No page asked: the whole gallery, page by page (src/core/list-all.js).
                    const { paging, ...all } = await allAvatars(getApi());
                    result = all;
                    if (paging.note) warning(paging.note);
                } else {
                    result = await getApi().getAvatarList(opts.count ?? 50, opts.page ?? 1);
                }
                output(result, program.opts().json);
            } catch (e) {
                error(`Get avatars failed: ${e.message}`);
            }
        });

    profile
        .command("full-avatar <friendId>")
        .description("Get full-size avatar URL for a user")
        .action(async (friendId) => {
            try {
                const result = await getApi().getFullAvatar(friendId);
                output(result, program.opts().json, () => {
                    info(`Avatar: ${result?.avatar || "?"}`);
                });
            } catch (e) {
                error(`Get full avatar failed: ${e.message}`);
            }
        });

    profile
        .command("avatar-url <friendIds...>")
        .description("Get avatar URLs for one or more users")
        .action(async (friendIds) => {
            try {
                const result = await getApi().getAvatarUrlProfile(friendIds);
                output(result, program.opts().json);
            } catch (e) {
                error(`Get avatar URLs failed: ${e.message}`);
            }
        });

    profile
        .command("delete-avatar <photoIds...>")
        .description("Delete avatar(s) from your gallery")
        .action(async (photoIds) => {
            try {
                const result = await getApi().deleteAvatar(photoIds);
                output(result, program.opts().json, () => success(`Deleted ${photoIds.length} avatar(s)`));
            } catch (e) {
                error(`Delete avatar failed: ${e.message}`);
            }
        });

    profile
        .command("reuse-avatar <photoId>")
        .description("Reuse a previous avatar from your gallery")
        .action(async (photoId) => {
            try {
                const result = await getApi().reuseAvatar(photoId);
                output(result, program.opts().json, () => success("Avatar reused"));
            } catch (e) {
                error(`Reuse avatar failed: ${e.message}`);
            }
        });

    profile
        .command("set <setting> <value>")
        .description("Update a privacy setting (use 'profile settings' to see options)")
        .action(async (setting, value) => {
            try {
                // Zalo answers the update with an empty body, so the reply is what was set (the same reply as
                // zalo_profile `set`, src/core/profile-settings.js); an unknown setting or value sends nothing.
                const reply = await updateSetting(getApi(), setting, value);
                const label = SETTING_MAP[setting].label;
                output(reply, program.opts().json, () => success(`${label}: ${reply.meaning} (${reply.value})`));
            } catch (e) {
                error(`Setting update failed: ${e.message}`);
            }
        });

    profile
        .command("active <on|off>")
        .description(
            "Set this session's presence, active (on) or away (off), as Zalo Web does when its tab gains or loses " +
                "focus. It does not hide your online status from others: that is `profile set online-status 0`",
        )
        .action(async (state) => {
            try {
                const active = parseOnOff(state, "active");
                const result = await getApi().updateActiveStatus(active);
                output(result, program.opts().json, () => success(`Active status: ${active ? "on" : "off"}`));
            } catch (e) {
                error(e.message);
            }
        });

    profile
        .command("lang <language>")
        .description("Set the account language: vi or en")
        .action(async (language) => {
            try {
                const lang = parseLanguage(language);
                const result = await getApi().updateLang(lang);
                output(result, program.opts().json, () => success(`Language set to ${lang}`));
            } catch (e) {
                error(e.message);
            }
        });

    profile
        .command("lost-focus")
        .description("Tell Zalo this client moved to the background (what Zalo Web sends when its tab loses focus)")
        .action(async () => {
            try {
                const result = await getApi().lostFocus();
                output(result, program.opts().json, () => success("Sent"));
            } catch (e) {
                error(`Lost focus failed: ${e.message}`);
            }
        });
    // Asked about first, as Zalo Web does: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    guardSubcommand(profile, "delete-avatar", "profile.deleteAvatar", { target: (photoIds) => ({ photoIds }) });
}
