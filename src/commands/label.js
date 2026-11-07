/**
 * Label commands — list and update conversation/contact labels.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, output } from "../utils/output.js";
import { gateCli, guardSubcommand, removedLabels } from "../core/confirm-guard.js";

export function registerLabelCommands(program) {
    const label = program.command("label").description("Manage conversation labels");

    label
        .command("list")
        .description("List all labels")
        .action(async () => {
            try {
                const result = await getApi().getLabels();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get labels failed: ${e.message}`);
            }
        });

    label
        .command("update <json>")
        .description('Update labels (JSON payload: {"labelData":[...],"version":N})')
        .action(async (json, opts) => {
            try {
                const payload = JSON.parse(json);
                // The update replaces the whole list, so a label left out of it is deleted: only that is asked
                // about, and knowing it takes the current list.
                const api = getApi();
                const current = await api.getLabels();
                const removed = removedLabels(current?.labelData, payload?.labelData);
                gateCli("label.update", { removedLabels: removed, version: payload?.version ?? null }, opts, {
                    json: program.opts().json,
                    applies: removed.length > 0,
                });
                const result = await api.updateLabels(payload);
                output(result, program.opts().json, () => success("Labels updated"));
            } catch (e) {
                if (e instanceof SyntaxError) {
                    error(`Invalid JSON: ${e.message}`);
                } else {
                    error(`Update labels failed: ${e.message}`);
                }
            }
        });

    // Removing a label is asked about: --yes to act, --dry-run to preview (src/core/confirm-guard.js). The action
    // settles it itself, after reading which labels the update would remove.
    guardSubcommand(label, "update", "label.update", { target: () => ({}), deferred: true });
}
