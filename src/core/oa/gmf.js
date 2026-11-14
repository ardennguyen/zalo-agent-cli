/**
 * OA GMF group chats (Zalo's OA docs "Nhóm chat GMF"): create and manage the OA's group chats, read their
 * messages, send to them, and check the GMF quota.
 *
 * Every endpoint is `https://openapi.zalo.me/v3.0/oa/…`; reads are GETs with plain query params (`group_id`,
 * `offset`, `count`), writes are POSTs with a JSON body. GMF needs a verified OA on the Advanced or Premium
 * package, and an app granted group management.
 *
 * Nothing here prints: callers report through src/utils/output.js.
 */

import { OPENAPI_V3, OAError, oaRequest } from "./transport.js";

const GROUP = `${OPENAPI_V3}/oa/group`;

/** The endpoints, as the docs name them. */
export const GMF_URLS = Object.freeze({
    message: `${GROUP}/message`,
    create: `${GROUP}/creategroupwithoa`,
    get: `${GROUP}/getgroup`,
    updateInfo: `${GROUP}/updateinfo`,
    updateAsset: `${GROUP}/updateasset`,
    invite: `${GROUP}/invite`,
    listPending: `${GROUP}/listpendinginvite`,
    acceptPending: `${GROUP}/acceptpendinginvite`,
    rejectPending: `${GROUP}/rejectpendinginvite`,
    listMembers: `${GROUP}/listmember`,
    addAdmins: `${GROUP}/addadmins`,
    removeAdmins: `${GROUP}/removeadmins`,
    removeMembers: `${GROUP}/removemembers`,
    delete: `${GROUP}/delete`,
    listGroups: `${GROUP}/getgroupsofoa`,
    recentChat: `${GROUP}/listrecentchat`,
    conversation: `${GROUP}/conversation`,
    quota: `${OPENAPI_V3}/oa/quota/group`,
});

/** "Tạo nhóm mới": `member_user_ids` must not be empty and holds at most 99 users. */
export const MAX_CREATE_MEMBERS = 99;
/** "Gửi tin nhắn nhóm dạng Hình ảnh": the caption (`text`) is at most 2,000 characters. */
export const MAX_IMAGE_CAPTION = 2000;
/** The GMF products (`product_type` / `asset_type`). */
export const GMF_PRODUCT_TYPES = Object.freeze(["gmf10", "gmf50", "gmf100"]);
/** `quota_owner` of "Kiểm tra hạn mức nhóm". */
export const QUOTA_OWNERS = Object.freeze(["OA", "APP"]);
/** `quota_type` of "Kiểm tra hạn mức nhóm". */
export const QUOTA_TYPES = Object.freeze(["sub_quota", "purchase_quota", "reward_quota"]);
/** The list endpoints' documented defaults (`offset` 0, `count` 5). */
export const DEFAULT_PAGE = Object.freeze({ offset: 0, count: 5 });

function invalid(message) {
    return new OAError(message, { code: "invalid_input" });
}

function requireId(value, what) {
    const s = value === undefined || value === null ? "" : String(value).trim();
    if (!s) throw invalid(`${what} is required`);
    return s;
}

/**
 * A list of user ids from arrays and/or comma- or space-separated strings, trimmed, empty entries and
 * duplicates dropped (order kept).
 *
 * @param {string|string[]|undefined} input
 * @returns {string[]}
 */
export function parseIdList(input) {
    const parts = [input]
        .flat(Infinity)
        .filter((v) => v !== undefined && v !== null)
        .flatMap((v) => String(v).split(/[\s,]+/))
        .map((s) => s.trim())
        .filter(Boolean);
    return [...new Set(parts)];
}

function requireIds(input, what) {
    const ids = parseIdList(input);
    if (!ids.length) throw invalid(`${what}: at least one user id is required`);
    return ids;
}

function pageQuery({ offset, count } = {}) {
    const off = offset === undefined ? DEFAULT_PAGE.offset : Number(offset);
    const cnt = count === undefined ? DEFAULT_PAGE.count : Number(count);
    if (!Number.isInteger(off) || off < 0) throw invalid(`offset must be a whole number >= 0 (got ${offset})`);
    if (!Number.isInteger(cnt) || cnt < 1) throw invalid(`count must be a whole number >= 1 (got ${count})`);
    return { offset: off, count: cnt };
}

// ─── Groups ──────────────────────────────────────────────────────────

/**
 * Create a group chat with the OA ("Tạo nhóm mới", `POST v3.0/oa/group/creategroupwithoa`).
 *
 * @param {object} spec
 * @param {string} spec.name - `group_name`
 * @param {string} [spec.description] - `group_description`
 * @param {string} spec.assetId - `asset_id`, an available GMF asset from {@link getGroupQuota}
 * @param {string|string[]} spec.memberUserIds - `member_user_ids`: 1–99 users, at least one an admin of the OA
 * @param {string} [oaId]
 * @returns {Promise<object>} Zalo's reply (`data.group_id`, `group_link`, `status`, …)
 */
export async function createGroup({ name, description, assetId, memberUserIds }, oaId = "default") {
    const groupName = requireId(name, "group name");
    const asset = requireId(assetId, "asset id (see `oa group quota`)");
    const members = requireIds(memberUserIds, "members");
    if (members.length > MAX_CREATE_MEMBERS) {
        throw invalid(`a new group takes at most ${MAX_CREATE_MEMBERS} members (got ${members.length})`);
    }
    const body = { group_name: groupName };
    if (description !== undefined && description !== null) body.group_description = String(description);
    body.asset_id = asset;
    body.member_user_ids = members;
    return oaRequest({ method: "POST", url: GMF_URLS.create, body, oaId });
}

/**
 * A group's info, service package and settings ("Lấy thông tin nhóm", `GET v3.0/oa/group/getgroup`).
 *
 * @param {string} groupId
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.group_info`, `data.asset_info`, `data.group_setting`
 */
export async function getGroup(groupId, oaId = "default") {
    return oaRequest({ url: GMF_URLS.get, query: { group_id: requireId(groupId, "group id") }, oaId });
}

/** updateinfo's optional fields: our name → Zalo's. */
const UPDATE_FIELDS = Object.freeze({
    name: "group_name",
    avatar: "group_avatar",
    description: "group_description",
    lockSendMsg: "lock_send_msg",
    joinAppr: "join_appr",
    enableMsgHistory: "enable_msg_history",
    enableLinkJoin: "enable_link_join",
});
const BOOLEAN_FIELDS = new Set(["lockSendMsg", "joinAppr", "enableMsgHistory", "enableLinkJoin"]);

/**
 * Update a group's name, avatar, description or settings ("Cập nhật nhóm", `POST v3.0/oa/group/updateinfo`).
 * Only the fields given are sent; at least one is required.
 *
 * @param {string} groupId
 * @param {{ name?: string, avatar?: string, description?: string, lockSendMsg?: boolean, joinAppr?: boolean,
 *   enableMsgHistory?: boolean, enableLinkJoin?: boolean }} changes - `avatar` is an image URL
 * @param {string} [oaId]
 * @returns {Promise<object>} the group as {@link getGroup} returns it
 */
export async function updateGroup(groupId, changes = {}, oaId = "default") {
    const body = { group_id: requireId(groupId, "group id") };
    for (const [ours, theirs] of Object.entries(UPDATE_FIELDS)) {
        const v = changes[ours];
        if (v === undefined || v === null) continue;
        if (BOOLEAN_FIELDS.has(ours)) {
            if (typeof v !== "boolean") throw invalid(`${theirs} must be true or false`);
            body[theirs] = v;
        } else {
            body[theirs] = String(v);
        }
    }
    if (Object.keys(body).length === 1) throw invalid("nothing to update: give at least one field");
    return oaRequest({ method: "POST", url: GMF_URLS.updateInfo, body, oaId });
}

/**
 * Attach a GMF asset to a group, to renew it or raise its member limit ("Cập nhật dịch vụ cho Nhóm chat",
 * `POST v3.0/oa/group/updateasset`).
 *
 * @param {string} groupId
 * @param {string} assetId - from {@link getGroupQuota}
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function updateGroupAsset(groupId, assetId, oaId = "default") {
    const body = { group_id: requireId(groupId, "group id"), asset_id: requireId(assetId, "asset id") };
    return oaRequest({ method: "POST", url: GMF_URLS.updateAsset, body, oaId });
}

/**
 * Dissolve a group for every member ("OA Giải tán nhóm", `POST v3.0/oa/group/delete`).
 *
 * @param {string} groupId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function deleteGroup(groupId, oaId = "default") {
    return oaRequest({
        method: "POST",
        url: GMF_URLS.delete,
        body: { group_id: requireId(groupId, "group id") },
        oaId,
    });
}

/**
 * The groups the OA manages ("Lấy danh sách nhóm OA đang quản lý", `GET v3.0/oa/group/getgroupsofoa`).
 *
 * @param {{ offset?: number, count?: number }} [page] - default offset 0, count 5 (the docs' defaults)
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.groups`, `data.total`, …
 */
export async function listGroups(page = {}, oaId = "default") {
    return oaRequest({ url: GMF_URLS.listGroups, query: pageQuery(page), oaId });
}

/**
 * The OA's GMF assets ("Kiểm tra hạn mức nhóm", `POST v3.0/oa/quota/group`): each `asset_id` with its product,
 * source, expiry and whether it is still `available` for a new group.
 *
 * @param {{ quotaOwner?: string, productType?: string, quotaType?: string }} [filter] - `quota_owner` (OA|APP,
 *   default OA), `product_type` (gmf10|gmf50|gmf100), `quota_type` (sub_quota|purchase_quota|reward_quota)
 * @param {string} [oaId]
 * @returns {Promise<object>} `data` is an array of assets
 */
export async function getGroupQuota({ quotaOwner = "OA", productType, quotaType } = {}, oaId = "default") {
    if (!QUOTA_OWNERS.includes(quotaOwner)) throw invalid(`quota owner must be one of ${QUOTA_OWNERS.join(", ")}`);
    const body = { quota_owner: quotaOwner };
    if (productType !== undefined) {
        if (!GMF_PRODUCT_TYPES.includes(productType)) {
            throw invalid(`product type must be one of ${GMF_PRODUCT_TYPES.join(", ")}`);
        }
        body.product_type = productType;
    }
    if (quotaType !== undefined) {
        if (!QUOTA_TYPES.includes(quotaType)) throw invalid(`quota type must be one of ${QUOTA_TYPES.join(", ")}`);
        body.quota_type = quotaType;
    }
    return oaRequest({ method: "POST", url: GMF_URLS.quota, body, oaId });
}

// ─── Members ─────────────────────────────────────────────────────────

async function memberAction(url, groupId, userIds, oaId, what) {
    const body = { group_id: requireId(groupId, "group id"), member_user_ids: requireIds(userIds, what) };
    return oaRequest({ method: "POST", url, body, oaId });
}

/**
 * Invite users to a group ("Mời tham gia nhóm", `POST v3.0/oa/group/invite`). Each must follow the OA or have
 * interacted with it in the past 7 days.
 *
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function inviteMembers(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.invite, groupId, userIds, oaId, "invite");
}

/**
 * Users waiting for approval to join ("Lấy danh sách thành viên chờ duyệt", `GET v3.0/oa/group/listpendinginvite`).
 *
 * @param {string} groupId
 * @param {{ offset?: number, count?: number }} [page] - default offset 0, count 5
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.members` (`user_id`, `name`), `data.total`
 */
export async function listPendingMembers(groupId, page = {}, oaId = "default") {
    const query = { group_id: requireId(groupId, "group id"), ...pageQuery(page) };
    return oaRequest({ url: GMF_URLS.listPending, query, oaId });
}

/**
 * Approve pending users ("Đồng ý duyệt thành viên mới vào nhóm", `POST v3.0/oa/group/acceptpendinginvite`).
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function acceptPendingMembers(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.acceptPending, groupId, userIds, oaId, "accept");
}

/**
 * Refuse pending users ("Từ chối duyệt thành viên mới vào nhóm", `POST v3.0/oa/group/rejectpendinginvite`).
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function rejectPendingMembers(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.rejectPending, groupId, userIds, oaId, "reject");
}

/**
 * A group's members ("Lấy danh sách thành viên nhóm", `GET v3.0/oa/group/listmember`). The OA itself is listed
 * with `oa_id` instead of `user_id`.
 *
 * @param {string} groupId
 * @param {{ offset?: number, count?: number }} [page] - default offset 0, count 5
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.members`, `data.total`
 */
export async function listMembers(groupId, page = {}, oaId = "default") {
    const query = { group_id: requireId(groupId, "group id"), ...pageQuery(page) };
    return oaRequest({ url: GMF_URLS.listMembers, query, oaId });
}

/**
 * Make members deputy admins ("Thêm phó nhóm", `POST v3.0/oa/group/addadmins`).
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function addAdmins(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.addAdmins, groupId, userIds, oaId, "add-admins");
}

/**
 * Take deputy admin from members ("Xóa phó nhóm", `POST v3.0/oa/group/removeadmins`).
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function removeAdmins(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.removeAdmins, groupId, userIds, oaId, "remove-admins");
}

/**
 * Remove members from a group ("Xóa thành viên khỏi nhóm", `POST v3.0/oa/group/removemembers`).
 * @param {string} groupId
 * @param {string|string[]} userIds
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function removeMembers(groupId, userIds, oaId = "default") {
    return memberAction(GMF_URLS.removeMembers, groupId, userIds, oaId, "remove-members");
}

/**
 * Every page of a paged GMF list, concatenated. `data.total` decides when to stop (a page shorter than asked
 * does not, since the docs give no maximum `count` and Zalo may cap it); without a total, a short page ends it.
 *
 * @param {(page: {offset: number, count: number}) => Promise<object>} fetchPage
 * @param {string} key - the list's field in `data` (`members`, `groups`)
 * @param {{ offset?: number, count?: number, maxPages?: number }} [opts] - count per page (default 5, the docs'
 *   default)
 * @returns {Promise<object>} the last reply with `data[key]` holding every item and `data.count` its length
 */
export async function walkPages(fetchPage, key, { offset = 0, count = DEFAULT_PAGE.count, maxPages = 1000 } = {}) {
    const all = [];
    let off = Number(offset);
    let last;
    for (let i = 0; i < maxPages; i++) {
        last = await fetchPage({ offset: off, count });
        const items = Array.isArray(last?.data?.[key]) ? last.data[key] : [];
        all.push(...items);
        off += items.length;
        const total = Number(last?.data?.total);
        if (!items.length) break;
        if (Number.isFinite(total) ? off >= total : items.length < count) break;
    }
    return { ...last, data: { ...last?.data, offset: Number(offset), count: all.length, [key]: all } };
}

// ─── Messages ────────────────────────────────────────────────────────

/**
 * The OA's most recent group messages, across groups ("Lấy danh sách tin nhắn nhóm gần nhất",
 * `GET v3.0/oa/group/listrecentchat`).
 *
 * @param {{ offset?: number, count?: number }} [page] - default offset 0, count 5
 * @param {string} [oaId]
 * @returns {Promise<object>} `data` is an array of messages (`src` 0 = OA, 1 = user)
 */
export async function listRecentChats(page = {}, oaId = "default") {
    return oaRequest({ url: GMF_URLS.recentChat, query: pageQuery(page), oaId });
}

/**
 * One group's messages ("Lấy thông tin tin nhắn trong một nhóm", `GET v3.0/oa/group/conversation`).
 *
 * @param {string} groupId
 * @param {{ offset?: number, count?: number }} [page] - default offset 0, count 5
 * @param {string} [oaId]
 * @returns {Promise<object>} `data` is an array of messages, newest first
 */
export async function getGroupConversation(groupId, page = {}, oaId = "default") {
    const query = { group_id: requireId(groupId, "group id"), ...pageQuery(page) };
    return oaRequest({ url: GMF_URLS.conversation, query, oaId });
}

/**
 * Text with mention tags ("Gửi tin nhắn Mention tới nhóm"): `[@user_id]` mentions a member, `[@group_id]` the
 * whole group. Each id not already tagged in `text` is put in front of it, in order.
 *
 * @param {string} text
 * @param {string[]} [userIds]
 * @param {string} [allGroupId] - mention the whole group with this group id
 * @returns {string}
 */
export function mentionText(text, userIds = [], allGroupId) {
    const body = text === undefined || text === null ? "" : String(text);
    const ids = [...(allGroupId ? [allGroupId] : []), ...parseIdList(userIds)];
    const tags = [...new Set(ids)].filter((id) => !body.includes(`[@${id}]`)).map((id) => `[@${id}]`);
    return [...tags, body].filter(Boolean).join(" ");
}

/**
 * The `message` object for one group message, as the GMF message pages give it.
 *
 * - `text`: `{ text }` (also the mention form: put `[@user_id]` tags in the text, see {@link mentionText});
 * - `image`: a media template with one `image` (or `gif`, which needs width and height) element by `url` or
 *   `attachment_id` (one of the two), and `text`, its caption (required, at most 2,000 characters);
 * - `file`: `{ attachment: { type: "file", payload: { token } } }` (the token of an OA file upload);
 * - `sticker`: a media template with one `sticker` element by `attachment_id`.
 *
 * @param {"text"|"image"|"file"|"sticker"} kind
 * @param {{ text?: string, url?: string, attachmentId?: string, gif?: boolean, width?: number, height?: number,
 *   token?: string, stickerId?: string }} spec
 * @returns {object}
 */
export function buildGroupMessage(kind, spec = {}) {
    const media = (element) => ({
        attachment: { type: "template", payload: { template_type: "media", elements: [element] } },
    });
    switch (kind) {
        case "text": {
            const text = spec.text === undefined || spec.text === null ? "" : String(spec.text);
            if (!text.trim()) throw invalid("the message text is empty");
            return { text };
        }
        case "image": {
            const text = spec.text === undefined || spec.text === null ? "" : String(spec.text);
            if (!text.trim()) throw invalid("an image message needs a caption (the docs require `text`)");
            if (text.length > MAX_IMAGE_CAPTION) {
                throw invalid(`the caption is ${text.length} characters; the limit is ${MAX_IMAGE_CAPTION}`);
            }
            if (Boolean(spec.url) === Boolean(spec.attachmentId)) {
                throw invalid("give exactly one of an image URL or an attachment id");
            }
            const element = { media_type: spec.gif ? "gif" : "image" };
            if (spec.attachmentId) element.attachment_id = String(spec.attachmentId);
            else element.url = String(spec.url);
            if (spec.gif) {
                const w = Number(spec.width);
                const h = Number(spec.height);
                if (!Number.isInteger(w) || w < 1 || !Number.isInteger(h) || h < 1) {
                    throw invalid("a GIF needs its width and height (whole numbers of pixels)");
                }
                element.width = w;
                element.height = h;
            }
            return { text, ...media(element) };
        }
        case "file": {
            const token = requireId(spec.token, "file token (from an OA file upload)");
            return { attachment: { type: "file", payload: { token } } };
        }
        case "sticker": {
            const id = requireId(spec.stickerId, "sticker id");
            return media({ media_type: "sticker", attachment_id: id });
        }
        default:
            throw invalid(`unknown group message kind "${kind}"`);
    }
}

/**
 * Send one message to a group (`POST v3.0/oa/group/message`, the GMF message pages).
 *
 * @param {string} groupId
 * @param {object} message - from {@link buildGroupMessage}
 * @param {string} [oaId]
 * @returns {Promise<object>} `data.message_id`, `data.group_id`
 */
export async function sendGroupMessage(groupId, message, oaId = "default") {
    const body = { recipient: { group_id: requireId(groupId, "group id") }, message };
    return oaRequest({ method: "POST", url: GMF_URLS.message, body, oaId });
}

/**
 * Send a text message to a group ("Gửi tin nhắn nhóm dạng Text").
 * @param {string} groupId
 * @param {string} text
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendGroupText(groupId, text, oaId = "default") {
    return sendGroupMessage(groupId, buildGroupMessage("text", { text }), oaId);
}

/**
 * Send a text message that mentions members or the whole group ("Gửi tin nhắn Mention tới nhóm").
 * @param {string} groupId
 * @param {string} text
 * @param {{ userIds?: string[], all?: boolean }} mentions
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendGroupMention(groupId, text, { userIds = [], all = false } = {}, oaId = "default") {
    const gid = requireId(groupId, "group id");
    if (!all && !parseIdList(userIds).length && !/\[@[^\]]+\]/.test(String(text ?? ""))) {
        throw invalid("a mention needs at least one user id, the whole group, or a [@user_id] tag in the text");
    }
    return sendGroupText(gid, mentionText(text, userIds, all ? gid : undefined), oaId);
}

/**
 * Send an image or GIF to a group ("Gửi tin nhắn nhóm dạng Hình ảnh").
 * @param {string} groupId
 * @param {{ text: string, url?: string, attachmentId?: string, gif?: boolean, width?: number, height?: number }} image
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendGroupImage(groupId, image, oaId = "default") {
    return sendGroupMessage(groupId, buildGroupMessage("image", image), oaId);
}

/**
 * Send a file to a group by its upload token ("Gửi tin nhắn nhóm dạng File").
 * @param {string} groupId
 * @param {string} token
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendGroupFile(groupId, token, oaId = "default") {
    return sendGroupMessage(groupId, buildGroupMessage("file", { token }), oaId);
}

/**
 * Send a sticker to a group ("Gửi tin nhắn nhóm dạng Sticker").
 * @param {string} groupId
 * @param {string} stickerId
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function sendGroupSticker(groupId, stickerId, oaId = "default") {
    return sendGroupMessage(groupId, buildGroupMessage("sticker", { stickerId }), oaId);
}
