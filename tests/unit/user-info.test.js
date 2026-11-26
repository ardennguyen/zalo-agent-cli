/**
 * src/zalo/custom/user-info.js -- profile lookups that notice a rate limit.
 *
 * A restore of a busy account asks Zalo for thousands of profiles in batches
 * of 100. The old loops swallowed every error with a fixed sentence and went
 * on to the next batch, so a "limit reached" answer was repeated for all of
 * them, and the real text was never written anywhere. These pin the
 * behavior: pace, never retry a rate limit but rest every lookup for a while
 * (said once), and log what Zalo said -- with every wait injected, so nothing
 * here sleeps.
 */
import "../helpers/sandbox.js"; // first: the name helpers now reach the account db (src/core/contact-names.js)
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    LOOKUP_COOL_DOWN_MS,
    MAX_CONSECUTIVE_FAILURES,
    configureUserInfo,
    lookupsCoolingDown,
    resetLookupCoolDown,
    describeLookupError,
    isRateLimitError,
    runPacedBatches,
    setUserInfoLogger,
} from "../../src/zalo/custom/user-info.js";
import { resolveCurrentUserNames } from "../../src/core/current-user-names.js";

const ids = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));
/** An error shaped like the session's: a code and a message. */
const zaloError = (code, message) => Object.assign(new Error(message), { code });

/** A sleep that records its waits instead of waiting. */
function fakeSleep() {
    const waits = [];
    return { waits, sleep: async (ms) => void waits.push(ms) };
}

afterEach(() => {
    configureUserInfo();
    setUserInfoLogger(null);
    resetLookupCoolDown();
});

describe("describeLookupError / isRateLimitError", () => {
    it("reports the code and the message Zalo gave, and finds a trailing (code) in a message", () => {
        assert.equal(describeLookupError(zaloError(221, "Quá giới hạn")), "code 221: Quá giới hạn");
        assert.equal(describeLookupError(new Error("Zalo said no (114)")), "code 114: Zalo said no (114)");
        assert.equal(describeLookupError(new Error("boom")), "boom");
        assert.equal(describeLookupError("plain"), "plain");
    });

    it("recognizes a rate limit by code or by wording, and nothing else", () => {
        assert.equal(isRateLimitError(zaloError(221, "x")), true);
        assert.equal(isRateLimitError(zaloError(429, "x")), true, "429 is a rate limit whatever the text says");
        for (const text of [
            "Rate limit exceeded",
            "limit reached",
            "Quá giới hạn",
            "too many requests",
            "try again later",
        ]) {
            assert.equal(isRateLimitError(new Error(text)), true, text);
        }
        assert.equal(isRateLimitError(zaloError(114, "Tham số không hợp lệ")), false);
        assert.equal(isRateLimitError(new Error("socket hang up")), false);
        assert.equal(isRateLimitError(undefined), false);
    });
});

describe("runPacedBatches", () => {
    it("runs every batch in order, waiting only between them", async () => {
        const { waits, sleep } = fakeSleep();
        const seen = [];
        const r = await runPacedBatches(ids(250), {
            batchSize: 100,
            gapMs: 300,
            sleep,
            call: async (batch) => (seen.push(batch.length), batch.length),
        });
        assert.deepEqual(seen, [100, 100, 50]);
        assert.deepEqual(r.results, [100, 100, 50]);
        assert.deepEqual(waits, [300, 300], "no wait before the first request");
        assert.deepEqual([r.failed, r.skippedIds, r.stoppedBy, r.retries], [0, 0, null, 0]);
    });

    it("does nothing for no ids and never calls out", async () => {
        const r = await runPacedBatches([], { batchSize: 100, call: async () => assert.fail("called") });
        assert.deepEqual([r.results, r.batches, r.failed], [[], 0, 0]);
    });

    it("does not retry a rate limit: it stops, starts the cool-down and says so once (the 2/5/15 s retries cost ~22 s a batch)", async () => {
        const { waits, sleep } = fakeSleep();
        const logs = [];
        let calls = 0;
        const r = await runPacedBatches(ids(450), {
            batchSize: 100,
            gapMs: 0,
            sleep,
            log: (m) => logs.push(m),
            call: async () => {
                calls++;
                if (calls > 1) throw zaloError(221, "Vượt quá số request cho phép");
                return "ok";
            },
        });
        // batch 1 ok; batch 2 refused once, not retried; 3 batches never asked.
        assert.equal(calls, 2);
        assert.deepEqual(waits, [], "no back-off waits");
        assert.equal(r.stoppedBy, "rate-limit");
        assert.equal(r.retries, 0);
        assert.equal(r.skippedIds, 250);
        assert.equal(lookupsCoolingDown(), true);
        assert.equal(logs.filter((m) => m.startsWith("names deferred: Zalo is limiting lookups")).length, 1);
        assert.ok(
            logs.some((m) => m.includes("code 221: Vượt quá số request cho phép")),
            logs.join(" | "),
        );
    });

    it("while the cool-down lasts, a lookup asks nothing and logs nothing; after it, lookups run again", async () => {
        let clock = 1_000_000;
        configureUserInfo({ gapMs: 0, now: () => clock });
        const logs = [];
        const limited = async () => {
            throw zaloError(221, "Vượt quá số request cho phép");
        };
        await runPacedBatches(ids(100), { batchSize: 100, log: (m) => logs.push(m), call: limited });
        let calls = 0;
        for (let k = 0; k < 5; k++) {
            const r = await runPacedBatches(ids(300), {
                batchSize: 100,
                log: (m) => logs.push(m),
                call: async () => (calls++, "ok"),
            });
            assert.equal(r.stoppedBy, "cooling-down");
            assert.equal(r.skippedIds, 300);
        }
        assert.equal(calls, 0, "nothing asked while Zalo is limiting lookups");
        assert.equal(logs.length, 1, "said once, not per batch: " + logs.join(" | "));
        clock += LOOKUP_COOL_DOWN_MS + 1;
        const r = await runPacedBatches(ids(100), { batchSize: 100, call: async () => (calls++, "ok") });
        assert.equal(r.stoppedBy, null);
        assert.equal(calls, 1);
    });

    it("an aborted signal stops a lookup between requests", async () => {
        const ctl = new AbortController();
        let calls = 0;
        const r = await runPacedBatches(ids(500), {
            batchSize: 100,
            gapMs: 0,
            signal: ctl.signal,
            call: async () => {
                calls++;
                if (calls === 2) ctl.abort();
                return "ok";
            },
        });
        assert.equal(calls, 2);
        assert.equal(r.stoppedBy, "cancelled");
        assert.equal(r.skippedIds, 300);
    });

    it("continues past an ordinary failure, but stops after several in a row whatever the text", async () => {
        const { sleep } = fakeSleep();
        const logs = [];
        let calls = 0;
        const r = await runPacedBatches(ids(700), {
            batchSize: 100,
            gapMs: 0,
            sleep,
            log: (m) => logs.push(m),
            call: async () => {
                calls++;
                if (calls === 1) throw new Error("socket hang up");
                if (calls >= 3) throw zaloError(500, "server error");
                return "ok";
            },
        });
        // 1 fails (continue), 2 ok (reset), 3,4,5 fail in a row -> stop; batches 6 and 7 are skipped.
        assert.equal(calls, 5);
        assert.equal(MAX_CONSECUTIVE_FAILURES, 3);
        assert.equal(r.stoppedBy, "repeated-failures");
        assert.equal(r.failed, 4);
        assert.equal(r.skippedIds, 200);
        assert.ok(logs.some((m) => /3 failed batches in a row/.test(m)));
    });

    it("writes to the registered sink when no log is passed, and stays silent without one", async () => {
        const { sleep } = fakeSleep();
        const sunk = [];
        setUserInfoLogger((m) => sunk.push(m));
        await runPacedBatches(ids(10), { batchSize: 100, sleep, call: async () => assert.fail("x") }).catch(() => {});
        assert.ok(sunk.some((m) => /failed/.test(m)));
        setUserInfoLogger(null);
        const before = sunk.length;
        await runPacedBatches(ids(10), {
            batchSize: 100,
            sleep,
            call: async () => {
                throw new Error("quiet");
            },
        });
        assert.equal(sunk.length, before);
    });
});

describe("resolveCurrentUserNames under a rate limit", () => {
    it("falls back to ids, asks for far fewer batches than it has, and writes Zalo's own words to the sink", async () => {
        const { sleep } = fakeSleep();
        configureUserInfo({ gapMs: 0, sleep });
        const sunk = [];
        setUserInfoLogger((m) => sunk.push(m));
        let calls = 0;
        const api = {
            getAliasList: async () => ({ items: [] }),
            getUserInfo: async () => {
                calls++;
                throw zaloError(221, "Quá giới hạn");
            },
        };
        const uids = Array.from({ length: 1000 }, (_, i) => String(500000 + i));
        const names = await resolveCurrentUserNames(api, uids);
        assert.equal(names.size, 1000);
        assert.deepEqual(names.get("500000"), { name: "500000", source: "uid" });
        // 10 batches existed. No retry: the lookup stopped at the first refusal, 1 request, not 10.
        assert.equal(calls, 1);
        assert.ok(
            sunk.some((m) => m.includes("code 221: Quá giới hạn")),
            sunk.join("\n"),
        );
        assert.ok(sunk.some((m) => /names deferred: Zalo is limiting lookups/.test(m)));
    });

    it("still resolves everything when Zalo answers", async () => {
        const { sleep } = fakeSleep();
        configureUserInfo({ gapMs: 0, sleep });
        const api = {
            getAliasList: async () => ({ items: [] }),
            getUserInfo: async (batch) => ({
                changed_profiles: Object.fromEntries(batch.map((id) => [id, { zaloName: `N${id}` }])),
            }),
        };
        const names = await resolveCurrentUserNames(api, ["101", "102"]);
        assert.deepEqual(names.get("102"), { name: "N102", source: "zalo" });
    });
});
