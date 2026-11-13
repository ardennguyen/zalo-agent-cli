/**
 * `conv unread` pins the unread mark to the conversation's newest message, as Zalo expects: the
 * newest cached message with a client id, its `cliMsgId` and sender (`"0"` for this account's own). Before, the
 * command sent only the thread id, so the mark carried the clock as a message id and `"0"` as the sender.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { initDb, insertMessage } from "../../src/core/db.js";
import { unreadMarkAnchor } from "../../src/core/receipts.js";
import { registerConvCommands } from "../../src/commands/conv.js";

const OWN = "9100000000000000001";
const MEMBER = "9400000000000000004";
let nextId = 0;
const freshThread = () => String(9300000000000000200n + BigInt(++nextId));

before(() => {
    assertSandboxed(CONFIG_DIR);
    addAccount(OWN, "Offline Test");
    const dir = join(SANDBOX_CONFIG_DIR, "accounts", OWN);
    mkdirSync(dir, { recursive: true });
    initDb(join(dir, "zalo.db"));
});

/** A cached row, newest-first order decided by `ts`. */
function row({ threadId, msgId, cliMsgId, senderId, ts, type = "text", raw = {} }) {
    return {
        msgId,
        threadId,
        senderId,
        senderName: "x",
        text: "hello",
        timestamp: ts,
        type,
        raw_data: { msgId, cliMsgId, uidFrom: senderId, ...raw },
    };
}

/** Run `zalo-agent conv unread ...` with an api that records the addUnreadMark call. */
async function unread(args) {
    const calls = [];
    const api = {
        addUnreadMark: async (...a) => {
            calls.push(a);
            return { data: { updateId: 1 }, status: 0 };
        },
    };
    const program = new Command();
    program.exitOverride();
    program.option("--json");
    registerConvCommands(program, { getApi: () => api });
    const log = mock.method(console, "log", () => {});
    const err = mock.method(console, "error", () => {});
    const savedExitCode = process.exitCode;
    try {
        await program.parseAsync(["node", "zalo-agent", "conv", "unread", ...args]);
    } finally {
        // error() sets 1; it must not become the test process's exit code.
        process.exitCode = savedExitCode;
        log.mock.restore();
        err.mock.restore();
    }
    return calls;
}

describe("conv unread: the mark names the newest cached message", () => {
    it("an incoming message: its cliMsgId and its sender's uid", async () => {
        const t = freshThread();
        insertMessage(
            row({ threadId: t, msgId: "8000000000000401", cliMsgId: "1700000000401", senderId: MEMBER, ts: 1 }),
        );
        insertMessage(
            row({ threadId: t, msgId: "8000000000000402", cliMsgId: "1700000000402", senderId: MEMBER, ts: 2 }),
        );
        const calls = await unread([t, "-t", "1"]);
        // Red if the command still passed the thread alone (the mark would name no message).
        assert.deepEqual(calls, [[t, 1, { cliMsgId: "1700000000402", fromUid: MEMBER }]]);
    });

    it('our own message: fromUid "0", Zalo\'s name for this account', async () => {
        const t = freshThread();
        insertMessage(row({ threadId: t, msgId: "8000000000000501", cliMsgId: "1700000000501", senderId: OWN, ts: 5 }));
        const calls = await unread([t]);
        assert.deepEqual(calls, [[t, 0, { cliMsgId: "1700000000501", fromUid: "0" }]]);
    });

    it('an empty cache: null, so "-1" goes out', async () => {
        const t = freshThread();
        const calls = await unread([t]);
        assert.deepEqual(calls, [[t, 0, null]]);
    });
});

describe("unreadMarkAnchor", () => {
    const at = (over) => ({
        msgId: "8000000000000601",
        senderId: MEMBER,
        type: "text",
        raw_data: JSON.stringify({ cliMsgId: "1700000000601" }),
        ...over,
    });

    it("passes over a tombstone, a system line and a row with no client id", () => {
        const rows = [
            at({ type: "deleted" }),
            at({ msgId: "ge:1700000000700" }),
            at({ raw_data: JSON.stringify({ cliMsgId: "0" }) }),
            at({}),
        ];
        assert.deepEqual(unreadMarkAnchor(rows, { ownId: OWN }), { cliMsgId: "1700000000601", fromUid: MEMBER });
    });

    it('a raw frame\'s uidFrom "0" is this account even when the row says otherwise', () => {
        const rows = [at({ senderId: "", raw_data: JSON.stringify({ cliMsgId: "1700000000601", uidFrom: "0" }) })];
        assert.deepEqual(unreadMarkAnchor(rows, { ownId: OWN }), { cliMsgId: "1700000000601", fromUid: "0" });
    });

    it("stops at a newest row whose sender is a noised id rather than marking an older message", () => {
        const rows = [at({ senderId: "NOISEDNOISEDNOISEDNOISEDNOISED00" }), at({ msgId: "8000000000000600" })];
        assert.equal(unreadMarkAnchor(rows, { ownId: OWN }), null);
    });

    it("nothing cached: null", () => {
        assert.equal(unreadMarkAnchor([], { ownId: OWN }), null);
        assert.equal(unreadMarkAnchor(undefined, { ownId: OWN }), null);
    });
});
