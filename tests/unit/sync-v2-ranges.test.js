/**
 * What a restore still has to ask for (src/core/sync-v2/ranges.js, plan items Y5a-d), and the table that remembers it
 * (sync_ranges in src/core/db.js): skip what is settled, continue from what is, ask in full for the rest, drop what no
 * longer exists.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    countSyncRanges,
    deleteSyncRanges,
    getSyncRanges,
    initDb,
    markSyncRangesPending,
    setSyncRangeStatus,
} from "../../src/core/db.js";
import { coveredAfter, planRanges, rangeStatusAfter } from "../../src/core/sync-v2/ranges.js";

const ask = (partition, from, to) => ({ partition, from, to });
const range = (partition, fromTs, toTs, status = "done") => ({ partition, fromTs, toTs, status });

describe("planRanges", () => {
    it("asks in full for a conversation nothing is recorded about", () => {
        const { todo, skipped, orphans } = planRanges({ asked: [ask("oneone/A", 0, 100)], prior: [] });
        assert.deepEqual(todo, [{ partition: "oneone/A", from: 0, to: 100, incremental: false }]);
        assert.deepEqual(skipped, []);
        assert.deepEqual(orphans, []);
    });

    it("skips a conversation settled for a window that covers this one, up to this one's last message", () => {
        const { todo, skipped } = planRanges({
            asked: [ask("oneone/A", 50, 100)],
            prior: [range("oneone/A", 0, 100)],
        });
        assert.deepEqual(todo, []);
        assert.deepEqual(skipped, ["oneone/A"]);
    });

    it("continues from the earlier last message when the conversation has moved on (incremental)", () => {
        const { todo, skipped } = planRanges({
            asked: [ask("group/B", 0, 500)],
            prior: [range("group/B", 0, 300)],
        });
        assert.deepEqual(todo, [{ partition: "group/B", from: 300, to: 500, incremental: true }]);
        assert.deepEqual(skipped, []);
    });

    it("does not continue from before the window it was asked for", () => {
        const { todo } = planRanges({ asked: [ask("group/B", 400, 500)], prior: [range("group/B", 0, 300)] });
        assert.equal(todo[0].from, 400);
    });

    it("asks in full when the earlier run covered less far back than this one wants", () => {
        const { todo, skipped } = planRanges({
            asked: [ask("oneone/A", 0, 100)],
            prior: [range("oneone/A", 80, 100)],
        });
        assert.deepEqual(todo, [{ partition: "oneone/A", from: 0, to: 100, incremental: false }]);
        assert.deepEqual(skipped, [], "a --days 1 run says nothing about last week");
    });

    it("asks in full for a conversation whose range is failed or pending, so a resume picks it up", () => {
        const { todo } = planRanges({
            asked: [ask("a", 0, 10), ask("b", 0, 10)],
            prior: [range("a", 0, 10, "failed"), range("b", 0, 10, "pending")],
        });
        assert.deepEqual(
            todo.map((t) => [t.partition, t.incremental]),
            [
                ["a", false],
                ["b", false],
            ],
        );
    });

    it("ignores everything recorded on a full resync, and drops nothing as skipped", () => {
        const { todo, skipped } = planRanges({
            asked: [ask("a", 0, 10)],
            prior: [range("a", 0, 10)],
            fullResync: true,
        });
        assert.deepEqual(todo, [{ partition: "a", from: 0, to: 10, incremental: false }]);
        assert.deepEqual(skipped, []);
    });

    it("keeps the order of the conversations it was given", () => {
        const { todo } = planRanges({
            asked: [ask("c", 0, 1), ask("a", 0, 1), ask("b", 0, 1)],
            prior: [range("a", 0, 1)],
        });
        assert.deepEqual(
            todo.map((t) => t.partition),
            ["c", "b"],
        );
    });

    it("drops the unfinished range of a conversation that is gone, and keeps what is settled", () => {
        const { orphans } = planRanges({
            asked: [ask("a", 0, 1)],
            prior: [
                range("gone-failed", 0, 5, "failed"),
                range("gone-pending", 0, 5, "pending"),
                range("gone-done", 0, 5),
            ],
        });
        assert.deepEqual(orphans.sort(), ["gone-failed", "gone-pending"]);
    });
});

describe("coveredAfter", () => {
    it("is the window asked for after a full ask", () => {
        assert.deepEqual(coveredAfter(ask("a", 10, 100), undefined, false), { fromTs: 10, toTs: 100 });
    });

    it("keeps the earlier start after an incremental ask", () => {
        assert.deepEqual(coveredAfter(ask("a", 300, 500), range("a", 0, 300), true), { fromTs: 0, toTs: 500 });
    });
});

describe("rangeStatusAfter", () => {
    const session = (over = {}) => ({ done: false, failed: new Set(), covered: new Set(), ...over });

    it("a partition the phone reported as failed is failed, even in a session that finished", () => {
        assert.equal(rangeStatusAfter("p", session({ done: true, failed: new Set(["p"]) })), "failed");
    });

    it("a partition the phone served is done, and so is everything in a session that finished", () => {
        assert.equal(rangeStatusAfter("p", session({ covered: new Set(["p"]) })), "done");
        assert.equal(rangeStatusAfter("p", session({ done: true })), "done");
    });

    it("a partition of a session that ended early and was not served stays pending", () => {
        assert.equal(rangeStatusAfter("p", session()), "pending");
    });
});

describe("the sync_ranges table", () => {
    let n = 0;

    before(() => {
        assertSandboxed(CONFIG_DIR);
    });

    beforeEach(() => {
        initDb(join(SANDBOX_CONFIG_DIR, `ranges-${n++}.sqlite`));
    });

    it("records ranges as pending, and counts an attempt each time they are asked for", () => {
        markSyncRangesPending([
            { partition: "a", fromTs: 0, toTs: 10 },
            { partition: "b", fromTs: 0, toTs: 20 },
        ]);
        markSyncRangesPending([{ partition: "a", fromTs: 0, toTs: 15 }]);
        const rows = Object.fromEntries(getSyncRanges().map((r) => [r.partition, r]));
        assert.equal(rows.a.attempts, 2);
        assert.equal(rows.a.toTs, 15, "the new window replaces the old");
        assert.equal(rows.b.attempts, 1);
        assert.deepEqual(countSyncRanges(), { pending: 2, failed: 0, done: 0 });
    });

    it("settles a range as done with the window it now covers, or as failed with why", () => {
        markSyncRangesPending([
            { partition: "a", fromTs: 0, toTs: 10 },
            { partition: "b", fromTs: 0, toTs: 20 },
        ]);
        setSyncRangeStatus("a", "done", { fromTs: 0, toTs: 10 });
        setSyncRangeStatus("b", "failed", { reason: "download:not-found" });
        assert.deepEqual(countSyncRanges(), { pending: 0, failed: 1, done: 1 });
        assert.equal(getSyncRanges("failed")[0].reason, "download:not-found");
        assert.equal(getSyncRanges("failed")[0].toTs, 20, "a failure keeps the window it was asked for");
        assert.deepEqual(
            getSyncRanges("done").map((r) => r.partition),
            ["a"],
        );
    });

    it("keeps a done range's window when it is set done again without one", () => {
        markSyncRangesPending([{ partition: "a", fromTs: 5, toTs: 10 }]);
        setSyncRangeStatus("a", "done");
        assert.deepEqual(
            getSyncRanges().map((r) => [r.fromTs, r.toTs, r.status]),
            [[5, 10, "done"]],
        );
    });

    it("creates the row when a range is settled that was never recorded", () => {
        setSyncRangeStatus("new", "done", { fromTs: 1, toTs: 2 });
        assert.deepEqual(
            getSyncRanges().map((r) => [r.partition, r.fromTs, r.toTs]),
            [["new", 1, 2]],
        );
    });

    it("forgets some ranges, or all of them", () => {
        markSyncRangesPending(["a", "b", "c"].map((partition) => ({ partition, fromTs: 0, toTs: 1 })));
        assert.equal(deleteSyncRanges(["a", "b"]), 2);
        assert.deepEqual(
            getSyncRanges().map((r) => r.partition),
            ["c"],
        );
        assert.equal(deleteSyncRanges(), 1);
        assert.deepEqual(countSyncRanges(), { pending: 0, failed: 0, done: 0 });
    });
});
