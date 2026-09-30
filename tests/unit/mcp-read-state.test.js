/**
 * The account's read state on Zalo, as the MCP tools report it (M4).
 *
 * A bot has its own read cursor (`consumer`, zalo_mark_read); this is the
 * other kind of read: what the human already read on the phone or Zalo Web,
 * which the listener stores from the server's `clearUnreads` reports
 * (src/core/read-state.js). It is the signal for handing a thread back to a
 * person, so each listing tool carries it: `readOnZalo` on every message of
 * zalo_get_messages, `readState` on every thread of zalo_list_threads and
 * zalo_list_conversations.
 *
 * The handlers run against a stub buffer and a real zalo.db in the sandbox.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { initDb, insertMessage, recordReadWatermark, upsertConvState, upsertThread } from "../../src/core/db.js";

// Made-up ids, fakes by the convention in no-real-ids.test.js.
const OWN = "100000000000000071";
const OTHER = "600000000000000071";
const GROUP = "200000000000000071";
const DM = "300000000000000071";

const ROOT = mkdtempSync(join(SANDBOX_HOME, "mcp-read-state-"));
const handles = [];
let n = 0;

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    handles.push(initDb(join(ROOT, `rs${n++}.sqlite`)));
    // GROUP is read through ...002 on Zalo; DM has no report at all.
    for (const id of ["7000000000001", "7000000000002", "7000000000003"]) {
        insertMessage({ msgId: id, threadId: GROUP, senderId: OTHER, text: "t", timestamp: 1, type: "text" });
    }
    recordReadWatermark({ threadId: GROUP, msgId: "7000000000002", ts: 1700000000000 });
});
after(() => {
    for (const h of handles) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
});

/** Register the tools over a stub buffer and call one. */
function call(name, args, buffer) {
    const tools = new Map();
    const server = { registerTool: (tool, meta, handler) => tools.set(tool, handler) };
    const api = { getOwnId: () => OWN };
    registerTools(server, api, buffer, {}, { limits: {} }, { ready: true, get: () => null, search: () => [] });
    return tools.get(name)(args);
}

const payloadOf = (res) => {
    assert.ok(!res.isError, res.content?.[0]?.text);
    return JSON.parse(res.content[0].text);
};

describe("zalo_get_messages -- readOnZalo on each message", () => {
    it("is true through the watermark, false after it, and null where nothing is known", async () => {
        const buffered = [
            { id: "7000000000002", threadId: GROUP, content: "a" },
            { id: "7000000000003", threadId: GROUP, content: "b" },
            { id: "7000000000009", threadId: DM, content: "c" },
        ];
        const buffer = { read: () => ({ messages: buffered, cursor: 3 }), readCursor: () => 0 };
        const out = payloadOf(await call("zalo_get_messages", { since: 0, limit: 10 }, buffer));
        // Red if the comparison flips, or a thread with no report is called read or unread.
        assert.deepEqual(
            out.messages.map((m) => m.readOnZalo),
            [true, false, null],
        );
        assert.equal(out.cursor, 3, "the rest of the result is untouched");
        assert.equal("readOnZalo" in buffered[0], false, "the buffer's own messages are not rewritten");
    });
});

describe("zalo_list_threads -- readState on each buffered thread", () => {
    it("reports the watermark and the cached messages from others after it", async () => {
        upsertConvState({ threadId: DM, unreadMarked: true, unreadMarkedAt: 1700000000500 });
        const buffer = {
            getStats: () => [
                { threadId: GROUP, unread: 5 },
                { threadId: DM, unread: 1 },
            ],
            getThreadType: (id) => (id === GROUP ? "group" : "dm"),
            readCursor: () => 0,
        };
        const out = payloadOf(await call("zalo_list_threads", { type: "all" }, buffer));
        const byId = Object.fromEntries(out.threads.map((t) => [t.threadId, t]));
        // `unread` stays the consumer's own count; readState is the account's.
        assert.equal(byId[GROUP].unread, 5);
        assert.deepEqual(byId[GROUP].readState, {
            lastReadMsgId: "7000000000002",
            lastReadAt: new Date(1700000000000).toISOString(),
            unreadAfter: 1,
            markedUnread: false,
        });
        assert.deepEqual(byId[DM].readState, {
            lastReadMsgId: null,
            lastReadAt: null,
            unreadAfter: null,
            markedUnread: true,
        });
    });
});

describe("zalo_list_conversations -- readState on each cached conversation", () => {
    it("carries the same read state conv recent shows", async () => {
        upsertThread({ threadId: GROUP, type: "group", name: "G", lastUpdate: 1700000002000 });
        upsertThread({ threadId: DM, type: "dm", name: "D", lastUpdate: 1700000001000 });
        // A pin is conversation state too, but says nothing about reading.
        upsertConvState({ threadId: DM, pinned: true, pinnedAt: 1700000001500 });
        const buffer = { getStats: () => [], getThreadType: () => "dm", readCursor: () => 0 };
        const out = payloadOf(await call("zalo_list_conversations", { type: "all", limit: 5 }, buffer));
        assert.deepEqual(
            out.conversations.map((c) => [c.threadId, c.readState?.unreadAfter ?? null]),
            [
                [GROUP, 1],
                [DM, null],
            ],
        );
        assert.equal(out.conversations[1].readState, null, "no report, no state");
    });
});
