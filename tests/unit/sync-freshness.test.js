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

    it("a completed socket backfill arms the debounce", async () => {
        const listener = new FakeListener();
        assert.equal(manager.getLastSuccessfulSyncAt(), null);

        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([], THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(res.reason, "complete");
        assert.ok(manager.getLastSuccessfulSyncAt() > 0, "a completed backfill must stamp lastSyncOkAt");
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
