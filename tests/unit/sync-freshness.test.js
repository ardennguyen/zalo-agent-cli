/**
 * src/core/sync.js — the sync-freshness debounce (`checkSyncFreshness`,
 * `markSyncSuccess`, `getLastSuccessfulSyncAt`).
 *
 * Background: a live capture of Zalo Web (2026-09-21) showed that after a
 * successful sync it sets a "sufficient messages / synced recently" marker and
 * a repeat "Đồng bộ tin nhắn" becomes a silent no-op — it never re-opens the
 * transfer session, so it never re-pings the phone. This suite covers the CLI
 * equivalent: a local marker that lets `sync-mobile` skip a redundant run
 * instead of spamming the socket (and, once the transfer-sync path lands, the
 * owner's phone). A pending coverage gap or `--force` always wins.
 *
 * See the local investigation notes under agent/work/transfer-sync-v2/
 * (HANDOFF.md, NOTES.md, FINDINGS.md).
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SyncManager, SYNC_FRESHNESS_MS } from "../../src/core/sync.js";
import { recordSyncGap } from "../../src/core/db.js";

const THREAD_USER = 0;
const THREAD_GROUP = 1;

/** Minimal started-listener stand-in, mirroring the backfill test's fake. */
class FakeListener extends EventEmitter {
    constructor() {
        super();
        this.requested = [];
    }
    requestOldMessages(threadType) {
        this.requested.push(threadType);
    }
    deliver(messages, threadType) {
        this.emit("old_messages", messages, threadType);
    }
}

/** Unique account id per test so each gets a clean zalo.db. */
let seq = 0;
const nextAccount = () => `fresh_${process.pid}_${++seq}`;

describe("SyncManager sync-freshness debounce", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    let manager;

    beforeEach(() => {
        manager = new SyncManager({}, nextAccount());
    });

    it("does not skip when the account has never synced", () => {
        assert.equal(manager.getLastSuccessfulSyncAt(), null);
        const r = manager.checkSyncFreshness();
        assert.equal(r.skip, false);
        assert.equal(r.reason, "never-synced");
        assert.equal(r.lastSyncAt, null);
        assert.equal(r.ageMs, null);
    });

    it("skips a repeat sync inside the freshness window", () => {
        manager.markSyncSuccess("backfill");
        const last = manager.getLastSuccessfulSyncAt();
        assert.ok(last > 0, "markSyncSuccess should stamp lastSyncOkAt");

        const r = manager.checkSyncFreshness({ now: last + 60_000, freshnessMs: SYNC_FRESHNESS_MS });
        assert.equal(r.skip, true);
        assert.equal(r.reason, "fresh");
        assert.equal(r.lastSyncAt, last);
        assert.equal(r.ageMs, 60_000);
    });

    it("does not skip once the last sync is older than the window", () => {
        manager.markSyncSuccess("legacy");
        const last = manager.getLastSuccessfulSyncAt();
        const r = manager.checkSyncFreshness({ now: last + SYNC_FRESHNESS_MS + 1, freshnessMs: SYNC_FRESHNESS_MS });
        assert.equal(r.skip, false);
        assert.equal(r.reason, "stale");
    });

    it("--force bypasses the debounce even when fresh", () => {
        manager.markSyncSuccess("backfill");
        const last = manager.getLastSuccessfulSyncAt();
        const r = manager.checkSyncFreshness({ force: true, now: last + 1000 });
        assert.equal(r.skip, false);
        assert.equal(r.reason, "forced");
    });

    it("a pending coverage gap always forces a sync, even when fresh", () => {
        manager.markSyncSuccess("backfill");
        manager._ensureDb();
        recordSyncGap(Date.now() - 10_000, Date.now(), "test-gap");

        const last = manager.getLastSuccessfulSyncAt();
        const r = manager.checkSyncFreshness({ now: last + 1000 });
        assert.equal(r.skip, false);
        assert.equal(r.reason, "pending-gap");
    });

    it("a narrow --days run does not suppress a later, wider one", () => {
        const DAY = 24 * 60 * 60 * 1000;
        const dayAgo = Date.now() - DAY;
        manager.markSyncSuccess("transfer", { coveredFrom: dayAgo });
        const last = manager.getLastSuccessfulSyncAt();

        const r = manager.checkSyncFreshness({ now: last + 60_000, coversFrom: dayAgo - 30 * DAY });
        assert.equal(r.skip, false, "asking for a month after syncing a day is not a redundant repeat");
        assert.equal(r.reason, "wider-window");
        assert.equal(r.coveredFrom, dayAgo);
    });

    it("still skips a repeat of the same or a narrower window", () => {
        const DAY = 24 * 60 * 60 * 1000;
        const monthAgo = Date.now() - 30 * DAY;
        manager.markSyncSuccess("transfer", { coveredFrom: monthAgo });
        const last = manager.getLastSuccessfulSyncAt();

        assert.equal(manager.checkSyncFreshness({ now: last + 1000, coversFrom: monthAgo }).skip, true, "same window");
        assert.equal(
            manager.checkSyncFreshness({ now: last + 1000, coversFrom: Date.now() - DAY }).skip,
            true,
            "narrower window",
        );
    });

    it("a path that records no window keeps the plain freshness behavior", () => {
        manager.markSyncSuccess("backfill");
        assert.equal(manager.getLastSyncCoveredFrom(), null);
        const last = manager.getLastSuccessfulSyncAt();
        const r = manager.checkSyncFreshness({ now: last + 1000, coversFrom: 0 });
        assert.equal(r.skip, true, "unknown coverage must not turn every run into a wider-window run");
        assert.equal(r.reason, "fresh");
    });

    it("a later window-less success clears a stale coverage marker", () => {
        manager.markSyncSuccess("transfer", { coveredFrom: Date.now() - 24 * 60 * 60 * 1000 });
        assert.ok(manager.getLastSyncCoveredFrom() > 0);
        manager.markSyncSuccess("backfill");
        assert.equal(manager.getLastSyncCoveredFrom(), null, "the marker must describe the LATEST success");
    });

    it("a completed backfill that stored messages arms the debounce", async () => {
        const listener = new FakeListener();
        assert.equal(manager.getLastSuccessfulSyncAt(), null);

        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver(
            [{ threadId: "t1", data: { msgId: "m1", uidFrom: "42", dName: "X", content: "hi", ts: 1700000000000 } }],
            THREAD_USER,
        );
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(res.reason, "complete");
        assert.equal(res.saved, 1);
        assert.ok(
            manager.getLastSuccessfulSyncAt() > 0,
            "a completed backfill that saved rows must stamp lastSyncOkAt",
        );
    });

    it("an EMPTY completed backfill does NOT arm the debounce (won't suppress a real --transfer)", async () => {
        const listener = new FakeListener();
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([], THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(res.reason, "complete");
        assert.equal(res.saved, 0);
        assert.equal(manager.getLastSuccessfulSyncAt(), null, "an empty backfill must not mark us synced");
    });

    it("a timed-out backfill does NOT arm the debounce", async () => {
        const listener = new FakeListener();
        const res = await manager.backfillOverSocket(listener, { timeoutMs: 120 });
        assert.equal(res.reason, "timeout");
        assert.equal(
            manager.getLastSuccessfulSyncAt(),
            null,
            "a partial/timed-out sync must not suppress the next run",
        );
    });
});
