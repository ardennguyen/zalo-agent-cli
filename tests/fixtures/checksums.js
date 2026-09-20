#!/usr/bin/env node
/**
 * Print the EXPECTED table for tests/fixtures/index.js.
 *
 * Run after deliberately changing or regenerating a fixture, then paste the
 * output over the `EXPECTED` object in index.js:
 *
 *   node tests/fixtures/checksums.js
 *
 * Do NOT run this to "fix" a failing verifyFixtures(). A checksum mismatch
 * you did not intend means something rewrote the file — find out what before
 * you bless the new bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL } from "./index.js";

const DIR = import.meta.dirname;

console.log("const EXPECTED = {");
for (const fx of ALL) {
    const path = join(DIR, fx.name);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    console.log(`    "${fx.name}": { size: ${statSync(path).size}, sha256: "${sha256}" },`);
}
console.log("};");
