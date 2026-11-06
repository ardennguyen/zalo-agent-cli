/**
 * History by date range (bug-reports #5): a conversation's cached messages between two times, oldest first, in pages
 * that never split or repeat a millisecond, so reaching one day no longer means paging back 200 at a time.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getAllMessagesInRange, getMessagesInRange, initDb, insertMessage } from "../../src/core/db.js";

describe("cached history in a time window", () => {
    const ROOT = mkdtempSync(join(tmpdir(), "zalo-history-range-"));
    const handles = [];
    let n = 0;

    before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
    beforeEach(() => handles.push(initDb(join(ROOT, `db${n++}.sqlite`))));
    after(() => {
        for (const h of handles) {
            try {
                h.close();
            } catch {
                /* already closed */
            }
        }
        try {
            rmSync(ROOT, { recursive: true, force: true });
        } catch {
            /* a lingering WAL handle is not worth failing the run over */
        }
    });

    /** Cache messages at these timestamps in thread t1 (ids m<ts>, or m<ts>b for a second one at the same ms). */
    const cache = (stamps, threadId = "t1") => {
        const seen = new Map();
        for (const ts of stamps) {
            const k = (seen.get(ts) ?? 0) + 1;
            seen.set(ts, k);
            insertMessage({
                msgId: `m${ts}${k > 1 ? String.fromCharCode(96 + k) : ""}`,
                threadId,
                senderId: "u2",
                senderName: "Chi Lan",
                text: `at ${ts}`,
                timestamp: ts,
                type: "text",
                raw_data: "x",
            });
        }
    };
    const ids = (rows) => rows.map((r) => r.msgId);

    it("returns the window's messages oldest first, both bounds included, and only this thread's", () => {
        cache([100, 200, 300, 400, 500]);
        cache([250], "t2");
        const { rows, nextSince } = getMessagesInRange("t1", { since: 200, until: 400 });
        assert.deepEqual(ids(rows), ["m200", "m300", "m400"]);
        assert.equal(nextSince, null, "nothing left");
    });

    it("leaves a bound open when it is not given", () => {
        cache([100, 200, 300]);
        assert.deepEqual(ids(getMessagesInRange("t1", { since: 200 }).rows), ["m200", "m300"]);
        assert.deepEqual(ids(getMessagesInRange("t1", { until: 200 }).rows), ["m100", "m200"]);
        assert.deepEqual(ids(getMessagesInRange("t1").rows), ["m100", "m200", "m300"]);
    });

    it("pages with nextSince, never splitting messages that share a millisecond", () => {
        cache([100, 200, 300, 300, 400]);
        const first = getMessagesInRange("t1", { limit: 3 });
        // the third row and the fourth share 300: the page stops before them
        assert.deepEqual(ids(first.rows), ["m100", "m200"]);
        assert.equal(first.nextSince, 201);
        const second = getMessagesInRange("t1", { since: first.nextSince, limit: 3 });
        assert.deepEqual(ids(second.rows), ["m300", "m300b", "m400"]);
        assert.equal(second.nextSince, null);
    });

    it("takes a whole run of one millisecond when it fills the page", () => {
        cache([300, 300, 300, 400]);
        const page = getMessagesInRange("t1", { limit: 2 });
        assert.deepEqual(ids(page.rows), ["m300", "m300b", "m300c"]);
        assert.equal(page.nextSince, 301);
    });

    it("reads every message of the window across pages, with nothing skipped or repeated", () => {
        const stamps = [];
        for (let i = 0; i < 2500; i++) stamps.push(1_000 + Math.floor(i / 3)); // runs of three per millisecond
        cache(stamps);
        const all = getAllMessagesInRange("t1");
        assert.equal(all.rows.length, 2500);
        assert.equal(new Set(ids(all.rows)).size, 2500);
        assert.equal(all.hasMore, false);
        const ordered = all.rows.every((r, i) => i === 0 || r.timestamp >= all.rows[i - 1].timestamp);
        assert.ok(ordered, "oldest first");
    });

    it("stops at a cap and says more are left", () => {
        cache([100, 200, 300, 400]);
        const capped = getAllMessagesInRange("t1", { cap: 2 });
        assert.deepEqual(ids(capped.rows), ["m100", "m200"]);
        assert.equal(capped.hasMore, true);
        const exact = getAllMessagesInRange("t1", { since: 300, cap: 2 });
        assert.deepEqual(ids(exact.rows), ["m300", "m400"]);
        assert.equal(exact.hasMore, false, "a cap the window fits in leaves nothing out");
    });
});
