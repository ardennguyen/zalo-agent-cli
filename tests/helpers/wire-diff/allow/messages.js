/**
 * Intended differences between zca-js and our engine for the messages area: one row per difference, each also recorded
 * in golden/messages.js. Owned by package MSG; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Offsets are into Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` (API module `fBUP`); they move with every build.
 *
 * `cases` (an addition of this file, read by tests/unit/wire-messages.test.js) names the cases a row is about; an
 * entry ending in `*` is a prefix (`"sendSticker/error-*"`: every error answer of that method). compare.js requires
 * every row it is given to be seen, so the test hands it only the rows of the case it runs.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 */

/** The session's fake imei (tests/unit/fake-zalo-session.js `FAKE.imei`): any non-empty string is accepted here. */
const anImei = (v) => typeof v === "string" && v.length > 0;

/**
 * A key order difference: zca-js's order and Web's.
 *
 * @param {string} method
 * @param {string[]} cases
 * @param {string[]} zca
 * @param {string[]} own
 * @param {string} why
 * @returns {object}
 */
const order = (method, cases, zca, own, why) => ({ method, cases, field: "paramsOrder", zca, own, why });

const ZTEXT = "Web sendZText @11618594 builds {message, clientId, imei}, then buildParams @11617320 appends";
const MENTION = "Web sendMentionMessage @11622562 builds {grid, message, clientId, mentionInfo, language, visibility}";
const GQUOTE = "Web sendGroupQuoteMessage @11621113 (+ transformQuoteMessage @11620093)";
const FORWARD = "Web forwardMessage @11626241 builds the thread keys first, transformForwardMessage @11624708 the rest";
const LINK = "Web sendLinkMessage @11621788";

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, cases?: string[]}>} */
export default [
    // ── sendMessage (text) ─────────────────────────────────────────────────────────────────────────────────────
    {
        method: "sendMessage",
        cases: ["sendMessage/plain-group", "sendMessage/styled-group", "sendMessage/urgency-group"],
        field: "params.imei",
        zca: undefined,
        own: anImei,
        why: `${ZTEXT}: group text carries imei too; zca-js omits it on /api/group/sendmsg`,
    },
    order(
        "sendMessage",
        ["sendMessage/plain-group"],
        ["message", "clientId", "ttl", "visibility", "grid"],
        ["message", "clientId", "imei", "ttl", "visibility", "grid"],
        `${ZTEXT} ttl, then visibility and grid`,
    ),
    order(
        "sendMessage",
        ["sendMessage/styled-dm"],
        ["message", "clientId", "imei", "ttl", "toid", "textProperties"],
        ["message", "clientId", "imei", "textProperties", "ttl", "toid"],
        `${ZTEXT} textProperties before ttl, then toid`,
    ),
    order(
        "sendMessage",
        ["sendMessage/styled-group"],
        ["message", "clientId", "ttl", "visibility", "grid", "textProperties"],
        ["message", "clientId", "imei", "textProperties", "ttl", "visibility", "grid"],
        `${ZTEXT} textProperties before ttl, then visibility and grid`,
    ),
    order(
        "sendMessage",
        ["sendMessage/urgency-dm"],
        ["message", "clientId", "imei", "ttl", "toid", "metaData"],
        ["message", "clientId", "imei", "metaData", "ttl", "toid"],
        `${ZTEXT} metaData before ttl, then toid`,
    ),
    order(
        "sendMessage",
        ["sendMessage/urgency-group"],
        ["message", "clientId", "ttl", "visibility", "grid", "metaData"],
        ["message", "clientId", "imei", "metaData", "ttl", "visibility", "grid"],
        `${ZTEXT} metaData before ttl, then visibility and grid`,
    ),
    {
        method: "sendMessage",
        cases: ["sendMessage/styles-empty"],
        field: "params.textProperties",
        zca: '{"styles":[],"ver":0}',
        own: undefined,
        why: "Web buildParams @11617320 writes textProperties only when the style list is non-empty",
    },
    order(
        "sendMessage",
        ["sendMessage/styles-empty"],
        ["message", "clientId", "imei", "ttl", "toid", "textProperties"],
        ["message", "clientId", "imei", "ttl", "toid"],
        "Web buildParams @11617320: no textProperties for an empty style list",
    ),
    {
        method: "sendMessage",
        cases: [
            "sendMessage/mention-group",
            "sendMessage/urgency-mention",
            "sendMessage/quote-group",
            "sendMessage/quote-group-styled-urgent",
        ],
        field: "params.language",
        zca: undefined,
        own: "vi",
        why: `${MENTION} and ${GQUOTE} both send the UI language; zca-js omits it`,
    },
    order(
        "sendMessage",
        ["sendMessage/mention-group"],
        ["message", "clientId", "mentionInfo", "ttl", "visibility", "grid"],
        ["grid", "message", "clientId", "mentionInfo", "language", "visibility", "ttl"],
        `${MENTION}, then buildParams appends ttl`,
    ),
    order(
        "sendMessage",
        ["sendMessage/urgency-mention"],
        ["message", "clientId", "mentionInfo", "ttl", "visibility", "grid", "metaData"],
        ["grid", "message", "clientId", "mentionInfo", "language", "visibility", "metaData", "ttl"],
        `${MENTION}, then buildParams appends metaData and ttl`,
    ),
    order(
        "sendMessage",
        ["sendMessage/quote-group"],
        [
            "grid",
            "message",
            "clientId",
            "qmsgOwner",
            "qmsgId",
            "qmsgCliId",
            "qmsgType",
            "qmsgTs",
            "qmsg",
            "visibility",
            "qmsgAttach",
            "qmsgTTL",
            "ttl",
        ],
        [
            "grid",
            "message",
            "clientId",
            "language",
            "qmsgOwner",
            "qmsgId",
            "qmsgCliId",
            "qmsgType",
            "qmsg",
            "qmsgTs",
            "visibility",
            "qmsgAttach",
            "qmsgTTL",
            "ttl",
        ],
        `${GQUOTE}: language after clientId, qmsg before qmsgTs`,
    ),
    order(
        "sendMessage",
        ["sendMessage/quote-group-styled-urgent"],
        [
            "grid",
            "message",
            "clientId",
            "qmsgOwner",
            "qmsgId",
            "qmsgCliId",
            "qmsgType",
            "qmsgTs",
            "qmsg",
            "visibility",
            "qmsgAttach",
            "qmsgTTL",
            "ttl",
            "textProperties",
            "metaData",
        ],
        [
            "grid",
            "message",
            "clientId",
            "language",
            "qmsgOwner",
            "qmsgId",
            "qmsgCliId",
            "qmsgType",
            "qmsg",
            "qmsgTs",
            "visibility",
            "textProperties",
            "metaData",
            "qmsgAttach",
            "qmsgTTL",
            "ttl",
        ],
        `${GQUOTE}: textProperties and metaData before qmsgAttach, qmsgTTL and ttl last`,
    ),

    // ── sendCard ───────────────────────────────────────────────────────────────────────────────────────────────
    order(
        "sendCard",
        ["sendCard/dm"],
        ["ttl", "msgType", "clientId", "msgInfo", "toId", "imei"],
        ["toId", "imei", "ttl", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {toId, imei}, ttl, msgType, clientId, msgInfo`,
    ),
    order(
        "sendCard",
        ["sendCard/group"],
        ["ttl", "msgType", "clientId", "msgInfo", "visibility", "grid"],
        ["grid", "visibility", "ttl", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {grid, visibility}, ttl, msgType, clientId, msgInfo`,
    ),

    // ── stickers ───────────────────────────────────────────────────────────────────────────────────────────────
    {
        method: "sendSticker",
        cases: ["sendSticker/dm", "sendSticker/group", "sendSticker/error-*"],
        field: "params.ttl",
        zca: undefined,
        own: 0,
        why: "Web sendSticker @11627793 always writes ttl (buildParams); zca-js sends none",
    },
    order(
        "sendSticker",
        ["sendSticker/dm", "sendSticker/error-*"],
        ["stickerId", "cateId", "type", "clientId", "imei", "zsource", "toid"],
        ["stickerId", "cateId", "type", "clientId", "imei", "zsource", "ttl", "toid"],
        "Web sendSticker @11627793: zsource, then ttl, then the thread key",
    ),
    order(
        "sendSticker",
        ["sendSticker/group"],
        ["stickerId", "cateId", "type", "clientId", "imei", "zsource", "grid"],
        ["stickerId", "cateId", "type", "clientId", "imei", "zsource", "ttl", "grid"],
        "Web sendSticker @11627793: zsource, then ttl, then the thread key",
    ),
    {
        method: "searchSticker",
        cases: ["searchSticker", "searchSticker/error-*"],
        field: "params.limit",
        zca: 50,
        own: 10,
        why: "Web searchSticker @11652412 defaults the limit to 10; the engine reads only the first hit",
    },
    {
        method: "getStickerCategoryDetail",
        cases: ["getStickerCategoryDetail", "getStickerCategoryDetail/error-*"],
        field: "params.cid",
        zca: 10500,
        own: "10500",
        why: 'Web getStickerCategoryDetail @11592445 writes the params by hand as {"cid":"<id>"}: a string',
    },

    // ── links ──────────────────────────────────────────────────────────────────────────────────────────────────
    {
        method: "parseLink",
        cases: ["parseLink/encoded"],
        field: "params.link",
        zca: "https://example.invalid/trang chủ",
        own: "https://example.invalid/trang%20ch%E1%BB%A7",
        why: "Web getLinkInformation @11591053 encodeURI()s a link that is not URI-encoded yet",
    },
    {
        method: "sendLink",
        cases: ["sendLink/dm", "sendLink/group-caption"],
        field: "params.type",
        zca: 2,
        own: 0,
        why: `${LINK} defaults type to 0 (zca-js sends 2 beside a "// 0" comment); a live check in batch B`,
    },
    {
        method: "sendLink",
        cases: ["sendLink/dm", "sendLink/group-caption"],
        field: "params.language",
        zca: undefined,
        own: "vi",
        why: `${LINK} sends the UI language; zca-js omits it`,
    },
    {
        method: "sendLink",
        cases: ["sendLink/group-caption"],
        field: "params.mentionInfo",
        zca: undefined,
        own: "[]",
        why: `${LINK}: a group link carries mentionInfo as a JSON array, "[]" when none`,
    },
    order(
        "sendLink",
        ["sendLink/dm"],
        ["msg", "href", "src", "title", "desc", "thumb", "type", "media", "ttl", "clientId", "toId", "mentionInfo"],
        [
            "msg",
            "href",
            "src",
            "title",
            "desc",
            "language",
            "thumb",
            "type",
            "media",
            "ttl",
            "toId",
            "clientId",
            "mentionInfo",
        ],
        `${LINK}: language after desc; toId before clientId`,
    ),
    order(
        "sendLink",
        ["sendLink/group-caption"],
        ["msg", "href", "src", "title", "desc", "thumb", "type", "media", "ttl", "clientId", "grid", "imei"],
        [
            "msg",
            "href",
            "src",
            "title",
            "desc",
            "language",
            "thumb",
            "type",
            "media",
            "ttl",
            "grid",
            "clientId",
            "mentionInfo",
            "imei",
        ],
        `${LINK}: language after desc; grid, clientId, mentionInfo, imei`,
    ),

    // ── voice and video (the forward endpoint) ─────────────────────────────────────────────────────────────────
    {
        method: "sendVoice",
        cases: ["sendVoice/group"],
        field: "params.imei",
        zca: anImei,
        own: undefined,
        why: `${FORWARD}: the group form carries no imei`,
    },
    order(
        "sendVoice",
        ["sendVoice/dm", "sendVoice/error-*"],
        ["toId", "ttl", "zsource", "msgType", "clientId", "msgInfo", "imei"],
        ["toId", "imei", "ttl", "zsource", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {toId, imei}, ttl, zsource, msgType, clientId, msgInfo`,
    ),
    order(
        "sendVoice",
        ["sendVoice/group"],
        ["grid", "visibility", "ttl", "zsource", "msgType", "clientId", "msgInfo", "imei"],
        ["grid", "visibility", "ttl", "zsource", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {grid, visibility}, ttl, zsource, msgType, clientId, msgInfo; no imei`,
    ),
    {
        method: "sendVideo",
        cases: ["sendVideo/group"],
        field: "params.imei",
        zca: anImei,
        own: undefined,
        why: `${FORWARD}: the group form carries no imei`,
    },
    order(
        "sendVideo",
        ["sendVideo/dm", "sendVideo/error-*"],
        ["toId", "clientId", "ttl", "zsource", "msgType", "msgInfo", "imei"],
        ["toId", "imei", "ttl", "zsource", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {toId, imei}, ttl, zsource, msgType, clientId, msgInfo`,
    ),
    order(
        "sendVideo",
        ["sendVideo/group"],
        ["grid", "visibility", "clientId", "ttl", "zsource", "msgType", "msgInfo", "imei"],
        ["grid", "visibility", "ttl", "zsource", "msgType", "clientId", "msgInfo"],
        `${FORWARD}: {grid, visibility}, ttl, zsource, msgType, clientId, msgInfo; no imei`,
    ),
    // A video without its geometry: zca-js sends it with a made-up 1280x720 (Zalo answers 114 for a forward whose
    // cached params lack it); ours refuses before any request.
    {
        method: "sendVideo",
        cases: ["sendVideo/no-geometry"],
        field: "requests.length",
        zca: 2,
        own: 0,
        why: "ours refuses a video with no width/height before the HEAD and the send (spec-send 6.1: code 114)",
    },
    {
        method: "sendVideo",
        cases: ["sendVideo/no-geometry"],
        field: "result",
        zca: (v) => !!v && typeof v.msgId === "string",
        own: undefined,
        why: "ours refuses a video with no width/height: nothing is sent, so there is no result",
    },
    {
        method: "sendVideo",
        cases: ["sendVideo/no-geometry"],
        field: "error",
        zca: null,
        own: (v) => !!v && /width and height/.test(v.message) && v.code === null,
        why: "ours refuses a video with no width/height, naming what is missing",
    },

    // ── bank card ──────────────────────────────────────────────────────────────────────────────────────────────
    {
        method: "sendBankCard",
        cases: ["sendBankCard/group", "sendBankCard/dm"],
        field: "result",
        zca: "",
        own: (v, { own }) =>
            !!v && v.cliMsgId === String(own.requests[0].params.cliMsgId) && Object.keys(v).length === 1,
        why: "Zalo answers a bank card with an empty data; ours still returns the cliMsgId it sent (zca-js loses it)",
    },
];
