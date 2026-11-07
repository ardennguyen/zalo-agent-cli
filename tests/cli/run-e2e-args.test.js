import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "../run-e2e.js");

// The runner reads tests/targets.json by a fixed path, and with real targets
// a regression here would start a live run from `npm test`. So the copy under
// test sits beside a stub that reports no targets: the worst a broken
// argument check can do is fail on targets, which the assertions catch.
let dir;
let runner;
before(() => {
    dir = mkdtempSync(join(tmpdir(), "run-e2e-args-"));
    mkdirSync(join(dir, "helpers"));
    writeFileSync(
        join(dir, "helpers", "targets.js"),
        'export function loadTargets() { return { configured: false, reason: "stub" }; }\n',
    );
    runner = join(dir, "run-e2e.js");
    copyFileSync(RUNNER, runner);
});
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run the stubbed copy of the live runner.
 *
 * @param {string[]} args - command-line arguments
 * @returns {import("node:child_process").SpawnSyncReturns<string>} the finished process
 */
function run(args) {
    return spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 30_000 });
}

describe("run-e2e argument check", () => {
    it("the stub stops a valid command at targets, so a pass below is the argument check", () => {
        const r = run(["--tier", "1"]);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /Cannot run live E2E: stub/);
    });

    it("--help prints usage and runs no tier", () => {
        const r = run(["--help"]);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /^Usage: node tests\/run-e2e\.js/);
        assert.doesNotMatch(r.stderr, /Cannot run live E2E/);
    });

    it("an unknown flag is refused, not ignored into the tiers 1–4 default", () => {
        const r = run(["--test-name-pattern=upload"]);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /Unknown argument: --test-name-pattern=upload/);
        assert.doesNotMatch(r.stderr, /Cannot run live E2E/);
    });

    it("--tier or --through without a tier number is refused", () => {
        for (const args of [["--tier"], ["--tier", "9"], ["--through", "--keep-going"]]) {
            const r = run(args);
            assert.equal(r.status, 2, args.join(" "));
            assert.match(r.stderr, /needs a tier number 1–5/);
        }
    });
});
