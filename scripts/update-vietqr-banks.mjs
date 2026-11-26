#!/usr/bin/env node
/**
 * Refresh the committed VietQR bank list (src/utils/vietqr-banks.js), the fallback a bank QR task uses when it cannot
 * fetch the live list: fetches https://api.vietqr.io/v2/banks, checks it as the engine does (parseVietQrBanks), and
 * rewrites the file with today's date. Run before a release, or whenever a bank is missing; review the diff, then run
 * `npm run format` and the gate.
 *
 *     node scripts/update-vietqr-banks.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VIETQR_BANKS_URL, parseVietQrBanks } from "../src/core/bank-directory.js";

const OUT = join(import.meta.dirname, "..", "src", "utils", "vietqr-banks.js");

const res = await fetch(VIETQR_BANKS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
if (!res.ok) throw new Error(`VietQR answered HTTP ${res.status}`);
const banks = parseVietQrBanks(await res.json());
const today = new Date().toISOString().slice(0, 10);

const lines = [
    "/**",
    " * VietQR's bank list (https://api.vietqr.io/v2/banks) as fetched on the date below: the fallback when a bank QR task",
    " * cannot fetch the live list (src/core/bank-directory.js). Refresh it with `node scripts/update-vietqr-banks.mjs`",
    ' * (docs/agent-notes.md, "Bank list").',
    " */",
    "",
    "/** The day this list was fetched. */",
    `export const VIETQR_BANKS_AS_OF = "${today}";`,
    "",
    "/** Each bank: its BIN (a number, as Zalo takes it), NAPAS code, short name and full Vietnamese name. */",
    "export const VIETQR_BANKS = [",
    ...banks.map(
        (b) =>
            `    { bin: ${b.bin}, code: ${JSON.stringify(b.code)}, shortName: ${JSON.stringify(b.shortName)}, ` +
            `name: ${JSON.stringify(b.name)} },`,
    ),
    "];",
    "",
];
writeFileSync(OUT, lines.join("\n"));
console.error(`${banks.length} banks written to ${OUT} (as of ${today}).`);
