/**
 * `msg send` must report the cliMsgId Zalo actually received.
 *
 * zca-js stamps `params.clientId = Date.now()` inside `handleMessage()`, right
 * before the AES encrypt and the POST, and upstream returns only `{msgId}`.
 * `src/commands/msg.js` used to take its own `Date.now()` reading before the
 * call and print that — a different number by however long the encrypt and the
 * round trip took. Usually 0-2ms off, never guaranteed equal, and an id that is
 * off by one millisecond is simply the wrong id.
 *
 * That mattered in three places, all of which key on the value:
 *
 *   · `msg react` / `msg undo` need the real cliMsgId, or Zalo accepts the
 *     call and nothing appears.
 *   · `msg send --react` auto-reacts with whatever `send` believes it sent.
 *   · `msg send --quote` rebuilds the quote payload from a cached row's
 *     cliMsgId, so a row whose id came from the guess cannot be quoted.
 *   · `msg undo` / `msg delete` refuse outright without one, which is how an
 *     image or a file could be sent and then not be cleanable.
 *
 * `patches/zca-js+2.2.0.patch` now hands the clientId back on the response, and
 * these tests hold that patch to its claim by decrypting the request body and
 * comparing the reported id against the one that went on the wire. A zca-js
 * bump that drops the patch fails here rather than silently reviving the guess.
 *
 * Pure protocol plumbing: `ctx.options.polyfill` is zca-js's own HTTP seam, so
 * the real `sendMessage` runs with no socket, no session and no filesystem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sendMessageFactory } from "../../node_modules/zca-js/dist/apis/sendMessage.js";
import { encodeAES, decodeAES } from "../../node_modules/zca-js/dist/utils.js";
import { ThreadType } from "../../node_modules/zca-js/dist/models/Enum.js";

/** Obviously-fake 16-byte AES key. Never a real session secret — see AGENTS.md §12. */
const SECRET_KEY = Buffer.from("0123456789abcdef").toString("base64");

const THREAD_USER = "9000000000000000001";
const THREAD_GROUP = "9000000000000000002";

/** An `others` upload result, the shape `handleAttachment` reads. Touches no file. */
const UPLOADED_FILE = {
    fileType: "others",
    fileId: 1,
    checksum: "deadbeef",
    fileName: "ghi-chu.txt",
    totalSize: 12,
    clientFileId: "555",
    fileUrl: "https://tt-files-test.invalid/ghi-chu.txt",
};

/**
 * A response shaped like Zalo's: outer JSON envelope, AES-encrypted payload.
 *
 * @param {object} data - what `resolveResponse` should hand back
 * @returns {object} a minimal Response stand-in
 */
function zaloOk(data) {
    const payload = encodeAES(SECRET_KEY, JSON.stringify({ error_code: 0, error_message: "Successful.", data }));
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ error_code: 0, error_message: "Successful.", data: payload }),
    };
}

/**
 * A `sendMessage` bound to a fake transport that records every decrypted request.
 *
 * @param {object} [opts]
 * @param {number} [opts.msgId] - msgId the fake Zalo assigns
 * @param {number} [opts.delayMs] - stall before responding, to separate the clock
 *   reading inside `handleMessage` from one taken after the call returns
 * @param {Function} [opts.uploadAttachment] - stub for `api.uploadAttachment`
 * @returns {{send: Function, sent: object[]}} the API function and the request log
 */
function harness({ msgId = 424242, delayMs = 0, uploadAttachment } = {}) {
    const sent = [];
    const ctx = {
        secretKey: SECRET_KEY,
        imei: "test-imei-0000",
        userAgent: "zalo-agent-cli-offline-test",
        API_VERSION: 651,
        API_TYPE: 30,
        options: {
            logging: false,
            agent: undefined,
            async polyfill(url, options) {
                const body = options?.body;
                const params = body instanceof URLSearchParams ? body.get("params") : null;
                sent.push({ url, params: params ? JSON.parse(decodeAES(SECRET_KEY, params)) : null });
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                return zaloOk({ msgId });
            },
        },
        settings: { features: { sharefile: { max_file: 100, max_size_share_file_v3: 1024 } } },
    };
    const api = {
        zpwServiceMap: {
            chat: ["https://tt-chat-test.invalid"],
            group: ["https://tt-group-test.invalid"],
            file: ["https://tt-files-test.invalid"],
        },
        uploadAttachment,
    };
    return { send: sendMessageFactory(ctx, api), sent };
}

/**
 * The one recorded request whose decrypted params carry a `message` field.
 *
 * @param {object[]} sent - the harness request log
 * @returns {object} that request
 */
function textRequest(sent) {
    const hits = sent.filter((r) => r.params && "message" in r.params);
    assert.equal(hits.length, 1, `expected exactly one text request, saw ${sent.length} request(s)`);
    return hits[0];
}

describe("sendMessage reports the clientId it put on the wire", () => {
    it("a DM's reported cliMsgId is the wire clientId, exactly", async () => {
        const { send, sent } = harness();
        const result = await send("xin chào", THREAD_USER, ThreadType.User);

        const wire = textRequest(sent).params;
        assert.ok(wire.clientId, "zca-js must still send a clientId");
        assert.equal(
            result.message.cliMsgId,
            String(wire.clientId),
            "the reported cliMsgId must be the clientId Zalo received",
        );
        assert.equal(result.message.msgId, 424242, "the rest of the response is untouched");
    });

    it("a group send reports it too", async () => {
        const { send, sent } = harness();
        const result = await send("chào cả nhà", THREAD_GROUP, ThreadType.Group);

        const req = textRequest(sent);
        assert.equal(req.params.grid, THREAD_GROUP, "sanity: this really is the group path");
        assert.equal(result.message.cliMsgId, String(req.params.clientId));
    });

    it("a quote-reply reports it — the path `msg send --quote` takes", async () => {
        // The quote branch builds a separate params object and posts to /quote,
        // so it needs its own coverage: an unstamped quote send is exactly the
        // case that leaves the reply unquotable in its turn.
        const { send, sent } = harness();
        const result = await send(
            {
                msg: "trả lời",
                quote: {
                    content: "tin gốc",
                    msgType: "webchat",
                    propertyExt: undefined,
                    uidFrom: "9000000000000000003",
                    msgId: "111111",
                    cliMsgId: "1700000000000",
                    ts: "1700000000000",
                    ttl: 0,
                },
            },
            THREAD_USER,
            ThreadType.User,
        );

        const req = textRequest(sent);
        assert.ok(req.url.includes("/quote"), "sanity: this really is the quote path");
        assert.equal(req.params.qmsgCliId, "1700000000000", "sanity: the quoted message's own id rides along");
        assert.equal(result.message.cliMsgId, String(req.params.clientId));
    });

    it("the reported id is the captured one, not a fresh clock reading", async () => {
        // The defect in one assertion. zca-js reads the clock before the POST,
        // so anything that re-reads it afterwards lands later by the round-trip
        // time. Stalling the fake transport makes that gap unmistakable.
        const { send } = harness({ delayMs: 120 });
        const result = await send("chậm", THREAD_USER, ThreadType.User);

        const drift = Date.now() - Number(result.message.cliMsgId);
        assert.ok(drift >= 100, `expected the id to predate the response by the stall, drift was ${drift}ms`);
    });

    it("text sent alongside a file still reports the text message's clientId", async () => {
        // A caption that cannot ride on the attachment goes out as its own
        // message first, through a second call site in zca-js. Same guarantee.
        const { send, sent } = harness({ uploadAttachment: async () => [UPLOADED_FILE] });
        const result = await send({ msg: "kèm tệp", attachments: ["ghi-chu.txt"] }, THREAD_USER, ThreadType.User);

        assert.equal(sent.length, 2, "one request for the text, one for the file");
        assert.equal(result.message.cliMsgId, String(textRequest(sent).params.clientId));
    });

    it("stamps the attachment responses too", async () => {
        // The case that made this necessary: a lone image or file. `canBeDesc`
        // folds the caption into the attachment, so `responses.message` is
        // null and — before the patch reached this path — the send returned no
        // cliMsgId anywhere. `msg undo` and `msg delete` both refuse without
        // one, so tier 4 could not clean up the attachments it had just sent.
        const { send, sent } = harness({ uploadAttachment: async () => [UPLOADED_FILE] });
        const result = await send({ msg: "", attachments: ["ghi-chu.txt"] }, THREAD_USER, ThreadType.User);

        assert.equal(result.message, null, "sanity: the caption folded into the attachment");
        assert.equal(result.attachment.length, 1);

        const wire = sent.find((r) => r.params && "clientId" in r.params && !("message" in r.params));
        assert.ok(wire, "the attachment request must carry a clientId");
        assert.equal(
            result.attachment[0].cliMsgId,
            String(wire.params.clientId),
            "the reported cliMsgId must be the clientId Zalo received",
        );
    });

    it("pairs each attachment with its own clientId, not the first one", async () => {
        // The stamping zips `send()`'s results against its inputs by index.
        // That is only sound because `send()` is a Promise.all over the array
        // it was handed. Two files with distinct ids catch a regression that
        // reorders or flattens them — and catch an off-by-one that would
        // silently label file 2 with file 1's id, which recalls the wrong
        // message.
        const uploads = [
            { ...UPLOADED_FILE, fileName: "mot.txt", clientFileId: "111" },
            { ...UPLOADED_FILE, fileName: "hai.txt", clientFileId: "222" },
        ];
        const { send } = harness({ uploadAttachment: async () => uploads });
        const result = await send({ msg: "", attachments: ["mot.txt", "hai.txt"] }, THREAD_USER, ThreadType.User);

        assert.equal(result.attachment.length, 2);
        assert.deepEqual(
            result.attachment.map((a) => a.cliMsgId),
            ["111", "222"],
            "each response carries the clientId of its own upload, in order",
        );
    });
});

describe("msg send never fabricates a cliMsgId", () => {
    const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "msg.js"), "utf8");

    /**
     * The `msg send` action body with comment lines stripped, so the prose
     * describing the defect cannot satisfy a check meant for the code.
     *
     * @returns {string}
     */
    function sendAction() {
        const start = SRC.indexOf('msg.command("send <threadId> <message>")');
        assert.ok(start > 0, "could not find the `msg send` command");
        const end = SRC.indexOf('msg.command("send-image', start);
        assert.ok(end > start, "could not find the end of the `msg send` command");
        return SRC.slice(start, end)
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
    }

    it("takes the id from the send result rather than the clock", () => {
        const body = sendAction();
        assert.match(body, /result\.message\?\.cliMsgId/, "the id must come off the send response");
        assert.doesNotMatch(
            body,
            /Date\.now\(\)/,
            "reading the clock here is the defect: it is a different number from the one zca-js sent",
        );
    });

    it("surfaces the attachment ids that `msg undo` and `msg delete` need", () => {
        // `msg send` reads result.message; an attachment send has none. Both
        // attachment commands go through sentAttachmentIds(), and both must
        // put it in the JSON — dropping it from either one is the regression
        // that leaves a sent file unrecallable.
        const uses = SRC.match(/sent: sentAttachmentIds\(result\)/g) || [];
        assert.equal(uses.length, 2, "both `send-image` and `send-file` must report it");
        assert.match(SRC, /function sentAttachmentIds\(result\)/);
    });

    it("gives --react only an id the send actually returned", () => {
        // The fallback is the msgId, which is what `msg react` uses when nobody
        // passes -c. It may not register, and the command says so — but it is
        // never a made-up timestamp.
        const body = sendAction();
        assert.match(body, /cliMsgId: cliMsgId \|\| String\(result\.message\.msgId\)/);
    });
});
