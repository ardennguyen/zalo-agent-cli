/**
 * The three commands that read a group's history, driven end to end offline.
 *
 * `group history`, `msg history -t 1` and `conv delete`'s anchor lookup all
 * called zca-js getGroupChatHistory, which asks {group}/api/group/history --
 * an endpoint Zalo answers with 404. Zalo Web reads a group's history from the
 * cloud-message store instead:
 *
 *   GET {group_cloud_message}/api/cm/getrecentv2?nretry=0
 *       params = AES({groupId, globalMsgId, count, msgIds, imei, src})
 *
 * (agent/work/zalo-web-capture-2026-09-29: comparison-vs-zca-js.md §3e and
 * §5.30, FINDINGS.md §13; the web client's own getCM in bundle 1 @11028626.)
 *
 * Each test runs the real command, in-process, on a real zca-js session whose
 * transport is ./fake-zalo-session.js, then asserts what went out on the wire
 * (host, path, method, decrypted params) and what the command did with the
 * answer. Two of the three consumers also read the old response in a shape
 * zca-js never returned -- an array instead of `{groupMsgs}` -- so they could
 * not have worked even on a 200; asserting their output catches that too.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getMessages } from "../../src/core/db.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serviceHost } from "./fake-zalo-session.js";

const GID = "7000000000000000001";
const MEMBER = "2000000000000000002";
/** Zalo Web's MessageConstants.MAX_MSG_ID, (BigInt(2) ** BigInt(63)).toString(). */
const NEWEST = "9223372036854775808";

/** One group message row in the socket/cloud shape (see live/socket.L1_group_echo.json). */
function row(msgId, over = {}) {
    const n = Number(msgId.slice(-3));
    return {
        actionId: String(14000000000000 + n),
        msgId,
        cliMsgId: String(1790000000000 + n),
        msgType: "webchat",
        uidFrom: MEMBER,
        idTo: GID,
        dName: "Member",
        ts: String(1790000000000 + n * 1000),
        status: 1,
        content: `text ${msgId}`,
        notify: "1",
        ttl: 0,
        ...over,
    };
}

/** getrecentv2's `data`: a JSON STRING, exactly as captured (live/group.A1.json row 2). */
function cloudPage(groupMsgs, extra = {}) {
    return JSON.stringify({
        error: 0,
        lastMsgId: "0",
        msgJumpId: "0",
        hasMore: 0,
        isOld: 0,
        isFiltered: 0,
        rootMsgId: null,
        isRootDel: 0,
        groupMsgs,
        tsJoinGroup: null,
        isFilteredByPhase: 0,
        isFilteredByTimeJoin: 0,
        ...extra,
    });
}

/** Assert the one request the web makes when a group is opened. */
function assertNewestPageRequest(req) {
    assert.ok(req, "no request reached the cloud-message store");
    assert.equal(req.method, "GET");
    assert.equal(req.host, serviceHost("group_cloud_message"));
    assert.equal(req.path, "/api/cm/getrecentv2");
    assert.equal(req.query.nretry, "0");
    assert.deepEqual(req.params, {
        groupId: GID,
        globalMsgId: NEWEST,
        count: 50,
        msgIds: [],
        imei: FAKE.imei,
        src: 1,
    });
}

describe("group history commands read Zalo's cloud-message store", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1"; // what `--json` sets in src/index.js
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    it("group history asks for the newest page and prints the newest messages first", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            cloudPage([row("8300000000002"), row("8300000000003"), row("8300000000001")]),
        );

        const r = await runCommand(registerGroupCommands, ["--json", "group", "history", GID, "-n", "2"]);

        assert.equal(fake.calls("/api/group/history").length, 0, "the retired endpoint was asked");
        assert.equal(fake.calls("/api/cm/").length, 1, `expected one store request; output: ${r.stdout}`);
        assertNewestPageRequest(fake.calls("/api/cm/")[0]);

        const out = JSON.parse(r.stdout);
        assert.equal(out.groupId, GID);
        assert.equal(out.count, 2);
        assert.deepEqual(
            out.messages.map((m) => m.msgId),
            ["8300000000003", "8300000000002"],
        );
        assert.equal(out.messages[0].content, "text 8300000000003");
        assert.equal(out.messages[0].fromUid, MEMBER);
        assert.equal(out.hasMore, true, "a third message exists beyond -n 2");
    });

    it("msg history -t 1 lists the store's messages and caches the ones it printed", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            cloudPage([row("8300000000001"), row("8300000000003"), row("8300000000002")]),
        );

        const r = await runCommand(registerMsgCommands, [
            "--json",
            "msg",
            "history",
            GID,
            "-t",
            "1",
            "-n",
            "2",
            "--no-cache",
        ]);

        assert.equal(r.exitCode, 0, `msg history failed: ${r.stdout} ${r.stderr}`);
        assert.equal(fake.calls("/api/cm/").length, 1);
        assertNewestPageRequest(fake.calls("/api/cm/")[0]);

        const out = JSON.parse(r.stdout);
        assert.equal(out.source, "live");
        assert.equal(out.threadType, "group");
        assert.deepEqual(
            out.messages.map((m) => m.msgId),
            ["8300000000003", "8300000000002"],
        );
        assert.equal(out.messages[0].text, "text 8300000000003");
        assert.equal(out.messages[0].senderId, MEMBER);

        // msg history's fetch writes what it fetched, insert-if-absent
        // (AGENTS.md §13); tests/unit/history-write-back.test.js covers the rule.
        initDb(join(CONFIG_DIR, "accounts", FAKE.ownId, "zalo.db"));
        assert.deepEqual(
            getMessages(GID, 100).map((m) => m.msgId),
            ["8300000000003", "8300000000002"],
            "the printed messages were not cached",
        );
    });

    it("msg history -t 1 still scans the socket when the store has nothing", async () => {
        // An empty cloud page does not prove an empty group: Zalo Web gates
        // cloud history on server config (cloud.enable and a flag per load
        // kind, `apiEnable` in its bundle), so the old socket fallback stays.
        // The harness refuses the socket, which is how this proves the
        // fallback was attempted.
        fake.route("/api/cm/getrecentv2", () => cloudPage([]));

        const r = await runCommand(registerMsgCommands, ["--json", "msg", "history", GID, "-t", "1", "-n", "5"]);

        assert.equal(fake.calls("/api/cm/getrecentv2").length, 1);
        assert.equal(r.exitCode, 1);
        assert.match(JSON.parse(r.stdout).error, /offline tests never open a socket/);
    });

    it("conv delete anchors on the newest real message the store reports", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            cloudPage([
                row("8300000000001"),
                // A recall event is newer than every message but is not one.
                row("8300000000004", {
                    msgType: "chat.undo",
                    content: { globalMsgId: "8300000000003", cliMsgId: "1790000000003", deleteMsg: 0 },
                }),
                // Our own message: the newest real one. Zalo marks self as uid "0".
                row("8300000000003", { uidFrom: "0" }),
                row("8300000000002"),
            ]),
        );
        fake.route("/api/group/deleteconver", () => ({}));

        const r = await runCommand(registerConvCommands, ["--json", "conv", "delete", GID, "-t", "1"]);

        assertNewestPageRequest(fake.calls("/api/cm/")[0]);
        const [del] = fake.calls("/api/group/deleteconver");
        assert.ok(del, `conv delete sent no deleteconver request; output: ${r.stdout}`);
        assert.equal(del.method, "POST");
        assert.equal(del.params.grid, GID);
        assert.deepEqual(del.params.conver, {
            ownerId: FAKE.ownId,
            cliMsgId: "1790000000003",
            globalMsgId: "8300000000003",
        });
    });
});
