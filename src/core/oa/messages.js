/**
 * OA messages: consultation (CS) sends, anonymous-user sends, reactions, uploads, conversation reads and message
 * quotas, per Zalo's OA docs ("Tin nhắn": "Tin Tư vấn", "Các loại tin khác", "Quản lý tin nhắn"; "Kiểm tra hạn mức
 * tin nhắn OA").
 *
 * Only consultation messages (`v3.0/oa/message/cs`) are sent to followers here. The UID transaction and personal
 * promotion services stopped on 01/03/2026 (per Zalo's OA docs) in favor of ZBS Template Message: see `zbs`.
 *
 * Every documented limit is checked before anything is sent: text and captions ≤ 2000 characters, one element per
 * template, `request_user_info` title ≤ 100 and subtitle ≤ 500, the documented reaction icons, ≤ 10 messages per
 * conversation page, and the upload types and sizes (in transport.js).
 */

import { OPENAPI_V2, OPENAPI_V3, UPLOAD_LIMITS, OAError, oaRequest, uploadForm } from "./transport.js";

/** `POST v3.0/oa/message/cs`: every consultation message. */
export const CS_MESSAGE_URL = `${OPENAPI_V3}/oa/message/cs`;
/** `POST v2.0/oa/message`: anonymous-user messages and reactions (still the documented path for those). */
export const OA_MESSAGE_V2_URL = `${OPENAPI_V2}/oa/message`;
/** `POST v3.0/oa/quota/message`: per-user quota (`user_id`) or the OA's quota (`quota_owner`). */
export const OA_QUOTA_MESSAGE_URL = `${OPENAPI_V3}/oa/quota/message`;

/** Text and caption limit ("Giới hạn tối đa là 2.000 ký tự"). */
export const CS_TEXT_MAX = 2000;
/** Messages per `listrecentchat` / `conversation` request ("mỗi request được lấy tối đa 10 tin nhắn"). */
export const OA_CONV_PAGE_MAX = 10;
/** `request_user_info` element limits. */
export const CS_REQUEST_INFO_LIMITS = Object.freeze({ title: 100, subtitle: 500 });
/** The reaction icons the docs list; `/-remove` takes the OA's reaction back. */
export const CS_REACT_ICONS = Object.freeze([":>", "--b", ":-((", "/-strong", "/-heart", ":-h", ":o", "/-remove"]);
/**
 * Names for the icons whose meaning the codes spell out, so a shell never sees a `/`-prefixed argument.
 * Any documented code is accepted as is too.
 */
export const CS_REACT_ALIASES = Object.freeze({ like: "/-strong", heart: "/-heart", remove: "/-remove" });
/** `quota_owner` values ("OA / APP"). */
export const OA_QUOTA_OWNERS = Object.freeze(["OA", "APP"]);
/** `product_type` values. */
export const OA_QUOTA_PRODUCT_TYPES = Object.freeze(["cs", "transaction"]);
/** `quota_type` values. */
export const OA_QUOTA_TYPES = Object.freeze(["sub_quota", "purchase_quota", "reward_quota"]);

function invalid(message) {
    return new OAError(message, { code: "invalid_argument" });
}

/** Characters as a reader counts them (code points, so an emoji is one). */
function charCount(text) {
    return [...String(text)].length;
}

function requireText(text, what = "Text") {
    if (typeof text !== "string" || text.length === 0) throw invalid(`${what} is empty`);
    const n = charCount(text);
    if (n > CS_TEXT_MAX) throw invalid(`${what} is ${n} characters; Zalo's limit is ${CS_TEXT_MAX}`);
    return text;
}

function requireId(value, what) {
    const s = value === undefined || value === null ? "" : String(value).trim();
    if (!s) throw invalid(`${what} is required`);
    return s;
}

function requireDims(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
        throw invalid("A GIF needs its width and height in pixels (positive integers)");
    }
    return { width: w, height: h };
}

/** Exactly one of `url` / `attachment_id` ("chỉ sử dụng 1 trong 2 biến"). */
function mediaSource(element, { url, attachmentId }) {
    if (url && attachmentId) throw invalid("Use either a URL or an attachment id, not both");
    if (url) element.url = String(url);
    else if (attachmentId) element.attachment_id = String(attachmentId);
    else throw invalid("An image needs a URL or an attachment id");
    return element;
}

function mediaTemplate(element) {
    return { type: "template", payload: { template_type: "media", elements: [element] } };
}

function postCs(userId, message, oaId) {
    return oaRequest({
        method: "POST",
        url: CS_MESSAGE_URL,
        oaId,
        body: { recipient: { user_id: requireId(userId, "The user id") }, message },
    });
}

// ─── Consultation (CS) messages ──────────────────────────────────────

/**
 * Send a CS text message ("Gửi tin Tư vấn dạng văn bản"), or a quoting reply when `quoteMessageId` is given
 * ("Gửi tin tư vấn trích dẫn": `message.quote_message_id`).
 *
 * @param {string} userId
 * @param {string} text - ≤ 2000 characters
 * @param {string} [oaId]
 * @param {{ quoteMessageId?: string }} [opts]
 * @returns {Promise<object>} Zalo's reply (`data.message_id`, `data.user_id`, `data.sent_time`, maybe `data.quota`)
 */
export async function sendText(userId, text, oaId = "default", { quoteMessageId } = {}) {
    const message = { text: requireText(text) };
    if (quoteMessageId !== undefined) message.quote_message_id = requireId(quoteMessageId, "The quoted message id");
    return postCs(userId, message, oaId);
}

/**
 * Send a CS image ("Gửi tin Tư vấn đính kèm ảnh"): a `media` template with one `image` element by `url` or
 * `attachment_id` (from `uploadImage`), and an optional caption in `message.text`.
 *
 * @param {string} userId
 * @param {{ url?: string, attachmentId?: string, caption?: string, imageUrl?: string, imageId?: string }} image
 *   (`imageUrl` / `imageId` are the older names of `url` / `attachmentId`)
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendImage(userId, { url, attachmentId, caption, imageUrl, imageId } = {}, oaId = "default") {
    const element = mediaSource(
        { media_type: "image" },
        { url: url ?? imageUrl, attachmentId: attachmentId ?? imageId },
    );
    const message = {};
    if (caption !== undefined) message.text = requireText(caption, "The caption");
    message.attachment = mediaTemplate(element);
    return postCs(userId, message, oaId);
}

/**
 * Send a CS GIF ("Gửi tin Tư vấn đính kèm ảnh", `media_type: gif`): `width` and `height` are required for a GIF.
 *
 * @param {string} userId
 * @param {{ url?: string, attachmentId?: string, width: number, height: number, caption?: string }} gif
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendCsGif(userId, { url, attachmentId, width, height, caption } = {}, oaId = "default") {
    const dims = requireDims(width, height);
    const element = mediaSource({ media_type: "gif" }, { url, attachmentId });
    element.width = dims.width;
    element.height = dims.height;
    const message = {};
    if (caption !== undefined) message.text = requireText(caption, "The caption");
    message.attachment = mediaTemplate(element);
    return postCs(userId, message, oaId);
}

/**
 * Send a CS file ("Gửi tin Tư vấn đính kèm file"): `attachment: { type: "file", payload: { token } }`, the token
 * coming from `uploadFile`.
 *
 * @param {string} userId
 * @param {string} fileToken
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendFile(userId, fileToken, oaId = "default") {
    const token = requireId(fileToken, "The file token");
    return postCs(userId, { attachment: { type: "file", payload: { token } } }, oaId);
}

/**
 * Send a CS sticker ("Gửi tin tư vấn kèm Sticker"): a `media` template with one `sticker` element whose
 * `attachment_id` is the sticker id (from stickers.zaloapp.com).
 *
 * @param {string} userId
 * @param {string} stickerId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendCsSticker(userId, stickerId, oaId = "default") {
    const element = { media_type: "sticker", attachment_id: requireId(stickerId, "The sticker id") };
    return postCs(userId, { attachment: mediaTemplate(element) }, oaId);
}

/**
 * Ask the user for their information ("Gửi tin Tư vấn theo mẫu yêu cầu thông tin người dùng"): a
 * `request_user_info` template with one element `{ title ≤ 100, subtitle ≤ 500, image_url }`.
 *
 * @param {string} userId
 * @param {{ title: string, subtitle: string, imageUrl: string }} element
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendCsRequestInfo(userId, { title, subtitle, imageUrl } = {}, oaId = "default") {
    const t = requireId(title, "The title");
    const s = requireId(subtitle, "The subtitle");
    const img = requireId(imageUrl, "The image URL");
    if (charCount(t) > CS_REQUEST_INFO_LIMITS.title) {
        throw invalid(`The title is ${charCount(t)} characters; Zalo's limit is ${CS_REQUEST_INFO_LIMITS.title}`);
    }
    if (charCount(s) > CS_REQUEST_INFO_LIMITS.subtitle) {
        throw invalid(`The subtitle is ${charCount(s)} characters; Zalo's limit is ${CS_REQUEST_INFO_LIMITS.subtitle}`);
    }
    const attachment = {
        type: "template",
        payload: { template_type: "request_user_info", elements: [{ title: t, subtitle: s, image_url: img }] },
    };
    return postCs(userId, { attachment }, oaId);
}

// ─── Reactions and anonymous users ───────────────────────────────────

/**
 * The documented icon code for `reaction` (a code from {@link CS_REACT_ICONS} or a name from {@link CS_REACT_ALIASES}).
 * @param {string} reaction
 * @returns {string}
 */
export function resolveCsReactIcon(reaction) {
    const r = String(reaction ?? "").trim();
    const icon = CS_REACT_ALIASES[r.toLowerCase()] ?? r;
    if (!CS_REACT_ICONS.includes(icon)) {
        throw invalid(
            `Unknown reaction "${r}". Zalo accepts ${CS_REACT_ICONS.join(" ")} (or ${Object.keys(CS_REACT_ALIASES).join(", ")})`,
        );
    }
    return icon;
}

/**
 * React to a message as the OA ("Thả biểu tượng cảm xúc vào tin nhắn"): `POST v2.0/oa/message` with
 * `sender_action: { react_icon, react_message_id }`. `/-remove` (alias `remove`) takes the reaction back. Zalo
 * allows at most 50 reactions per message; reactions do not count against the monthly quota.
 *
 * @param {string} userId
 * @param {string} messageId
 * @param {string} reaction
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function reactCsMessage(userId, messageId, reaction, oaId = "default") {
    const react_icon = resolveCsReactIcon(reaction);
    return oaRequest({
        method: "POST",
        url: OA_MESSAGE_V2_URL,
        oaId,
        body: {
            recipient: { user_id: requireId(userId, "The user id") },
            sender_action: { react_icon, react_message_id: requireId(messageId, "The message id") },
        },
    });
}

/**
 * Message an anonymous user ("Gửi tin nhắn … đến người dùng ẩn danh"): `POST v2.0/oa/message` with
 * `recipient: { anonymous_id, conversation_id }` and exactly one of: `text` (≤ 2000), an image (`url` or
 * `attachment_id`), a file `token` (from `uploadFile`), or a sticker id.
 *
 * @param {{ anonymousId: string, conversationId: string }} recipient
 * @param {{ text?: string, imageUrl?: string, attachmentId?: string, fileToken?: string, stickerId?: string }} content
 * @param {string} [oaId]
 * @returns {Promise<object>} Zalo's reply (`data.message_id`, `data.anonymous_id`, `data.conversation_id`)
 */
export async function sendAnonymousMessage({ anonymousId, conversationId } = {}, content = {}, oaId = "default") {
    const recipient = {
        anonymous_id: requireId(anonymousId, "The anonymous user id"),
        conversation_id: requireId(conversationId, "The conversation id"),
    };
    const { text, imageUrl, attachmentId, fileToken, stickerId } = content;
    const image = imageUrl !== undefined || attachmentId !== undefined;
    const kinds = [text !== undefined, image, fileToken !== undefined, stickerId !== undefined].filter(Boolean);
    if (kinds.length !== 1) throw invalid("Send exactly one of: text, image, file, sticker");
    let message;
    if (text !== undefined) message = { text: requireText(text) };
    else if (image) {
        message = { attachment: mediaTemplate(mediaSource({ media_type: "image" }, { url: imageUrl, attachmentId })) };
    } else if (fileToken !== undefined) {
        message = { attachment: { type: "file", payload: { token: requireId(fileToken, "The file token") } } };
    } else {
        const sticker = { media_type: "sticker", attachment_id: requireId(stickerId, "The sticker id") };
        message = { attachment: mediaTemplate(sticker) };
    }
    return oaRequest({ method: "POST", url: OA_MESSAGE_V2_URL, oaId, body: { recipient, message } });
}

// ─── Quotas ──────────────────────────────────────────────────────────

/**
 * One user's quota and last interaction ("Kiểm tra hạn mức gửi tin tới User cụ thể"): `POST v3.0/oa/quota/message`
 * with `{ user_id }`. Replies `data.last_interaction` (unix ms), `data.promotion` (daily/monthly), and `cs_reply`
 * until Zalo stops returning it.
 *
 * @param {string} userId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getUserMessageQuota(userId, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: OA_QUOTA_MESSAGE_URL,
        oaId,
        body: { user_id: requireId(userId, "The user id") },
    });
}

/**
 * The OA's message quota ("Kiểm tra hạn mức tin nhắn OA"): `POST v3.0/oa/quota/message` with `quota_owner`
 * (`OA`/`APP`) and the optional `product_type` (`cs`/`transaction`) and `quota_type`
 * (`sub_quota`/`purchase_quota`/`reward_quota`). Replies `data[]` of `{ asset_id, product_type, quota_type,
 * valid_through, total, remain }`.
 *
 * @param {{ owner?: string, productType?: string, quotaType?: string }} [filter]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getOAMessageQuota({ owner = "OA", productType, quotaType } = {}, oaId = "default") {
    const quota_owner = String(owner).toUpperCase();
    if (!OA_QUOTA_OWNERS.includes(quota_owner))
        throw invalid(`quota_owner must be one of ${OA_QUOTA_OWNERS.join(", ")}`);
    const body = { quota_owner };
    if (productType !== undefined) {
        if (!OA_QUOTA_PRODUCT_TYPES.includes(productType)) {
            throw invalid(`product_type must be one of ${OA_QUOTA_PRODUCT_TYPES.join(", ")}`);
        }
        body.product_type = productType;
    }
    if (quotaType !== undefined) {
        if (!OA_QUOTA_TYPES.includes(quotaType))
            throw invalid(`quota_type must be one of ${OA_QUOTA_TYPES.join(", ")}`);
        body.quota_type = quotaType;
    }
    return oaRequest({ method: "POST", url: OA_QUOTA_MESSAGE_URL, oaId, body });
}

// ─── Uploads ─────────────────────────────────────────────────────────

/**
 * Upload an image ("Upload hình ảnh", `POST v2.0/oa/upload/image`, multipart `file`, jpg/png ≤ 1 MB) →
 * `data.attachment_id`. Zalo keeps uploads 7 days; the API allows 5000 requests a month.
 * @param {string} filePath
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function uploadImage(filePath, oaId = "default") {
    return uploadForm(`${OPENAPI_V2}/oa/upload/image`, filePath, { ...UPLOAD_LIMITS.image, oaId });
}

/**
 * Upload a file ("Upload file", `POST v2.0/oa/upload/file`, multipart `file`, PDF/DOC/DOCX/CSV ≤ 5 MB) →
 * `data.token`.
 * @param {string} filePath
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function uploadFile(filePath, oaId = "default") {
    return uploadForm(`${OPENAPI_V2}/oa/upload/file`, filePath, { ...UPLOAD_LIMITS.file, oaId });
}

/**
 * Upload a GIF ("Upload ảnh GIF", `POST v2.0/oa/upload/gif`, multipart `file`, ≤ 5 MB) → `data.attachment_id`
 * (the docs' example; their field table calls it `token`, so {@link oaUploadedId} reads either).
 * @param {string} filePath
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function uploadGif(filePath, oaId = "default") {
    return uploadForm(`${OPENAPI_V2}/oa/upload/gif`, filePath, { ...UPLOAD_LIMITS.gif, oaId });
}

/**
 * The id an upload reply carries: `data.attachment_id` (image, GIF) or `data.token` (file, and the GIF doc's table).
 * @param {object} reply
 * @returns {string|undefined}
 */
export function oaUploadedId(reply) {
    const d = reply?.data || {};
    return d.attachment_id ?? d.token;
}

// ─── Conversation reads ──────────────────────────────────────────────

function pageArgs(offset, count) {
    const o = Number(offset);
    const c = Number(count);
    if (!Number.isInteger(o) || o < 0) throw invalid("offset must be a whole number ≥ 0");
    if (!Number.isInteger(c) || c < 1 || c > OA_CONV_PAGE_MAX) {
        throw invalid(
            `count must be 1–${OA_CONV_PAGE_MAX} (Zalo returns at most ${OA_CONV_PAGE_MAX} messages a request)`,
        );
    }
    return { offset: o, count: c };
}

/**
 * Recent messages ("Lấy thông tin Tin nhắn gần nhất"): `GET v2.0/oa/listrecentchat?data={"offset","count"}`,
 * count ≤ 10. Replies `data[]` of `{ src (0 OA→user, 1 user→OA), time, type, message, message_id, from_id, to_id,
 * from_display_name, … }`.
 * @param {number} [offset]
 * @param {number} [count]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getRecentChat(offset = 0, count = OA_CONV_PAGE_MAX, oaId = "default") {
    return oaRequest({ url: `${OPENAPI_V2}/oa/listrecentchat`, data: pageArgs(offset, count), oaId });
}

/**
 * One conversation's messages ("Lấy thông tin Tin nhắn trong một hội thoại"):
 * `GET v2.0/oa/conversation?data={"user_id","offset","count"}`, count ≤ 10. The docs type `user_id` as a long and
 * show it as a bare JSON number, so it is written unquoted (a user id passes 2^53, so it is spliced in as text, never
 * through a JS number).
 * @param {string} userId - digits only
 * @param {number} [offset]
 * @param {number} [count]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getConversation(userId, offset = 0, count = OA_CONV_PAGE_MAX, oaId = "default") {
    const id = requireId(userId, "The user id");
    if (!/^\d+$/.test(id)) throw invalid(`The user id must be digits: ${id}`);
    const p = pageArgs(offset, count);
    const data = `{"user_id":${id},"offset":${p.offset},"count":${p.count}}`;
    return oaRequest({ url: `${OPENAPI_V2}/oa/conversation`, query: { data }, oaId });
}

/**
 * Walk pages of `fetchPage(offset, count)` until a page comes back short or empty (or repeats the previous one).
 * @param {(offset: number, count: number) => Promise<object>} fetchPage
 * @param {{ offset?: number, pageSize?: number, max?: number }} [opts] - `max` stops after that many messages
 * @returns {Promise<{ error: 0, message: string, data: object[], pages: number }>}
 */
export async function walkOAConversationPages(fetchPage, { offset = 0, pageSize = OA_CONV_PAGE_MAX, max } = {}) {
    const all = [];
    let at = Number(offset) || 0;
    let pages = 0;
    let prevFirst;
    for (;;) {
        const reply = await fetchPage(at, pageSize);
        pages++;
        const rows = Array.isArray(reply?.data) ? reply.data : [];
        const first = rows[0]?.message_id;
        if (rows.length && first !== undefined && first === prevFirst) break;
        prevFirst = first;
        all.push(...rows);
        if (max && all.length >= max) {
            all.length = max;
            break;
        }
        if (rows.length < pageSize) break;
        at += rows.length;
    }
    return { error: 0, message: "Success", data: all, pages };
}

/**
 * Every recent message, page by page (offset steps of ≤ 10).
 * @param {{ offset?: number, max?: number }} [opts]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getAllOARecentChat({ offset = 0, max } = {}, oaId = "default") {
    return walkOAConversationPages((o, c) => getRecentChat(o, c, oaId), { offset, max });
}

/**
 * A whole conversation, page by page (offset steps of ≤ 10).
 * @param {string} userId
 * @param {{ offset?: number, max?: number }} [opts]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getAllOAConversation(userId, { offset = 0, max } = {}, oaId = "default") {
    return walkOAConversationPages((o, c) => getConversation(userId, o, c, oaId), { offset, max });
}
