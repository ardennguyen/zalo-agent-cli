/**
 * Live E2E harness — session probing, tier gating, and the small set of
 * write helpers the destructive tiers share.
 *
 * Tier gating (see tests/README.md for the full rationale):
 *
 *   ZALO_TEST_LIVE=1          tiers 1–4 may run at all
 *   ZALO_TEST_DESTRUCTIVE=1   tier 5a/5b (group disperse+recreate, history wipe)
 *   ZALO_TEST_END_SESSION=1   tier 5c/5d (real logout / purge — needs a QR re-scan)
 *
 * Each flag is strictly additive, so a bare `npm test` can never reach a
 * network call, and a bare `npm run test:e2e` can never end the session.
 */

import { runCli, runJson, hasSuccess, errorLineOf } from "./cli.js";
import { loadTargets, assertDisposable } from "./targets.js";

export { assertDisposable, loadTargets };

/** Unique-ish tag stamped into every message this suite sends. */
export const TAG = "[zalo-agent-cli e2e]";

/** A label that makes a sent message obviously test traffic and traceable. */
export function mark(what) {
    return `${TAG} ${what} · ${new Date().toISOString()}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flag = (name) => process.env[name] === "1" || process.env[name] === "true";

export const LIVE = flag("ZALO_TEST_LIVE");
export const DESTRUCTIVE = flag("ZALO_TEST_DESTRUCTIVE");
export const END_SESSION = flag("ZALO_TEST_END_SESSION");

/**
 * Resolve the gate + target state for a tier. Suites call this at the top
 * and pass `skipReason` into node:test's `{ skip }` option.
 *
 * @param {1|2|3|4|5} tier
 * @returns {{run:boolean, skipReason?:string, targets?:object, home?:string}}
 */
export function gate(tier) {
    if (!LIVE) return { run: false, skipReason: "ZALO_TEST_LIVE=1 not set (offline run)" };

    const { configured, reason, targets } = loadTargets();
    if (!configured) return { run: false, skipReason: `targets not configured: ${reason}` };

    if (tier >= 5 && !DESTRUCTIVE) {
        return { run: false, skipReason: "tier 5 needs ZALO_TEST_DESTRUCTIVE=1", targets, home: targets.home };
    }
    return { run: true, targets, home: targets.home };
}

/** Options bundle for runCli/runJson pointed at the live config home. */
export function live(targets, extra = {}) {
    return { home: targets.home, timeout: 120_000, ...extra };
}

/**
 * Confirm the stored credential still authenticates.
 * @returns {Promise<{ok:boolean, ownId?:string, reason?:string}>}
 */
export async function probeSession(targets) {
    const r = await runJson(["status"], live(targets, { timeout: 90_000 }));
    if (!r.ok) return { ok: false, reason: r.error };
    if (!r.data?.loggedIn) return { ok: false, reason: "status reports loggedIn:false — credential is dead" };
    if (String(r.data.ownId) !== targets.accountOwnId) {
        return {
            ok: false,
            reason: `logged in as ${r.data.ownId} but targets.json expects ${targets.accountOwnId}`,
        };
    }
    return { ok: true, ownId: String(r.data.ownId) };
}

/**
 * Transient failures that say nothing about the CLI. Zalo's unofficial
 * endpoints intermittently answer 5xx/404 or drop a connection; retrying a
 * READ smooths that out without hiding real breakage, because a genuinely
 * retired endpoint (`friend online`) fails every attempt.
 */
const TRANSIENT = /status code (404|429|5\d\d)|ECONNRESET|ETIMEDOUT|socket hang up|network|timeout/i;

/**
 * Retry a read-only `runJson`-shaped call while it fails transiently.
 *
 * NEVER wrap a write in this — a retried send delivers the message twice.
 *
 * @param {() => Promise<{ok:boolean, error?:string}>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]
 * @param {number} [opts.delay=1500] - ms between attempts
 */
export async function retryRead(fn, { attempts = 3, delay = 1500 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
        last = await fn();
        if (last.ok) return last;
        if (!TRANSIENT.test(last.error || "")) return last; // a real failure — surface it now
        if (i < attempts - 1) await sleep(delay * (i + 1));
    }
    return { ...last, error: `${last.error} (after ${attempts} attempts)` };
}

// ---------------------------------------------------------------------------
// Write helpers. Every one of these asserts the target is disposable first.
// ---------------------------------------------------------------------------

/**
 * Send a text message to a disposable thread.
 * @returns {Promise<{msgId:string, cliMsgId:string}>}
 */
export async function send(targets, thread, text, extraArgs = []) {
    assertDisposable(thread.threadId, "msg send");
    const r = await runJson(
        ["msg", "send", "-t", String(thread.type), thread.threadId, text, ...extraArgs],
        live(targets),
    );
    if (!r.ok) throw new Error(`send failed: ${r.error}`);
    const msgId = r.data?.message?.msgId;
    if (!msgId) throw new Error(`send returned no msgId: ${JSON.stringify(r.data)}`);
    return { msgId: String(msgId), cliMsgId: String(r.data.cliMsgId), raw: r.data };
}

/** Delete a message (one-sided). */
export async function deleteMsg(targets, thread, msgId) {
    assertDisposable(thread.threadId, "msg delete");
    return runCli(["msg", "delete", "-t", String(thread.type), msgId, thread.threadId], live(targets));
}

/** Recall a message for both sides. Requires the cliMsgId from send(). */
export async function undoMsg(targets, thread, msgId, cliMsgId) {
    assertDisposable(thread.threadId, "msg undo");
    return runCli(["msg", "undo", "-t", String(thread.type), "-c", cliMsgId, msgId, thread.threadId], live(targets));
}

/**
 * Best-effort cleanup used by `after()` hooks: recall everything in `ledger`
 * and swallow failures, so a cleanup problem never masks the real assertion.
 * @param {Array<{msgId:string, cliMsgId:string, thread:object}>} ledger
 */
export async function recallAll(targets, ledger) {
    const results = [];
    for (const entry of ledger) {
        try {
            const r = await undoMsg(targets, entry.thread, entry.msgId, entry.cliMsgId);
            results.push({ msgId: entry.msgId, recalled: hasSuccess(r.stdout), note: errorLineOf(r.stdout) });
        } catch (e) {
            results.push({ msgId: entry.msgId, recalled: false, note: e.message });
        }
    }
    return results;
}

/** Shared mutable ledger so a suite's `after()` can always find what it sent. */
export function makeLedger() {
    const entries = [];
    return {
        entries,
        track(thread, sent) {
            entries.push({ thread, msgId: sent.msgId, cliMsgId: sent.cliMsgId });
            return sent;
        },
    };
}
