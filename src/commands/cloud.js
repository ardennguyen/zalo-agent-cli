/**
 * `cloud`: what is in the account's zCloud index, what a cleanup would touch (decision D27, 2026-10-28), and the
 * cleanup itself.
 *
 * `ls` and `plan` read the local index that `sync-cloud` fills and the local message cache; they send nothing to Zalo.
 * `apply` does what Zalo Web's cloud view does when you delete items there (bundle 2026-11-06): it deletes the chat
 * message each item belongs to, for this account on every device, which cannot be undone. Zalo has no zCloud delete
 * endpoint. It is guarded (`--yes`, `--dry-run`, src/core/confirm-guard.js) and unverified: no such delete has been
 * watched on a disposable item yet (docs/agent-notes.md).
 *
 * `get` downloads one item's blob as Zalo Web opens it (src/zalo/zcloud-e2ee.js, ZP-10), unverified. An encrypted blob
 * opens only with the account's cloud key, which a person gives at run time (`--key-stdin`, `--key-prompt`) and which
 * is never stored (decision D8).
 */
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { getAccountDbPath } from "../core/credentials.js";
import { scopeOf } from "../core/keystore/index.js";
import { decryptMediaToFile } from "../core/keystore/media-seal.js";
import { getActive } from "../core/accounts.js";
import { findMessageByClientId, getCloudItems, getThreadNames, initDb } from "../core/db.js";
import {
    CLEANUP_WARNING,
    PLAN_DEFAULT_LIMIT,
    PLAN_MAX_LIMIT,
    applyCloudCleanup,
    planCloudCleanup,
} from "../core/cloud-plan.js";
import { gateCli, guardSubcommand } from "../core/confirm-guard.js";
import { autoLogin, getApi } from "../core/zalo-client.js";
import { error, info, output, success, warning } from "../utils/output.js";
import { parseIntAtLeast } from "../utils/parse-options.js";
import { promptSecret, readSecretFromStream } from "../utils/secret-input.js";
import { fetchCloudBlob } from "../zalo/zcloud.js";
import { decryptCloudBlob, decryptCloudInfo, importCloudPrivateKey } from "../zalo/zcloud-e2ee.js";

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
 * The filter options `plan` and `apply` share.
 *
 * @param {import("commander").Command} cmd
 * @returns {import("commander").Command}
 */
function filterOptions(cmd) {
    return cmd
        .option("-c, --conv <threadId>", "Only this conversation (repeatable)", collect, [])
        .option("-t, --type <kinds>", "Only these kinds, comma separated: photo, video, file, voice, gif, other")
        .option("--older-than <days>", "Only items older than this many days", (v) => Number(v))
        .option("--larger-than <mb>", "Only items of at least this many MB", (v) => Number(v))
        .option("-n, --limit <n>", `Items to list (default ${PLAN_DEFAULT_LIMIT}, at most ${PLAN_MAX_LIMIT})`, (v) =>
            parseInt(v, 10),
        )
        .option("--only-saved-locally", "Only items whose file this machine already holds")
        .option("--include-groups", "Include group conversations (left out by default)")
        .option("--include-my-cloud", "Include My Cloud, the chat with yourself (left out by default)");
}

/**
 * Check the numeric filters and plan from the local index; exits 1 on a bad value or an unreadable index.
 *
 * @param {object} opts - the command's options
 * @returns {{index: ReturnType<typeof openIndex>, r: ReturnType<typeof planCloudCleanup>}}
 */
function planFrom(opts) {
    for (const [flag, v] of [
        ["--older-than", opts.olderThan],
        ["--larger-than", opts.largerThan],
    ]) {
        if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
            error(`${flag} needs a number of at least 0.`);
            process.exit(1);
        }
    }
    try {
        const index = openIndex();
        const r = planCloudCleanup({
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
        return { index, r };
    } catch (e) {
        error(e.message);
        process.exit(1);
    }
}

/**
 * Register `cloud`.
 *
 * @param {import("commander").Command} program
 */
export function registerCloudCommands(program) {
    const cloud = program
        .command("cloud")
        .description("What the zCloud index holds, what a cleanup would touch, and the cleanup (`apply`, guarded)");

    const ls = cloud
        .command("ls")
        .description(
            "Summarize the local zCloud index (run `sync-cloud` first): items and bytes by kind and conversation",
        )
        .option("-n, --top <n>", "Conversations to list (default: all)", parseIntAtLeast(1))
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
            const top = opts.top ? r.byConversation.slice(0, opts.top) : r.byConversation;
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
                    info("Conversations, largest first:");
                    for (const c of top) {
                        info(`  ${c.name ?? c.threadId}: ${c.items} item(s), ${bytesText(c.bytes)}`);
                    }
                    if (r.excluded.e2ee)
                        info(`${r.excluded.e2ee} end-to-end encrypted item(s) are not counted by size.`);
                },
            );
        });
    ls.zaloLocalOnly = true;

    const plan = filterOptions(
        cloud
            .command("plan")
            .description(
                "Dry run: which zCloud items a cleanup of this shape would cover and how much space it would free",
            ),
    )
        .option("-o, --out <file>", "Write the plan (with every listed item) to this file, mode 0600")
        .action((opts) => {
            const jsonMode = program.opts().json;
            const { r } = planFrom(opts);
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
                    info("Conversations in the plan, largest first:");
                    for (const c of r.byConversation) {
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

    const apply = filterOptions(
        cloud
            .command("apply")
            .description(
                "Delete the planned items as Zalo Web's cloud view does: the chat message behind each, for this " +
                    "account on every device (no undo; unverified). Same filters as `plan`; acts on the listed items",
            ),
    )
        .option("--dry-run", "Show the plan and what would be sent, and send nothing")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const { index, r } = planFrom(opts);
            const conversations = new Set(r.items.map((it) => it.threadId)).size;
            const listedBytes = r.items.reduce((sum, it) => sum + it.bytes, 0);
            const target = { items: r.listed, size: bytesText(listedBytes), conversations };
            if (opts.dryRun) {
                output({ dryRun: true, sent: false, verified: false, warning: CLEANUP_WARNING, ...r }, jsonMode, () => {
                    warning(CLEANUP_WARNING);
                    info(
                        `Dry run: this would delete the message behind ${r.listed} item(s) (${target.size}) in ` +
                            `${conversations} conversation(s)` +
                            (r.listed < r.matched ? ` (${r.matched} match; raise --limit for more)` : "") +
                            ". Nothing was sent.",
                    );
                });
                process.exit(0);
            }
            gateCli("cloud.delete", target, opts, { json: jsonMode });
            if (!r.listed) {
                output({ deleted: 0, failed: [], skipped: [], bytes: 0, verified: false }, jsonMode, () =>
                    info("Nothing matches: no message was deleted."),
                );
                return;
            }
            await autoLogin(jsonMode);
            let api;
            try {
                api = getApi();
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            const result = await applyCloudCleanup({
                items: r.items,
                ownId: index.ownId,
                deleteForMe: (t) => api.deleteMessage(t, true),
                onProgress: (p) => {
                    if (!jsonMode && !p.ok) warning(`  ${p.item.noiseId}: ${p.error}`);
                },
            });
            output({ ...result, matched: r.matched, verified: false }, jsonMode, () => {
                success(
                    `Deleted the message behind ${result.deleted} item(s), ${bytesText(result.bytes)}. ` +
                        "The cloud drops them when its queue says so; `sync-cloud` then updates the local index.",
                );
                if (result.failed.length) warning(`${result.failed.length} item(s) were not deleted.`);
                if (result.skipped.length) info(`${result.skipped.length} item(s) were skipped (no message to name).`);
            });
            if (result.failed.length) process.exitCode = 1;
        });
    apply.zaloLocalOnly = true;

    const get = cloud
        .command("get <noiseId>")
        .description(
            "Download one zCloud item as Zalo Web opens it (unverified live). An encrypted item opens only with the " +
                "account's cloud key, given at run time and never stored",
        )
        .requiredOption("-o, --out <file>", "Where to write the file (mode 0600)")
        .option("--key-stdin", "Read the account's cloud key (base64 PKCS#8 RSA) from standard input")
        .option("--key-prompt", "Type the account's cloud key at a prompt that does not echo")
        .option("--raw", "Write an encrypted item as downloaded when no key is given")
        .action(async (noiseId, opts) => {
            const jsonMode = program.opts().json;
            let index;
            try {
                index = openIndex();
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            const row = index.rows.find((r) => String(r.noiseId) === String(noiseId));
            if (!row) {
                error(
                    `No item ${noiseId} in the local zCloud index (run \`zalo-agent sync-cloud\`, then \`cloud ls\`).`,
                );
                process.exit(1);
            }
            let raw = {};
            try {
                raw = JSON.parse(row.raw_data || "{}");
            } catch {
                raw = {};
            }
            const out = resolve(opts.out);
            const writeOut = (bytes) => {
                writeFileSync(out, bytes, { mode: 0o600 });
                try {
                    chmodSync(out, 0o600);
                } catch {
                    /* a filesystem with no modes */
                }
            };
            // My Cloud (the chat with oneself): the Web opens the item through its chat message first.
            const selfChat = String(row.threadId) === String(index.ownId);
            if (selfChat && index.savedLocally({ cliMsgId: raw.msgInfo?.cliMsgId, threadId: row.threadId })) {
                const msg = findMessageByClientId(String(raw.msgInfo.cliMsgId), row.threadId);
                // The cached copy is sealed (keystore/media-seal.js): written out decrypted, 0600.
                decryptMediaToFile(msg.localPath, out, scopeOf(String(index.ownId)), { msgId: msg.msgId });
                output({ noiseId, file: out, source: "message", encrypted: false, verified: true }, jsonMode, () =>
                    success(`Written from its chat message's downloaded file: ${out}`),
                );
                return;
            }
            // The key is read before any request, so a wrong one fails without touching Zalo. Never stored.
            let privateKey = null;
            try {
                if (opts.keyStdin || opts.keyPrompt) {
                    const text = opts.keyStdin
                        ? await readSecretFromStream()
                        : await promptSecret("The account's zCloud key (not shown): ");
                    privateKey = importCloudPrivateKey(text);
                }
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            await autoLogin(jsonMode);
            try {
                const blob = await fetchCloudBlob(getApi(), {
                    noiseId: row.noiseId,
                    encryptInfo: raw.encryptInfo ?? (row.encryptKey ? { encryptKey: row.encryptKey } : null),
                });
                let bytes = blob.bytes;
                let decrypted = false;
                let name = null;
                if (blob.encrypted) {
                    if (privateKey) {
                        bytes = decryptCloudBlob(blob.bytes, blob.wrappedKey, blob.algoVersion, privateKey);
                        decrypted = true;
                        const ext = raw.mediaInfo?.mediaExtInfo;
                        if (ext?.data && ext?.encryptInfo?.encryptKey) {
                            try {
                                const meta = decryptCloudInfo(ext.data, ext.encryptInfo.encryptKey, privateKey);
                                name = meta?.name || meta?.title || null;
                            } catch {
                                /* the name is a nicety; the file is written without it */
                            }
                        }
                    } else if (!opts.raw) {
                        error(
                            "This item is encrypted. Give the account's cloud key (--key-stdin or --key-prompt), or " +
                                "--raw to save it as downloaded.",
                        );
                        process.exit(1);
                    }
                }
                writeOut(bytes);
                output(
                    {
                        noiseId,
                        file: out,
                        bytes: bytes.length,
                        source: "cloud",
                        encrypted: blob.encrypted,
                        decrypted,
                        name,
                        verified: false,
                    },
                    jsonMode,
                    () => {
                        success(`Written: ${out} (${bytesText(bytes.length)})`);
                        if (blob.encrypted && !decrypted) warning("Saved encrypted, as downloaded (--raw).");
                        if (name) info(`Its name in the cloud: ${name}`);
                        if (selfChat) info("A My Cloud item: `sync-media` can also fetch it through its chat message.");
                    },
                );
            } catch (e) {
                error(`Download failed: ${e.message}`);
                process.exitCode = 1;
            } finally {
                privateKey = null;
            }
        });
    // It logs in itself, after the key was read: a wrong key fails before anything is sent.
    get.zaloLocalOnly = true;
    // Deleting is asked about first, as Zalo Web's confirm dialog does: --yes to act, --dry-run to preview. The action
    // settles it itself, after reading the plan (src/core/confirm-guard.js).
    guardSubcommand(cloud, "apply", "cloud.delete", { target: () => ({}), deferred: true, ownDryRun: true });
}
