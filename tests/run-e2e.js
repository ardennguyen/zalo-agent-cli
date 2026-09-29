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
 *   node tests/run-e2e.js --destructive   # tiers 1–5d  (see below)
 *   node tests/run-e2e.js --end-session   # tiers 1–5e  (QR re-scan needed!)
 *
 * --destructive reaches further than its name suggests. It unlocks 5a-5d,
 * which includes `logout --no-remote --delete-history` and
 * `logout --no-remote --purge` plus a deliberate unlink of the credential
 * file. Those are recoverable only via an after() hook that does NOT run on
 * Ctrl-C. Only 5e (a real server-side logout) needs --end-session.
 *   node tests/run-e2e.js --keep-going    # don't stop at the first failing tier
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// The gates are decided by the FLAGS on this command line and by nothing
// else. Spreading process.env first and then conditionally adding could only
// ever turn a gate ON: an ambient `ZALO_TEST_END_SESSION=1` left in the shell
// passed straight through to the tier-5 child and opened the real
// `logout` / `logout --purge` tests, while the banner below — which keys off
// the flag variable, not the environment — printed no warning at all. Same
// hole for ZALO_TEST_DESTRUCTIVE with `--tier 5`.
//
// So: strip all three, then set them from the parsed flags, and say out loud
// when an inherited value was discarded.
const GATE_VARS = ["ZALO_TEST_LIVE", "ZALO_TEST_DESTRUCTIVE", "ZALO_TEST_END_SESSION"];
const inherited = GATE_VARS.filter((k) => process.env[k] !== undefined);

const env = { ...process.env };
for (const k of GATE_VARS) delete env[k];
env.ZALO_TEST_LIVE = "1";
if (destructive) env.ZALO_TEST_DESTRUCTIVE = "1";
if (endSession) env.ZALO_TEST_END_SESSION = "1";

const ignored = inherited.filter((k) => env[k] === undefined);
if (ignored.length) {
    console.log(`  ⚠  ignoring inherited ${ignored.join(", ")} — gates come from this command's flags only`);
}

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

/**
 * Run one tier's test file and record the outcome.
 *
 * @param {object} tier - an entry of TIERS
 * @returns {boolean} whether the tier passed
 */
function runTier(tier) {
    console.log(`\n── tier ${tier.n}: ${tier.label}  [${tier.risk}] ${"─".repeat(30)}\n`);
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", resolve(HERE, tier.file)], {
        stdio: "inherit",
        env,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const okTier = r.status === 0;
    results.push({ tier: tier.n, label: tier.label, ok: okTier, secs });
    if (!okTier) console.error(`\n  ✗ tier ${tier.n} failed after ${secs}s`);
    return okTier;
}

const CLEANUP_TIER = 4;
let cleanupRan = false;

for (const tier of selected) {
    const file = resolve(HERE, tier.file);
    if (!existsSync(file)) {
        console.error(`  ✗ missing tier file: ${file}`);
        failed = true;
        break;
    }

    const okTier = runTier(tier);
    if (tier.n === CLEANUP_TIER) cleanupRan = true;

    if (!okTier) {
        failed = true;
        if (!keepGoing) {
            // Stop -- but NOT before cleaning up. Tier 2 sends to a real
            // person's DM, and Zalo's recall window closes: four artifacts
            // left there on 2026-09-21 were still unrecallable on
            // 2026-09-29, every one answering `Lỗi không xác định`, while a
            // message sent minutes earlier recalled cleanly. So a test bug
            // in tier 2 or 3 used to turn into permanent debris in someone
            // else's chat -- a far worse outcome than the failure itself.
            //
            // Only tier 4 is safe to run here. Tier 3 mutates and tier 5 is
            // irreversible; neither belongs after an unexplained failure.
            const cleanup = selected.find((t) => t.n === CLEANUP_TIER);
            if (cleanup && !cleanupRan && existsSync(resolve(HERE, cleanup.file))) {
                console.error(`\n  Running tier ${CLEANUP_TIER} anyway to recall what has already been sent.`);
                console.error("  Skipping the tiers in between.\n");
                runTier(cleanup);
                cleanupRan = true;
            }
            console.error("  Stopped. Re-run with --keep-going to continue through failures.\n");
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

// Tier 4 is where the DM recall lives, and tier 3 is the flakiest tier by
// this suite's own account. A tier-2 or tier-3 failure therefore strands
// every message tier 2 sent — including the ones in a REAL PERSON's chat —
// and the only trace was a quiet "not run" line in the table above, which
// reads like a skipped step rather than abandoned debris.
//
// The ledger is the evidence: tier 4 deletes it in its after(), so if it
// still exists, cleanup did not happen.
const ledger = resolve(HERE, ".artifacts.json");
const tier4Ran = results.some((r) => r.tier === 4);
if (existsSync(ledger) && !tier4Ran) {
    let pending = { messages: [] };
    try {
        pending = JSON.parse(readFileSync(ledger, "utf-8"));
    } catch {
        // A corrupt ledger still means uncleaned artifacts.
    }
    const msgs = pending.messages ?? [];
    const dmCount = targets.dm ? msgs.filter((m) => String(m.threadId) === targets.dm.threadId).length : 0;

    console.error("  !! MANUAL CLEANUP REQUIRED — tier 4 did not run, so nothing was recalled.");
    console.error(`     ${msgs.length} message(s) still sent, ${dmCount} of them in the DM (${targets.dm?.name}).`);
    console.error(
        `     Artifacts: ${(pending.polls ?? []).length} poll(s), ${(pending.reminders ?? []).length} reminder(s), ` +
            `${(pending.catalogs ?? []).length} catalog(s), ${(pending.quickMsgs ?? []).length} quick message(s).`,
    );
    console.error(`     Ledger: ${ledger}`);
    console.error("     Recover with:  node tests/run-e2e.js --tier 4\n");
}

process.exit(failed ? 1 : 0);
