import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBankBin, BIN_TO_DISPLAY, BANK_NAME_TO_BIN } from "./bank-helpers.js";

describe("resolveBankBin", () => {
    it("resolves OCB by name", () => {
        assert.equal(resolveBankBin("ocb"), 970448);
    });

    it("resolves VCB alias", () => {
        assert.equal(resolveBankBin("vcb"), 970436);
    });

    it("resolves Vietcombank full name", () => {
        assert.equal(resolveBankBin("vietcombank"), 970436);
    });

    it("resolves BIDV by BIN string", () => {
        assert.equal(resolveBankBin("970418"), 970418);
    });

    it("returns null for unknown name", () => {
        assert.equal(resolveBankBin("unknown"), null);
    });

    it("returns null for unknown BIN", () => {
        assert.equal(resolveBankBin("999999"), null);
    });

    it("is case insensitive", () => {
        assert.equal(resolveBankBin("OCB"), 970448);
        assert.equal(resolveBankBin("Vietcombank"), 970436);
        assert.equal(resolveBankBin("BIDV"), 970418);
    });

    it("handles spaces and underscores", () => {
        assert.equal(resolveBankBin("mb bank"), 970422);
        assert.equal(resolveBankBin("mb_bank"), 970422);
    });

    it("resolves MB shorthand", () => {
        assert.equal(resolveBankBin("mb"), 970422);
    });

    it("resolves CTG alias for VietinBank", () => {
        assert.equal(resolveBankBin("ctg"), 970415);
    });
});

describe("BIN_TO_DISPLAY", () => {
    it("has at least 50 banks", () => {
        assert.ok(Object.keys(BIN_TO_DISPLAY).length >= 50);
    });

    it("maps known BINs correctly", () => {
        assert.equal(BIN_TO_DISPLAY[970448], "OCB");
        assert.equal(BIN_TO_DISPLAY[970436], "Vietcombank");
        assert.equal(BIN_TO_DISPLAY[970418], "BIDV");
    });
});

describe("BANK_NAME_TO_BIN", () => {
    it("has at least 50 aliases", () => {
        assert.ok(Object.keys(BANK_NAME_TO_BIN).length >= 50);
    });
});
