/**
 * Source-level guards for the listener lifecycle.
 *
 * These read the command files as TEXT, the same technique as
 * `sync-socket-rules.test.js` and `daemon-channel.test.js`. The behaviour they
 * protect lives inside 700-line command actions wired to a live Zalo socket, so
 * there is no seam to unit-test it through — and every one of these defects was
 * invisible to the existing suite precisely because nothing asserted on shape.
 *
 * Each rule below corresponds to a measured defect, not a style preference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "..", "src");
const read = (p) => readFileSync(join(SRC, p), "utf8");

const listen = read("commands/listen.js");
const msg = read("commands/msg.js");

describe("listen: a reconnect must file a coverage gap", () => {
    it("does not gate gap reporting on reconnectCount", () => {
        // reconnectCount is incremented ONLY in the `closed` handler, and
        // `closed` never fires for a code on the server's close_and_retry_codes
        // list — zca-js emits `disconnected`, retries internally, then emits
        // `connected`. Those codes are precisely the recoverable ones, so
        // `if (reconnectCount > 0) reportGap(...)` was always false on the
        // common drop path: no gap was filed, and markConnected() then asserted
        // coverage over the outage. Silent, unrecoverable message loss.
        const connectedHandler = listen.slice(
            listen.indexOf('listener.on("connected"'),
            listen.indexOf('listener.on("disconnected"'),
        );
        assert.ok(connectedHandler.length > 0, "could not find the connected handler");
        assert.doesNotMatch(
            connectedHandler,
            // 900, not 400: in the defective version an info() line and a
            // six-line comment sat between the guard and the reportGap call,
            // so a tighter window matched nothing and the guard passed
            // against the very code it exists to reject.
            /if \(reconnectCount > 0\)[\s\S]{0,900}reportGap/,
            "gap reporting must be driven by observed socket state, not by which handler ran",
        );
        assert.match(connectedHandler, /downSince/, "the connected handler must consult observed down state");
        assert.match(connectedHandler, /reportGap\(\s*downSince/, "the gap must span from when the socket went down");
    });

    it("marks the socket down in both paths that take it down", () => {
        // A drop reaches us as EITHER `disconnected` (zca-js retries) or
        // `closed` (we re-login). Both must record it or the other path files
        // a gap starting from null.
        for (const handler of ["disconnected", "closed"]) {
            const body = listen.slice(listen.indexOf(`listener.on("${handler}"`));
            assert.match(
                body.slice(0, 900),
                /downSince === null\) downSince = Date\.now\(\)/,
                `the ${handler} handler must record when the outage started`,
            );
        }
    });

    it("the heartbeat does not claim coverage while the socket is down", () => {
        // markConnected() means "coverage is good up to now". On a bare timer it
        // kept advancing lastConnectedAt through the outage, so a crash mid-drop
        // made the NEXT launch compute its startup-gap from a moment we were not
        // connected — and the outage disappeared.
        const heartbeat = listen.slice(listen.indexOf("function heartbeat()"));
        assert.match(
            // Generous window: the explanation above the guard is long, and a
            // slice that clips it would fail for the wrong reason.
            heartbeat.slice(0, 1400),
            /if \(downSince !== null\) return;/,
            "heartbeat must not stamp connected while down",
        );
    });
});

describe("listen: Ctrl-C must not resurrect the socket", () => {
    it("sets a stopping flag before tearing anything down", () => {
        const sigint = listen.slice(listen.indexOf('process.on("SIGINT"'));
        assert.match(sigint.slice(0, 400), /stopping = true;/, "SIGINT must set stopping first");
    });

    it("both lifecycle handlers bail out when stopping", () => {
        // listener.stop() emits closed(1000), which is indistinguishable from a
        // real drop. Without this the shutdown ran the RECOVERY path: ~5s after
        // the user saw "Stopped", the process re-logged in and opened a fresh
        // socket — with daemon.lock already released and daemon-channel.json
        // already deleted, so the next listen/mcp/sync took the free lock and
        // the two sessions flapped over code 3000.
        for (const handler of ["disconnected", "closed"]) {
            const body = listen.slice(listen.indexOf(`listener.on("${handler}"`));
            assert.match(body.slice(0, 400), /if \(stopping\) return;/, `${handler} must bail out when stopping`);
        }
    });

    it("exits explicitly rather than relying on the event loop draining", () => {
        // An async `closed` handler already in flight resumes after the action
        // function has returned and keeps the process alive. mcp.js already
        // exits explicitly for the same reason.
        const sigint = listen.slice(listen.indexOf('process.on("SIGINT"'));
        assert.match(sigint, /process\.exit\(0\);/, "SIGINT must exit");
    });
});

describe("msg history must not open a second web session", () => {
    it("asks a running daemon before starting its own listener", () => {
        // Zalo permits one web session per account. `msg history` on a DM (or
        // any group whose REST call throws) opened a second one, evicting the
        // daemon with code 3000; the daemon retried and evicted the scan back,
        // and whatever arrived in the flap was lost with NO gap recorded. This
        // is the same failure the /send-attachments hand-off removed for
        // uploads — the read path just never got the guard.
        const scan = msg.slice(msg.indexOf("WebSocket global stream scanning"));
        const checkAt = scan.indexOf("getSyncChannel");
        const startAt = scan.indexOf("listener.start(");
        assert.notEqual(checkAt, -1, "the history scan must consult getSyncChannel");
        assert.notEqual(startAt, -1, "expected a listener.start in the history scan");
        assert.ok(checkAt < startAt, "the daemon must be checked BEFORE opening a socket, not after");
    });

    it("guards the direct-socket path behind the daemon result", () => {
        const scan = msg.slice(msg.indexOf("WebSocket global stream scanning"));
        assert.match(
            scan.slice(0, 3000),
            /if \(!handledByDaemon\) \{/,
            "the direct socket must be skipped when the daemon answered",
        );
    });
});

describe("listen and mcp start must track coverage the same way", () => {
    const mcp = readFileSync(join(SRC, "commands", "mcp.js"), "utf8");

    it("both construct a SyncManager", () => {
        // They are two entry points to the SAME socket, so an asymmetry is a
        // defect, not a difference. `mcp start` had none of this: no gap
        // tracking, no markConnected. An agent-driven install that only ran
        // `mcp start` had zero loss detection, and since it never wrote
        // lastConnectedAt, a later `listen` filed a bogus 14-day gap over a
        // window that was fully covered.
        for (const [name, src] of [
            ["listen.js", listen],
            ["mcp.js", mcp],
        ]) {
            assert.match(src, /new SyncManager\(/, `${name} must own a SyncManager`);
        }
    });

    it("both file a startup gap rather than assuming they are caught up", () => {
        for (const [name, src] of [
            ["listen.js", listen],
            ["mcp.js", mcp],
        ]) {
            assert.match(src, /"startup-gap"/, `${name} must check for a startup gap`);
        }
    });

    it("mcp start bails out of its lifecycle handlers when stopping", () => {
        // listener.stop() closes with 1000; without this the shutdown files a
        // gap for a window in which nothing was missed.
        for (const handler of ["disconnected", "closed"]) {
            const body = mcp.slice(mcp.indexOf(`listener.on("${handler}"`));
            assert.match(
                body.slice(0, 400),
                /isStopping\(\)\) return;/,
                `mcp.js ${handler} must bail out when stopping`,
            );
        }
    });
});
