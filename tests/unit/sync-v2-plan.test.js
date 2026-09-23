/**
 * `src/core/sync-v2/plan.js` — what one `zalo-agent sync` run will do.
 *
 * The rules checked here are the ones a live run cannot afford to get wrong:
 * the owner's phone is prompted at most once, the socket window is opened at
 * most once, and a running listen/mcp daemon is never evicted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSyncRun, STAGES } from "../../src/core/sync-v2/plan.js";

const stale = { skip: false, reason: "stale" };
const fresh = { skip: true, reason: "fresh" };
const byName = (plan) => Object.fromEntries(plan.stages.map((s) => [s.name, s]));

describe("planSyncRun", () => {
    it("runs every stage by default, socket stages first", () => {
        const plan = planSyncRun({ freshness: stale });
        assert.deepEqual(
            plan.stages.map((s) => s.name),
            ["messages", "reactions", "convState", "boards", "cloud", "media"],
        );
        assert.ok(plan.stages.every((s) => s.run));
        assert.equal(plan.openSocket, true);
        const firstRest = plan.stages.findIndex((s) => s.transport !== "socket");
        assert.ok(
            plan.stages.slice(firstRest).every((s) => s.transport !== "socket"),
            "no socket stage may follow a REST one -- that would need a second socket window",
        );
    });

    it("never plans more than one stage that wakes the phone", () => {
        // Checked across every combination of stage switches.
        const names = STAGES.map((s) => s.name);
        for (let mask = 0; mask < 1 << names.length; mask++) {
            const want = Object.fromEntries(names.map((n, i) => [n, Boolean(mask & (1 << i))]));
            const plan = planSyncRun({ want, freshness: stale });
            assert.ok(plan.stages.filter((s) => s.run && s.phone).length <= 1, JSON.stringify(want));
        }
    });

    it("skips the phone prompt when the last sync is fresh, and says so", () => {
        const s = byName(planSyncRun({ freshness: fresh }));
        assert.equal(s.messages.run, false);
        assert.match(s.messages.why, /synced recently/);
        assert.match(s.messages.why, /--force/);
        assert.equal(s.reactions.run, true, "the backlog is not debounced -- it never prompts the phone");
    });

    it("says why a restore runs", () => {
        assert.equal(
            byName(planSyncRun({ freshness: { skip: false, reason: "pending-gap" } })).messages.why,
            "pending-gap",
        );
    });

    it("does not evict a running daemon: both socket stages skip, REST stages still run", () => {
        const plan = planSyncRun({ freshness: stale, lockOk: false });
        const s = byName(plan);
        assert.equal(plan.openSocket, false);
        assert.equal(s.messages.run, false);
        assert.equal(s.reactions.run, false);
        assert.match(s.messages.why, /daemon holds/);
        for (const n of ["convState", "boards", "cloud", "media"]) assert.equal(s[n].run, true, n);
    });

    it("opens no socket when neither socket stage is wanted", () => {
        const plan = planSyncRun({ want: { messages: false, reactions: false }, freshness: stale });
        assert.equal(plan.openSocket, false);
    });

    it("opens no socket when messages are fresh and reactions are off", () => {
        assert.equal(planSyncRun({ want: { reactions: false }, freshness: fresh }).openSocket, false);
    });

    it("names the flag that switched a stage off", () => {
        const s = byName(planSyncRun({ want: { convState: false, boards: false }, freshness: stale }));
        assert.equal(s.convState.why, "--no-conv-state");
        assert.equal(s.boards.why, "--no-boards");
    });
});
