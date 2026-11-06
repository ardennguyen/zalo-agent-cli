/**
 * Intended differences between zca-js and our engine for the listener area: one row per difference, each also recorded
 * in golden/listener.js. Owned by package L2; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * `method` is the script name of tests/unit/wire-listener.test.js. Web citations are to the socket manager and
 * handlers of Zalo Web 26.11.10 (`1.c72c0957b455ab70b73c.js`), as agent/docs/zca-replace/spec-listener.md 3 reads
 * them.
 */
import { isDeepStrictEqual } from "node:util";

/**
 * The upgrade header names our listener sends, in order, as the fake socket records them (minus `Host` and
 * `Sec-WebSocket-Key`, which change on every connection): a browser's set, capitalized, the `ws` library's own five
 * where it puts them.
 */
export const OWN_UPGRADE_NAMES = Object.freeze([
    "Pragma",
    "Cache-Control",
    "User-Agent",
    "Origin",
    "Accept-Encoding",
    "Accept-Language",
    "Cookie",
    "Sec-WebSocket-Version",
    "Connection",
    "Upgrade",
    "Sec-WebSocket-Extensions",
]);

const isString = (v) => typeof v === "string";
const isEvent = (name) => (e) => e?.name === name;
const contentOf = (e) => e?.args?.[0]?.data?.content;

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function}>} */
export default [
    // ---- the upgrade -------------------------------------------------------------------------------------------
    {
        method: "handshake",
        field: "upgrade.url",
        zca: (v) => /^\/\?t=%3Ct%3E&zpw_ver=\d+&zpw_type=30$/.test(v),
        own: (v) => /^\/\?zpw_ver=\d+&zpw_type=30&t=%3Ct%3E$/.test(v),
        why: "Web connects to `config.url + '&t=' + Date.now()`: the common query first, the stamp last (socket manager `connect`, spec-listener 3 URL; D1)",
    },
    {
        method: "handshake",
        field: "upgrade.headers.prgama",
        zca: "no-cache",
        own: undefined,
        why: "zca-js misspells Pragma as `prgama`; a browser's upgrade sends `Pragma: no-cache` (spec-listener 3, Upgrade headers)",
    },
    {
        method: "handshake",
        field: "upgrade.headers.pragma",
        zca: undefined,
        own: "no-cache",
        why: "a browser's upgrade sends `Pragma: no-cache` (spec-listener 3, Upgrade headers)",
    },
    {
        method: "handshake",
        field: "upgrade.names.*",
        zca: (_v, { zca }) => zca.names.includes("prgama") && zca.names.includes("user-agent"),
        own: (_v, { own }) => isDeepStrictEqual(own.names, OWN_UPGRADE_NAMES),
        why: "header names as a browser writes them (capitalized), in Chromium's order where the ws library lets us choose; zca-js sent lowercase names and the typo (spec-listener 3, Upgrade headers)",
    },

    // ---- spec-listener 5: every list of every chat push ----------------------------------------------------------
    {
        method: "mixed-pushes",
        field: "event",
        zca: undefined,
        own: (e) =>
            isEvent("message")(e) && ["hello 2", "hello 3", "hello 4", "hello 5", "hello 6"].includes(contentOf(e)),
        why: "Web's chat handler reads msgs, groupMsgs and pageMsgs from every chat push, 504 and 524 included (`onOnlineData`/`preParseData` @~11751500, spec-listener 3 Push messages); zca-js read msgs from 501 only and ignored 504 and 524",
    },
    {
        method: "repush",
        field: "event",
        zca: undefined,
        own: (e) => isEvent("message")(e) && ["hello 1", "hello 2"].includes(contentOf(e)),
        why: "Web's chat handler reads 534 (the server's re-push of a message it never saw confirmed) like 501/521 (`onOnlineData` @~11751500, spec-listener 3 Push messages); zca-js ignored 534. The daemons let self-heal own it: a re-push of a stored message is not announced twice (src/core/self-heal.js isRepeatedRepush)",
    },

    // ---- spec-listener 6: Undo carries its thread type ----------------------------------------------------------
    {
        method: "undo",
        field: "event.args.0.type",
        zca: undefined,
        own: (v, { own }) => v === (own.args[0].isGroup ? 1 : 0),
        why: "Undo has a thread type (0 for a 1-1 recall, 1 for a group), so mcp.js normalizeUndo stops calling every DM recall a group recall (spec-listener 6; design 6.2)",
    },

    // ---- spec-listener 7: the Signal pushes ---------------------------------------------------------------------
    {
        method: "e2ee",
        field: "event",
        zca: undefined,
        own: (e) =>
            isEvent("message")(e) &&
            (["hello 1", "hello 3"].includes(contentOf(e)) ||
                (e.args[0].data.undecryptable === true && contentOf(e) === "")),
        why: "Web routes 551, 552 and 535 through `processOnlineE2ee` then the normal push path (@~11760000); without a Signal stack a chat.e2ee.* message is announced marked undecryptable with no ciphertext as text, others as a 501/521 would be (spec-listener 7; design 6.1 item 7). zca-js 2.2.0 ignored all three",
    },

    // ---- spec-listener 8: reactions item by item, and in 601 -----------------------------------------------------
    {
        method: "reactions",
        field: "event.args.0.message",
        zca: isString,
        own: "cmd 612 reacts: one item not readable (SyntaxError)",
        why: "the error for a reaction whose content is not JSON names the cmd and list it was in, not the parser's text (which varies by Node version and can quote the payload); the reaction is skipped alone (Web `processControl` parses each one, @~2845400)",
    },
    {
        method: "reactions",
        field: "event",
        zca: undefined,
        own: (e) => isEvent("reaction")(e) && e.args[0].isGroup === true,
        why: "Web reads reacts and reactGroups item by item and from every control frame, 601 included (`processControl` @~2845400, spec-listener 8); zca-js lost every reaction after a malformed one and read none in a 601",
    },

    // ---- spec-listener 3: ids and the frame's top level ---------------------------------------------------------
    {
        method: "ids-and-errors",
        field: "event.args.0.data.msgId",
        zca: 5,
        own: "5",
        why: "Web quotes the integers under its chat key list before parsing (`preParse`, msgId listed), so a small id arrives as a string too (spec-listener 3 Big ids; json-ids.js)",
    },
    {
        method: "ids-and-errors",
        field: "event.args.0.data.quote.ownerId",
        zca: (v) => isString(v) && v !== "2000000000000000004",
        own: "2000000000000000004",
        why: "an id past 2^53 in a plain (encrypt 0) frame keeps its digits under Web's `preParse` (ownerId listed); zca-js parsed plain frames with JSON.parse and rounded it",
    },
    {
        method: "ids-and-errors",
        field: "event.name",
        zca: "message",
        own: "error",
        why: "Web decodes a frame only when its top-level error_code is 0, and reports the code otherwise (`_onRawData` -> `_onDataError`, socket manager @~1.18M; spec-listener 3 Frame top level); zca-js never looked",
    },
    {
        method: "ids-and-errors",
        field: "event.args.0.*",
        when: ({ zca, own }) => zca?.name === "message" && own?.name === "error",
        zca: () => true,
        own: (_v, { own }) => own.args[0].code === 102 && /error_code 102/.test(own.args[0].message),
        why: "the same frame as the row above: the message zca-js emitted from a refused frame against the error we report for it",
    },
];
