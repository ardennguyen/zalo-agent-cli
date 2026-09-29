/**
 * Seen and delivered receipts must leave this CLI exactly as Zalo Web sends them.
 *
 * Ground truth is a capture of the real Zalo Web client (build
 * 826674fb31d2af1b2b59, zpw_ver 691), decrypted request by request. The
 * templates below are those captured plaintexts, copied verbatim with the ids
 * replaced by placeholders; each names the capture row it came from.
 *
 * zca-js has builders for both receipts and neither can produce these
 * requests: `sendSeenEvent.js:43-46` and `sendDeliveredEvent.js:38-41` compute
 * `msg.st || 0 === msg.st ? 0 : -1`, which parses as
 * `(msg.st || (0 === msg.st)) ? 0 : -1` and can only ever yield 0 or -1; a DM
 * seen omits `imei`; and zca-js rewrites an own message's `uidFrom` "0" to the
 * account uid, where the web sends "0". Hence src/core/receipts.js.
 *
 * Everything runs through zca-js's own HTTP seam (`ctx.options.polyfill`):
 * the real apiFactory, the real AES, a fake transport that decrypts each
 * request with a throwaway key. No socket, no session, no network.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { GroupMessage, UserMessage } from "zca-js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    sendSeenReceipt,
    sendDeliveredReceipt,
    liveReceiptTarget,
    createDeliveredReceipts,
} from "../../src/core/receipts.js";

const require = createRequire(import.meta.url);
const zcaUtils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

/** Obviously-fake 16-byte AES key and imei. Never a real session secret (AGENTS.md §12). */
const SECRET_KEY = Buffer.from("0123456789abcdef").toString("base64");
const IMEI = "test-imei-0000";

// Fake ids.
const OWN = "9100000000000000001";
const GRID = "9200000000000000002";
const PEER = "9300000000000000003";
const MEMBER = "9400000000000000004";

const HOSTS = {
    chat: "https://tt-chat.test.invalid",
    group: "https://tt-group.test.invalid",
    conversation: "https://tt-convers.test.invalid",
    label: "https://label.test.invalid",
};

/**
 * A Zalo api stand-in: the real zca-js apiFactory runs against it, and every
 * request it makes is recorded decrypted.
 *
 * @param {object} [opts]
 * @param {(rec: object) => any} [opts.respond] - returns the response `data`, throws to
 *   simulate a network failure, or returns `{ zaloError: {code, message} }`
 */
function harness({ respond = () => ({ status: 0 }) } = {}) {
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
                const plain = enc ? zcaUtils.decodeAES(SECRET_KEY, enc) : null;
                const rec = {
                    method: init.method || "GET",
                    origin: u.origin,
                    path: u.pathname,
                    query: Object.fromEntries([...u.searchParams].filter(([k]) => k !== "params")),
                    plain,
                    params: plain ? JSON.parse(plain) : null,
                    signal: init.signal,
                };
                sent.push(rec);
                const data = await respond(rec);
                const body = data?.zaloError
                    ? { error_code: data.zaloError.code, error_message: data.zaloError.message }
                    : {
                          error_code: 0,
                          error_message: "Successful.",
                          data: zcaUtils.encodeAES(
                              SECRET_KEY,
                              JSON.stringify({ error_code: 0, error_message: "", data }),
                          ),
                      };
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        },
    };
    const api = {
        zpwServiceMap: Object.fromEntries(Object.entries(HOSTS).map(([k, v]) => [k, [v]])),
        getContext: () => ctx,
    };
    return { api, ctx, sent };
}

/** Fill a captured template's placeholders. */
function fill(template, values) {
    return template.replace(/<(\w+)>/g, (_, k) => {
        assert.ok(k in values, `template placeholder <${k}> has no value`);
        return values[k];
    });
}

// ---- Captured plaintexts (ids replaced by <placeholders>) --------------------

/** group.A1 row 3: the web acknowledging its own group text. */
const GROUP_DELIVERED_OWN_ECHO = String.raw`{"msgInfos":"{\"seen\":0,\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"0\",\"di\":\"<grid>\",\"mt\":\"webchat\",\"st\":3,\"at\":5,\"cmd\":521,\"ts\":\"<ts>\"}],\"grid\":\"<grid>\"}","imei":"<imei>"}`;

/** dm.D13_reminder row 2: the web acknowledging a DM from the peer. No imei. */
const DM_DELIVERED_INCOMING = String.raw`{"msgInfos":"{\"seen\":0,\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"<peer>\",\"di\":\"0\",\"mt\":\"webchat\",\"st\":3,\"at\":9,\"cmd\":501,\"ts\":\"<ts>\"}]}"}`;

/** dm.D13_reminder row 3: the web acknowledging its own DM card. */
const DM_DELIVERED_OWN_ECHO = String.raw`{"msgInfos":"{\"seen\":0,\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"0\",\"di\":\"<peer>\",\"mt\":\"chat.ecard\",\"st\":3,\"at\":0,\"cmd\":501,\"ts\":\"<ts>\"}]}"}`;

/** group.A13_create_reminder row 2: group seenv2. */
const GROUP_SEEN = String.raw`{"msgInfos":"{\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"0\",\"di\":\"<grid>\",\"mt\":\"chat.ecard\",\"st\":3,\"at\":0,\"cmd\":521,\"ts\":\"<ts>\"}],\"grid\":\"<grid>\"}","imei":"<imei>"}`;

/** dm.D13_reminder row 1: DM seenv2 -- senderId, and an imei zca-js leaves out. */
const DM_SEEN = String.raw`{"msgInfos":"{\"data\":[{\"cmi\":\"<cmi>\",\"gmi\":\"<gmi>\",\"si\":\"<peer>\",\"di\":\"0\",\"mt\":\"webchat\",\"st\":3,\"at\":9,\"cmd\":501,\"ts\":\"<ts>\"}],\"senderId\":\"<peer>\"}","imei":"<imei>"}`;

// ---- Socket frames, as zca-js hands them to the listener ---------------------

/** A 501/521 row shaped like live/socket.L1_group_echo.json and socket.L4_dm_echo.json. */
function frame(over = {}) {
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
        content: "zcap listener echo",
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

const groupEcho = (over) => new GroupMessage(OWN, frame(over));
const groupIncoming = (over) => new GroupMessage(OWN, frame({ uidFrom: MEMBER, ...over }));
const dmIncoming = (over) => new UserMessage(OWN, frame({ uidFrom: PEER, idTo: "0", cmd: 501, at: 9, ...over }));
const dmEcho = (over) => new UserMessage(OWN, frame({ uidFrom: "0", idTo: PEER, cmd: 501, ...over }));

/** The data[] entries of a recorded receipt request. */
const entries = (rec) => JSON.parse(rec.params.msgInfos).data;

before(() => {
    assertSandboxed(CONFIG_DIR);
});

describe("seenv2 — what `conv read` puts on the wire", () => {
    it("group: matches the captured request byte for byte", async () => {
        const { api, sent } = harness();
        await sendSeenReceipt(api, {
            threadId: GRID,
            type: 1,
            messages: [
                {
                    msgId: "8000000000201",
                    cliMsgId: "1700000000201",
                    uidFrom: "0",
                    idTo: GRID,
                    msgType: "chat.ecard",
                    st: 3,
                    at: 0,
                    cmd: 521,
                    ts: "1700000000202",
                },
            ],
        });
        assert.equal(sent.length, 1);
        const [rec] = sent;
        assert.equal(rec.method, "POST");
        assert.equal(rec.origin, HOSTS.group);
        assert.equal(rec.path, "/api/group/seenv2");
        assert.equal(rec.query.nretry, "0", "the web sends seenv2 with nretry=0");
        assert.equal(
            rec.plain,
            fill(GROUP_SEEN, {
                cmi: "1700000000201",
                gmi: "8000000000201",
                grid: GRID,
                ts: "1700000000202",
                imei: IMEI,
            }),
        );
    });

    it("DM: carries senderId AND imei, exactly as captured", async () => {
        const { api, sent } = harness();
        await sendSeenReceipt(api, {
            threadId: PEER,
            type: 0,
            messages: [
                {
                    msgId: "8000000000301",
                    cliMsgId: "1700000000301",
                    uidFrom: PEER,
                    idTo: "0",
                    msgType: "webchat",
                    st: 3,
                    at: 9,
                    cmd: 501,
                    ts: 1700000000301, // a number in, the web's string out
                },
            ],
        });
        const [rec] = sent;
        assert.equal(rec.method, "POST");
        assert.equal(rec.origin, HOSTS.chat);
        assert.equal(rec.path, "/api/message/seenv2");
        assert.equal(rec.query.nretry, "0");
        assert.equal(
            rec.plain,
            fill(DM_SEEN, { cmi: "1700000000301", gmi: "8000000000301", peer: PEER, ts: "1700000000301", imei: IMEI }),
        );
    });

    it("refuses an empty batch and one over Zalo's 50-message limit, before any request", async () => {
        const { api, sent } = harness();
        const one = { msgId: "1", cliMsgId: "2", uidFrom: PEER, idTo: "0", msgType: "webchat", ts: "3" };
        await assert.rejects(() => sendSeenReceipt(api, { threadId: PEER, type: 0, messages: [] }));
        await assert.rejects(() =>
            sendSeenReceipt(api, { threadId: PEER, type: 0, messages: Array.from({ length: 51 }, () => one) }),
        );
        assert.equal(sent.length, 0);
    });
});

describe("deliveredv2 — built from the frame zca-js hands the listener", () => {
    /** Send one delivered receipt for a zca-js message the way the listener does. */
    async function deliver(msg) {
        const { api, sent } = harness();
        const target = liveReceiptTarget(msg);
        assert.ok(target, "a real message must be receiptable");
        await sendDeliveredReceipt(api, { threadId: target.threadId, type: target.type, messages: [target.message] });
        assert.equal(sent.length, 1);
        return sent[0];
    }

    it('group own echo: matches the captured request byte for byte (si is "0", not our uid)', async () => {
        const rec = await deliver(groupEcho());
        assert.equal(rec.method, "POST");
        assert.equal(rec.origin, HOSTS.group);
        assert.equal(rec.path, "/api/group/deliveredv2");
        assert.equal(rec.query.nretry, undefined, "the web sends deliveredv2 without nretry");
        assert.equal(
            rec.plain,
            fill(GROUP_DELIVERED_OWN_ECHO, {
                cmi: "1700000000101",
                gmi: "8000000000101",
                grid: GRID,
                ts: "1700000000150",
                imei: IMEI,
            }),
        );
    });

    it('DM incoming: matches the captured request byte for byte (di is "0", no imei)', async () => {
        const rec = await deliver(
            dmIncoming({ msgId: "8000000000401", cliMsgId: "1700000000401", ts: "1700000000401" }),
        );
        assert.equal(rec.origin, HOSTS.chat);
        assert.equal(rec.path, "/api/message/deliveredv2");
        assert.equal(
            rec.plain,
            fill(DM_DELIVERED_INCOMING, {
                cmi: "1700000000401",
                gmi: "8000000000401",
                peer: PEER,
                ts: "1700000000401",
            }),
        );
    });

    it("DM own echo: matches the captured request byte for byte", async () => {
        const rec = await deliver(
            dmEcho({
                msgId: "8000000000402",
                cliMsgId: "1700000000402",
                ts: "1700000000402",
                msgType: "chat.ecard",
                at: 0,
            }),
        );
        assert.equal(rec.path, "/api/message/deliveredv2");
        assert.equal(
            rec.plain,
            fill(DM_DELIVERED_OWN_ECHO, {
                cmi: "1700000000402",
                gmi: "8000000000402",
                peer: PEER,
                ts: "1700000000402",
            }),
        );
    });

    it("group message from another member names that member and the group", async () => {
        const rec = await deliver(groupIncoming({ msgId: "8000000000501", cliMsgId: "1700000000501" }));
        const [e] = entries(rec);
        assert.equal(e.si, MEMBER);
        assert.equal(e.di, GRID);
        assert.equal(JSON.parse(rec.params.msgInfos).grid, GRID);
    });

    it("a field the frame lacks goes out as -1, as the web's own builder sends it", async () => {
        const msg = groupEcho();
        delete msg.data.st;
        delete msg.data.at;
        delete msg.data.cmd;
        const [e] = entries(await deliver(msg));
        assert.deepEqual({ st: e.st, at: e.at, cmd: e.cmd }, { st: -1, at: -1, cmd: -1 });
    });

    it("st/at/cmd reach the wire as given, which zca-js's builder cannot do", async () => {
        const [e] = entries(await deliver(groupEcho({ st: 5, at: 9 })));
        assert.deepEqual({ st: e.st, at: e.at, cmd: e.cmd }, { st: 5, at: 9, cmd: 521 });
    });
});

describe("liveReceiptTarget — which live messages get a receipt", () => {
    it("skips the removal frames Zalo Web does not acknowledge", () => {
        // The web's message reducer routes chat.delete and chat.undo rows to
        // their own handlers and never into the delivered batch.
        assert.equal(liveReceiptTarget(dmEcho({ msgType: "chat.delete", content: [{}] })), null);
        assert.equal(liveReceiptTarget(groupEcho({ msgType: "chat.undo" })), null);
    });

    it("skips a message it cannot identify to Zalo", () => {
        assert.equal(liveReceiptTarget(groupEcho({ cliMsgId: undefined })), null);
        assert.equal(liveReceiptTarget(groupEcho({ msgId: "0" })), null);
        assert.equal(liveReceiptTarget(null), null);
    });
});

describe("createDeliveredReceipts — the listener's automatic receipts", () => {
    /** A receipter wired to a harness, with the delay taken out. */
    function setup({ respond, ...opts } = {}) {
        const h = harness({ respond });
        const logs = [];
        const receipts = createDeliveredReceipts({
            getApi: () => h.api,
            delayMs: 0,
            log: (m) => logs.push(m),
            ...opts,
        });
        const listener = new EventEmitter();
        receipts.attach(listener);
        return { ...h, logs, receipts, listener };
    }

    it("acknowledges every message, own echoes included, one call per conversation", async () => {
        const { sent, receipts, listener } = setup();
        listener.emit("message", groupEcho());
        listener.emit("message", dmIncoming({ msgId: "8000000000601", cliMsgId: "1700000000601" }));
        await receipts.flush();
        assert.deepEqual(
            sent.map((r) => r.path),
            ["/api/group/deliveredv2", "/api/message/deliveredv2"],
        );
        assert.equal(entries(sent[0])[0].si, "0", "our own echo is acknowledged, as the web does");
        assert.equal(entries(sent[1])[0].si, PEER);
    });

    it("batches a burst per conversation, in arrival order", async () => {
        const { sent, receipts, listener } = setup();
        listener.emit("message", groupIncoming({ msgId: "8000000000701", cliMsgId: "1700000000701" }));
        listener.emit("message", dmIncoming({ msgId: "8000000000702", cliMsgId: "1700000000702" }));
        listener.emit("message", groupIncoming({ msgId: "8000000000703", cliMsgId: "1700000000703" }));
        listener.emit("message", groupEcho({ msgId: "8000000000704", cliMsgId: "1700000000704" }));
        await receipts.flush();
        assert.equal(sent.length, 2, "one group call and one DM call");
        assert.deepEqual(
            entries(sent[0]).map((e) => e.gmi),
            ["8000000000701", "8000000000703", "8000000000704"],
        );
        assert.deepEqual(
            entries(sent[1]).map((e) => e.gmi),
            ["8000000000702"],
        );
    });

    it("never puts more than 50 messages in one call", async () => {
        const { sent, receipts, listener } = setup();
        for (let i = 0; i < 53; i++) {
            listener.emit(
                "message",
                groupIncoming({ msgId: String(8000000001000 + i), cliMsgId: String(1700000001000 + i) }),
            );
        }
        await receipts.flush();
        assert.deepEqual(
            sent.map((r) => entries(r).length),
            [50, 3],
        );
    });

    it("sends the batch on its own after the delay, without anyone flushing", async () => {
        // The production path: nothing ever calls flush(), only the timer.
        const { sent, listener } = setup({ delayMs: 20 });
        listener.emit("message", groupEcho());
        assert.equal(sent.length, 0, "nothing goes out before the delay");
        // Poll rather than sleep a fixed time: this box is shared with other
        // sessions, and a loaded event loop must not turn into a false failure.
        for (let waited = 0; sent.length === 0 && waited < 5000; waited += 25) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(sent.length, 1);
    });

    it("never sends a seen receipt", async () => {
        const { sent, receipts, listener } = setup();
        listener.emit("message", groupIncoming());
        listener.emit("message", dmIncoming());
        await receipts.flush();
        assert.ok(sent.length > 0);
        assert.deepEqual(
            sent.filter((r) => /seen/.test(r.path)),
            [],
        );
    });

    it("skips removal frames on the message channel", async () => {
        const { sent, receipts, listener } = setup();
        listener.emit("message", dmEcho({ msgType: "chat.delete", content: [{ globalDelMsgId: "1" }] }));
        await receipts.flush();
        assert.equal(sent.length, 0);
    });

    it("attaches nothing and sends nothing when disabled", async () => {
        const { sent, receipts, listener } = setup({ enabled: false });
        assert.equal(listener.listenerCount("message"), 0, "the opt-out must not even subscribe");
        receipts.queue(groupEcho());
        await receipts.flush();
        assert.equal(sent.length, 0);
    });

    it("a rejected receipt never throws into the listener, is logged, and the queue moves on", async () => {
        let calls = 0;
        const { sent, logs, receipts, listener } = setup({
            respond: () => (++calls === 1 ? { zaloError: { code: 114, message: "Tham số không hợp lệ" } } : ""),
        });
        const write = mock.method(process.stdout, "write", () => true);
        try {
            assert.doesNotThrow(() => listener.emit("message", groupEcho()));
            assert.doesNotThrow(() => listener.emit("message", dmIncoming()));
            await receipts.flush();
        } finally {
            write.mock.restore();
        }
        assert.equal(sent.length, 2, "the second conversation's receipt still went out");
        assert.equal(write.mock.callCount(), 0, "nothing may reach stdout: in MCP mode it is the JSON-RPC stream");
        const failures = logs.filter((l) => /fail/i.test(l));
        assert.equal(failures.length, 1, `expected one failure line, got: ${JSON.stringify(logs)}`);
        assert.match(failures[0], /114|Tham số/);
        assert.deepEqual({ sent: receipts.stats().sent, failed: receipts.stats().failed }, { sent: 1, failed: 1 });
    });

    it("a network failure or a missing session is swallowed the same way", async () => {
        const net = setup({
            respond: () => {
                throw new TypeError("fetch failed");
            },
        });
        net.listener.emit("message", groupEcho());
        await net.receipts.flush();
        assert.equal(net.receipts.stats().failed, 1);

        const noSession = setup({
            getApi: () => {
                throw new Error("Not logged in. Run: zalo-agent login");
            },
        });
        noSession.listener.emit("message", groupEcho());
        await noSession.receipts.flush();
        assert.equal(noSession.receipts.stats().failed, 1);
    });

    it("a hung request is abandoned after the timeout, and the next one still goes out", async () => {
        const { sent, receipts, listener } = setup({
            timeoutMs: 50,
            respond: (rec) =>
                rec.path === "/api/group/deliveredv2"
                    ? new Promise((_, reject) => rec.signal?.addEventListener("abort", () => reject(rec.signal.reason)))
                    : { status: 0 },
        });
        listener.emit("message", groupEcho());
        listener.emit("message", dmIncoming());
        await receipts.flush();
        assert.deepEqual(
            sent.map((r) => r.path),
            ["/api/group/deliveredv2", "/api/message/deliveredv2"],
        );
        assert.ok(sent[0].signal, "the request must carry an abort signal");
        assert.deepEqual({ sent: receipts.stats().sent, failed: receipts.stats().failed }, { sent: 1, failed: 1 });
    });

    it("the message write is never delayed: a handler registered first sees every message synchronously", () => {
        // listen.js and mcp.js register their storing handler first and attach
        // receipts after it. Even with the transport hung, emit() must return
        // at once and the storing handler must have run for every message.
        const stored = [];
        const h = harness({ respond: () => new Promise(() => {}) });
        const listener = new EventEmitter();
        listener.on("message", (m) => stored.push(m.data.msgId));
        const receipts = createDeliveredReceipts({ getApi: () => h.api, delayMs: 0, log: () => {} });
        receipts.attach(listener);
        for (let i = 0; i < 5; i++) listener.emit("message", groupEcho({ msgId: String(8000000002000 + i) }));
        assert.equal(stored.length, 5);
        receipts.stop();
    });

    it("bounds its memory when Zalo stops answering", async () => {
        const h = harness({ respond: () => new Promise(() => {}) });
        const receipts = createDeliveredReceipts({ getApi: () => h.api, delayMs: 0, maxPending: 10, log: () => {} });
        const listener = new EventEmitter();
        receipts.attach(listener);
        // Different conversations, so nothing coalesces.
        for (let i = 0; i < 30; i++) {
            listener.emit("message", groupIncoming({ idTo: String(9500000000000000000n + BigInt(i)) }));
        }
        await new Promise((r) => setImmediate(r));
        const s = receipts.stats();
        assert.ok(s.pending <= 10, `pending ${s.pending} exceeds the bound`);
        assert.ok(s.dropped > 0, "the overflow must be counted, not silently kept");
        receipts.stop();
    });
});
