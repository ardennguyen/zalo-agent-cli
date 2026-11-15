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
import { checkCli } from "../helpers/cli-fast.js";

const OWN = "301";
const options = { home: SANDBOX_HOME, timeout: 60_000 };
const accountDir = join(CONFIG_DIR, "accounts", OWN);
const argv = (args) => ["--account", OWN, "mcp", "webhook", ...args];
const parse = (r) => JSON.parse(stripAnsi(r.stdout).slice(stripAnsi(r.stdout).indexOf("{")));
// Each runs in the in-process CLI worker and hands its result to `check`; a check that fails there is re-run as a
// real child process (tests/helpers/cli-fast.js `checkCli`). The first test also spawns one real process.
const run = (args, check) => checkCli(argv(args), options, check);
const runJson = (args, check) => checkCli(["--json", ...argv(args)], options, (r) => check(parse(r)));

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
        // A real child process: the smoke check that the worker and a real process agree.
        const r = await runCli(argv(["status"]), options);
        assert.equal(r.code, 0);
        assert.match(stripAnsi(r.all), /no webhook outbox/);
        await runJson(["status"], (j) => {
            assert.equal(j.outbox, null);
            assert.equal(j.accountId, OWN);
        });
        await run(["list"], (again) => assert.match(stripAnsi(again.all), /no webhook outbox/));
        await runJson(["retry"], (j) => assert.equal(j.requeued ?? 0, 0));
    });

    it("status reports the backlog, the dead letters and the last error", async () => {
        seed();
        await runJson(["status"], (j) => {
            assert.equal(j.outbox.pending, 2);
            assert.equal(j.outbox.dead, 2);
            assert.equal(j.outbox.lastError, "HTTP 503");
            assert.equal(j.outbox.lastStatus, 503);
            assert.ok(j.outbox.oldestPendingAgeMs >= 0);
            assert.equal(j.daemon.running, false);
        });
        await run(["status"], (r) => {
            const text = stripAnsi(r.all);
            assert.match(text, /Queued: 2/);
            assert.match(text, /Dead-lettered: 2/);
            assert.match(text, /Last error: HTTP 503/);
            assert.match(text, /sent when `mcp start` \/ `listen` runs again/);
        });
    });

    it("list shows queued and dead events with their ids, and filters", async () => {
        seed();
        await runJson(["list"], (all) => {
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
        });
        await runJson(["list", "--dead"], (j) =>
            assert.deepEqual(
                j.events.map((e) => e.id),
                ["m3", "m4"],
            ),
        );
        await runJson(["list", "--pending", "-n", "1"], (j) =>
            assert.deepEqual(
                j.events.map((e) => e.id),
                ["m1"],
            ),
        );
        await run(["list", "--dead", "--pending"], (both) => {
            assert.equal(both.code, 1);
            assert.match(stripAnsi(both.stdout + both.stderr), /not both/);
        });
        await run(["list", "-n", "0"], (bad) => assert.equal(bad.code, 1));
    });

    it("retry puts one dead event back, then the rest; queued events are untouched", async () => {
        seed();
        const counts = (j) => [j.outbox.pending, j.outbox.dead];
        await runJson(["retry", "3"], (j) => assert.equal(j.requeued, 1));
        await runJson(["status"], (j) => assert.deepEqual(counts(j), [3, 1]));
        await runJson(["retry"], (j) => assert.equal(j.requeued, 1));
        await runJson(["status"], (j) => assert.deepEqual(counts(j), [4, 0]));
        await runJson(["retry"], (j) => assert.equal(j.requeued, 0));
        await run(["retry"], (r) => assert.match(stripAnsi(r.all), /No dead-lettered events/));
    });

    it("purge deletes dead events for good, one or all, and never a queued one", async () => {
        seed();
        await runJson(["purge", "4", "--yes"], (j) => assert.equal(j.deleted, 1));
        await runJson(["purge", "1", "--yes"], (j) => assert.equal(j.deleted, 0, "event 1 is queued, not dead"));
        await runJson(["purge", "--yes"], (j) => assert.equal(j.deleted, 1));
        await runJson(["status"], (j) => assert.deepEqual([j.outbox.pending, j.outbox.dead], [2, 0]));
    });

    it("rejects an event number that is not a positive integer", async () => {
        seed();
        for (const bad of ["abc", "0", "-1", "1.5"]) {
            await run(["retry", bad], (r) => {
                assert.equal(r.code, 1, bad);
                assert.match(stripAnsi(r.stdout + r.stderr), /Invalid event number/);
            });
        }
    });
});
