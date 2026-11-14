/**
 * Golden wire records: what our engine sends and returns for each case of an area, kept as a reviewed `.js`
 * module in `golden/<area>.js` (fake ids only). They are what guards the wire: a change to what the engine sends
 * or returns shows as a difference from a reviewed record.
 *
 * `expectGolden(area, name, rec.own)` compares one case with its entry. To (re)write an area's file from our side:
 *
 *     node tests/helpers/wire-diff/record.mjs <area>
 *
 * which runs `tests/unit/wire-<area>.test.js` with `WIRE_GOLDEN_RECORD=<area>`: in that mode `expectGolden`
 * asserts nothing and collects every case, and the file is written when the process exits. Review the diff
 * before committing it; a golden entry is a claim about the wire.
 *
 * The encrypted `rawParams` are left out of an entry: the decrypted `params` and their key order are in it, and
 * the session cipher has tests of its own.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeValue } from "./normalize.js";

/** Where the golden files live. */
export const GOLDEN_DIR = join(import.meta.dirname, "golden");

/** Cases collected in record mode, per file path. */
const recorded = new Map();
let hooked = false;

/**
 * The file of an area's golden records.
 *
 * @param {string} area - e.g. "groups"
 * @param {string} [dir]
 * @returns {string}
 */
export function goldenPath(area, dir = GOLDEN_DIR) {
    if (!/^[a-z][a-z0-9-]*$/.test(area)) throw new Error(`golden: not an area name: ${area}`);
    return join(dir, `${area}.js`);
}

/**
 * What a golden entry holds of a record side: everything but the encrypted params.
 *
 * @param {{requests: object[], result?: unknown, error?: object|null}} side
 * @returns {object}
 */
export function goldenEntry(side) {
    const requests = side.requests.map((r) => {
        const copy = { ...r };
        delete copy.rawParams;
        return copy;
    });
    const out = { requests, error: side.error ?? null };
    if (side.result !== undefined) out.result = side.result;
    return normalizeValue(out);
}

/**
 * The source text of a golden file.
 *
 * @param {string} area
 * @param {Record<string, object>} entries
 * @returns {string}
 */
export function goldenSource(area, entries) {
    const sorted = Object.fromEntries(
        Object.keys(entries)
            .sort()
            .map((k) => [k, entries[k]]),
    );
    return [
        "/**",
        ` * Golden wire records of the ${area} area: what our engine sends and returns for each case of`,
        ` * tests/unit/wire-${area}.test.js. Written by \`node tests/helpers/wire-diff/record.mjs ${area}\`, then reviewed by`,
        " * hand. Fake ids only.",
        " */",
        `export default ${JSON.stringify(sorted, null, 4)};`,
        "",
    ].join("\n");
}

/**
 * True when this process records `area` instead of checking it.
 *
 * @param {string} area
 * @returns {boolean}
 */
export function isRecording(area) {
    const mode = process.env.WIRE_GOLDEN_RECORD;
    return mode === area || mode === "all";
}

/**
 * Write every case collected in record mode. Runs by itself when the process exits; callable directly.
 *
 * @returns {string[]} the files written
 */
export function flushGolden() {
    const written = [];
    for (const [file, { area, entries }] of recorded) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, goldenSource(area, entries));
        written.push(file);
    }
    recorded.clear();
    return written;
}

/**
 * Compare our side of one case with its golden entry; in record mode, collect it instead.
 *
 * @param {string} area
 * @param {string} name - the case, unique in the area (e.g. "getGroupInfo" or "getGroupInfo/array")
 * @param {{requests: object[], result?: unknown, error?: object|null}} ownRecord - `rec.own` of a `wire.run`
 * @param {{dir?: string}} [opts] - another golden folder (the harness's own self-test)
 * @returns {Promise<void>}
 */
export async function expectGolden(area, name, ownRecord, { dir = GOLDEN_DIR } = {}) {
    const file = goldenPath(area, dir);
    const entry = goldenEntry(ownRecord);
    if (isRecording(area)) {
        if (!recorded.has(file)) recorded.set(file, { area, entries: {} });
        const { entries } = recorded.get(file);
        assert.ok(!(name in entries), `golden: case "${name}" recorded twice in ${area}`);
        entries[name] = entry;
        if (!hooked) {
            hooked = true;
            process.once("exit", flushGolden);
        }
        return;
    }
    const hint = `run \`node tests/helpers/wire-diff/record.mjs ${area}\`, review the diff, and commit it`;
    assert.ok(existsSync(file), `golden: no file golden/${area}.js; ${hint}`);
    const golden = (await import(pathToFileURL(file).href)).default;
    assert.ok(golden && Object.hasOwn(golden, name), `golden: no entry "${name}" in golden/${area}.js; ${hint}`);
    assert.deepStrictEqual(entry, golden[name], `golden: ${area} "${name}" no longer matches its reviewed record`);
}
