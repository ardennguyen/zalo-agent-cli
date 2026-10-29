/**
 * `zalo-agent mcp webhook ...` — look at, and act on, the durable webhook outbox
 * (src/core/webhook-outbox.js) of an account: how many events wait for the receiver, which were
 * dead-lettered and why. These read and write `accounts/<ownId>/webhook-outbox.db` directly; SQLite
 * lets them run beside the daemon that is delivering from it.
 */

import { existsSync } from "node:fs";
import { parseAccountId, selectDaemonAccount } from "../core/daemon-account.js";
import { getAccountDir } from "../core/credentials.js";
import { getDaemonStatus } from "../core/daemon-channel.js";
import { openOutbox, outboxPath } from "../core/webhook-outbox.js";
import { error, info, output, success } from "../utils/output.js";

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** @param {number} ms */
function age(ms) {
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
}

/**
 * @param {object} program - Commander root
 * @param {object} opts - The subcommand's options
 * @returns {{ ownId: string, accountDir: string }}
 */
function pickAccount(program, opts) {
    try {
        const requested = opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
        const acc = selectDaemonAccount(requested);
        return { ownId: acc.ownId, accountDir: getAccountDir(acc.ownId) };
    } catch (e) {
        error(`Account selection failed: ${e.message}`);
        process.exit(1);
    }
}

/**
 * Open the outbox, or say plainly that this account has none yet.
 * @param {string} accountDir
 * @param {boolean} readonly
 * @returns {object|null}
 */
function openOrNone(accountDir, readonly) {
    if (!existsSync(outboxPath(accountDir))) return null;
    try {
        return openOutbox(accountDir, { readonly });
    } catch (e) {
        error(`Could not open the webhook outbox: ${e.message}`);
        process.exit(1);
    }
}

const NO_OUTBOX =
    "This account has no webhook outbox: no event has been queued for a webhook yet (-w / ZALO_WEBHOOK_URL).";

/**
 * @param {object} mcp - The `mcp` Commander command
 * @param {object} program - Commander root, for the global --json / --account
 */
export function registerMCPWebhookCommands(mcp, program) {
    const webhook = mcp
        .command("webhook")
        .description("Inspect and manage the durable webhook outbox: events waiting for the receiver and dead letters");

    webhook
        .command("status")
        .description("Backlog of the webhook outbox: queued, dead-lettered, oldest wait, last success and error")
        .option("--account <id>", "Target a specific registered account ID (default: active account)", parseAccountId)
        .action((opts) => {
            const { ownId, accountDir } = pickAccount(program, opts);
            const daemon = getDaemonStatus(accountDir);
            const outbox = openOrNone(accountDir, true);
            const stats = outbox?.stats() ?? null;
            outbox?.close();
            const result = {
                accountId: ownId,
                daemon: { running: daemon.running, pid: daemon.pid },
                outbox: stats && {
                    path: outboxPath(accountDir),
                    pending: stats.pending,
                    dead: stats.dead,
                    oldestPendingAt: iso(stats.oldestPendingAt),
                    oldestPendingAgeMs: stats.oldestPendingAt ? Math.max(0, Date.now() - stats.oldestPendingAt) : 0,
                    deliveredTotal: stats.deliveredTotal,
                    lastSuccessAt: iso(stats.lastSuccessAt),
                    lastError: stats.lastError,
                    lastErrorAt: iso(stats.lastErrorAt),
                    lastStatus: stats.lastStatus,
                },
            };
            output(result, program.opts().json, () => {
                if (!stats) return info(NO_OUTBOX);
                const o = result.outbox;
                info(`Account ${ownId}  daemon: ${daemon.running ? `running (pid ${daemon.pid})` : "not running"}`);
                info(`Queued: ${o.pending}${o.pending ? `  (oldest waiting ${age(o.oldestPendingAgeMs)})` : ""}`);
                info(`Dead-lettered: ${o.dead}${o.dead ? "  (zalo-agent mcp webhook list --dead)" : ""}`);
                info(`Delivered since the outbox was created: ${o.deliveredTotal}`);
                info(`Last delivery: ${o.lastSuccessAt ?? "never"}`);
                if (o.lastError) info(`Last error: ${o.lastError}${o.lastErrorAt ? `  at ${o.lastErrorAt}` : ""}`);
                if (o.pending && !daemon.running)
                    info("Queued events are sent when `mcp start` / `listen` runs again.");
            });
        });

    webhook
        .command("list")
        .description("List queued events, or the dead letters, oldest first")
        .option("--account <id>", "Target a specific registered account ID (default: active account)", parseAccountId)
        .option("--dead", "Only dead-lettered events")
        .option("--pending", "Only events still queued")
        .option("-n, --limit <n>", "Maximum rows (default: 50)", "50")
        .action((opts) => {
            const limit = Number(opts.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
                error(`Invalid --limit "${opts.limit}": must be an integer between 1 and 1000.`);
                process.exit(1);
            }
            if (opts.dead && opts.pending) {
                error("Pass --dead or --pending, not both.");
                process.exit(1);
            }
            const { ownId, accountDir } = pickAccount(program, opts);
            const outbox = openOrNone(accountDir, true);
            const rows = (
                outbox?.list({ status: opts.dead ? "dead" : opts.pending ? "pending" : undefined, limit }) ?? []
            ).map((r) => {
                let event = {};
                try {
                    event = JSON.parse(r.body);
                } catch {
                    /* a row the receiver gets as-is; shown without fields */
                }
                return {
                    seq: r.seq,
                    status: r.status,
                    attempts: r.attempts,
                    queuedAt: iso(r.created_at),
                    lastAttemptAt: iso(r.last_attempt_at),
                    lastError: r.last_error,
                    event: event.event ?? null,
                    id: event.msgId ?? event.id ?? null, // an event queued by an older version has only `id`
                    threadId: event.threadId ?? null,
                };
            });
            outbox?.close();
            output({ accountId: ownId, count: rows.length, events: rows }, program.opts().json, () => {
                if (!outbox) return info(NO_OUTBOX);
                if (!rows.length) return info("Nothing queued.");
                for (const r of rows) {
                    info(
                        `#${r.seq} ${r.status} attempts=${r.attempts} ${r.event ?? "?"} id=${r.id ?? "-"} thread=${r.threadId ?? "-"} queued ${r.queuedAt}${r.lastError ? `  — ${r.lastError}` : ""}`,
                    );
                }
            });
        });

    for (const [name, verb, description] of [
        [
            "retry",
            "requeued",
            "Put dead-lettered events back in the queue (all, or one by number); the daemon sends them within 30 seconds",
        ],
        ["purge", "deleted", "Delete dead-lettered events for good (all, or one by number)"],
    ]) {
        webhook
            .command(`${name} [seq]`)
            .description(description)
            .option(
                "--account <id>",
                "Target a specific registered account ID (default: active account)",
                parseAccountId,
            )
            .action((seqArg, opts) => {
                let seq;
                if (seqArg !== undefined) {
                    seq = Number(seqArg);
                    if (!Number.isInteger(seq) || seq < 1) {
                        error(`Invalid event number "${seqArg}": use the # from \`mcp webhook list --dead\`.`);
                        process.exit(1);
                    }
                }
                const { ownId, accountDir } = pickAccount(program, opts);
                const outbox = openOrNone(accountDir, false);
                const n = !outbox ? 0 : name === "retry" ? outbox.retryDead({ seq }) : outbox.purgeDead({ seq });
                outbox?.close();
                output({ accountId: ownId, [verb]: n }, program.opts().json, () => {
                    if (!outbox) info(NO_OUTBOX);
                    else if (n) success(`${n} dead-lettered event(s) ${verb}.`);
                    else info(seq ? `No dead-lettered event #${seq}.` : "No dead-lettered events.");
                });
            });
    }
}
