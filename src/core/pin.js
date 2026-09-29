/**
 * Pin and unpin a message the way Zalo Web does.
 *
 * zca-js has none of these endpoints, so they are custom calls on its session
 * envelope (./zca-custom.js). Each shape is the one captured from Zalo Web on
 * 2026-09-29 (agent/work/zalo-web-capture-2026-09-29/live/group.A9_pin_message,
 * group.A9b_unpin_message, dm.D9_pin_message, dm.D9b_unpin_message):
 *
 *   group pin    POST {group_board}/api/board/topic/createv2
 *   group unpin  GET  {group_board}/api/board/unpinv2
 *   1-1 pin      GET  {friend_board}/api/friendboard/create
 *   1-1 unpin    GET  {friend_board}/api/friendboard/multi_unpin
 *
 * A pinned message is a board "topic" of type 2 whose `params` name the
 * message. Unpinning takes the topic's id, not the message's, so both unpins
 * start by listing the pinned topics: `/api/board/pin/list` for a group (the
 * web's fetchTopics, which also hands back the `boardVersion` unpinv2 needs)
 * and zca-js's getFriendBoardList for a 1-1 (which returns the `version`
 * create and multi_unpin need). A stale group board version is error 183; the
 * web then refetches once and retries, and so does this.
 *
 * Only text messages: text is the kind the capture covers, and every other
 * kind carries its own params blob.
 */
import { customCall, getWithParams, postWithParams } from "./zca-custom.js";

/** A pinned message's board topic type (the web's MSG_TOPIC). */
export const PINNED_MESSAGE_TOPIC = 2;

/** Zalo's error for a group board version that moved on (the web's INVALID_BOARD_VERSION). */
export const INVALID_BOARD_VERSION = 183;

/** #222222 -- the web's `settings.group.topic_colors[0]` in the capture. */
const DEFAULT_TOPIC_COLOR = -14540254;

/** The emoji the web gives a pinned text message (`:pushpin:`). */
const TEXT_PIN_EMOJI = "📌";

/**
 * The `params` of a text message's pin topic, in the web's field order.
 *
 * @param {object} m
 * @param {string} m.cliMsgId
 * @param {string} m.msgId
 * @param {string} m.senderUid - the sender's numeric uid
 * @param {string} [m.senderName]
 * @param {string} m.text
 * @returns {string} the JSON string Zalo expects
 */
export function textPinParams({ cliMsgId, msgId, senderUid, senderName, text }) {
    return JSON.stringify({
        client_msg_id: String(cliMsgId),
        global_msg_id: String(msgId),
        senderUid: String(senderUid),
        senderName: senderName || "",
        title: text,
        msg_type: 1,
    });
}

/** The topic color the server config asks for, else the captured one. */
function topicColor(ctx) {
    const color = ctx?.settings?.group?.topic_colors?.[0];
    return Number.isFinite(color) ? color : DEFAULT_TOPIC_COLOR;
}

/** A topic's params as an object, whichever form the server sent. */
function topicParams(topic) {
    const p = topic?.params;
    if (p && typeof p === "object") return p;
    try {
        return JSON.parse(p || "{}") || {};
    } catch {
        return {};
    }
}

/**
 * The pinned-message topic that pins `msgId`, from a board listing.
 *
 * @param {Array<object>|undefined} topics
 * @param {string} msgId
 * @returns {object|null}
 */
export function findPinnedTopic(topics, msgId) {
    for (const topic of Array.isArray(topics) ? topics : []) {
        if (Number(topic?.type) !== PINNED_MESSAGE_TOPIC) continue;
        if (String(topicParams(topic).global_msg_id ?? "") === String(msgId)) return topic;
    }
    return null;
}

/**
 * Pin a text message.
 *
 * @param {object} api - a logged-in zca-js API
 * @param {object} target
 * @param {string} target.threadId
 * @param {boolean} target.isGroup
 * @param {string} target.params - from {@link textPinParams}
 * @returns {Promise<unknown>} the created topic, as Zalo returns it
 */
export async function pinMessage(api, { threadId, isGroup, params }) {
    if (isGroup) {
        return customCall(api, (ctx, utils) =>
            postWithParams(utils, `${api.zpwServiceMap.group_board[0]}/api/board/topic/createv2`, {
                grid: String(threadId),
                type: PINNED_MESSAGE_TOPIC,
                color: topicColor(ctx),
                emoji: TEXT_PIN_EMOJI,
                startTime: -1,
                duration: -1,
                params,
                repeat: 0,
                src: -1,
                imei: ctx.imei,
                pinAct: 1,
            }),
        );
    }
    const conversationId = String(threadId);
    const board = await api.getFriendBoardList(conversationId);
    return customCall(api, (ctx, utils) =>
        getWithParams(utils, `${api.zpwServiceMap.friend_board[0]}/api/friendboard/create`, {
            conversationId,
            topic: {
                color: topicColor(ctx),
                duration: -1,
                emoji: TEXT_PIN_EMOJI,
                params,
                repeat: 0,
                startTime: -1,
                type: PINNED_MESSAGE_TOPIC,
                src: -1,
                pinAct: 1,
            },
            version: Number(board?.version) || 0,
            lang: ctx.language || "vi",
            imei: ctx.imei,
        }),
    );
}

/** A group's pinned topics and the board version that goes with them. */
function listGroupPins(api, groupId) {
    return customCall(api, (ctx, utils) =>
        getWithParams(utils, `${api.zpwServiceMap.group_board[0]}/api/board/pin/list`, {
            groupId: String(groupId),
            boardVersion: 0,
            imei: ctx.imei,
        }),
    );
}

/**
 * Unpin whatever topic pins `msgId` in a group.
 *
 * @param {object} api
 * @param {string} groupId
 * @param {string} msgId
 * @param {boolean} retry - refetch and retry once on a stale board version
 * @returns {Promise<{topicId?: string, notPinned?: boolean}>}
 */
async function unpinGroupMessage(api, groupId, msgId, retry) {
    const board = await listGroupPins(api, groupId);
    const topic = findPinnedTopic(board?.items ?? board?.topics, msgId);
    if (!topic) return { notPinned: true };
    try {
        await customCall(api, (ctx, utils) =>
            getWithParams(utils, `${api.zpwServiceMap.group_board[0]}/api/board/unpinv2`, {
                grid: String(groupId),
                imei: ctx.imei,
                topic: { topicId: String(topic.id), topicType: PINNED_MESSAGE_TOPIC },
                boardVersion: board?.boardVersion ?? 0,
            }),
        );
    } catch (e) {
        if (retry && Number(e?.code) === INVALID_BOARD_VERSION) return unpinGroupMessage(api, groupId, msgId, false);
        throw e;
    }
    return { topicId: String(topic.id) };
}

/**
 * Unpin whatever topic pins `msgId` in a 1-1 conversation.
 *
 * @param {object} api
 * @param {string} conversationId - the peer's uid
 * @param {string} msgId
 * @returns {Promise<{topicId?: string, notPinned?: boolean}>}
 */
async function unpinOneToOneMessage(api, conversationId, msgId) {
    const board = await api.getFriendBoardList(conversationId);
    const topic = findPinnedTopic(board?.data, msgId);
    if (!topic) return { notPinned: true };
    await customCall(api, (ctx, utils) =>
        getWithParams(utils, `${api.zpwServiceMap.friend_board[0]}/api/friendboard/multi_unpin`, {
            conversationId,
            topics: [{ topicId: String(topic.id), topicType: PINNED_MESSAGE_TOPIC }],
            version: Number(board?.version) || 0,
            lang: ctx.language || "vi",
            imei: ctx.imei,
        }),
    );
    return { topicId: String(topic.id) };
}

/**
 * Unpin a message.
 *
 * @param {object} api - a logged-in zca-js API
 * @param {object} target
 * @param {string} target.threadId
 * @param {boolean} target.isGroup
 * @param {string} target.msgId
 * @returns {Promise<{topicId?: string, notPinned?: boolean}>} `notPinned` when no topic pins it
 */
export async function unpinMessage(api, { threadId, isGroup, msgId }) {
    return isGroup
        ? unpinGroupMessage(api, String(threadId), String(msgId), true)
        : unpinOneToOneMessage(api, String(threadId), String(msgId));
}
