/**
 * src/core/sync-v2/gap-advice.js — what the `listen` daemon tells the owner
 * about a coverage gap.
 *
 * The daemon used to say "Attempting mobile-sync backfill..." and then go
 * silent: it called the retired `pullMobileMsg` path, got back
 * `{status: "legacy-retired"}`, and matched none of its own status branches.
 * The gap stayed pending forever and the owner was never told. It now reports
 * the window and names the command that closes it.
 *
 * The advice is only worth printing if it WORKS, so the load-bearing case here
 * is the round trip: take the `--from` date the daemon prints, push it through
 * the same `resolveSyncWindow()` the real `sync` command uses, and assert
 * `recordRestoreSuccess()` actually resolves that gap. A date even one day late
 * yields a command that looks right, runs fine, and silently leaves the gap
 * pending — which is the original defect wearing a new hat.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { describeGap, syncFromDate, formatSpan } from "../../src/core/sync-v2/gap-advice.js";
import { resolveSyncWindow, recordRestoreSuccess } from "../../src/core/sync-v2/index.js";
import { SyncManager, MAX_GAP_MS } from "../../src/core/sync.js";
import { getPendingSyncGaps, recordSyncGap } from "../../src/core/db.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Unique account id per test so each gets a clean zalo.db. */
let seq = 0;
const nextAccount = () => `gapadv_${process.pid}_${++seq}`;

describe("syncFromDate", () => {
    it("never lands after the timestamp it describes", () => {
        // The whole point: `--from <date>` is parsed as UTC midnight, so the
        // day must be the one the gap starts in, not the next one.
        for (const ts of [
            Date.UTC(2026, 8, 25, 0, 0, 0),
            Date.UTC(2026, 8, 25, 7, 26, 13),
            Date.UTC(2026, 8, 25, 23, 59, 59, 999),
        ]) {
            const parsed = Date.parse(syncFromDate(ts));
            assert.ok(parsed <= ts, `${syncFromDate(ts)} (${parsed}) must be <= ${ts}`);
            assert.equal(syncFromDate(ts), "2026-09-25");
        }
    });

    it("clamps junk to the epoch rather than emitting Invalid Date", () => {
        assert.equal(syncFromDate(-1), "1970-01-01");
        assert.equal(syncFromDate(undefined), "1970-01-01");
        assert.equal(syncFromDate(NaN), "1970-01-01");
    });
});

describe("formatSpan", () => {
    it("scales the unit to the size of the gap", () => {
        assert.equal(formatSpan(45 * 1000), "45s");
        assert.equal(formatSpan(45 * MINUTE), "45m");
        assert.equal(formatSpan(4 * HOUR + 12 * MINUTE), "4h 12m");
        // The live report that prompted this said "~4356m" — three days.
        assert.equal(formatSpan(4356 * MINUTE), "3d 0h");
    });

    it("floors the remainder so it can never print an overflowing unit", () => {
        // Rounding 23h40m up would give the nonsense "3d 24h".
        assert.equal(formatSpan(3 * DAY + 23 * HOUR + 40 * MINUTE), "3d 23h");
        assert.equal(formatSpan(2 * HOUR + 59 * MINUTE + 59 * 1000), "2h 59m");
    });

    it("never produces a negative or NaN span", () => {
        assert.equal(formatSpan(-5000), "0s");
        assert.equal(formatSpan(NaN), "0s");
        assert.equal(formatSpan(undefined), "0s");
    });
});

describe("describeGap", () => {
    it("names the command that closes this gap, dated from the gap's own start", () => {
        const from = Date.UTC(2026, 8, 25, 7, 26, 13);
        const to = Date.UTC(2026, 8, 28, 8, 2, 39);
        const a = describeGap({ fromTs: from, toTs: to, reason: "startup-gap", pendingGaps: [{ fromTs: from }] });

        assert.equal(a.reason, "startup-gap");
        assert.equal(a.command, "zalo-agent sync --from 2026-09-25");
        assert.equal(a.sinceDate, "2026-09-25");
        assert.equal(a.span, "3d 0h");
        assert.equal(a.from, "2026-09-25T07:26:13.000Z");
        assert.equal(a.to, "2026-09-28T08:02:39.000Z");
    });

    it("offers a single wider command when older gaps are still pending", () => {
        const from = Date.UTC(2026, 8, 25, 7, 0, 0);
        const a = describeGap({
            fromTs: from,
            toTs: Date.UTC(2026, 8, 28, 8, 0, 0),
            reason: "startup-gap",
            pendingGaps: [
                { fromTs: Date.UTC(2026, 8, 1, 3, 0, 0) },
                { fromTs: Date.UTC(2026, 8, 12, 9, 0, 0) },
                { fromTs: from },
            ],
        });

        assert.equal(a.pendingCount, 3);
        assert.equal(a.olderPending, 2);
        assert.equal(a.allCommand, "zalo-agent sync --from 2026-09-01");
        assert.equal(a.allSinceDate, "2026-09-01");
    });

    it("does not offer a second command when this gap is the oldest", () => {
        const from = Date.UTC(2026, 8, 25, 7, 0, 0);
        const a = describeGap({
            fromTs: from,
            toTs: Date.UTC(2026, 8, 28, 8, 0, 0),
            pendingGaps: [{ fromTs: from }, { fromTs: Date.UTC(2026, 8, 26, 1, 0, 0) }],
        });
        assert.equal(a.olderPending, 0);
        assert.equal(a.allCommand, null, "a duplicate of `command` would be noise");
    });

    it("treats an older gap on the same UTC day as covered, not as a second command", () => {
        const from = Date.UTC(2026, 8, 25, 20, 0, 0);
        const a = describeGap({
            fromTs: from,
            toTs: Date.UTC(2026, 8, 26, 1, 0, 0),
            pendingGaps: [{ fromTs: Date.UTC(2026, 8, 25, 2, 0, 0) }, { fromTs: from }],
        });
        assert.equal(a.allCommand, null, "--from 2026-09-25 already covers both");
    });

    // Observed live 2026-09-28: pending gaps on 09-23, 09-28 08:10 and 09-28
    // 08:39 printed "1 older gap(s) are also pending — … covers all 3". Both
    // numbers were right under their own definition and the sentence was still
    // nonsense, because only the 09-23 gap counts as "older" while all three
    // count toward "all". The report needs one denominator.
    it("counts every other pending gap, including one on this gap's own UTC day", () => {
        const from = Date.UTC(2026, 8, 28, 8, 39, 0);
        const a = describeGap({
            fromTs: from,
            toTs: Date.UTC(2026, 8, 28, 8, 40, 0),
            reason: "startup-gap",
            pendingGaps: [
                { fromTs: Date.UTC(2026, 8, 23, 21, 31, 0) },
                { fromTs: Date.UTC(2026, 8, 28, 8, 10, 0) },
                { fromTs: from },
            ],
        });

        assert.equal(a.pendingCount, 3);
        assert.equal(a.olderPending, 1, "only the 09-23 gap needs an earlier window");
        assert.equal(a.otherPending, 2, "but two other gaps are pending");
        assert.equal(
            a.otherPending + 1,
            a.pendingCount,
            "the report says `N other … covers all M` — those must reconcile",
        );
        assert.equal(a.allCommand, "zalo-agent sync --from 2026-09-23");
    });

    it("survives being called with nothing", () => {
        const a = describeGap();
        assert.equal(a.command, "zalo-agent sync --from 1970-01-01");
        assert.equal(a.pendingCount, 0);
        assert.equal(a.allCommand, null);
    });
});

describe("the advised command actually resolves the gap", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    let manager;
    beforeEach(() => {
        manager = new SyncManager({}, nextAccount());
        manager._ensureDb();
    });

    it("a sync run built from describeGap().sinceDate clears the pending gap", () => {
        const now = Date.now();
        const gapFrom = now - 3 * DAY;
        const id = recordSyncGap(gapFrom, now - 2 * DAY, "startup-gap");

        const advice = describeGap({ fromTs: gapFrom, toTs: now - 2 * DAY, pendingGaps: getPendingSyncGaps() });

        // Exactly what `zalo-agent sync --from <date>` does with that string.
        const win = resolveSyncWindow(undefined, now, advice.sinceDate);
        assert.ok(win.from <= gapFrom, "the advised window must start at or before the gap");

        const { resolvedGaps } = recordRestoreSuccess(win, { resolveGaps: true, now });
        assert.equal(resolvedGaps, 1);
        assert.deepEqual(
            getPendingSyncGaps().map((g) => g.id),
            [],
            `gap #${id} should no longer be pending`,
        );
    });

    it("the wider allCommand clears every pending gap in one run", () => {
        const now = Date.now();
        recordSyncGap(now - 10 * DAY, now - 9 * DAY, "startup-gap");
        recordSyncGap(now - 5 * DAY, now - 4 * DAY, "reconnect-gap");
        const newestFrom = now - 2 * DAY;
        recordSyncGap(newestFrom, now, "startup-gap");

        const advice = describeGap({ fromTs: newestFrom, toTs: now, pendingGaps: getPendingSyncGaps() });
        assert.equal(advice.pendingCount, 3);
        assert.ok(advice.allSinceDate, "an older gap is pending, so a wider command must be offered");

        const win = resolveSyncWindow(undefined, now, advice.allSinceDate);
        const { resolvedGaps } = recordRestoreSuccess(win, { resolveGaps: true, now });
        assert.equal(resolvedGaps, 3);
        assert.deepEqual(getPendingSyncGaps(), []);
    });

    it("the narrow command leaves older gaps pending — which is why allCommand exists", () => {
        const now = Date.now();
        recordSyncGap(now - 10 * DAY, now - 9 * DAY, "startup-gap");
        const newestFrom = now - 2 * DAY;
        recordSyncGap(newestFrom, now, "startup-gap");

        const advice = describeGap({ fromTs: newestFrom, toTs: now, pendingGaps: getPendingSyncGaps() });
        const win = resolveSyncWindow(undefined, now, advice.sinceDate);
        const { resolvedGaps } = recordRestoreSuccess(win, { resolveGaps: true, now });

        assert.equal(resolvedGaps, 1);
        assert.equal(getPendingSyncGaps().length, 1, "the 10-day-old gap is outside this window");
    });

    it("advice built from the STORED row matches a gap recordGap() clamped", () => {
        // recordGap() clamps anything older than MAX_GAP_MS. Advising from the
        // caller's raw `lastConnectedAt` would print a date weeks before the
        // window that was actually filed — still correct, but wider than needed
        // and inconsistent with what `sync-mobile`/the db report.
        const now = Date.now();
        const ancient = now - 60 * DAY;
        const id = manager.recordGap(ancient, now, "startup-gap");
        assert.ok(id, "a 60-day gap is worth recording");

        const pending = getPendingSyncGaps();
        const stored = pending.find((g) => String(g.id) === String(id));
        assert.ok(Number(stored.fromTs) > ancient, "recordGap clamps to MAX_GAP_MS");
        assert.ok(Math.abs(Number(stored.fromTs) - (now - MAX_GAP_MS)) < 5000);

        const advice = describeGap({
            fromTs: Number(stored.fromTs),
            toTs: Number(stored.toTs),
            pendingGaps: pending,
        });
        const win = resolveSyncWindow(undefined, now, advice.sinceDate);
        assert.equal(recordRestoreSuccess(win, { resolveGaps: true, now }).resolvedGaps, 1);
    });
});
