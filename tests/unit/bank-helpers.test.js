import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBankBin, BIN_TO_DISPLAY, BANK_NAME_TO_BIN } from "../../src/utils/bank-helpers.js";
import { BIN_CODES } from "../../src/core/zbs/template-check.js";
import { checkTableSync } from "../helpers/table.js";

describe("resolveBankBin", () => {
    it("resolves names, aliases and BINs in any case and spacing, and nothing unknown", () => {
        // [input, expected BIN or null]
        const ROWS = [
            ["ocb", 970448], // by name
            ["vcb", 970436], // alias
            ["vietcombank", 970436], // full name
            ["970418", 970418], // BIDV by BIN string
            ["unknown", null],
            ["999999", null], // an unknown BIN
            ["OCB", 970448], // case insensitive
            ["Vietcombank", 970436],
            ["BIDV", 970418],
            ["mb bank", 970422], // spaces and underscores
            ["mb_bank", 970422],
            ["mb", 970422], // MB shorthand
            ["ctg", 970415], // CTG alias for VietinBank
            // The ZBS BIN appendix's short names.
            ["LienVietPostBank", 970449],
            ["LPBank", 970449],
            ["Keb Hana HCM", 970466],
            ["BNP Paribas HN", 963668],
            ["VietCapitalBank", 970454],
        ];
        checkTableSync(
            ROWS,
            ([input]) => JSON.stringify(input),
            ([input, bin]) => assert.equal(resolveBankBin(input), bin),
        );
        assert.ok(Object.keys(BANK_NAME_TO_BIN).length >= 50, "at least 50 aliases");
    });
});

describe("BIN_TO_DISPLAY", () => {
    it("names at least 50 banks, the known BINs by their usual name", () => {
        assert.ok(Object.keys(BIN_TO_DISPLAY).length >= 50);
        checkTableSync(
            [
                [970448, "OCB"],
                [970436, "Vietcombank"],
                [970418, "BIDV"],
            ],
            ([bin]) => String(bin),
            ([bin, name]) => assert.equal(BIN_TO_DISPLAY[bin], name),
        );
    });
});

describe("every bank in Zalo's BIN list resolves", () => {
    it("each BIN of the ZBS BIN appendix (the PAYMENT component's list) is a known bank here too", () => {
        // Red if a bank Zalo lists (e.g. LPBank 970449, Citibank, KEB Hana) cannot be named in `bank` or
        // `msg send-qr-transfer`.
        const missing = Object.keys(BIN_CODES).filter((bin) => resolveBankBin(bin) !== Number(bin));
        assert.deepEqual(missing, []);
    });
});
