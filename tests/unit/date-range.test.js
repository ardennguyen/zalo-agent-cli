/**
 * The date options of search (src/utils/date-range.js): periods (`7d`, `3m`) and dates as bounds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateBound, parsePeriod } from "../../src/utils/date-range.js";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY = 86_400_000;

describe("parsePeriod", () => {
    it("takes hours, days, weeks, months and years, ending now", () => {
        assert.equal(parsePeriod("12h", NOW), NOW - 12 * 3_600_000);
        assert.equal(parsePeriod("7d", NOW), NOW - 7 * DAY);
        assert.equal(parsePeriod("2w", NOW), NOW - 14 * DAY);
        assert.equal(parsePeriod("1m", NOW), NOW - 30 * DAY);
        assert.equal(parsePeriod("3M", NOW), NOW - 90 * DAY, "the unit is not case sensitive");
        assert.equal(parsePeriod("1y", NOW), NOW - 365 * DAY);
        assert.equal(parsePeriod(" 5 d ", NOW), NOW - 5 * DAY, "spaces around are fine");
    });

    it("refuses anything else, and zero", () => {
        for (const bad of ["", "d", "7", "7x", "-3d", "0d", "1.5d", "week", "3 months", "99999d", null, undefined]) {
            assert.throws(() => parsePeriod(bad, NOW), /Expected a period/, String(bad));
        }
    });
});

describe("parseDateBound", () => {
    it("takes a day as its whole length: the first millisecond below, the last above", () => {
        assert.equal(parseDateBound("2026-10-01", "start"), new Date(2026, 9, 1, 0, 0, 0, 0).getTime());
        assert.equal(parseDateBound("2026-10-01", "end"), new Date(2026, 9, 1, 23, 59, 59, 999).getTime());
        const span = parseDateBound("2026-10-01", "end") - parseDateBound("2026-10-01", "start");
        assert.ok(span >= 23 * 3_600_000 && span < 25 * 3_600_000, "one local day, whatever the clock changes");
        assert.equal(
            new Date(parseDateBound("2026-10-01", "end")).getDate(),
            1,
            "the last millisecond is still the 1st",
        );
    });

    it("takes a full date and time as it is, at either edge", () => {
        const t = Date.parse("2026-10-01T09:30:00Z");
        assert.equal(parseDateBound("2026-10-01T09:30:00Z", "start"), t);
        assert.equal(parseDateBound("2026-10-01T09:30:00Z", "end"), t);
    });

    it("refuses what is not a date, including a day that rolls into the next month", () => {
        for (const bad of ["", "yesterday", "2026-13-01", "2026-02-31", "2026-10-1x", "10/01/2026x", null]) {
            assert.throws(() => parseDateBound(bad, "start"), /Not a date/, String(bad));
        }
        assert.ok(parseDateBound("2028-02-29", "start"), "a real leap day is a date");
        assert.throws(() => parseDateBound("2027-02-29", "start"), /Not a date/);
    });
});
