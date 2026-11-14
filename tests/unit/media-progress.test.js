/**
 * The progress lines of a media run (`mediaProgressPrinter` in src/commands/sync.js): they count files finished,
 * saved or failed, so a stretch of links that are all gone still shows the run moving.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { mediaProgressPrinter } from "../../src/commands/sync.js";

assertSandboxed(CONFIG_DIR);

/** An `attempted` event as the downloader sends it. */
const at = (attempted, total, downloaded = 0, failed = attempted - downloaded, bytes = 0) => ({
    phase: "attempted",
    attempted,
    total,
    downloaded,
    failed,
    bytes,
});

describe("mediaProgressPrinter", () => {
    it("prints a line per N files finished even when none was saved", () => {
        const lines = [];
        const p = mediaProgressPrinter({ every: 50, everyMs: 1e9, now: () => 0, print: (l) => lines.push(l) });
        for (let i = 1; i <= 120; i++) p(at(i, 1000));
        // Red if lines come only from saved files, which is what made a run of dead links look frozen.
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^ {2}50\/1000 files — 0 saved, 50 failed/);
        assert.match(lines[1], /^ {2}100\/1000 files — 0 saved, 100 failed/);
    });

    it("prints after a quiet stretch even below N, and always the last file", () => {
        const lines = [];
        let t = 0;
        const p = mediaProgressPrinter({ every: 50, everyMs: 30000, now: () => t, print: (l) => lines.push(l) });
        p(at(1, 3, 1, 0, 2048));
        t = 31000;
        p(at(2, 3, 1, 1, 2048));
        t = 31001;
        p(at(3, 3, 2, 1, 4096));
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^ {2}2\/3 files — 1 saved, 1 failed \(2(\.0)? KB\)/);
        assert.match(lines[1], /^ {2}3\/3 files — 2 saved, 1 failed/);
    });

    it("names the links skipped as known dead, and only when there are some", () => {
        const lines = [];
        const p = mediaProgressPrinter({ every: 1, print: (l) => lines.push(l) });
        p(at(1, 2, 0, 1));
        p({ ...at(2, 2, 0, 1), dead: 1 });
        assert.doesNotMatch(lines[0], /known dead/);
        assert.match(lines[1], /^ {2}2\/2 files — 0 saved, 1 failed, 1 known dead/);
    });

    it("ignores every other event", () => {
        const lines = [];
        const p = mediaProgressPrinter({ every: 1, print: (l) => lines.push(l) });
        p({ phase: "saved", done: 1, total: 1 });
        p({ phase: "fail" });
        p({ phase: "throttled" });
        assert.equal(lines.length, 0);
    });
});
