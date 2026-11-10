/**
 * Draining one offline queue (src/zalo/queues/offline-queue.js): one deadline for the whole drain, as Zalo PC's
 * `offline_timeout` (480 s, no per-page wait, no retry), and a socket that closes ends it at once. Driven through the
 * real socket tap and frame decoder with ./support/fake-socket.js; every id is made up.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createSocketTap } from "../../src/zalo/listener/socket-tap.js";
import { DEFAULT_DRAIN_TIMEOUT_MS, drainOfflineQueue } from "../../src/zalo/queues/offline-queue.js";
import { fakeListener } from "./support/fake-socket.js";

const QUEUE = { cmd: 511, subCmd: 1, queueName: "511_1" };

/** One 511 answer page. */
const page = (reqId, id, more) => ({
    error_code: 0,
    error_message: "",
    data: {
        lastActionId: String(id),
        more,
        groupMsgs: [{ msgId: String(id), ts: "1" }],
        queueStatus: { "511_1": { ids: [String(id)], lastId: String(id), evict: 0 } },
        reqId,
    },
});

function rig(respond) {
    const listener = fakeListener({ respond });
    const tap = createSocketTap();
    tap.attach(listener);
    return { listener, tap };
}

/** Let the drain's promise chain move on after a tick. */
const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("offline queue drain — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("one deadline for the whole drain", () => {
    afterEach(() => mock.timers.reset());

    it("is Zalo PC's offline_timeout: a page silent for longer than the old 10 s wait is still waited for", async () => {
        assert.equal(DEFAULT_DRAIN_TIMEOUT_MS, 480_000);
        mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
        const { listener, tap } = rig(() => null);
        let out = null;
        drainOfflineQueue({ listener, tap, queue: QUEUE, lastId: "100" }).then((r) => (out = r));
        mock.timers.tick(60_000);
        await flush();
        // Red on a per-page wait: the drain would have given up after 10 s.
        assert.equal(out, null, "the drain gave up on one silent page");
        mock.timers.tick(DEFAULT_DRAIN_TIMEOUT_MS - 60_000);
        await flush();
        assert.equal(out?.reason, "timeout");
        assert.equal(out.complete, false);
        assert.equal(listener.sent.length, 1, "no retry: the one request, then the deadline");
    });

    it("is shared by every page: pages that each come within the old per-page wait still end at the deadline", async () => {
        let n = 0;
        // Each page answers after 60 ms, more always 1: a 100 ms budget per page would never run out.
        const respond = (payload, l) => {
            const id = 200 + ++n;
            setTimeout(() => l.push(511, 1, page(payload.data.reqId, id, 1)), 60);
            return null;
        };
        const { listener, tap } = rig(respond);
        const r = await drainOfflineQueue({ listener, tap, queue: QUEUE, lastId: "100", timeoutMs: 100 });
        // Red on a per-page wait: it would read on until the page cap (Infinity here) or forever.
        assert.equal(r.reason, "timeout");
        assert.equal(r.complete, false);
        assert.equal(r.pages, 1, "only the page that came inside the one budget");
        assert.deepEqual(
            r.rows.map((x) => x.msgId),
            ["201"],
        );
    });

    it("ends at once when the socket closes: no answer can come on it", async () => {
        const { listener, tap } = rig(() => null);
        const started = Date.now();
        const p = drainOfflineQueue({ listener, tap, queue: QUEUE, lastId: "100", timeoutMs: 60_000 });
        listener.ws.emit("close", 1006, "");
        const r = await p;
        assert.equal(r.reason, "closed");
        assert.equal(r.complete, false);
        assert.ok(Date.now() - started < 5_000, "it waited out the deadline on a closed socket");
        assert.equal(listener.ws.listenerCount("close"), 0, "the close watcher is removed");
    });

    it("removes its close watcher once answered", async () => {
        const { listener, tap } = rig((payload) => page(payload.data.reqId, 300, 0));
        const r = await drainOfflineQueue({ listener, tap, queue: QUEUE, lastId: "100", timeoutMs: 1_000 });
        assert.equal(r.reason, "drained");
        assert.equal(listener.ws.listenerCount("close"), 0);
    });
});
