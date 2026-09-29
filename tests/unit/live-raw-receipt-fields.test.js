/**
 * The listener must keep `st`, `at` and `cmd` from the socket frame in raw_data.
 *
 * A seen or delivered receipt names each message by nine fields, and three of
 * them -- `st`, `at`, `cmd` -- exist nowhere but on the socket frame that
 * delivered the message. Zalo Web echoes them back verbatim: the captured
 * group seenv2 carried `"st":3,"at":0,"cmd":521`, the DM one `"st":3,"at":9,
 * "cmd":501`, and `at` differs from message to message (5 for plain text, 0
 * for a card, 9 elsewhere). So a value cannot be reconstructed later; it can
 * only be kept.
 *
 * `classifyLiveMessage` used to drop all three, which left `conv read` with
 * nothing but a guess for every message the listener had ever cached. The
 * frame below is the captured own-echo group frame (live/socket.L1_group_echo)
 * with its ids replaced by fake ones.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GroupMessage, UserMessage } from "zca-js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getMessages } from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { classifyLiveMessage } from "../../src/core/sync-v2/message-types.js";

// Fake ids. Real ones never appear in tests (AGENTS.md §12).
const OWN = "9100000000000000001";
const GRID = "9200000000000000002";
const PEER = "9300000000000000003";

/** A 521 row exactly as the socket delivers it, from live/socket.L1_group_echo.json. */
function groupFrame(over = {}) {
    return {
        actionId: "14000000000001",
        msgId: "8000000000101",
        cliMsgId: "1700000000101",
        msgType: "webchat",
        uidFrom: "0",
        idTo: GRID,
        dName: "Test Owner",
        ts: "1700000000150",
        status: 1,
        content: "zcap L1 listener echo group",
        notify: "1",
        ttl: 0,
        userId: "0",
        uin: "0",
        topOut: "0",
        topOutTimeOut: "0",
        topOutImprTimeOut: "0",
        propertyExt: { color: 0, size: 0, type: 0, subType: 0, ext: '{"shouldParseLinkOrContact":0}' },
        paramsExt: { countUnread: 1, containType: 0, platformType: 1 },
        cmd: 521,
        st: 3,
        at: 5,
        realMsgId: "0",
        ...over,
    };
}

before(() => {
    assertSandboxed(CONFIG_DIR);
});

describe("classifyLiveMessage keeps the receipt fields the frame carries", () => {
    it("records st, at and cmd exactly as the frame gives them", () => {
        const raw = classifyLiveMessage(groupFrame()).raw;
        assert.equal(raw.st, 3);
        assert.equal(raw.at, 5);
        assert.equal(raw.cmd, 521);
    });

    it("keeps a zero, which is a real value and not an absence", () => {
        // The captured card receipts carry "at":0. Dropping falsy values would
        // turn every one of them into a guess.
        const raw = classifyLiveMessage(groupFrame({ msgType: "chat.ecard", at: 0 })).raw;
        assert.equal(raw.at, 0);
        assert.equal(raw.st, 3);
    });

    it("keeps the DM command too", () => {
        const raw = classifyLiveMessage(groupFrame({ uidFrom: PEER, idTo: "0", cmd: 501, at: 9 })).raw;
        assert.equal(raw.cmd, 501);
        assert.equal(raw.at, 9);
    });

    it("adds no null noise when a frame lacks them", () => {
        const frame = groupFrame();
        delete frame.st;
        delete frame.at;
        delete frame.cmd;
        const raw = classifyLiveMessage(frame).raw;
        for (const k of ["st", "at", "cmd"]) {
            assert.equal(Object.hasOwn(raw, k) && raw[k] !== undefined, false, `${k} must be absent, not null`);
        }
    });
});

describe("the listener's own write path stores them in zalo.db", () => {
    before(() => {
        const dir = join(SANDBOX_CONFIG_DIR, "accounts", OWN);
        mkdirSync(dir, { recursive: true });
        initDb(join(dir, "zalo.db"));
    });

    it("a group echo written by storeLiveMessage reads back with st/at/cmd", () => {
        // GroupMessage is zca-js's own model: this is the object `listen` and
        // `mcp start` receive for a 521 frame.
        const r = storeLiveMessage(new GroupMessage(OWN, groupFrame()));
        assert.equal(r.stored, true, r.reason);
        const [row] = getMessages(GRID, 1);
        const raw = JSON.parse(row.raw_data);
        assert.deepEqual({ st: raw.st, at: raw.at, cmd: raw.cmd }, { st: 3, at: 5, cmd: 521 });
    });

    it("an incoming DM written by storeLiveMessage reads back with st/at/cmd", () => {
        const frame = groupFrame({
            msgId: "8000000000102",
            cliMsgId: "1700000000102",
            uidFrom: PEER,
            idTo: "0",
            cmd: 501,
            at: 9,
        });
        const r = storeLiveMessage(new UserMessage(OWN, frame));
        assert.equal(r.stored, true, r.reason);
        const [row] = getMessages(PEER, 1);
        const raw = JSON.parse(row.raw_data);
        assert.deepEqual({ st: raw.st, at: raw.at, cmd: raw.cmd }, { st: 3, at: 9, cmd: 501 });
    });
});
