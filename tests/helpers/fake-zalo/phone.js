/**
 * A fake phone for `SyncV2.restore()`: the whole restore, request to released session, with no real phone, no
 * decryption assets and no network.
 *
 * Three stand-ins make that possible:
 *
 *  - the phone: it answers every cmd 590 request with an ack, then plays the control frames a real phone sends
 *    (status 3 and 4 before the first batch, status 5 afterwards, then `upload_batch` frames carrying a `msgUrl`),
 *    and acknowledges every release;
 *  - the download host: a route on the fake Zalo's HTTP that serves each announced batch as `[u32 LE length][chunk]`;
 *  - the codecs: `decryptMetadata` and `decryptMessage` hand the chunk back as it is, and a "protobuf" class decodes
 *    JSON. They are passed to restore as `opts.codecs`.
 *
 * What it plays is scripted by the test: which conversations exist, what each holds, which batches fail to
 * download, whether the phone says no. Every id is made up.
 */
import { ok } from "./frames.js";
import { controlBody, transferStatus } from "./sync.js";

/** The host batches are "downloaded" from. */
export const BATCH_HOST = "sync.zalo.invalid";

const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
};

/** One batch blob: a single length-prefixed chunk of JSON. */
const blobOf = (obj) => {
    const chunk = Buffer.from(JSON.stringify(obj));
    return Buffer.concat([u32(chunk.length), chunk]);
};

/**
 * Codecs that need no decryption and no protobuf: a chunk is JSON, and "decoding" parses it.
 *
 * @returns {{zproto: object, M: object, C: object}}
 */
export function fakeCodecs() {
    const keyPair = () => ({ publicKey: Buffer.alloc(32, 1), privateKey: Buffer.alloc(32, 2) });
    const klass = {
        SyncChunk: {
            deserializeBinary: (buf) => ({ toObject: () => JSON.parse(Buffer.from(buf).toString("utf8")) }),
        },
    };
    return {
        zproto: {
            generateKeyPair: keyPair,
            decryptMetadata: (chunk) => ({ sessionRecord: Buffer.from("session"), plaintext: Buffer.from(chunk) }),
            decryptMessage: (chunk) => ({ plaintext: Buffer.from(chunk) }),
        },
        M: klass,
        C: klass,
    };
}

/**
 * A conversation of the fake phone.
 *
 * @typedef {object} PhoneConversation
 * @property {string} id - the opaque conversation id
 * @property {"oneone"|"group"} [kind]
 * @property {number} lastTs
 * @property {Array<{id: string, text: string, ts: number}>} messages
 */

/**
 * Play the phone.
 *
 * @param {object} zalo - from startFakeZalo()
 * @param {object} [opts]
 * @param {PhoneConversation[]} [opts.conversations]
 * @param {"complete"|"decline"|"silent"} [opts.outcome] - `decline`: status 3 then 6; `silent`: status 3 only
 * @param {(request: object) => number} [opts.ackError] - the `err` of the ack of a 590 request, 0 by default
 * @param {number} [opts.ackDelayMs] - how long the phone takes to acknowledge a 590 request (0: at once)
 * @param {number} [opts.failCode] - the `err` the phone gives a failed partition (default 1)
 * @param {(partition: string, attempt: number) => boolean} [opts.failPartition] - the phone reports this partition as
 *   failed; `attempt` counts the times it has been asked for, from 1
 * @param {(path: string, phone: object) => number|null} [opts.downloadStatus] - an HTTP status to answer a batch
 *   download with (null: serve it); gets the phone, to look at the requests so far
 * @returns {{
 *   requests: object[], releases: object[], downloads: string[], order: Array<{cmd: number, at: number}>,
 *   asked: (type: string) => object[],
 * }}
 */
export function installFakePhone(zalo, opts = {}) {
    const { conversations = [], outcome = "complete", ackError = () => 0, failPartition = () => false } = opts;
    const ackDelayMs = opts.ackDelayMs ?? 0;
    /** partition -> how many times it has been asked for */
    const attempts = new Map();
    const downloadStatus = opts.downloadStatus ?? (() => null);
    const requests = [];
    const releases = [];
    const downloads = [];
    const order = [];
    const blobs = new Map();
    let started = false;
    let t = 0;

    const push601 = (controls) => zalo.sock.push(601, 0, controlBody(controls));
    const batchControl = (syncId, reqId, idx, isLast, batchType, scopes, blob) => {
        const url = `https://${BATCH_HOST}/${syncId}/${idx}`;
        blobs.set(`/${syncId}/${idx}`, blob);
        return {
            actionId: String(++t),
            controlId: String(t),
            content: {
                act: "upload_batch",
                data: {
                    err: 0,
                    reqId,
                    ts: Date.now(),
                    fromDevice: 0,
                    msgUrl: url,
                    syncId,
                    ik: "ik",
                    batchType,
                    idx,
                    isLast,
                    scopes,
                },
                act_type: "transfer_sync2",
            },
        };
    };
    const failureControl = (syncId, partition, code = 1) => ({
        actionId: String(++t),
        controlId: String(t),
        content: {
            act: "upload_batch",
            data: { err: code, fromDevice: 0, syncId, scopes: [{ partition }], idx: 9 },
            act_type: "transfer_sync2",
        },
    });

    zalo.http.rawRoute(
        (r) => r.host === BATCH_HOST,
        (r) => {
            downloads.push(r.path);
            const status = downloadStatus(r.path, handle);
            if (status) return new Response("", { status });
            return new Response(blobs.get(r.path) ?? "", { status: blobs.has(r.path) ? 200 : 404 });
        },
    );

    zalo.sock.respond(590, 0, (frame) => {
        const inner = frame.data?.data ?? {};
        const reqId = frame.data?.reqId;
        const req = inner.req ?? {};
        requests.push({
            receivedAt: Date.now(),
            syncId: inner.syncId,
            reqId,
            ussidx: inner.ussidx,
            type: req.type,
            priority: req.priority,
            queries: req.queries ?? [],
            raw: inner,
        });
        order.push({ cmd: 590, at: requests.length });
        const err = ackError(requests.at(-1));
        queueMicrotask(() => {
            if (err !== 0) return;
            if (!started) {
                started = true;
                push601([transferStatus(inner.syncId, 3)]);
                if (outcome === "silent") return;
                if (outcome === "decline") return push601([transferStatus(inner.syncId, 6)]);
                push601([transferStatus(inner.syncId, 4)]);
            } else if (outcome === "complete") {
                push601([transferStatus(inner.syncId, 5)]);
            }
            if (outcome !== "complete") return;

            if (req.type === "conversation") {
                const list = conversations.map((c) => ({
                    convId: c.id,
                    convType: c.kind === "group" ? 2 : 1,
                    lastTs: c.lastTs,
                    respondedByMe: false,
                }));
                push601([
                    batchControl(inner.syncId, reqId, 0, false, 2, [], blobOf({})),
                    batchControl(inner.syncId, reqId, 1, true, 1, [], blobOf({ conversationsList: list })),
                ]);
                return;
            }
            const partitions = (req.queries ?? []).map((q) => q.partition);
            const asked = partitions.map((p) => [p, (attempts.get(p) ?? 0) + 1]);
            for (const [p, n] of asked) attempts.set(p, n);
            const failed = asked.filter(([p, n]) => failPartition(p, n)).map(([p]) => p);
            const served = asked.filter(([p, n]) => !failPartition(p, n)).map(([p]) => p);
            const parts = served.map((id) => {
                const conv = conversations.find((c) => id.endsWith(`/${c.id}`));
                return {
                    id,
                    messagesList: (conv?.messages ?? []).map((m) => ({
                        globalId: m.id,
                        clientId: `c${m.id}`,
                        senderId: "S1",
                        timestamp: m.ts,
                        msgType: 0,
                        content: m.text,
                    })),
                };
            });
            push601([
                batchControl(inner.syncId, reqId, 0, false, 2, [], blobOf({})),
                batchControl(
                    inner.syncId,
                    reqId,
                    1,
                    failed.length === 0,
                    1,
                    served.map((partition) => ({ partition })),
                    blobOf({ partitionsList: parts }),
                ),
                ...failed.map((p) => failureControl(inner.syncId, p, opts.failCode)),
            ]);
        });
        const ack = ok({ reqId, err, ts: Date.now() });
        return ackDelayMs > 0 ? [{ cmd: 590, sub: 0, body: ack, delayMs: ackDelayMs }] : ack;
    });

    zalo.sock.respond(591, 0, (frame) => {
        const inner = frame.data?.data ?? {};
        releases.push({ syncId: inner.syncId, reason: inner.reason, reqId: frame.data?.reqId });
        order.push({ cmd: 591, at: releases.length });
        return ok({ reqId: frame.data?.reqId, err: 0, ts: Date.now() });
    });

    const handle = {
        requests,
        releases,
        downloads,
        order,
        asked: (type) => requests.filter((r) => r.type === type),
    };
    return handle;
}
