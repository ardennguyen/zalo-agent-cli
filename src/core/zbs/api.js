/**
 * ZBS Template Message API (Zalo's ZBS docs, docs.zaloplatforms.com/docs/ZBS): every documented endpoint, with the
 * request built exactly as the docs give it and the documented limits checked before anything is sent.
 *
 * All calls go through src/core/oa/transport.js (`oaRequest` / `uploadForm`): the OA's access token in the
 * `access_token` header, ZBS error codes explained from the ZBS table, a stale token (ZBS -124) refreshed once.
 * The two journey calls add a `journey_token` header through oaRequest's `headers`.
 */

import { randomBytes } from "node:crypto";
import { OAError, OPENAPI_V3, ZBS_BASE, oaRequest, uploadForm } from "../oa/transport.js";
import { hashPhone, normalizePhone } from "./phone.js";
import { encryptTemplateData, parsePublicKey, rsaEncrypt } from "./rsa.js";
import { checkTemplate } from "./template-check.js";
import { ZBS_IMAGE_LIMITS, checkTemplateImage } from "./image.js";

/** Template list page size cap ("Mỗi request được lấy tối đa 100 template"). */
export const TEMPLATE_LIST_MAX = 100;
/** `status` filter of the template list: name → number. */
export const TEMPLATE_STATUS_FILTER = Object.freeze({ enable: 1, pending: 2, reject: 3, disable: 4 });
/** Journey token types (docs "API Gửi tin Journey"); Zalo's default is token_logistics_7. */
export const JOURNEY_TOKEN_TYPES = Object.freeze([
    "token_logistics_7",
    "token_logistics_30",
    "token_coach_bus_7",
    "token_coach_bus_30",
]);
/** `sending_mode` values: 1 normal (default), 3 over-quota (whitelisted OAs, tag 3 only). */
export const SENDING_MODES = Object.freeze(["1", "3"]);
/** tracking_id: Zalo asks for at most 48 characters and no special characters. */
export const TRACKING_ID_MAX = 48;
const TRACKING_ID_RE = /^[A-Za-z0-9_-]+$/;

function bad(message) {
    return new OAError(message, { code: "invalid_input" });
}

/**
 * A tracking_id for a call that needs one: the caller's (checked: 1-48 characters, letters, digits, `_`, `-`), or a
 * generated one (letters and digits only).
 *
 * @param {string} [given]
 * @returns {string}
 */
export function trackingId(given) {
    if (given === undefined || given === null || given === "") {
        return `zbs${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
    }
    const s = String(given);
    if (s.length > TRACKING_ID_MAX) throw bad(`tracking_id is longer than ${TRACKING_ID_MAX} characters`);
    if (!TRACKING_ID_RE.test(s)) throw bad("tracking_id may hold only letters, digits, '_' and '-'");
    return s;
}

/**
 * Check template_data: a JSON object (its values are the template's params).
 * @param {any} data
 * @returns {object}
 */
function templateData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw bad("template_data must be a JSON object of the template's params");
    }
    return data;
}

function templateId(id) {
    const s = String(id ?? "").trim();
    if (!s) throw bad("template_id is required");
    return s;
}

// ─── Templates ────────────────────────────────────────────────────────

/**
 * GET /template/all: the OA's templates, newest first ("API Lấy danh sách Template").
 *
 * @param {object} [opts]
 * @param {number} [opts.offset] - default 0
 * @param {number} [opts.limit] - 1-100, default 100
 * @param {number|string} [opts.status] - 1 enable, 2 pending review, 3 reject, 4 disable (or the name)
 * @param {boolean} [opts.mine] - only templates created by this app (`filterPreset=1`)
 * @param {string} [opts.oaId]
 * @returns {Promise<{ error: number, data: object[], metadata: { total: number } }>}
 */
export async function listTemplates({ offset = 0, limit = TEMPLATE_LIST_MAX, status, mine, oaId } = {}) {
    const off = Number(offset);
    const lim = Number(limit);
    if (!Number.isInteger(off) || off < 0) throw bad("offset must be a whole number >= 0");
    if (!Number.isInteger(lim) || lim < 1 || lim > TEMPLATE_LIST_MAX) {
        throw bad(`limit must be 1-${TEMPLATE_LIST_MAX} (Zalo's cap per request)`);
    }
    let st;
    if (status !== undefined && status !== null && status !== "") {
        st = TEMPLATE_STATUS_FILTER[String(status).toLowerCase()] ?? Number(status);
        if (![1, 2, 3, 4].includes(st)) throw bad("status must be enable, pending, reject or disable (1-4)");
    }
    return oaRequest({
        url: `${ZBS_BASE}/template/all`,
        query: { offset: off, limit: lim, status: st, filterPreset: mine ? 1 : undefined },
        oaId,
    });
}

/**
 * Every template, page by page (100 per request) until `metadata.total` is reached or a page comes back short.
 *
 * @param {object} [opts] - as {@link listTemplates} without offset/limit
 * @returns {Promise<{ error: 0, message: string, data: object[], metadata: { total: number } }>}
 */
export async function listAllTemplates({ status, mine, oaId } = {}) {
    const all = [];
    let total;
    for (let offset = 0; ; offset += TEMPLATE_LIST_MAX) {
        const r = await listTemplates({ offset, limit: TEMPLATE_LIST_MAX, status, mine, oaId });
        const page = Array.isArray(r.data) ? r.data : [];
        all.push(...page);
        total = r.metadata?.total ?? total;
        if (page.length < TEMPLATE_LIST_MAX || (total !== undefined && all.length >= total)) break;
    }
    return { error: 0, message: "Success", data: all, metadata: { total: total ?? all.length } };
}

/**
 * GET /template/info/v2?template_id= ("API Lấy thông tin chi tiết Template").
 * @param {string} id
 * @param {string} [oaId]
 */
export async function getTemplate(id, oaId) {
    return oaRequest({ url: `${ZBS_BASE}/template/info/v2`, query: { template_id: templateId(id) }, oaId });
}

/**
 * GET /template/sample-data?template_id= ("API Lấy dữ liệu mẫu của Template"): the params with sample values.
 * @param {string} id
 * @param {string} [oaId]
 */
export async function getTemplateSample(id, oaId) {
    return oaRequest({ url: `${ZBS_BASE}/template/sample-data`, query: { template_id: templateId(id) }, oaId });
}

/**
 * A timestamp in milliseconds from a number of ms, or anything Date.parse reads ("2026-11-01", ISO).
 * @param {string|number} v
 * @param {string} name - for the message
 * @returns {number}
 */
export function toMillis(v, name) {
    if (v === undefined || v === null || v === "") throw bad(`${name} is required (milliseconds or a date)`);
    if (/^\d+$/.test(String(v))) return Number(v);
    const t = Date.parse(String(v));
    if (Number.isNaN(t)) throw bad(`${name} is not a time: "${v}"`);
    return t;
}

function timeWindow(from, to) {
    const f = toMillis(from, "from");
    const t = toMillis(to, "to");
    if (f > t) throw bad("from is after to");
    return { from_time: f, to_time: t };
}

/**
 * /rating/get ("API Lấy thông tin đánh giá của khách hàng"): ratings left through a service-rating template.
 * The page lists "Method: POST" but its example is a GET with these as query parameters; we send the example's GET.
 *
 * @param {string} id
 * @param {{ from: string|number, to: string|number, offset?: number, limit?: number, oaId?: string }} opts
 */
export async function getRatings(id, { from, to, offset = 0, limit = 100, oaId } = {}) {
    const off = Number(offset);
    const lim = Number(limit);
    if (!Number.isInteger(off) || off < 0) throw bad("offset must be a whole number >= 0");
    if (!Number.isInteger(lim) || lim < 1) throw bad("limit must be a whole number >= 1");
    return oaRequest({
        url: `${ZBS_BASE}/rating/get`,
        query: { template_id: templateId(id), ...timeWindow(from, to), offset: off, limit: lim },
        oaId,
    });
}

/**
 * Every rating in the window, page by page until `data.total` is reached or a page comes back short.
 * @param {string} id
 * @param {{ from: string|number, to: string|number, pageSize?: number, oaId?: string }} opts
 */
export async function getAllRatings(id, { from, to, pageSize = 100, oaId } = {}) {
    const all = [];
    let total;
    for (let offset = 0; ; offset += pageSize) {
        const r = await getRatings(id, { from, to, offset, limit: pageSize, oaId });
        const page = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...page);
        total = r.data?.total ?? total;
        if (page.length < pageSize || (total !== undefined && all.length >= total)) break;
    }
    return { error: 0, data: { total: total ?? all.length, data: all } };
}

/**
 * /response/get ("API Lấy thông tin phản hồi nhanh của khách hàng"): answers given through a quick-response
 * template. Same method note as {@link getRatings}; this one has no offset.
 *
 * @param {string} id
 * @param {{ from: string|number, to: string|number, limit?: number, oaId?: string }} opts
 */
export async function getQuickReplies(id, { from, to, limit = 100, oaId } = {}) {
    const lim = Number(limit);
    if (!Number.isInteger(lim) || lim < 1) throw bad("limit must be a whole number >= 1");
    return oaRequest({
        url: `${ZBS_BASE}/response/get`,
        query: { template_id: templateId(id), ...timeWindow(from, to), limit: lim },
        oaId,
    });
}

function templateBody(template, { edit, id, tracking, check }) {
    if (!template || typeof template !== "object" || Array.isArray(template)) {
        throw bad("the template must be a JSON object");
    }
    const body = { ...template };
    if (edit) body.template_id = String(id ?? body.template_id ?? "");
    if (tracking !== undefined || body.tracking_id === undefined) body.tracking_id = trackingId(tracking);
    if (check) {
        const problems = checkTemplate(body, { edit });
        if (problems.length) {
            throw new OAError(`The template does not meet Zalo's ZBS rules:\n  - ${problems.join("\n  - ")}`, {
                code: "invalid_input",
                data: { problems },
            });
        }
    }
    return body;
}

/**
 * POST /template/create ("API Tạo Template"). The body is the caller's JSON, checked against the docs' rules first
 * (unless `check` is false); tracking_id is generated when missing. 100 requests a day.
 *
 * @param {object} template - template_name, template_type, tag, layout, params, note, tracking_id
 * @param {{ trackingId?: string, check?: boolean, oaId?: string }} [opts]
 */
export async function createTemplate(template, { trackingId: tracking, check = true, oaId } = {}) {
    const body = templateBody(template, { edit: false, tracking, check });
    return oaRequest({ method: "POST", url: `${ZBS_BASE}/template/create`, body, oaId });
}

/**
 * POST /template/edit ("API Chỉnh sửa Template"): only a template in REJECT status, created through the API.
 *
 * @param {string} id - the template to edit (sets `template_id`)
 * @param {object} template - as {@link createTemplate}
 * @param {{ trackingId?: string, check?: boolean, oaId?: string }} [opts]
 */
export async function editTemplate(id, template, { trackingId: tracking, check = true, oaId } = {}) {
    const body = templateBody(template, { edit: true, id: templateId(id), tracking, check });
    return oaRequest({ method: "POST", url: `${ZBS_BASE}/template/edit`, body, oaId });
}

/**
 * POST /upload/image ("API Upload Ảnh"): a JPG/PNG of at most 500 KB, multipart field `file`; returns `media_id`.
 * `kind` also checks the template rule for a logo (PNG 400x96) or an image (16:9).
 *
 * @param {string} filePath
 * @param {{ kind?: "logo"|"image", oaId?: string }} [opts]
 */
export async function uploadImage(filePath, { kind, oaId } = {}) {
    if (kind) checkTemplateImage(filePath, kind);
    return uploadForm(`${ZBS_BASE}/upload/image`, filePath, {
        field: "file",
        maxBytes: ZBS_IMAGE_LIMITS.maxBytes,
        types: [...ZBS_IMAGE_LIMITS.types],
        oaId,
    });
}

// ─── Send by phone ────────────────────────────────────────────────────

/**
 * Build the request for a send by phone number, without sending it: the URL and body of the mode asked for.
 *
 * - default: POST /message/template `{ phone, template_id, template_data, tracking_id, sending_mode? }`;
 * - `hash`: POST /message/template/hashphone `{ hash_phone, template_id, template_data, tracking_id }`
 *   (SHA-256 hex of the 84… number, or a digest given as is);
 * - `dev`: POST /message/template `{ mode: "development", phone, … }` (only to the app's or OA's admins);
 * - `rsa`: POST /rsa/message/template `{ rsa_phone, template_id, template_data, tracking_id }` with the phone and
 *   every template_data value RSA-encrypted (Base64) under `publicKey`, or sent as given with `encrypted`.
 *
 * @param {object} req
 * @param {string} req.phone
 * @param {string} req.templateId
 * @param {object} req.data
 * @param {string} [req.trackingId]
 * @param {"phone"|"hash"|"dev"|"rsa"} [req.mode]
 * @param {string} [req.sendingMode] - "1" or "3" (plain mode only)
 * @param {string|Buffer} [req.publicKey] - rsa mode
 * @param {boolean} [req.encrypted] - rsa mode: phone and data values are already ciphertexts
 * @param {"sha1"|"sha256"} [req.mgf1Hash] - rsa mode
 * @returns {{ url: string, body: object }}
 */
export function buildPhoneSend({
    phone,
    templateId: id,
    data,
    trackingId: tracking,
    mode = "phone",
    sendingMode,
    publicKey,
    encrypted = false,
    mgf1Hash,
}) {
    const template_id = templateId(id);
    const template_data = templateData(data);
    const tracking_id = trackingId(tracking);
    if (sendingMode !== undefined && mode !== "phone") throw bad("sending_mode applies only to a plain send");
    if (sendingMode !== undefined && !SENDING_MODES.includes(String(sendingMode))) {
        throw bad("sending_mode must be 1 (normal) or 3 (over quota, whitelisted OAs, tag 3 templates)");
    }
    switch (mode) {
        case "phone": {
            const body = { phone: normalizePhone(phone), template_id, template_data, tracking_id };
            if (sendingMode !== undefined) body.sending_mode = String(sendingMode);
            return { url: `${ZBS_BASE}/message/template`, body };
        }
        case "hash":
            return {
                url: `${ZBS_BASE}/message/template/hashphone`,
                body: { hash_phone: hashPhone(phone), template_id, template_data, tracking_id },
            };
        case "dev":
            return {
                url: `${ZBS_BASE}/message/template`,
                body: { mode: "development", phone: normalizePhone(phone), template_id, template_data, tracking_id },
            };
        case "rsa": {
            let rsa_phone;
            let values;
            if (encrypted) {
                rsa_phone = String(phone ?? "").trim();
                if (!rsa_phone) throw bad("the encrypted phone number is required");
                values = template_data;
            } else {
                if (!publicKey) throw bad("the RSA public key is required (`zbs rsa-key get`)");
                const key = parsePublicKey(publicKey);
                rsa_phone = rsaEncrypt(normalizePhone(phone), key, { mgf1Hash });
                values = encryptTemplateData(template_data, key, { mgf1Hash });
            }
            return {
                url: `${ZBS_BASE}/rsa/message/template`,
                body: { rsa_phone, template_id, template_data: values, tracking_id },
            };
        }
        default:
            throw bad(`unknown send mode "${mode}"`);
    }
}

/**
 * Send a template message by phone number (see {@link buildPhoneSend} for the modes). In rsa mode without a key,
 * the OA's public key is fetched from /rsa/key/get first.
 *
 * @param {object} req - as {@link buildPhoneSend}, plus `oaId`
 * @returns {Promise<object>} Zalo's reply, with the `tracking_id` that was sent
 */
export async function sendByPhone(req) {
    const r = { ...req };
    if (r.mode === "rsa" && !r.encrypted && !r.publicKey) {
        const got = await getRsaKey(r.oaId);
        r.publicKey = got?.data?.public_key;
        if (!r.publicKey)
            throw new OAError("Zalo returned no RSA public key (create one: `zbs rsa-key create`)", { code: -142 });
    }
    const { url, body } = buildPhoneSend(r);
    const result = await oaRequest({ method: "POST", url, body, oaId: r.oaId });
    return withTracking(result, body.tracking_id);
}

function withTracking(result, tracking) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
        const out = { ...result, tracking_id: tracking };
        if (result.rateLimit) Object.defineProperty(out, "rateLimit", { value: result.rateLimit, enumerable: false });
        return out;
    }
    return result;
}

/**
 * GET /rsa/key/gen: create the OA's RSA key pair; Zalo keeps the private key and returns the public one (Base64).
 * Fails with -143 when a key already exists.
 * @param {string} [oaId]
 */
export async function createRsaKey(oaId) {
    return oaRequest({ url: `${ZBS_BASE}/rsa/key/gen`, oaId });
}

/**
 * GET /rsa/key/get: the OA's existing RSA public key (Base64). Fails with -142 when none exists.
 * @param {string} [oaId]
 */
export async function getRsaKey(oaId) {
    return oaRequest({ url: `${ZBS_BASE}/rsa/key/get`, oaId });
}

// ─── Journey ──────────────────────────────────────────────────────────

/** The journey token, checked present, as the `journey_token` header the journey pages list. */
function journeyHeaders(journeyToken) {
    const t = String(journeyToken ?? "").trim();
    if (!t) throw bad("the journey token is required");
    return { journey_token: t };
}

/**
 * POST /journey/get-token ("Khởi tạo Journey Token"): a journey token for one recipient and journey type.
 * Zalo's reply carries `token` and `journey_id` at the top level.
 *
 * @param {string} phone
 * @param {{ type?: string, oaId?: string }} [opts] - type defaults to Zalo's token_logistics_7 when omitted
 */
export async function createJourneyToken(phone, { type, oaId } = {}) {
    if (type !== undefined && !JOURNEY_TOKEN_TYPES.includes(type)) {
        throw bad(`token_type must be one of ${JOURNEY_TOKEN_TYPES.join(", ")}`);
    }
    const body = { phone: normalizePhone(phone) };
    if (type !== undefined) body.token_type = type;
    return oaRequest({ method: "POST", url: `${ZBS_BASE}/journey/get-token`, body, oaId });
}

/**
 * GET /journey/check-token ("Kiểm tra Journey Token"): the token's type, creation and expiry.
 * @param {string} journeyToken
 * @param {string} [oaId]
 */
export async function checkJourneyToken(journeyToken, oaId) {
    return oaRequest({ url: `${ZBS_BASE}/journey/check-token`, headers: journeyHeaders(journeyToken), oaId });
}

/**
 * POST /message/template with the `journey_token` header ("Gửi tin qua SĐT với Journey Token"):
 * body `{ phone, template_id, template_data }` (the journey page has no tracking_id).
 *
 * @param {{ phone: string, templateId: string, data: object, journeyToken: string, oaId?: string }} req
 */
export async function sendJourney({ phone, templateId: id, data, journeyToken, oaId }) {
    const body = { phone: normalizePhone(phone), template_id: templateId(id), template_data: templateData(data) };
    const headers = journeyHeaders(journeyToken);
    return oaRequest({ method: "POST", url: `${ZBS_BASE}/message/template`, body, headers, oaId });
}

// ─── Send by UID ──────────────────────────────────────────────────────

/**
 * POST https://openapi.zalo.me/v3.0/oa/message/template ("API gửi tin qua UID"): a ZBS template to a user id of
 * the OA. Errors follow the OA error table (-249: the template does not support UID sends).
 *
 * @param {{ userId: string, templateId: string, data: object, oaId?: string }} req
 */
export async function sendByUid({ userId, templateId: id, data, oaId }) {
    const user_id = String(userId ?? "").trim();
    if (!/^\d+$/.test(user_id)) throw bad("user_id must be the user's numeric id for this OA");
    const body = { user_id, template_id: templateId(id), template_data: templateData(data) };
    return oaRequest({ method: "POST", url: `${OPENAPI_V3}/oa/message/template`, body, oaId });
}

// ─── Status, quota, quality ──────────────────────────────────────────

/** `status` of a phone message → meaning (docs "API Lấy thông tin trạng thái gửi tin qua SĐT"). */
export const MESSAGE_STATUS = Object.freeze({
    "-1": "the message does not exist",
    0: "pushed to Zalo's server, not yet delivered to the user's phone",
    1: "delivered to the user's phone",
});

/**
 * GET /message/status?message_id= : the delivery status of a message sent by phone number. The docs' example URL
 * also carries `phone`, which the parameter table does not list; it is sent only when given.
 *
 * @param {string} messageId
 * @param {{ phone?: string, oaId?: string }} [opts]
 */
export async function getMessageStatus(messageId, { phone, oaId } = {}) {
    const id = String(messageId ?? "").trim();
    if (!id) throw bad("message_id is required");
    return oaRequest({
        url: `${ZBS_BASE}/message/status`,
        query: { message_id: id, phone: phone ? normalizePhone(phone) : undefined },
        oaId,
    });
}

/**
 * GET /message/quota: the OA's daily phone-message quota and monthly promotion quota.
 * @param {string} [oaId]
 */
export async function getQuota(oaId) {
    return oaRequest({ url: `${ZBS_BASE}/message/quota`, oaId });
}

/**
 * GET /quality: the OA's phone-message quality over the last 48 hours and 7 days.
 * @param {string} [oaId]
 */
export async function getQuality(oaId) {
    return oaRequest({ url: `${ZBS_BASE}/quality`, oaId });
}
