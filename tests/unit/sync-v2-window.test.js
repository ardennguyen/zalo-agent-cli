/**
 * src/core/sync-v2 — `resolveSyncWindow`, the logic behind
 * `sync-mobile --transfer --days <n>`.
 *
 * It produces the `from`/`to` bounds carried by every cmd 590 query. Both the
 * conversation round and the message rounds use the same bounds, which is what
 * makes a narrow sync actually cheap: a shorter window returns fewer
 * conversations, which means fewer <=30-partition shards and a shorter run —
 * not just fewer messages per conversation.
 *
 * A pure function, so the whole contract is pinned here without a session: the
 * default is full history, an explicit window is never wider than the
 * `FULL_HISTORY_FROM` floor, and junk degrades to the default rather than to
 * NaN bounds (a NaN `from` would be sent to the phone verbatim).
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { resolveSyncWindow, FULL_HISTORY_FROM } from "../../src/core/sync-v2/index.js";

const DAY = 24 * 60 * 60 * 1000;
/** Fixed clock so the date strings in labels are deterministic. */
const NOW = Date.parse("2026-09-21T12:00:00.000Z");

describe("sync-v2 resolveSyncWindow", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    it("defaults to full history when no window is given", () => {
        const w = resolveSyncWindow(undefined, NOW);
        assert.equal(w.days, null);
        assert.equal(w.from, FULL_HISTORY_FROM);
        assert.equal(w.clamped, false);
        assert.match(w.label, /full history/);
    });

    it("treats the full-history floor as 2024-01-01, and says so in the label", () => {
        assert.equal(FULL_HISTORY_FROM, Date.parse("2024-01-01T00:00:00.000Z"));
        assert.match(resolveSyncWindow(null, NOW).label, /2024-01-01/);
    });

    it("narrows `from` to the last N days", () => {
        const w = resolveSyncWindow(7, NOW);
        assert.equal(w.days, 7);
        assert.equal(w.from, NOW - 7 * DAY);
        assert.equal(w.clamped, false);
        assert.match(w.label, /last 7 days \(since 2026-09-14\)/);
    });

    it("keeps `to` open-ended so nothing recent is cut off", () => {
        for (const days of [undefined, 1, 30, 9999]) {
            const w = resolveSyncWindow(days, NOW);
            assert.equal(w.to, Number.MAX_SAFE_INTEGER);
            assert.ok(w.from < w.to);
        }
    });

    it("clamps a window that reaches past the floor instead of widening the request", () => {
        const w = resolveSyncWindow(9999, NOW);
        assert.equal(w.from, FULL_HISTORY_FROM, "never ask for more than the default already asks for");
        assert.equal(w.clamped, true);
        assert.equal(w.days, 9999, "the requested value is kept for reporting");
        assert.match(w.label, /full history/);
    });

    it("clamping kicks in exactly at the floor, not before it", () => {
        const daysToFloor = Math.floor((NOW - FULL_HISTORY_FROM) / DAY);
        assert.equal(resolveSyncWindow(daysToFloor, NOW).clamped, false);
        assert.equal(resolveSyncWindow(daysToFloor + 1, NOW).clamped, true);
    });

    it("falls back to full history for zero, negative and non-numeric input", () => {
        for (const bad of [0, -1, -365, NaN, "", "week", {}, []]) {
            const w = resolveSyncWindow(bad, NOW);
            assert.equal(w.from, FULL_HISTORY_FROM, `${JSON.stringify(bad)} should mean full history`);
            assert.equal(w.days, null);
            assert.ok(Number.isFinite(w.from), "a NaN bound would be sent to the phone verbatim");
        }
    });

    it("says 'day' for a one-day window and 'days' otherwise", () => {
        assert.match(resolveSyncWindow(1, NOW).label, /last 1 day \(/);
        assert.match(resolveSyncWindow(2, NOW).label, /last 2 days \(/);
    });

    it("moves with the clock — the window is relative, not a fixed date", () => {
        const a = resolveSyncWindow(30, NOW);
        const b = resolveSyncWindow(30, NOW + 5 * DAY);
        assert.equal(b.from - a.from, 5 * DAY);
    });
});
