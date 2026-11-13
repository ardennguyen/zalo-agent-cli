/**
 * Quick message commands — list, add, update, remove saved quick messages.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, output } from "../utils/output.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { setQuickMessageStatus } from "../core/profile-settings.js";

export function registerQuickMsgCommands(program) {
    const qm = program.command("quick-msg").description("Manage quick/saved messages");

    qm.command("list")
        .description("List all quick messages")
        .action(async () => {
            try {
                const result = await getApi().getQuickMessageList();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get quick messages failed: ${e.message}`);
            }
        });

    qm.command("add <keyword> <title>")
        .description("Add a quick message")
        .action(async (keyword, title) => {
            try {
                const result = await getApi().addQuickMessage({ keyword, title });
                output(result, program.opts().json, () => success(`Quick message added: "${keyword}" → "${title}"`));
            } catch (e) {
                error(`Add quick message failed: ${e.message}`);
            }
        });

    qm.command("update <itemId> <keyword> <title>")
        .description("Update a quick message")
        .action(async (itemId, keyword, title) => {
            try {
                const result = await getApi().updateQuickMessage({ keyword, title }, Number(itemId));
                output(result, program.opts().json, () => success(`Quick message ${itemId} updated`));
            } catch (e) {
                error(`Update quick message failed: ${e.message}`);
            }
        });

    qm.command("remove <itemIds...>")
        .description("Remove quick message(s)")
        .action(async (itemIds) => {
            try {
                const ids = itemIds.map(Number);
                const result = await getApi().removeQuickMessage(ids);
                output(result, program.opts().json, () => success(`Removed ${ids.length} quick message(s)`));
            } catch (e) {
                error(`Remove quick message failed: ${e.message}`);
            }
        });
    // Asked about first, as Zalo does: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    for (const [name, enabled] of [
        ["enable", true],
        ["disable", false],
    ]) {
        qm.command(name)
            .description(
                `Turn quick messages ${enabled ? "on" : "off"} for this account, as Zalo's switch does ` +
                    "(unverified live; `profile settings` shows the current state)",
            )
            .action(async () => {
                try {
                    // The same reply as zalo_quick_message's action of this name (src/core/profile-settings.js).
                    const result = await setQuickMessageStatus(getApi(), enabled);
                    output(result, program.opts().json, () =>
                        success(`Quick messages ${enabled ? "enabled" : "disabled"}`),
                    );
                } catch (e) {
                    error(`Quick message ${name} failed: ${e.message}`);
                }
            });
    }

    guardSubcommand(qm, "remove", "quickMsg.remove", { target: (itemIds) => ({ quickMessageIds: itemIds }) });
}
