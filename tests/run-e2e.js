#!/usr/bin/env node
/**
 * Live E2E orchestrator.
 *
 * `node --test` runs files in parallel, which is wrong for this suite on
 * two counts: the tiers are strictly ordered (tier 4 deletes what tier 2
 * created), and Zalo permits only ONE WebSocket per account — two
 * concurrent `msg history` calls would knock each other off with close
 * code 3000. So each tier file is run in its own `node --test` process,
 * sequentially, and a failing tier stops the run before the next one can
 * destroy anything.
 *
 * Usage:
 *   node tests/run-e2e.js                 # tiers 1–4
 *   node tests/run-e2e.js --tier 1        # one tier
 *   node tests/run-e2e.js --through 3     # tiers 1–3
 *   node tests/run-e2e.js --destructive   # tiers 1–5c
 *   node tests/run-e2e.js --end-session   # tiers 1–5d  (QR re-scan needed!)
 *   node tests/run-e2e.js --keep-going    # don't stop at the first failing tier
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTargets } from "./helpers/targets.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const TIERS = [
    { n: 1, file: "e2e/tier1-readonly.test.js", label: "read-only", risk: "none" },
    { n: 2, file: "e2e/tier2-create.test.js", label: "send & create", risk: "adds artifacts" },
    { n: 3, file: "e2e/tier3-mutate-restore.test.js", label: "mutate & restore", risk: "reversible" },
    { n: 4, file: "e2e/tier4-cleanup.test.js", label: "delete & wipe history", risk: "destroys tier-2 artifacts" },
    { n: 5, file: "e2e/tier5-destructive.test.js", label: "irreversible", risk: "DISPERSE / PURGE / LOGOUT" },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
};

const only = valueOf("--tier");
const through = valueOf("--through");
const destructive = has("--destructive") || has("--end-session");
const endSession = has("--end-session");
const keepGoing = has("--keep-going");

let selected = TIERS;
if (only) selected = TIERS.filter((t) => String(t.n) === String(only));
else if (through) selected = TIERS.filter((t) => t.n <= Number(through));
else if (!destructive) selected = TIERS.filter((t) => t.n <= 4);

const { configured, reason, targets } = loadTargets();
if (!configured) {
    console.error(`\n✗ Cannot run live E2E: ${reason}\n`);
    console.error("  Copy tests/targets.example.json to tests/targets.json and fill it in.\n");
    process.exit(2);
}

const env = {
    ...process.env,
    ZALO_TEST_LIVE: "1",
    ...(destructive ? { ZALO_TEST_DESTRUCTIVE: "1" } : {}),
    ...(endSession ? { ZALO_TEST_END_SESSION: "1" } : {}),
};

console.log("\n" + "═".repeat(72));
console.log("  zalo-agent-cli — live E2E");
console.log("═".repeat(72));
console.log(`  account      ${targets.accountOwnId}`);
console.log(`  config home  ${targets.home}`);
console.log(`  group        ${targets.group.name} (${targets.group.threadId})`);
console.log(`  dm           ${targets.dm ? `${targets.dm.name} (${targets.dm.threadId})` : "(not configured)"}`);
console.log(`  denylist     ${targets.denylist.length ? targets.denylist.join(", ") : "(empty)"}`);
console.log(`  tiers        ${selected.map((t) => t.n).join(", ")}`);
if (destructive) console.log("  ⚠  DESTRUCTIVE tier enabled — the group will be dispersed and recreated");
if (endSession) console.log("  ⚠  END-SESSION enabled — you WILL need to re-scan a QR code afterward");
console.log("═".repeat(72) + "\n");

const results = [];
let failed = false;

for (const tier of selected) {
    const file = resolve(HERE, tier.file);
    if (!existsSync(file)) {
        console.error(`  ✗ missing tier file: ${file}`);
        failed = true;
        break;
    }

    console.log(`\n── tier ${tier.n}: ${tier.label}  [${tier.risk}] ${"─".repeat(30)}\n`);
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file], {
        stdio: "inherit",
        env,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const okTier = r.status === 0;
    results.push({ tier: tier.n, label: tier.label, ok: okTier, secs });

    if (!okTier) {
        failed = true;
        console.error(`\n  ✗ tier ${tier.n} failed after ${secs}s`);
        if (!keepGoing) {
            console.error("  Stopping before the next tier. Re-run with --keep-going to continue anyway.\n");
            break;
        }
    }
}

console.log("\n" + "═".repeat(72));
console.log("  summary");
console.log("═".repeat(72));
for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"}  tier ${r.tier} · ${r.label.padEnd(24)} ${r.secs}s`);
}
const notRun = selected.filter((t) => !results.some((r) => r.tier === t.n));
for (const t of notRun) console.log(`  ·  tier ${t.n} · ${t.label.padEnd(24)} not run`);
console.log("═".repeat(72) + "\n");

process.exit(failed ? 1 : 0);
