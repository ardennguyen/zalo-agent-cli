/**
 * patches/zca-js+2.2.0.patch is well-formed.
 *
 * `prepare` runs patch-package on it, and the patched zca-js is bundled into the
 * tarball. The file is edited by hand whenever an API is dropped, and one
 * hunk header left disagreeing with its body (a blank context line lost, the
 * header still saying -6 +7) is enough for patch-package to reject the WHOLE
 * file: `npm ci` then fails at `prepare` on every fresh install, CI and the
 * publish workflow included. 1558119 shipped exactly that. Nothing else
 * caught it, because every other test reads the already-patched zca-js on a
 * developer's disk, where the old patch had long since been applied.
 *
 * This checks the file itself, offline: each hunk's declared line counts
 * against what its body holds, and that no blank context line was stripped to
 * an empty line (a blank context line is a single space).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH = join(import.meta.dirname, "..", "..", "patches", "zca-js+2.2.0.patch");

/**
 * What is wrong with a unified diff's hunks, as readable strings.
 *
 * @param {string} text
 * @returns {string[]} empty when every hunk is consistent
 */
function hunkProblems(text) {
    const lines = text.split("\n");
    // The text ends with a newline, so the last element is not a line.
    if (lines[lines.length - 1] === "") lines.pop();
    const problems = [];
    let file = "?";
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("diff --git ")) file = lines[i].replace(/^diff --git a\//, "").replace(/ b\/.*/, "");
        const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) continue;
        const declaredOld = m[2] === undefined ? 1 : Number(m[2]);
        const declaredNew = m[4] === undefined ? 1 : Number(m[4]);
        let oldN = 0;
        let newN = 0;
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j];
            if (l.startsWith("@@") || l.startsWith("diff --git ")) break;
            if (l.startsWith("\\")) continue; // "\ No newline at end of file"
            if (l === "" || l === "\r") {
                problems.push(`${file}: line ${j + 1} is empty inside a hunk (a blank context line is one space)`);
                continue;
            }
            if (l[0] === "+") newN++;
            else if (l[0] === "-") oldN++;
            else {
                oldN++;
                newN++;
            }
        }
        if (oldN !== declaredOld || newN !== declaredNew) {
            problems.push(
                `${file}: hunk at line ${i + 1} declares -${declaredOld} +${declaredNew} but holds -${oldN} +${newN}`,
            );
        }
    }
    return problems;
}

/** @param {string} text */
const patchedFiles = (text) => [...text.matchAll(/^diff --git a\/node_modules\/zca-js\/(\S+) b\//gm)].map((m) => m[1]);

describe("patches/zca-js+2.2.0.patch", () => {
    const text = readFileSync(PATCH, "utf8");

    it("every hunk's header agrees with its body, so patch-package can parse it", () => {
        // Red if a hand edit leaves a header, or a stripped blank context line, behind.
        assert.deepEqual(hunkProblems(text), []);
    });

    it("patches the ESM and CJS builds alike", () => {
        const files = patchedFiles(text);
        assert.ok(files.length > 0, "no patched files found: the file's diff headers changed shape");
        for (const f of files.filter((x) => x.startsWith("dist/") && !x.startsWith("dist/cjs/") && x.endsWith(".js"))) {
            const twin = f.replace(/^dist\//, "dist/cjs/").replace(/\.js$/, ".cjs");
            assert.ok(files.includes(twin), `${f} is patched but its CJS twin ${twin} is not`);
        }
    });

    it("no longer adds the retired legacy-sync APIs", () => {
        const files = patchedFiles(text).join("\n");
        for (const gone of ["pullMobileMsg", "getCrossDB", "deleteSnapshotMobileMsg", "requestSyncMessage"]) {
            assert.ok(!files.includes(gone), `${gone} must not come back through the patch`);
        }
        assert.ok(files.includes("dist/apis/logoutV2.js"), "logoutV2 is the one API the patch still adds");
    });
});

describe("the hunk checker itself", () => {
    const head = "diff --git a/node_modules/zca-js/x.js b/node_modules/zca-js/x.js\n--- a/x\n+++ b/x\n";

    it("accepts a consistent hunk", () => {
        assert.deepEqual(hunkProblems(`${head}@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n`), []);
    });

    it("names a hunk whose header counts disagree with its body", () => {
        const problems = hunkProblems(`${head}@@ -1,4 +1,5 @@\n a\n+b\n c\n d\n`);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /declares -4 \+5 but holds -3 \+4/);
    });

    it("names a blank context line stripped down to an empty line", () => {
        const problems = hunkProblems(`${head}@@ -1,3 +1,4 @@\n a\n+b\n c\n\n`);
        assert.ok(
            problems.some((p) => /empty inside a hunk/.test(p)),
            problems.join("\n"),
        );
    });
});
