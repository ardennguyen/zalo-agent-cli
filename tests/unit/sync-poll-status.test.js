/**
 * `SyncManager.pollSync()` — its status contract, and the guarantee that every
 * status it can return is actually handled by a consumer.
 *
 * The bug this suite exists for: `listen`'s gap backfill switched on
 * `"saved" | "crossdb-error" | "no-token"`. `pollSync` had been changed to
 * return `"legacy-retired"` when the retired `pullMobileMsg` endpoint answers
 * without a session token — and `"no-token"` was left behind, matching nothing
 * that is ever returned. So the daemon printed "Attempting mobile-sync
 * backfill..." and then said nothing at all, forever, on every startup gap.
 * `"empty-or-unrecognized"` fell through the same hole.
 *
 * Two layers here:
 *
 *  1. Behavioral — drive `pollSync` against a stub api and pin each status,
 *     including that the retired path is attempted exactly ONCE and never
 *     reaches `getCrossDB` (every retry used to buzz a real person's phone).
 *  2. Static — the same technique as tests/unit/sync-socket-rules.test.js:
 *     read the source and fail the build when a status has no handler, or when
 *     `listen.js` reaches for the dead path again. A status that no consumer
 *     names is precisely the defect, and it is invisible to a unit test that
 *     only ever asserts on statuses someone remembered to write down.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SyncManager } from "../../src/core/sync.js";
import { recordSyncGap, getPendingSyncGaps } from "../../src/core/db.js";

const SRC_DIR = join(import.meta.dirname, "..", "..", "src");
const SYNC_CORE = readFileSync(join(SRC_DIR, "core", "sync.js"), "utf8");
const SYNC_CMD = readFileSync(join(SRC_DIR, "commands", "sync.js"), "utf8");

/**
 * Source with comments removed. The "does listen.js call this?" guards below
 * must answer about code, not prose — listen.js documents at length WHY it no
 * longer calls pollSync, and that explanation must not read as a call site.
 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const LISTEN_SRC = readFileSync(join(SRC_DIR, "commands", "listen.js"), "utf8");
const LISTEN_CODE = stripComments(LISTEN_SRC);

/** Unique account id per test so each gets a clean zalo.db. */
let seq = 0;
const nextAccount = () => `poll_${process.pid}_${++seq}`;

/**
 * Minimal stand-in for the two REST calls pollSync makes. Records what was
 * called so "one attempt, then stop" is assertable.
 */
function stubApi({ pull = null, crossDb = null, crossDbThrows = null } = {}) {
    const calls = [];
    return {
        calls,
        async pullMobileMsg(...args) {
            calls.push(["pullMobileMsg", ...args]);
            return pull;
        },
        async getCrossDB(...args) {
            calls.push(["getCrossDB", ...args]);
            if (crossDbThrows) throw new Error(crossDbThrows);
            return crossDb;
        },
        async deleteSnapshotMobileMsg(...args) {
            calls.push(["deleteSnapshotMobileMsg", ...args]);
        },
    };
}

const named = (api) => api.calls.map((c) => c[0]);

describe("pollSync status contract", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    let account;
    beforeEach(() => {
        account = nextAccount();
    });

    it('returns "already-synced" without touching the API when nothing is known to be missing', async () => {
        const api = stubApi({ pull: "tok" });
        const m = new SyncManager(api, account);
        m.markConnected(); // lastConnectionOk = true, no pending gaps

        const res = await m.pollSync();
        assert.equal(res.status, "already-synced");
        assert.equal(res.cached, true);
        assert.deepEqual(named(api), [], "the debounce must not ping the phone");
    });

    it("a pending gap defeats the debounce", async () => {
        const api = stubApi({ pull: null });
        const m = new SyncManager(api, account);
        m.markConnected();
        m._ensureDb();
        recordSyncGap(Date.now() - 10_000, Date.now(), "test-gap");

        const res = await m.pollSync();
        assert.equal(res.status, "legacy-retired");
        assert.deepEqual(named(api), ["pullMobileMsg"]);
    });

    it('returns "legacy-retired" when the retired endpoint yields no session token', async () => {
        for (const pull of [null, undefined, "", { data: "" }, { error_code: 0, data: null }]) {
            const api = stubApi({ pull });
            const res = await new SyncManager(api, nextAccount()).pollSync(0, 0, { force: true });
            assert.equal(res.status, "legacy-retired", `pull=${JSON.stringify(pull)}`);
        }
    });

    it("the retired path is attempted exactly once and never reaches getCrossDB", async () => {
        // Each retry used to put a notification on the owner's phone.
        const api = stubApi({ pull: null });
        await new SyncManager(api, account).pollSync(0, 0, { force: true });
        assert.deepEqual(named(api), ["pullMobileMsg"]);
    });

    it('"legacy-retired" leaves the gap pending — nothing was actually synced', async () => {
        const api = stubApi({ pull: null });
        const m = new SyncManager(api, account);
        m._ensureDb();
        recordSyncGap(Date.now() - 10_000, Date.now(), "startup-gap");

        await m.pollSync(0, 0, { force: true });
        assert.equal(getPendingSyncGaps().length, 1, "a retired endpoint settles nothing");
    });

    it('returns "crossdb-error" when the retrieval call throws', async () => {
        const api = stubApi({ pull: "session-token", crossDbThrows: "boom" });
        const res = await new SyncManager(api, account).pollSync(0, 0, { force: true });
        assert.equal(res.status, "crossdb-error");
        assert.equal(res.error, "boom");
        assert.equal(res.token, "session-token");
        assert.deepEqual(named(api), ["pullMobileMsg", "getCrossDB"]);
    });

    it('returns "empty-or-unrecognized" on a round trip that carried no records', async () => {
        const api = stubApi({ pull: "session-token", crossDb: { data: { msgs: [] } } });
        const res = await new SyncManager(api, account).pollSync(0, 0, { force: true });
        assert.equal(res.status, "empty-or-unrecognized");
        assert.ok(res.dumpFile, "the raw payload is always dumped");
        assert.deepEqual(named(api), ["pullMobileMsg", "getCrossDB", "deleteSnapshotMobileMsg"]);
    });

    it('returns "saved" and resolves pending gaps when records come back', async () => {
        const api = stubApi({
            pull: "session-token",
            crossDb: {
                data: {
                    msgs: [
                        { msgId: "m1", toId: "t1", uidFrom: "u1", dName: "A", content: "hello", ts: Date.now() },
                        { msgId: "m2", toId: "t1", uidFrom: "u1", dName: "A", content: "there", ts: Date.now() },
                    ],
                },
            },
        });
        const m = new SyncManager(api, account);
        m._ensureDb();
        recordSyncGap(Date.now() - 10_000, Date.now(), "startup-gap");

        const res = await m.pollSync(0, 0, { force: true });
        assert.equal(res.status, "saved");
        assert.equal(res.saved, 2);
        assert.equal(res.total, 2);
        assert.deepEqual(getPendingSyncGaps(), [], "a completed round trip covers what we knew was missing");
    });
});

describe("no pollSync status can fall through silently", () => {
    /** Every `status: "..."` literal reachable from pollSync's own code path. */
    const returned = new Set(
        [...SYNC_CORE.matchAll(/status:\s*"([a-z-]+)"/g)]
            .map((m) => m[1])
            // backfillOverSocket has its own, separate consumer.
            .filter((s) => s !== "backfilled"),
    );

    it("pollSync still returns the statuses this suite pins", () => {
        for (const s of ["already-synced", "legacy-retired", "crossdb-error", "empty-or-unrecognized", "saved"]) {
            assert.ok(returned.has(s), `pollSync no longer returns "${s}" — update this suite and its consumers`);
        }
    });

    it("runLegacySync handles every one of them, plus a default", () => {
        const start = SYNC_CMD.indexOf("async function runLegacySync");
        assert.ok(start > 0, "runLegacySync must exist — it is the only remaining pollSync consumer");
        const body = SYNC_CMD.slice(start);
        const handled = new Set([...body.matchAll(/case\s*"([a-z-]+)":/g)].map((m) => m[1]));

        const unhandled = [...returned].filter((s) => !handled.has(s));
        assert.deepEqual(unhandled, [], `pollSync can return these with no branch: ${unhandled.join(", ")}`);

        const stale = [...handled].filter((s) => !returned.has(s));
        assert.deepEqual(stale, [], `runLegacySync branches on statuses pollSync never returns: ${stale.join(", ")}`);

        assert.ok(/\bdefault:/.test(body), "a default branch is what stops the next new status going silent");
    });

    it("listen.js never calls the retired path again", () => {
        // The daemon reports gaps; `zalo-agent sync` closes them. Re-adding a
        // pollSync call here would reinstate the exact defect: a hopeful line
        // followed by silence, and a gap pending forever.
        assert.ok(!/pollSync\s*\(/.test(LISTEN_CODE), "listen.js must not call pollSync");
        assert.ok(!/pullMobileMsg|getCrossDB/.test(LISTEN_CODE), "listen.js must not call the retired endpoints");
    });

    it("listen.js tells the owner the command that does work", () => {
        assert.ok(/describeGap\s*\(/.test(LISTEN_CODE), "gap reporting goes through describeGap()");
        assert.ok(
            !/Attempting mobile-sync backfill/.test(LISTEN_SRC),
            "the daemon must not claim an attempt it does not make",
        );
        assert.ok(
            !/will be retried on next launch or/.test(LISTEN_SRC),
            "that retry promise pointed at a path that can never succeed",
        );
    });

    it("startup reports any downtime, with no threshold of its own", () => {
        // A crash under a supervisor restarts in seconds. The old
        // `Date.now() - lastConnectedAt > 30 * 1000` gate put exactly that case
        // on the markConnected() branch, so the daemon claimed it was caught up
        // over a window it never saw and nothing else would ever flag. The only
        // threshold that belongs here is recordGap's 1-second floor.
        // Bound the slice to the startup block itself. Reading to end-of-file
        // sweeps in every other timeout in listen.js and the 30s assertion below
        // fires on an unrelated one.
        const begin = LISTEN_CODE.indexOf("getLastConnectedAt");
        const end = LISTEN_CODE.indexOf("heartbeatTimer", begin);
        assert.ok(begin !== -1 && end > begin, "startup block not found — this guard has drifted from the source");
        const startup = LISTEN_CODE.slice(begin, end);
        assert.ok(
            !/lastConnectedAt\s*[<>]|[<>]\s*lastConnectedAt/.test(startup),
            "no comparison on lastConnectedAt — the floor lives in recordGap()",
        );
        assert.ok(
            !/30\s*\*\s*1000|30000/.test(startup),
            "a re-added 30s gate would silently drop fast-restart gaps again",
        );
        // markConnected() must stay reachable: when nothing was filed we really
        // are caught up, and leaving lastConnectedAt stale would inflate the
        // next startup's gap.
        assert.ok(
            /reportGap\s*\(\s*lastConnectedAt\s*,\s*["']startup-gap["']\s*\)/.test(startup),
            "startup must run the gap report unconditionally",
        );
        assert.ok(/markConnected\s*\(\s*\)/.test(startup), "the no-gap branch must still stamp connected");
    });
});
