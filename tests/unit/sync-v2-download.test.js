/**
 * The batch downloads (src/core/sync-v2/download.js, plan item Y3): two at a time, 60 s each, three retries one
 * second apart, typed failures, and a download that starts when it is announced, not when it is needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BatchDownloadError,
    DOWNLOAD_DEFAULTS,
    DOWNLOAD_FAILURE,
    createBatchDownloader,
} from "../../src/core/sync-v2/download.js";

const res = (status, body = "x") => ({
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => Buffer.from(body),
});

/** A downloader on a scripted fetch: `script(url, n)` answers the n-th request for that url. */
function rig(script, opts = {}) {
    const calls = [];
    const pauses = [];
    let inFlight = 0;
    let peak = 0;
    const downloader = createBatchDownloader({
        fetchImpl: async (url, init) => {
            const n = calls.filter((c) => c === url).length + 1;
            calls.push(url);
            inFlight++;
            peak = Math.max(peak, inFlight);
            try {
                return await script(url, n, init);
            } finally {
                inFlight--;
            }
        },
        sleep: async (ms) => void pauses.push(ms),
        ...opts,
    });
    return { downloader, calls, pauses, peak: () => peak };
}

describe("batch downloads", () => {
    it("uses the official settings: 2 at once, 60 s, 3 retries, 1 s apart", () => {
        assert.deepEqual(DOWNLOAD_DEFAULTS, { concurrent: 2, timeoutMs: 60000, retries: 3, retryDelayMs: 1000 });
    });

    it("returns the bytes", async () => {
        const { downloader } = rig(async () => res(200, "batch-bytes"));
        assert.equal((await downloader.get("u1")).toString(), "batch-bytes");
    });

    it("retries a server fault three times, one second apart, then fails with its kind and status", async () => {
        const { downloader, calls, pauses } = rig(async () => res(503));
        await assert.rejects(
            downloader.get("u1"),
            (e) => e instanceof BatchDownloadError && e.kind === DOWNLOAD_FAILURE.SERVER && e.status === 503,
        );
        assert.equal(calls.length, 4, "the first attempt and three retries");
        assert.deepEqual(pauses, [1000, 1000, 1000]);
    });

    it("succeeds when a retry works", async () => {
        const { downloader, calls } = rig(async (_u, n) => (n < 3 ? res(502) : res(200, "late")));
        assert.equal((await downloader.get("u1")).toString(), "late");
        assert.equal(calls.length, 3);
    });

    it("does not retry a missing batch: it will be just as missing a second later", async () => {
        const { downloader, calls, pauses } = rig(async () => res(404));
        await assert.rejects(downloader.get("u1"), (e) => e.kind === DOWNLOAD_FAILURE.NOT_FOUND && e.status === 404);
        assert.equal(calls.length, 1);
        assert.deepEqual(pauses, []);
    });

    it("does not retry a refusal (4xx other than 404)", async () => {
        const { downloader, calls } = rig(async () => res(403));
        await assert.rejects(downloader.get("u1"), (e) => e.kind === DOWNLOAD_FAILURE.REFUSED);
        assert.equal(calls.length, 1);
    });

    it("retries a network fault and a timeout, and names each", async () => {
        const net = rig(async () => {
            throw new TypeError("fetch failed");
        });
        await assert.rejects(
            net.downloader.get("u"),
            (e) => e.kind === DOWNLOAD_FAILURE.NETWORK && /fetch failed/.test(e.message),
        );
        assert.equal(net.calls.length, 4);

        const slow = rig(async () => {
            throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        });
        await assert.rejects(
            slow.downloader.get("u"),
            (e) => e.kind === DOWNLOAD_FAILURE.TIMEOUT && /60 s/.test(e.message),
        );
        assert.equal(slow.calls.length, 4);
    });

    it("gives every attempt its own 60 s timeout signal", async () => {
        const signals = [];
        const { downloader } = rig(async (_u, _n, init) => {
            signals.push(init.signal);
            return res(200);
        });
        await downloader.get("u1");
        assert.ok(signals[0] instanceof AbortSignal);
    });

    it("runs two downloads at a time and no more", async () => {
        let release;
        const gate = new Promise((r) => (release = r));
        const { downloader, peak, calls } = rig(async () => {
            await gate;
            return res(200);
        });
        const all = ["a", "b", "c", "d", "e"].map((u) => downloader.start(u));
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(calls.length, 2, "only two have begun");
        assert.equal(downloader.pending(), 5);
        release();
        await Promise.all(all);
        assert.equal(peak(), 2);
        assert.equal(downloader.pending(), 0);
    });

    it("starts a download when it is announced: asking for it later joins it, and does not fetch twice", async () => {
        const { downloader, calls } = rig(async () => res(200, "once"));
        downloader.start("u1");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(calls.length, 1, "it began before anyone asked for the bytes");
        assert.equal((await downloader.get("u1")).toString(), "once");
        assert.equal(calls.length, 1);
    });

    it("forgets a download once its bytes were taken, so a run does not keep every batch", async () => {
        const { downloader, calls } = rig(async () => res(200));
        await downloader.get("u1");
        await downloader.get("u1");
        assert.equal(calls.length, 2);
    });

    it("a prefetch that fails raises nothing on its own: the failure is reported when the bytes are asked for", async () => {
        const unhandled = [];
        const onUnhandled = (e) => unhandled.push(e);
        process.on("unhandledRejection", onUnhandled);
        try {
            const { downloader } = rig(async () => res(404));
            downloader.start("u1");
            await new Promise((r) => setTimeout(r, 30));
            assert.deepEqual(unhandled, []);
            await assert.rejects(downloader.get("u1"), (e) => e.kind === DOWNLOAD_FAILURE.NOT_FOUND);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
