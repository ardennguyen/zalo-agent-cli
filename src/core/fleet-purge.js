/**
 * `fleet purge`: the quota/retention purge (src/core/storage-quota.js) for every account on this machine, for a
 * systemd timer or cron job. An account's daemon runs that purge on its own timer (`retention.purgeEvery`); this
 * covers the accounts it cannot:
 *
 * - **No daemon running:** the same pass `db purge` runs, here, under the account's `daemon.lock` (one writer). It
 *   purges only what is due (an age rule, a grace period that has ended) and steps the quota clock, so the grace
 *   period of a stopped account runs too.
 * - **A daemon running whose last pass is older than `purgeEvery` × 2** (or that never recorded one): it is asked over
 *   its channel (`/purge`) to run the pass now. A daemon that checked in time is left alone.
 *
 * `--dry-run` counts and changes nothing, and takes no lock.
 */
import { existsSync } from "node:fs";
import { getAccountDbPath, getAccountDir } from "./credentials.js";
import { callViaDaemon, getDaemonStatus } from "./daemon-channel.js";
import { closeDb, initDb } from "./db.js";
import { acquireLock, releaseLock } from "./lock.js";
import { readQuotaState, resolveRetention, runStoragePass } from "./storage-quota.js";
import { purgeDeadDeliveries } from "./webhook-outbox.js";

/** What a pass report comes to, in a line's worth of numbers. */
export function purgeSummary(report) {
    const r = report ?? {};
    return {
        mediaFiles: (r.retention?.media?.files ?? 0) + (r.quota?.media?.files ?? 0),
        messages: (r.retention?.messages?.rows ?? 0) + (r.quota?.messages?.rows ?? 0),
        outboxDead: r.retention?.outboxDead ?? 0,
        goneGroups: r.goneGroups?.groups ?? 0,
        goneGroupMessages: r.goneGroups?.messages ?? 0,
        usedBefore: r.usageBefore?.total ?? null,
        usedAfter: r.dryRun ? null : (r.state?.usage?.total ?? null),
        events: (r.events ?? []).map((e) => e.level),
    };
}

/**
 * Whether a running daemon's own timer is behind: its last pass is older than twice its interval, or unrecorded.
 *
 * @param {string} ownId
 * @param {number} now
 * @returns {{stale: boolean, lastPassAt: string|null, everyMs: number}}
 */
export function daemonPassStale(ownId, now = Date.now()) {
    const everyMs = resolveRetention(ownId).purgeEveryMs;
    const lastPassAt = readQuotaState(getAccountDir(ownId)).lastPass?.at ?? null;
    const at = lastPassAt ? Date.parse(lastPassAt) : NaN;
    return { stale: !Number.isFinite(at) || now - at > everyMs * 2, lastPassAt, everyMs };
}

/**
 * Run the purge for each account, one at a time.
 *
 * @param {object} args
 * @param {string[]} args.accounts - account ids
 * @param {boolean} [args.dryRun]
 * @param {number} [args.now]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<Array<{accountId: string, action: "purged"|"counted"|"asked-daemon"|"skipped"|"failed",
 *   via: "local"|"daemon"|null, detail: string, summary?: object, error?: string}>>}
 */
export async function fleetPurge({ accounts, dryRun = false, now = Date.now(), log = () => {} }) {
    const results = [];
    for (const ownId of accounts) {
        const accountDir = getAccountDir(ownId);
        const daemon = getDaemonStatus(accountDir);
        if (daemon.running) {
            const s = daemonPassStale(ownId, now);
            if (!s.stale) {
                results.push({
                    accountId: ownId,
                    action: "skipped",
                    via: null,
                    detail: `its daemon (pid ${daemon.pid}) purges on its own: last check ${s.lastPassAt}`,
                });
                continue;
            }
            log(`${ownId}: its daemon has not checked since ${s.lastPassAt ?? "it started"}; asking it`);
            const via = await callViaDaemon(accountDir, "/purge", { dryRun }, { timeoutMs: 600_000 });
            if (!via || !via.ok) {
                results.push({
                    accountId: ownId,
                    action: "failed",
                    via: "daemon",
                    detail: "its daemon did not run the purge",
                    error: via?.error ?? "the daemon does not answer on its channel",
                });
                continue;
            }
            results.push({
                accountId: ownId,
                action: dryRun ? "counted" : "asked-daemon",
                via: "daemon",
                detail: dryRun ? "counted by its daemon" : "purged by its daemon",
                summary: purgeSummary(via.report),
            });
            continue;
        }
        const file = getAccountDbPath(ownId);
        if (!existsSync(file)) {
            results.push({ accountId: ownId, action: "skipped", via: null, detail: "no message database here" });
            continue;
        }
        if (!dryRun && !acquireLock(accountDir)) {
            results.push({
                accountId: ownId,
                action: "failed",
                via: "local",
                detail: "the account is held by another process",
                error: "daemon.lock is held (a daemon starting, or another purge)",
            });
            continue;
        }
        try {
            initDb(file);
            const report = runStoragePass({
                ownId,
                dryRun,
                now,
                log,
                purgeOutboxDead: (cutoff) => purgeDeadDeliveries(accountDir, cutoff),
            });
            results.push({
                accountId: ownId,
                action: dryRun ? "counted" : "purged",
                via: "local",
                detail: dryRun ? "counted here (no daemon runs)" : "purged here under daemon.lock (no daemon runs)",
                summary: purgeSummary(report),
            });
        } catch (e) {
            results.push({
                accountId: ownId,
                action: "failed",
                via: "local",
                detail: "the pass failed",
                error: e.message,
            });
        } finally {
            closeDb();
            if (!dryRun) releaseLock(accountDir);
        }
    }
    return results;
}
