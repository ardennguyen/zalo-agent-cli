/**
 * `cloud`: what is in the account's zCloud index, and what a cleanup would touch (decision D27, 2026-10-28).
 *
 * Both commands read the local index that `sync-cloud` fills and the local message cache. They send nothing to Zalo and
 * delete nothing, anywhere: Zalo has no zCloud delete endpoint, and the only removal the clients have (deleting the chat
 * message for this account on every device) cannot be undone. There is no `apply`: it waits until one such delete has
 * been validated on a disposable item with the owner present (docs/agent-notes.md).
 */
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { getAccountDbPath } from "../core/credentials.js";
import { getActive } from "../core/accounts.js";
import { findMessageByClientId, getCloudItems, getThreadNames, initDb } from "../core/db.js";
import { CLEANUP_WARNING, PLAN_DEFAULT_LIMIT, PLAN_MAX_LIMIT, planCloudCleanup } from "../core/cloud-plan.js";
import { error, info, output, warning } from "../utils/output.js";

const MB = 1024 * 1024;

/** Human-readable byte count. */
function bytesText(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Collect a repeatable option. */
const collect = (value, previous) => [...previous, value];

/**
 * Open the active account's cache and read the whole zCloud index and the helpers a plan needs.
 *
 * @returns {{ownId: string, rows: object[], names: Map<string, {name?: string}>, savedLocally: (item: object) => boolean}}
 */
function openIndex() {
    const account = getActive();
    if (!account) {
        error("No active account. Please login first.");
        process.exit(1);
    }
    initDb(getAccountDbPath(account.ownId));
    const rows = getCloudItems(null, 10_000_000);
    const names = getThreadNames();
    const savedLocally = (item) => {
        if (!item.cliMsgId) return false;
        try {
            return Boolean(findMessageByClientId(item.cliMsgId, item.threadId)?.localPath);
        } catch {
            return false;
        }
    };
    return { ownId: account.ownId, rows, names, savedLocally };
}

/**
 * Register `cloud`.
 *
 * @param {import("commander").Command} program
 */
export function registerCloudCommands(program) {
    const cloud = program
        .command("cloud")
        .description("What the zCloud index holds and what a cleanup would touch (reports only: nothing is deleted)");

    const ls = cloud
        .command("ls")
        .description(
            "Summarize the local zCloud index (run `sync-cloud` first): items and bytes by kind and conversation",
        )
        .option("-n, --top <n>", "Conversations to list", (v) => Math.max(1, parseInt(v, 10) || 10), 10)
        .action((opts) => {
            const jsonMode = program.opts().json;
            let r;
            let index;
            try {
                index = openIndex();
                r = planCloudCleanup({
                    rows: index.rows,
                    ownId: index.ownId,
                    filters: { includeGroups: true, includeMyCloud: true, limit: 1 },
                    nameOf: (id) => index.names.get(String(id))?.name ?? null,
                });
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            const top = r.byConversation.slice(0, opts.top);
            output(
                {
                    items: r.matched + r.excluded.e2ee,
                    bytes: r.bytes,
                    byKind: r.byKind,
                    byConversation: top,
                    e2eeItems: r.excluded.e2ee,
                },
                jsonMode,
                () => {
                    if (!r.matched && !r.excluded.e2ee) {
                        info("The local zCloud index is empty. Run `zalo-agent sync-cloud` to fill it.");
                        return;
                    }
                    info(`${r.matched + r.excluded.e2ee} item(s), ${bytesText(r.bytes)} in the local index.`);
                    for (const [kind, v] of Object.entries(r.byKind).sort((a, b) => b[1].bytes - a[1].bytes)) {
                        info(`  ${kind}: ${v.items} item(s), ${bytesText(v.bytes)}`);
                    }
                    info("Largest conversations:");
                    for (const c of top) {
                        info(`  ${c.name ?? c.threadId}: ${c.items} item(s), ${bytesText(c.bytes)}`);
                    }
                    if (r.excluded.e2ee)
                        info(`${r.excluded.e2ee} end-to-end encrypted item(s) are not counted by size.`);
                },
            );
        });
    ls.zaloLocalOnly = true;

    const plan = cloud
        .command("plan")
        .description("Dry run: which zCloud items a cleanup of this shape would cover and how much space it would free")
        .option("-c, --conv <threadId>", "Only this conversation (repeatable)", collect, [])
        .option("-t, --type <kinds>", "Only these kinds, comma separated: photo, video, file, voice, gif, other")
        .option("--older-than <days>", "Only items older than this many days", (v) => Number(v))
        .option("--larger-than <mb>", "Only items of at least this many MB", (v) => Number(v))
        .option("-n, --limit <n>", `Items to list (default ${PLAN_DEFAULT_LIMIT}, at most ${PLAN_MAX_LIMIT})`, (v) =>
            parseInt(v, 10),
        )
        .option("--only-saved-locally", "Only items whose file this machine already holds")
        .option("--include-groups", "Include group conversations (left out by default)")
        .option("--include-my-cloud", "Include My Cloud, the chat with yourself (left out by default)")
        .option("-o, --out <file>", "Write the plan (with every listed item) to this file, mode 0600")
        .action((opts) => {
            const jsonMode = program.opts().json;
            for (const [flag, v] of [
                ["--older-than", opts.olderThan],
                ["--larger-than", opts.largerThan],
            ]) {
                if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
                    error(`${flag} needs a number of at least 0.`);
                    process.exit(1);
                }
            }
            let r;
            try {
                const index = openIndex();
                r = planCloudCleanup({
                    rows: index.rows,
                    ownId: index.ownId,
                    filters: {
                        threads: opts.conv,
                        kinds: opts.type
                            ? String(opts.type)
                                  .split(",")
                                  .map((k) => k.trim())
                                  .filter(Boolean)
                            : [],
                        olderThanDays: opts.olderThan ?? null,
                        largerThanBytes: opts.largerThan === undefined ? null : opts.largerThan * MB,
                        onlySavedLocally: Boolean(opts.onlySavedLocally),
                        includeGroups: Boolean(opts.includeGroups),
                        includeMyCloud: Boolean(opts.includeMyCloud),
                        limit: opts.limit,
                    },
                    savedLocally: index.savedLocally,
                    nameOf: (id) => index.names.get(String(id))?.name ?? null,
                });
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            const result = { warning: CLEANUP_WARNING, generatedAt: new Date().toISOString(), ...r };
            if (opts.out) {
                try {
                    const file = resolve(opts.out);
                    writeFileSync(file, JSON.stringify(result, null, 2), { mode: 0o600 });
                    try {
                        chmodSync(file, 0o600);
                    } catch {
                        /* a filesystem with no modes */
                    }
                    result.file = file;
                } catch (e) {
                    error(`Could not write the plan: ${e.message}`);
                    process.exit(1);
                }
            }
            output(result, jsonMode, () => {
                warning(CLEANUP_WARNING);
                info(
                    `${r.matched} item(s) match, ${bytesText(r.bytes)} would be freed` +
                        (r.listed < r.matched ? ` (${r.listed} listed)` : "") +
                        ".",
                );
                for (const [kind, v] of Object.entries(r.byKind).sort((a, b) => b[1].bytes - a[1].bytes)) {
                    info(`  ${kind}: ${v.items} item(s), ${bytesText(v.bytes)}`);
                }
                if (r.byConversation.length) {
                    info("Largest conversations in the plan:");
                    for (const c of r.byConversation.slice(0, 10)) {
                        info(`  ${c.name ?? c.threadId}: ${c.items} item(s), ${bytesText(c.bytes)}`);
                    }
                }
                if (r.risks.notSavedLocally) {
                    info(
                        `${r.risks.notSavedLocally} item(s) are not saved on this machine: deleting them loses them for good.`,
                    );
                }
                if (r.risks.incoming) info(`${r.risks.incoming} item(s) are in messages other people sent you.`);
                const ex = r.excluded;
                const left = [
                    ex.e2ee && `${ex.e2ee} end-to-end encrypted`,
                    ex.groups && `${ex.groups} in groups (add --include-groups)`,
                    ex.myCloud && `${ex.myCloud} in My Cloud (add --include-my-cloud)`,
                    ex.notSavedLocally && `${ex.notSavedLocally} not saved here`,
                ].filter(Boolean);
                if (left.length) info(`Left out: ${left.join(", ")}.`);
                if (result.file) info(`The plan was written to ${result.file}`);
            });
        });
    plan.zaloLocalOnly = true;
}
