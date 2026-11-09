/**
 * zalo_get_history: no `limit` means every message (owner rule: a result is limited only when the caller pages), and a
 * DM with nothing cached is not scanned off the socket unless `scan` asks.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, insertMessage } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

before(() => assertSandboxed(CONFIG_DIR));

const PEER = "3000000000000000101";
const EMPTY_PEER = "3000000000000000102";

/** An api that answers names and fails the test if anything asks the socket for old messages. */
function api() {
    const scans = [];
    return {
        scans,
        getAliasList: async () => ({ items: [] }),
        getUserInfo: async (ids) => ({
            changed_profiles: Object.fromEntries(ids.map((id) => [id, { zaloName: "P" }])),
        }),
        listener: {
            requestOldMessages: (...a) => scans.push(a),
            on() {},
            removeListener() {},
        },
    };
}

function tools(a) {
    const handlers = new Map();
    registerTools({ registerTool: (n, _m, h) => handlers.set(n, h) }, a, {}, {}, {}, { get: () => null });
    return async (args) => JSON.parse((await handlers.get("zalo_get_history")(args)).content[0].text);
}

describe("zalo_get_history with no limit", () => {
    let db;
    let seq = 0;
    beforeEach(() => {
        db = initDb(join(SANDBOX_CONFIG_DIR, `mcp-history-all-${seq++}.sqlite`));
        for (let i = 0; i < 260; i++) {
            insertMessage({
                msgId: `hist-${i}`,
                threadId: PEER,
                senderId: PEER,
                senderName: "P",
                text: `m${i}`,
                timestamp: 1_000_000 + i,
                type: "text",
                raw_data: {},
            });
        }
    });
    afterEach(() => db.close());

    it("returns every cached message (past the old 50 default and 200 page cap)", async () => {
        const read = tools(api());
        const all = await read({ threadId: PEER, threadType: "dm" });
        assert.equal(all.count, 260);
        assert.equal(all.hasMore, false);
        const page = await read({ threadId: PEER, threadType: "dm", limit: 20 });
        assert.equal(page.count, 20);
        assert.equal(page.hasMore, true);
        const period = await read({ threadId: PEER, threadType: "dm", since: 1_000_010 });
        assert.equal(period.count, 250);
    });

    it("does not scan the socket for an uncached DM unless `scan` is given", async () => {
        const a = api();
        const r = await tools(a)({ threadId: EMPTY_PEER, threadType: "dm" });
        // Red under the old behavior: the server path scanned the socket's old-message stream for a DM.
        assert.equal(a.scans.length, 0);
        assert.equal(r.count, 0);
        assert.match(r.note, /no server history for a 1-1 conversation/);
    });
});
