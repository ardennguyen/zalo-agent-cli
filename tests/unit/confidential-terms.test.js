/**
 * No tracked file holds a confidential term.
 *
 * The terms (company and product names the project must never publish, and personal names) live in a gitignored file,
 * because this repository is public and the list cannot sit in it: `.agents/confidential-terms.txt`, the same list
 * `.agents/check-wiki-leaks.sh` reads before every wiki push. That script only covers the wiki; a term sat in four test
 * lines for ten days because nothing looked at the repository tree. This test does, whenever the list is there.
 *
 * Without the list the test skips and says so (CI does not have it, a developer's checkout does): it can never pass by
 * having looked at nothing without telling. `ZALO_CONFIDENTIAL_TERMS=<path>` points it at a list kept elsewhere, such as
 * the main checkout's when this is a worktree.
 *
 * A term matches as a whole word, in any case: a short name must not trip over the ordinary words that contain it.
 * A failure names the file and the number of the term in the list, never the term, so the report cannot become a leak.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIST = process.env.ZALO_CONFIDENTIAL_TERMS || join(ROOT, ".agents", "confidential-terms.txt");
const BINARY = /\.(pdf|png|jpe?g|gif|zip|ico|woff2?|wasm|gz)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The terms of a list file: one per line, `#` lines and blank lines ignored. */
export function readTerms(text) {
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}

/** A matcher for one term: the whole word, in any case, Unicode-aware. */
export function wordMatcher(term) {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}($|[^\\p{L}\\p{N}])`, "iu");
}

describe("the matcher", () => {
    it("takes a term as a whole word in any case, and not inside a longer word", () => {
        const m = wordMatcher("acme");
        assert.ok(m.test("a group named ACME Team"));
        assert.ok(m.test('watch: ["group:Acme*"]'));
        assert.ok(m.test("acme"));
        assert.ok(!m.test("an acmeish word"));
        assert.ok(!m.test("unacme"));
    });

    it("reads a list with comments and blank lines", () => {
        assert.deepEqual(readTerms("# a comment\n\nfoo\n  bar  \n#baz\n"), ["foo", "bar"]);
    });

    it("escapes what a term may contain", () => {
        assert.ok(wordMatcher("a.b").test("see a.b here"));
        assert.ok(!wordMatcher("a.b").test("see axb here"));
    });
});

describe("tracked files", () => {
    const have = existsSync(LIST);
    it(
        "hold none of the confidential terms",
        { skip: have ? false : `no terms list at ${LIST} (set ZALO_CONFIDENTIAL_TERMS to run this check)` },
        () => {
            const terms = readTerms(readFileSync(LIST, "utf8"));
            assert.ok(terms.length > 0, "the terms list is empty");
            const files = execFileSync("git", ["ls-files", "-z"], {
                cwd: ROOT,
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            })
                .split("\0")
                .filter((f) => f && !BINARY.test(f));
            const hits = [];
            const matchers = terms.map(wordMatcher);
            for (const f of files) {
                let text;
                try {
                    text = readFileSync(join(ROOT, f), "utf8");
                } catch {
                    continue; // a path git lists and the disk does not have: nothing to read
                }
                matchers.forEach((m, i) => {
                    if (m.test(text)) hits.push(`${f} (term #${i + 1} of the list)`);
                });
            }
            assert.deepEqual(hits, [], `a confidential term is in a tracked file:\n  ${hits.join("\n  ")}`);
        },
    );
});
