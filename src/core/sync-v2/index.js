/**
 * transfer-sync-v2 — restore mobile message history into zalo.db.
 *
 * This is the real, phone-backed sync (as opposed to the empty cmd 510/511
 * socket backfill). Flow, all over the one zca-js WebSocket:
 *
 *   1. cmd 590 CONVERSATION round (priority 0, partition "") — prompts the
 *      owner's phone once (transfer_status 3 -> 4 on tap). Decrypts to the full
 *      conversation list (opaque `convId`s + type).
 *   2. cmd 590 MESSAGE round(s) (priority 2), sharded at <=30 partitions each
 *      (`oneone/<convId>` / `group/<convId>`). Sent right after the confirm, so
 *      they inherit it (status 5, no extra tap). Each upload_batch carries a
 *      signed msgUrl.
 *   3. Fetch each msgUrl, strip the [u32 LE len] frame, decrypt via libzproto
 *      (metadata -> sessionRecord, then messages), Zstd-decompress, protobuf-
 *      decode, map the opaque convId to the real numeric threadId (+ name) via
 *      the friend/group lists, and write into zalo.db.
 *   4. cmd 591 dispose every session (clears the phone's sync banner).
 *
 * See tests/HANDOFF.md / agent/work/transfer-sync-v2 for the protocol notes.
 */
import zlib from "node:zlib";
import crypto from "node:crypto";
import { resolve } from "node:path";
import {
    initDb,
    insertMessage,
    upsertThread,
    setSyncState,
    runInTransaction,
    getPendingSyncGaps,
    resolveSyncGap,
    replaceLiveGroupEventPlaceholder,
    getThreadType,
    getRecentThreads,
    findMessageByClientId,
    countSyncRanges,
    deleteSyncRanges,
    getSyncRanges,
    markSyncRangesPending,
    setSyncRangeStatus,
} from "../db.js";
import { ensureAssets, loadCodecs } from "./assets.js";
import { classifySyncMessage } from "./message-types.js";
import { resolveNonFriendDms } from "./gid.js";
import { createSenderResolver } from "./senders.js";
import { readUserAliases, currentUserName, resolveCurrentUserNames } from "../current-user-names.js";
import { startKeepAlive } from "./keepalive.js";
import { DEVICE_LABEL } from "../../zalo/profile.js";
import { REQUEST_FAILURE, SyncRequestError, createSessionStore, createSyncChannel } from "./channel.js";
import { createBatchDownloader } from "./download.js";
import { createDownloadFetch } from "../../zalo/download-fetch.js";
import { coveredAfter, planRanges, rangeStatusAfter } from "./ranges.js";
import {
    CONFIRM_WAIT_MS,
    DISPOSE_REASON,
    applyControl,
    createTransferSession,
    declineError,
    PARTITION_NOT_FOUND,
    isConfirmed,
    isIdleTooLong,
    isStalledIdle,
    isTransferSessionComplete,
    judgeConversationRound,
    recordDownloadFailure,
    readTransferControls,
    shouldAbortOnFailures,
    STALL_IDLE_MS,
} from "./transfer.js";
import { attachLiveStore } from "../live-store.js";

/**
 * Lower bound of a "full history" sync: the beginning of time.
 *
 * This used to be pinned at 2024-01-01, which quietly made "full history" mean
 * "the last couple of years" — an account with messages from 2018 never had
 * them requested from the phone at all, with nothing in the output saying so.
 * Zalo itself asks for 14/30 days and the bound is just the `from` field of the
 * cmd 590 query, so there is no protocol reason to stop at any particular year.
 *
 * Use `--from` (see {@link resolveSyncWindow}) to raise it deliberately when a
 * narrower window is actually wanted.
 */
export const FULL_HISTORY_FROM = 0;

/** Zalo launched in 2012; nothing can predate it. Used only to sanity-check `--from`. */
const EARLIEST_PLAUSIBLE = 1325376000000; // 2012-01-01
const MAX_TS = 9007199254740991;
/**
 * Wait allowance per message shard. The phone serves shards sequentially,
 * so the overall budget scales with how many were sent rather than being a
 * flat number that is either too small for a full history or absurd for a
 * one-shard run.
 */
const PER_SHARD_BUDGET_MS = 30000;
/** How long a session may be waited for before the restore says what it is still missing. */
const STALL_NOTE_MS = 60_000;
/**
 * How many message sessions are asked for before the first of them has been served.
 *
 * Web and PC send every session of a run (98 partitions at 30 each is four of them, which is why a capture shows
 * four; PC has no cap either) one after the other, each after the previous one was acknowledged, then consume them
 * and release them together at the end. Fifty at once, with no waiting for acks, once got our socket dropped with no
 * error frame; the requests are ack-paced now. The phone stops serving at about 32 sessions that are open together
 * (live, 2026-10-25), so a wave is at most 30, which is also the most the restore takes (see `waveSize`): a run
 * of 79 sessions is three waves, and the sessions of a wave are released together when the wave is done.
 */
const DEFAULT_WAVE_SIZE = 30;
/**
 * Sessions released at once. One: each release goes out after the previous one was acknowledged. Web sends four 591
 * within 3 ms and gets four acks, but this client's bursts were answered only in part (live, 2026-10-28: two acks for
 * thirty releases, two for each burst of four, the rest unanswered for 3 s and then released fine one at a time),
 * while one at a time was acknowledged every time.
 */
const RELEASE_BURST = 1;
/**
 * How many times a dropped socket may be reconnected inside one restore.
 *
 * Three, as in a daemon. It was one, on the argument that a reconnect may cost the person a second tap if the server
 * does not carry the phone's confirmation across it. Live, 2026-10-28, none of a dozen or so reconnects on the
 * test account prompted the phone again, and each cost about three seconds (a two second pause, then the dead
 * socket's sessions released). A restore that dies on its second drop throws away a run that a phone tap bought.
 */
const MAX_RESUMES = 3;
/** The most reconnects a caller may ask a single restore to attempt. */
const MAX_RESUMES_CAP = 5;

/**
 * How many reconnects a restore may spend: the caller's `maxResumes` (a whole number, capped), else three.
 *
 * @param {unknown} requested
 * @returns {number}
 */
export function resolveMaxResumes(requested) {
    return Number.isInteger(requested) ? Math.min(MAX_RESUMES_CAP, Math.max(0, requested)) : MAX_RESUMES;
}
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turn the `--days` option into the `from`/`to` bounds carried by every
 * cmd 590 query — the conversation round as well as the message rounds, so a
 * narrow window also means fewer conversations, fewer shards and a shorter run.
 *
 * A falsy `days` (the default) means full history. A window reaching further
 * back than {@link FULL_HISTORY_FROM} is clamped to it, so `--days 9999` is
 * exactly the default rather than a wider request never tested against the
 * server.
 *
 * @param {number|null|undefined} days - how many days back to sync.
 * @param {number} [now=Date.now()] - injectable for tests.
 * @returns {{days: number|null, from: number, to: number, clamped: boolean, label: string}}
 */
/**
 * Record that a restore settled the window it asked about.
 *
 * Two things made the freshness debounce -- the guard that stops a run from
 * re-pinging the phone -- effectively disabled:
 *
 *  - a CONFIRMED empty window (the phone answered: nothing in this range was
 *    missed) returned before the success markers were written, so it never
 *    counted. That is the common case over any window a listener was
 *    connected for: the phone hands a sync only what a web session missed.
 *  - checkSyncFreshness never skips while any gap is pending, and nothing
 *    resolved gaps (resolveSyncGap had only test callers), so after the first
 *    listener reconnect every later run pinged the phone forever.
 *
 * Only a gap lying wholly inside the window is resolved: a --days 1 run says
 * nothing about a gap from last week. A partial run resolves none.
 *
 * @param {{from: number}} win - the window the restore asked for
 * @param {{resolveGaps?: boolean, now?: number}} [opts]
 * @returns {{resolvedGaps: number}}
 */
export function recordRestoreSuccess(win, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    setSyncState("lastSyncOkAt", now);
    setSyncState("lastSyncOkKind", "transfer");
    // How far back this run actually covered, so a later, WIDER sync is not
    // silently skipped by the freshness debounce.
    setSyncState("lastSyncOkFrom", String(win.from));
    let resolvedGaps = 0;
    if (opts.resolveGaps) {
        for (const g of getPendingSyncGaps()) {
            if (Number(g.fromTs) >= Number(win.from) && Number(g.toTs) <= now) {
                resolveSyncGap(g.id);
                resolvedGaps++;
            }
        }
    }
    return { resolvedGaps };
}

export function resolveSyncWindow(days, now = Date.now(), fromTs = undefined) {
    const since = (ts) => (ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "the beginning");

    // An explicit --from wins over --days: it is the more specific request.
    if (fromTs !== undefined && fromTs !== null && fromTs !== "") {
        const t = typeof fromTs === "number" ? fromTs : Date.parse(fromTs);
        if (Number.isFinite(t) && t >= EARLIEST_PLAUSIBLE && t <= now) {
            return { days: null, from: t, to: MAX_TS, clamped: false, label: `everything since ${since(t)}` };
        }
        return {
            days: null,
            from: FULL_HISTORY_FROM,
            to: MAX_TS,
            clamped: true,
            label: `full history (--from was not a usable date, so: everything)`,
        };
    }

    const n = Number(days);
    const full = { days: null, from: FULL_HISTORY_FROM, to: MAX_TS, clamped: false };
    if (!Number.isFinite(n) || n <= 0) return { ...full, label: "full history (everything your phone still holds)" };

    const wanted = now - n * DAY_MS;
    if (wanted <= FULL_HISTORY_FROM) {
        return { ...full, days: n, clamped: true, label: `the last ${n} days — which is all of it, so: full history` };
    }
    return {
        days: n,
        from: wanted,
        to: MAX_TS,
        clamped: false,
        label: `the last ${n} day${n === 1 ? "" : "s"} (since ${since(wanted)})`,
    };
}

const randId = (n = 32) =>
    [...crypto.randomBytes(n)]
        .map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62])
        .join("");
const b64 = (u8) => Buffer.from(u8).toString("base64");

/** Split a downloaded batch blob into its length-prefixed payload chunks. */
export function splitChunks(buf) {
    const out = [];
    let o = 0;
    while (o + 4 <= buf.length) {
        const n = buf.readUInt32LE(o);
        o += 4;
        if (o + n > buf.length) break;
        out.push(buf.subarray(o, o + n));
        o += n;
    }
    return out;
}

function decompress(p) {
    try {
        return zlib.zstdDecompressSync(p);
    } catch {}
    try {
        return zlib.inflateSync(p);
    } catch {}
    try {
        return zlib.gunzipSync(p);
    } catch {}
    return p;
}

/**
 * Decode a Zalo WebSocket frame body (the `{encrypt, data}` envelope) using the
 * per-session transport cipher key (the `key` field of the cmd 1/1 handshake
 * frame). Mirrors zca-js's decodeEventData without importing its internals.
 * encrypt: 0=plain JSON, 1=inflate-only, 2=AES-128-GCM+inflate, 3=GCM only.
 *
 * @param {{encrypt: number, data: string}} parsed
 * @param {string} cipherKey - base64 AES key from the handshake.
 */
export function decodeFrame(parsed, cipherKey) {
    if (parsed.encrypt === 0) return JSON.parse(parsed.data);
    const raw = Buffer.from(parsed.encrypt === 1 ? parsed.data : decodeURIComponent(parsed.data), "base64");
    let plain = raw;
    if (parsed.encrypt !== 1) {
        if (!cipherKey || raw.length < 48) throw new Error("missing cipher key or short frame");
        const iv = raw.subarray(0, 16);
        const aad = raw.subarray(16, 32);
        const body = raw.subarray(32);
        const ct = body.subarray(0, body.length - 16);
        const tag = body.subarray(body.length - 16);
        const key = Buffer.from(cipherKey, "base64");
        const decipher = crypto.createDecipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    }
    // encrypt 1/2 wrap the payload with zlib OR gzip (pako auto-detects both);
    // zlib.unzipSync handles either. encrypt 3 is uncompressed.
    let out = plain;
    if (parsed.encrypt !== 3) {
        try {
            out = zlib.unzipSync(plain);
        } catch {
            out = zlib.inflateRawSync(plain);
        }
    }
    return JSON.parse(out.toString("utf8"));
}

/**
 * Has a sync session delivered everything it was asked for?
 *
 * `isLast` looks like the end marker and mostly is, but a captured Zalo Web run
 * ends its final message session with `isLast=0` and disposes it anyway. What
 * actually completes a message session is coverage: every partition in the
 * cmd 590 request has come back inside some batch's `scopes`. The conversation
 * round asks for the empty partition and its batches carry no scopes, so there
 * `isLast` is the only signal available.
 *
 * @param {{want: Set<string>, covered: Set<string>, sawLast: boolean}} state
 * @returns {boolean}
 */
/**
 * Resolve a wait budget, refusing to produce something that means "do not wait".
 *
 * This exists because of a real regression: a call site that forgot to pass the
 * budget produced `Date.now() + undefined` = NaN, every comparison against NaN
 * is false, and the wait loop exited on its first check -- so a sync round that
 * should have waited three minutes for a phone confirmation returned instantly
 * and reported "not confirmed in time".
 *
 * @param {number|undefined} budgetMs - the requested budget
 * @param {number} fallbackMs - used when the request is missing or nonsensical
 * @returns {number} a finite, positive number of milliseconds
 */
export function resolveWaitBudget(budgetMs, fallbackMs) {
    if (Number.isFinite(budgetMs) && budgetMs > 0) return budgetMs;
    if (Number.isFinite(fallbackMs) && fallbackMs > 0) return fallbackMs;
    return 30000;
}

/**
 * The api a `reconnect` callback handed back, if it handed one.
 *
 * `true` means "the same listener is live again" (the CLI re-opens the socket on
 * the api it already has). `{api}` means the caller recovered by building a new
 * api, as a daemon does after logging in again, and the restore has to carry on
 * over that api's listener instead.
 *
 * @param {unknown} back - what `opts.reconnect()` resolved
 * @returns {object|null} the new api, or null when the old one is still the one
 */
export function reconnectedApi(back) {
    return back && typeof back === "object" && back.api?.listener ? back.api : null;
}

/**
 * Which shards still have to go out, and whether a dropped socket is worth one
 * more reconnect.
 *
 * Pulled out of the wave loop because this is the part that has to stay right
 * across a disconnect: a shard the phone already served must never be asked for
 * again (it would re-fetch, and in the worst case re-prompt), and a shard that
 * was in flight when the wire died must go out again or its messages are simply
 * lost. Mixing that bookkeeping in with the decrypt/decode/store body is how it
 * gets broken quietly.
 *
 * @param {number} shardCount - how many message rounds the run needs
 * @param {object} [opts]
 * @param {number} [opts.waveSize=DEFAULT_WAVE_SIZE] sessions in flight at once
 * @param {number} [opts.maxResumes=0] reconnects allowed; 0 disables resuming
 * @returns {{remaining: () => number, resumes: () => number, done: () => boolean,
 *   pending: () => number[], nextWave: () => number[], settle: (i: number) => boolean,
 *   useResume: () => boolean}}
 */
export function createShardSchedule(shardCount, opts = {}) {
    const waveSize = Math.max(1, opts.waveSize || DEFAULT_WAVE_SIZE);
    let resumesLeft = Number.isFinite(opts.maxResumes) && opts.maxResumes > 0 ? opts.maxResumes : 0;
    let resumes = 0;
    const pending = [];
    for (let i = 0; i < Math.max(0, shardCount); i++) pending.push(i);

    return {
        remaining: () => pending.length,
        resumes: () => resumes,
        done: () => pending.length === 0,
        pending: () => pending.slice(),
        /** The shard indexes to send next -- never more than one wave at a time. */
        nextWave: () => pending.slice(0, waveSize),
        /**
         * Mark a shard settled: served, or refused by the phone. Either way it
         * is finished with, and a resume must not send it again.
         *
         * @param {number} idx - shard index
         * @returns {boolean} true when it was still pending
         */
        settle(idx) {
            const at = pending.indexOf(idx);
            if (at >= 0) pending.splice(at, 1);
            return at >= 0;
        },
        /**
         * Spend one reconnect allowance.
         *
         * @returns {boolean} true when a reconnect may be attempted
         */
        useResume() {
            if (resumesLeft <= 0) return false;
            resumesLeft--;
            resumes++;
            return true;
        },
    };
}

/**
 * Turn the end state of a restore into a `reason` and, when it failed outright,
 * the message to throw.
 *
 * These two failures need opposite advice and used to read identically:
 *
 * - **the socket died** -- nothing is wrong with the phone, and if it had
 *   already confirmed, that tap is spent; the user needs to know a re-run costs
 *   them another one.
 * - **the phone never answered** -- the connection was fine the whole time, so
 *   the only thing to do differently is confirm the prompt.
 *
 * @param {object} st
 * @param {boolean} st.socketDied - the wire dropped and could not be resumed
 * @param {boolean} st.timedOut - the wait budget ran out with the socket up
 * @param {boolean} st.confirmed - the phone answered (transfer_status >= 4)
 * @param {number} st.messagesSaved
 * @param {number} st.finished - shards served
 * @param {number} st.total - shards requested
 * @param {number} [st.resumes=0] - reconnects used
 * @param {number} [st.waitMs] - the budget, for the timeout wording
 * @param {number} [st.failedBatches] - batches the phone could not serve
 * @param {number} [st.rowErrors] - rows that could not be written to the cache
 * @param {boolean} [st.tooManyFailures] - the run was stopped because too many batches failed
 * @returns {{reason: string, error: string|null}}
 */
export function describeRestoreOutcome(st) {
    const resumes = st.resumes || 0;
    const secs = Number.isFinite(st.waitMs) ? Math.round(st.waitMs / 1000) : null;

    if (st.tooManyFailures) {
        return {
            reason: "too-many-failures",
            error: st.messagesSaved
                ? null
                : "the phone could not serve most of the batches and none arrived — nothing was restored; try again later",
        };
    }

    if (st.socketDied && !st.messagesSaved) {
        return {
            reason: "socket-lost",
            error:
                (resumes ? `the connection dropped again after ${resumes} reconnect(s)` : "the connection dropped") +
                " before any messages arrived" +
                (st.confirmed
                    ? " — your phone had already confirmed, so re-running will prompt it again"
                    : " — your phone was never prompted, so nothing was spent"),
        };
    }
    if (st.timedOut && !st.messagesSaved) {
        return {
            reason: "timeout",
            error: st.confirmed
                ? `your phone confirmed but served no messages within ${secs ?? "the"}${secs ? "s" : " budget"} — the connection stayed up the whole time`
                : `your phone did not answer the sync prompt${secs ? ` within ${secs}s` : ""} — the connection stayed up, so nothing was lost; re-run and confirm it`,
        };
    }
    if (st.finished < st.total) return { reason: st.socketDied ? "socket-lost" : "partial", error: null };
    // Every shard came back, but some of what the phone was asked for did not: that is not complete.
    if (st.failedBatches > 0) return { reason: "partial", error: null };
    // Every shard came back and was asked for in full, but a row did not reach the cache: a hole is not complete.
    if (st.rowErrors > 0) return { reason: "partial", error: null };
    return { reason: "complete", error: null };
}

export function isSessionComplete(state) {
    return isTransferSessionComplete(state);
}

/**
 * The id a synced message should be stored under.
 *
 * `globalId` is the server id and the one every other path names a message by
 * (a reaction's `gMsgID`, a removal's `globalDelMsgId`). It is absent on some
 * messages, and jspb renders an absent uint64 as the string "0" — truthy — so
 * a plain `globalId || clientId` stored them all under the literal id "0",
 * where they overwrote one another through insertMessage's upsert.
 *
 * @param {object} msg - a decoded Sync2.Message.Message
 * @param {string|null} [threadId=null] - thread id to match an already-stored live row by cliMsgId
 * @returns {string}
 */
function syncMsgId(msg, threadId = null) {
    const gid = msg?.globalId;
    if (gid !== undefined && gid !== null && String(gid) !== "0" && String(gid) !== "") return String(gid);
    const cid = String(msg?.clientId ?? "");
    if (cid && cid !== "0" && threadId) {
        const existing = findMessageByClientId(cid, threadId);
        if (existing?.msgId) return String(existing.msgId);
    }
    return cid;
}

export class SyncV2 {
    /**
     * @param {object} api - a logged-in zca-js API (from getApi()).
     * @param {string} accountName - ownId; picks the account data dir.
     */
    constructor(api, accountName) {
        this.api = api;
        this.accountName = accountName;
        const dataRoot =
            process.env.ZALO_DATA_DIR ||
            process.env.ZALO_DB_DIR ||
            resolve(
                process.env.ZALO_CONFIG_DIR ||
                    resolve(process.env.USERPROFILE || process.env.HOME || "", ".zalo-agent-cli"),
                "accounts",
            );
        this.accountDir = resolve(dataRoot, accountName);
    }

    /** Build opaque-globalId -> {id, name, type} from the friend + group lists. */
    async _buildThreadMap(log) {
        const map = new Map();
        this.userAliases = await readUserAliases(this.api, log);
        try {
            const friends = await this.api.getAllFriends();
            const arr = Array.isArray(friends) ? friends : friends?.data || [];
            for (const f of arr)
                if (f.globalId)
                    map.set(f.globalId, {
                        id: String(f.userId),
                        name: currentUserName(f.userId, f, this.userAliases).name,
                        zaloName: f.zaloName || "",
                        snapshotName: f.zaloName || f.displayName || "",
                        type: "dm",
                    });
        } catch (e) {
            log(`friend list unavailable (${e.message}); DM names/ids may be missing`);
        }
        try {
            const groups = await this.api.getAllGroups();
            const gridVer = groups?.gridVerMap || groups?.data?.gridVerMap || {};
            const gids = Object.keys(gridVer);
            for (let i = 0; i < gids.length; i += 50) {
                const info = await this.api.getGroupInfo(gids.slice(i, i + 50)).catch(() => ({}));
                const gi = info?.gridInfoMap || info?.data?.gridInfoMap || {};
                for (const g of Object.values(gi))
                    if (g.globalId) map.set(g.globalId, { id: String(g.groupId), name: g.name || "", type: "group" });
            }
        } catch (e) {
            log(`group list unavailable (${e.message}); group names/ids may be missing`);
        }
        return map;
    }

    /** Refresh already-cached titles even if this restore window has no messages for them. */
    _refreshThreadNames(threadMap) {
        for (const thread of threadMap.values()) {
            if (getThreadType(thread.id) === thread.type) {
                upsertThread({ threadId: thread.id, type: thread.type, name: thread.name, lastUpdate: 0 });
            }
        }
    }

    /**
     * Refresh existing DM peers outside the requested message window, including non-friends.
     *
     * Every restore used to look up every non-friend DM peer in the cache: on a busy account that
     * is thousands of ids, each restore, and Zalo answered with a limit. So the run asks for at most
     * `maxLookups` of them (500 unless ZALO_SYNC_NAME_REFRESH_MAX says otherwise), peers whose
     * cached title is missing or just their id first, because those are the ones a restore can
     * actually improve. The rest keep the titles they have until a later restore reaches them.
     *
     * @param {Map<string, object>} threadMap
     * @param {(message: string) => void} [log]
     */
    async _refreshDmNames(threadMap, log = () => {}) {
        const profiles = new Map(
            [...threadMap.values()]
                .filter((t) => t.type === "dm" && t.zaloName)
                .map((t) => [t.id, { zaloName: t.zaloName }]),
        );
        const peers = getRecentThreads(-1, "dm");
        const unknown = (t) => !t.name || String(t.name) === String(t.threadId);
        const wanted = peers.filter((t) => !profiles.has(String(t.threadId)));
        wanted.sort((a, b) => Number(unknown(b)) - Number(unknown(a)));
        const envCap = Number.parseInt(process.env.ZALO_SYNC_NAME_REFRESH_MAX ?? "", 10);
        const maxLookups = Number.isFinite(envCap) && envCap >= 0 ? envCap : 500;
        const chosen = wanted.slice(0, maxLookups);
        if (wanted.length) {
            log(
                `refreshing ${chosen.length} of ${wanted.length} non-friend DM peer name(s)` +
                    (chosen.length < wanted.length
                        ? ` (cap ${maxLookups}; the rest keep their cached titles until a later restore)`
                        : ""),
            );
        }
        const names = await resolveCurrentUserNames(
            this.api,
            [...profiles.keys(), ...chosen.map((t) => String(t.threadId))],
            { aliases: this.userAliases, profiles, log },
        );
        for (const [id, current] of names) {
            upsertThread({ threadId: id, type: "dm", name: current.name, lastUpdate: 0 });
        }
    }

    /** Refresh the active account's own display name via onSelfName if provided. */
    async _refreshSelfName(onSelfName) {
        if (typeof onSelfName !== "function") return;
        const ownId = String(this.accountName || "");
        if (!/^[1-9][0-9]*$/.test(ownId)) return;
        try {
            const names = await resolveCurrentUserNames(this.api, [ownId], { aliases: new Map() });
            const self = names.get(ownId);
            if (self && self.source === "zalo" && self.name) {
                await onSelfName(self.name);
            }
        } catch {
            /* best-effort registry sync */
        }
    }

    /**
     * Run the full restore. Assumes the caller holds the account lock AND has
     * already started the listener: this adds and removes its own socket taps,
     * it never starts or stops the listener itself.
     *
     * @param {object} [opts]
     * @param {number|null} [opts.days=null] only sync the last N days; falsy = full history.
     * @param {string|number} [opts.from] explicit lower bound (date string or epoch ms); beats `days`.
     * @param {number} [opts.shardSize=30] partitions per message round (server caps ~30).
     * @param {number} [opts.waveSize=4] message sessions open at once (Zalo Web uses 4).
     * @param {number} [opts.waitMs=120000] per-phase wait budget.
     * @param {(s: {phase: string, detail?: string}) => void} [opts.onStatus]
     * @param {boolean} [opts.liveStore=true] false when the caller already taps live traffic
     * @param {number|false} [opts.keepAlive] heartbeat interval in ms, or false when the
     *   caller already pings this socket for the whole window it owns.
     * @param {number} [opts.settleMs] pause before the first request (default 1200; tests only)
     * @param {number} [opts.pollMs] how often a wait looks at its session (default 300; tests only)
     * @param {string} [opts.tempKey] the `temp_key` of a `transfer_after_login` control, to ask for the sync without a
     *   tap on the phone (Y8); empty by default
     * @param {AbortSignal} [opts.signal] cancel the run: it stops asking, keeps what already arrived, releases every
     *   open session with reason 0 (cancelled) and resolves with `reason: "cancelled"`
     * @param {boolean} [opts.fullResync] forget what earlier runs settled and ask for every conversation in full
     * @param {{zproto: object, M: object, C: object}} [opts.codecs] decryption and decoding stand-ins (tests only)
     * @param {number} [opts.stallNoteMs=60000] how long a session may be waited for before the run says what it lacks
     * @param {number} [opts.stallIdleMs=60000] how long an incomplete session may sit with the phone idle before it is failed
     * @param {number} [opts.maxResumes] reconnects this run may spend (default 3, at most 5); each one
     *   that needs the phone's confirmation again costs the owner a tap.
     * @param {() => Promise<boolean|{api: object}>} [opts.reconnect] re-open the listener socket
     *   after a drop and resolve true once it is live. Supplied by the caller because this class
     *   never starts or stops the listener itself. Without it a dropped socket ends the run.
     *   A caller that cannot reuse the old listener (a daemon, which re-logs-in and builds a new
     *   api) resolves `{api}` instead: the restore carries on over that api's listener.
     * @returns {Promise<{conversations:number, messagesSaved:number, threadsMapped:number, threadsUnmapped:number, reason:string, days:number|null, from:number, confirmed:boolean, resumes:number, rePrompted:boolean}>}
     */
    async restore(opts = {}) {
        // The server decides whether this account may sync from the phone at all: the web client reads
        // `settings.features.sync_2_web.enable` and shows no sync when it is false. (Live, 2026-10-28: true on a paid
        // and on a free account alike, with the same 300 s timeouts; the block does not depend on the zCloud plan.)
        if (this.api.getContext?.()?.settings?.features?.sync_2_web?.enable === false) {
            throw new Error(
                "Zalo has turned the phone-backed sync off for this account (the server's sync_2_web setting is off). " +
                    "Nothing was asked of the phone.",
            );
        }
        const shardSize = Math.min(30, Math.max(1, opts.shardSize || 30));
        const waveSize = Math.min(30, Math.max(1, opts.waveSize || DEFAULT_WAVE_SIZE));
        const stallNoteMs = opts.stallNoteMs ?? STALL_NOTE_MS;
        const stallIdleMs = opts.stallIdleMs ?? STALL_IDLE_MS;
        const waitMs = Math.max(30000, opts.waitMs || CONFIRM_WAIT_MS);
        // How long the socket is given to settle before the first request, and how often a wait looks at its session.
        // Both only ever change in a test.
        const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 1200;
        const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 300;
        const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
        const log = (m) => onStatus({ phase: "info", detail: m });
        // The key the phone offered at a QR login with auto sync ticked (a `transfer_after_login` control), when the
        // caller has one. Sent with the conversation request only.
        const tempKey = typeof opts.tempKey === "string" ? opts.tempKey : "";
        /** Has the caller asked to stop? Looked at between waits, never inside one request. */
        const aborted = () => opts.signal?.aborted === true;
        /** Set once the run was cut short on purpose: decides the reason sessions are released with. */
        let cancelled = false;
        const cancelError = () => Object.assign(new Error("cancelled"), { reason: "cancelled", cancelled: true });
        // The caller announces the window (it also decides the debounce on it);
        // it comes back on the result too, so no status line is emitted here.
        const win = resolveSyncWindow(opts.days, Date.now(), opts.from);

        // `opts.codecs` stands in for the decryption assets: a test runs the whole restore against a fake phone
        // with codecs of its own. The product never passes it.
        let codecs = opts.codecs;
        if (!codecs) {
            onStatus({ phase: "assets", detail: "loading decryption assets" });
            const assets = await ensureAssets(resolve(this.accountDir, "sync", "zproto-cache"), log);
            codecs = await loadCodecs(assets);
        }
        const { zproto, M, C } = codecs;

        onStatus({ phase: "contacts", detail: "reading friend/group lists for thread mapping" });
        const threadMap = await this._buildThreadMap(log);
        const senders = createSenderResolver(this.api, threadMap, { log });

        initDb(resolve(this.accountDir, "zalo.db"));
        // A full resync trusts nothing an earlier run settled (Y5c).
        if (opts.fullResync) deleteSyncRanges();
        this._refreshThreadNames(threadMap);
        await this._refreshDmNames(threadMap, log);
        await this._refreshSelfName(opts.onSelfName);

        // `let`: a daemon recovers a lost socket by logging in again, which builds a new api and a new
        // listener, and `opts.reconnect` can hand that api back (see `reconnect` below).
        let L = this.api.listener;
        const sessions = new Map(); // syncId -> {kind, batches:[], statuses:[], done, err}
        // Sending a request, reading its ack, releasing a session and remembering the open ones (Y4a, Y6, Y7).
        // It follows `L`, so a reconnect that replaces the listener is followed too.
        const channel = createSyncChannel({
            getListener: () => L,
            decode: (parsed) => decodeFrame(parsed, L.cipherKey),
            store: createSessionStore(resolve(this.accountDir, "sync", "open-sessions.json")),
            log,
        });
        // A batch is fetched the moment the phone announces it, two at a time (Y3), not when its turn to be
        // decoded comes.
        // In the account's own identity and over its proxy (plan item ZP-01), not the global fetch.
        const downloader = createBatchDownloader({ fetchImpl: createDownloadFetch(this.api) });
        const onMsg = async (buf) => {
            channel.handleFrame(buf);
            for (const ctl of readTransferControls(buf, (parsed) => decodeFrame(parsed, L.cipherKey))) {
                const s = sessions.get(ctl.syncId);
                if (!s) continue;
                const ev = applyControl(s, { act: ctl.act, data: ctl.data });
                if (ev.type === "batch" && ev.batch.msgUrl) downloader.start(ev.batch.msgUrl);
                if (ev.type === "status") {
                    if (ev.cls.status === 3) {
                        onStatus({
                            phase: "confirm",
                            detail: "Confirm the sync request on your phone (tap ĐỒNG BỘ NGAY)",
                        });
                    } else if (ev.cls.fatal) {
                        onStatus({ phase: "warn", detail: `your phone ended the sync: ${ev.cls.message}` });
                    }
                } else if (ev.type === "failure") {
                    onStatus({
                        phase: "warn",
                        detail:
                            `the phone could not serve ${ev.partitions.length} partition(s)` +
                            (ev.code !== null ? ` (error ${ev.code})` : ""),
                    });
                }
            }
        };

        // Zalo Web does not freeze while a sync runs: new messages keep arriving
        // on the same socket and keep being stored. A full-history run holds this
        // socket for many minutes, so without this everything that landed during
        // it was dropped -- a hole precisely where the sync promises completeness.
        // A caller holding the socket across several stages (`zalo-agent sync`)
        // attaches one tap for its whole window and passes liveStore:false, so
        // no live event is stored twice.
        const detachLive =
            opts.liveStore === false
                ? () => {}
                : attachLiveStore(L, (what, detail) =>
                      onStatus({
                          phase: "live",
                          detail: `stored a live ${what}${detail?.threadId ? ` in ${detail.threadId}` : ""}`,
                      }),
                  );

        // Why the socket went away matters: Zalo's 3000 means "another session
        // took the account", anything else points elsewhere. Without this the
        // only symptom is a silent stall, which is what made the first two
        // runs so hard to diagnose.
        let closeInfo = null;
        // Declared before the close handler that reads it: the handler reports
        // how long the heartbeat had gone unanswered when the wire died.
        let keeper = null;
        const onClose = (code, reason) => {
            closeInfo = { code, reason: String(reason || "") };
            // A 1006 carries no close frame, so the only thing that can say
            // whether the wire had already gone quiet is our own heartbeat.
            // Zalo echoes every cmd 2/1 straight back, so a ping count well
            // ahead of the echo count is a half-open socket we noticed late --
            // the one piece of evidence a bare 1006 otherwise never leaves.
            const hb = keeper?.stats();
            closeInfo.heartbeat = hb?.sent
                ? `${hb.echoed}/${hb.sent} echoed, last ${Math.round(hb.silentMs / 1000)}s ago`
                : "";
            onStatus({
                phase: "warn",
                detail:
                    `socket closed (code ${code}${closeInfo.reason ? ": " + closeInfo.reason : ""})` +
                    (closeInfo.heartbeat ? ` — heartbeat ${closeInfo.heartbeat}` : ""),
            });
        };
        const onSockErr = (e) => {
            closeInfo = closeInfo || { code: "error", reason: e?.message || String(e) };
            onStatus({ phase: "warn", detail: `socket error: ${closeInfo.reason}` });
        };

        // Everything below is attached to the RAW socket, so all of it has to be
        // re-attached after a reconnect -- `L.ws` is a different object then, and
        // zca-js nulls the old one. (`attachLiveStore` taps the Listener, which
        // outlives the socket, so it is deliberately not in here.)
        const attachSocketTaps = () => {
            try {
                L.ws.on("message", onMsg);
                L.ws.on("close", onClose);
                L.ws.on("error", onSockErr);
            } catch {
                /* an older ws shape without these events is not fatal */
            }
            if (opts.keepAlive !== false) {
                keeper = startKeepAlive(L, {
                    intervalMs: typeof opts.keepAlive === "number" ? opts.keepAlive : undefined,
                    // The interval the server gave this session at login, as Web uses it.
                    advisedMs: Number(this.api.getContext?.()?.settings?.features?.socket?.ping_interval),
                });
            }
        };
        const detachSocketTaps = () => {
            try {
                keeper?.stop();
            } catch {
                /* already stopped */
            }
            keeper = null;
            for (const [ev, fn] of [
                ["message", onMsg],
                ["close", onClose],
                ["error", onSockErr],
            ]) {
                try {
                    L.ws?.removeListener?.(ev, fn);
                } catch {
                    /* the socket may already be gone */
                }
            }
        };
        attachSocketTaps();

        /**
         * One reconnect attempt, then re-arm every raw-socket tap on the new
         * wire. The caller owns starting the listener (this class never does),
         * so it supplies `opts.reconnect`; without one a dropped socket stays
         * dropped, exactly as before.
         *
         * @returns {Promise<boolean>} true when a live socket is back
         */
        const reconnect = async () => {
            if (typeof opts.reconnect !== "function") return false;
            detachSocketTaps();
            let ok = false;
            try {
                const back = await opts.reconnect();
                ok = Boolean(back);
                // A new api means a new listener: the old one's socket is gone for good.
                const next = ok ? reconnectedApi(back) : null;
                if (next) {
                    this.api = next;
                    L = next.listener;
                }
            } catch (e) {
                onStatus({ phase: "warn", detail: `reconnect failed: ${e?.message || e}` });
                return false;
            }
            if (!ok || !L.ws || L.ws.readyState > 1) return false;
            closeInfo = null;
            attachSocketTaps();
            return true;
        };

        const newSession = (kind, wantPartitions = []) => {
            const id = randId();
            // Completion is measured by coverage: every partition asked for has to come back in some
            // batch's `scopes`, or be reported as failed (see ./transfer.js).
            sessions.set(id, createTransferSession({ kind, want: wantPartitions }));
            return id;
        };

        /**
         * Wait for one session to finish.
         *
         * `isLast` is NOT a reliable end marker -- a captured Zalo Web run ends
         * its final message session with isLast=0 and disposes it anyway. What
         * actually marks a message session complete is that every requested
         * partition has appeared in a batch's `scopes`. The conversation round
         * asks for the empty partition and carries no scopes, so it still falls
         * back to isLast.
         *
         * Returns why it stopped, so the caller can tell "no data" from
         * "the socket died" from "the phone never answered".
         */
        const waitDone = async (id, budgetMs) => {
            const dl = Date.now() + resolveWaitBudget(budgetMs, waitMs);
            const s = sessions.get(id);
            let noted = Date.now();
            while (!s.done && !s.err && !s.fatal && Date.now() < dl) {
                if (aborted()) return "cancelled";
                // A minute of waiting says what the session has and what it lacks: without it a phone that went
                // quiet looks exactly like work in progress (seen live, 2026-10-28: ten minutes of nothing).
                if (Date.now() - noted >= stallNoteMs) {
                    noted = Date.now();
                    onStatus({ phase: "wait", detail: describeWait(s) });
                }
                // A phone that says it is idle and stays so is not coming back.
                // A message session the phone left incomplete and idle: failed for this run, asked again at the end.
                if (s.kind === "msg" && isStalledIdle(s, { afterMs: stallIdleMs })) return "stalled";
                if (isIdleTooLong(s)) return "idle-timeout";
                // A closed socket can never deliver the rest, so stop now
                // instead of burning the whole budget waiting on a dead wire.
                // zca-js sets `this.ws = null` on close, so an absent socket is
                // just as dead as one reporting CLOSING/CLOSED -- checking only
                // readyState missed every real disconnect.
                if (!L.ws || L.ws.readyState > 1) return "socket-closed";
                await new Promise((r) => setTimeout(r, pollMs));
            }
            // The phone ended the sync (rejected, cancelled, busy, low on storage, signed out).
            if (s.fatal) return "declined";
            if (s.err) return "error";
            if (s.done) return "done";
            return "timeout";
        };

        /** What a session that is still waited for has: batches, conversations covered of those asked, phone statuses. */
        const describeWait = (s) => {
            const status = `phone status ${s.statuses.length ? s.statuses.slice(-4).join(",") : "none"}`;
            if (s.kind === "conv")
                return `still waiting for the phone: ${s.batches.length} batch(es) of the conversation list so far, ${status}`;
            return (
                `still waiting for the phone: ${s.batches.length} batch(es) so far, ${s.covered.size} of ${s.want.size} ` +
                `conversation(s) covered, ${s.failed.size} failed, last batch ${s.sawLast ? "seen" : "not seen"}, ${status}`
            );
        };

        /** Releases sent and not yet answered: a request must not overtake them (see sendRequest). */
        const releasing = new Set();

        /**
         * Release one session (the ack is awaited in the background; the next request waits for it).
         *
         * @returns {Promise<object>|undefined} the release, or nothing when the session is already let go of
         */
        const disposeOne = (id) => {
            const s = sessions.get(id);
            if (!s || s.disposed) return undefined;
            s.disposed = true;
            const going = channel.release(id, s.disposeReason ?? DISPOSE_REASON.SUCCESS).finally(() => {
                releasing.delete(going);
            });
            releasing.add(going);
            return going;
        };

        /**
         * Release a wave's sessions together, once the wave is stored (see RELEASE_BURST for how many go out at once).
         */
        const disposeTogether = async (ids) => {
            for (let i = 0; i < ids.length; i += RELEASE_BURST) {
                await Promise.allSettled(ids.slice(i, i + RELEASE_BURST).map(disposeOne));
            }
        };

        /**
         * Send one cmd 590 and wait until Zalo acknowledges it (Y4a): requests are paced by their acks, so a
         * request is never sent into a queue that has not taken the one before it.
         *
         * A request also waits for the releases still unanswered: Web sends 591, takes its ack, and only then the
         * 590 (capture CS1: 591 at 37.419 s, ack at 37.456, first 590 at 37.487).
         *
         * @returns {Promise<{socketClosed: boolean}>} `socketClosed` when the wire died before the ack; any other
         *   failure throws with words the person can act on
         */
        const sendRequest = async (kind, id, ek, req, tempKey = "") => {
            await Promise.allSettled([...releasing]);
            try {
                await channel.request({
                    tempKey,
                    kind,
                    syncId: id,
                    ek: b64(ek.publicKey),
                    ik: b64(ik.publicKey),
                    req,
                    deviceName: DEVICE_LABEL,
                });
                return { socketClosed: false };
            } catch (e) {
                if (!(e instanceof SyncRequestError)) throw e;
                if (e.failure === REQUEST_FAILURE.SOCKET_CLOSED) return { socketClosed: true };
                if (e.failure === REQUEST_FAILURE.NOT_SUPPORTED) {
                    throw Object.assign(
                        new Error(
                            `Zalo refused the sync request: this client's protocol version is not supported (${e.message})`,
                        ),
                        { reason: "client-not-supported" },
                    );
                }
                throw Object.assign(new Error(`Zalo did not take the sync request: ${e.message}`), {
                    reason: e.failure,
                });
            }
        };

        const ik = zproto.generateKeyPair();
        let conversations = 0,
            messagesSaved = 0,
            attachmentsSaved = 0,
            rowErrors = 0;
        /** The first reason a row could not be written, for the report. */
        let firstRowError = null;
        /** Partitions with a row that could not be written: they are not settled as done, so the next run asks again. */
        const writeFailed = new Set();
        const mappedThreads = new Set(),
            unmappedThreads = new Set();
        /** type name -> count, for the command's summary line. */
        const typeCounts = Object.create(null);
        let reason = "complete";
        /** What ended the run, when it threw: decides the reason sessions are released with. */
        let runError = null;
        // Did the phone actually answer? transfer_status 4 = Confirmed,
        // 5 = Authorized. Needed to tell "empty window" from "never tapped".
        let confirmed = false;
        // Set by the message rounds; read by done(), which can run before them.
        let resumeInfo = { resumes: 0, rePrompted: false };
        const done = (r) =>
            this._result(conversations, messagesSaved, mappedThreads, unmappedThreads, r, {
                days: win.days,
                from: win.from,
                confirmed,
                ...resumeInfo,
                attachmentsSaved,
                rowErrors,
                firstRowError,
                typeCounts: { ...typeCounts },
                // Every threadId the conversation round accounted for. Anything
                // cached outside this list is orphaned.
                liveThreadIds: [...mappedThreads, ...unmappedThreads],
            });

        // decrypt one session's batches -> decoded proto objects. A batch that cannot be downloaded fails its
        // scopes (Y3) instead of being skipped: they are returned, so the caller can count them.
        const eachChunkObj = async (s, ek, protoClass, onObj) => {
            const downloadFailures = [];
            let sessionRecord = null;
            const ordered = s.batches
                .slice()
                .sort((a, b) => (a.batchType === 2 ? -1 : 1) - (b.batchType === 2 ? -1 : 1) || a.idx - b.idx);
            for (const bt of ordered) {
                if (!bt.msgUrl) continue;
                await new Promise((r) => setImmediate(r));
                let blob;
                try {
                    blob = await downloader.get(bt.msgUrl);
                } catch (e) {
                    recordDownloadFailure(s, bt, e);
                    downloadFailures.push({ batch: bt, error: e });
                    onStatus({
                        phase: "warn",
                        detail: `could not download a batch (${e.kind ?? "error"}: ${e.message}) — its conversations are marked failed`,
                    });
                    continue;
                }
                for (const chunk of splitChunks(blob)) {
                    // Hand the event loop back before each chunk. Decode and
                    // store are synchronous and a single shard can carry tens of
                    // thousands of messages; zca-js keeps the socket alive with
                    // a setInterval ping, and a blocked loop means a missed ping
                    // means Zalo drops the connection mid-run. This is the same
                    // problem Zalo Web avoids by decoding in a worker thread.
                    await new Promise((r) => setImmediate(r));
                    try {
                        let plain;
                        if (bt.batchType === 2) {
                            const m = zproto.decryptMetadata(chunk, ik.publicKey, ik.privateKey, ek.privateKey);
                            sessionRecord = m.sessionRecord;
                            plain = m.plaintext;
                        } else {
                            if (!sessionRecord) continue;
                            plain = zproto.decryptMessage(chunk, sessionRecord).plaintext;
                        }
                        let obj;
                        try {
                            obj = protoClass.deserializeBinary(decompress(plain)).toObject();
                        } catch {
                            continue;
                        }
                        await onObj(obj);
                    } catch {
                        /* skip bad chunk */
                    }
                }
            }
            return { downloadFailures };
        };

        try {
            await new Promise((r) => setTimeout(r, settleMs));
            if (aborted()) throw cancelError();

            // A run that died left its sessions open on the phone; release them (reason 3) before starting
            // anything, so the phone's banner and its queue start clean (Y6b).
            const leftover = await channel.cleanLeftovers();
            if (leftover) log(`released ${leftover} sync session(s) an earlier run left open`);

            // ---- conversation round ----
            // `ek` is fresh per session and `ik` is stable across them (see
            // FINDINGS.md § cmd 590 request envelope), so a retried round needs
            // its OWN ek -- and the decrypt then has to use that one.
            let ekConv = zproto.generateKeyPair();
            let convId = newSession("conv");
            onStatus({ phase: "conversation", detail: "requesting your conversation list" });
            const convRequest = {
                type: "conversation",
                priority: 0,
                batchSize: 2000,
                queries: [{ partition: "", from: win.from, to: win.to, limit: 2147483647 }],
            };
            const convSent = await sendRequest("conv", convId, ekConv, convRequest, tempKey);
            let convWhy = convSent.socketClosed ? "socket-closed" : await waitDone(convId, waitMs);
            if (convWhy === "cancelled") throw cancelError();
            let convSession = sessions.get(convId);
            confirmed = isConfirmed(convSession.statuses);

            // A socket that dies here loses the conversation list outright --
            // it only ever arrives on the socket that asked for it. Reconnect
            // and ask again rather than ending the run: if the phone already
            // confirmed, the server carries that authorization and the resent
            // round goes straight through; if it had not, the prompt the user
            // sees is the one a manual re-run would have shown them anyway.
            if (convWhy === "socket-closed" && (await reconnect())) {
                onStatus({
                    phase: "reconnect",
                    detail: confirmed
                        ? "reconnected — asking for your conversation list again (your phone already confirmed)"
                        : "reconnected — asking for your conversation list again; your phone may prompt once more",
                });
                // A new socket starts as Web's does: the dead one's sessions released with reason 3, counting from 0.
                await channel.releaseAbandoned();
                channel.resetUssidx(0);
                const retryId = newSession("conv");
                ekConv = zproto.generateKeyPair();
                const retrySent = await sendRequest("conv", retryId, ekConv, convRequest, tempKey);
                convWhy = retrySent.socketClosed ? "socket-closed" : await waitDone(retryId, waitMs);
                if (convWhy === "cancelled") throw cancelError();
                convSession = sessions.get(retryId);
                convId = retryId;
                confirmed = confirmed || isConfirmed(convSession.statuses);
            }

            // What the conversation round ended in (see judgeConversationRound): a phone that said no is
            // not a window that was settled, so it ends here and nothing is recorded.
            const verdict = judgeConversationRound({ why: convWhy, session: convSession, waitMs, confirmed });
            if (verdict.error) throw verdict.error;

            const convs = [];
            const convRead = await eachChunkObj(convSession, ekConv, C.SyncChunk, (obj) => {
                for (const c of obj.conversationsList || []) convs.push(c);
            });
            // A conversation list with a hole in it is not a list: say so rather than restore a part of it.
            if (convRead.downloadFailures.length) {
                const first = convRead.downloadFailures[0].error;
                throw Object.assign(
                    new Error(
                        `your conversation list could not be downloaded (${first.kind ?? "error"}: ${first.message}) — nothing was restored`,
                    ),
                    { reason: "download-failed" },
                );
            }
            // Zalo Web releases the conversation session as soon as it has the
            // list, before asking for any messages. Match that: it clears the
            // phone's banner for that round instead of holding it open.
            disposeOne(convId);
            conversations = convs.length;
            // The conversation round carries per-thread state the message
            // rounds never repeat (whether you have replied, and the ids of the
            // newest message). Keep it keyed by the opaque convId so the
            // message loop can attach it once the real threadId is known.
            const convMeta = new Map();
            for (const c of convs) {
                convMeta.set(c.convId, {
                    respondedByMe: c.respondedByMe,
                    lastGlobalId: c.lastGlobalId,
                    lastClientId: c.lastClientId,
                    lastTs: Number(c.lastTs) || 0,
                });
            }
            if (!conversations) {
                // With --days an empty result is expected when nothing happened
                // in the window, so separate that from a prompt that was never
                // confirmed — the two need opposite advice from the caller.
                reason = confirmed ? "empty-window" : "no-conversations";
                // The phone answered and had nothing for this window: that IS
                // the window settled. Only an unconfirmed prompt is a non-result.
                if (confirmed) recordRestoreSuccess(win, { resolveGaps: true });
                return done(reason);
            }

            // Tier 3: resolve 1-1 conversations not in the friend list (non-friends, OA) to
            // real ids + names via /api/gid/decrypt — the same fallback Zalo Web uses. Left
            // groups have no per-item endpoint, so they stay opaque (as in Zalo Web).
            const unresolved = convs.filter((c) => c.convType !== 2 && !threadMap.has(c.convId)).map((c) => c.convId);
            if (unresolved.length) {
                onStatus({ phase: "resolve", detail: `resolving ${unresolved.length} non-friend conversation(s)` });
                try {
                    const extra = await resolveNonFriendDms(this.api, unresolved, log);
                    for (const [gid, v] of extra)
                        threadMap.set(gid, {
                            id: v.id,
                            name: currentUserName(v.id, { zaloName: v.zaloName }, this.userAliases).name,
                            zaloName: v.zaloName || "",
                            snapshotName: v.name,
                            type: "dm",
                        });
                    this._refreshThreadNames(threadMap);
                    onStatus({
                        phase: "resolve",
                        detail: `resolved ${extra.size}/${unresolved.length} via gid/decrypt`,
                    });
                } catch (e) {
                    log(`tier-3 resolve failed (${e.message})`);
                }
            }

            // `to` is per conversation, not a global bound. Zalo Web sends each
            // partition its own conversation's `lastTs` -- a capture of one run
            // shows 30 distinct `to` values across 30 partitions -- and asks for
            // an unbounded `to` only on the conversation round, where it does
            // not yet know what the latest message is. Sending MAX_SAFE_INTEGER
            // per partition asks the phone to scan to the year 285428 for a
            // conversation that has been quiet since 2024.
            const askedTo = Math.min(win.to, Date.now());
            const partitions = convs.map((c) => {
                const lastTs = Number(c.lastTs) || 0;
                return {
                    partition: (c.convType === 2 ? "group/" : "oneone/") + c.convId,
                    from: win.from,
                    // Never past what the caller asked for, and never past now.
                    to: lastTs > 0 ? Math.min(lastTs, askedTo) : askedTo,
                    limit: 2147483647,
                };
            });
            // What earlier runs settled is not asked for again, and what they got part of is asked for from
            // there (Y5): a killed run resumes, and a later run only fetches what came after the last one.
            const plan = planRanges({
                asked: partitions.map(({ partition, from, to }) => ({ partition, from, to })),
                prior: getSyncRanges(),
                fullResync: Boolean(opts.fullResync),
            });
            if (plan.orphans.length) deleteSyncRanges(plan.orphans);
            const askOf = new Map(partitions.map((q) => [q.partition, q]));
            const priorOf = new Map(getSyncRanges().map((r) => [r.partition, r]));
            const incrementalOf = new Map(plan.todo.map((q) => [q.partition, q.incremental]));
            const todo = plan.todo.map((q) => ({
                partition: q.partition,
                from: q.from,
                to: q.to,
                limit: askOf.get(q.partition).limit,
            }));
            markSyncRangesPending(
                plan.todo
                    .filter((q) => !q.incremental)
                    .map((q) => ({ partition: q.partition, fromTs: q.from, toTs: q.to })),
            );
            const rangeInfo = {
                skipped: plan.skipped.length,
                incremental: plan.todo.filter((q) => q.incremental).length,
                retried: 0,
                recovered: 0,
            };
            /** partition -> why it failed, for the ranges that stand failed right now in this run */
            const failedRanges = new Map();
            if (plan.skipped.length || rangeInfo.incremental) {
                onStatus({
                    phase: "messages",
                    detail:
                        `${plan.skipped.length} conversation(s) already settled by an earlier run are not asked for again` +
                        (rangeInfo.incremental
                            ? `; ${rangeInfo.incremental} are asked for only from where that run stopped`
                            : ""),
                });
            }
            // Settle each partition of a served shard: done, failed (with why), or still pending (the session ended early).
            const settleRanges = (queries, session) => {
                for (const q of queries) {
                    const status = rangeStatusAfter(q.partition, session);
                    if (status === "done" && writeFailed.has(q.partition)) {
                        setSyncRangeStatus(q.partition, "failed", { reason: "write-error" });
                        failedRanges.set(q.partition, "write-error");
                        continue;
                    }
                    if (status === "done") {
                        setSyncRangeStatus(
                            q.partition,
                            "done",
                            coveredAfter(
                                askOf.get(q.partition),
                                priorOf.get(q.partition),
                                incrementalOf.get(q.partition),
                            ),
                        );
                        failedRanges.delete(q.partition);
                    } else if (status === "failed") {
                        const f = session.failures.find((x) => x.partition === q.partition);
                        if (Number(f?.code) === PARTITION_NOT_FOUND) {
                            // The phone no longer has this conversation: there is nothing to ask for again.
                            deleteSyncRanges([q.partition]);
                            failedRanges.delete(q.partition);
                            rangeInfo.gone = (rangeInfo.gone ?? 0) + 1;
                            continue;
                        }
                        const why = f?.download ? `download:${f.download}` : `error:${f?.code ?? "unknown"}`;
                        setSyncRangeStatus(q.partition, "failed", { reason: why });
                        failedRanges.set(q.partition, why);
                    }
                }
            };
            if (!todo.length) {
                // Everything was settled by earlier runs: nothing to ask, and nothing left unfinished.
                onStatus({ phase: "messages", detail: "every conversation was already settled by an earlier run" });
                reason = "complete";
                recordRestoreSuccess(win, { resolveGaps: true });
                resumeInfo = { resumes: 0, rePrompted: false, ranges: { ...rangeInfo, ...countSyncRanges() } };
                return done(reason);
            }
            const shards = [];
            for (let i = 0; i < todo.length; i += shardSize) shards.push(todo.slice(i, i + shardSize));
            onStatus({ phase: "messages", detail: `${todo.length} conversations in ${shards.length} batch(es)` });

            // ---- message rounds (sharded) ----
            // Requests go out in waves. Zalo Web opens at most FOUR message
            // sessions at once and the phone serves them one at a time; firing
            // all fifty shards of a full-history run at once got the socket
            // dropped with no error frame, so the in-flight count is capped.
            // Within a wave the requests still go out together, which is what
            // makes them inherit the single confirmation.
            const sendWave = async (wave) => {
                const meta = [];
                for (const shard of wave) {
                    const ek = zproto.generateKeyPair();
                    const sid = newSession(
                        "msg",
                        shard.map((q) => q.partition),
                    );
                    meta.push({ sid, ek });
                    // Each request goes out after the one before it was acknowledged, not on a timer (Y4b).
                    const sent = await sendRequest("msg", sid, ek, {
                        type: "message",
                        priority: 2,
                        batchSize: 2000,
                        queries: shard,
                    });
                    if (sent.socketClosed) {
                        meta.socketClosed = true;
                        break;
                    }
                }
                return meta;
            };

            // One budget for the whole run, not one per shard: a per-shard
            // budget multiplies (50 shards x 10 min = eight hours of waiting on
            // a phone that already went quiet). It scales with the shard count
            // because the phone serves them one at a time -- a full-history run
            // is 50 shards and genuinely needs longer than a one-shard run --
            // and a dropped socket aborts immediately regardless, so a long
            // budget costs nothing when something actually breaks.
            const shardBudget = (n) => Math.max(waitMs, n * PER_SHARD_BUDGET_MS);
            let runDeadline = Date.now() + shardBudget(shards.length);
            onStatus({
                phase: "messages",
                detail: `waiting up to ${Math.round(shardBudget(shards.length) / 60000)} min for the phone to serve ${shards.length} batch(es)`,
            });
            let finished = 0;
            let socketDied = false;
            let timedOut = false;
            let stop = false;
            let declined = null;
            let failedBatches = 0;
            let tooManyFailures = false;
            const batchStats = { failed: 0, total: 0 };
            let rePrompted = false;
            /** batches that failed as a whole (no scope named): they are not a range to ask for again */
            let sessionErrors = 0;
            // A reconnect is only on the table when the caller handed us a way
            // to reconnect -- this class never starts the listener itself.
            const schedule = createShardSchedule(shards.length, {
                waveSize,
                maxResumes: typeof opts.reconnect === "function" ? resolveMaxResumes(opts.maxResumes) : 0,
            });

            // Store one decoded chunk: the same for a first ask and for the one retry.
            const storeChunk = async (obj) => {
                // Network identity lookups must finish before opening
                // the synchronous SQLite transaction for this chunk.
                await senders.prepare((obj.partitionsList || []).flatMap((p) => p.messagesList || []));
                // One transaction per decoded chunk rather than one per
                // row: thousands of individual WAL commits is both slow
                // and a long block on the event loop.
                runInTransaction(() => {
                    for (const part of obj.partitionsList || []) {
                        const gid = /^(?:oneone|group)\/(.+)$/.exec(part.id)?.[1];
                        const hit = gid && threadMap.get(gid);
                        const isGroup = part.id.startsWith("group/");
                        const threadId = hit ? hit.id : part.id;
                        (hit ? mappedThreads : unmappedThreads).add(threadId);
                        const cm = (gid && convMeta.get(gid)) || {};
                        for (const msg of part.messagesList || []) {
                            // The payload's numeric msgType + meta decide the row;
                            // `content` is always a string, so it cannot.
                            const info = classifySyncMessage(msg);
                            const threadType = hit ? hit.type : isGroup ? "group" : "dm";
                            try {
                                upsertThread({
                                    threadId,
                                    type: threadType,
                                    // The partition prefix is the phone's own
                                    // classification: authoritative when the
                                    // thread map agrees, so it can heal a 1-1 a
                                    // pin notice once turned into a "group".
                                    authoritative: threadType === (isGroup ? "group" : "dm"),
                                    name: hit ? hit.name : "",
                                    lastUpdate: Number(msg.timestamp) || 0,
                                    sync_timestamp: Date.now(),
                                    respondedByMe: cm.respondedByMe,
                                    lastGlobalId: cm.lastGlobalId,
                                    lastClientId: cm.lastClientId,
                                });
                                // The listener stored this system line under a
                                // placeholder id (a group event carries no
                                // message id); the phone's row replaces it.
                                if (info.type === "group_event") {
                                    replaceLiveGroupEventPlaceholder(threadId, Number(msg.timestamp) || 0);
                                }
                                insertMessage({
                                    // jspb renders an unset uint64 as
                                    // the STRING "0", which is truthy,
                                    // so `globalId || clientId` kept it
                                    // and every message without a
                                    // global id collided on the primary
                                    // key "0", overwriting each other.
                                    // 0 means absent here, exactly as
                                    // it does in a removal's
                                    // globalDelMsgId and a reaction's
                                    // gMsgID.
                                    msgId: syncMsgId(msg, threadId),
                                    threadId,
                                    senderId: senders.get(msg.senderId).id,
                                    senderName: senders.get(msg.senderId).name,
                                    text: info.text,
                                    timestamp: Number(msg.timestamp) || 0,
                                    type: info.type,
                                    raw_data: info.raw,
                                    has_attachment: info.hasAttachment,
                                    // The phone is the only source of
                                    // delivery/read state, and this was
                                    // parsed and then dropped on the way
                                    // to the column: 87k rows carried a
                                    // real status inside raw_data while
                                    // the column stayed NULL on all of
                                    // them.
                                    msgStatus: info.raw?.msgStatus,
                                });
                                messagesSaved++;
                                if (info.hasAttachment) attachmentsSaved++;
                                typeCounts[info.type] = (typeCounts[info.type] || 0) + 1;
                            } catch (e) {
                                // Keep going with the rest of the chunk, but never silently: a row that cannot be
                                // written (a full disk, a locked file) leaves a hole, so the partition is not settled
                                // and the run does not call itself complete.
                                rowErrors++;
                                writeFailed.add(part.id);
                                firstRowError ??= e?.message ?? String(e);
                            }
                        }
                    }
                });
            };

            // ---- wave by wave: send, wait, decrypt, decode, store ----
            // Storing per shard rather than after all of them means an
            // interrupted run keeps what it already pulled.
            while (!schedule.done() && !stop) {
                if (aborted()) {
                    cancelled = true;
                    stop = true;
                    break;
                }
                const wave = schedule.nextWave();
                const waveMeta = await sendWave(wave.map((i) => shards[i]));
                // A wire that died while the requests were going out loses the rest of the wave with it.
                let lostSocket = Boolean(waveMeta.socketClosed);
                for (let k = 0; !lostSocket && k < waveMeta.length; k++) {
                    const m = waveMeta[k];
                    const left = runDeadline - Date.now();
                    const why = left > 0 ? await waitDone(m.sid, left) : "timeout";
                    if (why === "socket-closed") {
                        lostSocket = true;
                        break;
                    }
                    if (why === "cancelled") {
                        cancelled = true;
                        stop = true;
                        break;
                    }
                    if (why === "declined") {
                        // Same rule as the conversation round: the phone's no ends the run.
                        declined = sessions.get(m.sid).fatal;
                        stop = true;
                        break;
                    }
                    if (why === "stalled") {
                        // Fail this session alone, as Web does (its idle timeout fails the session, not the run):
                        // what arrived is stored, and the conversations it never delivered are asked for once more at
                        // the end of the run, in sessions of their own.
                        const stalled = sessions.get(m.sid);
                        const missing = shards[wave[k]].filter(
                            (q) => !stalled.covered.has(q.partition) && !stalled.failed.has(q.partition),
                        );
                        for (const q of missing) {
                            stalled.failed.add(q.partition);
                            stalled.failures.push({ partition: q.partition, code: "stalled" });
                        }
                        stalled.disposeReason ??= DISPOSE_REASON.ERROR;
                        onStatus({
                            phase: "warn",
                            detail:
                                `the phone went idle with ${shards[wave[k]].length - missing.length} of ` +
                                `${shards[wave[k]].length} conversation(s) of batch ${finished + 1} delivered — ` +
                                `keeping those, and asking for the other ${missing.length} again at the end`,
                        });
                    } else if (why === "idle-timeout" || why === "timeout") {
                        stop = true;
                        timedOut = true;
                        onStatus({
                            phase: "warn",
                            detail: `timed out after ${finished}/${shards.length} batch(es) — keeping what arrived`,
                        });
                        break;
                    }
                    // Served or refused, this shard is settled: a resume must
                    // not ask the phone for it again.
                    schedule.settle(wave[k]);
                    // A message session that was prompted (status 3) rather than
                    // authorized outright (5) cost the user a second tap.
                    if (schedule.resumes() && sessions.get(m.sid).statuses.some((st) => Number(st) === 3)) {
                        rePrompted = true;
                    }
                    const served = sessions.get(m.sid);
                    if (why === "error") {
                        // Keep the part that did arrive: one bad frame must not drop a whole shard.
                        onStatus({
                            phase: "warn",
                            detail: `batch failed: ${JSON.stringify(served.err)} — keeping the part that arrived`,
                        });
                    }
                    const failedHere = served.failures.length + (served.err ? 1 : 0);
                    failedBatches += failedHere;
                    batchStats.failed += failedHere;
                    batchStats.total += served.batches.length + failedHere;
                    if (shouldAbortOnFailures(batchStats)) {
                        stop = true;
                        tooManyFailures = true;
                        onStatus({
                            phase: "warn",
                            detail: `${batchStats.failed} of ${batchStats.total} batches failed — stopping and keeping what arrived`,
                        });
                    }

                    const before = messagesSaved;
                    const read = await eachChunkObj(sessions.get(m.sid), m.ek, M.SyncChunk, storeChunk);

                    // Batches that could not be downloaded count as failed ones, and can stop the run like any other.
                    if (read.downloadFailures.length) {
                        failedBatches += read.downloadFailures.length;
                        batchStats.failed += read.downloadFailures.length;
                        if (shouldAbortOnFailures(batchStats) && !tooManyFailures) {
                            stop = true;
                            tooManyFailures = true;
                            onStatus({
                                phase: "warn",
                                detail: `${batchStats.failed} of ${batchStats.total} batches failed — stopping and keeping what arrived`,
                            });
                        }
                    }

                    // The partitions of this shard now stand done, failed, or (a session that ended early) pending.
                    if (served.err) sessionErrors++;
                    settleRanges(shards[wave[k]], served);
                    // The session is released with the others of its wave below, not now: Web and PC release a run's
                    // sessions together once all are consumed (capture CS1: four 591 within 3 ms, none between two
                    // 590s). The phone stops serving at about 32 sessions open together, which a wave never reaches.
                    if (served.err || served.failures.length) served.disposeReason ??= DISPOSE_REASON.ERROR;

                    finished++;
                    // Per-shard progress: without it a 50-shard run prints nothing
                    // between "50 batch(es)" and the final total, so a stall looks
                    // exactly like work in progress.
                    onStatus({
                        phase: "progress",
                        detail: `batch ${finished}/${shards.length} — ${messagesSaved - before} new message(s), ${messagesSaved} total`,
                    });
                }

                // A wave that was consumed whole: let go of its sessions together, back to back (the next request
                // waits for the acks, see sendRequest). One that stopped early is released by the end of the run,
                // each with its own reason (cancelled, declined, failed); one that lost the socket is released by
                // the first move on the next socket (releaseAbandoned).
                if (!lostSocket && !stop) await disposeTogether(waveMeta.map((m) => m.sid));
                if (!lostSocket) continue;
                socketDied = true;
                onStatus({
                    phase: "warn",
                    detail:
                        `connection lost after ${finished}/${shards.length} batch(es) — keeping what arrived` +
                        (closeInfo
                            ? ` [close ${closeInfo.code}${closeInfo.reason ? ": " + closeInfo.reason : ""}]`
                            : " [no close event seen]"),
                });
                // Re-tapping the phone is the expensive part of this command, so
                // a dropped wire is worth a few reconnects before giving the tap
                // up. The shards already served stay served; only what is still
                // pending goes out again. Worst case the phone prompts once more
                // -- which is exactly what a manual re-run would have cost, and
                // that run would have had to re-fetch everything as well.
                if (schedule.useResume() && (await reconnect())) {
                    socketDied = false;
                    // What Web does first on a socket it opens: release, with reason 3, every session the
                    // previous socket left open (cleanOldSyncSession; capture After-CS6: three 591 before any 590),
                    // and count sessions from 0 again, as a new sync does. The sessions of the dead socket are
                    // gone with it; asking on without releasing them left up to 39 of them open on the phone.
                    await channel.releaseAbandoned();
                    channel.resetUssidx(1); // 0 is the conversation round, which a resume does not repeat
                    // The remaining shards still need their own time; the
                    // reconnect must not eat the budget they were owed.
                    runDeadline = Date.now() + shardBudget(schedule.remaining());
                    onStatus({
                        phase: "reconnect",
                        detail: `reconnected — re-requesting the ${schedule.remaining()} batch(es) that never arrived (attempt ${schedule.resumes()} of ${resolveMaxResumes(opts.maxResumes)})`,
                    });
                    continue;
                }
                stop = true;
            }
            // A range the phone could not serve is asked for once more, in sessions of its own (Y2b). One that
            // fails again stays failed for the next run: the phone may simply not have it ready.
            if (!stop && !declined && failedRanges.size) {
                const again = todo.filter((q) => failedRanges.has(q.partition));
                runDeadline = Date.now() + shardBudget(Math.ceil(again.length / shardSize));
                onStatus({
                    phase: "messages",
                    detail: `asking once more for ${again.length} conversation(s) the phone could not serve`,
                });
                for (let i = 0; i < again.length; i += shardSize) {
                    const queries = again.slice(i, i + shardSize);
                    const ek = zproto.generateKeyPair();
                    const sid = newSession(
                        "msg",
                        queries.map((q) => q.partition),
                    );
                    const sent = await sendRequest("msg", sid, ek, {
                        type: "message",
                        priority: 2,
                        batchSize: 2000,
                        queries,
                    });
                    if (sent.socketClosed) break;
                    rangeInfo.retried += queries.length;
                    const left = runDeadline - Date.now();
                    const why = left > 0 ? await waitDone(sid, left) : "timeout";
                    if (why === "cancelled") cancelled = true;
                    if (
                        why === "cancelled" ||
                        why === "socket-closed" ||
                        why === "declined" ||
                        why === "stalled" ||
                        why === "idle-timeout" ||
                        why === "timeout"
                    )
                        break;
                    const retried = sessions.get(sid);
                    await eachChunkObj(retried, ek, M.SyncChunk, storeChunk);
                    const had = new Set(failedRanges.keys());
                    settleRanges(queries, retried);
                    if (retried.err || retried.failures.length) retried.disposeReason ??= DISPOSE_REASON.ERROR;
                    disposeOne(sid);
                    rangeInfo.recovered += queries.filter(
                        (q) => had.has(q.partition) && !failedRanges.has(q.partition),
                    ).length;
                }
            }
            if (rePrompted) {
                onStatus({
                    phase: "warn",
                    detail:
                        "the resumed request needed a fresh confirmation — " +
                        "the reconnect did not inherit the first one",
                });
            }
            resumeInfo = { resumes: schedule.resumes(), rePrompted, ranges: { ...rangeInfo, ...countSyncRanges() } };
            if (declined) throw declineError(declined);
            // A cut-short run is not a failure and not a settled window: what arrived is kept, nothing is recorded.
            if (cancelled) throw cancelError();
            const outcome = describeRestoreOutcome({
                // A range that failed and was recovered by the retry is not a failed batch any more.
                failedBatches: failedRanges.size || sessionErrors || tooManyFailures ? failedBatches : 0,
                tooManyFailures,
                socketDied,
                timedOut,
                confirmed,
                messagesSaved,
                rowErrors,
                finished,
                total: shards.length,
                resumes: schedule.resumes(),
                waitMs,
            });
            if (outcome.error) throw new Error(outcome.error);
            reason = outcome.reason;
            // Only a run that settled its window counts as a success (Y5a). A partial one records none: the
            // next run asks again, and (with the ranges kept above) only for what it did not get.
            if (reason === "complete") recordRestoreSuccess(win, { resolveGaps: true });
        } catch (e) {
            if (e?.cancelled) {
                cancelled = true;
                reason = "cancelled";
            } else {
                runError = e;
                throw e;
            }
        } finally {
            // Every session still open is released with the reason that fits how the run ended: the phone's own
            // reason when it ended the session (a "no" has one), cancelled for a run the person stopped, finished
            // for a run that settled its window, failed for one that did not (Y6a). The acks are awaited; on a
            // dead wire this fails fast.
            const settled = !runError && (reason === "complete" || reason === "empty-window");
            await channel.releaseAll((id) => {
                const s = sessions.get(id);
                if (Number.isInteger(s?.disposeReason)) return s.disposeReason;
                // A stop leaves finished sessions finished: only the ones still waiting are cancelled.
                if (cancelled) return s?.done ? DISPOSE_REASON.SUCCESS : DISPOSE_REASON.CANCELLED;
                return settled ? undefined : DISPOSE_REASON.ERROR;
            });
            detachSocketTaps();
            try {
                detachLive();
            } catch {}
        }
        return done(reason);
    }

    _result(conversations, messagesSaved, mapped, unmapped, reason, extra = {}) {
        return {
            conversations,
            messagesSaved,
            threadsMapped: mapped.size,
            threadsUnmapped: unmapped.size,
            reason,
            ...extra,
        };
    }
}
