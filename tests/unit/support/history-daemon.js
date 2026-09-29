/**
 * A running `listen` daemon, as its own process, for
 * tests/unit/history-daemon-writer.test.js.
 *
 * What that test claims is about processes: with a daemon up, `msg history`'s
 * fetch and its zalo.db write happen in the daemon, and the CLI process writes
 * nothing. One process has one db module and one connection, so "which process
 * wrote this row" has no answer there. This is the second process: the real
 * daemon side -- startDaemonChannel serving createSyncRunners, the wiring
 * `listen` and `mcp start` both use -- on a real zca-js session whose transport
 * is ../fake-zalo-session.js, writing the test's sandboxed zalo.db through its
 * own connection, as `listen` does.
 *
 * Started with child_process.fork and driven over IPC:
 *   <- {type: "ready", pid, port}          the channel is published
 *   -> {type: "scenario", scenario}        what this daemon's Zalo answers from now on
 *   <- {type: "scenario-set"}
 *   -> {type: "report"}                    what this daemon's Zalo was asked since then
 *   <- {type: "report", storeCalls, socketRequests}
 *   -> {type: "stop"}                      withdraw the channel and exit 0
 *
 * A scenario (all optional):
 *   store      getrecentv2's `data` for any group; absent means no route, so
 *              the store fails (HTTP 404) and the stage falls back to the socket
 *   pages      old-message pages, frames in the listener's `{threadId, type, data}`
 *   failScan   the socket scan throws this: the stage fails mid-call
 *   dieOnScan  the process exits with code 3 as the scan starts: the daemon
 *              dies mid-call, with its descriptor left behind
 *
 * It never imports ../../helpers/sandbox.js, which would make a new home. It
 * inherits the test's, and refuses to start unless the config dir resolves to
 * the one the test named -- so it cannot touch a real ~/.zalo-agent-cli/.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const expected = process.env.ZALO_TEST_DAEMON_CONFIG_DIR;
if (!process.send || !expected || join(homedir(), ".zalo-agent-cli") !== expected) {
    console.error("history-daemon.js: start me with fork() from the test, inside its sandbox");
    process.exit(2);
}

// Only now, with the home checked: these compute CONFIG_DIR when first loaded.
const { FAKE, installFakeZalo, loginFake, serveOldMessages } = await import("../fake-zalo-session.js");
const { CONFIG_DIR } = await import("../../../src/core/credentials.js");
const { initDb } = await import("../../../src/core/db.js");
const { startDaemonChannel } = await import("../../../src/core/daemon-channel.js");
const { createSyncRunners } = await import("../../../src/core/daemon-sync.js");

if (CONFIG_DIR !== expected) {
    console.error(`history-daemon.js: CONFIG_DIR is ${CONFIG_DIR}, not the test's sandbox`);
    process.exit(2);
}

const fake = installFakeZalo();
const api = await loginFake();
const accountDir = join(CONFIG_DIR, "accounts", FAKE.ownId);
// The daemon's own connection, opened the way `listen` opens it at start-up.
initDb(join(accountDir, "zalo.db"));

let socket = null;

/** Point this daemon's fake Zalo at a new scenario, forgetting what it was asked. */
function applyScenario(s = {}) {
    fake.clearRoutes();
    fake.requests.length = 0;
    if (typeof s.store === "string") fake.route("/api/cm/getrecentv2", () => s.store);
    socket?.restore();
    socket = serveOldMessages(api, s.pages || []);
    if (s.failScan) {
        api.listener.requestOldMessages = (threadType, lastId) => {
            socket.requests.push({ threadType, lastId });
            throw new Error(s.failScan);
        };
    }
    if (s.dieOnScan) api.listener.requestOldMessages = () => process.exit(3);
}
applyScenario();

const channel = await startDaemonChannel({
    getApi: () => api,
    accountDir,
    runners: createSyncRunners({ getApi: () => api, accountName: FAKE.ownId }),
});

process.on("message", (m) => {
    if (m?.type === "scenario") {
        applyScenario(m.scenario);
        process.send({ type: "scenario-set" });
    } else if (m?.type === "report") {
        process.send({
            type: "report",
            storeCalls: fake.calls("/api/cm/getrecentv2").length,
            socketRequests: socket.requests.length,
        });
    } else if (m?.type === "stop") {
        channel.stop();
        process.exit(0);
    }
});
// The test went away without saying stop: do not outlive it.
process.on("disconnect", () => {
    channel.stop();
    process.exit(0);
});

process.send({ type: "ready", pid: process.pid, port: channel.port });
