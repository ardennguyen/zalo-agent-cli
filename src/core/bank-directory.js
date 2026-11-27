/**
 * The bank list every bank task resolves its bank with (`bank add`, `bank update`, `msg send-bank`,
 * `msg send-qr-transfer`, `zalo_bank`, `zalo_send_message`'s `bankCard` and `qrTransfer`): VietQR's live list (https://api.vietqr.io/v2/banks), fetched with
 * a short timeout and kept for a day in memory and in the data dir (`vietqr-banks.json`), so a fresh list costs no
 * network call. When the fetch fails or answers something that is not the list, the last list fetched applies, else the
 * committed snapshot (src/utils/vietqr-banks.js). The engine's own alias table (src/utils/bank-helpers.js) still
 * resolves the names it knows, so a bank found in only one of the sources works.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import { BANK_NAME_TO_BIN, BIN_TO_DISPLAY } from "../utils/bank-helpers.js";
import { VIETQR_BANKS, VIETQR_BANKS_AS_OF } from "../utils/vietqr-banks.js";

/** Where the live list comes from. */
export const VIETQR_BANKS_URL = "https://api.vietqr.io/v2/banks";

/** A fetched list is used this long before the next fetch. */
export const BANK_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The fetch gives up after this long (the task goes on with the list it has). */
export const BANK_LIST_TIMEOUT_MS = 3000;

/** After a failed fetch, this process waits this long before trying again. */
export const BANK_LIST_RETRY_MS = 15 * 60 * 1000;

/** The largest answer read. */
const MAX_BYTES = 1 << 20;
const MIN_BANKS = 20;
const MAX_BANKS = 1000;

/** @type {{fetchedAt: number, banks: Bank[]}|null} */
let memory = null;
let lastFailureAt = 0;

/**
 * @typedef {object} Bank
 * @property {number} bin
 * @property {string} code
 * @property {string} shortName
 * @property {string} name
 */

/**
 * Read VietQR's answer, refusing anything that does not look like the list: `code` "00", a `data` array of 20 to 1000
 * banks, each with a 6-digit BIN (none twice) and a short name and name.
 *
 * @param {unknown} body - the parsed JSON
 * @returns {Bank[]}
 * @throws {Error} saying what is wrong
 */
export function parseVietQrBanks(body) {
    if (!body || typeof body !== "object" || body.code !== "00") throw new Error("the answer's code is not 00");
    const data = body.data;
    if (!Array.isArray(data)) throw new Error("the answer has no bank list");
    if (data.length < MIN_BANKS || data.length > MAX_BANKS) throw new Error(`the answer lists ${data.length} banks`);
    const seen = new Set();
    return data.map((b) => {
        const bin = typeof b?.bin === "string" ? b.bin : "";
        if (!/^\d{6}$/.test(bin)) throw new Error("a bank's BIN is not six digits");
        if (seen.has(bin)) throw new Error(`the BIN ${bin} is listed twice`);
        seen.add(bin);
        const shortName = String(b.shortName ?? b.short_name ?? "").trim();
        const name = String(b.name ?? "").trim();
        const code = String(b.code ?? "").trim();
        if (!shortName || shortName.length > 50 || !name || name.length > 300 || code.length > 50)
            throw new Error(`the bank with BIN ${bin} has no usable name`);
        return { bin: Number(bin), code, shortName, name };
    });
}

/** The data-dir copy of the last list fetched. */
function defaultCacheFile() {
    return join(CONFIG_DIR, "vietqr-banks.json");
}

function readCache(file) {
    try {
        const c = JSON.parse(readFileSync(file, "utf8"));
        if (typeof c?.fetchedAt === "number" && Array.isArray(c.banks) && c.banks.length >= MIN_BANKS) return c;
    } catch {
        /* no copy yet, or a broken one: fetch */
    }
    return null;
}

function writeCache(file, entry) {
    try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        /* the copy only saves a fetch next time */
    }
}

/**
 * The bank list in effect: the fetched one while it is under a day old (memory, then the data dir: no network call),
 * else a fetch now; on a failed fetch the last list fetched (however old), else the committed snapshot.
 *
 * @param {{fetchImpl?: typeof fetch, now?: number, cacheFile?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{source: "live"|"cache"|"snapshot", asOf: string, banks: Bank[], error?: string}>}
 */
export async function bankList(opts = {}) {
    const { fetchImpl = globalThis.fetch, now = Date.now(), cacheFile = defaultCacheFile() } = opts;
    const timeoutMs = opts.timeoutMs ?? BANK_LIST_TIMEOUT_MS;
    const view = (entry, source, error) => ({
        source,
        asOf: new Date(entry.fetchedAt).toISOString(),
        banks: entry.banks,
        ...(error && { error }),
    });

    if (memory && now - memory.fetchedAt < BANK_LIST_MAX_AGE_MS) return view(memory, "cache");
    const disk = readCache(cacheFile);
    if (disk && (!memory || disk.fetchedAt > memory.fetchedAt)) memory = disk;
    if (memory && now - memory.fetchedAt < BANK_LIST_MAX_AGE_MS) return view(memory, "cache");

    const fallback = (error) =>
        memory
            ? view(memory, "cache", error)
            : { source: "snapshot", asOf: VIETQR_BANKS_AS_OF, banks: VIETQR_BANKS, ...(error && { error }) };
    if (now - lastFailureAt < BANK_LIST_RETRY_MS) return fallback("an earlier fetch failed");
    // The offline test sandbox (tests/helpers/sandbox.js) never reaches the network unless a test hands in its fetch.
    if (!opts.fetchImpl && process.env.ZALO_SANDBOX_ACTIVE === "1") return fallback();

    try {
        const res = await fetchImpl(VIETQR_BANKS_URL, {
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error("the answer is too large");
        const banks = parseVietQrBanks(JSON.parse(text));
        memory = { fetchedAt: now, banks };
        lastFailureAt = 0;
        writeCache(cacheFile, memory);
        return view(memory, "live");
    } catch (e) {
        lastFailureAt = now;
        return fallback(e?.name === "TimeoutError" ? "VietQR did not answer in time" : String(e?.message ?? e));
    }
}

/**
 * A BIN's display name, without a request: the short name in the list this process holds (fetched or read from the
 * data dir), else the engine's alias table, else the committed snapshot, else the BIN.
 *
 * @param {number|string} bin
 * @returns {string}
 */
export function bankName(bin) {
    const n = Number(bin);
    const held = memory?.banks.find((b) => b.bin === n)?.shortName;
    return held || BIN_TO_DISPLAY[n] || VIETQR_BANKS.find((b) => b.bin === n)?.shortName || String(bin ?? "");
}

/** Forget the list held in memory and an earlier failure (tests; a new process starts this way). */
export function resetBankListMemory() {
    memory = null;
    lastFailureAt = 0;
}

const norm = (s) =>
    String(s ?? "")
        .normalize("NFD")
        .replace(/\p{Mn}/gu, "")
        .replace(/[đĐ]/g, "d")
        .toLowerCase()
        .replace(/[\s_.-]/g, "");

/**
 * The bank a name or BIN means, looked up in the list in effect (fetched when the copy is a day old), then the engine's
 * alias table, then the committed snapshot: a BIN in any of them, else a name matching a bank's code or short name in
 * the list, an alias, or a code or short name in the snapshot. Its display name comes from the same places. A BIN of
 * Zalo's own table that VietQR does not list still resolves (a bank only in one source works).
 *
 * @param {string|number} input - "vcb", "Vietcombank", "970436", ...
 * @param {Parameters<typeof bankList>[0]} [opts]
 * @returns {Promise<{bin: number, name: string, source: string, listError?: string}|null>}
 */
export async function resolveBank(input, opts) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    const list = await bankList(opts);
    const sources = [list.banks, VIETQR_BANKS];
    const byBin = (bin) => sources.map((s) => s.find((b) => b.bin === bin)).find(Boolean) ?? null;
    const named = (bin) => ({
        bin,
        name: byBin(bin)?.shortName || BIN_TO_DISPLAY[bin] || String(bin),
        source: list.source,
        ...(list.error && { listError: list.error }),
    });

    if (/^\d+$/.test(raw)) {
        const bin = Number(raw);
        return BIN_TO_DISPLAY[bin] || byBin(bin) ? named(bin) : null;
    }
    const key = norm(raw);
    const inList = (banks) => banks.find((b) => norm(b.code) === key || norm(b.shortName) === key);
    const hit = inList(list.banks)?.bin ?? BANK_NAME_TO_BIN[key] ?? inList(VIETQR_BANKS)?.bin;
    return hit ? named(hit) : null;
}
