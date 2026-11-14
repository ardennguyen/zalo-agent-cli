/**
 * `fleet purge` (src/core/fleet-purge.js), the purge a systemd timer or cron runs for every account on the machine:
 * - an account with no daemon is purged here, under its daemon.lock (taken and released), by the same pass `db purge`
 *   runs: only what its rules make due goes, and the pass is recorded (`lastPass`) so the quota clock moves;
 * - `--dry-run` counts, deletes nothing, takes no lock and records nothing;
 * - a running daemon that checked within purgeEvery × 2 is left alone; one that has not is asked over its channel;
 * - a daemon that does not answer is a failure, not a purge beside it.
 *
 * Red if a stopped account's due rows survive, if a dry run deletes or locks, if a running daemon is bypassed (a second
 * writer), or if a timely daemon is asked anyway.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, getMessageById, initDb, insertMessage } from "../../src/core/db.js";
import { applyPolicy } from "../../src/core/policy-store.js";
import { readQuotaState } from "../../src/core/storage-quota.js";
import { startDaemonChannel } from "../../src/core/daemon-channel.js";
import { daemonPassStale, fleetPurge } from "../../src/core/fleet-purge.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 8);
let n = 0;
const freshId = () => String(1000000000000000950n + BigInt(n++));

/** An account with 40 messages a day apart (the oldest 40 days back) and `retention.messages: 30d`; db closed. */
function account() {
    const id = freshId();
    const dir = getAccountDir(id);
    mkdirSync(dir, { recursive: true });
    initDb(getAccountDbPath(id));
    for (let i = 0; i < 40; i++) {
        insertMessage({
            msgId: `m${i}`,
            threadId: "t1",
            senderId: "1",
            text: `marker-${i}`,
            timestamp: NOW - (40 - i) * DAY,
            type: "text",
        });
    }
    closeDb();
    applyPolicy({
        target: { kind: "account", id },
        op: "put",
        policy: { retention: { messages: "30d" } },
        actor: "test",
    });
    return { id, dir };
}

/** Whether a message is still in an account's cache. */
function has({ id }, msgId) {
    initDb(getAccountDbPath(id));
    try {
        return Boolean(getMessageById(msgId));
    } finally {
        closeDb();
    }
}

const lastPassAt = (dir, at) =>
    writeFileSync(
        join(dir, "quota-state.json"),
        JSON.stringify({ usage: null, account: {}, tenants: {}, lastPass: { at: new Date(at).toISOString() } }),
    );

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("fleet purge: an account with no daemon", () => {
    it("--dry-run counts what is due, deletes nothing, takes no lock and records no pass", async () => {
        const a = account();
        const [r] = await fleetPurge({ accounts: [a.id], dryRun: true, now: NOW });
        assert.equal(r.action, "counted");
        assert.equal(r.via, "local");
        assert.equal(r.summary.messages, 11);
        assert.equal(has(a, "m0"), true);
        assert.equal(existsSync(join(a.dir, "daemon.lock")), false);
        assert.equal(readQuotaState(a.dir).lastPass, null);
    });

    it("purges what is due here, under its lock (released after), and records the pass", async () => {
        const a = account();
        const [r] = await fleetPurge({ accounts: [a.id], now: NOW });
        assert.equal(r.action, "purged", JSON.stringify(r));
        assert.equal(r.summary.messages, 11);
        assert.equal(has(a, "m0"), false, "past 30 days: gone");
        assert.equal(has(a, "m39"), true, "recent: kept");
        assert.equal(existsSync(join(a.dir, "daemon.lock")), false, "the lock is released");
        assert.equal(readQuotaState(a.dir).lastPass.at, new Date(NOW).toISOString());
    });

    it("an account with no database is skipped", async () => {
        const id = freshId();
        mkdirSync(getAccountDir(id), { recursive: true });
        const [r] = await fleetPurge({ accounts: [id], now: NOW });
        assert.equal(r.action, "skipped");
    });
});

describe("fleet purge: an account whose daemon runs", () => {
    /** A daemon channel for the account that runs no pass itself but records whether it was asked. */
    async function daemon(a) {
        const asked = [];
        const channel = await startDaemonChannel({
            getApi: () => null,
            accountDir: a.dir,
            onPurge: ({ dryRun }) => {
                asked.push(dryRun);
                return { report: { dryRun, retention: { messages: { rows: 7 } }, quota: {}, events: [] } };
            },
        });
        return { asked, channel };
    }

    it("a daemon that checked within purgeEvery x 2 is left alone, and nothing is purged beside it", async () => {
        const a = account();
        lastPassAt(a.dir, NOW - HOUR);
        const d = await daemon(a);
        try {
            const [r] = await fleetPurge({ accounts: [a.id], now: NOW });
            assert.equal(r.action, "skipped", JSON.stringify(r));
            assert.deepEqual(d.asked, []);
            assert.equal(has(a, "m0"), true, "no second writer");
        } finally {
            d.channel.stop();
        }
    });

    it("a daemon behind its timer (or with no pass recorded) is asked over its channel to run it", async () => {
        const a = account();
        lastPassAt(a.dir, NOW - 13 * HOUR);
        assert.equal(daemonPassStale(a.id, NOW).stale, true, "6h x 2 = 12h");
        const d = await daemon(a);
        try {
            const [r] = await fleetPurge({ accounts: [a.id], now: NOW });
            assert.equal(r.action, "asked-daemon", JSON.stringify(r));
            assert.equal(r.via, "daemon");
            assert.equal(r.summary.messages, 7);
            assert.deepEqual(d.asked, [false]);
            assert.equal(has(a, "m0"), true, "the daemon (here a stand-in) is the one writer");
            const [dry] = await fleetPurge({ accounts: [a.id], dryRun: true, now: NOW });
            assert.equal(dry.action, "counted");
            assert.deepEqual(d.asked, [false, true]);
        } finally {
            d.channel.stop();
        }
    });

    it("a daemon that holds the lock but does not answer is a failure; nothing is purged beside it", async () => {
        const a = account();
        writeFileSync(join(a.dir, "daemon.lock"), String(process.pid));
        const [r] = await fleetPurge({ accounts: [a.id], now: NOW });
        assert.equal(r.action, "failed");
        assert.match(r.error, /does not answer/);
        assert.equal(has(a, "m0"), true);
    });
});
