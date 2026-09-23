/**
 * `recordRestoreSuccess` — the bookkeeping that lets a sync NOT re-ping the phone.
 *
 * The freshness debounce was effectively off. checkSyncFreshness never skips
 * while any gap is pending, nothing resolved gaps, and a confirmed empty
 * window -- the usual answer over any window a listener was connected for --
 * returned before the success markers were written. A measured test cache
 * held 12 pending gaps and 0 resolved, so every run woke the phone.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, recordSyncGap, getPendingSyncGaps, getSyncState } from "../../src/core/db.js";
import { recordRestoreSuccess } from "../../src/core/sync-v2/index.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-restore-ok-"));
const opened = [];
let n = 0;
const DAY = 86_400_000;
const NOW = 1_750_000_000_000;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
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

describe("recordRestoreSuccess", () => {
    it("records success and how far back the run reached", () => {
        recordRestoreSuccess({ from: NOW - 7 * DAY }, { now: NOW });
        assert.equal(Number(getSyncState("lastSyncOkAt")), NOW);
        assert.equal(getSyncState("lastSyncOkKind"), "transfer");
        assert.equal(Number(getSyncState("lastSyncOkFrom")), NOW - 7 * DAY);
    });

    it("resolves the gaps the window covered", () => {
        recordSyncGap(NOW - 2 * DAY, NOW - 2 * DAY + 60_000, "reconnect-gap");
        recordSyncGap(NOW - DAY, NOW - DAY + 60_000, "startup-gap");
        const { resolvedGaps } = recordRestoreSuccess({ from: NOW - 7 * DAY }, { now: NOW, resolveGaps: true });
        assert.equal(resolvedGaps, 2);
        assert.equal(getPendingSyncGaps().length, 0);
    });

    it("leaves a gap older than the window alone -- a --days 1 run says nothing about last week", () => {
        recordSyncGap(NOW - 10 * DAY, NOW - 10 * DAY + 60_000, "reconnect-gap");
        recordSyncGap(NOW - 3_600_000, NOW - 3_000_000, "reconnect-gap");
        const { resolvedGaps } = recordRestoreSuccess({ from: NOW - DAY }, { now: NOW, resolveGaps: true });
        assert.equal(resolvedGaps, 1);
        assert.equal(getPendingSyncGaps().length, 1);
    });

    it("resolves nothing when asked not to, as for a partial run", () => {
        recordSyncGap(NOW - DAY, NOW - DAY + 60_000, "reconnect-gap");
        recordRestoreSuccess({ from: 0 }, { now: NOW, resolveGaps: false });
        assert.equal(getPendingSyncGaps().length, 1);
    });
});
