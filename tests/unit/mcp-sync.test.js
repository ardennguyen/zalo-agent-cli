import { assertSandboxed } from "../helpers/sandbox.js";
import { it, mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createStageLock } from "../../src/core/daemon-channel.js";
import { createSyncRunners } from "../../src/core/daemon-sync.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { createSyncJobs } from "../../src/mcp/sync-jobs.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

assertSandboxed(CONFIG_DIR);

function fixture() {
    const lock = createStageLock();
    const calls = [];
    let finish, fail, progress;
    const runner = (params, event) => {
        calls.push(params);
        progress = event;
        return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
    };
    const jobs = createSyncJobs({ runners: { messages: runner, reactions: runner }, lock });
    return {
        lock,
        calls,
        jobs,
        finish: (value) => finish(value),
        fail: (value) => fail(value),
        progress: (value) => progress(value),
    };
}

function tools(jobs) {
    const registered = new Map();
    registerTools(
        { registerTool: (name, meta, handler) => registered.set(name, { meta, handler }) },
        {},
        {},
        {},
        {},
        null,
        undefined,
        undefined,
        jobs,
    );
    return {
        registered,
        call: (name, args) => {
            const { meta, handler } = registered.get(name);
            return handler(meta.inputSchema.parse(args));
        },
    };
}
const payload = (response) => JSON.parse(response.content[0].text);
const request = { requestId: "restore-1", stage: "messages", days: 7 };

it("returns a running job before a long phone restore settles, with forwarded parameters", async () => {
    const f = fixture();
    const started = f.jobs.start(request);
    assert.equal(started.state, "running");
    assert.equal(started.phoneConfirmationRequired, true);
    assert.equal(f.lock.current().stage, "mcp-sync:messages");
    await tick();
    assert.deepEqual(f.calls, [{ days: 7 }]);
    f.progress({ phase: "confirm", detail: "Tap your phone" });
    assert.equal(f.jobs.status(started.jobId).events[0].phase, "confirm");
    f.finish({ reason: "complete", messagesSaved: 3 });
    await tick();
    const final = f.jobs.status(started.jobId);
    assert.equal(final.state, "completed");
    assert.deepEqual(final.result, { reason: "complete", messagesSaved: 3 });
    assert.ok(final.finishedAt >= started.startedAt);
    assert.equal(f.lock.current(), null);
});

it("same request retry does not prompt again, even after completion or with reordered params", async () => {
    const f = fixture();
    const started = f.jobs.start({ ...request, waitMs: 30000 });
    await tick();
    assert.equal(
        f.jobs.start({ waitMs: 30000, days: 7, stage: "messages", requestId: "restore-1" }).jobId,
        started.jobId,
    );
    f.finish({ reason: "complete" });
    await tick();
    assert.equal(f.jobs.start({ ...request, waitMs: 30000 }).jobId, started.jobId);
    assert.equal(f.calls.length, 1);
    assert.throws(() => f.jobs.start({ ...request, days: 8 }), /different sync request/);
});

it("MCP, CLI channel stages, history and self-heal share the same exclusion lock", async () => {
    const f = fixture();
    const release = f.lock.tryAcquire("history");
    assert.throws(() => f.jobs.start(request), /busy \(history\)/);
    assert.equal(f.calls.length, 0);
    release();
    f.jobs.start(request);
    assert.equal(f.lock.tryAcquire("messages"), null);
    assert.throws(() => f.jobs.start({ ...request, requestId: "other" }), /busy/);
    await tick();
    f.finish({ reason: "complete" });
    await tick();
    const after = f.lock.tryAcquire("self-heal");
    assert.equal(typeof after, "function");
    after();
});

for (const reason of ["partial", "timeout", "socket-lost", "no-conversations"]) {
    it(`retains ${reason} outcome rather than reporting a complete restore`, async () => {
        const f = fixture();
        f.jobs.start(request);
        await tick();
        f.finish({ reason, confirmed: false, messagesSaved: 0 });
        await tick();
        assert.deepEqual(f.jobs.status().result, { reason, confirmed: false, messagesSaved: 0 });
    });
}

it("runner failures are observable and release the lock; status does not retry", async () => {
    const f = fixture();
    f.jobs.start(request);
    await tick();
    f.fail(new Error("session unavailable"));
    await tick();
    assert.equal(f.jobs.status().state, "failed");
    assert.equal(f.jobs.status().error, "session unavailable");
    assert.equal(f.jobs.status().state, "failed");
    assert.equal(f.calls.length, 1);
    assert.equal(f.lock.current(), null);
});

it("a non-Error rejection is recorded without an unhandled rejection", async () => {
    const f = fixture();
    f.jobs.start(request);
    await tick();
    f.fail(null);
    await tick();
    assert.equal(f.jobs.status().state, "failed");
    assert.equal(f.jobs.status().error, "null");
    assert.equal(f.lock.current(), null);
});

it("retains bounded progress and returns immutable snapshots", async () => {
    const f = fixture();
    const start = f.jobs.start(request);
    start.params.days = 99;
    await tick();
    for (let i = 0; i < 100; i++) f.progress({ phase: "progress", detail: String(i) });
    const status = f.jobs.status();
    assert.equal(status.params.days, 7);
    assert.equal(status.events.length, 20);
    assert.equal(status.events[0].detail, "80");
    status.events.length = 0;
    assert.equal(f.jobs.status().events.length, 20);
    f.finish({ reason: "complete" });
    await tick();
});

it("ten-job retention, account isolation and restart loss are explicit", async () => {
    const f = fixture();
    const first = f.jobs.start(request);
    await tick();
    f.finish({});
    await tick();
    for (let i = 0; i < 10; i++) {
        f.jobs.start({ ...request, requestId: `next-${i}` });
        await tick();
        f.finish({});
        await tick();
    }
    assert.throws(() => f.jobs.status(first.jobId), /Unknown or expired/);
    const another = fixture();
    assert.deepEqual(another.jobs.status(), { state: "idle" });
    assert.throws(() => another.jobs.status(f.jobs.status().jobId), /Unknown or expired/);
});

it("reaction jobs forward removal control and need no phone restore", async () => {
    const f = fixture();
    const api = tools(f.jobs);
    const start = payload(
        await api.call("zalo_sync", { requestId: "reactions-1", stage: "reactions", applyRemovals: false }),
    );
    assert.equal(start.phoneConfirmationRequired, false);
    await tick();
    assert.deepEqual(f.calls, [{ applyRemovals: false }]);
    f.finish({ placed: 2, socketAlive: true });
    await tick();
    assert.equal(payload(await api.call("zalo_sync_status", { jobId: start.jobId })).result.placed, 2);
});

for (const invalid of [
    {},
    { requestId: "" },
    { requestId: "a", days: 0 },
    { requestId: "a", days: 1, from: "2026-10-01" },
    { requestId: "a", from: "2026-02-30" },
    { requestId: "a", from: "yesterday" },
    { requestId: "a", stage: "reactions", days: 1 },
    { requestId: "a", applyRemovals: false },
    { requestId: "a", waitMs: 1 },
    { requestId: "a", waitMs: 600001 },
    { requestId: "a", stage: "shell" },
    { requestId: "a", account: "101" },
]) {
    it(`refuses invalid sync parameters: ${JSON.stringify(invalid)}`, () => {
        const f = fixture();
        assert.throws(() => tools(f.jobs).call("zalo_sync", invalid));
        assert.equal(f.calls.length, 0);
        assert.equal(f.lock.current(), null);
    });
}

it("unknown jobs and unavailable tracker return MCP errors, never a new sync", async () => {
    const f = fixture();
    const unknown = await tools(f.jobs).call("zalo_sync_status", { jobId: "00000000-0000-4000-8000-000000000001" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown or expired/);
    for (const name of ["zalo_sync", "zalo_sync_status"]) {
        const result = await tools(undefined).call(name, name === "zalo_sync" ? request : {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Sync is unavailable/);
    }
    assert.equal(f.calls.length, 0);
});

it("shared runners resolve the current API after reconnect and never acquire a second socket", async (t) => {
    let api = { listener: { ws: { readyState: 1 } }, generation: 1 };
    const seen = [];
    const restore = mock.method(SyncV2.prototype, "restore", async function (params) {
        seen.push({ api: this.api, account: this.accountName, params });
        return { reason: "complete" };
    });
    t.after(() => restore.mock.restore());
    const jobs = createSyncJobs({
        runners: createSyncRunners({ getApi: () => api, accountName: "101" }),
        lock: createStageLock(),
    });
    jobs.start(request);
    await tick();
    const previous = api;
    api = { listener: { ws: { readyState: 1 } }, generation: 2 };
    jobs.start({ ...request, requestId: "after-reconnect" });
    await tick();
    assert.equal(seen[0].api, previous);
    assert.equal(seen[1].api, api);
    assert.equal(seen[1].account, "101");
    assert.equal(seen[1].params.liveStore, false);
    assert.equal(seen[1].params.keepAlive, true);
    // A reconnect that only waits for the daemon's own recovery (daemon-sync.js): it never opens a socket itself.
    assert.equal(typeof seen[1].params.reconnect, "function");
    assert.equal(seen[1].params.maxResumes, 3, "a daemon allows more resumes than the CLI's one");
});

it("the messages runner hands the cancel signal of the channel to the restore", async (t) => {
    const seen = [];
    const restore = mock.method(SyncV2.prototype, "restore", async function (params) {
        seen.push(params.signal);
        return { reason: "cancelled" };
    });
    t.after(() => restore.mock.restore());
    const runners = createSyncRunners({
        getApi: () => ({ listener: { ws: { readyState: 1 } } }),
        accountName: "101",
    });
    const controller = new AbortController();
    await runners.messages({}, () => {}, controller.signal);
    assert.equal(seen[0], controller.signal, "a cancel from the CLI must reach the restore, or Ctrl+C stops nothing");
});

it("SDK tools/call validates refinements and tracks async work across separate calls", async (t) => {
    const f = fixture();
    const server = new McpServer({ name: "sync-test", version: "1" });
    registerTools(server, {}, {}, {}, {}, null, undefined, f.lock, f.jobs);
    const client = new Client({ name: "test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
    });
    const list = await client.listTools();
    assert.ok(list.tools.some((tool) => tool.name === "zalo_sync"));
    const invalid = await client.callTool({
        name: "zalo_sync",
        arguments: { requestId: "invalid", days: 1, from: "2026-10-01" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(f.calls.length, 0);
    const start = payload(await client.callTool({ name: "zalo_sync", arguments: request }));
    await tick();
    f.finish({ reason: "complete", messagesSaved: 4 });
    await tick();
    const status = payload(await client.callTool({ name: "zalo_sync_status", arguments: { jobId: start.jobId } }));
    assert.equal(status.result.messagesSaved, 4);
});

it("stateless HTTP requests share one job tracker after the start response closes", async (t) => {
    const f = fixture();
    const server = createHTTPServer(
        registerTools,
        { api: {}, buffer: {}, filter: {}, config: {}, stageLock: f.lock, syncJobs: f.jobs },
        0,
        "test-token",
    );
    t.after(() => new Promise((resolve) => server.close(resolve)));
    if (!server.listening) await once(server, "listening");
    let id = 0;
    const call = async (name, args) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
            method: "POST",
            headers: {
                Authorization: "Bearer test-token",
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
        });
        assert.equal(response.status, 200);
        const wire = await response.text();
        const data = wire.split("\n").find((line) => line.startsWith("data: "));
        const rpc = JSON.parse(data ? data.slice(6) : wire);
        assert.ok(!rpc.error, JSON.stringify(rpc));
        return payload(rpc.result);
    };
    const start = await call("zalo_sync", request);
    assert.equal(start.state, "running");
    await tick();
    const retry = await call("zalo_sync", request);
    assert.equal(retry.jobId, start.jobId);
    assert.equal(f.calls.length, 1);
    f.finish({ reason: "partial", messagesSaved: 2 });
    await tick();
    const status = await call("zalo_sync_status", { jobId: start.jobId });
    assert.equal(status.state, "completed");
    assert.equal(status.result.reason, "partial");
    assert.equal(status.result.messagesSaved, 2);
});

it("real stdio transport returns a tracked sync job without polluting JSON-RPC stdout", async (t) => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("./support/mcp-sync-server.js", import.meta.url))],
        stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    t.after(() => client.close());
    const start = payload(await client.callTool({ name: "zalo_sync", arguments: request }));
    const result = payload(await client.callTool({ name: "zalo_sync_status", arguments: { jobId: start.jobId } }));
    assert.equal(result.state, "completed");
    assert.equal(result.result.messagesSaved, 5);
    assert.equal(result.result.days, 7);
});
