/**
 * `zalo-agent mcp webhook status|list|retry|purge` against a throwaway account: what the backlog
 * commands print, that --json is JSON, and that retry/purge change exactly what they say.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { openOutbox } from "../../src/core/webhook-outbox.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const OWN = "301";
const options = { home: SANDBOX_HOME, timeout: 60_000 };
const accountDir = join(CONFIG_DIR, "accounts", OWN);
const run = (...args) => runCli(["--account", OWN, "mcp", "webhook", ...args], options);
const runJson = async (...args) => {
    const r = await runCli(["--json", "--account", OWN, "mcp", "webhook", ...args], options);
    return JSON.parse(stripAnsi(r.stdout).slice(stripAnsi(r.stdout).indexOf("{")));
};

before(() => assertSandboxed(CONFIG_DIR));

beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify([{ ownId: OWN, name: "Example", proxy: null, active: true }]),
    );
    rmSync(accountDir, { recursive: true, force: true });
});

/** Seed an outbox: m1 queued, m2 queued, m3 + m4 dead. */
function seed() {
    const o = openOutbox(accountDir);
    for (const n of [1, 2, 3, 4]) {
        o.enqueue(`message:m${n}`, JSON.stringify({ event: "message", id: `m${n}`, threadId: "t1" }));
    }
    o.markFailed([1], { error: "HTTP 503", status: 503 });
    o.markDead([3, 4], "rejected by the receiver: HTTP 422");
    o.close();
}

describe("mcp webhook", () => {
    it("says plainly that an account with no webhook has no outbox, and does not create one", async () => {
        const r = await run("status");
        assert.equal(r.code, 0);
        assert.match(stripAnsi(r.all), /no webhook outbox/);
        const j = await runJson("status");
        assert.equal(j.outbox, null);
        assert.equal(j.accountId, OWN);
        const again = await run("list");
        assert.match(stripAnsi(again.all), /no webhook outbox/);
        assert.equal((await runJson("retry")).requeued ?? 0, 0);
    });

    it("status reports the backlog, the dead letters and the last error", async () => {
        seed();
        const j = await runJson("status");
        assert.equal(j.outbox.pending, 2);
        assert.equal(j.outbox.dead, 2);
        assert.equal(j.outbox.lastError, "HTTP 503");
        assert.equal(j.outbox.lastStatus, 503);
        assert.ok(j.outbox.oldestPendingAgeMs >= 0);
        assert.equal(j.daemon.running, false);
        const text = stripAnsi((await run("status")).all);
        assert.match(text, /Queued: 2/);
        assert.match(text, /Dead-lettered: 2/);
        assert.match(text, /Last error: HTTP 503/);
        assert.match(text, /sent when `mcp start` \/ `listen` runs again/);
    });

    it("list shows queued and dead events with their ids, and filters", async () => {
        seed();
        const all = await runJson("list");
        assert.deepEqual(
            all.events.map((e) => [e.seq, e.status, e.id]),
            [
                [1, "pending", "m1"],
                [2, "pending", "m2"],
                [3, "dead", "m3"],
                [4, "dead", "m4"],
            ],
        );
        assert.equal(all.events[0].attempts, 1);
        assert.equal(all.events[2].lastError, "rejected by the receiver: HTTP 422");
        assert.deepEqual(
            (await runJson("list", "--dead")).events.map((e) => e.id),
            ["m3", "m4"],
        );
        assert.deepEqual(
            (await runJson("list", "--pending", "-n", "1")).events.map((e) => e.id),
            ["m1"],
        );
        const both = await run("list", "--dead", "--pending");
        assert.equal(both.code, 1);
        assert.match(stripAnsi(both.stdout + both.stderr), /not both/);
        const bad = await run("list", "-n", "0");
        assert.equal(bad.code, 1);
    });

    it("retry puts one dead event back, then the rest; queued events are untouched", async () => {
        seed();
        assert.equal((await runJson("retry", "3")).requeued, 1);
        let s = (await runJson("status")).outbox;
        assert.deepEqual([s.pending, s.dead], [3, 1]);
        assert.equal((await runJson("retry")).requeued, 1);
        s = (await runJson("status")).outbox;
        assert.deepEqual([s.pending, s.dead], [4, 0]);
        assert.equal((await runJson("retry")).requeued, 0);
        const none = stripAnsi((await run("retry")).all);
        assert.match(none, /No dead-lettered events/);
    });

    it("purge deletes dead events for good, one or all, and never a queued one", async () => {
        seed();
        assert.equal((await runJson("purge", "4")).deleted, 1);
        assert.equal((await runJson("purge", "1")).deleted, 0, "event 1 is queued, not dead");
        assert.equal((await runJson("purge")).deleted, 1);
        const s = (await runJson("status")).outbox;
        assert.deepEqual([s.pending, s.dead], [2, 0]);
    });

    it("rejects an event number that is not a positive integer", async () => {
        seed();
        for (const bad of ["abc", "0", "-1", "1.5"]) {
            const r = await run("retry", bad);
            assert.equal(r.code, 1, bad);
            assert.match(stripAnsi(r.stdout + r.stderr), /Invalid event number/);
        }
    });
});
