/**
 * Account jobs on the fleet controller (./src/core/fleet-jobs.js): each kind runs the exact CLI arguments, one job per
 * account, a host-wide cap, the `--json` result kept, a failure's error tail kept, cancel interrupts the child, and
 * every start and end goes out as a `job` event. A stand-in replaces the child process; nothing here runs the CLI.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createFleetController } from "../../src/core/fleet-controller.js";
import { buildControllerApp } from "../../src/core/fleet-serve.js";
import { JOB_KINDS, createFleetJobs, parseJobResult } from "../../src/core/fleet-jobs.js";

const A = "1000000000000000981";
const B = "1000000000000000982";
const C = "1000000000000000983";
const ADMIN = "admin-token-fedcba9876543210";
const servers = [];

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() =>
    servers.forEach((s) => {
        s.closeAllConnections?.();
        s.close();
    }),
);

/** A controller with jobs on a real server; each started child is a promise the test settles. */
async function rig({ maxRunning = 2 } = {}) {
    const started = [];
    const events = [];
    const jobs = createFleetJobs({
        startCli: (args) => {
            let settle;
            const done = new Promise((r) => (settle = r));
            const child = { args, settle, cancelled: false };
            started.push(child);
            return {
                done,
                cancel: () => {
                    child.cancelled = true;
                    settle({ code: 130, stdout: "", stderr: "interrupted" });
                },
            };
        },
        publish: (e) => events.push(e),
        maxRunning,
    });
    const controller = createFleetController({
        driver: {
            kind: "fake",
            start: async () => ({}),
            stop: async () => ({}),
            restart: async () => ({}),
            status: async () => ({}),
        },
        listAccounts: () => [A, B, C].map((ownId) => ({ ownId })),
        probe: async () => ({ running: false, pid: null, health: null }),
        relay: async () => null,
        runCli: async () => ({ code: 0, stdout: "{}", stderr: "" }),
        jobs,
        log: () => {},
    });
    const { app } = buildControllerApp({ controller, env: { ZALO_MCP_ADMIN_TOKEN: ADMIN }, log: () => {} });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/zalo/admin`;
    const call = async (path, { method = "GET", body } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${ADMIN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const settled = () => new Promise((r) => setImmediate(r));
    return { call, started, events, settled };
}

describe("parseJobResult", () => {
    it("reads the whole output as JSON, else its last JSON line, else nothing", () => {
        assert.deepEqual(parseJobResult('{"ok":true}'), { ok: true });
        assert.deepEqual(parseJobResult('progress\n{"a":1}\n{"b":2}\n'), { b: 2 });
        assert.equal(parseJobResult("no json here"), null);
        assert.equal(parseJobResult(""), null);
    });
});

describe("account jobs", () => {
    it("runs each kind with the exact CLI arguments for that account", async () => {
        const { call, started } = await rig({ maxRunning: 10 });
        assert.equal(
            (await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync", days: 7 } })).status,
            202,
        );
        assert.equal((await call(`/accounts/${B}/jobs`, { method: "POST", body: { kind: "sync-quick" } })).status, 202);
        assert.equal(
            (await call(`/accounts/${C}/jobs`, { method: "POST", body: { kind: "purge", dryRun: true } })).status,
            202,
        );
        assert.deepEqual(
            started.map((c) => c.args),
            [
                ["--json", "--account", A, "sync", "--days", "7"],
                ["--json", "--account", B, "sync", "--no-messages"],
                ["--json", "--account", C, "db", "purge", "--yes", "--dry-run"],
            ],
        );
        assert.deepEqual(JOB_KINDS["sync-media"]({}), ["sync-media"]);
    });

    it("keeps the result of a job that succeeds and the error tail of one that fails, with a job event for each", async () => {
        const { call, started, events, settled } = await rig();
        const ok = await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync-media" } });
        assert.equal(ok.body.state, "running");
        assert.equal(ok.body.phonePrompt, false);
        started[0].settle({ code: 0, stdout: 'downloading\n{"downloaded":3,"failed":0}\n', stderr: "" });
        await settled();
        const done = await call(`/accounts/${A}/jobs/${ok.body.id}`);
        assert.equal(done.body.state, "succeeded");
        assert.deepEqual(done.body.result, { downloaded: 3, failed: 0 });
        assert.equal(done.body.error, null);

        const bad = await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync" } });
        assert.equal(bad.body.phonePrompt, true);
        started[1].settle({ code: 1, stdout: "", stderr: "the phone did not confirm in time" });
        await settled();
        const failed = await call(`/accounts/${A}/jobs/${bad.body.id}`);
        assert.equal(failed.body.state, "failed");
        assert.equal(failed.body.exitCode, 1);
        assert.match(failed.body.error, /phone did not confirm/);

        assert.deepEqual(
            events.map((e) => [e.event, e.accountId, e.job.kind, e.job.state]),
            [
                ["job", A, "sync-media", "running"],
                ["job", A, "sync-media", "succeeded"],
                ["job", A, "sync", "running"],
                ["job", A, "sync", "failed"],
            ],
        );
        const list = await call(`/accounts/${A}/jobs`);
        assert.deepEqual(
            list.body.jobs.map((j) => j.kind),
            ["sync", "sync-media"],
        );
    });

    it("runs one job per account and at most the host's maximum, and refuses what it does not know", async () => {
        const { call, started, settled } = await rig({ maxRunning: 2 });
        assert.equal((await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "purge" } })).status, 202);
        const again = await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync-media" } });
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "JOB_RUNNING");
        assert.equal((await call(`/accounts/${B}/jobs`, { method: "POST", body: { kind: "purge" } })).status, 202);
        const busy = await call(`/accounts/${C}/jobs`, { method: "POST", body: { kind: "purge" } });
        assert.equal(busy.status, 429);
        assert.equal(busy.body.code, "JOBS_BUSY");
        started[0].settle({ code: 0, stdout: "{}", stderr: "" });
        await settled();
        assert.equal((await call(`/accounts/${C}/jobs`, { method: "POST", body: { kind: "purge" } })).status, 202);

        assert.equal(
            (await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "rm -rf" } })).body.code,
            "UNKNOWN_JOB",
        );
        assert.equal(
            (await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync", days: 0 } })).body.code,
            "INVALID_DAYS",
        );
        assert.equal(
            (await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "purge", days: 3 } })).body.code,
            "INVALID_DAYS",
        );
        assert.equal((await call(`/accounts/999/jobs`, { method: "POST", body: { kind: "purge" } })).status, 404);
        assert.equal((await call(`/accounts/${A}/jobs/nope!`)).body.code, "INVALID_JOB_ID");
        assert.equal((await call(`/accounts/${A}/jobs/abcdefghijkl`)).body.code, "JOB_NOT_FOUND");
    });

    it("cancel interrupts a running job and says the job ended when it already has", async () => {
        const { call, started, settled } = await rig();
        const j = await call(`/accounts/${A}/jobs`, { method: "POST", body: { kind: "sync" } });
        const c = await call(`/accounts/${A}/jobs/${j.body.id}/cancel`, { method: "POST" });
        assert.equal(c.status, 202);
        assert.equal(started[0].cancelled, true);
        await settled();
        const after = await call(`/accounts/${A}/jobs/${j.body.id}`);
        assert.equal(after.body.state, "cancelled");
        const again = await call(`/accounts/${A}/jobs/${j.body.id}/cancel`, { method: "POST" });
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "JOB_ENDED");
    });
});
