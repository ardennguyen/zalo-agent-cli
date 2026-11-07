/**
 * `conv read`, `conv pin`/`unpin` and `conv archive`/`unarchive`, driven through
 * the real command handlers down to the request that reaches Zalo.
 *
 * Each command is parsed by commander exactly as the CLI parses it, with one
 * substitution: the Zalo api is the engine's own session object
 * (src/zalo/api.js), built on a context whose fetch is a fake transport that
 * decrypts every request with a throwaway key. What is asserted is that decrypted request -- host, path,
 * method, params -- compared with a capture of the real Zalo Web client
 * (build 826674fb31d2af1b2b59, zpw_ver 691). Templates name their capture row.
 *
 * `conv read` also reads the local cache, so its rows are written the way the
 * listener writes them: a listener message model through storeLiveMessage().
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { GroupMessage, UserMessage } from "../../src/zalo/listener/models.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { initDb, insertMessage, recordReactionMark, recordReadWatermark, upsertConvState } from "../../src/core/db.js";
import { seenMessages } from "../../src/core/receipts.js";
import { CONVERSATION_ACTIONS } from "../../src/mcp/actions-conversation.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { createApi } from "../../src/zalo/api.js";
import { openSession, sealSession } from "../../src/zalo/kernel/cipher.js";

/** Obviously-fake 16-byte AES key and imei (AGENTS.md §12). */
const SECRET_KEY = Buffer.from("0123456789abcdef").toString("base64");
const IMEI = "test-imei-0000";

// Fake ids. Each test uses its own conversation so the shared cache cannot leak between them.
const OWN = "9100000000000000001";
const MEMBER = "9400000000000000004";
let nextId = 0;
const freshGroup = () => String(9200000000000000100n + BigInt(++nextId));
const freshPeer = () => String(9300000000000000100n + BigInt(++nextId));

const HOSTS = {
    chat: "https://tt-chat.test.invalid",
    group: "https://tt-group.test.invalid",
    conversation: "https://tt-convers.test.invalid",
    label: "https://label.test.invalid",
    reaction: "https://reaction.test.invalid",
    auth: "https://auth.test.invalid",
};

/**
 * A logged-in session on a fake transport, whose requests are recorded decrypted.
 *
 * @param {(rec: object) => any} [respond] - the response `data` for a request, or
 *   `{ zaloError: {code, message} }`
 */
function harness(respond = () => ({ status: 0 })) {
    const sent = [];
    const ctx = {
        secretKey: SECRET_KEY,
        imei: IMEI,
        uid: OWN,
        userAgent: "zalo-agent-cli-offline-test",
        API_VERSION: 685,
        API_TYPE: 30,
        options: {
            logging: false,
            async polyfill(url, init = {}) {
                const u = new URL(url);
                const enc =
                    init.body instanceof URLSearchParams ? init.body.get("params") : u.searchParams.get("params");
                const plain = enc ? openSession(SECRET_KEY, enc) : null;
                const rec = {
                    method: init.method || "GET",
                    origin: u.origin,
                    path: u.pathname,
                    query: Object.fromEntries([...u.searchParams].filter(([k]) => k !== "params")),
                    plain,
                    params: plain ? JSON.parse(plain) : null,
                };
                sent.push(rec);
                const data = await respond(rec);
                const body = data?.zaloError
                    ? { error_code: data.zaloError.code, error_message: data.zaloError.message }
                    : {
                          error_code: 0,
                          error_message: "Successful.",
                          data: sealSession(SECRET_KEY, JSON.stringify({ error_code: 0, error_message: "", data })),
                      };
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        },
    };
    const serviceMap = Object.fromEntries(Object.entries(HOSTS).map(([k, v]) => [k, [v]]));
    const api = createApi(ctx, serviceMap, [], { createListener: () => new EventEmitter() });
    return { api, sent };
}

class ExitCalled extends Error {
    constructor(code) {
        super(`process.exit(${code})`);
        this.code = code;
    }
}

/**
 * Run `zalo-agent conv ...` through commander with the harness api injected.
 *
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null}>}
 */
async function conv(args, api, { json = false } = {}) {
    const program = new Command();
    program.exitOverride();
    program.option("--json");
    registerConvCommands(program, { getApi: () => api });
    const out = [];
    const err = [];
    const log = mock.method(console, "log", (...a) => out.push(a.join(" ")));
    const error = mock.method(console, "error", (...a) => err.push(a.join(" ")));
    const exit = mock.method(process, "exit", (code) => {
        throw new ExitCalled(code);
    });
    const prevJsonMode = process.env.ZALO_JSON_MODE;
    if (json) process.env.ZALO_JSON_MODE = "1";
    let exitCode = null;
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        await program.parseAsync(["node", "zalo-agent", ...(json ? ["--json"] : []), "conv", ...args]);
    } catch (e) {
        if (!(e instanceof ExitCalled)) throw e;
        exitCode = e.code;
    } finally {
        // error() sets 1 without exiting; count it, and keep it off the test process.
        if (exitCode === null && process.exitCode) exitCode = process.exitCode;
        process.exitCode = savedExitCode;
        log.mock.restore();
        error.mock.restore();
        exit.mock.restore();
        if (json) {
            if (prevJsonMode === undefined) delete process.env.ZALO_JSON_MODE;
            else process.env.ZALO_JSON_MODE = prevJsonMode;
        }
    }
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

const find = (sent, path) => sent.filter((r) => r.path === path);
const hasSuccessLine = (text) => /^\s*✓\s/m.test(text);
const errorLine = (text) => text.match(/^\s*✗\s*(.+)$/m)?.[1] ?? null;

function fill(template, values) {
    return template.replace(/<(\w+)>/g, (_, k) => {
        assert.ok(k in values, `template placeholder <${k}> has no value`);
        return values[k];
    });
}

/** A 501/521 row shaped like live/socket.L1_group_echo.json. */
function frame(over = {}) {
    return {
        actionId: "14000000000001",
        msgId: "8000000000101",
        cliMsgId: "1700000000101",
        msgType: "webchat",
        uidFrom: MEMBER,
        idTo: "0",
        dName: "Someone",
        ts: "1700000000150",
        status: 1,
        content: "hello",
        notify: "1",
        ttl: 0,
        propertyExt: { color: 0, size: 0, type: 0, subType: 0, ext: '{"shouldParseLinkOrContact":0}' },
        paramsExt: { countUnread: 1, containType: 0, platformType: 1 },
        cmd: 521,
        st: 3,
        at: 5,
        realMsgId: "0",
        ...over,
    };
}

/** Write a row the way the listener does. */
function listenerWrites(msg) {
    const r = storeLiveMessage(msg);
    assert.equal(r.stored, true, r.reason);
}

// ---- Captured plaintexts, ids replaced by <placeholders> ---------------------

/** group.A13_create_reminder row 2's shape, for a message from another member. */
const GROUP_SEEN = String.raw`{"msgInfos":"{\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"<si>\",\"di\":\"<grid>\",\"mt\":\"<mt>\",\"st\":<st>,\"at\":<at>,\"cmd\":521,\"ts\":\"<ts>\"}],\"grid\":\"<grid>\"}","imei":"<imei>"}`;

/** dm.D13_reminder row 1. */
const DM_SEEN = String.raw`{"msgInfos":"{\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"<peer>\",\"di\":\"0\",\"mt\":\"webchat\",\"st\":<st>,\"at\":<at>,\"cmd\":501,\"ts\":\"<ts>\"}],\"senderId\":\"<peer>\"}","imei":"<imei>"}`;

/** group.C1_pin_conv / C1b_unpin_conv and dm.C1_pin_conv / C1b_unpin_conv. */
const PIN = String.raw`{"actionType":<action>,"conversations":["<conv>"],"tab":0}`;

/** group.C4_move_to_other row 0 / C4b_move_to_focused, dm.C4_move_to_other / C4b_move_to_focused. */
const ARCHIVE = String.raw`{"ids":[{"id":"<id>","type":<type>}],"version":<version>,"actionType":<action>,"imei":"<imei>"}`;

before(() => {
    assertSandboxed(CONFIG_DIR);
    addAccount(OWN, "Offline Test");
    const dir = join(SANDBOX_CONFIG_DIR, "accounts", OWN);
    mkdirSync(dir, { recursive: true });
    initDb(join(dir, "zalo.db"));
});

describe("conv read — clears the manual unread mark AND sends the web's seenv2", () => {
    it("group: removeUnreadMark, then a seenv2 carrying the frame's real st/at/cmd", async () => {
        const grid = freshGroup();
        // at 9, a captured webchat value (group.A13 row 3), deliberately NOT the
        // fallback's 5: only a value from the frame can put it on the wire.
        listenerWrites(
            new GroupMessage(
                OWN,
                frame({ idTo: grid, msgId: "8000000000201", cliMsgId: "1700000000201", ts: "1700000000250", at: 9 }),
            ),
        );
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1"], api);

        const [unread] = find(sent, "/api/conv/removeUnreadMark");
        assert.ok(unread, "conv read must clear the manual unread flag -- it is what undoes `conv unread`");
        assert.equal(unread.method, "POST");
        assert.equal(unread.origin, HOSTS.conversation);
        const param = JSON.parse(unread.params.param);
        assert.equal(typeof param.convsGroupData[0].ts, "number");
        param.convsGroupData[0].ts = "<ts>";
        // group.C3c_mark_read_menu, compared structurally: the previous engine builds it and owns its key order.
        assert.deepEqual(param, {
            convsGroup: [grid],
            convsUser: [],
            convsGroupData: [{ id: grid, ts: "<ts>" }],
            convsUserData: [],
        });

        const [seen] = find(sent, "/api/group/seenv2");
        assert.ok(seen, "a group seenv2 must go out");
        assert.equal(seen.method, "POST");
        assert.equal(seen.origin, HOSTS.group);
        assert.equal(seen.query.nretry, "0");
        assert.equal(
            seen.plain,
            fill(GROUP_SEEN, {
                cmi: "1700000000201",
                gmi: "8000000000201",
                si: MEMBER,
                grid,
                mt: "webchat",
                st: "3",
                at: "9",
                ts: "1700000000250",
                imei: IMEI,
            }),
        );
        assert.equal(errorLine(r.stdout), null, r.stdout);
        assert.ok(hasSuccessLine(r.stdout), r.stdout);
        assert.equal(r.exitCode, null);
    });

    it('DM: a seenv2 with senderId and imei, di "0", and the frame\'s at', async () => {
        const peer = freshPeer();
        listenerWrites(
            new UserMessage(
                OWN,
                frame({
                    uidFrom: peer,
                    idTo: "0",
                    cmd: 501,
                    at: 9,
                    msgId: "8000000000301",
                    cliMsgId: "1700000000301",
                    ts: "1700000000301",
                }),
            ),
        );
        const { api, sent } = harness();
        const r = await conv(["read", peer], api);

        const [unread] = find(sent, "/api/conv/removeUnreadMark");
        assert.ok(unread);
        const param = JSON.parse(unread.params.param);
        assert.deepEqual(param.convsUser, [peer]);
        assert.deepEqual(param.convsGroup, []);

        const [seen] = find(sent, "/api/message/seenv2");
        assert.ok(seen, "a DM seenv2 must go out");
        assert.equal(seen.origin, HOSTS.chat);
        assert.equal(seen.query.nretry, "0");
        assert.equal(
            seen.plain,
            fill(DM_SEEN, {
                cmi: "1700000000301",
                gmi: "8000000000301",
                peer,
                st: "3",
                at: "9",
                ts: "1700000000301",
                imei: IMEI,
            }),
        );
        assert.equal(errorLine(r.stdout), null, r.stdout);
    });

    it("anchors on the newest INCOMING message, skipping our own and rows Zalo cannot identify", async () => {
        const grid = freshGroup();
        // Oldest: the one that must be chosen.
        listenerWrites(
            new GroupMessage(
                OWN,
                frame({ idTo: grid, msgId: "8000000000401", cliMsgId: "1700000000401", ts: "1700000000401" }),
            ),
        );
        // Newer: a system-line placeholder, which has no real msgId or cliMsgId.
        insertMessage({
            msgId: `ge:${grid}:1700000000402:update`,
            threadId: grid,
            senderId: MEMBER,
            senderName: "",
            text: "[group_event update]",
            timestamp: 1700000000402,
            type: "group_event",
            raw_data: { src: "listen", msgType: "group.update" },
            has_attachment: false,
        });
        // Newest: our own echo.
        listenerWrites(
            new GroupMessage(
                OWN,
                frame({
                    uidFrom: "0",
                    idTo: grid,
                    msgId: "8000000000403",
                    cliMsgId: "1700000000403",
                    ts: "1700000000403",
                }),
            ),
        );
        const { api, sent } = harness();
        await conv(["read", grid, "-t", "1"], api);
        const [seen] = find(sent, "/api/group/seenv2");
        assert.ok(seen);
        const [entry] = JSON.parse(seen.params.msgInfos).data;
        assert.equal(entry.gmi, "8000000000401");
        assert.equal(entry.si, MEMBER);
    });

    it("a row cached before st/at were kept gets the labelled fallback: cmd from the thread type, st 3, at 5", async () => {
        const grid = freshGroup();
        insertMessage({
            msgId: "8000000000501",
            threadId: grid,
            senderId: MEMBER,
            senderName: "",
            text: "older listener row",
            timestamp: 1700000000501,
            type: "text",
            raw_data: { src: "listen", msgType: "webchat", cliMsgId: "1700000000501", content: "older listener row" },
            has_attachment: false,
        });
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1"], api, { json: true });
        const [seen] = find(sent, "/api/group/seenv2");
        assert.ok(seen);
        const [entry] = JSON.parse(seen.params.msgInfos).data;
        assert.deepEqual({ st: entry.st, at: entry.at, cmd: entry.cmd }, { st: 3, at: 5, cmd: 521 });
        // --json: stdout is one JSON value, and it says which fields were guessed.
        const result = JSON.parse(r.stdout);
        assert.equal(result.seen.sent, 1);
        assert.deepEqual(result.seen.guessed.sort(), ["at", "st"]);
    });

    it("a cold cache still clears the unread mark, then refuses the seen receipt and exits 1", async () => {
        const grid = freshGroup();
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1"], api);
        assert.equal(find(sent, "/api/conv/removeUnreadMark").length, 1, "the manual flag needs no anchor");
        assert.equal(find(sent, "/api/group/seenv2").length, 0, "no message to anchor a seen receipt on");
        assert.equal(r.exitCode, 1);
        assert.doesNotMatch(r.stdout, /Marked as read/i, "must never claim success it did not achieve");
        assert.match(r.stdout, /listen/);
        assert.match(r.stdout, /sync/);
    });

    it("refuses to build a seen receipt on a sync-restored row whose sender id is noised", async () => {
        // transfer-sync-v2 stores the protobuf's noised sender id. It is not a
        // uid Zalo accepts as `si`, and it may even be our own id in disguise.
        const grid = freshGroup();
        insertMessage({
            msgId: "8000000000601",
            threadId: grid,
            senderId: "ZZNOISEDSENDERIDFORTESTSONLY0000",
            senderName: "",
            text: "restored",
            timestamp: 1700000000601,
            type: "text",
            raw_data: { src: "sync-v2", msgType: 0, cliMsgId: "1700000000601", content: "restored" },
            has_attachment: false,
        });
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1"], api);
        assert.equal(find(sent, "/api/conv/removeUnreadMark").length, 1);
        assert.equal(find(sent, "/api/group/seenv2").length, 0);
        assert.equal(r.exitCode, 1);
    });

    it("reports a failed unread-mark call without hiding the seen receipt that worked", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000000701", cliMsgId: "1700000000701" })));
        const { api, sent } = harness((rec) =>
            rec.path === "/api/conv/removeUnreadMark"
                ? { zaloError: { code: 114, message: "Tham số không hợp lệ" } }
                : { status: 0 },
        );
        const r = await conv(["read", grid, "-t", "1"], api);
        assert.equal(find(sent, "/api/group/seenv2").length, 1);
        assert.match(errorLine(r.stdout) ?? "", /114|Tham số|unread/i);
        assert.ok(hasSuccessLine(r.stdout), "the seen receipt did succeed and must say so");
    });
});

describe('conv read — Zalo Web\'s "Mark as read": every unread message, reactions, the mark only when set', () => {
    it("sends one seenv2 for every cached incoming message after the read watermark, oldest first", async () => {
        const grid = freshGroup();
        for (const [i, id] of ["8000000000801", "8000000000802", "8000000000803", "8000000000804"].entries()) {
            listenerWrites(
                new GroupMessage(
                    OWN,
                    frame({ idTo: grid, msgId: id, cliMsgId: `170000000080${i}`, ts: `17000000008${i}0` }),
                ),
            );
        }
        recordReadWatermark({ threadId: grid, msgId: "8000000000802" });
        // Known clear: Zalo Web removes the mark only when it is set.
        upsertConvState({ threadId: grid, unreadMarked: false });
        const { api, sent } = harness((rec) =>
            rec.path === "/api/setting/me" ? { display_seen_status: 1 } : { status: 0 },
        );
        const r = await conv(["read", grid, "-t", "1"], api, { json: true });
        const seen = find(sent, "/api/group/seenv2");
        assert.equal(seen.length, 1, "one call for the batch");
        // Red if the watermark is ignored (801, 802 would be there) or the order is newest first.
        assert.deepEqual(
            JSON.parse(seen[0].params.msgInfos).data.map((e) => e.gmi),
            ["8000000000803", "8000000000804"],
        );
        assert.equal(find(sent, "/api/conv/removeUnreadMark").length, 0, "the mark is known clear: nothing to remove");
        const out = JSON.parse(r.stdout);
        assert.equal(out.success, true);
        assert.equal(out.seen.sent, 2);
        assert.equal(out.unreadMark.wasSet, false);
        assert.equal(out.senderReceipt, "visible");
        assert.match(out.note, /Seen/);
        assert.equal(r.exitCode, null);
    });

    it("leaves out end-to-end encrypted messages and counts them", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000000901", cliMsgId: "1700000000901" })));
        insertMessage({
            msgId: "8000000000902",
            threadId: grid,
            senderId: MEMBER,
            senderName: "",
            text: "",
            timestamp: 1700000000902,
            type: "text",
            raw_data: { src: "listen", msgType: "chat.e2ee.text", cliMsgId: "1700000000902", undecryptable: true },
            has_attachment: false,
        });
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1"], api, { json: true });
        const [seen] = find(sent, "/api/group/seenv2");
        assert.deepEqual(
            JSON.parse(seen.params.msgInfos).data.map((e) => e.gmi),
            ["8000000000901"],
        );
        assert.equal(JSON.parse(r.stdout).seen.skipped.e2ee, 1);
    });

    it("sends react_seen for an unread reaction, and not once it is reported seen", async () => {
        const peer = freshPeer();
        listenerWrites(
            new UserMessage(OWN, frame({ uidFrom: peer, cmd: 501, msgId: "8000000001001", cliMsgId: "1700000001001" })),
        );
        recordReactionMark({ threadId: peer, column: "reactUnreadId", msgId: "8000000001005" });
        const first = harness();
        await conv(["read", peer], first.api, { json: true });
        const [react] = find(first.sent, "/api/message/react_seen");
        assert.ok(react, "an unread reaction must be marked seen");
        assert.equal(react.origin, HOSTS.reaction);
        assert.deepEqual(react.params.seenInfos, [{ msgIds: ["8000000001005"], uid: peer }]);
        assert.equal(react.params.imei, IMEI);

        recordReactionMark({ threadId: peer, column: "reactSeenId", msgId: "8000000001005" });
        const again = harness();
        await conv(["read", peer], again.api, { json: true });
        assert.equal(find(again.sent, "/api/message/react_seen").length, 0);
    });

    it("--mark-only sends only removeUnreadMark and says the real unread count stays", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001101", cliMsgId: "1700000001101" })));
        upsertConvState({ threadId: grid, unreadMarked: false });
        const { api, sent } = harness();
        const r = await conv(["read", grid, "-t", "1", "--mark-only"], api, { json: true });
        assert.deepEqual(
            sent.map((s) => s.path),
            ["/api/conv/removeUnreadMark"],
            "red if a seen receipt or a settings read goes out",
        );
        const out = JSON.parse(r.stdout);
        assert.equal(out.markOnly, true);
        assert.equal(out.seen, null);
        assert.match(out.note, /real unread count stays/);
    });

    it("reports hidden when this account's seen status is hidden", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001201", cliMsgId: "1700000001201" })));
        const { api } = harness((rec) => (rec.path === "/api/setting/me" ? { display_seen_status: 0 } : { status: 0 }));
        const out = JSON.parse((await conv(["read", grid, "-t", "1"], api, { json: true })).stdout);
        assert.equal(out.senderReceipt, "hidden");
        assert.match(out.note, /Received/);
    });

    it("zalo_conversation `read` answers the same JSON as `conv read --json`", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001301", cliMsgId: "1700000001301" })));
        upsertConvState({ threadId: grid, unreadMarked: true });
        const viaCli = JSON.parse((await conv(["read", grid, "-t", "1"], harness().api, { json: true })).stdout);
        const ctx = {
            api: harness().api,
            ownId: () => OWN,
            threadType: () => 1,
            threadTypeName: (t) => (Number(t) === 1 ? "group" : "dm"),
        };
        const viaMcp = await CONVERSATION_ACTIONS.read.run({ threadId: grid, threadType: "group" }, ctx);
        assert.deepEqual(viaMcp, viaCli);
        assert.equal(viaCli.unreadMark.removed, true);
    });
});

describe("msg seen / zalo_conversation `seen` — chosen messages, no unread mark", () => {
    it("marks the named cached messages seen and says which it could not", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001401", cliMsgId: "1700000001401" })));
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001402", cliMsgId: "1700000001402" })));
        listenerWrites(
            new GroupMessage(
                OWN,
                frame({ uidFrom: "0", idTo: grid, msgId: "8000000001403", cliMsgId: "1700000001403" }),
            ),
        );
        const { api, sent } = harness();
        const r = await seenMessages(api, {
            threadId: grid,
            type: 1,
            ownId: OWN,
            msgIds: ["8000000001402", "8000000001403", "8000000009999"],
        });
        const [seen] = find(sent, "/api/group/seenv2");
        assert.deepEqual(
            JSON.parse(seen.params.msgInfos).data.map((e) => e.gmi),
            ["8000000001402"],
        );
        assert.equal(find(sent, "/api/conv/removeUnreadMark").length, 0, "msg seen never touches the unread mark");
        assert.equal(r.success, true);
        assert.deepEqual(
            r.notSent.map((x) => x.msgId),
            ["8000000001403", "8000000009999"],
        );
        assert.match(r.note, /read position/);
    });

    it("with no ids it marks the newest cached incoming message; with none usable it fails without a request", async () => {
        const grid = freshGroup();
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001501", cliMsgId: "1700000001501" })));
        listenerWrites(new GroupMessage(OWN, frame({ idTo: grid, msgId: "8000000001502", cliMsgId: "1700000001502" })));
        const { api, sent } = harness();
        const r = await seenMessages(api, { threadId: grid, type: 1, ownId: OWN });
        assert.deepEqual(r.msgIds, ["8000000001502"]);
        const cold = harness();
        const none = await seenMessages(cold.api, { threadId: freshGroup(), type: 1, ownId: OWN });
        assert.equal(none.success, false);
        assert.equal(cold.sent.length, 0);
        assert.equal(find(sent, "/api/group/seenv2").length, 1);
    });
});

describe("conv block-sharing — blocksharing/updateConvers (zBusiness Max, unverified)", () => {
    it("sends the Web's body and answers {success, threadId, threadType, blockSharing, verified: false}", async () => {
        const grid = freshGroup();
        const { api, sent } = harness();
        const r = await conv(["block-sharing", grid, "on", "-t", "1"], api, { json: true });
        const [req] = find(sent, "/api/conv/blocksharing/updateConvers");
        assert.equal(req.origin, HOSTS.conversation);
        assert.deepEqual(req.params, { threadId: grid, isGroup: 1, isEnabled: 1, clientLang: "vi" });
        assert.deepEqual(JSON.parse(r.stdout), {
            success: true,
            threadId: grid,
            threadType: "group",
            blockSharing: true,
            verified: false,
        });
    });

    it("names Zalo Web's refusal 829 (zBusiness only)", async () => {
        const { api } = harness(() => ({ zaloError: { code: 829, message: "denied" } }));
        const r = await conv(["block-sharing", freshPeer(), "off"], api);
        assert.equal(r.exitCode, 1);
        assert.match(r.stdout + r.stderr, /zBusiness/);
    });
});

describe("conv pin / unpin — pinconvers/updatev2 with the web's tab:0", () => {
    for (const [cmd, type, action] of [
        ["pin", "1", 1],
        ["unpin", "1", 2],
        ["pin", "0", 1],
        ["unpin", "0", 2],
    ]) {
        it(`${cmd} -t ${type}: matches the captured request byte for byte`, async () => {
            const id = type === "1" ? freshGroup() : freshPeer();
            const { api, sent } = harness(() => "");
            const r = await conv([cmd, id, "-t", type], api);
            assert.equal(sent.length, 1, "one request, nothing else");
            const [rec] = sent;
            assert.equal(rec.method, "POST");
            assert.equal(rec.origin, HOSTS.conversation);
            assert.equal(rec.path, "/api/pinconvers/updatev2");
            assert.equal(rec.query.nretry, undefined);
            assert.equal(rec.plain, fill(PIN, { action: String(action), conv: `${type === "1" ? "g" : "u"}${id}` }));
            assert.equal(errorLine(r.stdout), null, r.stdout);
            assert.ok(hasSuccessLine(r.stdout), r.stdout);
        });
    }

    it("refuses a thread type that is neither 0 nor 1, before any request", async () => {
        const { api, sent } = harness();
        const r = await conv(["pin", freshGroup(), "-t", "2"], api);
        assert.equal(sent.length, 0);
        assert.ok(errorLine(r.stdout), r.stdout);
    });
});

describe("conv pinned — the list Web reads, without Zalo's m1 entry", () => {
    it("prints the pinned conversations and leaves out `m1` (spec-actions 7.3)", async () => {
        const g = freshGroup();
        const u = freshPeer();
        const { api, sent } = harness(() => ({ conversations: [`g${g}`, "m1", `u${u}`], version: 7 }));
        const r = await conv(["pinned"], api, { json: true });
        // With no hidden-chat id mirror yet, the hidden list is read once too, to leave hidden chats out.
        const lists = sent.filter((s) => s.path !== "/api/hiddenconvers/get-all");
        assert.equal(lists.length, 1);
        assert.equal(lists[0].path, "/api/pinconvers/list");
        // Red when `conv pinned` prints the list as Zalo answers it: "m1" is in the middle.
        assert.deepEqual(JSON.parse(r.stdout), { conversations: [`g${g}`, `u${u}`], version: 7 });
    });
});

describe("conv archive / unarchive — archivedchat/update with the server's version", () => {
    const SERVER_VERSION = 1700000123000;

    /** A harness whose archived-chat list reports SERVER_VERSION. */
    const labelled = (update = () => ({ needResync: false, version: SERVER_VERSION + 1000 })) =>
        harness((rec) =>
            rec.path === "/api/archivedchat/list" ? { items: [], version: SERVER_VERSION } : update(rec),
        );

    for (const [cmd, type, action] of [
        ["archive", "1", 0],
        ["unarchive", "1", 1],
        ["archive", "0", 0],
        ["unarchive", "0", 1],
    ]) {
        it(`${cmd} -t ${type}: sends the server's version, not the clock, byte for byte as captured`, async () => {
            const id = type === "1" ? freshGroup() : freshPeer();
            const { api, sent } = labelled();
            const r = await conv([cmd, id, "-t", type], api);
            const [list] = find(sent, "/api/archivedchat/list");
            assert.ok(list, "the version comes from the archived-chat list, as the web's comes from its last list");
            assert.equal(list.method, "GET");
            const [update] = find(sent, "/api/archivedchat/update");
            assert.ok(update);
            assert.equal(update.method, "POST");
            assert.equal(update.origin, HOSTS.label);
            assert.equal(
                update.plain,
                fill(ARCHIVE, { id, type, version: String(SERVER_VERSION), action: String(action), imei: IMEI }),
            );
            assert.equal(errorLine(r.stdout), null, r.stdout);
            assert.ok(hasSuccessLine(r.stdout), r.stdout);
        });
    }

    it("sends nothing when the version cannot be read", async () => {
        const { api, sent } = harness((rec) =>
            rec.path === "/api/archivedchat/list" ? { zaloError: { code: -1, message: "list unavailable" } } : {},
        );
        const r = await conv(["archive", freshGroup(), "-t", "1"], api);
        assert.equal(find(sent, "/api/archivedchat/update").length, 0);
        assert.ok(errorLine(r.stdout), r.stdout);
    });

    it("says so when Zalo answers needResync", async () => {
        const { api } = labelled(() => ({ needResync: true, version: SERVER_VERSION + 1000 }));
        const r = await conv(["archive", freshGroup(), "-t", "1"], api);
        assert.match(r.stdout, /⚠.*(needResync|resync|conv archived)/i);
    });
});
