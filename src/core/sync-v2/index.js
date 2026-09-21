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
import { initDb, insertMessage, upsertThread, setSyncState } from "../db.js";
import { extractMessageText } from "../../utils/extract-message-text.js";
import { ensureAssets, loadCodecs } from "./assets.js";
import { resolveNonFriendDms } from "./gid.js";

const FROM_FLOOR = 1704067200000; // 2024-01-01; sync window lower bound
const MAX_TS = 9007199254740991;

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
     * Run the full restore. Assumes the caller holds the account lock. Manages
     * its own listener lifecycle.
     *
     * @param {object} [opts]
     * @param {number} [opts.shardSize=30] partitions per message round (server caps ~30).
     * @param {number} [opts.waitMs=120000] per-phase wait budget.
     * @param {(s: {phase: string, detail?: string}) => void} [opts.onStatus]
     * @returns {Promise<{conversations:number, messagesSaved:number, threadsMapped:number, threadsUnmapped:number, reason:string}>}
     */
    async restore(opts = {}) {
        const shardSize = Math.min(30, Math.max(1, opts.shardSize || 30));
        const waitMs = Math.max(30000, opts.waitMs || 120000);
        const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
        const log = (m) => onStatus({ phase: "info", detail: m });

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
                    if (dj.isLast) s.done = true;
                } else if (/error/i.test(c.content.act)) {
                    s.err = dj;
                }
            }
        };
        L.ws.on("message", onMsg);

        const newSession = (kind) => {
            const id = randId();
            sessions.set(id, { kind, batches: [], statuses: [], done: false, err: null });
            return id;
        };
        const waitDone = async (id) => {
            const dl = Date.now() + waitMs;
            const s = sessions.get(id);
            while (!s.done && !s.err && Date.now() < dl) await new Promise((r) => setTimeout(r, 300));
        };

        const ik = zproto.generateKeyPair();
        let conversations = 0,
            messagesSaved = 0;
        const mappedThreads = new Set(),
            unmappedThreads = new Set();
        let reason = "complete";

        // decrypt one session's batches -> decoded proto objects
        const eachChunkObj = async (s, ek, protoClass, onObj) => {
            let sessionRecord = null;
            const ordered = s.batches
                .slice()
                .sort((a, b) => (a.batchType === 2 ? -1 : 1) - (b.batchType === 2 ? -1 : 1) || a.idx - b.idx);
            for (const bt of ordered) {
                if (!bt.msgUrl) continue;
                let blob;
                try {
                    const r = await fetch(bt.msgUrl);
                    if (!r.ok) continue;
                    blob = Buffer.from(await r.arrayBuffer());
                } catch {
                    continue;
                }
                for (const chunk of splitChunks(blob)) {
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
                queries: [{ partition: "", from: FROM_FLOOR, to: MAX_TS, limit: 2147483647 }],
            });
            await waitDone(convId);
            const convSession = sessions.get(convId);
            if (convSession.err) throw new Error(`conversation round failed: ${JSON.stringify(convSession.err)}`);

            const convs = [];
            await eachChunkObj(convSession, ekConv, C.SyncChunk, (obj) => {
                for (const c of obj.conversationsList || []) convs.push(c);
            });
            conversations = convs.length;
            if (!conversations) {
                reason = "no-conversations";
                return this._result(conversations, messagesSaved, mappedThreads, unmappedThreads, reason);
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

            const partitions = convs.map((c) => ({
                partition: (c.convType === 2 ? "group/" : "oneone/") + c.convId,
                from: FROM_FLOOR,
                to: MAX_TS,
                limit: 2147483647,
            }));
            const shards = [];
            for (let i = 0; i < partitions.length; i += shardSize) shards.push(partitions.slice(i, i + shardSize));
            onStatus({ phase: "messages", detail: `${conversations} conversations in ${shards.length} batch(es)` });

            // ---- message rounds (sharded) ----
            const shardMeta = [];
            for (const shard of shards) {
                const ek = zproto.generateKeyPair();
                const sid = newSession("msg");
                shardMeta.push({ sid, ek });
                this._send590(L, "msg", sid, ek, ik, { type: "message", priority: 2, batchSize: 2000, queries: shard });
                await new Promise((r) => setTimeout(r, 600));
            }
            for (const m of shardMeta) await waitDone(m.sid);

            // ---- decrypt + decode + store ----
            for (const m of shardMeta) {
                await eachChunkObj(sessions.get(m.sid), m.ek, M.SyncChunk, (obj) => {
                    for (const part of obj.partitionsList || []) {
                        const gid = /^(?:oneone|group)\/(.+)$/.exec(part.id)?.[1];
                        const hit = gid && threadMap.get(gid);
                        const isGroup = part.id.startsWith("group/");
                        const threadId = hit ? hit.id : part.id;
                        (hit ? mappedThreads : unmappedThreads).add(threadId);
                        for (const msg of part.messagesList || []) {
                            const isText = typeof msg.content === "string";
                            try {
                                upsertThread({
                                    threadId,
                                    type: hit ? hit.type : isGroup ? "group" : "dm",
                                    name: hit ? hit.name : "",
                                    lastUpdate: Number(msg.timestamp) || 0,
                                    sync_timestamp: Date.now(),
                                });
                                insertMessage({
                                    msgId: String(msg.globalId || msg.clientId),
                                    threadId,
                                    senderId: String(msg.senderId || ""),
                                    senderName: "",
                                    text: isText ? msg.content : extractMessageText(msg.content, msg.msgType) || "",
                                    timestamp: Number(msg.timestamp) || 0,
                                    type: isText ? "text" : msg.msgType || "attachment",
                                    raw_data: msg.content,
                                });
                                messagesSaved++;
                            } catch {
                                /* dedupe/constraint — keep going */
                            }
                        }
                    }
                });
            }
            setSyncState("lastSyncOkAt", Date.now());
            setSyncState("lastSyncOkKind", "transfer");
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
        }
        return this._result(conversations, messagesSaved, mappedThreads, unmappedThreads, reason);
    }

    _result(conversations, messagesSaved, mapped, unmapped, reason) {
        return { conversations, messagesSaved, threadsMapped: mapped.size, threadsUnmapped: unmapped.size, reason };
    }
}
