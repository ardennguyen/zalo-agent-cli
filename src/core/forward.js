/**
 * Forward a text message the way Zalo Web does: as a forward, not a copy.
 *
 * A forward is the source text plus a `reference` that names the source
 * message, and a `decorLog` that repeats it. Without them the copy arrives as
 * plain text with no "forwarded" badge, which is what `msg forward` sent until
 * this module existed.
 *
 * The reference id is derived, not looked up. The web builds it as
 *
 *     id = md5(cliMsgId + senderUid + conversationKey)
 *
 * with senderUid the source sender's numeric uid (its own uid when the web
 * holds the sender as "0") and conversationKey the web's conversation id: "g"
 * plus the group id for a group, the peer's uid for a 1-1, the send2me id for
 * My Documents. Verified offline against the 2026-09-29 capture: the captured
 * group-source forward's id is exactly that md5
 * (agent/work/zalo-web-capture-2026-09-29/comparison-vs-zca-js.md §5.16).
 *
 * `ts` is the source message's send time -- `sendDttm` in the web's message
 * model, which for any message the web did not send itself is the server
 * timestamp (`sendDttm: e.ts`). `logSrcType` classifies the source
 * conversation, and the decorLog's `st` IS that logSrcType (the web maps
 * st -> logSrcType), so it is 2 for a group source and 1 for a 1-1.
 * zca-js's forwardMessage hardcodes `st: 1`, which is right only for a 1-1
 * source; that is why the request is sent from here instead.
 *
 * Only a first-level forward is built (fwLvl 1, rootMsgRef = the source
 * itself). Forwarding something that was itself a forward makes the web carry
 * the original root and raise fwLvl; the local cache does not keep a message's
 * own reference, so that cannot be reproduced.
 */
import { createHash } from "node:crypto";
import { customCall, postWithParams } from "./zca-custom.js";

/** Zalo Web's source-conversation kinds for a forward (its `logSrcType` enum). */
export const LOG_SRC_TYPE = Object.freeze({ UNKNOWN: 0, ONE_ONE: 1, GROUP: 2, COMMUNITY: 3, OA: 4, MY_CLOUD: 5 });

/**
 * The reference and decorLog of a first-level forward.
 *
 * @param {object} source
 * @param {string} source.cliMsgId - the source message's client id
 * @param {string} source.senderUid - the source sender's numeric uid
 * @param {string} source.threadId - the source conversation's id
 * @param {boolean} source.isGroup - whether that conversation is a group
 * @param {number} source.ts - the source message's send time (server timestamp)
 * @param {number} [source.logSrcType] - overrides the group/1-1 default (My Documents is 5)
 * @returns {{reference: object, decorLog: object}}
 */
export function buildForwardReference({ cliMsgId, senderUid, threadId, isGroup, ts, logSrcType }) {
    const kind = logSrcType ?? (isGroup ? LOG_SRC_TYPE.GROUP : LOG_SRC_TYPE.ONE_ONE);
    const conversationKey = isGroup ? `g${threadId}` : String(threadId);
    const id = createHash("md5").update(`${cliMsgId}${senderUid}${conversationKey}`).digest("hex");
    // Key order is the web's, and it matters: every level is serialized to a
    // JSON string, so the order is part of the bytes Zalo receives.
    const self = { id, ts, logSrcType: kind };
    return {
        reference: { ...self, fwLvl: 1, rootMsgRef: self },
        decorLog: { fw: { pmsg: { st: kind, ts, id }, rmsg: { st: kind, ts, id }, fwLvl: 1 } },
    };
}

/**
 * Send one mforward request with `reference` and `decorLog` exactly as given.
 *
 * Same endpoint and parameter layout as zca-js's forwardMessage (and as the
 * capture): `grids[]` for groups, `toIds[]` plus `imei` for 1-1s, the message
 * info as nested JSON strings. The clientId that went on the wire is stamped
 * onto the result as `cliMsgId`, as patches/zca-js+2.2.0.patch does for
 * forwardMessage, so the caller can report the {msgId, cliMsgId} pair that
 * `msg undo` needs.
 *
 * @param {object} api - a logged-in zca-js API
 * @param {{message: string, reference: object, decorLog: object, ttl?: number}} payload
 * @param {string[]} threadIds - the targets, all of one kind
 * @param {number} type - 0 for users, 1 for groups
 * @returns {Promise<object>} Zalo's `{success, failed}` plus `cliMsgId`
 */
export async function sendForward(api, { message, reference, decorLog, ttl = 0 }, threadIds, type) {
    const isGroup = Number(type) === 1;
    const clientId = String(Date.now());
    const msgInfo = JSON.stringify({
        message,
        reference: JSON.stringify({ type: 3, data: JSON.stringify(reference) }),
    });
    const decor = JSON.stringify(decorLog);
    return customCall(api, async (ctx, utils) => {
        const params = isGroup
            ? {
                  grids: threadIds.map((grid) => ({ clientId, grid: String(grid), ttl })),
                  ttl,
                  msgType: "1",
                  totalIds: threadIds.length,
                  msgInfo,
                  decorLog: decor,
              }
            : {
                  toIds: threadIds.map((toUid) => ({ clientId, toUid: String(toUid), ttl })),
                  imei: ctx.imei,
                  ttl,
                  msgType: "1",
                  totalIds: threadIds.length,
                  msgInfo,
                  decorLog: decor,
              };
        const base = `${api.zpwServiceMap.file[0]}/api/${isGroup ? "group" : "message"}/mforward`;
        const result = await postWithParams(utils, base, params);
        if (result && typeof result === "object") result.cliMsgId = clientId;
        return result;
    });
}
