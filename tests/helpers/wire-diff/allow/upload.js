/**
 * Intended differences between zca-js and our engine for the upload area: one row per difference, each also recorded
 * in golden/upload.js. Owned by package UPL; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Method rows must be present in every run they are matched against, and the upload cases differ in which requests
 * they make, so each case of tests/unit/wire-upload.test.js has its own name (`sendMessage/image-dm`, ...) and its
 * own set of rows, built here from the kinds of request it makes. Offsets are in Zalo Web build 26.11.10's main
 * bundle (spec-send.md 2.3).
 */
import { isDeepStrictEqual } from "node:util";

/** The kind of upload-area request a normalized request is, by its path. */
export function requestKind(req) {
    const p = req?.path ?? "";
    if (/\/(photo_original|asyncfile)\/upload$/.test(p)) return "chunk";
    if (p.endsWith("/photo_original/send")) return "photo";
    if (p.endsWith("/asyncfile/msg")) return "file";
    if (p.endsWith("/upthumb")) return "upthumb";
    if (/\/(message|group)\/gif$/.test(p)) return "gif";
    return null;
}

/** The Web's key order of each request's params (the bundle's object literals; spec-send 2.3). */
export const WEB_PARAM_ORDER = Object.freeze({
    chunk: ["totalChunk", "fileName", "clientId", "totalSize", "imei", "chunkId", "toid", "grid"],
    photo: [
        "photoId",
        "clientId",
        "desc",
        "width",
        "height",
        "rawUrl",
        "thumbUrl",
        "hdUrl",
        "normalUrl",
        "oriUrl",
        "groupLayoutId",
        "idInGroup",
        "isGroupLayout",
        "totalItemInGroup",
        "toid",
        "grid",
        "language",
        "extMsgProp",
        "zsource",
        "ttl",
        "imei",
    ],
    file: [
        "fileId",
        "checksum",
        "checksumSha",
        "extension",
        "totalSize",
        "fileName",
        "clientId",
        "fType",
        "fileCount",
        "fdata",
        "toid",
        "grid",
        "fileUrl",
        "zsource",
        "ttl",
        "imei",
    ],
});

/**
 * True when `keys` are all known for the request kind and come in the Web's order.
 *
 * @param {string|null} kind
 * @param {string[]} keys
 * @returns {boolean}
 */
export function inWebOrder(kind, keys) {
    const order = WEB_PARAM_ORDER[kind];
    if (!order || !Array.isArray(keys)) return false;
    return (
        keys.every((k) => order.includes(k)) &&
        isDeepStrictEqual(
            keys,
            order.filter((k) => keys.includes(k)),
        )
    );
}

/**
 * The Web's query for the names zca-js sent on an upload-area request: `zpw_ver`, `zpw_type`, `params`, then the
 * endpoint's own names (`type`), without `nretry`.
 *
 * @param {string[]} order
 * @returns {string[]}
 */
export function webUploadQuery(order) {
    const head = ["zpw_ver", "zpw_type", ...(order.includes("params") ? ["params"] : [])];
    return [...head, ...order.filter((k) => !head.includes(k) && k !== "nretry")];
}

const at =
    (...kinds) =>
    ({ zca, own }) =>
        kinds.includes(requestKind(own ?? zca));
const isText = (v) => typeof v === "string" && v.length > 0;
const absent = undefined;

/** Rows every case with requests has: the transport and the key order. */
const base = (method) => [
    {
        method,
        field: "queryOrder",
        zca: () => true,
        own: (v, { zca }) => isDeepStrictEqual(v, webUploadQuery(zca.queryOrder)),
        why: "Web getUrl (@8323590): base, then the common params, then &params=, then &type=; no nretry (spec-send 0)",
    },
    {
        method,
        field: "headers.cookie",
        zca: "",
        own: absent,
        why: "the kernel (K1) sends no Cookie header when the jar has nothing for the file host; zca-js sends an empty one",
    },
    {
        method,
        field: "paramsOrder",
        zca: () => true,
        own: (v, { own }) => inWebOrder(requestKind(own), v),
        why: "the Web's key order of each object literal: chunk builder @8322790, sendMsgPhotoAsync @11674337, sendMsgFileAsync @11672663",
    },
];

/** Upload chunks: the Web's non-E2EE builder has no isE2EE/jxl. */
const chunk = (method) => [
    {
        method,
        field: "params.isE2EE",
        when: at("chunk"),
        zca: 0,
        own: absent,
        why: "Web non-E2EE chunk builder (@8322790): isE2EE appears only in the E2EE builder, as 1",
    },
    {
        method,
        field: "params.jxl",
        when: at("chunk"),
        zca: 0,
        own: absent,
        why: "Web chunk builder (@8322790): jxl is sent only as 1, for a jxl photo",
    },
];

/** Photo sends. */
const photo = (method) => [
    {
        method,
        field: "params.hdSize",
        when: at("photo"),
        zca: isText,
        own: absent,
        why: "Web sendMsgPhotoAsync (@11674337): hdSize only from a photo_success control, never from the upload",
    },
    {
        method,
        field: "params.jcp",
        when: at("photo"),
        zca: '{"convertible":"jxl"}',
        own: absent,
        why: "Web sendMsgPhotoAsync (@11674337): jcp only with a sendSource or a jxl photo",
    },
    {
        method,
        field: "params.language",
        when: at("photo"),
        zca: absent,
        own: "vi",
        why: "Web sendMsgPhotoAsync (@11674337) sends the UI language on every photo send",
    },
    {
        method,
        field: "params.imei",
        when: at("photo"),
        zca: absent,
        own: isText,
        why: "Web sendMsgPhotoAsync (@11674337) sends imei on 1-1 and group photo sends",
    },
];

/** File sends; `dm` when the case sends to a user (imei is then on the Web's file send too). */
const file = (method, { dm }) => [
    {
        method,
        field: "params.extention",
        when: at("file"),
        zca: isText,
        own: absent,
        why: "Web sendMsgFileAsync (@11672663) spells it extension; zca-js sent extention",
    },
    {
        method,
        field: "params.extension",
        when: at("file"),
        zca: absent,
        own: (v, { own }) => v === own.params.fileName.split(".").pop().toLowerCase(),
        why: "Web sendMsgFileAsync (@11672663) spells it extension",
    },
    ...(dm
        ? [
              {
                  method,
                  field: "params.imei",
                  when: at("file"),
                  zca: absent,
                  own: isText,
                  why: "Web sendMsgFileAsync (@11672663) sends imei on a 1-1 file send",
              },
          ]
        : []),
];

/** One monotonic clientId source per session, where zca-js restarted from Date.now(). */
const laterId = (v, { zca }) => Number(v) > Number(zca.params.clientId);

/** Every case and its rows. */
export default [
    ...base("sendMessage/image-dm"),
    ...chunk("sendMessage/image-dm"),
    ...photo("sendMessage/image-dm"),

    ...base("sendMessage/image-group"),
    ...chunk("sendMessage/image-group"),
    ...photo("sendMessage/image-group"),

    ...base("sendMessage/multi-image"),
    ...chunk("sendMessage/multi-image"),
    ...photo("sendMessage/multi-image"),

    ...base("sendMessage/file-dm"),
    ...chunk("sendMessage/file-dm"),
    ...file("sendMessage/file-dm", { dm: true }),

    ...base("sendMessage/file-group"),
    ...chunk("sendMessage/file-group"),
    ...file("sendMessage/file-group", { dm: false }),

    ...base("sendMessage/video-as-file"),
    ...chunk("sendMessage/video-as-file"),
    ...file("sendMessage/video-as-file", { dm: true }),

    ...base("sendMessage/file-multi-chunk"),
    ...chunk("sendMessage/file-multi-chunk"),
    ...file("sendMessage/file-multi-chunk", { dm: true }),

    ...base("sendMessage/gif").filter((r) => r.field !== "paramsOrder"),

    ...base("uploadAttachment/image-and-file"),
    ...chunk("uploadAttachment/image-and-file"),

    // A photo, a file and a GIF in one send: the clientIds and the photo layout.
    ...base("sendMessage/mixed"),
    ...chunk("sendMessage/mixed"),
    ...photo("sendMessage/mixed"),
    ...file("sendMessage/mixed", { dm: true }),
    ...["groupLayoutId", "isGroupLayout", "idInGroup", "totalItemInGroup", "extMsgProp"].map((key) => ({
        method: "sendMessage/mixed",
        field: `params.${key}`,
        when: at("photo"),
        zca: (v) => v !== undefined,
        own: absent,
        why: "a group layout gathers the photos of a send; zca-js counted every non-GIF file into it, so one photo beside a file was sent as a layout of two (unverified live: batch C)",
    })),
    {
        method: "sendMessage/mixed",
        field: "params.clientId",
        when: at("upthumb", "gif"),
        zca: () => true,
        own: laterId,
        why: "one monotonic clientId source per session (spec-send 0; Web Ki.a.next()): zca-js gave the GIF Date.now() again, the first photo's id",
    },
    {
        method: "sendMessage/mixed",
        field: "result.attachment.2.cliMsgId",
        zca: "1700000000000",
        own: (v) => Number(v) > 1700000000001,
        why: "the GIF's cliMsgId is its own clientId; zca-js's collided with the photo's, so `msg undo` could not tell them apart",
    },

    // The caption goes first through sendMessage and takes the session's next clientId; the file takes the one after.
    ...base("sendMessage/caption-separate"),
    ...chunk("sendMessage/caption-separate"),
    ...file("sendMessage/caption-separate", { dm: false }),
    {
        method: "sendMessage/caption-separate",
        field: "params.clientId",
        when: at("chunk", "file"),
        zca: () => true,
        own: (v, { zca }) => Number(v) === Number(zca.params.clientId) + 1,
        why: "one monotonic clientId source per session (spec-send 0): zca-js restarted from Date.now() after the caption and gave the file the caption's clientId",
    },
    {
        method: "sendMessage/caption-separate",
        field: "result.attachment.0.cliMsgId",
        zca: "1700000000000",
        own: "1700000000001",
        why: "the file's cliMsgId follows the caption's; zca-js's equalled it",
    },

    // An inner error_code 1 on a chunk is Zalo's "already uploaded".
    ...base("sendMessage/duplicate"),
    ...chunk("sendMessage/duplicate"),
    {
        method: "sendMessage/duplicate",
        field: "requests.length",
        zca: 1,
        own: 2,
        why: "Web handleSendChunkResp (@8309993) takes inner error_code 1 with a photoId and URLs as a done (duplicate) upload and sends it; zca-js threw",
    },
    {
        method: "sendMessage/duplicate",
        field: "result",
        zca: absent,
        own: (v) => Array.isArray(v?.attachment) && v.attachment.length === 1 && isText(v.attachment[0].msgId),
        why: "Web handleSendChunkResp (@8309993): the duplicate photo is sent",
    },
    {
        method: "sendMessage/duplicate",
        field: "error",
        zca: (v) => v?.code === 1,
        own: null,
        why: "Web sendChunk (@8317751) accepts inner error_code 0 and 1 on a chunk",
    },

    // A refused file refuses the whole send before anything goes out.
    {
        method: "sendMessage/limit-before-caption",
        field: "requests.length",
        zca: 1,
        own: 0,
        why: "every limit is checked before the first request; zca-js sent the caption, then refused the file",
    },
];
