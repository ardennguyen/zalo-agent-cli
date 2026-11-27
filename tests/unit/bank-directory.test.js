/**
 * The bank list a bank QR task resolves with (src/core/bank-directory.js): VietQR's live list through a mocked fetch,
 * kept a day in memory and in the data dir, the committed snapshot when the fetch fails or answers badly, and the
 * alias table for a bank only it knows. Also the locally built VietQR payload (src/utils/vietqr.js).
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    BANK_LIST_MAX_AGE_MS,
    BANK_LIST_RETRY_MS,
    VIETQR_BANKS_URL,
    bankList,
    parseVietQrBanks,
    resetBankListMemory,
    resolveBank,
} from "../../src/core/bank-directory.js";
import { VIETQR_BANKS, VIETQR_BANKS_AS_OF } from "../../src/utils/vietqr-banks.js";
import { crc16Ccitt, vietQrPayload } from "../../src/utils/vietqr.js";
import { actionTool } from "../../src/mcp/action-tool.js";
import { BANK_ACTIONS } from "../../src/mcp/actions-business.js";
import { resolveBankBin } from "../../src/utils/bank-helpers.js";

assertSandboxed(CONFIG_DIR);

const T0 = Date.UTC(2026, 10, 26, 8, 0, 0);
let cacheN = 0;

/** 25 invented banks, BINs 971200 up; the first is "Example Pay" (code EXPAY), which no other source knows. */
function answer({ code = "00", banks = 25 } = {}) {
    return {
        code,
        desc: "Get Bank list successful!",
        data: Array.from({ length: banks }, (_, i) => ({
            id: i + 1,
            name: i === 0 ? "Ví điện tử Ví dụ" : `Ngân hàng số ${i}`,
            code: i === 0 ? "EXPAY" : `EX${i}`,
            bin: String(971200 + i),
            shortName: i === 0 ? "Example Pay" : `Bank ${i}`,
            logo: `https://cdn.example.com/img/EX${i}.png`,
            transferSupported: 1,
            lookupSupported: 1,
        })),
    };
}

/** A fetch that answers `body` (or throws `fail`), recording each URL. */
function mockFetch({ body = answer(), status = 200, fail = null } = {}) {
    const calls = [];
    const fn = async (url) => {
        calls.push(String(url));
        if (fail) throw fail;
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    return { fn, calls };
}

describe("parseVietQrBanks", () => {
    it("reads VietQR's answer: BIN as a number, code, short name, name", () => {
        const banks = parseVietQrBanks(answer());
        assert.equal(banks.length, 25);
        assert.deepEqual(banks[0], { bin: 971200, code: "EXPAY", shortName: "Example Pay", name: "Ví điện tử Ví dụ" });
    });

    it("refuses an answer that is not the list", () => {
        const bad = (mutate) => {
            const a = answer();
            mutate(a);
            return a;
        };
        const rows = [
            ["code 01", answer({ code: "01" }), /code is not 00/],
            ["no data", { code: "00" }, /no bank list/],
            ["too few", answer({ banks: 3 }), /lists 3 banks/],
            ["5-digit BIN", bad((a) => (a.data[2].bin = "97120")), /not six digits/],
            ["numeric BIN", bad((a) => (a.data[2].bin = 971202)), /not six digits/],
            ["BIN twice", bad((a) => (a.data[3].bin = "971200")), /listed twice/],
            ["no name", bad((a) => (a.data[4].name = "")), /no usable name/],
        ];
        for (const [label, body, re] of rows) assert.throws(() => parseVietQrBanks(body), re, label);
    });
});

describe("bankList and resolveBank", () => {
    let cacheFile;
    beforeEach(() => {
        resetBankListMemory();
        cacheFile = join(SANDBOX_CONFIG_DIR, `vietqr-banks-${++cacheN}.json`);
    });

    it("live: fetches VietQR's list, resolves a bank only it has, and keeps a copy in the data dir", async () => {
        const f = mockFetch();
        const bank = await resolveBank("Example Pay", { fetchImpl: f.fn, now: T0, cacheFile });
        assert.deepEqual(bank, { bin: 971200, name: "Example Pay", source: "live" });
        assert.deepEqual(f.calls, [VIETQR_BANKS_URL]);
        assert.equal((await resolveBank("expay", { fetchImpl: f.fn, now: T0, cacheFile }))?.bin, 971200, "by code");
        assert.equal((await resolveBank("971200", { fetchImpl: f.fn, now: T0, cacheFile }))?.bin, 971200, "by BIN");
        assert.ok(existsSync(cacheFile));
        assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).banks[0].bin, 971200);
    });

    it("cache: a list under a day old costs no fetch, from memory or (a new process) the data dir", async () => {
        const f = mockFetch();
        await bankList({ fetchImpl: f.fn, now: T0, cacheFile });
        const again = await bankList({ fetchImpl: f.fn, now: T0 + BANK_LIST_MAX_AGE_MS - 1, cacheFile });
        assert.equal(again.source, "cache");
        resetBankListMemory();
        const fromDisk = await bankList({ fetchImpl: f.fn, now: T0 + 60_000, cacheFile });
        assert.equal(fromDisk.source, "cache");
        assert.equal(fromDisk.banks[0].shortName, "Example Pay");
        assert.equal(f.calls.length, 1, "no second fetch while the copy is fresh");

        // A day old: fetched again.
        const later = await bankList({ fetchImpl: f.fn, now: T0 + BANK_LIST_MAX_AGE_MS, cacheFile });
        assert.equal(later.source, "live");
        assert.equal(f.calls.length, 2);
    });

    it("fallback: VietQR unreachable gives the committed snapshot, and a bank in only one source still resolves", async () => {
        const f = mockFetch({ fail: new TypeError("fetch failed") });
        const list = await bankList({ fetchImpl: f.fn, now: T0, cacheFile });
        assert.equal(list.source, "snapshot");
        assert.equal(list.asOf, VIETQR_BANKS_AS_OF);
        assert.equal(list.error, "fetch failed");
        assert.equal(list.banks, VIETQR_BANKS);
        // In the snapshot only (not the alias table): MoMo.
        assert.deepEqual(await resolveBank("momo", { fetchImpl: f.fn, now: T0, cacheFile }), {
            bin: 971025,
            name: "MoMo",
            source: "snapshot",
            listError: "an earlier fetch failed",
        });
        // In the alias table only (VietQR does not list it): Liobank, by name and by BIN.
        assert.equal((await resolveBank("liobank", { fetchImpl: f.fn, now: T0, cacheFile }))?.bin, 963369);
        assert.equal((await resolveBank("963369", { fetchImpl: f.fn, now: T0, cacheFile }))?.name, "Liobank");
        assert.equal(await resolveBank("notabank", { fetchImpl: f.fn, now: T0, cacheFile }), null);
        assert.equal(await resolveBank("123456", { fetchImpl: f.fn, now: T0, cacheFile }), null);
        assert.equal(f.calls.length, 1, "a failed fetch is not retried within the retry period");

        await bankList({ fetchImpl: f.fn, now: T0 + BANK_LIST_RETRY_MS, cacheFile });
        assert.equal(f.calls.length, 2, "and is retried after it");
    });

    it("fallback: a bad answer (code other than 00, HTTP error) is not trusted", async () => {
        const bad = mockFetch({ body: answer({ code: "99" }) });
        let list = await bankList({ fetchImpl: bad.fn, now: T0, cacheFile });
        assert.deepEqual([list.source, list.error], ["snapshot", "the answer's code is not 00"]);
        assert.equal(await resolveBank("Example Pay", { fetchImpl: bad.fn, now: T0, cacheFile }), null);

        resetBankListMemory();
        list = await bankList({ fetchImpl: mockFetch({ status: 503 }).fn, now: T0, cacheFile });
        assert.deepEqual([list.source, list.error], ["snapshot", "HTTP 503"]);
    });

    it("fallback: a fetch that does not answer in time gives up after the timeout", async () => {
        // A server that never answers. AbortSignal.timeout's timer does not keep the process alive (a real request's socket
        // does), so this one holds a timer of its own until the abort.
        const hang = (url, init) =>
            new Promise((_, reject) => {
                const alive = setTimeout(() => reject(new Error("the timeout never fired")), 5000);
                init.signal.addEventListener("abort", () => {
                    clearTimeout(alive);
                    reject(init.signal.reason);
                });
            });
        const list = await bankList({ fetchImpl: hang, now: T0, cacheFile, timeoutMs: 50 });
        assert.deepEqual([list.source, list.error], ["snapshot", "VietQR did not answer in time"]);
    });

    it("a list fetched earlier outlives a later failed fetch (newer than the snapshot)", async () => {
        await bankList({ fetchImpl: mockFetch().fn, now: T0, cacheFile });
        const down = mockFetch({ fail: new TypeError("fetch failed") });
        const bank = await resolveBank("Example Pay", {
            fetchImpl: down.fn,
            now: T0 + 2 * BANK_LIST_MAX_AGE_MS,
            cacheFile,
        });
        assert.deepEqual(bank, { bin: 971200, name: "Example Pay", source: "cache", listError: "fetch failed" });
        assert.equal(down.calls.length, 1);
    });

    it("without a fetch handed in, the test sandbox never reaches the network: the snapshot applies", async () => {
        const list = await bankList({ now: T0, cacheFile });
        assert.equal(list.source, "snapshot");
        assert.equal((await resolveBank("vcb", { now: T0, cacheFile }))?.bin, 970436);
    });
});

describe("every bank task resolves with the same list", () => {
    beforeEach(() => resetBankListMemory());

    /** zalo_bank's runner over a session recording each call. */
    function zaloBank() {
        const calls = [];
        const api = new Proxy(
            {},
            {
                get: (_t, prop) =>
                    prop === "then"
                        ? undefined
                        : async (...args) => {
                              calls.push({ method: prop, args });
                              return {};
                          },
            },
        );
        const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
        const err = (m) => ({ content: [{ type: "text", text: m }], isError: true });
        return { calls, run: actionTool("zalo_bank", BANK_ACTIONS, { api, ok, err, gate: async () => null }) };
    }

    it("zalo_bank add and update take a bank only VietQR's live list has (the alias table refused it)", async () => {
        // "Example Pay" (BIN 971200) is in no table of the engine's: only in the list fetched now.
        assert.equal(resolveBankBin("Example Pay"), null);
        await bankList({
            fetchImpl: mockFetch().fn,
            cacheFile: join(SANDBOX_CONFIG_DIR, `vietqr-banks-${++cacheN}.json`),
        });
        const b = zaloBank();
        const added = await b.run({
            action: "add",
            bank: "Example Pay",
            accountNumber: "0123",
            holderName: "NGUYEN VAN A",
        });
        assert.equal(added.isError, undefined, added.content[0].text);
        assert.deepEqual(b.calls.at(-1), {
            method: "createBankAccount",
            args: [{ binBank: 971200, numAccBank: "0123", nameAccBank: "NGUYEN VAN A" }],
        });
        assert.equal(JSON.parse(added.content[0].text).bank, "Example Pay");
        const updated = await b.run({
            action: "update",
            bankAccountId: "7",
            bank: "expay",
            accountNumber: "0123",
            holderName: "NGUYEN VAN A",
        });
        assert.equal(updated.isError, undefined, updated.content[0].text);
        assert.equal(b.calls.at(-1).args[0].binBank, 971200);
    });

    it("an unknown bank is still refused before anything is sent", async () => {
        const b = zaloBank();
        const r = await b.run({ action: "add", bank: "no such bank", accountNumber: "0123", holderName: "A" });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /Unknown bank: 'no such bank'/);
        assert.deepEqual(b.calls, []);
    });
});

describe("the committed snapshot", () => {
    it("is VietQR's list as parsed: six-digit BINs, no BIN twice, a name for each", () => {
        assert.match(VIETQR_BANKS_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
        const asAnswer = {
            code: "00",
            data: VIETQR_BANKS.map((b) => ({ ...b, bin: String(b.bin) })),
        };
        assert.deepEqual(parseVietQrBanks(asAnswer), VIETQR_BANKS);
        assert.ok(VIETQR_BANKS.length >= 70);
    });
});

describe("vietQrPayload", () => {
    /** The top-level EMVCo fields of a payload. */
    const fields = (p) => {
        const out = {};
        for (let i = 0; i < p.length;) {
            const len = Number(p.slice(i + 2, i + 4));
            out[p.slice(i, i + 2)] = p.slice(i + 4, i + 4 + len);
            i += 4 + len;
        }
        return out;
    };

    it("uses CRC-16/CCITT-FALSE (check value 29B1)", () => {
        assert.equal(crc16Ccitt("123456789"), 0x29b1);
    });

    it("carries the BIN, account, amount and the note without marks, and a checksum that matches", () => {
        const p = vietQrPayload({ bin: 971025, accountNumber: "0123456789", amount: 50000, content: "Đơn hàng 12" });
        const f = fields(p);
        assert.equal(f["01"], "12", "dynamic: it has an amount");
        assert.equal(f["38"], "0010A000000727" + "0124" + "0006971025" + "01100123456789" + "0208QRIBFTTA");
        assert.deepEqual([f["53"], f["54"], f["58"], f["62"]], ["704", "50000", "VN", "0811Don hang 12"]);
        assert.equal(f["63"], crc16Ccitt(p.slice(0, -4)).toString(16).toUpperCase().padStart(4, "0"));
        assert.equal(fields(vietQrPayload({ bin: "970436", accountNumber: "1" }))["01"], "11", "static: no amount");
    });

    it("refuses a BIN that is not six digits and an account number that is not 1-19 letters or digits", () => {
        assert.throws(() => vietQrPayload({ bin: 9704261, accountNumber: "1" }), /six digits/);
        assert.throws(() => vietQrPayload({ bin: 970436, accountNumber: "12-3" }), /1-19/);
        assert.throws(() => vietQrPayload({ bin: 970436, accountNumber: "1".repeat(20) }), /1-19/);
    });
});
