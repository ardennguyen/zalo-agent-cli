/**
 * Source-level guards for the listener lifecycle.
 *
 * These read the command files as TEXT, the same technique as
 * `sync-socket-rules.test.js` and `daemon-channel.test.js`, or, where a rule is
 * about which object a call receives, as a syntax tree (tests/helpers/ast-wiring.js),
 * so a rename or reformat cannot break it and a dead line cannot satisfy it. The behaviour they
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
import { boundTo, boundToCall, callsTo, findAll, isId, methodCalls, parseModule, prop } from "../helpers/ast-wiring.js";

const SRC = join(import.meta.dirname, "..", "..", "src");
const read = (p) => readFileSync(join(SRC, p), "utf8");

const listen = read("commands/listen.js");
const msg = read("commands/msg.js");

describe("listen: a reconnect must file a coverage gap", () => {
    it("does not gate gap reporting on reconnectCount", () => {
        // reconnectCount is incremented ONLY in the `closed` handler, and
        // `closed` never fires for a code on the server's close_and_retry_codes
        // list — the listener emits `disconnected`, retries internally, then emits
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
        // The shared tracker (src/core/listener-lifecycle.js) files the outage from when it went down, then claims
        // coverage: the same bookkeeping `mcp start` runs, so the two cannot drift apart.
        assert.match(connectedHandler, /lifecycle\.noteUp\(\)/, "the connected handler must go through the tracker");
    });

    it("marks the socket down in the path that takes it down", () => {
        // Every drop reaches us as `disconnected`: the socket supervisor does the
        // retrying, so there is no `closed` path any more (a rule below keeps it
        // that way). It must record the start of the outage or the gap is filed
        // from null; the tracker keeps the first drop (first drop wins).
        for (const handler of ["disconnected"]) {
            const body = listen.slice(listen.indexOf(`listener.on("${handler}"`));
            assert.match(
                body.slice(0, 1200),
                /lifecycle\.noteDown\(\)/,
                `the ${handler} handler must record when the outage started`,
            );
        }
    });

    it("the heartbeat does not claim coverage while the socket is down", () => {
        // markConnected() means "coverage is good up to now". On a bare timer it
        // kept advancing lastConnectedAt through the outage, so a crash mid-drop
        // made the NEXT launch compute its startup-gap from a moment we were not
        // connected — and the outage disappeared. The tracker's heartbeat skips while down or parked.
        const heartbeat = listen.slice(listen.indexOf("function heartbeat()"));
        assert.match(heartbeat.slice(0, 400), /lifecycle\.heartbeat\(\)/, "heartbeat goes through the tracker");
        const lib = read("core/listener-lifecycle.js");
        const beat = lib.slice(lib.indexOf("heartbeat() {"));
        assert.match(beat.slice(0, 300), /if \(stopping \|\| downSince !== null \|\| parkedAt !== null\) return;/);
    });
});

describe("listen: Ctrl-C must not resurrect the socket", () => {
    it("sets a stopping flag before tearing anything down", () => {
        const sigint = listen.slice(listen.indexOf('process.on("SIGINT"'));
        assert.match(sigint.slice(0, 400), /stopping = true;/, "SIGINT must set stopping first");
    });

    it("the lifecycle handler bails out when stopping", () => {
        // listener.stop() emits closed(1000), which is indistinguishable from a
        // real drop. Without this the shutdown ran the RECOVERY path: ~5s after
        // the user saw "Stopped", the process re-logged in and opened a fresh
        // socket — with daemon.lock already released and daemon-channel.json
        // already deleted, so the next listen/mcp/sync took the free lock and
        // the two sessions flapped over code 3000.
        for (const handler of ["disconnected"]) {
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

    // The wiring lives in the daemons' action handlers (live login only), so it is read as data flow from the syntax
    // tree: which object each call receives, not which text is on a line.
    const daemons = [
        ["listen.js", parseModule(join(SRC, "commands", "listen.js"))],
        ["mcp.js", parseModule(join(SRC, "commands", "mcp.js"))],
    ];

    /** The one SyncManager a daemon owns, by variable name. */
    const syncManagerOf = (name, ast) => {
        const owned = boundToCall(ast, "SyncManager", { isNew: true });
        assert.equal(owned.length, 1, `${name} must own exactly one SyncManager`);
        return owned[0];
    };

    it("both keep coverage through the one gap tracker, with the park stamp", () => {
        for (const [name, ast] of daemons) {
            const sm = syncManagerOf(name, ast);
            const trackers = callsTo(ast, "createGapTracker");
            assert.equal(trackers.length, 1, `${name} must keep coverage through createGapTracker`);
            const arg = trackers[0].arguments[0];
            assert.ok(isId(prop(arg, "syncManager"), sm), `${name}: the tracker drives the daemon's SyncManager`);
            assert.ok(isId(prop(arg, "setState"), "setSyncState"), `${name} must stamp the park`);
            assert.equal(callsTo(ast, "createDaemonPresence").length, 1, `${name} must run presence`);
        }
    });

    it("both construct a SyncManager", () => {
        // They are two entry points to the SAME socket, so an asymmetry is a
        // defect, not a difference. `mcp start` had none of this: no gap
        // tracking, no markConnected. An agent-driven install that only ran
        // `mcp start` had zero loss detection, and since it never wrote
        // lastConnectedAt, a later `listen` filed a bogus 14-day gap over a
        // window that was fully covered.
        for (const [name, ast] of daemons) {
            const sm = syncManagerOf(name, ast);
            assert.ok(methodCalls(ast, sm, "markConnected").length > 0, `${name} must mark itself connected`);
        }
    });

    it("both file a startup gap rather than assuming they are caught up", () => {
        // From the last recorded connection, with "startup-gap" as the reason unless the window ended in a park
        // (startupGapReason names that one); only when nothing was filed is the daemon caught up.
        for (const [name, ast] of daemons) {
            const sm = syncManagerOf(name, ast);
            const [last] = boundTo(
                ast,
                (init) =>
                    init.type === "CallExpression" &&
                    init.callee.type === "MemberExpression" &&
                    isId(init.callee.object, sm) &&
                    init.callee.property.name === "getLastConnectedAt",
            );
            assert.ok(last, `${name} must read the last recorded connection`);
            const [reason] = boundTo(
                ast,
                (init) =>
                    init.type === "ConditionalExpression" &&
                    init.alternate.type === "Literal" &&
                    init.alternate.value === "startup-gap" &&
                    init.consequent.type === "CallExpression" &&
                    init.consequent.callee.name === "startupGapReason" &&
                    isId(prop(init.consequent.arguments[0], "lastConnectedAt"), last),
            );
            assert.ok(reason, `${name} must name the start-up gap "startup-gap", or the park's reason`);
            const filed = findAll(
                ast,
                (n) =>
                    n.type === "IfStatement" &&
                    n.test.type === "UnaryExpression" &&
                    n.test.operator === "!" &&
                    n.test.argument.type === "CallExpression" &&
                    n.test.argument.callee.name === "reportGap" &&
                    isId(n.test.argument.arguments[0], last) &&
                    isId(n.test.argument.arguments[1], reason) &&
                    methodCalls(n.consequent, sm, "markConnected").length === 1,
            );
            assert.equal(filed.length, 1, `${name} must file the gap, and mark connected only when none was filed`);
        }
    });

    it("mcp start bails out of its lifecycle handlers when stopping", () => {
        // listener.stop() closes with 1000; without this the shutdown files a
        // gap for a window in which nothing was missed.
        for (const handler of ["disconnected"]) {
            const body = mcp.slice(mcp.indexOf(`listener.on("${handler}"`));
            assert.match(
                body.slice(0, 400),
                /isStopping\(\)\) return;/,
                `mcp.js ${handler} must bail out when stopping`,
            );
        }
    });
});

describe("a kick ends the daemon cleanly, in either listener", () => {
    const mcp = read("commands/mcp.js");
    /** The `onKicked: () => { ... }` callback of one file. */
    const kickedCallback = (src) => {
        const at = src.indexOf("onKicked: () => {");
        assert.ok(at > 0, "could not find the kicked callback -- this guard has drifted");
        return src.slice(at, src.indexOf("},", at));
    };

    it("listen releases the lock and stops its channel before exiting, as mcp start does", () => {
        // Red if listen goes back to a bare process.exit: daemon.lock and
        // daemon-channel.json stay behind until a stale-PID check reclaims them.
        for (const [name, src] of [
            ["listen", listen],
            ["mcp start", mcp],
        ]) {
            const cb = kickedCallback(src);
            assert.match(cb, /dropLock\(\)/, `${name}'s kicked callback must call dropLock()`);
            assert.match(cb, /process\.exit\(EXIT_CODE\.KICKED\)/, `${name} must exit with the kicked code`);
            const helper = src.slice(src.indexOf("const dropLock = () => {"));
            const body = helper.slice(0, helper.indexOf("\n            };"));
            assert.match(body, /releaseLock\(accountDir\)/, `${name}'s dropLock() releases the lock`);
            assert.match(body, /channel\?\.stop\(\)/, `${name}'s dropLock() stops the channel`);
        }
    });

    it("the other ending, a login Zalo keeps refusing, does the same", () => {
        for (const [name, src] of [
            ["listen", listen],
            ["mcp start", mcp],
        ]) {
            const at = src.indexOf("onRevoked: (e) => {");
            assert.ok(at > 0, `${name}: could not find the revoked callback`);
            const cb = src.slice(at, src.indexOf("},", at + 60) + 2);
            assert.match(cb, /dropLock\(\)/, `${name}'s revoked callback must call dropLock()`);
            assert.match(cb, /process\.exit\(EXIT_CODE\.SESSION_REVOKED\)/, `${name} must exit with the revoked code`);
        }
    });
});

describe("listen and mcp start: the socket host keeps the socket alive", () => {
    const mcp = read("commands/mcp.js");

    it("neither has a `closed` ladder, and neither lets the listener retry on its own", () => {
        // The ladder (re-login after 5 s, again after 30 s, then exit) reconnected on a duplicate
        // session until its retries ran out, evicting the other session again each time, and ran the
        // same way for every cause. The supervisor retries by Zalo's own rules instead.
        for (const [name, src] of [
            ["listen.js", listen],
            ["mcp.js", mcp],
        ]) {
            assert.doesNotMatch(src, /listener\.on\("closed"/, `${name} must not handle \`closed\` itself`);
            assert.doesNotMatch(src, /retryOnClose: true/, `${name} must not let the listener retry on its own`);
            assert.doesNotMatch(src, /Re-login in 5s/, `${name} must not carry the old recovery ladder`);
        }
    });

    it("both start the socket through the host, and stop it before the listener at shutdown", () => {
        for (const [name, src] of [
            ["listen.js", listen],
            ["mcp.js", mcp],
        ]) {
            assert.match(src, /createSocketHost\(/, `${name} must build the socket host`);
            // Through presence (src/core/daemon-presence.js): the host adopts the session, presence opens the socket.
            assert.match(src, /daemonPresence\.start\(api\)/, `${name} must start the socket through presence`);
            const stopAt = src.indexOf("socketHost.stop()");
            const listenerStopAt = src.indexOf("getApi().listener.stop()");
            assert.ok(stopAt > 0 && listenerStopAt > stopAt, `${name} must stop the supervisor before the listener`);
        }
    });

    it("both give the host the same four callbacks, so they cannot differ", () => {
        for (const [name, src] of [
            ["listen.js", listen],
            ["mcp.js", mcp],
        ]) {
            for (const key of ["relogin:", "onKicked:", "onRevoked:", "isStopping:"]) {
                assert.ok(src.includes(key), `${name} must pass ${key} to the socket host`);
            }
        }
    });
});
