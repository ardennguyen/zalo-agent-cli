/**
 * Standing guard: no offline test may touch the developer's real config.
 *
 * `src/core/credentials.js` computes CONFIG_DIR ONCE, at module-evaluation
 * time, from `os.homedir()`. Anything that transitively imports it therefore
 * binds to the real `~/.zalo-agent-cli/` unless HOME/USERPROFILE were
 * redirected *before* that first import. `tests/helpers/sandbox.js` does the
 * redirect at import time, which is why it has to be the FIRST import in any
 * test that reaches config state — a later import is too late, and fails
 * silently rather than loudly.
 *
 * This existed as a convention in AGENTS.md §12 and tests/README.md and was
 * enforced by nothing. `src/utils/qr-display.test.js` violated it for as long
 * as it existed: no sandbox import, and beforeEach/afterEach that
 * mkdirSync'd and unlinkSync'd `resolve(CONFIG_DIR, "qr.png")` in the real
 * home directory on every `npm test`. The proof was an empty
 * `.zalo-agent-cli` sitting in the developer's home on a machine whose only
 * real session lives somewhere else entirely.
 *
 * So the rule is now a test. It is deliberately static analysis rather than
 * execution: the damage happens at import time, so by the time a runtime
 * check could look, the directory is already created.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** Every *.test.js under src/ and tests/, as repo-relative paths. */
function testFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) testFiles(full, out);
        else if (name.endsWith(".test.js")) out.push(full);
    }
    return out;
}

/** Local (non-package) specifiers a file imports. */
function localImports(src) {
    const out = [];
    // `(?:X)?` is GREEDY, so `[\s\S]*?` would happily run past a
    // side-effect import's own quotes to the next `… from "…"` clause.
    // Restricting the skip to non-quote characters pins each match to one
    // import statement.
    const re = /(?:^|\n)\s*import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) if (m[1].startsWith(".")) out.push(m[1]);
    return out;
}

/**
 * Does `file` reach src/core/credentials.js through local imports?
 * Depth-limited walk; a cycle or a missing file just stops that branch.
 */
function reachesCredentials(file, seen = new Set()) {
    const key = resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    if (key.endsWith(join("src", "core", "credentials.js"))) return true;

    let src;
    try {
        src = readFileSync(key, "utf8");
    } catch {
        return false;
    }
    for (const spec of localImports(src)) {
        const target = resolve(join(key, "..", spec));
        if (reachesCredentials(target, seen)) return true;
    }
    return false;
}

/** The first import specifier in a file, or null. */
function firstImport(src) {
    const m = src.match(/(?:^|\n)\s*import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/);
    return m ? m[1] : null;
}

describe("sandbox discipline", () => {
    const files = testFiles(join(ROOT, "src")).concat(testFiles(join(ROOT, "tests")));

    it("finds the test files to check", () => {
        assert.ok(files.length > 20, `expected to scan the whole suite, found ${files.length}`);
    });

    it("every test that can reach credentials.js redirects HOME first", () => {
        const offenders = [];
        for (const f of files) {
            // The e2e suite deliberately runs against the real (test-home)
            // config — it is gated behind ZALO_TEST_LIVE and drives the CLI
            // as a subprocess with an explicit `home`, never in-process.
            if (relative(ROOT, f).split(/[\\/]/).includes("e2e")) continue;
            // This file itself only reads source text.
            if (resolve(f) === resolve(import.meta.filename)) continue;

            const src = readFileSync(f, "utf8");
            if (!reachesCredentials(f)) continue;

            const first = firstImport(src) ?? "";
            const ok = /(^|\/)helpers\/sandbox\.js$/.test(first) || /sandbox\.js$/.test(first);
            if (!ok) offenders.push(`${relative(ROOT, f)} (first import: ${first || "none"})`);
        }
        assert.deepEqual(
            offenders,
            [],
            "these tests reach credentials.js without importing helpers/sandbox.js FIRST, so they " +
                `operate on the real ~/.zalo-agent-cli/: ${offenders.join(", ")}`,
        );
    });
});
