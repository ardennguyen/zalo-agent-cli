/**
 * `src/core/sync-v2/conv-state.js` — pinned and unread-marked conversations.
 *
 * Both input shapes below were measured against a live account, and both
 * would have written nothing correct if taken at face value:
 *
 *  - getPinConversations() returns ids PREFIXED with the thread kind:
 *    `g<groupId>`, `u<userId>`. As-is, 0 of 2 resolved against the cache.
 *  - getUnreadMark() returns ids as JSON NUMBERS. A 19-digit thread id is past
 *    Number.MAX_SAFE_INTEGER, so it arrives rounded (4546985820537230880 ->
 *    4546985820537231000). It can only be matched, never read back exactly.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, upsertThread, getConvState } from "../../src/core/db.js";
import { parsePinnedId, resolveLossyThreadId, syncConvState } from "../../src/core/sync-v2/conv-state.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-convstate-"));
const opened = [];
let n = 0;

// Fictional ids of the real length -- long enough to lose precision.
const G1 = "4546985820537230880";
const G2 = "3183269580055261719";
const U1 = "7893245679818986672";

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
    upsertThread({ threadId: G1, type: "group", name: "g1", lastUpdate: 3 });
    upsertThread({ threadId: G2, type: "group", name: "g2", lastUpdate: 2 });
    upsertThread({ threadId: U1, type: "dm", name: "u1", lastUpdate: 1 });
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

/** An api answering the way the live one did. */
const api = ({ pins = [], group = [], user = [], pinErr, unreadErr } = {}) => ({
    getPinConversations: async () => {
        if (pinErr) throw new Error(pinErr);
        return { conversations: pins, otherTabConvs: [], version: 1 };
    },
    getUnreadMark: async () => {
        if (unreadErr) throw new Error(unreadErr);
        return { data: { convsGroup: group, convsUser: user }, status: 0 };
    },
});
const mark = (id, ts = 1_750_000_000_000) => ({ id, cliMsgId: String(ts), fromUid: -1, ts });

describe("parsePinnedId", () => {
    it("strips the kind prefix Zalo puts on pinned ids", () => {
        assert.deepEqual(parsePinnedId(`g${G1}`), { threadId: G1, type: "group" });
        assert.deepEqual(parsePinnedId(`u${U1}`), { threadId: U1, type: "dm" });
    });

    it("leaves an unprefixed id alone", () => {
        assert.deepEqual(parsePinnedId(G1), { threadId: G1, type: null });
    });
});

describe("resolveLossyThreadId", () => {
    const threads = [
        { threadId: G1, type: "group" },
        { threadId: U1, type: "dm" },
    ];

    it("recovers the thread from the rounded number the live api returned", () => {
        const lossy = Number(G1);
        assert.notEqual(String(lossy), G1, "precondition: the id really is lossy as a number");
        assert.deepEqual(resolveLossyThreadId(lossy, threads, "group"), { threadId: G1 });
    });

    it("refuses to guess between two ids that round to the same number", () => {
        // Differ only in the last digits, which a double cannot hold.
        const twins = [
            { threadId: "4546985820537230880", type: "group" },
            { threadId: "4546985820537230881", type: "group" },
        ];
        assert.equal(Number(twins[0].threadId), Number(twins[1].threadId), "precondition: they collide");
        assert.deepEqual(resolveLossyThreadId(Number(twins[0].threadId), twins, "group"), {
            threadId: null,
            why: "ambiguous",
        });
    });

    it("takes a string id literally when the cache has it", () => {
        assert.deepEqual(resolveLossyThreadId(G1, threads, "group"), { threadId: G1 });
    });

    it("does not match across kinds", () => {
        assert.deepEqual(resolveLossyThreadId(Number(U1), threads, "group"), { threadId: null, why: "unknown" });
    });
});

describe("syncConvState", () => {
    it("writes pinned conversations under their real thread id", async () => {
        const st = await syncConvState({ api: api({ pins: [`g${G1}`, `g${G2}`] }) });
        assert.equal(st.pinned, 2);
        assert.equal(getConvState(G1).pinned, 1);
        assert.equal(getConvState(G2).pinned, 1);
    });

    it("writes an unread mark whose id arrived rounded", async () => {
        const st = await syncConvState({ api: api({ group: [mark(Number(G1))] }) });
        assert.equal(st.unread, 1);
        assert.equal(getConvState(G1).unreadMarked, 1);
    });

    it("unpins and unmarks what was cleared on another device", async () => {
        await syncConvState({ api: api({ pins: [`g${G1}`], group: [mark(Number(G1))] }) });
        const st = await syncConvState({ api: api({ pins: [], group: [] }) });
        assert.equal(st.unpinned, 1);
        assert.equal(st.unmarked, 1);
        assert.equal(getConvState(G1).pinned, 0);
        assert.equal(getConvState(G1).unreadMarked, 0);
    });

    it("does not unpin everything when the pin list fails to load", async () => {
        // One failed request says nothing about what is pinned.
        await syncConvState({ api: api({ pins: [`g${G1}`] }) });
        const st = await syncConvState({ api: api({ pinErr: "timeout" }) });
        assert.equal(st.unpinned, 0);
        assert.equal(getConvState(G1).pinned, 1);
        assert.equal(st.failures[0].what, "pinned");
    });

    it("counts a conversation the cache has never seen, and writes nothing for it", async () => {
        const st = await syncConvState({ api: api({ pins: ["g1111111111111111111"] }) });
        assert.equal(st.pinned, 0);
        assert.equal(st.unresolved, 1);
        assert.deepEqual(getConvState(), []);
    });
});
