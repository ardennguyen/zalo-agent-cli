/**
 * A restore that loses its socket mid-run, inside a daemon.
 *
 * Close code 1006 carries no close frame and is not on the server's own list of
 * codes to retry, so nothing retries it for a stage. In the CLI the restore
 * reopens the socket itself and re-requests the batches that never arrived. In
 * a daemon it used to end as a partial restore -- `listen` and `mcp` answer a
 * close by logging in again and rebuilding the api, and a stage reopening the
 * socket would race that -- so a 100,000-message restore that dropped once was
 * over, and the next one asked the phone again.
 *
 * The daemon's runner now hands the restore a `reconnect` that only WATCHES
 * for the daemon's recovery and returns the new api; the restore follows it.
 * These pin both halves with a fake clock, so nothing waits.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { waitForDaemonSocket } from "../../src/core/daemon-sync.js";
import { reconnectedApi, resolveMaxResumes } from "../../src/core/sync-v2/index.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

/** A clock whose `sleep` advances it, and a record of what the watcher logged. */
function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms) };
}
const apiWith = (ws) => ({ listener: { ws } });
const OPEN = 1;
const CLOSED = 3;

describe("waitForDaemonSocket", () => {
    it("returns the daemon's new api once its socket is open, after waiting through the re-login", async () => {
        const c = clock();
        const lostWs = { readyState: CLOSED };
        const lostApi = apiWith(lostWs);
        const fresh = apiWith({ readyState: OPEN });
        let calls = 0;
        // Gone for a few polls (the daemon sleeps 5s and logs in), then a new api with an open socket.
        const getApi = () => (++calls < 4 ? apiWith(null) : fresh);
        const logs = [];
        const back = await waitForDaemonSocket({
            getApi,
            lostWs,
            lostApi,
            ...c,
            pollMs: 500,
            log: (m) => logs.push(m),
        });
        assert.equal(back.api, fresh);
        assert.ok(calls >= 4);
        assert.match(logs[0], /waiting up to 120s for the daemon to reconnect/);
        assert.match(logs.at(-1), /reconnected after [\d.]+s; resuming the stage/);
    });

    it("accepts the same api when zca-js reopened a new socket on it, but not the socket that was lost", async () => {
        const c = clock();
        const lostWs = { readyState: OPEN };
        const api = { listener: { ws: lostWs } };
        let polls = 0;
        const getApi = () => {
            // The same api whose socket object has been replaced after two polls.
            if (++polls === 3) api.listener.ws = { readyState: OPEN };
            return api;
        };
        const back = await waitForDaemonSocket({ getApi, lostWs, lostApi: api, ...c });
        assert.equal(back.api, api);
        assert.equal(polls, 3, "an open socket that is the lost one is not a reconnect");
    });

    it("gives up after the timeout and says so, so the stage ends with what it has", async () => {
        const c = clock();
        const logs = [];
        const back = await waitForDaemonSocket({
            getApi: () => apiWith(null),
            lostWs: null,
            lostApi: null,
            timeoutMs: 3000,
            pollMs: 500,
            ...c,
            log: (m) => logs.push(m),
        });
        assert.equal(back, null);
        assert.match(logs.at(-1), /did not reconnect within 3s; the stage ends with what it has/);
    });

    it("survives getApi throwing while the daemon is between sessions", async () => {
        const c = clock();
        let n = 0;
        const fresh = apiWith({ readyState: OPEN });
        const back = await waitForDaemonSocket({
            getApi: () => {
                if (++n < 3) throw new Error("logging in again");
                return fresh;
            },
            lostWs: null,
            lostApi: null,
            ...c,
        });
        assert.equal(back.api, fresh);
    });
});

describe("reconnectedApi", () => {
    it("is the api only when the caller handed one with a listener", () => {
        const api = { listener: {} };
        assert.equal(reconnectedApi({ api }), api);
        for (const same of [true, false, undefined, null, {}, { api: {} }, "yes", 1]) {
            assert.equal(reconnectedApi(same), null, JSON.stringify(same));
        }
    });
});

describe("resolveMaxResumes", () => {
    it("is one unless a whole number is asked for, and never more than five", () => {
        assert.equal(resolveMaxResumes(undefined), 1);
        assert.equal(resolveMaxResumes(null), 1);
        assert.equal(resolveMaxResumes("3"), 1, "text is not a whole number");
        assert.equal(resolveMaxResumes(1.5), 1);
        assert.equal(resolveMaxResumes(3), 3);
        assert.equal(resolveMaxResumes(0), 0, "zero switches resuming off");
        assert.equal(resolveMaxResumes(99), 5);
        assert.equal(resolveMaxResumes(-2), 0);
    });
});
