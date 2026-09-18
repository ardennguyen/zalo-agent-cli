import fs from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { CONFIG_DIR } from "./credentials.js";
import {
    initDb,
    insertMessage,
    upsertThread,
    getSyncState,
    setSyncState,
    recordSyncGap,
    getPendingSyncGaps,
    resolveAllPendingSyncGaps,
} from "./db.js";

function resolveAccountDir(accountName) {
    return resolve(CONFIG_DIR, "accounts", accountName);
}

/** Zalo Web's own client only ever seems to backfill about this far on a
 * fresh login (confirmed by live observation — see agent/docs/mobile-sync-
 * live-test-results.md, task #4). Clamp any gap we ask the mobile app to
 * fill to this width so we never request something the platform wouldn't
 * honor anyway, and so a very old `lastConnectedAt` (e.g. the tool sat
 * uninstalled for months) doesn't produce a nonsensical multi-month ask. */
export const MAX_GAP_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Best-effort field aliases for a single synced message, mirroring the shape
 * `src/commands/listen.js` already normalizes live WS messages into before
 * calling insertMessage()/upsertThread(). The exact shape of a `get_crossdb`
 * message record hasn't been confirmed against real data yet (see
 * agent/docs/mobile-sync-live-test-results.md) — this stays defensive and
 * falls back to the raw dump file whenever a record doesn't look recognizable,
 * rather than silently dropping or mis-storing it.
 */
function normalizeSyncedMessage(raw) {
    if (!raw || typeof raw !== "object") return null;

    const msgId = raw.msgId ?? raw.msg_id ?? raw.cliMsgId ?? raw.cli_msg_id;
    const threadId = raw.threadId ?? raw.toId ?? raw.to_uid ?? raw.groupId ?? raw.uidTo;
    if (!msgId || !threadId) return null;

    const senderId = raw.uidFrom ?? raw.fromUid ?? raw.senderId ?? raw.from_uid ?? "";
    const senderName = raw.dName ?? raw.displayName ?? raw.senderName ?? "";
    const rawContent = raw.content ?? raw.text ?? raw.msg ?? null;
    const isText = typeof rawContent === "string";
    const msgType = raw.msgType ?? raw.msg_type ?? null;
    const timestamp = raw.ts ? Number(raw.ts) : raw.timestamp ? Number(raw.timestamp) : Date.now();
    const isGroup = raw.type === 1 || raw.isGroup === true || !!raw.groupId;

    return {
        msgId: String(msgId),
        threadId: String(threadId),
        senderId: String(senderId),
        senderName: String(senderName),
        text: isText ? rawContent : (rawContent ? JSON.stringify(rawContent) : ""),
        timestamp,
        type: isText ? "text" : msgType || "attachment",
        raw_data: rawContent,
        threadType: isGroup ? "group" : "dm",
    };
}

/** Pull out a plausible array of message-like records from whatever shape
 * getCrossDB's decrypted payload turns out to have (object/array/JSON string). */
function extractMessageRecords(payload) {
    let parsed = payload;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return []; // not JSON — nothing we can map into rows
        }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
        for (const key of ["msgs", "messages", "data", "list", "items"]) {
            if (Array.isArray(parsed[key])) return parsed[key];
        }
    }
    return [];
}

export class SyncManager {
    constructor(api, accountName) {
        this.api = api;
        this.accountName = accountName;
        this.accountDir = resolveAccountDir(accountName);
        this.syncSessionDir = resolve(this.accountDir, "sync");
        if (!fs.existsSync(this.syncSessionDir)) {
            fs.mkdirSync(this.syncSessionDir, { recursive: true });
        }
        this.keys = this._loadOrGenerateKeys();
        this.dbInitialized = false;
    }

    _loadOrGenerateKeys() {
        const keyFile = resolve(this.syncSessionDir, "rsa_keys.json");
        if (fs.existsSync(keyFile)) {
            return JSON.parse(fs.readFileSync(keyFile, "utf8"));
        }
        const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        const pubKeyRaw = publicKey
            .replace(/-----BEGIN PUBLIC KEY-----/g, "")
            .replace(/-----END PUBLIC KEY-----/g, "")
            .replace(/\n/g, "");
        const keys = { publicKey: pubKeyRaw, privateKey };
        fs.writeFileSync(keyFile, JSON.stringify(keys), "utf8");
        return keys;
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
     * reports "connected", or right after startup with no prior gap) so the
     * debounce check in pollSync() has an accurate picture. */
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
     * One full sync cycle:
     *  1. pullMobileMsg() — nudges the phone and gets back a short opaque
     *     token (confirmed live: 64 raw bytes, NOT message content — see
     *     agent/docs/mobile-sync-live-test-results.md). Earlier code treated
     *     this token itself as "the sync data" and stopped here, which meant
     *     it never actually retrieved anything.
     *  2. getCrossDB(token) — the actual retrieval call. Only call this once
     *     we have a token from step 1.
     *  3. Parse + store whatever comes back into zalo.db via the same
     *     insertMessage()/upsertThread() helpers the `listen` daemon uses.
     *  4. deleteSnapshotMobileMsg() to ack completion, regardless of whether
     *     step 3 found anything, so the pending server-side request is
     *     cleaned up either way.
     *
     * By default this is gap-aware and debounced (task #3): if we have no
     * recorded pending gap and our last known connection state was healthy,
     * it returns `{status: "already-synced", cached: true}` immediately
     * instead of calling the mobile API — mirroring what Zalo Web itself does
     * (confirmed live: its own IndexedDB `missing_message_range` table is
     * what gates whether clicking "Sync" re-pings the phone or just reports
     * success instantly). Pass `{force: true}` to bypass this and always hit
     * the API, e.g. for the explicit `sync-mobile` CLI command.
     */
    async pollSync(fromSeqId = 0, isRetry = 0, opts = {}) {
        const force = opts === true || opts?.force === true; // tolerate old boolean-ish callers
        this._ensureDb();

        if (!force) {
            const pending = getPendingSyncGaps();
            const connectionOk = getSyncState("lastConnectionOk");
            if (pending.length === 0 && connectionOk === "true") {
                console.log(`[Sync] No known coverage gap and connection state is healthy — skipping API call.`);
                return { status: "already-synced", cached: true };
            }
        }

        console.log(`[Sync] Requesting mobile push (pullMobileMsg)...`);
        const pullRes = await this.api.pullMobileMsg(this.keys.publicKey, fromSeqId, isRetry, "");
        const token = this._unwrap(pullRes);
        if (!token) {
            console.log(`[Sync] No session token returned — nothing to pull yet.`);
            return { status: "no-token", raw: pullRes };
        }

        console.log(`[Sync] Got sync session token, calling getCrossDB...`);
        let crossDbRes;
        try {
            crossDbRes = await this.api.getCrossDB(token);
        } catch (e) {
            console.error(`[Sync] getCrossDB failed:`, e.message);
            return { status: "crossdb-error", error: e.message, token };
        }

        const payload = this._unwrap(crossDbRes);
        const result = await this.processSyncData(payload, token);

        try {
            await this.api.deleteSnapshotMobileMsg(this.keys.publicKey);
        } catch (e) {
            console.error(`[Sync] deleteSnapshotMobileMsg failed (non-fatal):`, e.message);
        }

        // A completed round-trip (even one that found nothing new) means
        // we've genuinely asked the server "what did I miss?" and gotten an
        // answer, so whatever gaps we knew about are covered now.
        resolveAllPendingSyncGaps();
        setSyncState("lastFullSyncAt", Date.now());
        setSyncState("lastConnectionOk", "true");

        return result;
    }

    /** zca-js's apiFactory convention isn't 100% consistent about whether a
     * raw method return is the payload itself or `{data: payload, ...}` —
     * handle both without guessing wrong silently. */
    _unwrap(res) {
        if (res && typeof res === "object" && "data" in res && Object.keys(res).length <= 2) {
            return res.data;
        }
        return res;
    }

    async processSyncData(payload, token) {
        // Always keep the raw dump — cheap forensic safety net regardless of
        // whether structured parsing below succeeds.
        const dumpFile = resolve(this.syncSessionDir, `sync_dump_${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify({ token, payload }), "utf8");

        const records = extractMessageRecords(payload);
        if (records.length === 0) {
            console.log(
                `[Sync] getCrossDB returned no recognizable message records (dumped raw to ${dumpFile}). ` +
                    `This is expected if there's no real offline gap right now, or means the payload shape ` +
                    `needs re-checking against agent/docs/mobile-sync-live-test-results.md.`,
            );
            return { status: "empty-or-unrecognized", dumpFile };
        }

        const threadsTouched = new Map();
        let saved = 0;
        for (const raw of records) {
            const msg = normalizeSyncedMessage(raw);
            if (!msg) continue;
            try {
                insertMessage({
                    msgId: msg.msgId,
                    threadId: msg.threadId,
                    senderId: msg.senderId,
                    senderName: msg.senderName,
                    text: msg.text,
                    timestamp: msg.timestamp,
                    type: msg.type,
                    raw_data: msg.raw_data,
                });
                if (!threadsTouched.has(msg.threadId) || threadsTouched.get(msg.threadId) < msg.timestamp) {
                    threadsTouched.set(msg.threadId, msg.timestamp);
                    upsertThread({
                        threadId: msg.threadId,
                        type: msg.threadType,
                        name: msg.senderName,
                        lastUpdate: msg.timestamp,
                        sync_timestamp: Date.now(),
                    });
                }
                saved++;
            } catch (e) {
                console.error(`[Sync] Failed to save message ${msg.msgId}:`, e.message);
            }
        }

        console.log(`[Sync] Saved ${saved}/${records.length} synced messages to zalo.db (dump: ${dumpFile}).`);
        return { status: "saved", saved, total: records.length, dumpFile };
    }
}
