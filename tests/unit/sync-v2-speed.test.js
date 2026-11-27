/**
 * How fast a restore gets the text in, as Zalo does it: sessions consumed several at once, decoding in worker
 * threads, name lookups beside the restore instead of in front of it, a recent round first, and every session
 * released together at the end. Against the fake phone (tests/helpers/fake-zalo/phone.js); every id is made up.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import zlib from "node:zlib";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getMessageById, getSyncRanges, getThreadNames } from "../../src/core/db.js";
import { RECENT_CONVERSATIONS, RECENT_MESSAGES, SyncV2 } from "../../src/core/sync-v2/index.js";
import { decodeBatch } from "../../src/zalo/transfer-sync/decode.js";
import { createDecodePool } from "../../src/zalo/transfer-sync/decode-pool.js";
import { FAKE, installQueuePulls, startFakeZalo } from "../helpers/fake-zalo/index.js";
import { fakeCodecs, installFakePhone } from "../helpers/fake-zalo/phone.js";

const T = Date.UTC(2026, 9, 1);
const FAKE_WORKER = new URL("../helpers/fake-zalo/decode-worker.js", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `n` one-message conversations, the newest last. */
const convs = (n, prefix = "FAST") =>
    Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${i}`,
        kind: "oneone",
        lastTs: T + 1000 + i,
        messages: [{ id: `${7000 + i}`, text: `fast ${i}`, ts: T + 1000 + i }],
    }));

describe("a restore as fast as Zalo's", () => {
    let zalo = null;
    let api = null;
    let n = 0;

    before(() => assertSandboxed(CONFIG_DIR));

    /** Stop the listener and the fake Zalo of the last run. */
    async function teardown() {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    }
    afterEach(teardown);

    /** Connect, run the restore, and report everything that happened, with how long it took. */
    async function run(phoneOpts = {}, { before: prepare, withPhone, ...restoreOpts } = {}) {
        zalo = await startFakeZalo();
        installQueuePulls(zalo.sock);
        const phone = installFakePhone(zalo, phoneOpts);
        withPhone?.(phone);
        api = await zalo.login();
        const sync = new SyncV2(api, `${FAKE.ownId}${++n}-speed`);
        prepare?.(sync);
        const connected = once(api.listener, "connected");
        api.listener.start();
        await connected;
        const events = [];
        let result = null;
        let error = null;
        const started = Date.now();
        try {
            result = await sync.restore({
                codecs: fakeCodecs(),
                keepAlive: false,
                settleMs: 0,
                pollMs: 10,
                waitMs: 30_000,
                ...restoreOpts,
                onStatus: (e) => {
                    events.push({ ...e, at: Date.now() });
                    restoreOpts.onStatus?.(e);
                },
            });
        } catch (e) {
            error = e;
        }
        return { result, error, events, phone, sync, ms: Date.now() - started };
    }

    it("consumes up to N sessions at once: decoding slow batches in workers, N at a time", async () => {
        // Every message batch takes 300 ms to decrypt (in a worker: the main thread is never held). Consumed one
        // session at a time the eight take eight times that; four at once, about two. Timed from the first message
        // request to the last session stored, so what the run does before and after (lists, names) is left out.
        const timed = async (concurrency) => {
            const r = await run(
                { conversations: convs(8) },
                {
                    // The conversations are no friends: gid/decrypt answers at once (nothing), so no store waits on it.
                    before: () => zalo.http.route("/api/gid/decrypt", () => ({})),
                    shardSize: 1,
                    recentConversations: 0,
                    concurrency,
                    decodeWorkers: 4,
                    decodeWorker: { url: FAKE_WORKER, data: { decryptDelayMs: 300 } },
                },
            );
            assert.equal(r.error, null);
            assert.equal(r.result.messagesSaved, 8);
            const from = r.phone.asked("message")[0].receivedAt;
            const stored = r.events.filter((e) => e.phase === "progress");
            assert.equal(stored.length, 8);
            await teardown();
            return stored.at(-1).at - from;
        };
        const one = await timed(1);
        const four = await timed(4);
        console.error(`[timing] 8 sessions, 300 ms decode each: one at a time ${one} ms, four at once ${four} ms`);
        assert.ok(one >= 8 * 300, `one at a time took ${one} ms`);
        assert.ok(four < one * 0.6, `four at once took ${four} ms against ${one} ms one at a time`);
    });

    it("stores text without waiting for name lookups: a slow getUserInfo delays no store, the names come after", async () => {
        const PEER_UID = "1000000000000000701";
        const MEMBER_UID = "1000000000000000702";
        const MEMBER = "VNOISED0000000000000000000000072";
        const conversations = [
            // A non-friend DM: its thread id comes from gid/decrypt, its name from getUserInfo.
            {
                id: "PEERA",
                kind: "oneone",
                lastTs: T + 2000,
                messages: [{ id: "8001", text: "from the peer", ts: T + 2000, senderId: "PEERA" }],
            },
            // A group whose sender is not known: looked up by gid/decrypt and getUserInfo.
            {
                id: "GROUPB",
                kind: "group",
                lastTs: T + 3000,
                messages: [{ id: "8002", text: "from a member", ts: T + 3000, senderId: MEMBER }],
            },
        ];
        let namesAnsweredAt = null;
        const NAMES_MS = 1500;
        const { result, error, events } = await run(
            { conversations },
            {
                before: (sync) => {
                    zalo.http.route("/api/gid/decrypt", () => ({ PEERA: PEER_UID, [MEMBER]: MEMBER_UID }));
                    sync.api.getUserInfo = async (uids) => {
                        await sleep(NAMES_MS);
                        namesAnsweredAt ??= Date.now();
                        const names = { [PEER_UID]: "Example Peer", [MEMBER_UID]: "Example Member" };
                        return {
                            changed_profiles: Object.fromEntries(
                                uids.filter((u) => names[u]).map((u) => [u, { zaloName: names[u] }]),
                            ),
                        };
                    };
                },
            },
        );
        assert.equal(error, null);
        assert.equal(result.messagesSaved, 2);
        const stored = events.find((e) => e.phase === "progress" && /^batch 1\/1/.test(e.detail));
        assert.ok(stored, "the batch was stored");
        assert.ok(namesAnsweredAt, "getUserInfo was asked");
        assert.ok(
            stored.at < namesAnsweredAt,
            `the messages were stored ${stored.at - namesAnsweredAt} ms after the first names came back`,
        );
        console.error(
            `[timing] getUserInfo takes ${NAMES_MS} ms: messages stored ${stored.at - events[0].at} ms into the run, ` +
                `the first names ${namesAnsweredAt - events[0].at} ms`,
        );
        // The names came after, and were filled in.
        const peer = getMessageById("8001");
        assert.equal(peer.threadId, PEER_UID, "stored under the thread id gid/decrypt gave");
        assert.equal(peer.senderId, PEER_UID);
        assert.equal(peer.senderName, "Example Peer", "the peer's rows took the name once it came");
        assert.equal(getThreadNames().get(PEER_UID)?.name, "Example Peer", "and so did the thread's title");
        const member = getMessageById("8002");
        assert.equal(member.senderId, MEMBER_UID, "the opaque sender was filled in with its user id");
        assert.equal(member.senderName, "Example Member");
    });

    it("asks for the recent conversations first, at priority 0, and counts their messages once", async () => {
        const twelve = convs(12, "RECENT");
        const storedAtRecent = [];
        const { result, error, phone } = await run(
            { conversations: twelve },
            {
                onStatus: (e) => {
                    if (e.phase === "progress" && /^recent round/.test(e.detail))
                        storedAtRecent.push(...twelve.map((c) => Boolean(getMessageById(c.messages[0].id))));
                },
            },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        assert.equal(result.messagesSaved, 12, "a message the recent round stored is not counted again");
        const messages = phone.asked("message");
        const [first, ...rest] = messages;
        assert.equal(first.priority, 0, "the recent round goes first, at priority 0");
        assert.ok(
            rest.every((r) => r.priority === 2),
            "the full rounds follow at priority 2",
        );
        assert.equal(first.queries.length, RECENT_CONVERSATIONS);
        assert.ok(first.queries.every((q) => q.limit === RECENT_MESSAGES));
        assert.deepEqual(
            first.queries.map((q) => q.partition),
            twelve
                .slice()
                .reverse()
                .slice(0, RECENT_CONVERSATIONS)
                .map((c) => `oneone/${c.id}`),
            "the most recent conversations, newest first",
        );
        assert.equal(first.ussidx, 1, "right after the conversation round");
        // Once the recent round is stored, the newest conversations are readable.
        assert.deepEqual(storedAtRecent.slice(2), Array(10).fill(true), "the ten newest are stored by then");
        // It settles nothing itself: every range is settled by the full rounds.
        assert.equal(getSyncRanges("done").length, 12);
    });

    describe("releases", () => {
        it("go out in one burst at the end; one that was not acknowledged is tried once more", async () => {
            let dropped = null;
            const { result, error, phone } = await run(
                {
                    conversations: convs(6),
                    releaseAckDelayMs: 200,
                    // The first release of the third session is never answered.
                    dropReleaseAck: (r, nth, p) => {
                        if (dropped === null && nth === 1 && r.syncId === p.requests[2]?.syncId) dropped = r.syncId;
                        return r.syncId === dropped && nth === 1;
                    },
                },
                { shardSize: 1, waveSize: 6 },
            );
            assert.equal(error, null);
            assert.equal(result.reason, "complete");
            const lastRequest = Math.max(...phone.requests.map((r) => r.receivedAt));
            const firstRound = phone.releases.slice(0, phone.requests.length);
            assert.equal(new Set(firstRound.map((r) => r.syncId)).size, phone.requests.length, "one each first");
            assert.ok(
                firstRound.every((r) => r.receivedAt >= lastRequest),
                "none before the last request",
            );
            const spread = Math.max(...firstRound.map((r) => r.receivedAt)) - firstRound[0].receivedAt;
            assert.ok(spread < 150, `in one burst: they went out over ${spread} ms (each ack takes 200 ms)`);
            assert.ok(dropped, "a release was left unanswered");
            const again = phone.releases.slice(phone.requests.length);
            assert.deepEqual(
                again.map((r) => r.syncId),
                [dropped],
                "only the unanswered one is sent again, once",
            );
        });

        it("on a cancel, go out in one burst too: finished sessions as finished, the others as cancelled", async () => {
            const ctl = new AbortController();
            const { result, error, phone } = await run(
                {
                    conversations: convs(6),
                    releaseAckDelayMs: 200,
                    // The first session is served at once, the others only after a long while.
                    serveDelayMs: (r) => (r.type === "message" && r.ussidx > 1 ? 3_000 : 0),
                },
                {
                    shardSize: 1,
                    waveSize: 6,
                    signal: ctl.signal,
                    onStatus: (e) => {
                        if (e.phase === "progress") ctl.abort();
                    },
                },
            );
            assert.equal(error, null);
            assert.equal(result.reason, "cancelled");
            assert.equal(phone.releases.length, phone.requests.length, "every session is released");
            const byId = new Map(phone.releases.map((r) => [r.syncId, r.reason]));
            const [conv, first, ...waiting] = phone.requests;
            assert.equal(byId.get(conv.syncId), 1, "the conversation round finished");
            assert.equal(byId.get(first.syncId), 1, "the served session finished");
            for (const r of waiting) assert.equal(byId.get(r.syncId), 0, "a session still waited for is cancelled");
            const times = phone.releases.map((r) => r.receivedAt);
            assert.ok(Math.max(...times) - Math.min(...times) < 150, "in one burst");
        });
    });
});

describe("decoding in a worker", () => {
    /** A batch of length-prefixed chunks, as the phone uploads them. */
    const blobOf = (chunks) =>
        Buffer.concat(
            chunks.flatMap((c) => {
                const len = Buffer.alloc(4);
                len.writeUInt32LE(c.length);
                return [len, c];
            }),
        );
    const json = (o) => Buffer.from(JSON.stringify(o));
    const part = (id, n) => ({
        partitionsList: [
            {
                id,
                messagesList: Array.from({ length: n }, (_, i) => ({
                    globalId: `${9000 + i}`,
                    senderId: "S1",
                    content: `text ${i} ✓ đ`,
                    timestamp: T + i,
                })),
            },
        ],
    });
    const keys = { ikPub: Buffer.alloc(32, 1), ikPriv: Buffer.alloc(32, 2), ekPriv: Buffer.alloc(32, 3) };
    const fixtures = {
        metadata: { blob: blobOf([zlib.zstdCompressSync(json({ meta: 1 }))]), ctx: { batchType: 2, keys } },
        messages: {
            blob: blobOf([
                zlib.zstdCompressSync(json(part("oneone/WORKA", 50))),
                zlib.deflateSync(json(part("group/WORKB", 3))),
                zlib.gzipSync(json(part("oneone/WORKC", 1))),
                json(part("oneone/WORKD", 2)),
                Buffer.from("not a chunk at all"),
            ]),
            ctx: { batchType: 1, keys, sessionRecord: Buffer.from("session") },
        },
        "messages without a session record": {
            blob: blobOf([json(part("oneone/WORKE", 1))]),
            ctx: { batchType: 1, keys },
        },
    };

    for (const [name, { blob, ctx }] of Object.entries(fixtures)) {
        it(`gives what the main thread gives: ${name}`, async () => {
            const here = decodeBatch(blob, ctx, fakeCodecs(), "M");
            const pool = createDecodePool({ size: 1, workerUrl: FAKE_WORKER });
            try {
                const there = await pool.decode(blob, ctx, "M");
                assert.deepEqual(there.objs, here.objs);
                assert.deepEqual(
                    there.sessionRecord && Buffer.from(there.sessionRecord),
                    here.sessionRecord && Buffer.from(here.sessionRecord),
                );
                assert.equal(pool.broken(), false);
            } finally {
                await pool.close();
            }
            if (name === "messages") assert.equal(here.objs.length, 4, "four chunks decode, the bad one is skipped");
        });
    }

    it("a worker that cannot load its codecs fails its task, so the caller decodes on the main thread", async () => {
        const pool = createDecodePool({ size: 1, workerUrl: FAKE_WORKER, workerData: { failToLoad: true } });
        try {
            await assert.rejects(pool.decode(fixtures.messages.blob, fixtures.messages.ctx, "M"));
        } finally {
            await pool.close();
        }
    });
});
