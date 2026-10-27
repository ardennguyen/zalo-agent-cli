/**
 * The maintenance gate (src/zalo/maintenance.js) and the retry history's file
 * (src/zalo/anomaly-store.js): the two small pieces that touch the outside.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MAINTENANCE_POLL_MS,
    MAINTENANCE_URL,
    checkMaintenance,
    maintenanceKeysOf,
    pollDelayMs,
    waitOutMaintenance,
    watchMaintenance,
} from "../../src/zalo/maintenance.js";
import { loadAnomalyState, saveAnomalyState } from "../../src/zalo/anomaly-store.js";

const answer =
    (body, ok = true) =>
    async () => ({ ok, json: async () => body });
const NONE = { startTime: 0, endTime: 0 };

describe("maintenanceKeysOf", () => {
    const apiWith = (dr) => ({ getContext: () => ({ settings: { features: { dr_config: dr } } }) });

    it("reads the disaster-recovery numbers the session's login learned, under the names the question uses", () => {
        assert.deepEqual(maintenanceKeysOf(apiWith({ supportMaintenance: 1, bucketId: 4 })), { bkt: 4, sptMtn: 1 });
        assert.deepEqual(maintenanceKeysOf(apiWith({ supportMaintenance: "0", bucketId: "12" })), {
            bkt: 12,
            sptMtn: 0,
        });
    });

    it("gives nothing, so the question asks -1 and -1, when the session holds none or only one", () => {
        for (const api of [
            undefined,
            {},
            apiWith(undefined),
            apiWith({ bucketId: 4 }),
            apiWith({ supportMaintenance: 1 }),
            apiWith({ supportMaintenance: "x", bucketId: 4 }),
            { getContext: () => ({}) },
            {
                getContext: () => {
                    throw new Error("no session");
                },
            },
        ]) {
            assert.deepEqual(maintenanceKeysOf(api), {});
        }
    });
});

describe("checkMaintenance", () => {
    it("asks the maintenance host, carrying the two stored numbers and nothing else", async () => {
        const seen = [];
        await checkMaintenance({
            fetchFn: async (url, init) => {
                seen.push({ url, method: init.method });
                return { ok: true, json: async () => ({ error_code: 0 }) };
            },
            bkt: 3,
            sptMtn: 7,
        });
        assert.deepEqual(seen, [{ url: `${MAINTENANCE_URL}/api/chk?bkt=3&spt_mtn=7`, method: "GET" }]);
    });

    it("sends -1 and -1 when nothing is stored", async () => {
        let url;
        await checkMaintenance({
            fetchFn: async (u) => ((url = u), { ok: true, json: async () => ({ error_code: 0 }) }),
        });
        assert.match(url, /bkt=-1&spt_mtn=-1$/);
    });

    it("reads 0 as ok, 70 as maintenance now, 71 as a notice", async () => {
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 0 }) }), {
            state: "ok",
            code: 0,
            window: NONE,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 70 }) }), {
            state: "maintenance",
            code: 70,
            window: NONE,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 71 }) }), {
            state: "notice",
            code: 71,
            window: NONE,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer(70) }), {
            state: "maintenance",
            code: 70,
            window: NONE,
        });
    });

    it("reads the announced window from the data of the answer, in milliseconds, and zeros when it is not numbers", async () => {
        const data = { startTime: 1_000, endTime: 5_000 };
        for (const code of [0, 70, 71]) {
            const out = await checkMaintenance({ fetchFn: answer({ error_code: code, data }) });
            assert.deepEqual(out.window, data, `code ${code}`);
        }
        const junk = await checkMaintenance({
            fetchFn: answer({ error_code: 71, data: { startTime: "soon", endTime: null } }),
        });
        assert.deepEqual(junk.window, NONE);
    });

    it("calls anything it cannot read unreachable: that says nothing about maintenance", async () => {
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 5 }) }), {
            state: "unreachable",
            code: 5,
            window: NONE,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({}) }), {
            state: "unreachable",
            code: null,
            window: NONE,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 0 }, false) }), {
            state: "unreachable",
            code: null,
            window: NONE,
        });
        assert.deepEqual(
            await checkMaintenance({
                fetchFn: async () => {
                    throw new Error("offline");
                },
            }),
            { state: "unreachable", code: null, window: NONE },
        );
        assert.deepEqual(
            await checkMaintenance({
                fetchFn: async () => ({
                    ok: true,
                    json: async () => {
                        throw new Error("not json");
                    },
                }),
            }),
            { state: "unreachable", code: null, window: NONE },
        );
    });
});

describe("waitOutMaintenance", () => {
    /** A check that answers from a script, and a sleep that records instead of waiting. */
    function scripted(states, window = NONE) {
        const queue = [...states];
        const sleeps = [];
        const polls = [];
        return {
            check: async () => ({ state: queue.shift() ?? "ok", code: null, window }),
            sleep: async (ms) => void sleeps.push(ms),
            onPoll: (state) => polls.push(state),
            sleeps,
            polls,
        };
    }

    it("keeps asking every minute while Zalo is in maintenance, and returns when it is out", async () => {
        const s = scripted(["maintenance", "maintenance", "ok"]);
        const out = await waitOutMaintenance(s);
        assert.deepEqual(out, { state: "ok", code: null, window: NONE, polls: 3 });
        assert.deepEqual(s.sleeps, [MAINTENANCE_POLL_MS.afterWindow, MAINTENANCE_POLL_MS.afterWindow]);
        assert.deepEqual(s.polls, ["maintenance", "maintenance", "ok"]);
    });

    it("returns at once for a notice, for an unreachable host and for no maintenance, without waiting", async () => {
        for (const state of ["notice", "unreachable", "ok"]) {
            const s = scripted([state]);
            assert.equal((await waitOutMaintenance(s)).state, state);
            assert.deepEqual(s.sleeps, []);
        }
    });

    it("stops when told to, even in the middle of a wait", async () => {
        const controller = new AbortController();
        const s = scripted(["maintenance", "maintenance", "maintenance"]);
        s.sleep = async (ms) => {
            s.sleeps.push(ms);
            controller.abort();
        };
        const out = await waitOutMaintenance({ ...s, signal: controller.signal });
        assert.equal(out.state, "aborted");
        assert.equal(out.polls, 1);
    });

    it("asks hourly while an announced window is running, as the official client does", async () => {
        const s = scripted(["maintenance", "maintenance", "ok"], { startTime: 1_000, endTime: 9_000_000 });
        await waitOutMaintenance({ ...s, now: () => 5_000 });
        assert.deepEqual(s.sleeps, [MAINTENANCE_POLL_MS.inWindow, MAINTENANCE_POLL_MS.inWindow]);
    });
});

describe("pollDelayMs", () => {
    const window = { startTime: 1_000, endTime: 2_000 };

    it("is an hour inside the window and a minute from its end", () => {
        assert.equal(pollDelayMs(window, 1_000), MAINTENANCE_POLL_MS.inWindow);
        assert.equal(pollDelayMs(window, 1_999), MAINTENANCE_POLL_MS.inWindow);
        assert.equal(pollDelayMs(window, 2_000), MAINTENANCE_POLL_MS.afterWindow);
        assert.equal(pollDelayMs(window, 9_999), MAINTENANCE_POLL_MS.afterWindow);
    });

    it("is a minute with no window, and before one starts (the official 0 would ask in a loop)", () => {
        assert.equal(pollDelayMs(undefined, 5), MAINTENANCE_POLL_MS.afterWindow);
        assert.equal(pollDelayMs(NONE, 5), MAINTENANCE_POLL_MS.afterWindow);
        assert.equal(pollDelayMs(window, 999), MAINTENANCE_POLL_MS.afterWindow);
    });

    it("an hour is longer than a minute by a wide margin", () => {
        assert.ok(MAINTENANCE_POLL_MS.inWindow >= 10 * MAINTENANCE_POLL_MS.afterWindow);
    });
});

describe("watchMaintenance (the 71 continue-checking loop)", () => {
    /** Answers from a script; a sleep that records. */
    function watched(answers, extra = {}) {
        const queue = [...answers];
        const sleeps = [];
        const maintenance = [];
        return {
            check: async () => queue.shift() ?? { state: "ok", code: 0, window: NONE },
            sleep: async (ms) => void sleeps.push(ms),
            onMaintenance: (a) => maintenance.push(a.code),
            sleeps,
            maintenance,
            ...extra,
        };
    }
    const notice = (window = NONE) => ({ state: "notice", code: 71, window });

    it("waits before the first question, keeps asking through 71 and unanswered questions, and ends on 0", async () => {
        const w = watched([notice(), { state: "unreachable", code: null, window: NONE }, notice()]);
        assert.equal(await watchMaintenance(w), "ok");
        assert.equal(w.sleeps.length, 4, "a wait before each of the four questions");
        assert.deepEqual(w.maintenance, []);
    });

    it("hands a 70 to the caller and ends: the socket goes back into the maintenance wait", async () => {
        const w = watched([notice(), { state: "maintenance", code: 70, window: NONE }]);
        assert.equal(await watchMaintenance(w), "maintenance");
        assert.deepEqual(w.maintenance, [70]);
    });

    it("times each wait by the newest window it was told", async () => {
        const window = { startTime: 0, endTime: 10_000_000 };
        const w = watched([notice(window), notice(NONE)], { window, now: () => 5_000 });
        await watchMaintenance(w);
        assert.deepEqual(w.sleeps, [
            MAINTENANCE_POLL_MS.inWindow,
            MAINTENANCE_POLL_MS.inWindow,
            MAINTENANCE_POLL_MS.afterWindow,
        ]);
    });

    it("stops when told to, before or during a wait, without asking", async () => {
        const controller = new AbortController();
        controller.abort();
        let asked = 0;
        assert.equal(
            await watchMaintenance({
                check: async () => void (asked += 1),
                sleep: async () => {},
                onMaintenance() {},
                signal: controller.signal,
            }),
            "aborted",
        );
        const mid = new AbortController();
        assert.equal(
            await watchMaintenance({
                check: async () => void (asked += 1),
                sleep: async () => mid.abort(),
                onMaintenance() {},
                signal: mid.signal,
            }),
            "aborted",
        );
        assert.equal(asked, 0);
    });
});

describe("the anomaly history file", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-anomaly-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("round-trips what was saved", () => {
        const file = join(dir, "sock-anomaly.json");
        const state = {
            firstInstall: 1000,
            errors: [
                { code: 4001, time: 2000 },
                { code: "internal", time: 3000 },
            ],
        };
        assert.equal(saveAnomalyState(file, state), true);
        assert.deepEqual(loadAnomalyState(file), state);
    });

    it("starts over when the file is missing, empty, damaged or not an object", () => {
        assert.equal(loadAnomalyState(join(dir, "none.json")), undefined);
        for (const [name, text] of [
            ["empty", ""],
            ["junk", "{not json"],
            ["array-ish", "7"],
            ["null", "null"],
        ]) {
            const file = join(dir, `${name}.json`);
            writeFileSync(file, text);
            assert.equal(loadAnomalyState(file), undefined, name);
        }
    });

    it("keeps only well-formed entries and a usable first-install time", () => {
        const file = join(dir, "mixed.json");
        writeFileSync(
            file,
            JSON.stringify({
                firstInstall: "yesterday",
                errors: [
                    { code: 4001, time: 5 },
                    { code: {}, time: 6 },
                    { code: 7, time: "now" },
                    null,
                    { code: "x", time: 8 },
                ],
            }),
        );
        assert.deepEqual(loadAnomalyState(file), {
            firstInstall: undefined,
            errors: [
                { code: 4001, time: 5 },
                { code: "x", time: 8 },
            ],
        });
    });

    it("reports a failed save instead of throwing, and leaves no partial file", () => {
        const blocked = join(dir, "is-a-directory");
        mkdirSync(blocked);
        assert.equal(saveAnomalyState(blocked, { firstInstall: 1, errors: [] }), false);
    });

    it("writes only error codes and times: no identity, no credential", () => {
        const file = join(dir, "s.json");
        saveAnomalyState(file, { firstInstall: 1, errors: [{ code: 4001, time: 2 }] });
        const text = readFileSync(file, "utf8");
        assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["errors", "firstInstall"]);
    });
});
