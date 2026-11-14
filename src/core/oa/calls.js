/**
 * OA voice calls (Zalo's OA docs "Gọi thoại"): ask a user for permission to be called by phone number, check that
 * permission, create outbound/inbound call links, and read the call center's agents and branches.
 *
 * The consent endpoints are v2.0 (`requestconsent` POSTs JSON, `checkconsent` GETs `?data=<JSON>`); the call
 * links and the agent/branch info are v3.0. The consent endpoints answer with their own code table ("Mã lỗi" of
 * "Cấp quyền gọi", {@link CONSENT_CODES}): `error` 0 is not the only meaningful answer there, so the state codes
 * come back as results and only the failure codes throw.
 *
 * Nothing here prints: callers report through src/utils/output.js.
 */

import { OPENAPI_V2, OPENAPI_V3, OAError, oaRequest } from "./transport.js";

/** The endpoints, as the docs name them. */
export const CALL_URLS = Object.freeze({
    requestConsent: `${OPENAPI_V2}/oa/call/requestconsent`,
    checkConsent: `${OPENAPI_V2}/oa/call/checkconsent`,
    outbound: `${OPENAPI_V3}/oa/call/outbound`,
    inbound: `${OPENAPI_V3}/oa/call/inbound`,
    mccInfo: `${OPENAPI_V3}/oa/call/getmccinfo`,
});

/** `call_type` values. */
export const CALL_TYPES = Object.freeze(["audio", "video", "audio_and_video"]);

/** `reason_code` values of "Gửi yêu cầu cấp quyền gọi" (others: the docs say to contact Zalo). */
export const CONSENT_REASONS = Object.freeze({
    101: "product / service consultation",
    103: "order / appointment confirmation",
    105: "delivery notice",
    106: "flight notice",
    107: "order update",
});

/** The consent code table ("Mã lỗi" under "Cấp quyền gọi"), as the docs word it. */
export const CONSENT_CODES = Object.freeze({
    0: "User approved the request",
    1: "Already allowed to call",
    2: "Request sent",
    3: "User rejected the request",
    4: "User blocked",
    5: "The number of requests allowed is exceeded, please try again later",
    6: "Insufficient permissions",
    7: "A reason is required to request user consent",
    8: "Waiting for user approval",
    9: "The user has not yet interacted with this OA",
    10: "Bad connection",
    11: "Bad request",
    12: "Something went wrong, please retry later",
    13: "Invalid param",
    14: "Failed",
    16: "Consent expired",
    18: "Outside working hours",
    19: "Not in permitted time range",
    20: "OA has not yet requested user consent",
    21: "OA has turned off inbound call",
});

/** Codes that answer "what is this user's consent?" (a result, not a failure). */
const CHECK_STATES = new Set([0, 1, 2, 3, 4, 8, 9, 16, 20]);
/** Codes that mean a consent request went out or is not needed. */
const REQUEST_OK = new Set([0, 1, 2, 8]);
/** The codes after which the OA may call the user. */
const CONSENTED = new Set([0, 1]);

function invalid(message) {
    return new OAError(message, { code: "invalid_input" });
}

/**
 * A phone number as the consent endpoints take it (digits, as in the docs' `84773543888`): spaces, dots and dashes
 * are dropped and a leading `+` removed; anything else that is not 9–15 digits is refused.
 *
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
    const s = String(phone ?? "")
        .trim()
        .replace(/[\s.-]/g, "")
        .replace(/^\+/, "");
    if (!/^\d{9,15}$/.test(s)) throw invalid(`not a phone number: "${phone}" (use 84xxxxxxxxx or 0xxxxxxxxx)`);
    return s;
}

function callType(value) {
    const t = value === undefined ? "audio" : String(value);
    if (!CALL_TYPES.includes(t)) throw invalid(`call type must be one of ${CALL_TYPES.join(", ")}`);
    return t;
}

/** Turn a consent-table code thrown by oaRequest into a result, or rethrow it with the table's meaning. */
function consentAnswer(e, okCodes) {
    if (!(e instanceof OAError) || typeof e.code !== "number" || !(e.code in CONSENT_CODES)) throw e;
    if (okCodes.has(e.code)) return e.data ?? { error: e.code, message: CONSENT_CODES[e.code] };
    throw new OAError(`OA call consent error ${e.code}: ${CONSENT_CODES[e.code]}`, {
        code: e.code,
        data: e.data,
        meaning: CONSENT_CODES[e.code],
    });
}

function withState(reply) {
    const code = Number(reply?.error ?? 0);
    return {
        ...reply,
        code,
        status: CONSENT_CODES[code] ?? reply?.message ?? "",
        consented: CONSENTED.has(code),
    };
}

/**
 * Ask a user, by phone number, for permission to be called ("Gửi yêu cầu cấp quyền gọi",
 * `POST v2.0/oa/call/requestconsent`). Zalo charges each request; the user has 24 hours to answer, and an
 * approval lets the OA call for 30 days. Codes 0/1/2/8 come back as results; the rest throw.
 *
 * @param {object} spec
 * @param {string} spec.phone
 * @param {string} [spec.callType] - audio (default), video or audio_and_video
 * @param {number|string} spec.reasonCode - one of {@link CONSENT_REASONS}
 * @param {string} [oaId]
 * @returns {Promise<object>} Zalo's reply plus `code`, `status` (the docs' wording) and `consented`
 */
export async function requestCallConsent({ phone, callType: type, reasonCode }, oaId = "default") {
    const reason = Number(reasonCode);
    if (!(reason in CONSENT_REASONS) || !Number.isInteger(reason)) {
        const list = Object.entries(CONSENT_REASONS)
            .map(([k, v]) => `${k} (${v})`)
            .join(", ");
        throw invalid(`reason code must be one of ${list}`);
    }
    const body = { phone: normalizePhone(phone), call_type: callType(type), reason_code: reason };
    let reply;
    try {
        reply = await oaRequest({ method: "POST", url: CALL_URLS.requestConsent, body, oaId });
    } catch (e) {
        reply = consentAnswer(e, REQUEST_OK);
    }
    return withState(reply);
}

/**
 * Whether a user allowed the OA to call their phone number ("Kiểm tra người dùng đã cấp quyền gọi",
 * `GET v2.0/oa/call/checkconsent?data={"phone":…}`). The state codes (approved, already allowed, sent, rejected,
 * blocked, waiting, no interaction, expired, not requested) come back as results; the rest throw.
 *
 * @param {string} phone
 * @param {string} [oaId]
 * @returns {Promise<object>} Zalo's reply (`expired_time` when approved) plus `code`, `status`, `consented`
 */
export async function checkCallConsent(phone, oaId = "default") {
    const data = { phone: normalizePhone(phone) };
    let reply;
    try {
        reply = await oaRequest({ url: CALL_URLS.checkConsent, data, oaId });
    } catch (e) {
        reply = consentAnswer(e, CHECK_STATES);
    }
    return withState(reply);
}

/**
 * A link (and QR code) for the OA to call a user ("Tạo link gọi thoại outbound từ OA đến người dùng",
 * `POST v3.0/oa/call/outbound`).
 *
 * @param {object} spec
 * @param {string} spec.userId - the user to call
 * @param {string} [spec.agentId] - the agent (their user_id) who makes the call
 * @param {string} [spec.callType] - audio (default), video or audio_and_video
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.call_link`, `data.qr_code`, `data.ttl` (seconds)
 */
export async function createOutboundCallLink({ userId, agentId, callType: type }, oaId = "default") {
    const uid = String(userId ?? "").trim();
    if (!uid) throw invalid("user id is required");
    const body = { user_id: uid };
    if (agentId !== undefined && agentId !== null && agentId !== "") body.agent_id = String(agentId);
    body.call_type = callType(type);
    return oaRequest({ method: "POST", url: CALL_URLS.outbound, body, oaId });
}

/**
 * A link (and QR code) for a user to call the OA ("Tạo link gọi thoại inbound từ người dùng đến OA",
 * `POST v3.0/oa/call/inbound`).
 *
 * @param {object} [spec]
 * @param {string} [spec.branchId] - the call branch to reach
 * @param {string} [spec.agentId] - the agent (their user_id) to reach
 * @param {string} [spec.callType] - audio (default), video or audio_and_video
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.call_link`, `data.qr_code`, `data.ttl` (seconds)
 */
export async function createInboundCallLink({ branchId, agentId, callType: type } = {}, oaId = "default") {
    const body = {};
    if (branchId !== undefined && branchId !== null && branchId !== "") body.branch_id = String(branchId);
    if (agentId !== undefined && agentId !== null && agentId !== "") body.agent_id = String(agentId);
    body.call_type = callType(type);
    return oaRequest({ method: "POST", url: CALL_URLS.inbound, body, oaId });
}

/**
 * The call center's agents and branches ("Lấy thông tin Agent, Branch", `GET v3.0/oa/call/getmccinfo`).
 *
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.agents` (`agent_id`, `agent_name`, `allocation`), `data.branches`
 *   (`branch_id`, `branch_name`, `status` on|off)
 */
export async function getCallCenterInfo(oaId = "default") {
    return oaRequest({ url: CALL_URLS.mccInfo, oaId });
}
