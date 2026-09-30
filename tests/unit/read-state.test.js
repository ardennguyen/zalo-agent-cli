/**
 * src/core/read-state.js -- the read state other devices report (M4).
 *
 * zca-js drops both carriers: the `clearUnreads` rows (cmds 504/524, and a
 * field of every chat envelope and offline page) that say "this conversation
 * is read through message N", and the 601 `mark_unread` control that sets or
 * clears the manual unread flag. Without them a conversation the human read
 * on the phone still looks unread here. These drive the REAL socket tap with
 * frames written offline (./support/fake-socket.js) against a sandboxed db,
 * and pin, for each rule, the change that would turn it red.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { initDb, getConvState, recordReadWatermark, upsertConvState, upsertThread } from "../../src/core/db.js";
import {
    CLEAR_UNREADS_CMDS,
    createReadStateSync,
    parseKeepingIds,
    readMarksFrom,
    readStateEvent,
    unreadMarksFrom,
} from "../../src/core/read-state.js";
import { createSocketTap } from "../../src/core/socket-tap.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { fakeListener } from "./support/fake-socket.js";
import { walkAst } from "../helpers/zca-call-sites.js";

// Fakes by the convention in no-real-ids.test.js; both past MAX_SAFE_INTEGER.
const GROUP = "9000000000000000011";
const DM = "1000000000000000001";
// A pair that rounds to the same double, for the ambiguous-match rule.
const TWIN_A = "4123456789012345678";
const TWIN_B = "4123456789012345679";

assertSandboxed(CONFIG_DIR);

const ROOT = mkdtempSync(join(tmpdir(), "zalo-read-state-test-"));
const opened = [];
let dbCount = 0;
function freshDb() {
    const handle = initDb(join(ROOT, `db-${++dbCount}`, "zalo.db"));
    opened.push(handle);
    return handle;
}
after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    rmSync(ROOT, { recursive: true, force: true });
});

const row = (over = {}) => ({
    idTo: DM,
    isGroup: 0,
    lastMsgId: "7000000000001",
    lastCliMsgId: "7000000000901",
    type: 0,
    sct: 0,
    ts: "1790000000000",
    ...over,
});

const noThreads = () => [];

describe("readMarksFrom -- which clearUnreads rows are conversation reads", () => {
    it("reads a DM and a group row as a read watermark on that conversation", () => {
        const marks = readMarksFrom(
            { clearUnreads: [row(), row({ idTo: GROUP, isGroup: 1, lastMsgId: "7000000000002" })] },
            noThreads,
        );
        assert.deepEqual(marks, [
            {
                threadId: DM,
                isGroup: false,
                lastMsgId: "7000000000001",
                lastCliMsgId: "7000000000901",
                ts: 1790000000000,
            },
            {
                threadId: GROUP,
                isGroup: true,
                lastMsgId: "7000000000002",
                lastCliMsgId: "7000000000901",
                ts: 1790000000000,
            },
        ]);
    });

    it("skips a folder or request-box row (type 2, sct 1-3) and a read of message 0, as the web does", () => {
        const marks = readMarksFrom(
            {
                clearUnreads: [
                    row({ type: 2, sct: 1 }),
                    row({ type: 2, sct: 2 }),
                    row({ type: 2, sct: 3 }),
                    row({ lastMsgId: "0" }),
                    row({ lastMsgId: 0 }),
                    row({ lastMsgId: undefined }),
                    // type 2 with any other sct falls through to a normal read in the web
                    row({ type: 2, sct: 0, lastMsgId: "7000000000005" }),
                ],
            },
            noThreads,
        );
        // Red if the type/sct rule is dropped (3 more) or widened to all of type 2 (0 left).
        assert.deepEqual(
            marks.map((m) => m.lastMsgId),
            ["7000000000005"],
        );
    });

    it("matches an id the JSON already rounded to the one cached thread, and never guesses between two", () => {
        const threads = () => [
            { threadId: GROUP, type: "group" },
            { threadId: TWIN_A, type: "dm" },
            { threadId: TWIN_B, type: "dm" },
        ];
        const marks = readMarksFrom(
            {
                clearUnreads: [
                    row({ idTo: Number(GROUP), isGroup: 1 }),
                    row({ idTo: Number(TWIN_A) }), // rounds to the same double as TWIN_B
                ],
            },
            threads,
        );
        // Red if String(number) is trusted: it names a thread that does not exist.
        assert.deepEqual(
            marks.map((m) => m.threadId),
            [GROUP],
        );
    });

    it("finds nothing in an envelope without the field", () => {
        assert.deepEqual(readMarksFrom({ msgs: [] }, noThreads), []);
        assert.deepEqual(readMarksFrom(null, noThreads), []);
    });
});

describe("parseKeepingIds -- a JSON payload whose ids are bare numbers", () => {
    it("keeps a 19-digit id exact, and leaves strings, short numbers and fractions alone", () => {
        const text = `{"id":${GROUP},"s":"x${GROUP}","q":"a\\"${DM}","n":42,"f":1.1234567890123456789}`;
        const v = parseKeepingIds(text);
        // Red if plain JSON.parse is used: the id comes back rounded.
        assert.equal(v.id, GROUP);
        assert.equal(v.s, `x${GROUP}`);
        assert.equal(v.q, `a"${DM}`);
        assert.equal(v.n, 42);
        assert.equal(typeof v.f, "number");
        // What it guards against: plain JSON.parse names a different thread.
        assert.notEqual(String(JSON.parse(text).id), GROUP);
    });
});

describe("unreadMarksFrom -- the 601 mark_unread control", () => {
    const control = (act, content, where = "content") => ({
        controls: [{ controlId: "5", content: { act_type: "mark_unread", act, [where]: content } }],
    });

    it("reads an add, whose JSON-string content names each conversation with a bare-number id", () => {
        const content = `{"convsGroup":[{"id":${GROUP},"cliMsgId":"1","fromUid":"0","ts":1790000000001}],"convsUser":[]}`;
        const marks = unreadMarksFrom(control("add", content), noThreads);
        // Red if the id is parsed lossily (a thread that does not exist) or the ts dropped.
        assert.deepEqual(marks, [{ threadId: GROUP, isGroup: true, marked: true, ts: 1790000000001 }]);
    });

    it("reads a remove, which names bare ids", () => {
        const marks = unreadMarksFrom(control("remove", `{"convsGroup":[],"convsUser":["${DM}"]}`), noThreads);
        assert.deepEqual(marks, [{ threadId: DM, isGroup: false, marked: false, ts: null }]);
    });

    it("also takes the payload from `data`, as an object", () => {
        const marks = unreadMarksFrom(control("add", { convsUser: [{ id: DM, ts: 5 }] }, "data"), noThreads);
        assert.deepEqual(marks, [{ threadId: DM, isGroup: false, marked: true, ts: 5 }]);
    });

    it("ignores every other control, and a payload it cannot parse", () => {
        const others = {
            controls: [
                { content: { act_type: "group", act: "join", data: "{}" } },
                { content: { act_type: "file_done", data: { url: "u" } } },
                { content: { act_type: "mark_unread", act: "toggle", content: "{}" } },
                { content: { act_type: "mark_unread", act: "add", content: "{not json" } },
            ],
        };
        assert.deepEqual(unreadMarksFrom(others, noThreads), []);
    });
});

describe("recordReadWatermark -- the watermark only moves forward", () => {
    beforeEach(() => freshDb());

    it("moves on a newer id, and not on an older or equal one", () => {
        assert.equal(recordReadWatermark({ threadId: DM, msgId: "7000000000005", ts: 11 }), true);
        assert.equal(recordReadWatermark({ threadId: DM, msgId: "7000000000004", ts: 12 }), false);
        assert.equal(recordReadWatermark({ threadId: DM, msgId: "7000000000005", ts: 13 }), false);
        const st = getConvState(DM);
        assert.equal(st.lastReadMsgId, "7000000000005");
        assert.equal(st.lastReadTs, 11);
    });

    it("compares ids as integers: a 14-digit id is later than any 13-digit one", () => {
        recordReadWatermark({ threadId: DM, msgId: "9999999999999" });
        // Red if compared as strings, where "9999…" sorts after "1000…".
        assert.equal(recordReadWatermark({ threadId: DM, msgId: "10000000000000" }), true);
        assert.equal(getConvState(DM).lastReadMsgId, "10000000000000");
    });

    it("keeps the conversation's pin and unread mark, and ignores a non-id", () => {
        upsertConvState({ threadId: GROUP, pinned: true, pinnedAt: 1, unreadMarked: true, unreadMarkedAt: 2 });
        recordReadWatermark({ threadId: GROUP, msgId: "7000000000001" });
        const st = getConvState(GROUP);
        assert.equal(st.pinned, 1);
        assert.equal(st.unreadMarked, 1);
        assert.equal(st.lastReadMsgId, "7000000000001");
        assert.equal(recordReadWatermark({ threadId: GROUP, msgId: "0" }), false);
        assert.equal(recordReadWatermark({ threadId: GROUP, msgId: "abc" }), false);
    });

    it("stamps the time it was told when the report carries none", () => {
        const before = Date.now();
        recordReadWatermark({ threadId: DM, msgId: "7000000000001" });
        assert.ok(getConvState(DM).lastReadTs >= before);
    });
});

describe("createReadStateSync -- through the real socket tap", () => {
    let listener;
    let changes;
    let logs;
    let sync;

    beforeEach(() => {
        freshDb();
        upsertThread({ threadId: GROUP, type: "group", name: "G", lastUpdate: 1 });
        listener = fakeListener();
        const tap = createSocketTap();
        tap.attach(listener);
        changes = [];
        logs = [];
        sync = createReadStateSync({ tap, onChange: (c) => changes.push(c), log: (l) => logs.push(l) });
    });

    it("stores a read reported on 504, and reports it once", () => {
        listener.push(504, 0, { error_code: 0, data: { more: 0, clearUnreads: [row()] } });
        assert.equal(getConvState(DM).lastReadMsgId, "7000000000001");
        assert.deepEqual(changes, [
            { kind: "read", threadId: DM, isGroup: false, lastReadMsgId: "7000000000001", ts: 1790000000000 },
        ]);
    });

    it("reads the same field in every chat envelope and offline page, without repeating a read", () => {
        for (const cmd of [501, 502, 510, 511, 521, 522, 524]) {
            assert.ok(CLEAR_UNREADS_CMDS.includes(cmd), `${cmd} carries clearUnreads`);
        }
        listener.push(524, 0, { data: { clearUnreads: [row({ idTo: GROUP, isGroup: 1 })] } });
        listener.push(521, 0, { data: { groupMsgs: [], clearUnreads: [row({ idTo: GROUP, isGroup: 1 })] } });
        // An offline page that arrives late, carrying an older read.
        listener.push(511, 1, {
            data: { groupMsgs: [], clearUnreads: [row({ idTo: GROUP, isGroup: 1, lastMsgId: "6" })] },
        });
        listener.push(501, 0, { data: { msgs: [], clearUnreads: [row({ lastMsgId: "7000000000009" })] } });
        // Red if a repeat or an older read moves the watermark or is reported again.
        assert.equal(getConvState(GROUP).lastReadMsgId, "7000000000001");
        assert.equal(getConvState(DM).lastReadMsgId, "7000000000009");
        assert.deepEqual(
            changes.map((c) => `${c.threadId}:${c.lastReadMsgId}`),
            [`${GROUP}:7000000000001`, `${DM}:7000000000009`],
        );
    });

    it("does not take the reaction path's clearUnreads (613) for a read", () => {
        listener.push(613, 0, { data: { clearUnreads: [row()] } });
        assert.equal(getConvState(DM), null);
        assert.deepEqual(changes, []);
    });

    it("sets and clears the unread mark from 601, reporting only what changed", () => {
        const push = (act, content) =>
            listener.push(601, 0, {
                data: { controls: [{ controlId: "1", content: { act_type: "mark_unread", act, content } }] },
            });
        push("add", `{"convsGroup":[{"id":${GROUP},"cliMsgId":"1","ts":1790000000002}],"convsUser":[]}`);
        assert.equal(getConvState(GROUP).unreadMarked, 1);
        assert.equal(getConvState(GROUP).unreadMarkedAt, 1790000000002);
        push("add", `{"convsGroup":[{"id":${GROUP},"cliMsgId":"1","ts":1790000000003}],"convsUser":[]}`);
        push("remove", `{"convsGroup":["${GROUP}"],"convsUser":[]}`);
        assert.equal(getConvState(GROUP).unreadMarked, 0);
        push("remove", `{"convsGroup":["${GROUP}"],"convsUser":[]}`);
        // Red if a repeat is reported, or a remove is not applied.
        assert.deepEqual(
            changes.map((c) => `${c.kind}:${c.marked}`),
            ["unread_mark:true", "unread_mark:false"],
        );
    });

    it("matches a rounded id in an object payload against the cached threads", () => {
        listener.push(601, 0, {
            data: {
                controls: [
                    {
                        content: {
                            act_type: "mark_unread",
                            act: "add",
                            data: { convsGroup: [{ id: Number(GROUP), ts: 9 }] },
                        },
                    },
                ],
            },
        });
        // Red if the number is written as String(n): the mark lands on a thread that does not exist.
        assert.equal(getConvState(GROUP)?.unreadMarked, 1);
        assert.equal(getConvState(String(Number(GROUP))), null);
    });

    it("a store that fails is reported, and the socket keeps being read", () => {
        opened.at(-1).close(); // every write now throws: the connection is gone
        listener.push(504, 0, { data: { clearUnreads: [row()] } });
        assert.ok(logs.some((l) => /read state: could not store a read of /.test(l)));
        assert.deepEqual(changes, [], "nothing stored, so nothing reported");
        freshDb();
        listener.push(504, 0, { data: { clearUnreads: [row()] } });
        assert.equal(getConvState(DM).lastReadMsgId, "7000000000001");
    });

    it("a change handler that throws is reported, and the next read is still stored", () => {
        const tap = createSocketTap({ log: (l) => logs.push(l) });
        const l2 = fakeListener();
        tap.attach(l2);
        createReadStateSync({
            tap,
            onChange: () => {
                throw new Error("printer broke");
            },
            log: (l) => logs.push(l),
        });
        l2.push(504, 0, { data: { clearUnreads: [row({ lastMsgId: "7000000000003" })] } });
        l2.push(504, 0, { data: { clearUnreads: [row({ lastMsgId: "7000000000004" })] } });
        // Red if one failing printer stops the next read from being stored.
        assert.equal(getConvState(DM).lastReadMsgId, "7000000000004");
        assert.ok(logs.some((l) => /read state: a change handler failed: printer broke/.test(l)));
    });

    it("stops reading once stopped", () => {
        sync.stop();
        listener.push(504, 0, { data: { clearUnreads: [row()] } });
        assert.equal(getConvState(DM), null);
    });
});

describe("readStateEvent -- what `listen --events read` prints", () => {
    it("names the conversation and the message it was read up to", () => {
        const read = readStateEvent({
            kind: "read",
            threadId: DM,
            isGroup: false,
            lastReadMsgId: "7000000000001",
            ts: 3,
        });
        assert.deepEqual(read.data, {
            event: "read",
            threadId: DM,
            isGroup: false,
            lastReadMsgId: "7000000000001",
            ts: 3,
        });
        assert.equal(read.human, `Read up to message 7000000000001 in ${DM}`);
        const mark = readStateEvent({ kind: "unread_mark", threadId: GROUP, isGroup: true, marked: false });
        assert.deepEqual(mark.data, { event: "unread_mark", threadId: GROUP, isGroup: true, marked: false });
        assert.equal(mark.human, `Unread mark cleared: ${GROUP}`);
    });
});

describe("`listen` and `mcp start` both store read state from their socket tap", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const taps = [];
            const syncs = [];
            walkAst(ast, (n) => {
                if (n.type === "VariableDeclarator" && n.init?.callee?.name === "createSocketTap") taps.push(n.id.name);
                if (n.type === "CallExpression" && n.callee?.name === "createReadStateSync") syncs.push(n);
            });
            // Red if one entry point stops storing read state: AGENTS.md §13 calls that asymmetry a defect.
            assert.equal(syncs.length, 1, `${file} must build one read-state sync`);
            const tapArg = syncs[0].arguments[0]?.properties?.find((p) => p.key?.name === "tap");
            assert.equal(tapArg?.value?.name, taps[0], "it must ride the daemon's socket tap");
        });
    }
});
