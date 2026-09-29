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

/**
 * The same rules once a running daemon can lend its socket.
 *
 * `lockOk: false` used to mean one thing — skip the socket stages — and now
 * means two, split by whether that daemon published a usable channel. The
 * risk in that split is a plan that reads "RUN" and then opens a second
 * WebSocket anyway, which is what evicts the daemon and loses messages.
 */
describe("planSyncRun — through a running daemon", () => {
    it("runs the socket stages on the daemon instead of skipping them", () => {
        const plan = planSyncRun({ freshness: stale, lockOk: false, daemonChannel: true });
        const s = byName(plan);
        assert.equal(s.messages.run, true);
        assert.equal(s.reactions.run, true);
        assert.equal(s.messages.via, "daemon");
        assert.equal(s.reactions.via, "daemon");
        assert.equal(plan.viaDaemon, true);
        // The whole point: nothing here opens a second session.
        assert.equal(plan.openSocket, false, "a hand-off must not also open a socket of our own");
    });

    it("leaves the REST stages exactly where they were", () => {
        const s = byName(planSyncRun({ freshness: stale, lockOk: false, daemonChannel: true }));
        for (const n of ["convState", "boards", "cloud", "media"]) {
            assert.equal(s[n].run, true, n);
            assert.equal(s[n].via, "local", `${n} needs no socket and must not be routed anywhere`);
        }
    });

    it("keeps the stages local when we hold the lock ourselves", () => {
        // A stale channel file from a daemon that has since exited must not
        // send a run that legitimately owns the socket through a dead port.
        const plan = planSyncRun({ freshness: stale, lockOk: true, daemonChannel: true });
        assert.equal(plan.openSocket, true);
        assert.equal(plan.viaDaemon, false);
        assert.equal(byName(plan).messages.via, "local");
    });

    it("still debounces the phone prompt — a lent socket is not a reason to re-ping", () => {
        const plan = planSyncRun({ freshness: fresh, lockOk: false, daemonChannel: true });
        const s = byName(plan);
        assert.equal(s.messages.run, false);
        assert.match(s.messages.why, /synced recently/);
        assert.equal(s.messages.via, "local", "a skipped stage is routed nowhere");
        assert.equal(s.reactions.run, true, "the backlog never prompts the phone, so it still runs");
        assert.equal(plan.viaDaemon, true);
    });

    it("still honours --no-messages / --no-reactions", () => {
        const plan = planSyncRun({
            want: { messages: false, reactions: false },
            freshness: stale,
            lockOk: false,
            daemonChannel: true,
        });
        assert.equal(plan.viaDaemon, false);
        assert.equal(plan.openSocket, false);
        assert.equal(byName(plan).messages.why, "--no-messages");
    });

    it("never plans more than one stage that wakes the phone, on either socket", () => {
        // The invariant that protects a real person from two prompts. Routing
        // through a daemon removes the second WebSocket, not the tap.
        const names = STAGES.map((s) => s.name);
        for (const daemonChannel of [false, true]) {
            for (const lockOk of [false, true]) {
                for (let mask = 0; mask < 1 << names.length; mask++) {
                    const want = Object.fromEntries(names.map((n, i) => [n, Boolean(mask & (1 << i))]));
                    const plan = planSyncRun({ want, freshness: stale, lockOk, daemonChannel });
                    assert.ok(
                        plan.stages.filter((s) => s.run && s.phone).length <= 1,
                        JSON.stringify({ want, lockOk, daemonChannel }),
                    );
                    // And a run is never both: opening our own socket while a
                    // daemon runs a stage on its one is the eviction itself.
                    assert.ok(
                        !(plan.openSocket && plan.viaDaemon),
                        `openSocket and viaDaemon are exclusive: ${JSON.stringify({ lockOk, daemonChannel })}`,
                    );
                }
            }
        }
    });
});
