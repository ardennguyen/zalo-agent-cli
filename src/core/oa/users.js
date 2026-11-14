/**
 * OA users, user fields, tags, Zalo Ads forms and OA product purchases, as Zalo's OA docs give them:
 *
 * - "Quản lý thông tin người dùng": user list/detail/update/delete, custom user info, tags (v2.0 `tag/*`);
 * - "Quản lý trường thông tin người dùng": user field definitions (`v3.0/oa/userfield/*`);
 * - "Quản lý form Zalo Ads": form content (`v2.0/oa/form/get`);
 * - "Mua sản phẩm / dịch vụ OA": create and confirm an order (`v3.0/oa/purchase/*`).
 *
 * Inputs are checked against the documented limits before anything is sent; a bad input throws a RangeError or
 * TypeError naming the limit. Nothing here prints.
 */

import { OPENAPI_V2, OPENAPI_V3, oaRequest } from "./transport.js";

// ─── Limits from the docs ────────────────────────────────────────────

/**
 * `v3.0/oa/user/getlist` limits ("Truy xuất danh sách người dùng"): at most 50 users per request and an offset of
 * at most 9951 (10,000 users in all).
 */
export const FOLLOWER_LIST_LIMITS = Object.freeze({ maxCount: 50, maxOffset: 9951 });

/** The fixed `last_interaction_period` values; a custom range is `YYYY_MM_DD:YYYY_MM_DD`. */
export const LAST_INTERACTION_PERIODS = Object.freeze(["TODAY", "YESTERDAY", "L7D", "L30D"]);

/** `shared_info` fields of `v3.0/oa/user/update` ("Cập nhật chi tiết người dùng"). */
export const SHARED_INFO_FIELDS = Object.freeze(["name", "phone", "address", "city_id", "district_id", "user_dob"]);

/** Top-level fields of `v3.0/oa/user/update/custominfo` besides `user_id` ("Cập nhật thông tin tùy biến"). */
export const CUSTOM_INFO_UPDATE_FIELDS = Object.freeze([
    "name",
    "phone",
    "user_dob",
    "gender",
    "full_address",
    "user_external_id",
    "custom_info",
]);

/** The `gender` values `user/update/custominfo` accepts. */
export const CUSTOM_INFO_GENDERS = Object.freeze(["Nam", "Nữ", "Khác"]);

/** The `data_type` values a user field can be created with (the system types id, tag, gender, location cannot). */
export const USER_FIELD_DATA_TYPES = Object.freeze([
    "boolean",
    "number",
    "text",
    "datetime",
    "table",
    "email",
    "phone",
    "url",
]);

/** The documented `additional_format` values of a datetime user field ("Format datetime"). */
export const USER_FIELD_DATETIME_FORMATS = Object.freeze([
    "dd/MM/yyyy",
    "dd/MM/yyyy HH:mm:ss",
    "dd-MM-yyyy",
    "dd-MM-yyyy HH:mm:ss",
    "yyyy-MM-dd",
    "yyyy-MM-ddTHH:mm:ss",
]);

/** A user field's `status`. */
export const USER_FIELD_STATUSES = Object.freeze(["active", "inactive"]);

/** `field_type` filter of `userfield/get`. */
export const USER_FIELD_TYPES = Object.freeze(["system", "oa_custom"]);

/** A table user field holds at most 5 key-value pairs. */
export const USER_FIELD_TABLE_MAX_KEYS = 5;

/** `v2.0/oa/form/get` limits ("Lấy nội dung form Zalo Ads"): ≤ 200 items, a window of ≤ 30 days. */
export const ADS_FORM_LIMITS = Object.freeze({ maxLimit: 200, maxWindowSeconds: 30 * 24 * 3600 });

/** Who a purchase is for (`beneficiary`). */
export const PURCHASE_BENEFICIARIES = Object.freeze(["OA", "APP"]);

// ─── Small checks ────────────────────────────────────────────────────

function intIn(value, name, min, max) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
        const range = max === undefined ? `an integer ≥ ${min}` : `an integer from ${min} to ${max}`;
        throw new RangeError(`${name} must be ${range} (got ${value})`);
    }
    return n;
}

function requireText(value, name) {
    if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
    return value;
}

function oneOf(value, allowed, name) {
    if (!allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join(", ")} (got ${value})`);
    return value;
}

function plainObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be a JSON object`);
    }
    return value;
}

function onlyKeys(obj, allowed, name) {
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
    if (extra.length) {
        throw new RangeError(`${name}: unknown field(s) ${extra.join(", ")}; the docs allow ${allowed.join(", ")}`);
    }
}

/**
 * A numeric id the docs type as `long`, sent as a bare JSON number with every digit kept (ids pass 2^53, so a
 * JS number would round them).
 * @param {string|number|bigint} id
 * @param {string} name
 * @returns {unknown} a value JSON.stringify writes as the exact number
 */
export function longId(id, name = "id") {
    const s = String(id ?? "").trim();
    if (!/^\d+$/.test(s)) throw new TypeError(`${name} must be a numeric id (got ${id})`);
    return JSON.rawJSON(s.replace(/^0+(?=\d)/, ""));
}

/**
 * `dd/MM/yyyy`, a real date from 01/01/1970 on (the docs' only accepted birth dates).
 * @param {string} value
 * @param {string} [name]
 * @returns {string}
 */
export function checkDob(value, name = "user_dob") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value));
    const d = m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
    if (!d || d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || +m[3] < 1970) {
        throw new RangeError(`${name} must be a dd/MM/yyyy date from 01/01/1970 on (got ${value})`);
    }
    return String(value);
}

// ─── Users ───────────────────────────────────────────────────────────

/**
 * One user's details (`GET v3.0/oa/user/detail?data={user_id}`): `display_name`, `user_alias`,
 * `user_is_follower`, `user_last_interaction_date`, `tags_and_notes_info`, `shared_info`, …
 * @param {string} userId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getFollowerInfo(userId, oaId = "default") {
    requireText(String(userId ?? ""), "user id");
    return oaRequest({ url: `${OPENAPI_V3}/oa/user/detail`, data: { user_id: String(userId) }, oaId });
}

/**
 * Normalize a `last_interaction_period`: TODAY, YESTERDAY, L7D, L30D, or a custom `YYYY_MM_DD:YYYY_MM_DD` range
 * (angle brackets around the range, as the docs print it, are accepted and dropped).
 * @param {string} period
 * @returns {string}
 */
export function normalizeInteractionPeriod(period) {
    const p = String(period)
        .trim()
        .replace(/^<(.*)>$/, "$1");
    const upper = p.toUpperCase();
    if (LAST_INTERACTION_PERIODS.includes(upper)) return upper;
    if (/^\d{4}_\d{2}_\d{2}:\d{4}_\d{2}_\d{2}$/.test(p)) return p;
    throw new RangeError(
        `last interaction period must be ${LAST_INTERACTION_PERIODS.join(", ")} or YYYY_MM_DD:YYYY_MM_DD (got ${period})`,
    );
}

/**
 * The `data` of a `user/getlist` call, checked against the documented limits.
 * @param {object} [opts]
 * @param {number} [opts.offset] - 0..9951
 * @param {number} [opts.count] - 1..50
 * @param {string} [opts.tagName] - only users with this tag
 * @param {string} [opts.lastInteraction] - TODAY | YESTERDAY | L7D | L30D | YYYY_MM_DD:YYYY_MM_DD
 * @param {boolean} [opts.isFollower] - true: following the OA; false: not following
 * @returns {object}
 */
export function followerListData({ offset = 0, count = 50, tagName, lastInteraction, isFollower } = {}) {
    const data = {
        offset: intIn(offset, "offset", 0, FOLLOWER_LIST_LIMITS.maxOffset),
        count: intIn(count, "count", 1, FOLLOWER_LIST_LIMITS.maxCount),
    };
    if (tagName !== undefined) data.tag_name = requireText(tagName, "tag name");
    if (lastInteraction !== undefined) data.last_interaction_period = normalizeInteractionPeriod(lastInteraction);
    if (isFollower !== undefined) data.is_follower = Boolean(isFollower);
    return data;
}

/**
 * One page of the user list (`GET v3.0/oa/user/getlist?data={offset,count,tag_name?,last_interaction_period?,
 * is_follower?}`). The answer's `data.users` holds `{user_id}` only; `data.total` counts every match.
 * @param {Parameters<typeof followerListData>[0]} [opts]
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getFollowers(opts = {}, oaId = "default") {
    return oaRequest({ url: `${OPENAPI_V3}/oa/user/getlist`, data: followerListData(opts), oaId });
}

/**
 * Every page of the user list, 50 at a time from `offset`, until the total is reached, a page comes back short,
 * or the documented offset ceiling (9951, so 10,000 users) is passed.
 * @param {Parameters<typeof followerListData>[0]} [opts] - `count` is ignored (50 per page)
 * @param {string} [oaId]
 * @returns {Promise<{ total: number, users: object[], truncated: boolean }>} `truncated`: more users exist than the
 *   API can list
 */
export async function getAllFollowers(opts = {}, oaId = "default") {
    const { maxCount, maxOffset } = FOLLOWER_LIST_LIMITS;
    const users = [];
    let offset = intIn(opts.offset ?? 0, "offset", 0, maxOffset);
    let total = 0;
    for (;;) {
        const r = await getFollowers({ ...opts, offset, count: maxCount }, oaId);
        const page = Array.isArray(r?.data?.users) ? r.data.users : [];
        total = Number(r?.data?.total) || 0;
        users.push(...page);
        offset += maxCount;
        if (page.length < maxCount || offset >= total) return { total, users, truncated: false };
        if (offset > maxOffset) return { total, users, truncated: true };
    }
}

/**
 * The body of `v3.0/oa/user/update`: profile fields under `shared_info`, `user_alias` and `user_external_id`
 * at the top level.
 *
 * `fields` takes the doc's shape (`{shared_info: {...}, user_alias, user_external_id}`), and `shared_info` keys
 * given at the top level are moved under `shared_info`. Unknown keys are refused rather than dropped; `city_id`
 * and `district_id` must be integers and `user_dob` a dd/MM/yyyy date from 1970 on.
 *
 * @param {string} userId
 * @param {object} fields
 * @returns {object}
 */
export function buildFollowerUpdate(userId, fields) {
    requireText(String(userId ?? ""), "user id");
    plainObject(fields, "update");
    const { shared_info: nested, user_alias: alias, user_external_id: externalId, ...flat } = fields;
    onlyKeys(flat, SHARED_INFO_FIELDS, "update");
    const shared = { ...(nested === undefined ? {} : plainObject(nested, "shared_info")), ...flat };
    onlyKeys(shared, SHARED_INFO_FIELDS, "shared_info");
    for (const k of ["city_id", "district_id"]) {
        if (shared[k] !== undefined) shared[k] = intIn(shared[k], k, 0);
    }
    if (shared.user_dob !== undefined) checkDob(shared.user_dob);
    for (const k of ["name", "phone", "address"]) {
        if (shared[k] !== undefined) shared[k] = String(shared[k]);
    }
    const body = { user_id: String(userId) };
    if (Object.keys(shared).length) body.shared_info = shared;
    if (alias !== undefined) body.user_alias = String(alias);
    if (externalId !== undefined) body.user_external_id = String(externalId);
    if (Object.keys(body).length === 1) {
        throw new TypeError("nothing to update: give a shared_info field, user_alias or user_external_id");
    }
    return body;
}

/**
 * Update a user (`POST v3.0/oa/user/update`, body as {@link buildFollowerUpdate} builds it).
 * @param {string} userId
 * @param {object} fields
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function updateFollowerInfo(userId, fields, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/user/update`,
        body: buildFollowerUpdate(userId, fields),
        oaId,
    });
}

/**
 * Delete what the OA stores about a user (`POST v2.0/oa/deletefollowerinfo`, body `{user_id}`). The user's Zalo
 * account is not changed.
 * @param {string} userId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function deleteFollowerInfo(userId, oaId = "default") {
    requireText(String(userId ?? ""), "user id");
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V2}/oa/deletefollowerinfo`,
        body: { user_id: String(userId) },
        oaId,
    });
}

/**
 * A user's custom info (`GET v3.0/oa/user/detail/custominfo?data={user_id,fields_to_export?}`). Every value in
 * `data.custom_info` comes back as a string; a table field is asked for by its parent key.
 * @param {string} userId
 * @param {string[]} [fields] - `fields_to_export`; all fields when absent
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getFollowerCustomInfo(userId, fields, oaId = "default") {
    requireText(String(userId ?? ""), "user id");
    const data = { user_id: String(userId) };
    if (fields?.length) data.fields_to_export = fields.map(String);
    return oaRequest({ url: `${OPENAPI_V3}/oa/user/detail/custominfo`, data, oaId });
}

/**
 * The body of `v3.0/oa/user/update/custominfo`: `user_id` plus the documented fields (`name`, `phone`,
 * `user_dob`, `gender` Nam|Nữ|Khác, `full_address{user_city_id,user_ward_id,user_address}`, `user_external_id`,
 * `custom_info{…}`). Unknown keys are refused.
 * @param {string} userId
 * @param {object} fields
 * @returns {object}
 */
export function buildCustomInfoUpdate(userId, fields) {
    requireText(String(userId ?? ""), "user id");
    plainObject(fields, "custom info update");
    if ("user_id" in fields) throw new RangeError("give the user id as the argument, not inside the JSON");
    onlyKeys(fields, CUSTOM_INFO_UPDATE_FIELDS, "custom info update");
    if (!Object.keys(fields).length) throw new TypeError("nothing to update");
    if (fields.gender !== undefined) oneOf(fields.gender, CUSTOM_INFO_GENDERS, "gender");
    if (fields.user_dob !== undefined) checkDob(fields.user_dob);
    if (fields.full_address !== undefined) {
        onlyKeys(
            plainObject(fields.full_address, "full_address"),
            ["user_city_id", "user_ward_id", "user_address"],
            "full_address",
        );
    }
    if (fields.custom_info !== undefined) plainObject(fields.custom_info, "custom_info");
    return { user_id: String(userId), ...fields };
}

/**
 * Update a user's custom info (`POST v3.0/oa/user/update/custominfo`).
 * @param {string} userId
 * @param {object} fields - see {@link buildCustomInfoUpdate}
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function updateFollowerCustomInfo(userId, fields, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/user/update/custominfo`,
        body: buildCustomInfoUpdate(userId, fields),
        oaId,
    });
}

// ─── User fields ─────────────────────────────────────────────────────

/**
 * The OA's user fields (`GET v3.0/oa/userfield/get`), optionally filtered by `field_type` and `fields_to_get`.
 *
 * The docs' example sends the filter as a JSON body on a GET, which fetch cannot do; it is sent the way every
 * other v3.0 GET takes its input, as `?data=<JSON>`, and only when a filter is given.
 *
 * @param {{ fieldType?: string, fields?: string[] }} [filter]
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.fields[]`: `key`, `name`, `data_type`, `status`, `field_type`, …
 */
export async function listUserFields({ fieldType, fields } = {}, oaId = "default") {
    const data = {};
    if (fieldType !== undefined) data.field_type = oneOf(fieldType, USER_FIELD_TYPES, "field type");
    if (fields?.length) data.fields_to_get = fields.map(String);
    return oaRequest({
        url: `${OPENAPI_V3}/oa/userfield/get`,
        data: Object.keys(data).length ? data : undefined,
        oaId,
    });
}

function checkTableFields(list) {
    if (!Array.isArray(list) || !list.length) throw new TypeError("table fields must be a non-empty JSON array");
    if (list.length > USER_FIELD_TABLE_MAX_KEYS) {
        throw new RangeError(`a table field holds at most ${USER_FIELD_TABLE_MAX_KEYS} keys (got ${list.length})`);
    }
    for (const f of list) {
        plainObject(f, "table field");
        onlyKeys(f, ["key", "data_type", "additional_format"], "table field");
        requireText(f.key, "table field key");
        oneOf(
            f.data_type,
            USER_FIELD_DATA_TYPES.filter((t) => t !== "table"),
            "table field data_type",
        );
        if (f.additional_format !== undefined) {
            if (f.data_type !== "datetime") throw new RangeError("additional_format is for a datetime field only");
            oneOf(f.additional_format, USER_FIELD_DATETIME_FORMATS, "additional_format");
        }
    }
    return list;
}

/**
 * The body of `v3.0/oa/userfield/create`, checked: `key`, `name`, `data_type` (not a system type),
 * `description?`, `status?` (default active), `additional_format?` (datetime only), `additional_fields?` (table
 * only, ≤ 5 keys).
 * @param {object} field
 * @returns {object}
 */
export function buildUserFieldCreate(field) {
    plainObject(field, "user field");
    const { key, name, data_type: type, description, status, additional_format: fmt, additional_fields: cols } = field;
    onlyKeys(
        field,
        ["key", "name", "data_type", "description", "status", "additional_format", "additional_fields"],
        "user field",
    );
    const body = { key: requireText(key, "key"), name: requireText(name, "name") };
    body.data_type = oneOf(type, USER_FIELD_DATA_TYPES, "data type");
    if (description !== undefined) body.description = String(description);
    if (status !== undefined) body.status = oneOf(status, USER_FIELD_STATUSES, "status");
    if (fmt !== undefined) {
        if (type !== "datetime") throw new RangeError("a format is for a datetime field only");
        body.additional_format = oneOf(fmt, USER_FIELD_DATETIME_FORMATS, "format");
    }
    if (cols !== undefined) {
        if (type !== "table") throw new RangeError("table fields are for a table field only");
        body.additional_fields = checkTableFields(cols);
    }
    return body;
}

/**
 * Create a custom user field (`POST v3.0/oa/userfield/create`). `key` and `data_type` cannot change afterwards.
 * @param {object} field - see {@link buildUserFieldCreate}
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function createUserField(field, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/userfield/create`,
        body: buildUserFieldCreate(field),
        oaId,
    });
}

/**
 * The body of `v3.0/oa/userfield/update`: `key` plus any of `name`, `description`, `status`,
 * `additional_format`, `additional_fields` (table: new keys only). `key` and `data_type` cannot change.
 * @param {object} field
 * @returns {object}
 */
export function buildUserFieldUpdate(field) {
    plainObject(field, "user field");
    onlyKeys(
        field,
        ["key", "name", "description", "status", "additional_format", "additional_fields"],
        "user field update",
    );
    const body = { key: requireText(field.key, "key") };
    if (field.name !== undefined) body.name = requireText(field.name, "name");
    if (field.description !== undefined) body.description = String(field.description);
    if (field.status !== undefined) body.status = oneOf(field.status, USER_FIELD_STATUSES, "status");
    if (field.additional_format !== undefined) {
        body.additional_format = oneOf(field.additional_format, USER_FIELD_DATETIME_FORMATS, "format");
    }
    if (field.additional_fields !== undefined) body.additional_fields = checkTableFields(field.additional_fields);
    if (Object.keys(body).length === 1) {
        throw new TypeError("nothing to update: give a name, description, status, format or table fields");
    }
    return body;
}

/**
 * Update a user field (`POST v3.0/oa/userfield/update`).
 * @param {object} field - see {@link buildUserFieldUpdate}
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function updateUserField(field, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/userfield/update`,
        body: buildUserFieldUpdate(field),
        oaId,
    });
}

/**
 * Delete a custom (`oa_custom`) user field and every user's value in it (`POST v3.0/oa/userfield/delete`, body
 * `{key}`). The docs give POST as the method (their curl example says DELETE); POST is sent.
 * @param {string} key
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function deleteUserField(key, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/userfield/delete`,
        body: { key: requireText(key, "key") },
        oaId,
    });
}

// ─── Tags ────────────────────────────────────────────────────────────

/**
 * The OA's tags (`GET v2.0/oa/tag/gettagsofoa`); `data` is a string array.
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getTags(oaId = "default") {
    return oaRequest({ url: `${OPENAPI_V2}/oa/tag/gettagsofoa`, oaId });
}

/**
 * Tag a user (`POST v2.0/oa/tag/tagfollower`, body `{user_id, tag_name}`; a tag that does not exist is created).
 * @param {string} userId
 * @param {string} tagName
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function assignTag(userId, tagName, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V2}/oa/tag/tagfollower`,
        body: { user_id: longId(userId, "user id"), tag_name: requireText(tagName, "tag name") },
        oaId,
    });
}

/**
 * Untag a user (`POST v2.0/oa/tag/rmfollowerfromtag`, body `{user_id, tag_name}`).
 * @param {string} userId
 * @param {string} tagName
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function removeFollowerFromTag(userId, tagName, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V2}/oa/tag/rmfollowerfromtag`,
        body: { user_id: longId(userId, "user id"), tag_name: requireText(tagName, "tag name") },
        oaId,
    });
}

/**
 * Delete a tag, untagging every user (`POST v2.0/oa/tag/rmtag`, body `{tag_name}`).
 * @param {string} tagName
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function removeTag(tagName, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V2}/oa/tag/rmtag`,
        body: { tag_name: requireText(tagName, "tag name") },
        oaId,
    });
}

// ─── Zalo Ads forms ──────────────────────────────────────────────────

/**
 * A time as Unix seconds: an integer (seconds; 13 digits are read as milliseconds) or a date string `Date`
 * parses (e.g. `2026-11-01`, `2026-11-01T08:00:00+07:00`).
 * @param {string|number} value
 * @param {string} name
 * @returns {number}
 */
export function toUnixSeconds(value, name = "time") {
    const s = String(value ?? "").trim();
    if (/^\d+$/.test(s)) return s.length >= 13 ? Math.floor(Number(s) / 1000) : Number(s);
    const ms = Date.parse(s);
    if (!s || Number.isNaN(ms)) throw new RangeError(`${name} must be Unix seconds or a date (got ${value})`);
    return Math.floor(ms / 1000);
}

/**
 * The query of `v2.0/oa/form/get`: `form_id`, `from_time`, `to_time` (seconds, a window of at most 30 days),
 * `offset`, `limit` (≤ 200). All five are required by the docs.
 * @param {{ formId: string, from: string|number, to: string|number, offset?: number, limit?: number }} q
 * @returns {object}
 */
export function adsFormQuery({ formId, from, to, offset = 0, limit = ADS_FORM_LIMITS.maxLimit }) {
    const fromTime = toUnixSeconds(from, "from");
    const toTime = toUnixSeconds(to, "to");
    if (toTime < fromTime) throw new RangeError("to must not be before from");
    if (toTime - fromTime > ADS_FORM_LIMITS.maxWindowSeconds) {
        throw new RangeError("the time window must be 30 days or less (Zalo's limit)");
    }
    return {
        form_id: requireText(String(formId ?? ""), "form id"),
        from_time: fromTime,
        to_time: toTime,
        offset: intIn(offset, "offset", 0),
        limit: intIn(limit, "limit", 1, ADS_FORM_LIMITS.maxLimit),
    };
}

/**
 * A Zalo Ads form's leads (`GET v2.0/oa/form/get?form_id&from_time&to_time&offset&limit`): `data.total`,
 * `data.questions[]` (`questionId`, `title`), `data.responses[]` (`leadId`, `submitTime`, `adId`, `answers[]`).
 * @param {Parameters<typeof adsFormQuery>[0]} q
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getAdsForm(q, oaId = "default") {
    return oaRequest({ url: `${OPENAPI_V2}/oa/form/get`, query: adsFormQuery(q), oaId });
}

/**
 * Every response of a form in the window, 200 at a time, until `data.total` is reached or a page comes back short.
 * @param {Parameters<typeof adsFormQuery>[0]} q - `limit` is ignored
 * @param {string} [oaId]
 * @returns {Promise<{ total: number, questions: object[], responses: object[] }>}
 */
export async function getAllAdsForm(q, oaId = "default") {
    const limit = ADS_FORM_LIMITS.maxLimit;
    let offset = intIn(q.offset ?? 0, "offset", 0);
    const responses = [];
    let questions = [];
    for (;;) {
        const r = await getAdsForm({ ...q, offset, limit }, oaId);
        const d = r?.data || {};
        if (Array.isArray(d.questions) && d.questions.length) questions = d.questions;
        const page = Array.isArray(d.responses) ? d.responses : [];
        responses.push(...page);
        offset += limit;
        const total = Number(d.total) || 0;
        if (page.length < limit || offset >= total) return { total, questions, responses };
    }
}

// ─── Purchases ───────────────────────────────────────────────────────

/**
 * The body of `v3.0/oa/purchase/create_order`: `beneficiary` (OA|APP) and exactly one of `product_id` (sent as
 * the exact number) or `redeem_code`, plus `voucher_code?`.
 * @param {{ beneficiary?: string, productId?: string, redeemCode?: string, voucherCode?: string }} order
 * @returns {object}
 */
export function buildPurchaseOrder({ beneficiary = "OA", productId, redeemCode, voucherCode } = {}) {
    if ((productId === undefined) === (redeemCode === undefined)) {
        throw new TypeError("give exactly one of a product id or a redeem code");
    }
    const body = { beneficiary: oneOf(String(beneficiary).toUpperCase(), PURCHASE_BENEFICIARIES, "beneficiary") };
    if (productId !== undefined) body.product_id = longId(productId, "product id");
    else body.redeem_code = requireText(redeemCode, "redeem code");
    if (voucherCode !== undefined) body.voucher_code = requireText(voucherCode, "voucher code");
    return body;
}

/**
 * Create an order for an OA product (`POST v3.0/oa/purchase/create_order`). Nothing is charged yet: the answer
 * holds the price (`amount`, `final_amount`), `order_id` and the one-time `verified_token` (valid 5 minutes) that
 * {@link confirmPurchaseOrder} needs. Orders can only be created from 00:01 to 23:54.
 * @param {Parameters<typeof buildPurchaseOrder>[0]} order
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function createPurchaseOrder(order, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/purchase/create_order`,
        body: buildPurchaseOrder(order),
        oaId,
    });
}

/**
 * Confirm (pay) an order (`POST v3.0/oa/purchase/confirm_order`, body `{order_id, verified_token}`): the product
 * is bought and the ZCA account charged.
 * @param {string} orderId
 * @param {string} verifiedToken - the create answer's `verified_token`
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function confirmPurchaseOrder(orderId, verifiedToken, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: `${OPENAPI_V3}/oa/purchase/confirm_order`,
        body: {
            order_id: requireText(String(orderId ?? ""), "order id"),
            verified_token: requireText(String(verifiedToken ?? ""), "verified token"),
        },
        oaId,
    });
}
