/**
 * A pending group invitation's details (`group invite-info`).
 *
 * zca-js's `getGroupInviteBoxInfo` reads `data.groupInfo.topic.params` without
 * checking that the group has a topic. Most groups have no pinned message, so
 * for them Zalo's answer carries no `topic` and zca-js throws "Cannot read
 * properties of undefined (reading 'params')" after Zalo had answered fine.
 * This makes the same request (GET {group}/api/group/inv-box/inv-info) on
 * zca-js's own session envelope, and unpacks the topic's JSON-in-JSON params
 * only when there is a topic.
 */
import { customCall, getWithParams } from "./zca-custom.js";

/**
 * Parse a topic's `params`, which Zalo sends as a JSON string whose `extra`
 * field is itself a JSON string. Anything that does not parse is left as it came.
 *
 * @param {object} topic
 * @returns {object} the same topic, with `params` unpacked when it could be
 */
export function unpackTopic(topic) {
    if (!topic || typeof topic.params !== "string") return topic;
    try {
        const params = JSON.parse(topic.params);
        if (typeof params?.extra === "string") {
            try {
                params.extra = JSON.parse(params.extra);
            } catch {
                /* keep the string */
            }
        }
        return { ...topic, params };
    } catch {
        return topic;
    }
}

/**
 * @param {object} api - logged-in zca-js api
 * @param {{groupId: string, mpage?: number, mcount?: number}} payload
 * @returns {Promise<object>} Zalo's `data`: groupInfo, inviterInfo, grCreatorInfo, expiredTs, type
 */
export async function getInviteBoxInfo(api, { groupId, mpage = 1, mcount = 10 }) {
    return customCall(api, async (_ctx, utils) => {
        const data = await getWithParams(utils, `${api.zpwServiceMap.group[0]}/api/group/inv-box/inv-info`, {
            grId: groupId,
            mcount,
            mpage,
        });
        if (data?.groupInfo?.topic) data.groupInfo.topic = unpackTopic(data.groupInfo.topic);
        return data;
    });
}
