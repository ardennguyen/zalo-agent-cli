/**
 * The messages area on the wire (package MSG, design.md 4.1 and 3.3): `src/zalo/api/messages.js`, built by
 * `createApi` on a logged-in context of the fake Zalo (tests/helpers/wire-diff).
 *
 * Each case has two parts:
 *
 * 1. `expectGolden`: every request (method, service, path, query and its order, decrypted params and their key
 *    order, headers, form) and the outcome, against its reviewed record in tests/helpers/wire-diff/golden/messages.js.
 * 2. Error cases: an outer error, an inner error, HTTP 500 and an undecryptable `data` for every method, each checked
 *    against a literal `{message, code}`.
 *
 * Beside those, direct assertions: the reported `cliMsgId` is the `clientId` on the wire for every send, the client ids of 50 sends in one millisecond are all different, the HEAD of a hosted
 * video carries no cookie and times out, a hosted voice makes no HEAD (Web makes none), and a video without geometry
 * sends nothing.
 *
 * Every id here is fake.
 */
import "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// The upload and send paths wait on unref'd timers on purpose (they must never keep a daemon alive). With fakes
// that never answer and nothing else running, Linux drains the event loop first and node:test cancels the pending
// tests ("Promise resolution is still pending but the event loop has already resolved"). A ref'd interval for the
// file's length stands in for the daemon's socket, as in tests/unit/receipts.test.js.
let keepAlive;
before(() => {
    keepAlive = setInterval(() => {}, 25);
});
after(() => clearInterval(keepAlive));
import { createApi } from "../../src/zalo/api.js";
import { ENDPOINTS, HEAD_TIMEOUT_MS, messageMethods } from "../../src/zalo/api/messages.js";
import { FAKE, T0, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { normalizeRequest } from "../helpers/wire-diff/normalize.js";

const USER = "2000000000000000002";
const GROUP = "3000000000000000003";
const OTHER = "4000000000000000004";
const MSG_ID = "5000000000000000005";
const QUOTED_ID = "6000000000000000006";

/** A host the user names for a hosted voice/video: not Zalo, so no Zalo header or cookie may reach it. */
const HOSTED_HOST = "media.example.invalid";

/** How the hosted host answers a HEAD: its content length, or never (until the request is aborted). */
const HOSTED = { length: "48000", hang: false };

const sent = { reply: { msgId: MSG_ID } };

/** A cached text message as src/utils/quote.js `buildQuote` hands it over. */
const QUOTE = Object.freeze({
    content: "the quoted text",
    msgType: "webchat",
    propertyExt: { color: 0, size: 0, type: 0, subType: 0, ext: '{"shouldParseLinkOrContact":0}' },
    uidFrom: OTHER,
    msgId: QUOTED_ID,
    cliMsgId: "1690000000000",
    ts: "1690000000500",
    ttl: 0,
});

/** Bold, an indent of 2 (the engine's `ind_$`), a bullet list: what src/zalo/format/markdown.js produces. */
const STYLES = [
    { start: 0, len: 5, st: "b" },
    { start: 6, len: 5, st: "ind_$", indentSize: 2 },
    { start: 6, len: 5, st: "lst_1" },
];

/** @All and one member. */
const MENTIONS = [
    { pos: 0, uid: "-1", len: 4 },
    { pos: 8, uid: OTHER, len: 4 },
];

const QR_URL = "https://qr.example.invalid/card.png";
const CARD = { replies: { "/mget-qr": { data: { [OTHER]: QR_URL } } }, reply: { msgId: MSG_ID } };

const PREVIEW = {
    data: {
        thumb: "https://img.example.invalid/t.jpg",
        title: "A page",
        desc: "What the page says",
        src: "example.invalid",
        href: "https://example.invalid/page",
        media: { type: 0, count: 0, mediaTitle: "", artist: "", streamUrl: "", stream_icon: "" },
        stream_icon: "",
    },
    error_maps: {},
};
const LINK = { replies: { "/parselink": { data: PREVIEW } }, reply: { msgId: MSG_ID } };

const VOICE_URL = `https://${HOSTED_HOST}/v.aac`;
const VIDEO = Object.freeze({
    videoUrl: `https://${HOSTED_HOST}/clip.mp4`,
    thumbnailUrl: `https://${HOSTED_HOST}/clip.jpg`,
    msg: "a clip",
    duration: 4000,
    width: 1280,
    height: 720,
});

/** The last request of a record side that went to a Zalo host. */
const lastZalo = (side) => side.requests.filter((r) => r.service !== HOSTED_HOST).at(-1);

/**
 * The reported id is the one on the wire: red when a send reads the clock again, or reports nothing.
 *
 * @param {{requests: object[], result: object}} own
 * @param {(result: object) => string} pick - where the result carries it
 * @param {string} [key] - the wire param that holds it
 */
function reportsWireId(own, pick, key = "clientId") {
    const wire = lastZalo(own).params[key];
    assert.ok(wire !== undefined, `the request carries ${key}`);
    assert.equal(pick(own.result), String(wire), "the reported cliMsgId is the id that went on the wire");
}

/**
 * Every case: `name` (unique; the golden key), `method`, `args`,
 * `fixture` (wire.run's canned answers), and `check(own)`: assertions on our side alone, each saying what turns it
 * red.
 */
const CASES = [
    {
        name: "sendMessage/plain-dm",
        method: "sendMessage",
        args: ["hello there", USER, 0],
        fixture: sent,
        check(own) {
            const req = own.requests[0];
            assert.equal(req.path, "/api/message/sms");
            assert.deepEqual(req.params, { message: "hello there", clientId: T0, imei: FAKE.imei, ttl: 0, toid: USER });
            // The JSON contract of `msg send --json`: red if the shape changes.
            assert.deepEqual(own.result, { message: { msgId: MSG_ID, cliMsgId: String(T0) }, attachment: [] });
        },
    },
    {
        name: "sendMessage/plain-group",
        method: "sendMessage",
        args: ["hello there", GROUP, 1],
        fixture: sent,
        check(own) {
            assert.equal(own.requests[0].service, "group");
            assert.equal(own.requests[0].path, "/api/group/sendmsg");
            reportsWireId(own, (r) => r.message.cliMsgId);
        },
    },
    {
        name: "sendMessage/styled-dm",
        method: "sendMessage",
        args: [{ msg: "hello there", styles: STYLES }, USER, 0],
        fixture: sent,
        check(own) {
            // `ind_$` with indentSize 2 is `ind_20`, and indentSize is not sent: red if the rewrite is forgotten.
            assert.deepEqual(JSON.parse(own.requests[0].params.textProperties), {
                styles: [
                    { start: 0, len: 5, st: "b" },
                    { start: 6, len: 5, st: "ind_20" },
                    { start: 6, len: 5, st: "lst_1" },
                ],
                ver: 0,
            });
        },
    },
    {
        name: "sendMessage/styled-group",
        method: "sendMessage",
        args: [{ msg: "hello there", styles: STYLES }, GROUP, 1],
        fixture: sent,
    },
    {
        name: "sendMessage/styles-empty",
        method: "sendMessage",
        args: [{ msg: "hello there", styles: [] }, USER, 0],
        fixture: sent,
    },
    {
        name: "sendMessage/mention-group",
        method: "sendMessage",
        args: [{ msg: "@All hi @Bob", mentions: MENTIONS }, GROUP, 1],
        fixture: sent,
        check(own) {
            const req = own.requests[0];
            assert.equal(req.path, "/api/group/mention");
            // @All is type 1, a member type 0.
            assert.deepEqual(JSON.parse(req.params.mentionInfo), [
                { pos: 0, uid: "-1", len: 4, type: 1 },
                { pos: 8, uid: OTHER, len: 4, type: 0 },
            ]);
            reportsWireId(own, (r) => r.message.cliMsgId);
        },
    },
    {
        name: "sendMessage/mention-dm",
        method: "sendMessage",
        args: [{ msg: "@All hi @Bob", mentions: MENTIONS }, USER, 0],
        fixture: sent,
        check(own) {
            // A 1-1 chat has no mentions: plain sms, no mentionInfo. Red if the mentions reach the wire.
            assert.equal(own.requests[0].path, "/api/message/sms");
            assert.equal(own.requests[0].params.mentionInfo, undefined);
        },
    },
    {
        name: "sendMessage/quote-dm",
        method: "sendMessage",
        args: [{ msg: "a reply", quote: QUOTE }, USER, 0],
        fixture: sent,
        check(own) {
            const p = own.requests[0].params;
            assert.equal(own.requests[0].path, "/api/message/quote");
            assert.equal(p.qmsgType, 1, "webchat is client type 1");
            assert.equal(p.qmsgCliId, QUOTE.cliMsgId);
            assert.equal(p.qmsgAttach, undefined, "a 1-1 text quote carries no qmsgAttach");
            reportsWireId(own, (r) => r.message.cliMsgId);
        },
    },
    {
        name: "sendMessage/quote-group",
        method: "sendMessage",
        args: [{ msg: "a reply", quote: QUOTE }, GROUP, 1],
        fixture: sent,
        check(own) {
            const p = own.requests[0].params;
            assert.equal(own.requests[0].path, "/api/group/quote");
            assert.deepEqual(JSON.parse(p.qmsgAttach), QUOTE.propertyExt);
            reportsWireId(own, (r) => r.message.cliMsgId);
        },
    },
    {
        name: "sendMessage/quote-group-styled-urgent",
        method: "sendMessage",
        args: [{ msg: "a reply", quote: QUOTE, styles: STYLES.slice(0, 1), urgency: 2 }, GROUP, 1],
        fixture: sent,
    },
    {
        name: "sendMessage/urgency-dm",
        method: "sendMessage",
        args: [{ msg: "hello there", urgency: 2 }, USER, 0],
        fixture: sent,
        check(own) {
            // An object inside the sealed JSON, not a string: red if it is stringified.
            assert.deepEqual(own.requests[0].params.metaData, { urgency: 2 });
        },
    },
    {
        name: "sendMessage/urgency-group",
        method: "sendMessage",
        args: [{ msg: "hello there", urgency: 1 }, GROUP, 1],
        fixture: sent,
    },
    {
        name: "sendMessage/urgency-mention",
        method: "sendMessage",
        args: [{ msg: "@All hi @Bob", mentions: MENTIONS, urgency: 1 }, GROUP, 1],
        fixture: sent,
    },
    {
        name: "sendMessage/missing-content",
        method: "sendMessage",
        args: [{ msg: "" }, USER, 0],
        fixture: sent,
        check(own) {
            assert.equal(own.requests.length, 0, "refused before any request");
            assert.deepEqual(own.error, { message: "Missing message content", code: null });
        },
    },
    {
        name: "sendMessage/mentions-too-long",
        method: "sendMessage",
        args: [{ msg: "@A", mentions: [{ pos: 0, uid: OTHER, len: 9 }] }, GROUP, 1],
        fixture: sent,
        check(own) {
            assert.equal(own.requests.length, 0, "refused before any request");
            assert.match(own.error.message, /mention characters exceed message length/);
        },
    },
    {
        name: "sendCard/dm",
        method: "sendCard",
        args: [{ userId: OTHER, phoneNumber: "0901234567" }, USER, 0],
        fixture: CARD,
        check(own) {
            assert.equal(own.requests[0].path, "/api/friend/mget-qr");
            assert.deepEqual(own.requests[0].params, { fids: [OTHER] });
            const send = own.requests[1];
            assert.equal(send.path, "/api/message/forward");
            assert.equal(send.params.msgType, 6);
            assert.deepEqual(JSON.parse(send.params.msgInfo), {
                contactUid: OTHER,
                qrCodeUrl: QR_URL,
                phone: "0901234567",
            });
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendCard/group",
        method: "sendCard",
        args: [{ userId: OTHER }, GROUP, 1],
        fixture: CARD,
        check(own) {
            assert.equal(own.requests[1].path, "/api/group/forward");
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendSticker/dm",
        method: "sendSticker",
        args: [{ id: 21000, cateId: 10500, type: 7 }, USER, 0],
        fixture: sent,
        check(own) {
            assert.equal(own.requests[0].path, "/api/message/sticker");
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendSticker/group",
        method: "sendSticker",
        args: [{ id: 21000, cateId: 0, type: 3 }, GROUP, 1],
        fixture: sent,
        check(own) {
            // cateId 0 is a real category, not a missing one.
            assert.equal(own.requests[0].params.cateId, 0);
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendSticker/missing-cate",
        method: "sendSticker",
        args: [{ id: 21000, type: 3 }, GROUP, 1],
        fixture: sent,
        check(own) {
            assert.equal(own.requests.length, 0);
            assert.deepEqual(own.error, { message: "Missing sticker cateId", code: null });
        },
    },
    {
        name: "searchSticker",
        method: "searchSticker",
        args: ["hello"],
        fixture: { reply: [{ sticker_id: 21000, cate_id: 10500, type: 7 }] },
        check(own) {
            assert.equal(own.requests[0].method, "GET");
            assert.equal(own.requests[0].service, "sticker");
        },
    },
    {
        name: "searchSticker/limit",
        method: "searchSticker",
        args: ["hello", 5],
        fixture: { reply: [] },
    },
    {
        name: "getStickers",
        method: "getStickers",
        args: ["hello"],
        fixture: {
            reply: { sugg_sticker: [{ sticker_id: 21000 }, { sticker_id: 21001 }], sugg_gif: [], sugg_guggy: [] },
        },
        check(own) {
            assert.equal(own.requests[0].path, "/api/message/sticker/suggest/stickers");
            assert.deepEqual(own.result, [21000, 21001]);
        },
    },
    {
        // Zalo suggests GIFs only: no `sugg_sticker` list at all.
        name: "getStickers/no-suggestions",
        method: "getStickers",
        args: ["hello"],
        fixture: { reply: { sugg_gif: [], sugg_guggy: [] } },
        check(own) {
            // Red when the list is read unguarded (`data.sugg_sticker.map`): that throws instead.
            assert.equal(own.error, null);
            assert.deepEqual(own.result, []);
        },
    },
    {
        // An answer with no data object: the previous engine throws reading it, ours finds no suggestion.
        name: "getStickers/no-data",
        method: "getStickers",
        args: ["hello"],
        fixture: { reply: null },
        check(own) {
            assert.equal(own.error, null);
            assert.deepEqual(own.result, []);
        },
    },
    {
        name: "getStickersDetail",
        method: "getStickersDetail",
        args: [[21000, 21001]],
        fixture: {
            replies: {
                "/sticker_detail": [
                    { data: { id: 21000, cateId: 10500, type: 7 } },
                    { inner: { error_code: 120, error_message: "gone" } },
                ],
            },
        },
        check(own) {
            // One request per id; a refused id is left out, not thrown.
            assert.deepEqual(
                own.requests.map((r) => r.params),
                [{ sid: 21000 }, { sid: 21001 }],
            );
            assert.deepEqual(own.result, [{ id: 21000, cateId: 10500, type: 7 }]);
        },
    },
    {
        name: "getStickerCategoryDetail",
        method: "getStickerCategoryDetail",
        args: [10500],
        fixture: { reply: [{ sticker_id: 21000 }] },
        check(own) {
            assert.equal(own.requests[0].path, "/api/message/sticker/category/sticker_detail");
        },
    },
    {
        name: "parseLink",
        method: "parseLink",
        args: ["https://example.invalid/page"],
        fixture: { reply: PREVIEW },
        check(own) {
            assert.equal(own.requests[0].method, "GET");
            assert.deepEqual(own.requests[0].params, {
                link: "https://example.invalid/page",
                version: 1,
                imei: FAKE.imei,
            });
            assert.deepEqual(own.result, PREVIEW);
        },
    },
    {
        name: "parseLink/encoded",
        method: "parseLink",
        args: ["https://example.invalid/trang chủ"],
        fixture: { reply: PREVIEW },
    },
    {
        name: "parseLink/already-encoded",
        method: "parseLink",
        args: ["https://example.invalid/trang%20ch%E1%BB%A7"],
        fixture: { reply: PREVIEW },
        check(own) {
            // Encoded once, not twice: red if `%` becomes `%25`.
            assert.equal(own.requests[0].params.link, "https://example.invalid/trang%20ch%E1%BB%A7");
        },
    },
    {
        name: "sendLink/dm",
        method: "sendLink",
        args: [{ link: "https://example.invalid/page" }, USER, 0],
        fixture: LINK,
        check(own) {
            assert.equal(own.requests[0].path, "/api/message/parselink");
            const p = own.requests[1].params;
            assert.equal(own.requests[1].path, "/api/message/link");
            assert.equal(p.msg, "https://example.invalid/page");
            assert.equal(p.mentionInfo, "");
            assert.deepEqual(JSON.parse(p.media), PREVIEW.data.media);
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendLink/group-caption",
        method: "sendLink",
        args: [{ link: "https://example.invalid/page", msg: "look" }, GROUP, 1],
        fixture: LINK,
        check(own) {
            assert.equal(own.requests[1].path, "/api/group/sendlink");
            assert.equal(own.requests[1].params.msg, "look https://example.invalid/page", "the link joins the caption");
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendVoice/dm",
        method: "sendVoice",
        args: [{ voiceUrl: VOICE_URL }, USER, 0],
        fixture: sent,
        check(own) {
            // Web forwards a voice with no HEAD to its host and no fileSize: red if either comes back.
            assert.deepEqual(
                own.requests.map((r) => r.method),
                ["POST"],
            );
            const p = own.requests[0].params;
            assert.equal(p.msgType, 3);
            assert.deepEqual(JSON.parse(p.msgInfo), { voiceUrl: VOICE_URL, m4aUrl: VOICE_URL });
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendVoice/group",
        method: "sendVoice",
        args: [{ voiceUrl: VOICE_URL }, GROUP, 1],
        fixture: sent,
        check(own) {
            assert.equal(own.requests.length, 1, "no HEAD");
            assert.equal(own.requests[0].path, "/api/group/forward");
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendVideo/dm",
        method: "sendVideo",
        args: [VIDEO, USER, 0],
        fixture: sent,
        check(own) {
            const head = own.requests[0];
            assert.equal(head.method, "HEAD");
            assert.equal(head.service, HOSTED_HOST);
            // A third-party host: no Zalo cookie (one is planted for it in the jar), Origin or Referer.
            assert.equal(head.headers.cookie, undefined);
            assert.equal(head.headers.origin, undefined);
            assert.equal(head.headers.referer, undefined);
            const p = own.requests[1].params;
            assert.equal(p.msgType, 5);
            const info = JSON.parse(p.msgInfo);
            assert.equal(info.fileSize, 48000);
            assert.equal(info.width, 1280);
            assert.equal(info.height, 720);
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendVideo/group",
        method: "sendVideo",
        args: [VIDEO, GROUP, 1],
        fixture: sent,
        check(own) {
            reportsWireId(own, (r) => r.cliMsgId);
        },
    },
    {
        name: "sendVideo/no-geometry",
        method: "sendVideo",
        args: [{ ...VIDEO, width: undefined, height: undefined }, USER, 0],
        fixture: sent,
        check(own) {
            // Not even the HEAD: red if the refusal moves after any request.
            assert.equal(own.requests.length, 0);
            assert.match(own.error.message, /width and height/);
        },
    },
    {
        name: "sendBankCard/group",
        method: "sendBankCard",
        args: [{ binBank: 970448, numAccBank: "0123456789", nameAccBank: "Nguyen Van A" }, GROUP, 1],
        fixture: { reply: "" },
        check(own) {
            const p = own.requests[0].params;
            assert.equal(own.requests[0].service, "zimsg");
            assert.equal(p.nameAccBank, "NGUYEN VAN A");
            assert.equal(p.destType, 1);
            // Zalo's answer is empty; the stamped id is the only one the caller gets.
            reportsWireId(own, (r) => r.cliMsgId, "cliMsgId");
        },
    },
    {
        name: "sendBankCard/dm",
        method: "sendBankCard",
        args: [{ binBank: 970448, numAccBank: "0123456789" }, USER, 0],
        fixture: { reply: "" },
        check(own) {
            assert.equal(own.requests[0].params.nameAccBank, "---");
            assert.equal(own.requests[0].params.destType, 0);
            reportsWireId(own, (r) => r.cliMsgId, "cliMsgId");
        },
    },
    {
        name: "sendTypingEvent/dm",
        method: "sendTypingEvent",
        args: [USER, 0],
        fixture: { reply: "" },
        check(own) {
            assert.deepEqual(own.requests[0].params, { toid: USER, destType: 3, imei: FAKE.imei });
        },
    },
    {
        name: "sendTypingEvent/group",
        method: "sendTypingEvent",
        args: [GROUP, 1],
        fixture: { reply: "" },
        check(own) {
            assert.equal(own.requests[0].path, "/api/group/typing");
            assert.deepEqual(own.requests[0].params, { grid: GROUP, imei: FAKE.imei });
        },
    },
    {
        name: "sendReport/dm",
        method: "sendReport",
        args: [{ reason: 1 }, USER, 0],
        fixture: { reply: { reportId: "77" } },
        check(own) {
            assert.equal(own.requests[0].path, "/api/report/abuse-v2");
            // The person report sends the reason as a string, and no content unless the reason is "other".
            assert.deepEqual(own.requests[0].params, { idTo: USER, objId: "person.profile", reason: "1" });
        },
    },
    {
        name: "sendReport/dm-other",
        method: "sendReport",
        args: [{ reason: 0, content: "spam" }, USER, 0],
        fixture: { reply: { reportId: "77" } },
    },
    {
        name: "sendReport/group",
        method: "sendReport",
        args: [{ reason: 2 }, GROUP, 1],
        fixture: { reply: "" },
        check(own) {
            assert.equal(own.requests[0].path, "/api/social/profile/reportabuse");
            assert.deepEqual(own.requests[0].params, {
                uidTo: GROUP,
                type: 14,
                reason: 2,
                content: "",
                imei: FAKE.imei,
            });
        },
    },
    {
        name: "sendReport/group-other",
        method: "sendReport",
        args: [{ reason: 0, content: "spam" }, GROUP, 1],
        fixture: { reply: "" },
    },
    {
        name: "scanURL",
        method: "scanURL",
        args: ["https://example.invalid/page"],
        fixture: { reply: { isSafe: true } },
        check(own) {
            assert.equal(own.requests[0].method, "POST");
            assert.equal(own.requests[0].service, "file");
            assert.deepEqual(own.result, { isSafe: true });
        },
    },
];

/** One call per method for the error cases: the method, its arguments. */
const ERROR_CALLS = [
    ["sendMessage", ["hello there", USER, 0]],
    ["sendCard", [{ userId: OTHER }, USER, 0]],
    ["sendSticker", [{ id: 21000, cateId: 10500, type: 7 }, USER, 0]],
    ["searchSticker", ["hello"]],
    ["getStickers", ["hello"]],
    ["getStickersDetail", [[21000]]],
    ["getStickerCategoryDetail", [10500]],
    ["parseLink", ["https://example.invalid/page"]],
    ["sendLink", [{ link: "https://example.invalid/page" }, USER, 0]],
    ["sendVoice", [{ voiceUrl: VOICE_URL }, USER, 0]],
    ["sendVideo", [VIDEO, USER, 0]],
    ["sendBankCard", [{ binBank: 970448, numAccBank: "0123456789" }, USER, 0]],
    ["sendTypingEvent", [USER, 0]],
    ["sendReport", [{ reason: 1 }, USER, 0]],
    ["scanURL", ["https://example.invalid/page"]],
];

/** The error answers, by kind. */
const ERRORS = {
    outer: { error: { outer: { error_code: 102, error_message: "session expired", data: null } } },
    inner: { error: { inner: { error_code: 114, error_message: "invalid params" } } },
    http500: { error: { status: 500 } },
    undecryptable: { error: { undecryptable: true } },
};

/** Answer the hosted host's HEAD (installed again after every `clearRoutes`, since wire.run clears them). */
function installHosted(fake) {
    const clear = fake.clearRoutes;
    const add = () =>
        fake.rawRoute(
            (r) => r.host === HOSTED_HOST,
            (r) =>
                HOSTED.hang
                    ? new Promise((_, reject) => r.signal?.addEventListener("abort", () => reject(r.signal.reason)))
                    : new Response(null, { status: 200, headers: { "content-length": HOSTED.length } }),
        );
    fake.clearRoutes = () => {
        clear();
        add();
    };
    add();
}

describe("messages on the wire", () => {
    let wire;

    before(async () => {
        wire = await openWire();
        installHosted(wire.fake);
        // A cookie every fake Zalo host gets, so the Cookie header is recorded with a value; and one for the hosted
        // host, which a HEAD that went through the session's cookie jar would carry.
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
        wire.ctx.cookie.setCookieSync("tracker=fake-t; Path=/", `https://${HOSTED_HOST}/`);
    });
    after(() => wire?.close());

    for (const c of CASES) {
        it(c.name, async () => {
            const rec = await wire.run(c.method, c.args, c.fixture);
            await expectGolden("messages", c.name, rec.own);
            c.check?.(rec.own);
        });
    }

    describe("error answers", () => {
        for (const [method, args] of ERROR_CALLS) {
            for (const [kind, fixture] of Object.entries(ERRORS)) {
                it(`${method}: ${kind}`, async () => {
                    const rec = await wire.run(method, args, fixture);
                    if (method === "getStickersDetail") {
                        // A refused id is dropped, not thrown: the answer is [].
                        assert.deepEqual(rec.own.result, []);
                    } else if (kind === "http500") {
                        // No code; the text is the kernel's own ("HTTP 500", K1).
                        assert.deepEqual(rec.own.error, { message: "HTTP 500", code: null });
                    } else {
                        const expected = {
                            outer: { message: "session expired", code: 102 },
                            inner: { message: "invalid params", code: 114 },
                            undecryptable: { message: "Failed to parse response data", code: null },
                        }[kind];
                        assert.deepEqual(rec.own.error, expected);
                    }
                    await expectGolden("messages", `${method}/error-${kind}`, rec.own);
                });
            }
        }
    });
});

describe("messages: the session's client ids, the hosted HEAD, the URL scan", () => {
    let wire;
    let api;
    let clock;

    before(async () => {
        wire = await openWire();
        installHosted(wire.fake);
        wire.ctx.cookie.setCookieSync("tracker=fake-t; Path=/", `https://${HOSTED_HOST}/`);
        clock = T0;
        api = await createApi(wire.ctx, wire.ctx.loginInfo.zpw_service_map_v3, ["wss://ws.zalo.invalid/"], {
            now: () => clock,
        });
    });
    after(() => wire?.close());

    it("gives 50 sends in one millisecond 50 different client ids, each reported as it went out", async () => {
        wire.fake.clearRoutes();
        wire.fake.routeAnswer("/mget-qr", { data: { [OTHER]: QR_URL } });
        wire.fake.routeAnswer("/parselink", { data: PREVIEW });
        wire.fake.routeAnswer("", { data: { msgId: MSG_ID } });
        const from = wire.fake.requests.length;
        // Every kind of send draws from the one session source; the clock never moves.
        const kinds = [
            () => api.sendMessage("hi", USER, 0).then((r) => r.message.cliMsgId),
            () => api.sendSticker({ id: 21000, cateId: 1, type: 7 }, GROUP, 1).then((r) => r.cliMsgId),
            () => api.sendCard({ userId: OTHER }, USER, 0).then((r) => r.cliMsgId),
            () => api.sendLink({ link: "https://example.invalid/page" }, GROUP, 1).then((r) => r.cliMsgId),
            () => api.sendVoice({ voiceUrl: VOICE_URL }, USER, 0).then((r) => r.cliMsgId),
        ];
        const reported = [];
        for (let i = 0; i < 50; i++) reported.push(await kinds[i % kinds.length]());
        const sends = wire.fake.requests
            .slice(from)
            .map((r) => normalizeRequest(r, wire.fake))
            .filter((r) => r.params && "clientId" in r.params);
        const onWire = sends.map((r) => String(r.params.clientId));
        // Red with a clock read per send (the previous engine): all 50 would be T0.
        assert.equal(new Set(onWire).size, 50, "no two sends share a client id");
        assert.deepEqual(
            onWire,
            Array.from({ length: 50 }, (_, i) => String(T0 + i)),
        );
        assert.deepEqual(reported, onWire, "each send reports the client id it put on the wire");
    });

    it("gives up on a hosted video whose host never answers the HEAD, and sends nothing to Zalo", async () => {
        wire.fake.clearRoutes();
        wire.fake.routeAnswer("", { data: { msgId: MSG_ID } });
        HOSTED.hang = true;
        const from = wire.fake.requests.length;
        try {
            await assert.rejects(
                api.sendVideo({ ...VIDEO, timeoutMs: 50 }, USER, 0),
                (e) => e.code === null && /^Unable to get video content: no answer within 50 ms$/.test(e.message),
            );
        } finally {
            HOSTED.hang = false;
        }
        const made = wire.fake.requests.slice(from);
        assert.equal(made.length, 1, "the HEAD only");
        assert.equal(made[0].host, HOSTED_HOST);
    });

    it("sends a hosted voice even when its host never answers, since it asks that host nothing", async () => {
        wire.fake.clearRoutes();
        wire.fake.routeAnswer("", { data: { msgId: MSG_ID } });
        HOSTED.hang = true;
        const from = wire.fake.requests.length;
        try {
            // Red with the HEAD back: the send would hang on the host, then fail.
            const r = await api.sendVoice({ voiceUrl: VOICE_URL }, USER, 0);
            assert.equal(r.msgId, MSG_ID);
        } finally {
            HOSTED.hang = false;
        }
        const made = wire.fake.requests.slice(from);
        assert.deepEqual(
            made.map((q) => q.host === HOSTED_HOST),
            [false],
        );
    });

    it("waits a bounded time for a HEAD by default", () => {
        // Red if the default timeout is removed (the previous engine waits forever).
        assert.ok(HEAD_TIMEOUT_MS > 0 && HEAD_TIMEOUT_MS <= 15000);
    });

    it("passes a forward's m4a URL, with no size", async () => {
        wire.fake.clearRoutes();
        wire.fake.routeAnswer("", { data: { msgId: MSG_ID } });
        const from = wire.fake.requests.length;
        const m4a = `https://${HOSTED_HOST}/v.m4a`;
        await api.sendVoice({ voiceUrl: VOICE_URL, m4aUrl: m4a }, USER, 0);
        const made = wire.fake.requests.slice(from).map((r) => normalizeRequest(r, wire.fake));
        assert.equal(made.length, 1, "no HEAD");
        assert.deepEqual(JSON.parse(made[0].params.msgInfo), { voiceUrl: VOICE_URL, m4aUrl: m4a });
    });

    it("gives up on a URL scan Zalo does not answer after 5 s, Web's scanUrl timeout, not the 10 s default", async () => {
        wire.fake.clearRoutes();
        wire.fake.routeAnswer("/scanurl", { hang: true });
        const started = Date.now();
        // Red when the endpoint loses its own timeout: the kernel's default then gives up after 10 s, not 5.
        await assert.rejects(api.scanURL("https://example.invalid/page"), /did not answer within 5 s/);
        const waited = Date.now() - started;
        assert.ok(waited >= 4500 && waited < 9000, `waited ${waited} ms`);
        assert.equal(ENDPOINTS.scanUrl.timeoutMs, 5000);
    });

    it("defines exactly the methods this file covers, sendText included", () => {
        const names = Object.keys(messageMethods({ ctx: {}, call: async () => null, now: () => 0 }));
        assert.ok(names.includes("sendText"));
        // Red when a method is added to the area without a case here, or one covered here is removed.
        const covered = new Set([...CASES.map((c) => c.method), ...ERROR_CALLS.map(([m]) => m)]);
        covered.delete("sendMessage");
        covered.add("sendText");
        assert.deepEqual([...covered].sort(), names.sort());
    });
});
