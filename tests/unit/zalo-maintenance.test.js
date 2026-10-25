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
    waitOutMaintenance,
} from "../../src/zalo/maintenance.js";
import { loadAnomalyState, saveAnomalyState } from "../../src/zalo/anomaly-store.js";

const answer =
    (body, ok = true) =>
    async () => ({ ok, json: async () => body });

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
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 0 }) }), { state: "ok", code: 0 });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 70 }) }), {
            state: "maintenance",
            code: 70,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 71 }) }), {
            state: "notice",
            code: 71,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer(70) }), { state: "maintenance", code: 70 });
    });

    it("calls anything it cannot read unreachable: that says nothing about maintenance", async () => {
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 5 }) }), {
            state: "unreachable",
            code: 5,
        });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({}) }), { state: "unreachable", code: null });
        assert.deepEqual(await checkMaintenance({ fetchFn: answer({ error_code: 0 }, false) }), {
            state: "unreachable",
            code: null,
        });
        assert.deepEqual(
            await checkMaintenance({
                fetchFn: async () => {
                    throw new Error("offline");
                },
            }),
            { state: "unreachable", code: null },
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
            { state: "unreachable", code: null },
        );
    });
});

describe("waitOutMaintenance", () => {
    /** A check that answers from a script, and a sleep that records instead of waiting. */
    function scripted(states) {
        const queue = [...states];
        const sleeps = [];
        const polls = [];
        return {
            check: async () => ({ state: queue.shift() ?? "ok", code: null }),
            sleep: async (ms) => void sleeps.push(ms),
            onPoll: (state) => polls.push(state),
            sleeps,
            polls,
        };
    }

    it("keeps asking every minute while Zalo is in maintenance, and returns when it is out", async () => {
        const s = scripted(["maintenance", "maintenance", "ok"]);
        const out = await waitOutMaintenance(s);
        assert.deepEqual(out, { state: "ok", code: null, polls: 3 });
        assert.deepEqual(s.sleeps, [MAINTENANCE_POLL_MS.maintenance, MAINTENANCE_POLL_MS.maintenance]);
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

    it("polls an announced window much less often than a live one", () => {
        assert.ok(MAINTENANCE_POLL_MS.notice >= 10 * MAINTENANCE_POLL_MS.maintenance);
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
