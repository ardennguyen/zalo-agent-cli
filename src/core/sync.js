import { resolve } from "path";
import { getAccountDir } from "./credentials.js";
import {
    initDb,
    getSyncState,
    setSyncState,
    recordSyncGap,
    countSyncRanges,
    getPendingSyncGaps,
    resolveAllPendingSyncGaps,
} from "./db.js";
import { storeLiveMessage } from "./live-store.js";

/** zca-js ThreadType values, mirrored so this module doesn't import the enum. */
const THREAD_TYPE_USER = 0;
const THREAD_TYPE_GROUP = 1;

function resolveAccountDir(accountName) {
    return resolve(getAccountDir(accountName));
}

/** Zalo Web's own client only ever seems to backfill about this far on a
 * fresh login (confirmed by live observation — see agent/docs/mobile-sync-
 * live-test-results.md, task #4). Clamp any gap we ask the mobile app to
 * fill to this width so we never request something the platform wouldn't
 * honor anyway, and so a very old `lastConnectedAt` (e.g. the tool sat
 * uninstalled for months) doesn't produce a nonsensical multi-month ask. */
export const MAX_GAP_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * How recently a sync must have completed for a fresh one to be treated as
 * redundant and skipped. This is the CLI equivalent of Zalo Web's own
 * redundant-sync gate: after a successful sync, Zalo Web sets a
 * `0_sufficient_msg_ts` marker and records the run in `0_sync_download_stats_v1`,
 * and clicking "Đồng bộ tin nhắn" again while those are fresh is a silent no-op —
 * it never re-opens the transfer session, so it never re-pings the phone
 * (confirmed by a live capture, 2026-09-21). Bypass with `{force: true}`
 * (the `sync-mobile --force` flag).
 */
export const SYNC_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour

export class SyncManager {
    constructor(api, accountName) {
        this.api = api;
        this.accountName = accountName;
        this.accountDir = resolveAccountDir(accountName);
        this.dbInitialized = false;
    }

    /** Lazily open the same zalo.db the `listen` daemon uses, so synced
     * messages land in the exact same queryable cache as live-listened ones,
     * and so gap/state bookkeeping is shared between `listen` and `sync-mobile`
     * regardless of which one runs first. */
    _ensureDb() {
        if (this.dbInitialized) return;
        initDb(resolve(this.accountDir, "zalo.db"));
        this.dbInitialized = true;
    }

    /**
     * Record that we know of (or suspect) a gap in coverage between `fromTs`
     * and `toTs` (ms epoch). Called by `listen` on startup and on
     * disconnect/reconnect so a crash or closed listener gets backfilled on
     * next launch (task #4), and by callers that just want to force a fresh
     * check. Clamped to MAX_GAP_MS and to "not before epoch 0 / not in the
     * future" so bad inputs can't produce a nonsensical request.
     */
    recordGap(fromTs, toTs = Date.now(), reason = "unknown") {
        this._ensureDb();
        const safeTo = Math.min(toTs, Date.now());
        const safeFrom = Math.max(0, Math.max(fromTs, safeTo - MAX_GAP_MS));
        if (safeTo - safeFrom < 1000) return null; // not worth tracking (<1s)
        const id = recordSyncGap(safeFrom, safeTo, reason);
        setSyncState("lastConnectionOk", "false");
        console.log(
            `[Sync] Recorded coverage gap #${id} (${reason}): ${new Date(safeFrom).toISOString()} → ${new Date(safeTo).toISOString()}`,
        );
        return id;
    }

    /** Called whenever we're confidently caught up (e.g. right after the WS
     * reports "connected", or right after startup with no prior gap) so
     * sync freshness checks have an accurate picture. */
    markConnected() {
        this._ensureDb();
        setSyncState("lastConnectedAt", Date.now());
        setSyncState("lastConnectionOk", "true");
    }

    markDisconnected() {
        this._ensureDb();
        setSyncState("lastDisconnectedAt", Date.now());
        setSyncState("lastConnectionOk", "false");
    }

    /** ms epoch of the last time we know we were connected/caught up, or
     * null if we've never recorded one (e.g. very first run ever). */
    getLastConnectedAt() {
        this._ensureDb();
        const v = getSyncState("lastConnectedAt");
        return v ? Number(v) : null;
    }

    /** ms epoch of the last time we know the WS dropped, or null. */
    getLastDisconnectedAt() {
        this._ensureDb();
        const v = getSyncState("lastDisconnectedAt");
        return v ? Number(v) : null;
    }

    /**
     * Record that a sync of `kind` just completed a full server round-trip.
     * This single marker is what {@link checkSyncFreshness} reads, so every
     * sync path that reaches the server should call it on success.
     *
     * @param {string} [kind] - which path completed ("backfill" | "transfer").
     * @param {{coveredFrom?: number}} [opts] - ms epoch this run reached back to,
     *   for the paths that know their window (transfer-sync does; the socket
     *   backfill does not). Recorded so a later, WIDER sync is not suppressed
     *   by {@link checkSyncFreshness}. Always rewritten, so the marker never
     *   describes an older run than `lastSyncOkAt`.
     */
    markSyncSuccess(kind = "sync", opts = {}) {
        this._ensureDb();
        setSyncState("lastSyncOkAt", Date.now());
        setSyncState("lastSyncOkKind", String(kind));
        setSyncState("lastSyncOkFrom", Number.isFinite(opts.coveredFrom) ? String(opts.coveredFrom) : "");
    }

    /**
     * ms epoch the last successful sync reached back to, or null when that
     * path never recorded a window (socket backfill, or a db written
     * before this marker existed).
     *
     * @returns {number|null}
     */
    getLastSyncCoveredFrom() {
        this._ensureDb();
        const v = getSyncState("lastSyncOkFrom");
        if (v === null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * ms epoch of the last successful sync round-trip across any path, or null
     * if we have never completed one. Reads only the unified `lastSyncOkAt`
     * marker (set by {@link markSyncSuccess}); a db written before that marker
     * existed simply reports null and syncs once to establish it, rather than
     * risk over-suppressing from an older per-path/attempt timestamp.
     *
     * @returns {number|null}
     */
    getLastSuccessfulSyncAt() {
        this._ensureDb();
        const v = getSyncState("lastSyncOkAt");
        return v ? Number(v) : null;
    }

    /**
     * Decide whether a sync can be skipped because we completed one recently
     * and know of no coverage gap — the CLI equivalent of Zalo Web's
     * redundant-sync debounce (see {@link SYNC_FRESHNESS_MS}), so repeated runs
     * don't spam the socket or, for the phone-waking transfer-sync path, the
     * owner's phone.
     *
     * A pending coverage gap always forces a sync, and so does an unfinished conversation range (a restore that
     * settled only part of its window), and so does `force`.
     * Otherwise we skip when the last success is younger than `freshnessMs` —
     * unless the caller is asking for a WIDER window than the last success
     * covered (`coversFrom` older than the recorded `lastSyncOkFrom`). A
     * `--days 1` run must not suppress a full-history run an hour later:
     * that is a request for data we do not have, not a redundant repeat.
     * `now`/`freshnessMs` are injectable for tests.
     *
     * @param {{force?: boolean, freshnessMs?: number, now?: number, coversFrom?: number}} [opts]
     * @returns {{skip: boolean, reason: string, lastSyncAt: number|null, ageMs: number|null, coveredFrom: number|null}}
     */
    checkSyncFreshness(opts = {}) {
        this._ensureDb();
        const force = opts.force === true;
        const freshnessMs = Number.isFinite(opts.freshnessMs) ? opts.freshnessMs : SYNC_FRESHNESS_MS;
        const now = Number.isFinite(opts.now) ? opts.now : Date.now();
        const lastSyncAt = this.getLastSuccessfulSyncAt();
        const ageMs = lastSyncAt === null ? null : Math.max(0, now - lastSyncAt);
        const coveredFrom = this.getLastSyncCoveredFrom();
        const out = (skip, reason) => ({ skip, reason, lastSyncAt, ageMs, coveredFrom });

        if (force) return out(false, "forced");
        if (getPendingSyncGaps().length > 0) return out(false, "pending-gap");
        // A restore that settled only part of its window left ranges behind: that is work to finish, however
        // recently the last run ended (Y5b).
        const ranges = countSyncRanges();
        if (ranges.pending + ranges.failed > 0) return out(false, "unfinished-ranges");
        if (lastSyncAt === null) return out(false, "never-synced");
        if (ageMs < freshnessMs) {
            const widening = Number.isFinite(opts.coversFrom) && coveredFrom !== null && coveredFrom > opts.coversFrom;
            return widening ? out(false, "wider-window") : out(true, "fresh");
        }
        return out(false, "stale");
    }

    /**
     * Backfill recent history straight from Zalo's servers over an already-open
     * WebSocket, writing it into the same zalo.db the `listen` daemon uses.
     *
     * Uses socket cmd 510 (DMs) and 511 (groups), subCmd 1, payload
     * `{first: true, lastId, preIds: []}` — which zca-js already speaks via
     * `listener.requestOldMessages()` and the `old_messages` event, so no
     * patch to the library is needed.
     *
     * MEASURED 2026-09-20, and worth knowing before trusting this: Zalo
     * returned an EMPTY set for both commands on the development account, both
     * with `lastId: null` and with the exact anchor ids Zalo Web sends. Zalo
     * Web gets the same empty answer and falls back to `transfer-sync-v2`
     * (cmd 590/591, libsignal), which is not implemented here. Treat this as a
     * cheap probe, not a guaranteed restore. See agent/work/transfer-sync-v2/NOTES.md § Mobile sync.
     *
     * The caller owns the socket: it must hold `daemon.lock`, start the
     * listener, and stop it afterwards. This method only issues the two
     * requests and persists whatever comes back.
     *
     * @param {import("zca-js").Listener} listener A started zca-js listener.
     * @param {{timeoutMs?: number, onBatch?: (info: object) => void}} [opts]
     * @returns {Promise<{status: string, saved: number, total: number, reason: string}>}
     */
    async backfillOverSocket(listener, opts = {}) {
        this._ensureDb();
        const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
        const onBatch = typeof opts.onBatch === "function" ? opts.onBatch : () => {};

        let saved = 0;
        let total = 0;
        const answered = new Set();

        return new Promise((resolve) => {
            let settled = false;
            let timer = null;

            const finish = (reason) => {
                if (settled) return;
                settled = true;
                listener.removeListener("old_messages", handler);
                if (timer) clearTimeout(timer);
                setSyncState("lastBackfillAt", Date.now());
                // A completed round-trip means we asked the server what we
                // missed and were answered, so known gaps are covered. But only
                // ARM the freshness debounce when we actually stored something —
                // an empty socket backfill (the common case here) must not mark
                // us "synced" and thereby suppress a real `sync-mobile --transfer`.
                // A timeout is a partial answer: it neither resolves gaps nor arms.
                if (reason === "complete") {
                    resolveAllPendingSyncGaps();
                    if (saved > 0) this.markSyncSuccess("backfill");
                }
                resolve({ status: "backfilled", saved, total, reason });
            };

            const handler = (msgs, threadType) => {
                answered.add(threadType);
                const batch = Array.isArray(msgs) ? msgs : [];
                total += batch.length;
                for (const msg of batch) {
                    if (this._persistSocketMessage(msg, threadType)) saved++;
                }
                onBatch({ threadType, count: batch.length, saved, total });
                // Both thread types have reported in — nothing more is coming.
                if (answered.has(THREAD_TYPE_USER) && answered.has(THREAD_TYPE_GROUP)) finish("complete");
            };

            listener.on("old_messages", handler);
            timer = setTimeout(() => finish("timeout"), timeoutMs);

            try {
                listener.requestOldMessages(THREAD_TYPE_USER);
                listener.requestOldMessages(THREAD_TYPE_GROUP);
            } catch (e) {
                console.error(`[Sync] requestOldMessages failed: ${e.message}`);
                finish("request-failed");
            }
        });
    }

    /**
     * Persist one `old_messages` entry through the listener's own writer.
     *
     * An `old_messages` entry is a live-encoded frame, so it goes through
     * storeLiveMessage exactly as a live one does. This used to carry its own
     * copy of the mapping -- documented as "the exact same field mapping the
     * listen daemon applies", which stopped being true when listen moved to
     * live-store. The copy stored the raw msgType (chat.photo) as the row type,
     * never set has_attachment (so a restored photo was overwritten to 0 and
     * sync-media never fetched it again), and named the conversation after the
     * message's SENDER.
     *
     * @returns {boolean} true when a row was written or a removal applied.
     */
    _persistSocketMessage(msg, threadType) {
        if (!msg?.data?.msgId || !msg.threadId) return false;
        try {
            const r = storeLiveMessage({
                threadId: msg.threadId,
                type: threadType,
                data: msg.data,
                isSelf: msg.isSelf,
            });
            if (!r.stored && r.reason)
                console.error(`[Sync] backfilled message ${msg.data.msgId} not stored: ${r.reason}`);
            return Boolean(r.stored);
        } catch (e) {
            console.error(`[Sync] Failed to save backfilled message ${msg.data.msgId}: ${e.message}`);
            return false;
        }
    }
}
