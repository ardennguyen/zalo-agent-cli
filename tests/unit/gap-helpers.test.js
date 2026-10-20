/**
 * The pure parts behind the gap-sweep commands: argument parsers, the saved-bank-account
 * lookup and the invitation-topic unpacking.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReportReason } from "zca-js";
import {
    REPORT_REASONS,
    parseLanguage,
    parseOnOff,
    parseReportReason,
    parseThreadTypeArg,
} from "../../src/utils/cli-args.js";
import { filterBanks, findBankAccount } from "../../src/core/bank-accounts.js";
import { unpackTopic } from "../../src/core/group-invite.js";

describe("parseThreadTypeArg", () => {
    it("accepts 0 and 1 only", () => {
        assert.equal(parseThreadTypeArg("0"), 0);
        assert.equal(parseThreadTypeArg(1), 1);
        for (const bad of ["2", "", "user", "-1", "01"])
            assert.throws(() => parseThreadTypeArg(bad), /--type must be 0/, bad);
    });
});

describe("parseOnOff", () => {
    it("reads the usual spellings of on and off, and refuses the rest", () => {
        for (const on of ["on", "ON", "true", "1", "yes", "enable"]) assert.equal(parseOnOff(on), true, on);
        for (const off of ["off", "Off", "false", "0", "no", "disable"]) assert.equal(parseOnOff(off), false, off);
        assert.throws(() => parseOnOff("maybe", "active"), /active must be "on" or "off"/);
        assert.throws(() => parseOnOff(""), /must be/);
    });
});

describe("parseLanguage", () => {
    it("maps vi/en to the codes zca-js sends and refuses others", () => {
        assert.equal(parseLanguage("vi"), "VI");
        assert.equal(parseLanguage(" EN "), "EN");
        assert.throws(() => parseLanguage("fr"), /language must be one of: vi, en/);
    });
});

describe("parseReportReason", () => {
    it("maps each named reason to zca-js's code", () => {
        assert.deepEqual(parseReportReason("sensitive"), { reason: ReportReason.Sensitive });
        assert.deepEqual(parseReportReason("Annoy"), { reason: ReportReason.Annoy });
        assert.deepEqual(parseReportReason("fraud"), { reason: ReportReason.Fraud });
        assert.deepEqual(Object.keys(REPORT_REASONS), ["sensitive", "annoy", "fraud", "other"]);
    });

    it("'other' carries trimmed text and needs it", () => {
        assert.deepEqual(parseReportReason("other", "  scam  "), { reason: ReportReason.Other, content: "scam" });
        assert.throws(() => parseReportReason("other"), /needs the details/);
        assert.throws(() => parseReportReason("other", "   "), /needs the details/);
    });

    it("refuses text with any other reason (zca-js would drop it silently) and unknown reasons", () => {
        assert.throws(() => parseReportReason("fraud", "details"), /only sent with --reason other/);
        assert.throws(() => parseReportReason("rude"), /--reason must be one of/);
    });
});

describe("findBankAccount", () => {
    const acct = (id, def = false) => ({ account_id: id, default: def });
    /** An api whose saved-account list is split into pages of `size`. */
    function api(all, size, calls = []) {
        return {
            calls,
            getListBankAccount: async (page, limit) => {
                calls.push([page, limit]);
                const slice = all.slice(page * size, page * size + size);
                return { myBanks: slice, hasMore: (page + 1) * size < all.length, total: all.length };
            },
        };
    }

    it("finds an account on a later page and reports it with its default flag", async () => {
        const a = api([acct(1), acct(2), acct(3, true), acct(4)], 2);
        assert.deepEqual(await findBankAccount(a, 3), acct(3, true));
        assert.equal(a.calls.length, 2, "stops at the page that has it");
    });

    it("is null when no page has it, and compares ids as numbers", async () => {
        assert.equal(await findBankAccount(api([acct(1)], 5), 9), null);
        assert.deepEqual(await findBankAccount(api([acct("12")], 5), 12), acct("12"));
    });

    it("gives up after a bounded number of pages if Zalo never stops saying there are more", async () => {
        const endless = { getListBankAccount: async () => ({ myBanks: [], hasMore: true }) };
        assert.equal(await findBankAccount(endless, 1), null);
    });
});

describe("filterBanks", () => {
    const banks = [
        { bin: 970448, name: "Phương Đông", short_name: "OCB", name_eng: "Orient", search_key_word: "ocb" },
        {
            bin: 970436,
            name: "Ngoại thương",
            short_name: "Vietcombank",
            name_eng: "Foreign Trade",
            search_key_word: "vcb",
        },
    ];
    it("matches name, short name, English name, keyword or BIN; all for an empty query", () => {
        assert.deepEqual(
            filterBanks(banks, "OCB").map((b) => b.bin),
            [970448],
        );
        assert.deepEqual(
            filterBanks(banks, "foreign").map((b) => b.bin),
            [970436],
        );
        assert.deepEqual(
            filterBanks(banks, "970436").map((b) => b.bin),
            [970436],
        );
        assert.equal(filterBanks(banks, "").length, 2);
        assert.deepEqual(filterBanks(undefined, "x"), []);
    });
});

describe("unpackTopic", () => {
    it("unpacks params, and params.extra, which Zalo sends as JSON inside JSON", () => {
        const topic = { id: "t", params: JSON.stringify({ title: "T", extra: JSON.stringify({ n: 1 }) }) };
        assert.deepEqual(unpackTopic(topic).params, { title: "T", extra: { n: 1 } });
        assert.equal(typeof topic.params, "string", "the input is not mutated");
    });

    it("leaves a topic it cannot read as it came, and survives no topic at all", () => {
        assert.deepEqual(unpackTopic({ params: "not json" }), { params: "not json" });
        assert.equal(unpackTopic(undefined), undefined);
        assert.deepEqual(unpackTopic({ id: "x" }), { id: "x" });
        const keepExtra = unpackTopic({ params: JSON.stringify({ extra: "not json" }) });
        assert.equal(keepExtra.params.extra, "not json");
    });
});
