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
 * (the 2026-09-29 Zalo Web capture's comparison notes, §5.16).
 *
 * `ts` is the source message's send time -- `sendDttm` in the web's message
 * model, which for any message the web did not send itself is the server
 * timestamp (`sendDttm: e.ts`). `logSrcType` classifies the source
 * conversation, and the decorLog's `st` IS that logSrcType (the web maps
 * st -> logSrcType), so it is 2 for a group source and 1 for a 1-1.
 * The previous engine's forwardMessage hardcoded `st: 1`, which is right only for a 1-1
 * source; that is why the request is sent from here instead.
 *
 * Only a first-level forward is built (fwLvl 1, rootMsgRef = the source
 * itself). Forwarding something that was itself a forward makes the web carry
 * the original root and raise fwLvl; the local cache does not keep a message's
 * own reference, so that cannot be reproduced.
 *
 * A voice or video message is not forwarded this way: it is re-sent by its
 * hosted URL (`sendVoice` / `sendVideo`). `voiceResendOptions` and
 * `videoResendOptions` read what those need out of the cached message, so a
 * video re-send does not ask the CDN for a size the cache already knows (the
 * HEAD the engine otherwise makes), and a HEAD that is still needed is bounded.
 * A voice re-send makes no HEAD at all, as Web does.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { customCall, postWithParams } from "../session-call.js";
import { HEAD_TIMEOUT_MS } from "../api/messages.js";

/** A forwarded video with no geometry in its cached params goes out as this (Zalo refuses one without any). */
export const FORWARD_VIDEO_FALLBACK = Object.freeze({ width: 1280, height: 720 });

/**
 * A cached attachment's `params`: JSON text on the wire, sometimes already an object.
 *
 * @param {object|null} content
 * @returns {object}
 */
function paramsOf(content) {
    const p = content?.params;
    if (p && typeof p === "object") return p;
    if (typeof p !== "string" || !p) return {};
    try {
        const parsed = JSON.parse(p);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * The size of a cached attachment, when something already knows it: the size its params give, else the size of the
 * copy downloaded locally. Undefined leaves the engine to ask the host.
 *
 * @param {unknown} declared
 * @param {string|null|undefined} localPath
 * @returns {number|undefined}
 */
function knownSize(declared, localPath) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > 0) return n;
    if (!localPath) return undefined;
    try {
        const size = statSync(localPath).size;
        return size > 0 ? size : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The `sendVoice` options that re-send a cached voice message: its URL and the m4a copy Zalo keeps beside it (Zalo
 * Web forwards `m4aUrl: params.m4a`). No size: Web sends none for a voice, so the engine asks the host for nothing.
 *
 * @param {object|null} content - the cached message's `content` (`{href, params}`)
 * @returns {{voiceUrl: string|undefined, m4aUrl?: string}}
 */
export function voiceResendOptions(content) {
    const p = paramsOf(content);
    return {
        voiceUrl: content?.href,
        ...(typeof p.m4a === "string" && p.m4a ? { m4aUrl: p.m4a } : {}),
    };
}

/**
 * The `sendVideo` options that re-send a cached video: URL, thumbnail, duration and geometry from its params (a
 * missing width or height falls back to {@link FORWARD_VIDEO_FALLBACK}), the size when the cache knows it, and a
 * bound on the HEAD when it does not.
 *
 * @param {object|null} content - the cached message's `content` (`{href, thumb, params}`)
 * @param {string|null} [localPath] - the downloaded copy, if any
 * @returns {{videoUrl: string|undefined, thumbnailUrl: string, duration: number, width: number, height: number,
 *   fileSize?: number, timeoutMs: number}}
 */
export function videoResendOptions(content, localPath = null) {
    const p = paramsOf(content);
    const fileSize = knownSize(p.fileSize ?? p.video_file_size, localPath);
    return {
        videoUrl: content?.href,
        thumbnailUrl: content?.thumb || "",
        duration: Number(p.duration) || 0,
        width: Number(p.video_width || p.video_original_width) || FORWARD_VIDEO_FALLBACK.width,
        height: Number(p.video_height || p.video_original_height) || FORWARD_VIDEO_FALLBACK.height,
        ...(fileSize !== undefined ? { fileSize } : {}),
        timeoutMs: HEAD_TIMEOUT_MS,
    };
}

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
 * Same endpoint and parameter layout as the previous engine's forwardMessage (and as the
 * capture): `grids[]` for groups, `toIds[]` plus `imei` for 1-1s, the message
 * info as nested JSON strings. The clientId that went on the wire is stamped
 * onto the result as `cliMsgId`, as every send of the session does, so the caller can report the {msgId, cliMsgId} pair that
 * `msg undo` needs.
 *
 * @param {object} api - a logged-in session
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
