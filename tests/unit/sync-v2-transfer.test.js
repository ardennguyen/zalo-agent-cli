/**
 * What the phone's frames mean for a transfer sync (src/core/sync-v2/transfer.js): the status table, how
 * one session reads its controls, when it is finished, and when a run has failed too much to go on.
 *
 * The first bug here was a comparison, `status >= 4`: a phone that REJECTED the request (status 6) read as
 * confirmed, the empty result read as "that window had nothing", and the run recorded success and closed
 * the coverage gap it was meant to repair. Each rule below is checked on the values around its edge, and
 * the last section runs the real frames of a declined and a completed sync through the real listener.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { decodeFrame, describeRestoreOutcome, isSessionComplete } from "../../src/core/sync-v2/index.js";
import {
    CONFIRM_WAIT_MS,
    DISPOSE_REASON,
    IDLE_TIMEOUT_MS,
    STALL_IDLE_MS,
    MAX_FAILED_BATCHES,
    applyControl,
    classifyTransferStatus,
    createTransferSession,
    declineError,
    firstFatalStatus,
    isConfirmed,
    isIdleTooLong,
    isStalledIdle,
    isTransferSessionComplete,
    judgeConversationRound,
    readTransferControls,
    shouldAbortOnFailures,
    recordDownloadFailure,
} from "../../src/core/sync-v2/transfer.js";
import { installTransferSync, startFakeZalo } from "../helpers/fake-zalo/index.js";

const status = (s, extra = {}) => ({
    act: "transfer_status",
    data: { syncId: "s", status: s, fromDevice: 0, ...extra },
});
const batch = (idx, isLast, partitions = [], extra = {}) => ({
    act: "upload_batch",
    data: { syncId: "s", err: 0, idx, isLast, scopes: partitions.map((partition) => ({ partition })), ...extra },
});

describe("the status table", () => {
    it("says confirmed only for 4 and 5", () => {
        for (let s = 1; s <= 10; s++)
            assert.equal(classifyTransferStatus(s).confirmed, s === 4 || s === 5, `status ${s}`);
    });

    it("makes 6 to 10 fatal, each with its own words and release reason", () => {
        const expected = {
            6: ["rejected", "phone-rejected", DISPOSE_REASON.ERROR],
            7: ["cancelled", "phone-cancelled", DISPOSE_REASON.CANCELLED],
            8: ["busy", "phone-busy", DISPOSE_REASON.ERROR],
            9: ["low-storage", "phone-low-storage", DISPOSE_REASON.ERROR],
            10: ["logged-out", "phone-logged-out", DISPOSE_REASON.ERROR],
        };
        const messages = new Set();
        for (const [s, [kind, reason, dispose]] of Object.entries(expected)) {
            const c = classifyTransferStatus(Number(s));
            assert.deepEqual(
                [c.kind, c.reason, c.disposeReason, c.fatal],
                [kind, reason, dispose, true],
                `status ${s}`,
            );
            assert.ok(c.message.length > 10);
            messages.add(c.message);
        }
        assert.equal(messages.size, 5, "two statuses share one message");
    });

    it("leaves 1, 2 and 3 neither confirmed nor fatal, and an unknown number as unknown", () => {
        for (const s of [1, 2, 3]) {
            const c = classifyTransferStatus(s);
            assert.deepEqual([c.confirmed, c.fatal], [false, false], `status ${s}`);
        }
        for (const s of [0, 11, 99, -1, NaN, "x", undefined]) {
            const c = classifyTransferStatus(s);
            assert.deepEqual([c.kind, c.confirmed, c.fatal], ["unknown", false, false], `status ${s}`);
        }
    });

    it("reads a numeric string as its number", () => {
        assert.equal(classifyTransferStatus("6").kind, "rejected");
        assert.equal(classifyTransferStatus("4").confirmed, true);
    });

    it("isConfirmed: a rejection is not a confirmation, and a confirmation survives later statuses", () => {
        assert.equal(isConfirmed([3, 6]), false);
        assert.equal(isConfirmed([3]), false);
        assert.equal(isConfirmed([3, 4]), true);
        assert.equal(isConfirmed([5]), true);
        assert.equal(isConfirmed([]), false);
        assert.equal(isConfirmed(undefined), false);
    });

    it("firstFatalStatus finds the first status that ends the sync", () => {
        assert.equal(firstFatalStatus([3, 4, 5]), null);
        assert.equal(firstFatalStatus([3, 8, 6]).kind, "busy");
        assert.equal(firstFatalStatus(undefined), null);
    });

    it("the wait for a confirmation is ten minutes, as Zalo's own clients wait", () => {
        assert.equal(CONFIRM_WAIT_MS, 600_000);
        assert.equal(IDLE_TIMEOUT_MS, 600_000);
    });
});

describe("applyControl: statuses", () => {
    let s;
    beforeEach(() => {
        s = createTransferSession({ kind: "msg", want: ["oneone/a"] });
    });

    it("records the statuses and a rejection as the session's fatal, the first one only", () => {
        applyControl(s, status(3));
        applyControl(s, status(6));
        applyControl(s, status(8));
        assert.deepEqual(s.statuses, [3, 6, 8]);
        assert.equal(s.fatal.kind, "rejected");
        assert.equal(s.disposeReason, DISPOSE_REASON.ERROR);
        assert.equal(isConfirmed(s.statuses), false, "a rejected sync was read as confirmed");
    });

    it("a cancel releases with reason 0", () => {
        applyControl(s, status(7));
        assert.equal(s.disposeReason, DISPOSE_REASON.CANCELLED);
    });

    it("ignores a status that is about another device", () => {
        assert.deepEqual(applyControl(s, status(6, { fromDevice: 1 })), { type: "ignored", why: "other-device" });
        assert.deepEqual(s.statuses, []);
        assert.equal(s.fatal, null);
        applyControl(s, { act: "transfer_status", data: { syncId: "s", status: 4 } }); // no device named: counts
        assert.deepEqual(s.statuses, [4]);
    });

    it("tracks idleness: a 1 or 2 starts the clock, anything else stops it, and ten minutes of it is too long", () => {
        applyControl(s, status(2), { now: 1000 });
        assert.equal(s.idleSince, 1000);
        applyControl(s, status(1), { now: 5000 });
        assert.equal(s.idleSince, 1000, "a second idle status restarted the clock");
        assert.equal(isIdleTooLong(s, 1000 + IDLE_TIMEOUT_MS), false, "exactly ten minutes is not over ten minutes");
        assert.equal(isIdleTooLong(s, 1000 + IDLE_TIMEOUT_MS + 1), true);
        applyControl(s, status(3), { now: 9000 });
        assert.equal(s.idleSince, null);
        assert.equal(isIdleTooLong(s, 10 ** 12), false);
        assert.equal(isIdleTooLong(null), false);
    });

    it("gives an idle phone a minute on an incomplete session where Web gives it ten (pinned: a change is a decision)", () => {
        assert.equal(STALL_IDLE_MS, 60_000);
        assert.equal(IDLE_TIMEOUT_MS, 600_000);
    });

    it("calls a session stalled when the phone has been idle for a minute and the session is still incomplete", () => {
        applyControl(s, status(2), { now: 1000 });
        assert.equal(isStalledIdle(s, { now: 1000 + STALL_IDLE_MS - 1 }), false, "a minute is not yet over");
        assert.equal(isStalledIdle(s, { now: 1000 + STALL_IDLE_MS }), true);
        assert.equal(isStalledIdle(s, { now: 1000 + 200, afterMs: 100 }), true, "the grace is a parameter");
        applyControl(s, status(5), { now: 2000 });
        assert.equal(isStalledIdle(s, { now: 10 ** 12 }), false, "a phone that is not idle is not stalled");
        assert.equal(isStalledIdle(null), false);
    });

    it("does not call a finished session stalled, however long the phone stays idle", () => {
        applyControl(s, status(2), { now: 1000 });
        applyControl(s, batch(0, true, ["oneone/a"]), { now: 1500 });
        assert.equal(isTransferSessionComplete(s), true);
        assert.equal(isStalledIdle(s, { now: 10 ** 12 }), false);
    });

    it("does not call an idle phone fatal", () => {
        applyControl(s, status(2));
        assert.equal(s.fatal, null);
    });
});

describe("applyControl: batches", () => {
    let s;
    beforeEach(() => {
        s = createTransferSession({ kind: "msg", want: ["oneone/a", "group/b"] });
    });

    it("drops a batch the phone sent twice", () => {
        assert.equal(applyControl(s, batch(0, false, ["oneone/a"])).type, "batch");
        assert.deepEqual(applyControl(s, batch(0, false, ["oneone/a"])), { type: "duplicate", idx: 0 });
        assert.equal(s.batches.length, 1);
        assert.equal(s.duplicates, 1);
    });

    it("is not finished at the last batch while an earlier index is missing", () => {
        applyControl(s, batch(0, false));
        applyControl(s, batch(2, true));
        assert.equal(s.sawLast, true);
        assert.equal(s.lastIdx, 2);
        assert.equal(s.done, false, "finished with index 1 never having arrived");
        applyControl(s, batch(1, false));
        assert.equal(s.done, true);
    });

    it("is finished at once when the last batch comes alone as index 0", () => {
        applyControl(s, batch(0, true));
        assert.equal(s.done, true);
    });

    it("is finished when every partition has come back, even if isLast never arrives", () => {
        applyControl(s, batch(0, false, ["oneone/a"]));
        assert.equal(s.done, false);
        applyControl(s, batch(1, false, ["group/b"]));
        assert.equal(s.done, true);
        assert.equal(s.sawLast, false);
    });

    it("keeps the scopes of every batch", () => {
        applyControl(s, batch(0, false, ["oneone/a"]));
        assert.deepEqual([...s.covered], ["oneone/a"]);
    });

    it("tolerates a batch with no index and no scopes", () => {
        applyControl(s, { act: "upload_batch", data: { syncId: "s", err: 0, isLast: true } });
        assert.equal(s.done, true);
    });

    it("ignores an act it does not know", () => {
        assert.deepEqual(applyControl(s, { act: "something_new", data: {} }), {
            type: "ignored",
            why: "unhandled-act",
        });
    });
});

describe("applyControl: failures are per scope, not per shard", () => {
    let s;
    beforeEach(() => {
        s = createTransferSession({ kind: "msg", want: ["oneone/a", "group/b", "oneone/c"] });
    });

    it("fails only the partitions a failed batch names, and keeps what had arrived", () => {
        applyControl(s, batch(0, false, ["oneone/a"]));
        const ev = applyControl(s, {
            act: "upload_batch",
            data: { syncId: "s", err: 7, idx: 1, scopes: [{ partition: "group/b" }] },
        });
        assert.deepEqual(ev, { type: "failure", partitions: ["group/b"], code: 7 });
        assert.equal(s.err, null, "a scoped failure condemned the whole session");
        assert.equal(s.batches.length, 1, "the good batch was lost");
        assert.deepEqual([...s.failed], ["group/b"]);
        assert.deepEqual(s.failures, [{ partition: "group/b", code: 7, idx: 1 }]);
    });

    it("counts a failed partition as accounted for, so the session can still finish", () => {
        applyControl(s, batch(0, false, ["oneone/a", "oneone/c"]));
        assert.equal(s.done, false);
        applyControl(s, {
            act: "upload_batch",
            data: { syncId: "s", err: 7, idx: 1, scopes: [{ partition: "group/b" }] },
        });
        assert.equal(s.done, true);
    });

    it("reads a transfer_error with a partition the same way, taking the code from errorCode", () => {
        const ev = applyControl(s, {
            act: "transfer_error",
            data: { syncId: "s", partition: "oneone/a", errorCode: 1105 },
        });
        assert.deepEqual(ev, { type: "failure", partitions: ["oneone/a"], code: 1105 });
    });

    it("a failure that names no scope fails the session, which is all it can say", () => {
        assert.deepEqual(applyControl(s, { act: "transfer_error", data: { syncId: "s" } }), { type: "error" });
        assert.ok(s.err);
        assert.deepEqual(applyControl(createTransferSession(), { act: "upload_batch", data: { err: 3 } }), {
            type: "error",
        });
    });

    it("gives a code of null when none is stated", () => {
        const ev = applyControl(s, { act: "transfer_error", data: { partition: "oneone/a" } });
        assert.equal(ev.code, null);
    });
});

describe("isTransferSessionComplete, and the exported isSessionComplete that delegates to it", () => {
    const S = (want, covered, sawLast = false, extra = {}) => ({
        want: new Set(want),
        covered: new Set(covered),
        sawLast,
        ...extra,
    });

    it("keeps every rule the older tests pin", () => {
        assert.equal(isSessionComplete(S(["a", "b"], ["a", "b"])), true);
        assert.equal(isSessionComplete(S(["a", "b"], ["a"])), false);
        assert.equal(isSessionComplete(S(["a"], ["a"], false)), true);
        assert.equal(isSessionComplete(S(["a", "b"], [], true)), true);
        assert.equal(isSessionComplete(S([], [])), false);
        assert.equal(isSessionComplete(S([], [], true)), true);
        assert.equal(isSessionComplete(null), false);
        assert.equal(isSessionComplete({}), false);
    });

    it("needs the index set to be whole before an isLast batch ends a session that has indexes", () => {
        const base = { idxSeen: new Set([0, 2]), lastIdx: 2 };
        assert.equal(isTransferSessionComplete(S(["a", "b"], [], true, base)), false);
        assert.equal(
            isTransferSessionComplete(S(["a", "b"], [], true, { ...base, idxSeen: new Set([0, 1, 2]) })),
            true,
        );
    });

    it("counts a failed partition as accounted for", () => {
        assert.equal(isTransferSessionComplete(S(["a", "b"], ["a"], false, { failed: new Set(["b"]) })), true);
        assert.equal(isTransferSessionComplete(S(["a", "b"], [], false, { failed: new Set(["b"]) })), false);
    });
});

describe("recordDownloadFailure (Y3)", () => {
    const err = { kind: "not-found", message: "the batch is no longer there (404)" };

    it("fails the scopes the batch carried, with the reason, as if the phone had reported them", () => {
        const s = createTransferSession({ kind: "msg", want: ["oneone/a", "group/b", "group/c"] });
        const failed = recordDownloadFailure(
            s,
            { idx: 4, scopes: [{ partition: "oneone/a" }, { partition: "group/b" }] },
            err,
        );
        assert.deepEqual(failed, ["oneone/a", "group/b"]);
        assert.deepEqual([...s.failed].sort(), ["group/b", "oneone/a"]);
        assert.deepEqual(s.failures[0], { partition: "oneone/a", code: null, idx: 4, download: "not-found" });
        assert.equal(s.err, null, "the session itself did not fail: the other scopes may still arrive");
    });

    it("lets a session finish when every scope has either come back or failed", () => {
        const s = createTransferSession({ kind: "msg", want: ["oneone/a", "group/b"] });
        applyControl(s, { act: "upload_batch", data: { err: 0, idx: 0, scopes: [{ partition: "oneone/a" }] } });
        assert.equal(s.done, false);
        recordDownloadFailure(s, { idx: 1, scopes: [{ partition: "group/b" }] }, err);
        s.done = isTransferSessionComplete(s);
        assert.equal(s.done, true);
    });

    it("fails the session when the batch names no scope (a conversation-list batch)", () => {
        const s = createTransferSession({ kind: "conv" });
        assert.deepEqual(recordDownloadFailure(s, { idx: 0 }, err), []);
        assert.deepEqual(s.err, { download: "not-found", message: err.message });
    });

    it("keeps the first failure of a session when a second one follows", () => {
        const s = createTransferSession({ kind: "conv" });
        recordDownloadFailure(s, { idx: 0 }, err);
        recordDownloadFailure(s, { idx: 1 }, { kind: "server", message: "later" });
        assert.equal(s.err.download, "not-found");
    });
});

describe("shouldAbortOnFailures", () => {
    it("stops at ten failed batches, whatever the total", () => {
        assert.equal(shouldAbortOnFailures({ failed: MAX_FAILED_BATCHES - 1, total: 9 }), false);
        assert.equal(shouldAbortOnFailures({ failed: MAX_FAILED_BATCHES, total: 500 }), true);
    });

    it("stops when more than half have failed, but only once ten batches have been seen", () => {
        assert.equal(
            shouldAbortOnFailures({ failed: 1, total: 1 }),
            false,
            "one failure among the first one is not half of everything",
        );
        assert.equal(shouldAbortOnFailures({ failed: 4, total: 5 }), false);
        assert.equal(shouldAbortOnFailures({ failed: 5, total: 10 }), false, "exactly half is not more than half");
        assert.equal(shouldAbortOnFailures({ failed: 6, total: 11 }), true);
        assert.equal(shouldAbortOnFailures({ failed: 5, total: 11 }), false);
        assert.equal(shouldAbortOnFailures({ failed: 0, total: 0 }), false);
    });
});

describe("readTransferControls", () => {
    /** One server frame: header (cmd 601) and a plain JSON body. */
    const frame = (cmd, body, top = {}) => {
        const head = Buffer.alloc(4);
        head.writeUInt8(1, 0);
        head.writeUInt16LE(cmd, 1);
        return Buffer.concat([head, Buffer.from(JSON.stringify({ ...top, encrypt: 0, data: JSON.stringify(body) }))]);
    };
    const control = (act, data, actType = "transfer_sync2") => ({ content: { act, data, act_type: actType } });
    const decode = (p) => decodeFrame(p, undefined);

    it("returns the transfer controls of a 601 frame, parsing data that arrives as JSON text", () => {
        const buf = frame(601, {
            data: {
                controls: [
                    control("transfer_status", JSON.stringify({ syncId: "s1", status: 3 })),
                    control("upload_batch", { syncId: "s2", idx: 0 }),
                ],
            },
        });
        assert.deepEqual(readTransferControls(buf, decode), [
            { act: "transfer_status", data: { syncId: "s1", status: 3 }, syncId: "s1" },
            { act: "upload_batch", data: { syncId: "s2", idx: 0 }, syncId: "s2" },
        ]);
    });

    it("skips other control types, other commands, and frames it cannot read", () => {
        const mixed = frame(601, {
            data: { controls: [control("join", {}, "group"), control("transfer_status", { syncId: "x", status: 4 })] },
        });
        assert.deepEqual(
            readTransferControls(mixed, decode).map((c) => c.syncId),
            ["x"],
        );
        assert.deepEqual(readTransferControls(frame(504, { data: {} }), decode), []);
        assert.deepEqual(readTransferControls(Buffer.from("xx"), decode), []);
        assert.deepEqual(
            readTransferControls(Buffer.concat([Buffer.from([1, 89, 2, 0]), Buffer.from("{not json")]), decode),
            [],
        );
        assert.deepEqual(readTransferControls("not a buffer", decode), []);
        assert.deepEqual(readTransferControls(frame(601, { data: {} }), decode), []);
    });

    it("returns nothing, not an error, when decoding fails", () => {
        const buf = frame(601, { data: { controls: [control("transfer_status", { syncId: "x", status: 3 })] } });
        const boom = () => {
            throw new Error("bad key");
        };
        assert.deepEqual(readTransferControls(buf, boom), []);
    });
});

describe("judgeConversationRound", () => {
    const session = (over = {}) => ({ statuses: [], err: null, fatal: null, ...over });

    it("ends in the phone's own words when it rejected the sync, and never as an empty window", () => {
        const fatal = classifyTransferStatus(6);
        const v = judgeConversationRound({
            why: "declined",
            session: session({ statuses: [3, 6], fatal }),
            waitMs: 1000,
        });
        assert.equal(v.confirmed, false);
        assert.match(v.error.message, /you rejected the sync request on your phone/);
        assert.match(v.error.message, /nothing was restored and nothing was recorded as synced/);
        assert.equal(v.error.reason, "phone-rejected");
    });

    it("tells a phone that went idle from one that said no", () => {
        const v = judgeConversationRound({ why: "idle-timeout", session: session({ statuses: [3, 2] }), waitMs: 1000 });
        assert.equal(v.error.reason, "phone-idle-timeout");
        assert.match(v.error.message, /went idle/);
    });

    it("keeps the old advice for the cases that were already right", () => {
        const dropped = (confirmed) =>
            judgeConversationRound({
                why: "socket-closed",
                session: session({ statuses: confirmed ? [3, 4] : [3] }),
                waitMs: 1000,
            });
        assert.match(dropped(true).error.message, /dropped after your phone confirmed/);
        assert.match(dropped(false).error.message, /dropped while waiting for your phone to confirm/);
        const timeout = judgeConversationRound({
            why: "timeout",
            session: session({ statuses: [3] }),
            waitMs: 600_000,
        });
        assert.match(timeout.error.message, /did not answer the sync prompt within 600s/);
        assert.match(
            judgeConversationRound({ why: "done", session: session({ err: { code: 9 } }), waitMs: 1 }).error.message,
            /conversation round failed/,
        );
    });

    it("lets a confirmed run on, even when the budget ran out", () => {
        assert.equal(
            judgeConversationRound({ why: "timeout", session: session({ statuses: [3, 4] }), waitMs: 1000 }).error,
            null,
        );
        assert.equal(
            judgeConversationRound({ why: "done", session: session({ statuses: [3, 4] }), waitMs: 1000 }).error,
            null,
        );
    });

    it("uses the confirmation seen on an earlier attempt when it is handed in", () => {
        const v = judgeConversationRound({
            why: "socket-closed",
            session: session({ statuses: [] }),
            waitMs: 1,
            confirmed: true,
        });
        assert.match(v.error.message, /after your phone confirmed/);
    });

    it("declineError carries the reason and the status classification", () => {
        const e = declineError(classifyTransferStatus(9));
        assert.equal(e.reason, "phone-low-storage");
        assert.equal(e.phone.status, 9);
    });
});

describe("describeRestoreOutcome with failed batches", () => {
    const base = { socketDied: false, timedOut: false, confirmed: true, messagesSaved: 10, finished: 3, total: 3 };

    it("is unchanged without failures", () => {
        assert.deepEqual(describeRestoreOutcome(base), { reason: "complete", error: null });
    });

    it("is partial, not complete, when the phone could not serve some of what was asked", () => {
        assert.deepEqual(describeRestoreOutcome({ ...base, failedBatches: 2 }), { reason: "partial", error: null });
    });

    it("says why a run was stopped for too many failures, and is an error only if nothing arrived", () => {
        assert.deepEqual(describeRestoreOutcome({ ...base, failedBatches: 10, tooManyFailures: true }), {
            reason: "too-many-failures",
            error: null,
        });
        const none = describeRestoreOutcome({ ...base, messagesSaved: 0, failedBatches: 10, tooManyFailures: true });
        assert.equal(none.reason, "too-many-failures");
        assert.match(none.error, /nothing was restored/);
    });
});

describe("the real frames of a sync, through the real listener", () => {
    let zalo;
    let api;

    beforeEach(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
    });
    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    });

    const request = (n, type = "message") => ({
        version: 1,
        cmd: 590,
        subCmd: 0,
        data: {
            data: {
                syncId: `sync-${n}`,
                syncType: 0,
                ek: "e",
                ik: "i",
                toDevice: 0,
                tempKey: "",
                deviceName: "x",
                req: { type, priority: 0, queries: [{}], batchSize: 2000 },
                ver: 1,
                ussidx: 0,
            },
            reqId: `req-${n}`,
        },
    });

    /** Connect, send the requests, and apply every control that comes back to a session per syncId. */
    async function run(outcome, requests, opts = {}) {
        const { once } = await import("node:events");
        zalo = await startFakeZalo();
        installTransferSync(zalo.sock, { outcome, ...opts });
        api = await zalo.login();
        const connected = once(api.listener, "connected");
        api.listener.start();
        await connected;
        const sessions = new Map(requests.map((r) => [r.data.data.syncId, createTransferSession({ kind: "conv" })]));
        api.listener.ws.on("message", (buf) => {
            for (const ctl of readTransferControls(buf, (p) => decodeFrame(p, undefined))) {
                const s = sessions.get(ctl.syncId);
                if (s) applyControl(s, { act: ctl.act, data: ctl.data });
            }
        });
        for (const r of requests) api.listener.sendWs(r, false);
        await new Promise((r) => setTimeout(r, 250));
        return sessions;
    }

    it("a declined sync is recognized by its status frames, with no download and no timeout (X3)", async () => {
        const sessions = await run("declined", [request(1, "conversation")]);
        const s = sessions.get("sync-1");
        assert.deepEqual(s.statuses, [3, 6]);
        assert.equal(s.fatal.reason, "phone-rejected");
        assert.equal(isConfirmed(s.statuses), false);
        assert.equal(s.batches.length, 0);
        assert.equal(s.disposeReason, DISPOSE_REASON.ERROR);
    });

    it("a completed sync is confirmed, whole, and not fatal", async () => {
        const sessions = await run("complete", [request(1, "conversation"), request(2)], {
            batchesPerRequest: 2,
            expectedRequests: 2,
        });
        const first = sessions.get("sync-1");
        const second = sessions.get("sync-2");
        assert.equal(isConfirmed(first.statuses), true);
        assert.equal(first.fatal, null);
        assert.equal(first.done, true);
        assert.equal(second.done, true);
        assert.equal(first.batches.length, 2);
        assert.deepEqual([...first.idxSeen].sort(), [0, 1]);
    });

    it("a sync the phone has not answered is neither confirmed nor fatal: only the wait can end it", async () => {
        const sessions = await run("waiting", [request(1, "conversation")]);
        const s = sessions.get("sync-1");
        assert.deepEqual(s.statuses, [3]);
        assert.equal(s.fatal, null);
        assert.equal(isConfirmed(s.statuses), false);
        assert.equal(s.done, false);
    });
});
