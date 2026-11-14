/**
 * `msg send` must report the cliMsgId Zalo actually received.
 *
 * The send stamps `params.clientId` from the session's client-id source right
 * before the encrypt and the POST, and hands the same value back as
 * `cliMsgId`. `src/commands/msg.js` used to take its own `Date.now()` reading
 * before the call and print that -- a different number by however long the
 * encrypt and the round trip took. Usually 0-2ms off, never guaranteed equal,
 * and an id that is off by one millisecond is simply the wrong id.
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
 * These tests decrypt the request body and compare the reported id against the
 * one that went on the wire, end to end through the session object
 * (src/zalo/api.js). Every other send method, and the attachment sends, are
 * held to the same thing case by case in tests/unit/wire-messages.test.js and
 * tests/unit/wire-upload.test.js.
 *
 * Pure protocol plumbing: `ctx.options.polyfill` is the session's HTTP seam,
 * so the real `sendMessage` runs with no socket, no session and no filesystem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApi } from "../../src/zalo/api.js";
import { THREAD_TYPE } from "../../src/zalo/enums.js";
import { openSession, sealSession } from "../../src/zalo/kernel/cipher.js";

/** Obviously-fake 16-byte AES key. Never a real session secret — see AGENTS.md §12. */
const SECRET_KEY = Buffer.from("0123456789abcdef").toString("base64");

const THREAD_USER = "9000000000000000001";
const THREAD_GROUP = "9000000000000000002";

/**
 * A response shaped like Zalo's: outer JSON envelope, AES-encrypted payload.
 *
 * @param {object} data - what the session's reply decoding should hand back
 * @returns {Response}
 */
function zaloOk(data) {
    const payload = sealSession(SECRET_KEY, JSON.stringify({ error_code: 0, error_message: "Successful.", data }));
    return new Response(JSON.stringify({ error_code: 0, error_message: "Successful.", data: payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/**
 * A `sendMessage` on a fake transport that records every decrypted request.
 *
 * @param {object} [opts]
 * @param {number} [opts.msgId] - msgId the fake Zalo assigns
 * @param {number} [opts.delayMs] - stall before responding, to separate the id
 *   minted before the POST from a clock reading taken after the call returns
 * @returns {{send: Function, sent: object[]}} the API function and the request log
 */
function harness({ msgId = 424242, delayMs = 0 } = {}) {
    const sent = [];
    const ctx = {
        secretKey: SECRET_KEY,
        imei: "test-imei-0000",
        userAgent: "zalo-agent-cli-offline-test",
        language: "vi",
        API_VERSION: 651,
        API_TYPE: 30,
        options: {
            logging: false,
            async polyfill(url, options) {
                const body = options?.body;
                const params = body instanceof URLSearchParams ? body.get("params") : null;
                sent.push({ url: String(url), params: params ? JSON.parse(openSession(SECRET_KEY, params)) : null });
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                return zaloOk({ msgId });
            },
        },
    };
    const serviceMap = { chat: ["https://tt-chat-test.invalid"], group: ["https://tt-group-test.invalid"] };
    const api = createApi(ctx, serviceMap, [], { createListener: () => null });
    return { send: api.sendMessage, sent };
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
        const result = await send("xin chào", THREAD_USER, THREAD_TYPE.USER);

        const wire = textRequest(sent).params;
        assert.ok(wire.clientId, "the send must carry a clientId");
        assert.equal(
            result.message.cliMsgId,
            String(wire.clientId),
            "the reported cliMsgId must be the clientId Zalo received",
        );
        assert.equal(String(result.message.msgId), "424242", "the rest of the response is untouched");
    });

    it("a group send reports it too", async () => {
        const { send, sent } = harness();
        const result = await send("chào cả nhà", THREAD_GROUP, THREAD_TYPE.GROUP);

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
            THREAD_TYPE.USER,
        );

        const req = textRequest(sent);
        assert.ok(req.url.includes("/quote"), "sanity: this really is the quote path");
        assert.equal(req.params.qmsgCliId, "1700000000000", "sanity: the quoted message's own id rides along");
        assert.equal(result.message.cliMsgId, String(req.params.clientId));
    });

    it("the reported id is the one minted before the POST, not a fresh clock reading", async () => {
        // The defect in one assertion. The id is minted before the POST, so
        // anything that re-reads the clock afterwards lands later by the
        // round-trip time. Stalling the fake transport makes that gap
        // unmistakable.
        const { send } = harness({ delayMs: 120 });
        const result = await send("chậm", THREAD_USER, THREAD_TYPE.USER);

        const drift = Date.now() - Number(result.message.cliMsgId);
        assert.ok(drift >= 100, `expected the id to predate the response by the stall, drift was ${drift}ms`);
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
            "reading the clock here is the defect: it is a different number from the one the send put on the wire",
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
        // Never a made-up timestamp, and no longer the msgId either: keyed on
        // the msgId, Zalo accepts a reaction and never shows it, so a send
        // that came back without a cliMsgId now skips --react and says how to
        // react later. What the reaction really carries is asserted on the
        // decrypted request in tests/unit/msg-react-cache.test.js; this only
        // keeps the old fallback from coming back.
        const body = sendAction();
        assert.doesNotMatch(body, /cliMsgId:\s*cliMsgId\s*\|\|\s*String\(result\.message\.msgId\)/);
    });
});

describe("msg forward reports ids its own undo can use", () => {
    const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "msg.js"), "utf8");

    /** The `msg forward` action body, comments stripped. */
    function forwardAction() {
        const start = SRC.indexOf('msg.command("forward <msgId> <threadId>")');
        assert.ok(start > 0, "could not find `msg forward`");
        const end = SRC.indexOf("msg.command(", start + 20);
        assert.ok(end > start, "could not find the end of `msg forward`");
        return SRC.slice(start, end)
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
    }

    it("pairs each forwarded msgId with a cliMsgId", () => {
        // A forward mints ONE clientId for the whole call and Zalo echoes it
        // per target as `clientId`, while the send reports it at the top
        // level as `cliMsgId`. Neither spot alone gives a caller the pair
        // that `msg undo` needs, so tier 4 once recorded the forwarded
        // message with a null id and could not recall it.
        const body = forwardAction();
        assert.match(body, /const sent = /, "forward must build a `sent` array");
        assert.match(body, /x\.clientId \?\? shared/, "each target falls back to the shared id");
        assert.match(body, /output\(\{ \.\.\.result, sent }/, "and must actually report it");
    });

    it("reads the failure key Zalo actually sends", () => {
        // The response is {success, failed}. This checked `result.fail`,
        // which is never a key on it, so the count was always 0 and a
        // rejected target was reported as a success.
        assert.match(forwardAction(), /result\?\.failed/, "must read `failed`");
    });
});
