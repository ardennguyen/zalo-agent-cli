/**
 * The retry of a failed `gid/decrypt` batch (src/core/sync-v2/gid.js, plan item Y9): twice more, after 0.5 s and
 * 1.5 s, except for a rate limit, which the paced batches already back off for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GID_RETRY_DELAYS_MS, retrying } from "../../src/core/sync-v2/gid.js";

const quick = () => {
    const pauses = [];
    return { pauses, sleep: async (ms) => void pauses.push(ms) };
};

describe("retrying a gid/decrypt batch", () => {
    it("asks again after 0.5 s and 1.5 s while the call throws, and gives the result as soon as it answers", async () => {
        const wait = quick();
        let calls = 0;
        const out = await retrying(async () => {
            if (++calls < 3) throw new Error("profile service unavailable");
            return { ok: true };
        }, wait.sleep);
        assert.deepEqual(out, { ok: true });
        assert.equal(calls, 3);
        assert.deepEqual(wait.pauses, [500, 1500]);
        assert.deepEqual(GID_RETRY_DELAYS_MS, [500, 1500]);
    });

    it("throws the last error after the first try and two retries", async () => {
        const wait = quick();
        let calls = 0;
        await assert.rejects(
            retrying(async () => {
                throw new Error(`failure ${++calls}`);
            }, wait.sleep),
            /failure 3/,
        );
        assert.equal(calls, 3);
    });

    it("does not pause when the first try works", async () => {
        const wait = quick();
        assert.equal(await retrying(async () => 7, wait.sleep), 7);
        assert.deepEqual(wait.pauses, []);
    });

    it("does not retry a rate limit: the batches back off for that", async () => {
        const wait = quick();
        let calls = 0;
        await assert.rejects(
            retrying(async () => {
                calls++;
                throw Object.assign(new Error("too many requests"), { code: 429 });
            }, wait.sleep),
            /too many requests/,
        );
        assert.equal(calls, 1);
        assert.deepEqual(wait.pauses, []);
    });
});
