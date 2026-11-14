/**
 * The cloud walk beside a running daemon (D31, research row ZP-09).
 *
 * The daemon walks the zCloud queue on its own when the server sends cmd 621, under its stage lock. A `sync` or
 * `sync-cloud` that walked it at the same time, in its own process, could write the saved place out of order, and a
 * `--full` sweep could delete what the daemon had just recorded. Now the walk runs in the daemon (its `cloud` stage,
 * under the same lock), and a process that holds the account but cannot run it means no walk at all.
 *
 * No network: the walker and the verify call are injected; ids are throwaway constants.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getSyncState, setSyncState } from "../../src/core/db.js";
import { cloudPass, cloudWalkRoute } from "../../src/commands/sync.js";
import { createSyncRunners } from "../../src/core/daemon-sync.js";
import { createStageLock, getSyncChannel, startDaemonChannel, syncViaDaemon } from "../../src/core/daemon-channel.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-cloud-walk-route-"));
const opened = [];
const started = [];
let n = 0;
let dir;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n}.sqlite`)));
    dir = join(ROOT, `acct${n++}`);
    mkdirSync(dir, { recursive: true });
});

after(() => {
    for (const c of started) {
        try {
            c.stop();
        } catch {
            /* already stopped */
        }
    }
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering handle is not worth failing the run over */
    }
});

/** A walker that records its options and moves the saved place as the real one does. */
function fakeWalker() {
    const calls = [];
    const walk = async (opts) => {
        calls.push(opts);
        opts.onProgress?.({ phase: "cloud-page", page: 1, items: 2, removed: 0 });
        opts.onPage?.({ cursor: "after-walk", page: 1, complete: true });
        return { items: 2, removed: 0, pages: 1, failed: 0, failures: [], complete: true, lastNoiseId: "after-walk" };
    };
    return { calls, walk };
}

describe("cloud walk route — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("where the walk runs", () => {
    it("in the daemon when it runs the cloud stage; here when nothing holds the account; nowhere otherwise", () => {
        assert.equal(cloudWalkRoute({ locked: true, chan: { stages: ["cloud"] } }).via, "daemon");
        assert.equal(cloudWalkRoute({ locked: false, chan: null }).via, "local");
        const skip = cloudWalkRoute({ locked: true, chan: null });
        assert.equal(skip.via, "skip", "a daemon without the stage may be walking the queue itself");
        assert.match(skip.reason, /restart the daemon/);
    });
});

describe("cloudPass hands the walk over", () => {
    const api = { getOwnId: () => "1001" };
    const freePlan = { settings: async () => ({}), myCloud: async () => ({ plan: 1 }), usage: async () => ({}) };

    it("asks the given walker, with an explicit resume only, and walks nothing itself", async () => {
        setSyncState("cloudCursor", "saved-place");
        const asked = [];
        let localVerify = 0;
        const r = await cloudPass(api, {
            ...freePlan,
            resume: "explicit",
            full: true,
            pages: 9,
            verify: async () => {
                localVerify++;
                return {};
            },
            walk: async (p) => {
                asked.push(p);
                p.onProgress({ page: 1, items: 4 });
                return { items: 4, removed: 0, pages: 1, failed: 0, failures: [], complete: true };
            },
        });
        assert.equal(r.status, "ok");
        assert.equal(localVerify, 0);
        assert.equal(asked.length, 1);
        assert.deepEqual(
            { resume: asked[0].resume, full: asked[0].full, maxPages: asked[0].maxPages },
            { resume: "explicit", full: true, maxPages: 9 },
        );
        assert.equal(getSyncState("cloudCursor"), "saved-place", "the daemon keeps the place, not this process");
    });
});

describe("the daemon's cloud stage", () => {
    it("walks from the daemon's saved place and keeps it", async () => {
        setSyncState("cloudCursor", "daemon-place");
        const w = fakeWalker();
        const runners = createSyncRunners({ getApi: () => ({ id: "api" }), accountName: "1001", cloudWalk: w.walk });
        const events = [];
        const stats = await runners.cloud({ maxPages: 7 }, (e) => events.push(e));
        assert.equal(stats.items, 2);
        assert.equal(w.calls[0].lastNoiseId, "daemon-place");
        assert.equal(w.calls[0].maxPages, 7);
        assert.equal(w.calls[0].full, false);
        assert.equal(getSyncState("cloudCursor"), "after-walk");
        assert.equal(events[0].phase, "cloud-page");
    });

    it("takes an explicit resume over the saved place, and a full walk", async () => {
        setSyncState("cloudCursor", "daemon-place");
        const w = fakeWalker();
        const runners = createSyncRunners({ getApi: () => ({}), accountName: "1001", cloudWalk: w.walk });
        await runners.cloud({ resume: "explicit", full: true });
        assert.equal(w.calls[0].lastNoiseId, "explicit");
        assert.equal(w.calls[0].full, true);
    });

    it("is served on the channel, and waits its turn behind the daemon's own cmd 621 walk", async () => {
        const w = fakeWalker();
        const lock = createStageLock();
        const runners = createSyncRunners({ getApi: () => ({}), accountName: "1001", cloudWalk: w.walk });
        const chan = await startDaemonChannel({ getApi: () => ({}), accountDir: dir, runners, lock });
        started.push(chan);
        assert.ok(getSyncChannel(dir, "cloud"), "the descriptor offers the cloud stage");

        // The cmd 621 walker holds the stage lock: the CLI's walk is refused, never run beside it.
        const release = lock.tryAcquire("cloud-verify");
        const busy = await syncViaDaemon(dir, { stage: "cloud", params: {} });
        assert.equal(busy.ok, false);
        assert.equal(busy.busyStage, "cloud-verify");
        assert.equal(w.calls.length, 0);
        release();

        const events = [];
        const ok = await syncViaDaemon(dir, {
            stage: "cloud",
            params: { maxPages: 3 },
            onEvent: (e) => events.push(e),
        });
        assert.equal(ok.ok, true);
        assert.equal(ok.result.items, 2);
        assert.equal(w.calls[0].maxPages, 3);
        assert.equal(events[0].phase, "cloud-page");
    });
});
