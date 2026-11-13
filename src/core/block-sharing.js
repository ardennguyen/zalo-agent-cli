/**
 * Block sharing for one conversation (`conv block-sharing`, zalo_conversation `block_sharing`): one function, one
 * reply. It is Zalo's `/api/conv/blocksharing/updateConvers`, the `blocksharing-update` write
 * (src/zalo/writes.js), which needs a zBusiness Max account and has never been seen to succeed: unverified.
 */
import { callWrite } from "../zalo/writes.js";
import { errorCodeOf } from "../zalo/errors.js";

/** The refusals Zalo names for this call, by error code. */
export const BLOCK_SHARING_REFUSALS = Object.freeze({
    829: "this feature is for zBusiness accounts only (zBusiness Max)",
    273: "Zalo could not save the setting",
    275: "only the group's admins may change it",
    277: "this account's limit of such settings is reached",
    278: "the other side's limit of such settings is reached",
    280: "this account blocks the other side",
});

/**
 * Turn block sharing on or off for one conversation.
 *
 * @param {object} api - logged-in session
 * @param {{threadId: string, type: 0|1, enabled: boolean}} opts
 * @returns {Promise<{success: true, threadId: string, threadType: "dm"|"group", blockSharing: boolean,
 *   verified: false}>}
 * @throws {Error} Zalo's refusal, named when its code is known
 */
export async function setBlockSharing(api, { threadId, type, enabled }) {
    const isGroup = Number(type) === 1;
    try {
        await callWrite(api, "blocksharing-update", { threadId: String(threadId), isGroup, enabled: Boolean(enabled) });
    } catch (e) {
        const why = BLOCK_SHARING_REFUSALS[errorCodeOf(e)];
        throw new Error(why ? `${e.message} (${why})` : e.message, { cause: e });
    }
    return {
        success: true,
        threadId: String(threadId),
        threadType: isGroup ? "group" : "dm",
        blockSharing: Boolean(enabled),
        verified: false,
    };
}
