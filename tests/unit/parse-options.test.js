/**
 * `src/utils/parse-options.js` — the Commander coercion helpers.
 *
 * This module exists to stop one specific, silent bug: Commander calls a
 * coercion as `fn(value, previousValue)` where `previousValue` is the
 * option's *default*, so the idiomatic-looking
 * `.option("-c, --count <n>", "…", parseInt, 100)` resolves to
 * `parseInt("100", 100)` — a radix, not a default. Some values come back
 * `NaN` (and reach Zalo as "Tham số không hợp lệ", which reads like a
 * server-side rejection), and some come back *plausibly wrong*:
 * `parseInt("20", 20)` is 40, so `catalog list -l 20` silently pages by 40.
 *
 * Nine command files import `parseIntOption`, and until this suite existed
 * none of them had a regression test for the trap they were fixed to avoid.
 * These tests pin the contract down at the unit level, where the radix bug
 * is visible, rather than waiting for a live paging assertion to catch it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntOption, parseIntAtLeast } from "../../src/utils/parse-options.js";

describe("parseIntOption", () => {
    it("parses a plain base-10 integer", () => {
        assert.equal(parseIntOption("100"), 100);
        assert.equal(parseIntOption("1"), 1);
        assert.equal(parseIntOption("0"), 0);
    });

    it("ignores Commander's second argument, so a default can never become a radix", () => {
        // This is the entire reason the module exists. parseInt("20", 20) is 40.
        assert.equal(parseIntOption("20", 20), 20);
        assert.equal(parseIntOption("100", 100), 100);
        assert.equal(parseIntOption("50", 50), 50);
    });

    it("never returns NaN — it throws instead", () => {
        for (const bad of ["", "abc", "1abc", "--", "NaN", "Infinity", "1e3", "0x10"]) {
            assert.throws(() => parseIntOption(bad), /Expected a whole number/, `"${bad}" should throw`);
        }
    });

    it("rejects a float rather than silently truncating it", () => {
        assert.throws(() => parseIntOption("1.5"), /Expected a whole number/);
        assert.throws(() => parseIntOption("2.0"), /Expected a whole number/);
    });

    it("tolerates surrounding whitespace", () => {
        assert.equal(parseIntOption("  42  "), 42);
    });

    it("accepts a negative integer (range is a separate concern)", () => {
        assert.equal(parseIntOption("-5"), -5);
    });

    it("names the offending value in the error, so the user can see the typo", () => {
        assert.throws(() => parseIntOption("twenty"), /twenty/);
    });
});

describe("parseIntAtLeast", () => {
    it("returns a coercion function, Commander-style", () => {
        assert.equal(typeof parseIntAtLeast(1), "function");
    });

    it("accepts a value at or above the floor", () => {
        assert.equal(parseIntAtLeast(1)("1"), 1);
        assert.equal(parseIntAtLeast(1)("99"), 99);
        assert.equal(parseIntAtLeast(0)("0"), 0);
    });

    it("rejects a value below the floor and reports both numbers", () => {
        assert.throws(() => parseIntAtLeast(1)("0"), /Expected a whole number >= 1, got 0/);
        assert.throws(() => parseIntAtLeast(10)("-3"), /Expected a whole number >= 10, got -3/);
    });

    it("still rejects non-integers before it ever checks the floor", () => {
        assert.throws(() => parseIntAtLeast(1)("abc"), /Expected a whole number/);
    });

    it("inherits the radix immunity", () => {
        assert.equal(parseIntAtLeast(1)("20", 20), 20);
    });
});
