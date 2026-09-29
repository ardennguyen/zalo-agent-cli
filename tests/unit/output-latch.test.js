/**
 * `src/utils/output.js` — the once-only JSON error latch.
 *
 * In `--json` mode the FIRST error() is the machine-readable payload on
 * stdout; every later one goes to stderr, so a command that fails twice
 * still emits exactly one parseable JSON value and `| jq` keeps working.
 *
 * That branch was uncovered. Every `--json` contract test drives the binary
 * as a subprocess, and a subprocess exits after one error, so the second-
 * error path never ran. output.js even exports `_resetErrorLatch` labelled
 * "Test seam" — and a repo-wide grep found exactly one hit: the definition.
 * The seam existed for a test that was never written.
 *
 * In-process is the only place this is reachable, hence this file.
 */

import "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { error, success, info, warning, _resetErrorLatch } from "../../src/utils/output.js";

describe("output.js — the once-only JSON error latch", () => {
    let outLines;
    let errLines;
    let realLog;
    let realErr;

    beforeEach(() => {
        _resetErrorLatch();
        outLines = [];
        errLines = [];
        realLog = console.log;
        realErr = console.error;
        console.log = (...a) => outLines.push(a.join(" "));
        console.error = (...a) => errLines.push(a.join(" "));
        process.env.ZALO_JSON_MODE = "1";
    });

    afterEach(() => {
        console.log = realLog;
        console.error = realErr;
        delete process.env.ZALO_JSON_MODE;
        _resetErrorLatch();
    });

    it("emits the first error as JSON on stdout", () => {
        error("first thing went wrong");
        assert.equal(outLines.length, 1);
        assert.deepEqual(JSON.parse(outLines[0]), { error: "first thing went wrong" });
        assert.equal(errLines.length, 0);
    });

    it("sends every LATER error to stderr, so stdout stays one JSON value", () => {
        error("first");
        error("second");
        error("third");

        assert.equal(outLines.length, 1, "stdout must carry exactly one value");
        assert.doesNotThrow(() => JSON.parse(outLines[0]), "stdout must stay parseable");
        assert.deepEqual(JSON.parse(outLines[0]), { error: "first" });

        assert.equal(errLines.length, 2);
        assert.match(errLines[0], /✗ second/);
        assert.match(errLines[1], /✗ third/);
    });

    it("_resetErrorLatch re-arms it — without that, order between test files would leak", () => {
        error("one");
        assert.equal(outLines.length, 1);
        _resetErrorLatch();
        error("two");
        assert.equal(outLines.length, 2, "after a reset the next error is a payload again");
        assert.deepEqual(JSON.parse(outLines[1]), { error: "two" });
    });

    it("keeps success/info/warning off stdout in machine mode", () => {
        success("done");
        info("context");
        warning("careful");
        assert.deepEqual(outLines, [], "nothing but the JSON payload may reach stdout");
        assert.equal(errLines.length, 3);
    });

    it("human mode is unaffected — every error prints, none is JSON", () => {
        delete process.env.ZALO_JSON_MODE;
        _resetErrorLatch();
        error("alpha");
        error("beta");
        assert.equal(outLines.length, 2);
        for (const line of outLines) assert.throws(() => JSON.parse(line));
    });
});
