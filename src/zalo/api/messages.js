/**
 * Message sends that carry no uploaded file, and their read-only neighbors (agent/docs/zca-replace/spec-send.md
 * 1, 3-6; spec-sweep.md 1.2 "Messages").
 *
 * - `sendText(message, threadId, type)`: the text half of the composed `sendMessage` (src/zalo/api.js routes a
 *   message without attachments here). Plain, styled, mention (groups only), quote (1-1 and group), urgency.
 * - `sendCard`, `sendSticker` (+ `searchSticker`, `getStickers`, `getStickersDetail`, `getStickerCategoryDetail`),
 *   `sendLink` (+ `parseLink`), `sendVoice`, `sendVideo` (both by hosted URL, over the forward endpoint),
 *   `sendBankCard`, `sendTypingEvent`, `sendReport`, `scanURL`.
 *
 * Wire facts this follows, from Zalo Web 26.11.10's API module where it and the previous engine differ (each is
 * pinned by a golden record in tests/helpers/wire-diff/golden/messages.js):
 *
 * - Every send's params are in Web's key order (Web builds the object, then appends styles `textProperties`,
 *   `metaData {urgency}` and `ttl`, then the thread key). The previous engine used its own order.
 * - Group text (`/api/group/sendmsg`) carries `imei`; group mention and group quote carry `language`.
 * - A sticker carries `ttl`; `searchSticker` asks for 10 by default; `getStickerCategoryDetail` sends `cid` as a
 *   string.
 * - A link goes out with `type: 0`, `title || href`, `language`, and a group link with `mentionInfo: "[]"`;
 *   `parseLink` sends the link URI-encoded unless it already is.
 * - A voice or video sent to a group carries no `imei` (the forward endpoint's group form has none).
 *
 * Behavior that is ours, not a wire fact: every send returns the client id it put on the wire as `cliMsgId` (a
 * string), even when Zalo answers with no object (a bank card answers ""); the client ids come from the session's
 * monotonic source (`s.nextClientId()`), so two sends in one millisecond never share one; a video without its
 * width and height is refused before any request (Zalo refuses it with code 114); the HEAD that reads a hosted
 * voice or video's size has a timeout and sends no cookie.
 *
 * Nothing here writes to stdout or logs an id.
 */
import { ZaloApiError } from "../errors.js";
import { THREAD_TYPE } from "../enums.js";

/** How long the HEAD to a user-given voice or video URL may take. */
export const HEAD_TIMEOUT_MS = 8000;

/** `ttl` when the caller gives none: no self-destruct. */
const NO_TTL = 0;

/** `zsource` values (Web's send-source tracker; -1 is "not tracked"). */
const ZSOURCE = Object.freeze({ UNTRACKED: -1, STICKER_SUGGESTION: 101, FORWARD_VIDEO: 704 });

/** `msgType` of the forward endpoint, by what is forwarded. */
const FORWARD_TYPE = Object.freeze({ VOICE: 3, VIDEO: 5, CONTACT: 6 });

/** The typing indicator's destination kind for a person (Web `DEST_TYPING.USER`). */
const DEST_USER = 3;

/** `sendReport`'s "other" reason: the only one that carries free text. */
const REASON_OTHER = 0;

/** A group report's `type` (Web `reportUser`). */
const GROUP_REPORT_TYPE = 14;

/**
 * The client message type of a quoted message, by its `msgType` (the `qmsgType` param). Unknown kinds count as
 * text, which is the only kind the engine quotes.
 */
export const QUOTE_TYPE = Object.freeze({
    webchat: 1,
    "chat.voice": 31,
    "chat.photo": 32,
    "chat.sticker": 36,
    "chat.doodle": 37,
    "chat.recommended": 38,
    "chat.link": 38,
    "chat.location.new": 43,
    "chat.video.msg": 44,
    "share.file": 46,
    "chat.gif": 49,
});

/**
 * A POST whose sealed params the caller builds (`args.params`).
 *
 * @param {string} host - service-map key
 * @param {string} path
 * @param {number} cmd - Web command id
 * @param {object} [extra] - more definition fields (`timeoutMs`, `transform`)
 * @returns {object} an endpoint definition (src/zalo/kernel/endpoint.js)
 */
function post(host, path, cmd, extra = {}) {
    return Object.freeze({ host, path, cmd, method: "post", body: (args) => args.params, reply: "session", ...extra });
}

/**
 * A GET whose sealed params the caller builds (`args.params`).
 *
 * @param {string} host
 * @param {string} path
 * @param {number|null} cmd
 * @param {object} [extra]
 * @returns {object}
 */
function get(host, path, cmd, extra = {}) {
    return Object.freeze({ host, path, cmd, method: "get", body: (args) => args.params, reply: "session", ...extra });
}

/** The endpoints, by name. */
export const ENDPOINTS = Object.freeze({
    sms: post("chat", "/api/message/sms", 11151),
    groupText: post("group", "/api/group/sendmsg", 11163),
    mention: post("group", "/api/group/mention", 11198),
    quote: post("chat", "/api/message/quote", 11771),
    groupQuote: post("group", "/api/group/quote", 11197),
    forward: post("file", "/api/message/forward", 11199),
    groupForward: post("file", "/api/group/forward", 11818),
    qr: post("friend", "/api/friend/mget-qr", 12128),
    sticker: post("chat", "/api/message/sticker", 11154),
    groupSticker: post("group", "/api/group/sticker", 11165),
    searchSticker: get("sticker", "/api/message/sticker/search", 11747),
    stickerSuggest: get("sticker", "/api/message/sticker/suggest/stickers", 11741),
    stickerDetail: get("sticker", "/api/message/sticker/sticker_detail", 11279),
    stickerCategory: get("sticker", "/api/message/sticker/category/sticker_detail", 11284),
    parseLink: get("file", "/api/message/parselink", 11285),
    link: post("chat", "/api/message/link", 11286),
    groupLink: post("group", "/api/group/sendlink", 11193),
    typing: post("chat", "/api/message/typing", 11144),
    groupTyping: post("group", "/api/group/typing", 11196),
    reportUser: post("profile", "/api/report/abuse-v2", 15295),
    reportGroup: post("profile", "/api/social/profile/reportabuse", 31582),
    scanUrl: post("file", "/api/message/scanurl", 12400, { timeoutMs: 5000 }),
    bankCard: post("zimsg", "/api/transfer/card", 15220),
});

/**
 * True when a thread type names a group (anything else is a person, as the engine passes 0 or 1).
 *
 * @param {unknown} type
 * @returns {boolean}
 */
const isGroupType = (type) => Number(type) === THREAD_TYPE.GROUP;

/**
 * A send's answer with the client id it was sent with, as a string: Zalo answers `{msgId}` only, and `msg undo`,
 * `msg react` and a quote need the client id too. An answer that is not an object (a bank card's "") becomes one.
 *
 * @param {unknown} data
 * @param {number|string} clientId
 * @returns {object}
 */
function stamp(data, clientId) {
    const base = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    return { ...base, cliMsgId: String(clientId) };
}

/**
 * The UI language name Web sends as `language` ("vi" or "en").
 *
 * @param {{language?: string}} ctx
 * @returns {string}
 */
function languageOf(ctx) {
    return String(ctx?.language || "vi").toLowerCase();
}

/**
 * Valid group mentions, in Zalo's shape; none for a 1-1 chat (Zalo has no mentions there).
 *
 * @param {boolean} group
 * @param {string} text
 * @param {Array<{pos: number, uid: string, len: number}>|undefined} mentions
 * @returns {Array<{pos: number, uid: string, len: number, type: number}>}
 * @throws {ZaloApiError} when the mentions cover more characters than the text has
 */
function mentionsOf(group, text, mentions) {
    if (!group || !Array.isArray(mentions)) return [];
    const out = mentions
        .filter((m) => m && m.pos >= 0 && m.uid && m.len > 0)
        .map((m) => ({ pos: m.pos, uid: m.uid, len: m.len, type: String(m.uid) === "-1" ? 1 : 0 }));
    const covered = out.reduce((n, m) => n + m.len, 0);
    if (covered > text.length) {
        throw new ZaloApiError("Invalid mentions: total mention characters exceed message length");
    }
    return out;
}

/**
 * One text style as Zalo takes it: the engine's `st: "ind_$"` with `indentSize` n becomes `ind_<n>0`, and
 * `indentSize` itself is not sent. Every other key keeps its place.
 *
 * @param {{start: number, len: number, st: string, indentSize?: number}} style
 * @returns {object}
 */
function styleOf(style) {
    const out = {};
    for (const [k, v] of Object.entries(style ?? {})) {
        if (k === "indentSize" || v === undefined) continue;
        out[k] = v;
    }
    if (style?.st === "ind_$") out.st = `ind_${style.indentSize ?? 1}0`;
    return out;
}

/**
 * Append what Web's param builder appends after a send's own keys: `textProperties` for a non-empty style list,
 * `metaData` for urgency 1 (important) or 2 (urgent).
 *
 * @param {object} params - mutated
 * @param {{styles?: object[], urgency?: number}} message
 */
function addTextExtras(params, { styles, urgency }) {
    if (Array.isArray(styles) && styles.length) {
        params.textProperties = JSON.stringify({ styles: styles.map(styleOf), ver: 0 });
    }
    if (urgency === 1 || urgency === 2) params.metaData = { urgency };
}

/**
 * True when a link is already URI-encoded (decoding it changes it).
 *
 * @param {string} link
 * @returns {boolean}
 */
function isEncoded(link) {
    try {
        return link !== decodeURIComponent(link);
    } catch {
        return false;
    }
}

/**
 * The size of a hosted file, from a HEAD to its URL: a request to a host the user named, so it carries no Zalo
 * header and no cookie, goes through the session's fetch (its proxy) and has a timeout.
 *
 * @param {object} ctx
 * @param {string} url
 * @param {string} what - "voice" or "video", for the error
 * @param {number} timeoutMs
 * @returns {Promise<number>} the content length, 0 when the host does not say or answers an error
 * @throws {ZaloApiError} "Unable to get <what> content: ..." when the request fails or times out
 */
async function hostedSize(ctx, url, what, timeoutMs) {
    const fetchFn = ctx.options?.polyfill ?? globalThis.fetch;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try {
        res = await fetchFn(url, signal ? { method: "HEAD", signal } : { method: "HEAD" });
    } catch (e) {
        const reason = signal?.aborted ? `no answer within ${timeoutMs} ms` : (e?.message ?? e);
        throw new ZaloApiError(`Unable to get ${what} content: ${reason}`);
    }
    if (!res?.ok) return 0;
    const size = parseInt(res.headers?.get?.("content-length") || "0", 10);
    return Number.isFinite(size) ? size : 0;
}

/**
 * The message calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function messageMethods(s) {
    /**
     * Send a forward-endpoint message (card, voice, video) with Web's key order: the thread keys, `ttl`,
     * `zsource` when the send is tracked, `msgType`, `clientId`, `msgInfo`.
     */
    async function forward({ threadId, group, ttl, zsource, msgType, clientId, msgInfo }) {
        const params = group ? { grid: threadId, visibility: 0 } : { toId: threadId, imei: s.ctx.imei };
        params.ttl = ttl ?? NO_TTL;
        if (zsource !== undefined) params.zsource = zsource;
        params.msgType = msgType;
        params.clientId = clientId;
        params.msgInfo = JSON.stringify(msgInfo);
        const data = await s.call(group ? ENDPOINTS.groupForward : ENDPOINTS.forward, { params });
        return stamp(data, clientId);
    }

    /**
     * Send text: plain, styled, with mentions (groups only), a quote or an urgency.
     *
     * @param {string|{msg: string, styles?: object[], mentions?: object[], quote?: object, urgency?: number,
     *   ttl?: number}} message - a string is a plain message
     * @param {string} threadId - the person or group
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{message: {msgId: string, cliMsgId: string}, attachment: []}>}
     * @throws {ZaloApiError} "Missing message content" / "Missing threadId" before any request; Zalo's error
     */
    async function sendText(message, threadId, type = THREAD_TYPE.USER) {
        if (!message) throw new ZaloApiError("Missing message content");
        if (!threadId) throw new ZaloApiError("Missing threadId");
        const m = typeof message === "string" ? { msg: message } : message;
        const text = m.msg;
        if (typeof text !== "string" || text.length === 0) throw new ZaloApiError("Missing message content");
        const group = isGroupType(type);
        const mentions = mentionsOf(group, text, m.mentions);
        const quote = m.quote;
        if (quote && typeof quote.content !== "string") {
            throw new ZaloApiError("Only a text message can be quoted");
        }
        const ttl = m.ttl ?? NO_TTL;
        const clientId = s.nextClientId();
        const imei = s.ctx.imei;
        let params;
        let def;

        if (quote) {
            const qmsgType = QUOTE_TYPE[quote.msgType] ?? 1;
            if (group) {
                params = {
                    grid: threadId,
                    message: text,
                    clientId,
                    language: languageOf(s.ctx),
                    qmsgOwner: quote.uidFrom,
                    qmsgId: quote.msgId,
                    qmsgCliId: quote.cliMsgId,
                    qmsgType,
                    qmsg: quote.content,
                    qmsgTs: quote.ts,
                    visibility: 0,
                };
                addTextExtras(params, m);
                if (quote.propertyExt !== undefined) params.qmsgAttach = JSON.stringify(quote.propertyExt);
                if (mentions.length) params.mentionInfo = JSON.stringify(mentions);
                def = ENDPOINTS.groupQuote;
            } else {
                params = {
                    toid: threadId,
                    message: text,
                    clientId,
                    qmsgOwner: quote.uidFrom,
                    qmsgId: quote.msgId,
                    qmsgCliId: quote.cliMsgId,
                    qmsgType,
                    qmsgTs: quote.ts,
                    qmsg: quote.content,
                    imei,
                };
                addTextExtras(params, m);
                def = ENDPOINTS.quote;
            }
            params.qmsgTTL = quote.ttl ?? NO_TTL;
            params.ttl = ttl;
        } else if (group && mentions.length) {
            params = {
                grid: threadId,
                message: text,
                clientId,
                mentionInfo: JSON.stringify(mentions),
                language: languageOf(s.ctx),
                visibility: 0,
            };
            addTextExtras(params, m);
            params.ttl = ttl;
            def = ENDPOINTS.mention;
        } else {
            params = { message: text, clientId, imei };
            addTextExtras(params, m);
            params.ttl = ttl;
            if (group) {
                params.visibility = 0;
                params.grid = threadId;
            } else {
                params.toid = threadId;
            }
            def = group ? ENDPOINTS.groupText : ENDPOINTS.sms;
        }

        const data = await s.call(def, { params });
        return { message: stamp(data, clientId), attachment: [] };
    }

    /**
     * Send a contact card: the contact's QR is looked up first (`mget-qr`), then forwarded as a contact.
     *
     * @param {{userId: string, phoneNumber?: string, ttl?: number}} options
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{msgId: string, cliMsgId: string}>}
     */
    async function sendCard(options, threadId, type = THREAD_TYPE.USER) {
        const userId = options?.userId;
        const qr = await s.call(ENDPOINTS.qr, { params: { fids: [userId] } });
        const msgInfo = { contactUid: userId, qrCodeUrl: qr?.[userId] };
        if (options.phoneNumber) msgInfo.phone = options.phoneNumber;
        return forward({
            threadId,
            group: isGroupType(type),
            ttl: options.ttl,
            msgType: FORWARD_TYPE.CONTACT,
            clientId: String(s.nextClientId()),
            msgInfo,
        });
    }

    /**
     * Send a sticker.
     *
     * @param {{id: number|string, cateId: number|string, type: number}} sticker - `cateId` may be 0
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{msgId: string, cliMsgId: string}>}
     * @throws {ZaloApiError} for a missing sticker field or thread, before any request
     */
    async function sendSticker(sticker, threadId, type = THREAD_TYPE.USER) {
        if (!sticker) throw new ZaloApiError("Missing sticker");
        if (!threadId) throw new ZaloApiError("Missing threadId");
        if (!sticker.id) throw new ZaloApiError("Missing sticker id");
        if (sticker.cateId === undefined || sticker.cateId === null) throw new ZaloApiError("Missing sticker cateId");
        if (!sticker.type) throw new ZaloApiError("Missing sticker type");
        const group = isGroupType(type);
        const clientId = s.nextClientId();
        const params = {
            stickerId: sticker.id,
            cateId: sticker.cateId,
            type: sticker.type,
            clientId,
            imei: s.ctx.imei,
            zsource: ZSOURCE.STICKER_SUGGESTION,
            ttl: NO_TTL,
        };
        if (group) params.grid = threadId;
        else params.toid = threadId;
        const data = await s.call(group ? ENDPOINTS.groupSticker : ENDPOINTS.sticker, { params });
        return stamp(data, clientId);
    }

    /**
     * Search stickers by keyword.
     *
     * @param {string} keyword
     * @param {number} [limit] - how many; Web asks for 10
     * @returns {Promise<Array<{sticker_id: number, cate_id: number, type: number}>>}
     */
    const searchSticker = (keyword, limit = 10) =>
        s.call(ENDPOINTS.searchSticker, { params: { keyword, limit, srcType: 0, imei: s.ctx.imei } });

    /**
     * The ids of the stickers Zalo suggests for a keyword.
     *
     * @param {string} keyword
     * @returns {Promise<Array<number>>}
     * @throws {ZaloApiError} "Missing keyword" before any request
     */
    async function getStickers(keyword) {
        if (!keyword) throw new ZaloApiError("Missing keyword");
        const data = await s.call(ENDPOINTS.stickerSuggest, {
            params: { keyword, gif: 1, guggy: 0, imei: s.ctx.imei },
        });
        return (data?.sugg_sticker ?? []).map((x) => x.sticker_id);
    }

    /**
     * The details of stickers, one request per id; an id Zalo refuses is left out.
     *
     * @param {number|number[]} stickerIds
     * @returns {Promise<object[]>}
     * @throws {ZaloApiError} "Missing sticker id" for no id, before any request
     */
    async function getStickersDetail(stickerIds) {
        if (stickerIds === undefined || stickerIds === null || stickerIds === "") {
            throw new ZaloApiError("Missing sticker id");
        }
        const ids = Array.isArray(stickerIds) ? stickerIds : [stickerIds];
        if (ids.length === 0) throw new ZaloApiError("Missing sticker id");
        const settled = await Promise.allSettled(
            ids.map((sid) => s.call(ENDPOINTS.stickerDetail, { params: { sid } })),
        );
        return settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    }

    /**
     * The stickers of one sticker category.
     *
     * @param {number|string} cateId - the category id (sent as a string, as Web does)
     * @returns {Promise<object>}
     */
    const getStickerCategoryDetail = (cateId) => s.call(ENDPOINTS.stickerCategory, { params: { cid: String(cateId) } });

    /**
     * The preview Zalo builds for a link.
     *
     * @param {string} link - URI-encoded here unless it already is
     * @returns {Promise<{data: object, error_maps?: object}>}
     */
    const parseLink = (link) =>
        s.call(ENDPOINTS.parseLink, {
            params: { link: isEncoded(String(link)) ? link : encodeURI(String(link)), version: 1, imei: s.ctx.imei },
        });

    /**
     * Send a link with its preview (from `parseLink`).
     *
     * @param {{link: string, msg?: string, ttl?: number}} options - `msg` is the caption; the link is appended to
     *   it when it does not contain it
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{msgId: string, cliMsgId: string}>}
     */
    async function sendLink(options, threadId, type = THREAD_TYPE.USER) {
        const link = options?.link;
        const preview = await parseLink(link);
        const d = preview?.data ?? {};
        const caption = options.msg && options.msg.trim() ? options.msg : "";
        const group = isGroupType(type);
        const clientId = s.nextClientId();
        const params = {
            msg: caption ? (caption.includes(link) ? caption : `${caption} ${link}`) : link,
            href: d.href,
            src: d.src,
            title: d.title || d.href,
            desc: d.desc,
            language: languageOf(s.ctx),
            thumb: d.thumb,
            type: 0,
            media: d.media === undefined ? undefined : JSON.stringify(d.media),
            ttl: options.ttl ?? NO_TTL,
        };
        if (group) {
            Object.assign(params, { grid: threadId, clientId, mentionInfo: "[]", imei: s.ctx.imei });
        } else {
            Object.assign(params, { toId: threadId, clientId, mentionInfo: "" });
        }
        const data = await s.call(group ? ENDPOINTS.groupLink : ENDPOINTS.link, { params });
        return stamp(data, clientId);
    }

    /**
     * Send a voice message from a hosted file.
     *
     * @param {{voiceUrl: string, ttl?: number, m4aUrl?: string, fileSize?: number, timeoutMs?: number}} options -
     *   `m4aUrl` defaults to `voiceUrl`; a known `fileSize` skips the HEAD; `timeoutMs` bounds the HEAD
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{msgId: string, cliMsgId: string}>}
     * @throws {ZaloApiError} for a thread type other than 0/1 or no URL, before any request; "Unable to get voice
     *   content: ..." when the HEAD fails
     */
    async function sendVoice(options, threadId, type = THREAD_TYPE.USER) {
        const t = Number(type);
        if (t !== THREAD_TYPE.USER && t !== THREAD_TYPE.GROUP) throw new ZaloApiError("Thread type is invalid");
        if (!options?.voiceUrl) throw new ZaloApiError("Missing voiceUrl");
        const clientId = String(s.nextClientId());
        const fileSize = Number.isFinite(options.fileSize)
            ? options.fileSize
            : await hostedSize(s.ctx, options.voiceUrl, "voice", options.timeoutMs ?? HEAD_TIMEOUT_MS);
        return forward({
            threadId,
            group: t === THREAD_TYPE.GROUP,
            ttl: options.ttl,
            zsource: ZSOURCE.UNTRACKED,
            msgType: FORWARD_TYPE.VOICE,
            clientId,
            msgInfo: { voiceUrl: options.voiceUrl, m4aUrl: options.m4aUrl ?? options.voiceUrl, fileSize },
        });
    }

    /**
     * Send a video from a hosted file.
     *
     * @param {{videoUrl: string, thumbnailUrl: string, msg?: string, duration?: number, width: number,
     *   height: number, ttl?: number, fileSize?: number, timeoutMs?: number}} options - `duration` in ms; a known
     *   `fileSize` skips the HEAD; `timeoutMs` bounds the HEAD
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{msgId: string, cliMsgId: string}>}
     * @throws {ZaloApiError} for missing geometry, a thread type other than 0/1 or no URL, before any request
     *   (Zalo refuses a video without its width and height, code 114); "Unable to get video content: ..." when the
     *   HEAD fails
     */
    async function sendVideo(options, threadId, type = THREAD_TYPE.USER) {
        const t = Number(type);
        if (t !== THREAD_TYPE.USER && t !== THREAD_TYPE.GROUP) throw new ZaloApiError("Thread type is invalid");
        if (!options?.videoUrl) throw new ZaloApiError("Missing videoUrl");
        const width = Number(options.width);
        const height = Number(options.height);
        if (!(width > 0) || !(height > 0)) {
            throw new ZaloApiError(
                "A video needs its width and height (Zalo refuses one without them, code 114); none was given",
            );
        }
        const clientId = String(s.nextClientId());
        const fileSize = Number.isFinite(options.fileSize)
            ? options.fileSize
            : await hostedSize(s.ctx, options.videoUrl, "video", options.timeoutMs ?? HEAD_TIMEOUT_MS);
        return forward({
            threadId,
            group: t === THREAD_TYPE.GROUP,
            ttl: options.ttl,
            zsource: ZSOURCE.FORWARD_VIDEO,
            msgType: FORWARD_TYPE.VIDEO,
            clientId,
            msgInfo: {
                videoUrl: options.videoUrl,
                thumbUrl: options.thumbnailUrl,
                duration: options.duration ?? 0,
                width,
                height,
                fileSize,
                properties: {
                    color: -1,
                    size: -1,
                    type: 1003,
                    subType: 0,
                    ext: { sSrcType: -1, sSrcStr: "", msg_warning_type: 0 },
                },
                title: options.msg ?? "",
            },
        });
    }

    /**
     * Send a bank card (a bank account to pay into). Zalo answers it with no message ids, so the result carries
     * only the `cliMsgId` that was sent.
     *
     * @param {{binBank: string|number, numAccBank: string, nameAccBank?: string}} payload - the holder name is
     *   upper-cased, "---" when absent
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{cliMsgId: string}>}
     */
    async function sendBankCard(payload, threadId, type = THREAD_TYPE.USER) {
        const cliMsgId = String(s.nextClientId());
        const params = {
            binBank: payload.binBank,
            numAccBank: payload.numAccBank,
            nameAccBank: payload.nameAccBank ? String(payload.nameAccBank).toUpperCase() : "---",
            cliMsgId,
            tsMsg: s.now(),
            destUid: threadId,
            destType: isGroupType(type) ? 1 : 0,
        };
        const data = await s.call(ENDPOINTS.bankCard, { params });
        return stamp(data, cliMsgId);
    }

    /**
     * Show the "typing..." indicator.
     *
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @param {number} [destType] - a person's destination kind (3 a user, 5 a page)
     * @returns {Promise<unknown>}
     * @throws {ZaloApiError} "Missing threadId" before any request
     */
    async function sendTypingEvent(threadId, type = THREAD_TYPE.USER, destType = DEST_USER) {
        if (!threadId) throw new ZaloApiError("Missing threadId");
        if (isGroupType(type)) {
            return s.call(ENDPOINTS.groupTyping, { params: { grid: threadId, imei: s.ctx.imei } });
        }
        return s.call(ENDPOINTS.typing, { params: { toid: threadId, destType, imei: s.ctx.imei } });
    }

    /**
     * Report a person (`/api/report/abuse-v2`) or a group (`/api/social/profile/reportabuse`) to Zalo.
     *
     * @param {{reason: number, content?: string}} options - reason 0 other (with `content`), 1 sensitive, 2 annoy,
     *   3 fraud
     * @param {string} threadId
     * @param {number} [type] - 0 a person, 1 a group
     * @returns {Promise<{reportId?: string}>}
     */
    function sendReport(options, threadId, type = THREAD_TYPE.USER) {
        const other = options.reason === REASON_OTHER;
        if (isGroupType(type)) {
            return s.call(ENDPOINTS.reportGroup, {
                params: {
                    uidTo: threadId,
                    type: GROUP_REPORT_TYPE,
                    reason: options.reason,
                    content: other ? options.content : "",
                    imei: s.ctx.imei,
                },
            });
        }
        const params = { idTo: threadId, objId: "person.profile", reason: String(options.reason) };
        if (other && options.content !== undefined) params.content = options.content;
        return s.call(ENDPOINTS.reportUser, { params });
    }

    /**
     * Ask Zalo whether a URL is safe to open.
     *
     * @param {string} url
     * @returns {Promise<{isSafe?: boolean}>}
     */
    const scanURL = (url) => s.call(ENDPOINTS.scanUrl, { params: { url } });

    return {
        sendText,
        sendCard,
        sendSticker,
        searchSticker,
        getStickers,
        getStickersDetail,
        getStickerCategoryDetail,
        parseLink,
        sendLink,
        sendVoice,
        sendVideo,
        sendBankCard,
        sendTypingEvent,
        sendReport,
        scanURL,
    };
}
