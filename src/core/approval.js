/**
 * What the approve page (confirmMode "human", src/core/secure-page.js) asks of the person besides a click, so that an
 * AI agent that can open a link cannot approve its own action by opening the link it was handed.
 *
 * - The approver secret is per deployment (`approval.secret`, src/core/deploy-policy.js resolveApproval):
 *   - `pin`: the account's hidden-chat PIN, checked against the hash Zalo gave this process with the PIN page's own
 *     lockout (src/core/hidden-chats.js);
 *   - `password`: the approver password, set with `mcp approver set`. Only a salted scrypt hash is kept, in
 *     `approver-secret.json` in the account folder (0600). A wrong one counts toward a lockout like the PIN's
 *     (`approver-lockout.json`: counts and times only);
 *   - `none`: a click approves (weaker: whoever opens the link can approve);
 *   - `auto` (the default): the approver password when one is set and the link travels through the agent; nothing when
 *     none is set (the reply then says `approverSecret: false`) or when the link never reaches the agent (URL-mode
 *     elicitation, or `approval.deliver: "webhook"`).
 * - Nothing typed is kept, logged, echoed or returned.
 */

import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { readSealedJson, scopeOfDir, writeSealedJson } from "./keystore/index.js";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { PIN_FREE_TRIES, pinBackoffMs, pinFailureLine } from "./hidden-chats.js";

const scrypt = promisify(scryptCb);

/** The file holding the approver password's hash, in the account folder. */
export const APPROVER_FILE = "approver-secret.json";
const LOCKOUT_FILE = "approver-lockout.json";
/** The scrypt cost: 2^15, r 8, p 1 (32 MiB, about 0.1 s). */
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });
const MAXMEM = 64 * 1024 * 1024;
/** The shortest approver password taken. */
export const APPROVER_MIN_LENGTH = 8;
const APPROVER_MAX_LENGTH = 256;

/** The approver password's hash is sealed like the other account secrets (src/core/keystore), under the boot key. */
const APPROVER_SPEC = Object.freeze({ kind: "approver-secret", use: "boot" });

function readJson(file) {
    if (file.endsWith(APPROVER_FILE)) {
        try {
            return readSealedJson(file, scopeOfDir(dirname(file)), APPROVER_SPEC);
        } catch (e) {
            if (e?.code === "ENOENT" || e instanceof SyntaxError) return null;
            throw e;
        }
    }
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function writeJson(dir, name, value) {
    mkdirSync(dir, { recursive: true });
    if (name === APPROVER_FILE) writeSealedJson(join(dir, name), scopeOfDir(dir), APPROVER_SPEC, value);
    else writeFileAtomic(join(dir, name), JSON.stringify(value), { mode: 0o600 });
}

/**
 * Why a password cannot be an approver password, or null when it can.
 *
 * @param {string} password
 * @returns {string|null}
 */
export function approverPasswordProblem(password) {
    const text = String(password ?? "");
    if (text.length < APPROVER_MIN_LENGTH)
        return `The approver password needs at least ${APPROVER_MIN_LENGTH} characters.`;
    if (text.length > APPROVER_MAX_LENGTH) return `The approver password is at most ${APPROVER_MAX_LENGTH} characters.`;
    return null;
}

/**
 * The record kept for an approver password: the scrypt parameters, the salt and the hash (base64). Never the password.
 *
 * @param {string} password
 * @param {{salt?: Buffer, now?: () => number}} [opts]
 * @returns {{v: 1, kdf: "scrypt", N: number, r: number, p: number, salt: string, hash: string, setAt: string}}
 */
export function hashApproverPassword(password, { salt = randomBytes(16), now = Date.now } = {}) {
    const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        maxmem: MAXMEM,
    });
    return {
        v: 1,
        kdf: "scrypt",
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        salt: salt.toString("base64"),
        hash: hash.toString("base64"),
        setAt: new Date(now()).toISOString(),
    };
}

/**
 * Set (or replace) the account's approver password: its hash goes to APPROVER_FILE (0600), and the lockout restarts.
 *
 * @param {string} accountDir
 * @param {string} password
 * @returns {{setAt: string}}
 */
export function setApproverPassword(accountDir, password) {
    const problem = approverPasswordProblem(password);
    if (problem) throw new Error(problem);
    const record = hashApproverPassword(password);
    writeJson(accountDir, APPROVER_FILE, record);
    rmSync(join(accountDir, LOCKOUT_FILE), { force: true });
    return { setAt: record.setAt };
}

/** The stored record, or null when no approver password is set (or the file is not one). */
function readRecord(accountDir) {
    if (!accountDir) return null;
    const r = readJson(join(accountDir, APPROVER_FILE));
    if (r?.kdf !== "scrypt" || typeof r.salt !== "string" || typeof r.hash !== "string") return null;
    return r;
}

/**
 * Whether the account has an approver password, and since when.
 *
 * @param {string|null} accountDir
 * @returns {{set: boolean, setAt: string|null}}
 */
export function approverStatus(accountDir) {
    const r = readRecord(accountDir);
    return { set: Boolean(r), setAt: r?.setAt ?? null };
}

/**
 * Remove the account's approver password.
 *
 * @param {string} accountDir
 * @returns {boolean} whether there was one
 */
export function removeApproverPassword(accountDir) {
    const had = Boolean(readRecord(accountDir));
    rmSync(join(accountDir, APPROVER_FILE), { force: true });
    rmSync(join(accountDir, LOCKOUT_FILE), { force: true });
    return had;
}

const memLockouts = new Map();

function lockoutState(accountDir) {
    const s = accountDir ? readJson(join(accountDir, LOCKOUT_FILE)) : memLockouts.get("");
    return {
        failures: Number.isInteger(s?.failures) ? s.failures : 0,
        lastFailureAt: Number.isFinite(s?.lastFailureAt) ? s.lastFailureAt : 0,
    };
}

function saveLockout(accountDir, state) {
    if (accountDir) writeJson(accountDir, LOCKOUT_FILE, state);
    else memLockouts.set("", state);
}

/**
 * Check a typed approver password, counting a wrong one toward the lockout (6 free tries, then the PIN's back-off).
 *
 * @param {string|null} accountDir
 * @param {string} typed
 * @param {{now?: () => number}} [opts]
 * @returns {Promise<{ok: true} | {ok: false, reason: "none"|"locked"|"wrong", retryAfterMs?: number, failures?: number}>}
 */
export async function verifyApproverPassword(accountDir, typed, { now = Date.now } = {}) {
    const record = readRecord(accountDir);
    if (!record) return { ok: false, reason: "none" };
    const state = lockoutState(accountDir);
    const retryAfterMs = Math.max(0, state.lastFailureAt + pinBackoffMs(state.failures) - now());
    if (retryAfterMs > 0) return { ok: false, reason: "locked", retryAfterMs, failures: state.failures };
    const expected = Buffer.from(record.hash, "base64");
    let given = Buffer.alloc(0);
    try {
        given = await scrypt(String(typed ?? ""), Buffer.from(record.salt, "base64"), expected.length, {
            N: record.N,
            r: record.r,
            p: record.p,
            maxmem: MAXMEM,
        });
    } catch {
        /* a damaged record: counts as wrong */
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
        if (state.failures) saveLockout(accountDir, { failures: 0, lastFailureAt: 0 });
        return { ok: true };
    }
    const failures = state.failures + 1;
    saveLockout(accountDir, { failures, lastFailureAt: now() });
    return { ok: false, reason: "wrong", failures, retryAfterMs: pinBackoffMs(failures) };
}

/**
 * The sentence for a failed approver-password check, with no secret in it.
 *
 * @param {{reason: string, retryAfterMs?: number, failures?: number}} r
 * @returns {string}
 */
export function approverFailureLine(r) {
    if (r.reason === "none")
        return "No approver password is set: the owner sets one with `zalo-agent mcp approver set`.";
    if (r.reason === "locked")
        return `Too many wrong passwords: try again in ${Math.ceil((r.retryAfterMs ?? 0) / 1000)} s.`;
    return (
        `Wrong approver password (${r.failures} failed${r.failures === 1 ? "" : " in a row"}).` +
        (r.failures >= PIN_FREE_TRIES && r.retryAfterMs
            ? ` Wait ${Math.ceil(r.retryAfterMs / 1000)} s before the next try.`
            : "")
    );
}

/**
 * What the approve page of one request asks besides a click.
 *
 * @param {object} opts
 * @param {"auto"|"pin"|"password"|"none"} opts.mode - approval.secret
 * @param {boolean} opts.throughAgent - the link reaches the agent (the tool result carries it)
 * @param {string|null} [opts.accountDir] - for the approver password
 * @param {(() => import("./hidden-chats.js").HiddenChats)|null} [opts.hidden] - for the PIN
 * @returns {{kind: "pin"|"password"|null, approverSecret: boolean, check?: (typed: string) => Promise<object>} | {error: string}}
 *   `check` answers `{status: "approved"|"retry"|"failed", message}`, as a secure page's onSubmit does
 */
export function approverFor({ mode = "auto", throughAgent, accountDir = null, hidden = null }) {
    let kind = mode;
    if (mode === "auto") kind = throughAgent && approverStatus(accountDir).set ? "password" : "none";
    if (kind === "none") return { kind: null, approverSecret: false };
    if (kind === "password") {
        if (!approverStatus(accountDir).set) {
            return {
                error:
                    'approval.secret is "password" but no approver password is set for this account: the owner sets ' +
                    "one with `zalo-agent mcp approver set`.",
            };
        }
        return {
            kind,
            approverSecret: true,
            check: async (typed) => {
                const r = await verifyApproverPassword(accountDir, typed);
                if (r.ok) return { status: "approved", message: "Approved. The agent can go on now." };
                return { status: r.reason === "wrong" ? "retry" : "failed", message: approverFailureLine(r) };
            },
        };
    }
    // pin
    const set = hidden?.();
    if (!set?.hasPin) {
        return {
            error:
                'approval.secret is "pin" but this account has no hidden-chat PIN this server knows of: set one ' +
                "(on the phone, or with `conv hidden-pin`), then restart the server.",
        };
    }
    return {
        kind,
        approverSecret: true,
        check: async (typed) => {
            const r = set.verifyPin(typed);
            if (r.ok) return { status: "approved", message: "Approved. The agent can go on now." };
            return { status: r.reason === "locked" ? "failed" : "retry", message: pinFailureLine(r) };
        },
    };
}
