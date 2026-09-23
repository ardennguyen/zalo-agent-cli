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
} from "../db.js";
import { ensureAssets, loadCodecs } from "./assets.js";
import { classifySyncMessage } from "./message-types.js";
import { resolveNonFriendDms } from "./gid.js";
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
/**
 * How many message sessions may be open on the phone at once. Zalo Web
 * opens four; fifty at once got the socket dropped with no error frame.
 */
const DEFAULT_WAVE_SIZE = 4;
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

export function isSessionComplete(state) {
    if (!state) return false;
    if (state.sawLast) return true;
    const want = state.want?.size ?? 0;
    if (!want) return false; // conversation round: only isLast can end it
    return (state.covered?.size ?? 0) >= want;
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
 * @returns {string}
 */
function syncMsgId(msg) {
    const gid = msg?.globalId;
    if (gid !== undefined && gid !== null && String(gid) !== "0" && String(gid) !== "") return String(gid);
    return String(msg?.clientId ?? "");
}

export class SyncV2 {
    /**
     * @param {object} api - a logged-in zca-js API (from getApi()).
     * @param {string} accountName - ownId; picks the account data dir.
     */
    constructor(api, accountName) {
        this.api = api;
        this.accountName = accountName;
        this.accountDir = resolve(
            process.env.USERPROFILE || process.env.HOME || "",
            ".zalo-agent-cli",
            "accounts",
            accountName,
        );
    }

    /** Build opaque-globalId -> {id, name, type} from the friend + group lists. */
    async _buildThreadMap(log) {
        const map = new Map();
        try {
            const friends = await this.api.getAllFriends();
            const arr = Array.isArray(friends) ? friends : friends?.data || [];
            for (const f of arr)
                if (f.globalId)
                    map.set(f.globalId, { id: String(f.userId), name: f.displayName || f.zaloName || "", type: "dm" });
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

    _send590(listener, kind, syncId, ek, ik, req) {
        listener.sendWs(
            {
                version: 1,
                cmd: 590,
                subCmd: 0,
                data: {
                    data: {
                        syncId,
                        syncType: 0,
                        ek: b64(ek.publicKey),
                        ik: b64(ik.publicKey),
                        toDevice: 0,
                        tempKey: "",
                        deviceName: "zalo-agent-cli",
                        req,
                        ver: 1,
                        ussidx: 0,
                    },
                    reqId: `req_${kind}_${syncId.slice(0, 6)}`,
                },
            },
            false,
        );
    }
    _dispose(listener, syncId) {
        listener.sendWs(
            { version: 1, cmd: 591, subCmd: 0, data: { data: { syncId, toDevice: 0, reason: 1 }, reqId: "req_disp" } },
            false,
        );
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
     * @returns {Promise<{conversations:number, messagesSaved:number, threadsMapped:number, threadsUnmapped:number, reason:string, days:number|null, from:number, confirmed:boolean}>}
     */
    async restore(opts = {}) {
        const shardSize = Math.min(30, Math.max(1, opts.shardSize || 30));
        const waveSize = Math.min(30, Math.max(1, opts.waveSize || DEFAULT_WAVE_SIZE));
        const waitMs = Math.max(30000, opts.waitMs || 120000);
        const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
        const log = (m) => onStatus({ phase: "info", detail: m });
        // The caller announces the window (it also decides the debounce on it);
        // it comes back on the result too, so no status line is emitted here.
        const win = resolveSyncWindow(opts.days, Date.now(), opts.from);

        onStatus({ phase: "assets", detail: "loading decryption assets" });
        const assets = await ensureAssets(resolve(this.accountDir, "sync", "zproto-cache"), log);
        const { zproto, M, C } = await loadCodecs(assets);

        onStatus({ phase: "contacts", detail: "reading friend/group lists for thread mapping" });
        const threadMap = await this._buildThreadMap(log);

        initDb(resolve(this.accountDir, "zalo.db"));

        const L = this.api.listener;
        const sessions = new Map(); // syncId -> {kind, batches:[], statuses:[], done, err}
        const onMsg = async (buf) => {
            if (!(buf instanceof Buffer) || buf.length < 4 || buf.readUInt16LE(1) !== 601) return;
            let parsed;
            try {
                parsed = JSON.parse(buf.subarray(4).toString("utf8"));
            } catch {
                return;
            }
            let d;
            try {
                d =
                    typeof parsed.data === "string" && typeof parsed.encrypt === "number"
                        ? decodeFrame(parsed, L.cipherKey)
                        : parsed;
            } catch {
                return;
            }
            for (const c of d?.data?.controls || []) {
                if (c?.content?.act_type !== "transfer_sync2") continue;
                let dj = c.content.data;
                try {
                    dj = JSON.parse(dj);
                } catch {}
                const s = sessions.get(dj?.syncId);
                if (!s) continue;
                if (c.content.act === "transfer_status") {
                    s.statuses.push(dj.status);
                    if (dj.status === 3)
                        onStatus({
                            phase: "confirm",
                            detail: "Confirm the sync request on your phone (tap ĐỒNG BỘ NGAY)",
                        });
                } else if (c.content.act === "upload_batch") {
                    s.batches.push(dj);
                    for (const sc of dj.scopes || []) if (sc?.partition) s.covered.add(sc.partition);
                    if (dj.isLast) s.sawLast = true;
                    s.done = isSessionComplete(s);
                } else if (/error/i.test(c.content.act)) {
                    s.err = dj;
                }
            }
        };
        L.ws.on("message", onMsg);

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
        const onClose = (code, reason) => {
            closeInfo = { code, reason: String(reason || "") };
            onStatus({
                phase: "warn",
                detail: `socket closed (code ${code}${closeInfo.reason ? ": " + closeInfo.reason : ""})`,
            });
        };
        const onSockErr = (e) => {
            closeInfo = closeInfo || { code: "error", reason: e?.message || String(e) };
            onStatus({ phase: "warn", detail: `socket error: ${closeInfo.reason}` });
        };
        try {
            L.ws.on("close", onClose);
            L.ws.on("error", onSockErr);
        } catch {
            /* an older ws shape without these events is not fatal */
        }

        const newSession = (kind, wantPartitions = []) => {
            const id = randId();
            sessions.set(id, {
                kind,
                batches: [],
                statuses: [],
                done: false,
                sawLast: false,
                err: null,
                disposed: false,
                // Completion is measured by coverage: every partition asked for
                // has to come back in some batch's `scopes`.
                want: new Set(wantPartitions.filter(Boolean)),
                covered: new Set(),
            });
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
            while (!s.done && !s.err && Date.now() < dl) {
                // A closed socket can never deliver the rest, so stop now
                // instead of burning the whole budget waiting on a dead wire.
                // zca-js sets `this.ws = null` on close, so an absent socket is
                // just as dead as one reporting CLOSING/CLOSED -- checking only
                // readyState missed every real disconnect.
                if (!L.ws || L.ws.readyState > 1) return "socket-closed";
                await new Promise((r) => setTimeout(r, 300));
            }
            if (s.err) return "error";
            if (s.done) return "done";
            return "timeout";
        };

        /** Dispose one session the moment it finishes, as Zalo Web does. */
        const disposeOne = (id) => {
            const s = sessions.get(id);
            if (!s || s.disposed) return;
            s.disposed = true;
            try {
                this._dispose(L, id);
            } catch {
                /* the socket may already be gone; nothing to release */
            }
        };

        const ik = zproto.generateKeyPair();
        let conversations = 0,
            messagesSaved = 0,
            attachmentsSaved = 0;
        const mappedThreads = new Set(),
            unmappedThreads = new Set();
        /** type name -> count, for the command's summary line. */
        const typeCounts = Object.create(null);
        let reason = "complete";
        // Did the phone actually answer? transfer_status 4 = Confirmed,
        // 5 = Authorized. Needed to tell "empty window" from "never tapped".
        let confirmed = false;
        const done = (r) =>
            this._result(conversations, messagesSaved, mappedThreads, unmappedThreads, r, {
                days: win.days,
                from: win.from,
                confirmed,
                attachmentsSaved,
                typeCounts: { ...typeCounts },
                // Every threadId the conversation round accounted for. Anything
                // cached outside this list is orphaned.
                liveThreadIds: [...mappedThreads, ...unmappedThreads],
            });

        // decrypt one session's batches -> decoded proto objects
        const eachChunkObj = async (s, ek, protoClass, onObj) => {
            let sessionRecord = null;
            const ordered = s.batches
                .slice()
                .sort((a, b) => (a.batchType === 2 ? -1 : 1) - (b.batchType === 2 ? -1 : 1) || a.idx - b.idx);
            for (const bt of ordered) {
                if (!bt.msgUrl) continue;
                await new Promise((r) => setImmediate(r));
                let blob;
                try {
                    const r = await fetch(bt.msgUrl);
                    if (!r.ok) continue;
                    blob = Buffer.from(await r.arrayBuffer());
                } catch {
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
                        onObj(obj);
                    } catch {
                        /* skip bad chunk */
                    }
                }
            }
        };

        try {
            await new Promise((r) => setTimeout(r, 1200));

            // ---- conversation round ----
            const ekConv = zproto.generateKeyPair();
            const convId = newSession("conv");
            onStatus({ phase: "conversation", detail: "requesting your conversation list" });
            this._send590(L, "conv", convId, ekConv, ik, {
                type: "conversation",
                priority: 0,
                batchSize: 2000,
                queries: [{ partition: "", from: win.from, to: win.to, limit: 2147483647 }],
            });
            const convWhy = await waitDone(convId, waitMs);
            const convSession = sessions.get(convId);
            if (convSession.err) throw new Error(`conversation round failed: ${JSON.stringify(convSession.err)}`);
            if (convWhy === "socket-closed") throw new Error("connection dropped while waiting for the phone");
            confirmed = convSession.statuses.some((st) => Number(st) >= 4);

            const convs = [];
            await eachChunkObj(convSession, ekConv, C.SyncChunk, (obj) => {
                for (const c of obj.conversationsList || []) convs.push(c);
            });
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
                    for (const [gid, v] of extra) threadMap.set(gid, { id: v.id, name: v.name, type: "dm" });
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
            const shards = [];
            for (let i = 0; i < partitions.length; i += shardSize) shards.push(partitions.slice(i, i + shardSize));
            onStatus({ phase: "messages", detail: `${conversations} conversations in ${shards.length} batch(es)` });

            // ---- message rounds (sharded) ----
            // Requests go out in waves. Zalo Web opens at most FOUR message
            // sessions at once and the phone serves them one at a time; firing
            // all fifty shards of a full-history run at once got the socket
            // dropped with no error frame, so the in-flight count is capped.
            // Within a wave the requests still go out together, which is what
            // makes them inherit the single confirmation.
            const waves = [];
            for (let i = 0; i < shards.length; i += waveSize) waves.push(shards.slice(i, i + waveSize));
            const sendWave = async (wave) => {
                const meta = [];
                for (const shard of wave) {
                    const ek = zproto.generateKeyPair();
                    const sid = newSession(
                        "msg",
                        shard.map((q) => q.partition),
                    );
                    meta.push({ sid, ek });
                    this._send590(L, "msg", sid, ek, ik, {
                        type: "message",
                        priority: 2,
                        batchSize: 2000,
                        queries: shard,
                    });
                    await new Promise((r) => setTimeout(r, 600));
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
            const runBudget = Math.max(waitMs, shards.length * PER_SHARD_BUDGET_MS);
            const runDeadline = Date.now() + runBudget;
            onStatus({
                phase: "messages",
                detail: `waiting up to ${Math.round(runBudget / 60000)} min for the phone to serve ${shards.length} batch(es)`,
            });
            let finished = 0;
            let socketDied = false;
            let stop = false;
            const shardMeta = [];

            // ---- wave by wave: send, wait, decrypt, decode, store ----
            // Storing per shard rather than after all of them means an
            // interrupted run keeps what it already pulled.
            for (const wave of waves) {
                if (stop) break;
                const waveMeta = await sendWave(wave);
                shardMeta.push(...waveMeta);
                for (const m of waveMeta) {
                    const left = runDeadline - Date.now();
                    const why = left > 0 ? await waitDone(m.sid, left) : "timeout";
                    if (why === "socket-closed") {
                        socketDied = true;
                        stop = true;
                        onStatus({
                            phase: "warn",
                            detail:
                                `connection lost after ${finished}/${shards.length} batch(es) — keeping what arrived` +
                                (closeInfo
                                    ? ` [close ${closeInfo.code}${closeInfo.reason ? ": " + closeInfo.reason : ""}]`
                                    : " [no close event seen]"),
                        });
                        break;
                    }
                    if (why === "timeout") {
                        stop = true;
                        onStatus({
                            phase: "warn",
                            detail: `timed out after ${finished}/${shards.length} batch(es) — keeping what arrived`,
                        });
                        break;
                    }
                    if (why === "error") {
                        onStatus({ phase: "warn", detail: `batch failed: ${JSON.stringify(sessions.get(m.sid).err)}` });
                        continue;
                    }

                    const before = messagesSaved;
                    await eachChunkObj(sessions.get(m.sid), m.ek, M.SyncChunk, (obj) => {
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
                                    try {
                                        upsertThread({
                                            threadId,
                                            type: hit ? hit.type : isGroup ? "group" : "dm",
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
                                            msgId: syncMsgId(msg),
                                            threadId,
                                            senderId: String(msg.senderId || ""),
                                            senderName: "",
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
                                    } catch {
                                        /* dedupe/constraint — keep going */
                                    }
                                }
                            }
                        });
                    });

                    finished++;
                    // Per-shard progress: without it a 50-shard run prints nothing
                    // between "50 batch(es)" and the final total, so a stall looks
                    // exactly like work in progress.
                    onStatus({
                        phase: "progress",
                        detail: `batch ${finished}/${shards.length} — ${messagesSaved - before} new message(s), ${messagesSaved} total`,
                    });
                }
            }
            if (socketDied && !messagesSaved) throw new Error("connection dropped before any messages arrived");
            if (finished < shards.length) reason = "partial";
            // A partial run still records success (unchanged), so the next run
            // within the hour is skipped unless --force -- but it settles no gap.
            recordRestoreSuccess(win, { resolveGaps: reason === "complete" });
        } finally {
            for (const id of sessions.keys()) {
                try {
                    this._dispose(L, id);
                } catch {}
            }
            await new Promise((r) => setTimeout(r, 1500));
            try {
                L.ws.removeListener("message", onMsg);
            } catch {}
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
