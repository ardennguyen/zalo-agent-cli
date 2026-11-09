import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { PARK_MS, PROFILE_CHUNK_SIZE, readParked, refreshProfiles } from "../../src/core/name-refresh.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { initDb, upsertThread, getRecentThreads } from "../../src/core/db.js";
import { ZaloApiError } from "../../src/zalo/errors.js";

before(() => assertSandboxed(CONFIG_DIR));

/** Fake uids: 1001, 1002, ... (short, nowhere near a real id). */
const uids = (n, from = 1001) => Array.from({ length: n }, (_, i) => String(from + i));

/** An api whose getUserInfo answers `Name <uid>` and records every request; `refuseOn` = 1-based request to 221. */
function profileApi({ refuseOn = 0, nextTs } = {}) {
    const calls = [];
    return {
        calls,
        getAliasList: async () => ({ items: [] }),
        getAllFriends: async () => [],
        getAllGroups: async () => ({ gridVerMap: {} }),
        getUserInfo: async (ids) => {
            calls.push([...ids]);
            if (calls.length === refuseOn) {
                throw new ZaloApiError("Too many requests", 221, nextTs ? { nextTs } : undefined);
            }
            return { changed_profiles: Object.fromEntries(ids.map((id) => [id, { zaloName: `Name ${id}` }])) };
        },
    };
}

describe("non-friend name refresh (refreshProfiles)", () => {
    const stateFile = join(SANDBOX_CONFIG_DIR, "name-refresh-test", "parked.json");
    beforeEach(() => rmSync(stateFile, { force: true }));

    it("asks for every uid, in requests of 500, one after another", async () => {
        const api = profileApi();
        const res = await refreshProfiles(api, uids(1203), { stateFile, gapMs: 0 });
        // Red if a cap comes back (fewer than 1203 asked) or the chunk size drifts from Zalo PC's 500.
        assert.equal(PROFILE_CHUNK_SIZE, 500);
        assert.deepEqual(
            api.calls.map((c) => c.length),
            [500, 500, 203],
        );
        assert.equal(res.profiles.size, 1203);
        assert.equal(res.profiles.get("2203").zaloName, "Name 2203");
        assert.equal(res.stoppedBy, null);
        assert.equal(res.left, 0);
    });

    it("stops on 221, reports what was left and parks the refused request's uids for an hour", async () => {
        const api = profileApi({ refuseOn: 2 });
        const now = 1_000_000;
        const res = await refreshProfiles(api, uids(1203), { stateFile, gapMs: 0, now: () => now });
        // No third request after the refusal.
        assert.equal(api.calls.length, 2);
        assert.equal(res.stoppedBy, "rate-limit");
        assert.equal(res.asked, 500);
        assert.equal(res.left, 703);
        assert.equal(res.parkedUntil, now + PARK_MS);
        const parked = readParked(stateFile, now);
        assert.equal(parked.size, 500);
        assert.ok(parked.has("1501") && !parked.has("1500") && !parked.has("2001"));

        // The next run skips the parked uids and asks for the rest.
        const again = profileApi();
        const second = await refreshProfiles(again, uids(1203), { stateFile, gapMs: 0, now: () => now + 1000 });
        assert.equal(second.parkedSkipped, 500);
        assert.equal(again.calls.flat().length, 703);
        assert.ok(!again.calls.flat().includes("1501"));

        // An hour later they are asked again.
        const later = profileApi();
        await refreshProfiles(later, uids(1203), { stateFile, gapMs: 0, now: () => now + PARK_MS + 1 });
        assert.equal(later.calls.flat().length, 1203);
    });

    it("parks until the server's nextTs (+100 ms) when the reply names one", async () => {
        const now = 5_000_000;
        const api = profileApi({ refuseOn: 1, nextTs: now + 30_000 });
        const res = await refreshProfiles(api, uids(10), { stateFile, gapMs: 0, now: () => now });
        assert.equal(res.parkedUntil, now + 30_100);
        assert.equal(readParked(stateFile, now + 30_101).size, 0);
    });
});

describe("SyncV2._refreshDmNames", () => {
    let db;
    let seq = 0;
    beforeEach(() => {
        db = initDb(join(SANDBOX_CONFIG_DIR, `name-refresh-${seq++}.sqlite`));
    });
    afterEach(() => {
        db.close();
        delete process.env.ZALO_SYNC_NAME_REFRESH_MAX;
    });

    it("refreshes more than 500 non-friend peers in chunks of 500 and reports a 221 stop", async () => {
        const ids = uids(1100);
        for (const id of ids) upsertThread({ threadId: id, type: "dm", name: id, lastUpdate: 1 });
        const api = profileApi({ refuseOn: 3 });
        const sync = new SyncV2(api, "name-refresh-account");
        rmSync(resolve(sync.accountDir, "sync", "name-refresh-parked.json"), { force: true });
        const map = await sync._buildThreadMap(() => {});
        const res = await sync._refreshDmNames(map);
        assert.deepEqual(
            api.calls.map((c) => c.length),
            [500, 500, 100],
        );
        assert.equal(res.stoppedBy, "rate-limit");
        assert.deepEqual(
            {
                refreshed: sync.nameRefresh.refreshed,
                left: sync.nameRefresh.left,
                stoppedBy: sync.nameRefresh.stoppedBy,
            },
            { refreshed: 1000, left: 100, stoppedBy: "rate-limit" },
        );
        const titles = new Map(getRecentThreads(-1, "dm").map((t) => [String(t.threadId), t.name]));
        // Refreshed peers got their profile name; the refused 100 keep their cached title.
        assert.equal(titles.get("1001"), "Name 1001");
        assert.equal(titles.get("2000"), "Name 2000");
        assert.equal(titles.get("2001"), "2001");
        assert.ok(existsSync(resolve(sync.accountDir, "sync", "name-refresh-parked.json")));
    });

    it("ZALO_SYNC_NAME_REFRESH_MAX is an opt-in cap", async () => {
        for (const id of uids(30)) upsertThread({ threadId: id, type: "dm", name: id, lastUpdate: 1 });
        process.env.ZALO_SYNC_NAME_REFRESH_MAX = "7";
        const api = profileApi();
        const sync = new SyncV2(api, "name-refresh-cap");
        rmSync(resolve(sync.accountDir, "sync", "name-refresh-parked.json"), { force: true });
        await sync._refreshDmNames(await sync._buildThreadMap(() => {}));
        assert.equal(api.calls.flat().length, 7);
    });
});
