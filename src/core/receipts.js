/**
 * Seen and delivered receipts, sent the way Zalo Web sends them.
 *
 * Both are plain HTTP calls carrying the same per-message record:
 *
 *   seenv2       {group}/api/group/seenv2?nretry=0   {msgInfos: '{"data":[…],"grid":…}', imei}
 *                {chat}/api/message/seenv2?nretry=0  {msgInfos: '{"data":[…],"senderId":…}', imei}
 *   deliveredv2  {group}/api/group/deliveredv2       {msgInfos: '{"seen":0,"data":[…],"grid":…}', imei}
 *                {chat}/api/message/deliveredv2      {msgInfos: '{"seen":0,"data":[…]}'}   (no imei)
 *
 *   data[i] = {cmi, gmi, si, di, mt, st, at, cmd, ts}
 *
 * That is what a capture of the real client (build 826674fb31d2af1b2b59,
 * zpw_ver 691) shows, and what its own builders (`sendSeen` / `sendDelivered`
 * in the web API bundle) produce: `si`/`di` are the raw frame's uidFrom/idTo --
 * "0" meaning this account -- and `st`, `at`, `cmd`, `ts` are echoed from the
 * socket frame that delivered the message, -1 where a field is missing.
 *
 * zca-js ships a builder for each receipt and neither can produce that:
 *
 *   - `sendSeenEvent.js:43-46` / `sendDeliveredEvent.js:38-41` compute
 *     `st: msg.st || 0 === msg.st ? 0 : -1`, which parses as
 *     `(msg.st || (0 === msg.st)) ? 0 : -1`: always 0 or -1, never the value.
 *     The same holds for at, cmd and ts.
 *   - A DM seen goes out without `imei`, which the web always sends.
 *   - zca-js rewrites an own message's uidFrom "0" (and a DM's idTo "0") to the
 *     account uid before any handler sees it, so passing its message through
 *     sends our uid where the web sends "0".
 *
 * Hence this module: the requests are built here, on zca-js's own apiFactory,
 * the pattern src/core/sync-v2/board.js uses for calls zca-js lacks.
 *
 * Read receipts are kept OFF on purpose, so nothing here sends seenv2 on its
 * own: `conv read` is the only caller. The listener's automatic receipt is
 * deliveredv2 only -- what every Zalo client sends when a message arrives.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LIVE_MSG_TYPES } from "./sync-v2/message-types.js";

const require = createRequire(import.meta.url);

/** zca-js ThreadType. */
const THREAD_USER = 0;
const THREAD_GROUP = 1;

/** The socket command a message arrives on, which its receipt echoes as `cmd`. */
export const RECEIPT_CMD = Object.freeze({ [THREAD_USER]: 501, [THREAD_GROUP]: 521 });

/** Zalo's per-call cap, shared by both receipts (zca-js MAX_MESSAGES_PER_SEND, the web's slice(-50)). */
export const MAX_RECEIPTS_PER_CALL = 50;

/**
 * `st`/`at` for a cached message the listener stored before it kept them.
 *
 * A GUESS, labelled as one wherever it is used. `st` was 3 on every captured
 * ordinary message (5 only on pin/unpin system rows); `at` varies -- 5 for
 * plain text, 0 for a card, 9 elsewhere -- and 5 is the plain-text value. The
 * web's own builder sends -1 for a field it lacks; if Zalo misbehaves with
 * this guess, -1 is the web-faithful alternative. To verify live.
 */
export const SEEN_FALLBACK = Object.freeze({ st: 3, at: 5 });

/** The web's delivered-queue delay (`ack_seen.queue_delay || 150`). */
export const DELIVERED_QUEUE_DELAY_MS = 150;

/**
 * Live msgTypes that must never be acknowledged. Zalo Web's message reducer
 * routes these to their own handlers and never into the delivered batch.
 */
const NO_RECEIPT_TYPES = new Set(["chat.delete", "chat.undo", "chat.e2ee.replace"]);

let _utils = null;
/** zca-js internals, located the way ./sync-v2/board.js and ./sync-v2/gid.js do it. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * POST `params=<session-AES(JSON)>` to a Zalo endpoint and resolve its answer.
 *
 * The shared transport for calls zca-js lacks or builds wrong: the receipts
 * here, and `conv pin` / `conv archive`. It runs on zca-js's own apiFactory, so
 * the session key, headers, cookies, proxy and `zpw_ver`/`zpw_type` are exactly
 * the ones every zca-js call uses, and an `error_code` other than 0 throws.
 *
 * @param {object} api - a logged-in zca-js api (exposes getContext and zpwServiceMap)
 * @param {object} opts
 * @param {string} opts.url - endpoint without query
 * @param {object} [opts.query] - extra query parameters (e.g. `{nretry: 0}`)
 * @param {(ctx: object) => object} opts.params - builds the plaintext params; gets the context for `imei`
 * @param {AbortSignal} [opts.signal] - abort the request
 * @returns {Promise<any>} the decrypted response `data`
 */
export async function zaloPost(api, { url, query = {}, params, signal }) {
    const call = zcaUtils().apiFactory()((_api, ctx, utils) => async () => {
        const enc = utils.encodeAES(JSON.stringify(params(ctx)));
        if (!enc) throw new Error("Failed to encrypt params");
        const response = await utils.request(utils.makeURL(url, query), {
            method: "POST",
            body: new URLSearchParams({ params: enc }),
            ...(signal ? { signal } : {}),
        });
        return utils.resolve(response);
    })(api.getContext(), api);
    return call();
}

/** A numeric frame field as the web sends it: the value, or -1 when absent. */
function frameInt(v) {
    if (v === undefined || v === null || v === "") return -1;
    const n = Number(v);
    return Number.isFinite(n) ? n : -1;
}

/** A usable message id: present, non-empty and not the "0" Zalo uses for "none". */
function isId(v) {
    if (v === undefined || v === null) return false;
    const s = String(v);
    return s !== "" && s !== "0";
}

/**
 * One `msgInfos.data` entry, in the web's key order.
 *
 * @param {object} m
 * @param {string|number} m.msgId - global message id (`gmi`)
 * @param {string|number} m.cliMsgId - client message id (`cmi`)
 * @param {string} m.uidFrom - the RAW sender: "0" for this account
 * @param {string} m.idTo - the RAW recipient: the group id, a DM peer, or "0" for this account
 * @param {string} m.msgType - the live msgType string ("webchat", "chat.photo", …)
 * @param {number} [m.st]
 * @param {number} [m.at]
 * @param {number} [m.cmd]
 * @param {string|number} [m.ts] - message timestamp in ms; sent as a string
 * @returns {object}
 */
export function receiptEntry(m) {
    return {
        cmi: String(m.cliMsgId),
        gmi: String(m.msgId),
        si: String(m.uidFrom),
        di: String(m.idTo),
        mt: m.msgType,
        st: frameInt(m.st),
        at: frameInt(m.at),
        cmd: frameInt(m.cmd),
        ts: m.ts === undefined || m.ts === null || m.ts === "" ? -1 : String(m.ts),
    };
}

/** Validate a receipt batch and build its entries. */
function entriesOf(messages) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_RECEIPTS_PER_CALL) {
        throw new Error(`A receipt names between 1 and ${MAX_RECEIPTS_PER_CALL} messages.`);
    }
    for (const m of messages) {
        if (!isId(m?.msgId) || !isId(m?.cliMsgId))
            throw new Error("Every message in a receipt needs a msgId and a cliMsgId.");
    }
    return messages.map(receiptEntry);
}

/** Validate a thread id and type, returning `[threadId, isGroup]`. */
function threadOf(threadId, type) {
    if (!isId(threadId)) throw new Error("A receipt needs the conversation's thread id.");
    const t = Number(type);
    if (t !== THREAD_USER && t !== THREAD_GROUP)
        throw new Error(`Unknown thread type ${type}: use 0 (user) or 1 (group).`);
    return [String(threadId), t === THREAD_GROUP];
}

/**
 * Send seenv2 for up to 50 messages of one conversation.
 *
 * Group: `{"data":[…],"grid":<id>}`; DM: `{"data":[…],"senderId":<peer>}`.
 * Both carry `imei` and go out with `nretry=0`, as captured.
 *
 * @param {object} api - logged-in zca-js api
 * @param {object} opts
 * @param {string} opts.threadId - group id, or the DM peer's uid
 * @param {0|1} opts.type - 0 user, 1 group
 * @param {object[]} opts.messages - see {@link receiptEntry}
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>} Zalo's answer (`{status: 0}` when accepted)
 */
export async function sendSeenReceipt(api, { threadId, type, messages, signal } = {}) {
    const [id, isGroup] = threadOf(threadId, type);
    const data = entriesOf(messages);
    const msgInfos = isGroup ? { data, grid: id } : { data, senderId: id };
    return zaloPost(api, {
        url: isGroup
            ? `${api.zpwServiceMap.group[0]}/api/group/seenv2`
            : `${api.zpwServiceMap.chat[0]}/api/message/seenv2`,
        query: { nretry: 0 },
        params: (ctx) => ({ msgInfos: JSON.stringify(msgInfos), imei: ctx.imei }),
        signal,
    });
}

/**
 * Send deliveredv2 for up to 50 messages of one conversation.
 *
 * Group: `{"seen":0,"data":[…],"grid":<id>}` plus `imei`; DM: `{"seen":0,"data":[…]}`
 * and no `imei` at all -- the web's DM sender adds none. No `nretry`.
 *
 * @param {object} api - logged-in zca-js api
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {0|1} opts.type
 * @param {object[]} opts.messages - see {@link receiptEntry}
 * @param {boolean} [opts.seen] - the web's `seen` flag; always false from the listener
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>}
 */
export async function sendDeliveredReceipt(api, { threadId, type, messages, seen = false, signal } = {}) {
    const [id, isGroup] = threadOf(threadId, type);
    const data = entriesOf(messages);
    const head = { seen: seen ? 1 : 0, data };
    const msgInfos = isGroup ? { ...head, grid: id } : head;
    return zaloPost(api, {
        url: isGroup
            ? `${api.zpwServiceMap.group[0]}/api/group/deliveredv2`
            : `${api.zpwServiceMap.chat[0]}/api/message/deliveredv2`,
        params: (ctx) =>
            isGroup ? { msgInfos: JSON.stringify(msgInfos), imei: ctx.imei } : { msgInfos: JSON.stringify(msgInfos) },
        signal,
    });
}

/**
 * What a receipt for one live zca-js message event names.
 *
 * zca-js has already rewritten the frame's "0" sender (and a DM's "0"
 * recipient) to our uid by the time a handler sees it, so the raw values the
 * web echoes are rebuilt from `isSelf`: our own message is `si:"0"`; in a DM
 * the side that is us is "0" (`di:"0"` for an incoming DM, `di:<peer>` for our
 * own); in a group `di` is always the group.
 *
 * @param {object} msg - zca-js `message` event ({threadId, type, isSelf, data})
 * @returns {{threadId: string, type: 0|1, message: object}|null} null when the
 *   message must not be acknowledged (a removal frame) or cannot be named
 */
export function liveReceiptTarget(msg) {
    const d = msg?.data;
    if (!d || typeof d !== "object") return null;
    if (NO_RECEIPT_TYPES.has(d.msgType)) return null;
    if (!isId(d.msgId) || !isId(d.cliMsgId)) return null;
    if (!isId(msg.threadId)) return null;
    const threadId = String(msg.threadId);
    const type = msg.type === THREAD_GROUP ? THREAD_GROUP : THREAD_USER;
    const self = Boolean(msg.isSelf);
    if (!self && !isId(d.uidFrom)) return null;
    return {
        threadId,
        type,
        message: {
            msgId: d.msgId,
            cliMsgId: d.cliMsgId,
            msgType: d.msgType,
            uidFrom: self ? "0" : String(d.uidFrom),
            idTo: type === THREAD_GROUP ? threadId : self ? threadId : "0",
            st: d.st,
            at: d.at,
            cmd: d.cmd,
            ts: d.ts,
        },
    };
}

// ---- conv read ---------------------------------------------------------------

/** Our type vocabulary -> the live msgType the web would name it by (first mapping wins). */
const WEB_MSG_TYPE = Object.freeze(
    Object.entries(LIVE_MSG_TYPES).reduce((acc, [live, ours]) => {
        if (!(ours in acc)) acc[ours] = live;
        return acc;
    }, {}),
);

/** `raw_data` as an object, whatever shape its writer used. */
function parseRaw(rawData) {
    try {
        const parsed = JSON.parse(rawData || "{}");
        if (!parsed || typeof parsed !== "object") return {};
        return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    } catch {
        return {};
    }
}

/**
 * The newest cached message a seen receipt can be anchored on.
 *
 * Zalo marks a MESSAGE seen, not a thread, and must be able to identify it: an
 * incoming message (never one of ours), with a real msgId and a cliMsgId, that
 * is not a tombstone. A system-line placeholder (`ge:` id, no cliMsgId) and a
 * recalled row are passed over rather than ending the search.
 *
 * @param {object[]} rows - `messages` rows, newest first (db.getMessages)
 * @param {{ownId: string}} opts
 * @returns {{row: object, raw: object}|null}
 */
export function pickSeenAnchor(rows, { ownId }) {
    for (const row of rows || []) {
        if (!row || String(row.senderId ?? "") === String(ownId)) continue;
        if (row.type === "deleted") continue;
        if (!/^\d+$/.test(String(row.msgId ?? ""))) continue;
        const raw = parseRaw(row.raw_data);
        if (!isId(raw.cliMsgId)) continue;
        return { row, raw };
    }
    return null;
}

/**
 * The seenv2 message for a cached row, and which of its fields are guessed.
 *
 * `st`/`at`/`cmd` come from raw_data, where the listener keeps the frame's
 * values. A row written before it did falls back: `cmd` from the thread type --
 * deterministic, it is the command the message arrived on, 501 or 521 -- and
 * `st`/`at` from {@link SEEN_FALLBACK}, which ARE guesses and are reported in
 * `guessed`.
 *
 * @param {object} row - the anchor row
 * @param {object} raw - its parsed raw_data
 * @param {{threadId: string, type: 0|1}} opts
 * @returns {{message: object, guessed: string[]}}
 */
export function seenTargetFromCachedRow(row, raw, { threadId, type }) {
    const isGroup = Number(type) === THREAD_GROUP;
    const has = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));
    const guessed = [];
    const pick = (key, fallback, isGuess = true) => {
        if (has(raw[key])) return Number(raw[key]);
        if (isGuess) guessed.push(key);
        return fallback;
    };
    return {
        message: {
            msgId: String(row.msgId),
            cliMsgId: String(raw.cliMsgId),
            uidFrom: String(row.senderId),
            // Incoming by construction: in a DM the recipient is us ("0"), in a group the group.
            idTo: isGroup ? String(threadId) : "0",
            msgType: typeof raw.msgType === "string" && raw.msgType ? raw.msgType : WEB_MSG_TYPE[row.type] || "webchat",
            st: pick("st", SEEN_FALLBACK.st),
            at: pick("at", SEEN_FALLBACK.at),
            cmd: pick("cmd", RECEIPT_CMD[isGroup ? THREAD_GROUP : THREAD_USER], false),
            ts: row.timestamp ?? raw.ts,
        },
        guessed,
    };
}

/**
 * Mark a conversation read both ways Zalo Web does.
 *
 * The web has two different "read" operations and `conv read` performs both:
 *
 *   - `conv/removeUnreadMark` clears the MANUAL unread flag -- the one
 *     `conv unread` (addUnreadMark) sets and the conversation menu's "mark as
 *     read" clears. It needs only the thread id, so it is always sent.
 *   - `seenv2` marks messages seen, which is what clears the unread count on
 *     the account's other devices. It names a message, so it needs one cached
 *     incoming message to anchor on; without one it is refused, and said so.
 *
 * Neither call can hide the other's failure: each gets its own result.
 *
 * @param {object} api - logged-in zca-js api
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {0|1} opts.type
 * @param {string} opts.ownId - this account's uid, to tell incoming from ours
 * @param {object[]} opts.rows - the thread's newest cached rows, newest first
 * @returns {Promise<{threadId: string, type: number, unreadMark: object, seen: object}>}
 */
export async function markConversationRead(api, { threadId, type, ownId, rows }) {
    const [id, isGroup] = threadOf(threadId, type);
    const t = isGroup ? THREAD_GROUP : THREAD_USER;
    const out = { threadId: id, type: t, unreadMark: null, seen: null };

    try {
        out.unreadMark = { ok: true, response: await api.removeUnreadMark(id, t) };
    } catch (e) {
        out.unreadMark = { ok: false, error: e.message };
    }

    const anchor = pickSeenAnchor(rows, { ownId });
    if (!anchor) {
        out.seen = {
            ok: false,
            refused: "no-anchor",
            error: "No incoming message for this conversation is in the local cache, so no seen receipt was sent.",
        };
        return out;
    }
    const { row, raw } = anchor;
    // transfer-sync-v2 restores rows under the protobuf's NOISED sender id. It
    // is not a uid Zalo accepts as `si`, and the row may even be one of ours:
    // our own noised id does not equal our uid, so it passed the check above.
    if (!/^\d+$/.test(String(row.senderId))) {
        out.seen = {
            ok: false,
            refused: "noised-sender",
            msgId: String(row.msgId),
            error:
                `The newest cached message not sent from this account (${row.msgId}) was restored by sync and ` +
                "carries a noised sender id, so a seen receipt built on it would name the wrong sender -- " +
                "possibly this account. No seen receipt was sent.",
        };
        return out;
    }

    const { message, guessed } = seenTargetFromCachedRow(row, raw, { threadId: id, type: t });
    const entry = receiptEntry(message);
    try {
        const response = await sendSeenReceipt(api, { threadId: id, type: t, messages: [message] });
        out.seen = { ok: true, msgId: message.msgId, guessed, entry, response };
    } catch (e) {
        out.seen = { ok: false, msgId: message.msgId, guessed, entry, error: e.message };
    }
    return out;
}

// ---- the listener's automatic delivered receipts -----------------------------

/**
 * Automatic deliveredv2 receipts for a long-running listener.
 *
 * `listen` and `mcp start` both use this, and only this, so the two entry
 * points to the socket cannot drift apart (AGENTS.md §13). Every received 501
 * or 521 message is acknowledged -- our own echoes included, as Zalo Web does
 * -- except the removal frames the web does not acknowledge either.
 *
 * Batching mirrors the web's delivered queue: messages wait `delayMs` (the
 * web's 150 ms), then go out one call at a time, one conversation per call, at
 * most 50 messages per call. A message arriving while its conversation's batch
 * is still waiting joins it. So ordinary traffic produces exactly the captured
 * one-message calls, and a burst -- a reconnect replaying a backlog, a busy
 * group -- costs one call per conversation instead of one per message, spaced
 * like the web's own.
 *
 * Best-effort by construction. A receipt must never stop the listener, delay
 * or drop the message write, or reach stdout (the JSON-RPC stream in MCP mode):
 *
 *   - `attach()` subscribes AFTER the caller's storing handler, and its handler
 *     only queues -- synchronously, inside a try/catch -- so the write has
 *     already happened and nothing can throw back into zca-js's socket loop.
 *   - Sending happens later, off the event, and every failure (rejection,
 *     network error, no session during a re-login, a hung request abandoned
 *     after `timeoutMs`) is counted and reported through `log`, rate-limited.
 *   - The queue is bounded (`maxPending`); overflow drops the oldest receipts
 *     and is counted.
 *   - The api is resolved per send through `getApi`, because a re-login
 *     replaces it.
 *
 * @param {object} opts
 * @param {() => object} opts.getApi - returns the current logged-in api
 * @param {boolean} [opts.enabled] - false: attach() subscribes nothing
 * @param {number} [opts.delayMs] - wait before each call
 * @param {number} [opts.timeoutMs] - abandon a call after this long
 * @param {number} [opts.maxPending] - most receipts held while Zalo is not answering
 * @param {(line: string) => void} [opts.log] - diagnostics; must not be stdout in MCP mode
 * @returns {{attach: Function, queue: Function, flush: Function, stop: Function, stats: Function}}
 */
export function createDeliveredReceipts({
    getApi,
    enabled = true,
    delayMs = DELIVERED_QUEUE_DELAY_MS,
    timeoutMs = 15_000,
    maxPending = 1000,
    log = (line) => console.error(line),
} = {}) {
    /** @type {{threadId: string, type: number, messages: object[]}[]} */
    const batches = [];
    let pending = 0;
    let pumping = null;
    let hurry = false;
    let wake = null;
    let stopped = false;
    const counts = { queued: 0, sent: 0, failed: 0, dropped: 0, calls: 0 };
    let announced = false;
    let lastFailureLogAt = 0;
    let quietFailures = 0;
    let droppedNoted = false;

    const say = (line) => {
        try {
            log(line);
        } catch {
            /* a broken logger must not break the listener either */
        }
    };

    /** Wait `ms` on a timer that never keeps the process alive; flush() cuts it short. */
    const pause = (ms) =>
        new Promise((resolve) => {
            if (ms <= 0) return resolve();
            const done = () => {
                wake = null;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(done, ms);
            timer.unref?.();
            wake = done;
        });

    function noteFailure(batch, e) {
        counts.failed += batch.messages.length;
        const now = Date.now();
        if (lastFailureLogAt && now - lastFailureLogAt < 60_000) {
            quietFailures++;
            return;
        }
        const extra = quietFailures ? ` (${quietFailures} more failed quietly since the last report)` : "";
        quietFailures = 0;
        lastFailureLogAt = now;
        say(`delivered receipt failed for ${batch.threadId}: ${e?.message || e}${extra}`);
    }

    async function send(batch) {
        counts.calls++;
        let timer = null;
        try {
            const signal = AbortSignal.timeout(timeoutMs);
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
                timer.unref?.();
            });
            await Promise.race([
                sendDeliveredReceipt(getApi(), {
                    threadId: batch.threadId,
                    type: batch.type,
                    messages: batch.messages,
                    signal,
                }),
                timeout,
            ]);
            counts.sent += batch.messages.length;
            if (!announced) {
                announced = true;
                say(
                    `delivered receipts on: Zalo accepted the first (${batch.messages.length} message(s) ` +
                        `in ${batch.threadId}); opt out with --no-delivered-receipts`,
                );
            }
        } catch (e) {
            noteFailure(batch, e);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function pump() {
        while (batches.length && !stopped) {
            if (!hurry) await pause(delayMs);
            if (stopped) break;
            const batch = batches.shift();
            if (!batch) break;
            pending -= batch.messages.length;
            await send(batch);
        }
    }

    function kick() {
        if (pumping || stopped || !batches.length) return;
        pumping = pump().finally(() => {
            pumping = null;
            kick();
        });
    }

    /**
     * Queue a receipt for one zca-js message event. Never throws.
     *
     * @param {object} msg
     * @returns {boolean} whether a receipt was queued
     */
    function queue(msg) {
        if (!enabled || stopped) return false;
        try {
            const target = liveReceiptTarget(msg);
            if (!target) return false;
            let batch = null;
            for (const b of batches) {
                if (
                    b.threadId === target.threadId &&
                    b.type === target.type &&
                    b.messages.length < MAX_RECEIPTS_PER_CALL
                ) {
                    batch = b;
                    break;
                }
            }
            if (!batch) {
                batch = { threadId: target.threadId, type: target.type, messages: [] };
                batches.push(batch);
            }
            batch.messages.push(target.message);
            pending++;
            counts.queued++;
            while (pending > maxPending && batches.length > 1) {
                const old = batches.shift();
                pending -= old.messages.length;
                counts.dropped += old.messages.length;
            }
            if (counts.dropped && !droppedNoted) {
                droppedNoted = true;
                say(`delivered receipts: Zalo is not keeping up; dropping the oldest beyond ${maxPending} queued`);
            }
            kick();
            return true;
        } catch (e) {
            say(`delivered receipt skipped: ${e?.message || e}`);
            return false;
        }
    }

    return {
        /**
         * Subscribe to a zca-js listener's `message` events. Call it AFTER the
         * storing handler, and again on every new listener a re-login creates.
         *
         * @param {import("node:events").EventEmitter} listener - `api.listener`
         * @returns {() => void} detach
         */
        attach(listener) {
            if (!enabled || typeof listener?.on !== "function") return () => {};
            const onMessage = (msg) => {
                queue(msg);
            };
            listener.on("message", onMessage);
            return () => {
                try {
                    listener.removeListener("message", onMessage);
                } catch {
                    /* an already torn-down listener is fine */
                }
            };
        },

        queue,

        /**
         * Send everything queued now, without the delay. Resolves when the
         * queue is empty (failures are counted, never thrown).
         *
         * @returns {Promise<void>}
         */
        async flush() {
            hurry = true;
            try {
                wake?.();
                kick();
                while (pumping) await pumping;
            } finally {
                hurry = false;
            }
        },

        /** Stop sending; receipts still queued are dropped. */
        stop() {
            stopped = true;
            wake?.();
            counts.dropped += pending;
            batches.length = 0;
            pending = 0;
        },

        /** @returns {{queued: number, sent: number, failed: number, dropped: number, calls: number, pending: number}} */
        stats() {
            return { ...counts, pending };
        },
    };
}
