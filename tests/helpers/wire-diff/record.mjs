#!/usr/bin/env node
/**
 * (Re)write an area's golden file from our side:
 *
 *     node tests/helpers/wire-diff/record.mjs <area>
 *
 * Runs `tests/unit/wire-<area>.test.js` with `WIRE_GOLDEN_RECORD=<area>`, so every `expectGolden` of that file
 * collects its case instead of checking it, and the file `tests/helpers/wire-diff/golden/<area>.js` is written
 * when the test process exits. Then formats it with the repo's prettier settings. The parts of the test that do
 * not depend on the golden file (the direct assertions, the error cases) still run and must pass.
 *
 * Review the diff (`git diff tests/helpers/wire-diff/golden/<area>.js`) before committing: a golden entry is a
 * claim about the wire, and it must hold fake ids only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goldenPath } from "./golden.js";

const area = process.argv[2];
if (!area || !/^[a-z][a-z0-9-]*$/.test(area)) {
    console.error("usage: node tests/helpers/wire-diff/record.mjs <area>   (e.g. groups)");
    process.exit(2);
}
const root = join(import.meta.dirname, "..", "..", "..");
const testFile = join(root, "tests", "unit", `wire-${area}.test.js`);
if (!existsSync(testFile)) {
    console.error(`record: no test file tests/unit/wire-${area}.test.js`);
    process.exit(2);
}

const run = spawnSync(process.execPath, ["--test", testFile], {
    cwd: root,
    env: { ...process.env, WIRE_GOLDEN_RECORD: area },
    stdio: "inherit",
});
const file = goldenPath(area);
if (!existsSync(file)) {
    console.error(`record: the run wrote no golden/${area}.js (did any case call expectGolden?)`);
    process.exit(1);
}

const prettier = await import("prettier");
const text = readFileSync(file, "utf8");
const options = (await prettier.resolveConfig(file)) ?? {};
writeFileSync(file, await prettier.format(text, { ...options, filepath: file }));
console.error(`record: wrote tests/helpers/wire-diff/golden/${area}.js; review the diff before committing`);
process.exit(run.status ?? 1);
