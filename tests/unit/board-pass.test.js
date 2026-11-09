/**
 * src/core/board-pass.js — which threads a board pass visits (`sync-boards`, `sync`'s boards stage, zalo_sync boards).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, upsertThread, getSyncState } from "../../src/core/db.js";
import { BOARD_RESUME_KEY, runBoardPass } from "../../src/core/board-pass.js";

before(() => assertSandboxed(CONFIG_DIR));

/** A board api that records which group it was asked about and answers an empty board. */
function recordingApi(refuse = null) {
    const asked = [];
    return {
        asked,
        getListBoard: async (_opts, groupId) => {
            asked.push(String(groupId));
            if (groupId === refuse) throw Object.assign(new Error("Too many requests"), { code: 221 });
            return { items: [] };
        },
    };
}

describe("runBoardPass", () => {
    let db;
    let seq = 0;
    beforeEach(() => {
        db = initDb(join(SANDBOX_CONFIG_DIR, `board-pass-${seq++}.sqlite`));
        // 250 groups; g0 is the oldest, far past the old 200 most-recent window.
        for (let i = 0; i < 250; i++)
            upsertThread({ threadId: `g${i}`, type: "group", name: `G${i}`, lastUpdate: i + 1 });
    });
    afterEach(() => db.close());

    it("-T fetches exactly that thread even when it is older than the 200 most recent", async () => {
        const api = recordingApi();
        const r = await runBoardPass(api, { thread: "g0", reminders: false });
        // Red under the old code: it read the 200 most recent threads, filtered for g0, found none and skipped.
        assert.equal(r.status, "ok");
        assert.deepEqual(api.asked, ["g0"]);
    });

    it("visits every cached thread by default (no 200 cap)", async () => {
        const api = recordingApi();
        const r = await runBoardPass(api, { reminders: false });
        assert.equal(r.stats.threads, 250);
        assert.equal(new Set(api.asked).size, 250);
    });

    it("an explicit limit still bounds the pass", async () => {
        const api = recordingApi();
        await runBoardPass(api, { reminders: false, limit: 5 });
        assert.deepEqual(api.asked.sort(), ["g245", "g246", "g247", "g248", "g249"]);
    });

    it("on 221 stops, notes the stop, and the next pass resumes at the refused thread", async () => {
        const first = recordingApi("g100");
        const r = await runBoardPass(first, { reminders: false, concurrency: 1 });
        assert.equal(r.stats.stoppedBy, "rate-limit");
        assert.match(r.note, /221/);
        assert.equal(getSyncState(BOARD_RESUME_KEY), "g100");
        // Most recent first: g249 ... g101 were done, g100 was refused.
        assert.equal(r.stats.threads, 149);

        const second = recordingApi();
        const again = await runBoardPass(second, { reminders: false, concurrency: 1 });
        assert.equal(again.resumed, true);
        assert.equal(second.asked[0], "g100");
        assert.equal(again.stats.threads, 250);
        assert.equal(getSyncState(BOARD_RESUME_KEY), null);
    });
});
