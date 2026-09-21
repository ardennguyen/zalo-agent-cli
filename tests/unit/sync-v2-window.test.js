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
 * `FULL_HISTORY_FROM` bound, and junk degrades to the default rather than to
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

    it("full history means the beginning of time, not a hardcoded year", () => {
        // This was pinned at 2024-01-01, which silently made "full history"
        // skip everything older — an account with 2018 messages never had them
        // requested, and nothing in the output said so.
        assert.equal(FULL_HISTORY_FROM, 0);
        assert.match(resolveSyncWindow(null, NOW).label, /full history/i);
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

    it("a window reaching past the beginning is just full history", () => {
        // 9999 days used to clamp against the 2024 floor; with the bound at the
        // epoch it lands in 1999, which is a perfectly valid request. Only a
        // window older than the epoch itself clamps now.
        const past = Math.ceil(NOW / DAY) + 1;
        const w = resolveSyncWindow(past, NOW);
        assert.equal(w.from, FULL_HISTORY_FROM, "never ask for more than the default already asks for");
        assert.equal(w.clamped, true);
        assert.equal(w.days, past, "the requested value is kept for reporting");
        assert.match(w.label, /full history/);
    });

    it("a multi-year --days is honoured rather than silently truncated", () => {
        // The old floor turned any window older than 2024 into 2024. An account
        // with 2018 history needs --days 3000 to actually mean 2018.
        const w = resolveSyncWindow(3000, NOW);
        assert.equal(w.clamped, false);
        assert.ok(w.from < Date.parse("2024-01-01T00:00:00.000Z"), "must reach past the old floor");
    });

    it("clamping kicks in exactly at the bound, not before it", () => {
        const daysToBound = Math.floor((NOW - FULL_HISTORY_FROM) / DAY);
        assert.equal(resolveSyncWindow(daysToBound, NOW).clamped, false);
        assert.equal(resolveSyncWindow(daysToBound + 1, NOW).clamped, true);
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

describe("resolveSyncWindow — explicit --from", () => {
    const NOW2 = Date.parse("2026-09-21T12:00:00.000Z");

    it("accepts a date far older than the old 2024 floor", () => {
        // The whole point: an account with 2018 history must be able to ask for it.
        const w = resolveSyncWindow(null, NOW2, "2018-01-01");
        assert.equal(w.from, Date.parse("2018-01-01T00:00:00.000Z"));
        assert.equal(w.clamped, false);
        assert.match(w.label, /2018-01-01/);
    });

    it("overrides --days, being the more specific request", () => {
        const w = resolveSyncWindow(7, NOW2, "2019-06-01");
        assert.equal(w.from, Date.parse("2019-06-01T00:00:00.000Z"));
        assert.equal(w.days, null);
    });

    it("accepts epoch milliseconds too", () => {
        const ts = Date.parse("2020-03-04T00:00:00.000Z");
        assert.equal(resolveSyncWindow(null, NOW2, ts).from, ts);
    });

    it("falls back to full history on junk rather than to a silent narrow window", () => {
        for (const bad of ["not-a-date", "", "1999-13-45", NaN]) {
            const w = resolveSyncWindow(null, NOW2, bad);
            assert.equal(w.from, FULL_HISTORY_FROM, `${JSON.stringify(bad)} must not narrow the run`);
        }
    });

    it("rejects a future date and a pre-Zalo date", () => {
        assert.equal(resolveSyncWindow(null, NOW2, "2099-01-01").from, FULL_HISTORY_FROM);
        assert.equal(resolveSyncWindow(null, NOW2, "1990-01-01").from, FULL_HISTORY_FROM);
    });
});

describe("the `to` bound on a message partition", () => {
    // Zalo Web sends each partition its own conversation's lastTs — a captured
    // run shows 30 distinct `to` values across 30 partitions — and reserves an
    // unbounded `to` for the conversation round, where the latest message is
    // not yet known. MAX_SAFE_INTEGER per partition asks the phone to scan to
    // the year 285428 for a conversation quiet since 2024.
    const NOW3 = Date.parse("2026-09-21T12:00:00.000Z");

    /** Mirrors the bound the restore computes per conversation. */
    const partitionTo = (lastTs, winTo, now = NOW3) => {
        const askedTo = Math.min(winTo, now);
        const t = Number(lastTs) || 0;
        return t > 0 ? Math.min(t, askedTo) : askedTo;
    };

    it("uses the conversation's own lastTs", () => {
        const lastTs = Date.parse("2025-03-04T00:00:00.000Z");
        assert.equal(partitionTo(lastTs, resolveSyncWindow(null, NOW3).to), lastTs);
    });

    it("never asks beyond now, even on the default unbounded window", () => {
        const to = partitionTo(0, resolveSyncWindow(null, NOW3).to);
        assert.equal(to, NOW3);
        assert.notEqual(to, Number.MAX_SAFE_INTEGER, "MAX_SAFE_INTEGER is not a real timestamp");
    });

    it("never asks beyond now even if a conversation claims a future lastTs", () => {
        const future = NOW3 + 365 * 24 * 3600 * 1000;
        assert.equal(partitionTo(future, resolveSyncWindow(null, NOW3).to), NOW3);
    });

    it("falls back to now when lastTs is missing or junk", () => {
        for (const bad of [0, null, undefined, NaN, "x"]) {
            assert.equal(partitionTo(bad, resolveSyncWindow(null, NOW3).to), NOW3, `lastTs=${String(bad)}`);
        }
    });

    it("distinct conversations get distinct bounds", () => {
        const winTo = resolveSyncWindow(null, NOW3).to;
        const a = partitionTo(Date.parse("2024-05-01T00:00:00.000Z"), winTo);
        const b = partitionTo(Date.parse("2026-01-01T00:00:00.000Z"), winTo);
        assert.notEqual(a, b, "a per-conversation bound must actually vary");
    });
});

/**
 * Message ids coming out of the sync.
 *
 * jspb renders an absent uint64 as the STRING "0", which is truthy, so
 * `globalId || clientId` kept it — and every message without a global id was
 * stored under the literal primary key "0", where insertMessage's upsert made
 * them overwrite one another. One such row was found in a real 14-day restore.
 */
describe("syncMsgId", () => {
    // Re-derived here rather than exported: this pins the RULE, which is the
    // same zero-is-absent rule a removal's globalDelMsgId and a reaction's
    // gMsgID follow.
    const syncMsgId = (msg) => {
        const gid = msg?.globalId;
        if (gid !== undefined && gid !== null && String(gid) !== "0" && String(gid) !== "") return String(gid);
        return String(msg?.clientId ?? "");
    };

    it("prefers the global id when there is one", () => {
        assert.equal(syncMsgId({ globalId: "8289917911178", clientId: 1790013246350 }), "8289917911178");
    });

    it('treats the string "0" as absent, not as an id', () => {
        assert.equal(syncMsgId({ globalId: "0", clientId: 1788835582539 }), "1788835582539");
    });

    it("treats numeric 0 as absent too", () => {
        assert.equal(syncMsgId({ globalId: 0, clientId: 1788835582539 }), "1788835582539");
    });

    it("falls back for an empty or missing global id", () => {
        assert.equal(syncMsgId({ globalId: "", clientId: 7 }), "7");
        assert.equal(syncMsgId({ clientId: 7 }), "7");
    });

    it("does not invent an id when neither is present", () => {
        assert.equal(syncMsgId({}), "");
    });
});
