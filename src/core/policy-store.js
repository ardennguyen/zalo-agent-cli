/**
 * The runtime policy store: what a deployment may change while the server runs (confirmMode, hiddenChats, approval,
 * media delivery and links, webhooks, quotas, retention), kept apart from the files and the environment that are read
 * once at start.
 *
 * - **Files.** One per account, `<accountDir>/policy.json`, and one per tenant, `<configDir>/tenants/<tenantId>.json`
 *   (a tenant is a group of accounts: `quota.tenant.accounts`). Each is `{rev, updatedAt, updatedBy, policy}`, sealed
 *   under the boot key (src/core/keystore), so it opens without a login. A tenant's files share the keyring of
 *   `<configDir>/tenants/`.
 * - **Layers.** defaults < files < environment < policy; within the policy, a tenant's (in tenant id order) under the
 *   account's own. The resolvers read it through ./policy-layer.js on every call.
 * - **Writers.** The admin API on the MCP HTTP server (src/core/admin-api.js), `zalo-agent policy set|unset` (through
 *   the daemon's channel when one runs, else the file), and a file drop: a config-management tool writes the file as
 *   plain JSON; the watcher of a running daemon (debounced) checks it and seals it, or rejects it, keeps the last good
 *   policy and saves the rejected text beside it as `policy.json.rejected`.
 * - **Revisions.** Every change raises `rev`. A writer may name the rev it read (`If-Match`): a different one is a
 *   conflict and nothing is written.
 * - **Audit.** `<configDir>/policy-audit.log`, one JSON line per change or refusal: when, who, which file, which keys,
 *   the old and new rev. Never a value: a webhook URL can carry a token.
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    watch,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "./credentials.js";
import { isSealed, openBuffer, scopeOfDir, writeSealedJson } from "./keystore/index.js";
import { setPolicyProvider } from "./policy-layer.js";
import { changedKeys, flattenPolicy, mergePolicy, policyGet, validatePolicy } from "./policy-schema.js";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";

/** The account's policy file. */
export const POLICY_FILE = "policy.json";
const SPEC = Object.freeze({ kind: "policy", use: "boot" });
// `keyring` is the tenants' folder's own keyring.json (src/core/keystore/keyring.js), never a tenant.
const TENANT_ID = /^(?!keyring$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;

/** A policy write that could not be done: `code` is INVALID, RESTART_REQUIRED, CONFLICT, NOT_FOUND or BUSY. */
export class PolicyError extends Error {
    /**
     * @param {string} message
     * @param {string} code
     * @param {object} [details]
     */
    constructor(message, code, details = {}) {
        super(message);
        this.name = "PolicyError";
        this.code = code;
        this.details = details;
        Object.assign(this, details);
    }
}

/** @returns {string} */
export function tenantsDir() {
    return join(CONFIG_DIR, "tenants");
}

/** @returns {string} */
export function policyAuditFile() {
    return join(CONFIG_DIR, "policy-audit.log");
}

/**
 * Check a policy target and name its file.
 *
 * @param {{kind: "account"|"tenant", id: string}} target
 * @returns {{kind: string, id: string, file: string, dir: string, label: string}}
 */
export function resolveTarget(target) {
    const kind = target?.kind === "tenant" ? "tenant" : "account";
    const id = String(target?.id ?? "").trim();
    if (kind === "tenant") {
        if (!TENANT_ID.test(id))
            throw new PolicyError(`"${id}" is not a tenant id (letters, digits, - and _)`, "INVALID");
        return { kind, id, dir: tenantsDir(), file: join(tenantsDir(), `${id}.json`), label: `tenant:${id}` };
    }
    if (!ACCOUNT_ID.test(id)) throw new PolicyError(`"${id}" is not an account id`, "INVALID");
    const dir = getAccountDir(id);
    return { kind, id, dir, file: join(dir, POLICY_FILE), label: `account:${id}` };
}

/** A dropped (plain JSON) document: `{policy, rev?}`, or the policy object itself. */
function droppedDoc(text, file) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new PolicyError(`${file} is not valid JSON (${e.message})`, "INVALID", { errors: [] });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new PolicyError(`${file} must hold a JSON object`, "INVALID", { errors: [] });
    const policy = parsed.policy && typeof parsed.policy === "object" ? parsed.policy : parsed;
    const rev = Number.isInteger(parsed.rev) && parsed.policy ? parsed.rev : null;
    return { policy, rev };
}

/**
 * Read one policy file. A sealed file is opened; a plain one (a file drop) is checked and, when valid, sealed in place
 * with the next rev. An invalid drop throws INVALID and is left as it is for the caller.
 *
 * @param {{kind: string, id: string, file: string, dir: string}} t - from {@link resolveTarget}
 * @param {{lastRev?: number}} [opts] - the rev known before the drop (the next one is above it)
 * @returns {{rev: number, updatedAt: string|null, updatedBy: string|null, policy: object, dropped?: boolean}|null}
 */
export function readPolicyFile(t, { lastRev = 0 } = {}) {
    let bytes;
    try {
        bytes = readFileSync(t.file);
    } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
    }
    if (isSealed(bytes)) {
        const doc = JSON.parse(openBuffer(scopeOfDir(t.dir), SPEC, bytes).toString("utf8"));
        return {
            rev: Number(doc.rev) || 0,
            updatedAt: doc.updatedAt ?? null,
            updatedBy: doc.updatedBy ?? null,
            policy: doc.policy ?? {},
        };
    }
    const drop = droppedDoc(bytes.toString("utf8"), t.file);
    const v = validatePolicy(drop.policy, { scope: t.kind });
    if (v.errors.length || v.restartRequired.length) {
        throw new PolicyError(`${t.file} was not taken: ${describeProblems(v)}`, "INVALID", {
            errors: v.errors,
            restartRequired: v.restartRequired,
        });
    }
    const doc = {
        rev: Math.max(lastRev + 1, drop.rev ?? 0, 1),
        updatedAt: new Date().toISOString(),
        updatedBy: "file",
        policy: v.policy,
    };
    writeSealedJson(t.file, scopeOfDir(t.dir), SPEC, doc);
    return { ...doc, dropped: true };
}

/** One line naming what is wrong with a policy. */
export function describeProblems({ errors = [], restartRequired = [] }) {
    const parts = errors.map((e) => (e.key ? `${e.key} ${e.error}` : e.error));
    if (restartRequired.length)
        parts.push(`${restartRequired.join(", ")} cannot change while the server runs (restartRequired)`);
    return parts.join("; ");
}

// ── The live registry ──────────────────────────────────────────────────────────────────────────────────────────────

/** ownId -> the account's document (null: none) */
const accounts = new Map();
/** tenantId -> document; null until loaded */
let tenants = null;
const listeners = new Set();
const warned = new Set();

function warnOnce(key, line) {
    if (warned.has(key)) return;
    warned.add(key);
    console.error(line);
}

/** Load every tenant's file (once, or again with `force`). */
function loadTenants({ strict = false, force = false } = {}) {
    if (tenants && !force) return tenants;
    const next = new Map();
    let names = [];
    try {
        names = readdirSync(tenantsDir()).filter((f) => f.endsWith(".json"));
    } catch {
        /* no tenants */
    }
    for (const name of names.sort()) {
        const id = name.slice(0, -5);
        if (!TENANT_ID.test(id)) continue;
        try {
            const t = resolveTarget({ kind: "tenant", id });
            const doc = readPolicyFile(t, { lastRev: tenants?.get(id)?.rev ?? 0 });
            if (doc) next.set(id, doc);
        } catch (e) {
            if (strict) throw e;
            const keep = tenants?.get(id);
            if (keep) next.set(id, keep);
            warnOnce(`tenant:${id}:${e.message}`, `[policy] tenant ${id}: ${e.message}`);
        }
    }
    tenants = next;
    return tenants;
}

/** Load one account's file (once, or again with `force`). */
function loadAccount(ownId, { strict = false, force = false } = {}) {
    if (accounts.has(ownId) && !force) return accounts.get(ownId);
    const t = resolveTarget({ kind: "account", id: ownId });
    try {
        const doc = readPolicyFile(t, { lastRev: accounts.get(ownId)?.rev ?? 0 });
        accounts.set(ownId, doc);
        return doc;
    } catch (e) {
        if (strict) throw e;
        warnOnce(`account:${ownId}:${e.message}`, `[policy] account ${ownId}: ${e.message}`);
        if (!accounts.has(ownId)) accounts.set(ownId, null);
        return accounts.get(ownId);
    }
}

/**
 * The tenants an account belongs to (`quota.tenant.accounts`), in id order.
 *
 * @param {string} ownId
 * @returns {Array<{id: string, rev: number, policy: object}>}
 */
export function tenantsOf(ownId) {
    const out = [];
    for (const [id, doc] of loadTenants()) {
        const members = policyGet(doc.policy, "quota.tenant.accounts");
        if (Array.isArray(members) && members.includes(String(ownId)))
            out.push({ id, rev: doc.rev, policy: doc.policy });
    }
    return out;
}

/**
 * One account's effective policy: its tenants' policies (in id order), then its own.
 *
 * @param {string} ownId
 * @returns {object}
 */
export function effectivePolicy(ownId) {
    const id = String(ownId);
    let merged = {};
    const mine = tenantsOf(id);
    if (mine.length > 1)
        warnOnce(
            `multi:${id}`,
            `[policy] account ${id} is listed by ${mine.length} tenants (${mine.map((t) => t.id).join(", ")}); the later ones win`,
        );
    for (const t of mine) merged = mergePolicy(merged, t.policy);
    const own = loadAccount(id);
    if (own) merged = mergePolicy(merged, own.policy);
    return merged;
}

setPolicyProvider((ownId) => {
    const p = effectivePolicy(ownId);
    return Object.keys(p).length ? p : null;
});

/**
 * Load an account's policy and every tenant's now, failing on a file that cannot be used (a daemon's start: a policy
 * it cannot read is never silently replaced by the defaults).
 *
 * @param {string} ownId
 * @returns {{account: object|null, tenants: string[]}}
 */
export function loadPoliciesStrict(ownId) {
    loadTenants({ strict: true, force: true });
    const account = loadAccount(String(ownId), { strict: true, force: true });
    return { account, tenants: tenantsOf(ownId).map((t) => t.id) };
}

/**
 * One target's document as it is now (read from disk, not the cache).
 *
 * @param {{kind: "account"|"tenant", id: string}} target
 * @returns {{rev: number, updatedAt: string|null, updatedBy: string|null, policy: object}}
 */
export function getPolicy(target) {
    const t = resolveTarget(target);
    const cached = t.kind === "tenant" ? tenants?.get(t.id) : accounts.get(t.id);
    const doc = readPolicyFile(t, { lastRev: cached?.rev ?? 0 });
    return doc ?? { rev: 0, updatedAt: null, updatedBy: null, policy: {} };
}

/**
 * Be told of every applied change (from any writer in this process, and from the watcher).
 *
 * @param {(change: {target: string, kind: string, id: string, rev: number, changed: string[], accounts: string[]}) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onPolicyChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit(change) {
    for (const fn of listeners) {
        try {
            fn(change);
        } catch (e) {
            console.error(`[policy] a change hook failed: ${e.message}`);
        }
    }
}

/** The accounts a change to one target reaches. */
function reachedAccounts(t, before, after) {
    if (t.kind === "account") return [t.id];
    const ids = new Set();
    for (const doc of [before, after]) {
        const m = policyGet(doc?.policy, "quota.tenant.accounts");
        if (Array.isArray(m)) for (const id of m) ids.add(String(id));
    }
    return [...ids].sort();
}

/**
 * Append one line to the audit log. Keys and revs only: never a value.
 *
 * @param {object} entry
 */
export function audit(entry) {
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        appendFileSync(policyAuditFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", {
            mode: 0o600,
        });
    } catch (e) {
        console.error(`[policy] the audit log could not be written: ${e.message}`);
    }
}

/** A short exclusive lock on one policy file, across processes. */
function withFileLock(file, fn) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
            break;
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
            try {
                if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
            } catch {
                /* gone meanwhile */
            }
            if (Date.now() > deadline)
                throw new PolicyError(`${file} is being changed by another writer; try again`, "BUSY");
            const until = Date.now() + 20;
            while (Date.now() < until) {
                /* a short spin: writes are rare and take milliseconds */
            }
        }
    }
    try {
        return fn();
    } finally {
        rmSync(lock, { force: true });
    }
}

/**
 * Change one target's policy: validate, check the rev, write it sealed, swap the live copy, run the hooks, audit.
 *
 * @param {object} args
 * @param {{kind: "account"|"tenant", id: string}} args.target
 * @param {"put"|"patch"} args.op - put replaces the whole policy; patch is a JSON merge patch (null removes a key)
 * @param {object} args.policy - the new policy, or the patch
 * @param {number|string|null} [args.ifMatch] - the rev the writer read; another rev is a CONFLICT
 * @param {string} args.actor - who, for the audit log (`admin-api`, `cli`, …), never a credential
 * @returns {{target: string, rev: number, oldRev: number, changed: string[], policy: object, accounts: string[]}}
 * @throws {PolicyError}
 */
export function applyPolicy({ target, op, policy, ifMatch = null, actor }) {
    const t = resolveTarget(target);
    const v = validatePolicy(policy, { scope: t.kind, allowNull: op === "patch" });
    const keys = Object.keys(flattenPolicy(policy && typeof policy === "object" ? policy : {})).sort();
    if (v.errors.length || v.restartRequired.length) {
        const restart = v.restartRequired.length && !v.errors.length;
        audit({ actor, target: t.label, op, keys, result: restart ? "restartRequired" : "invalid" });
        throw new PolicyError(describeProblems(v), restart ? "RESTART_REQUIRED" : "INVALID", {
            errors: v.errors,
            restartRequired: v.restartRequired,
        });
    }
    if (t.kind === "account" && !existsSync(t.dir)) {
        throw new PolicyError(`account ${t.id} has no folder on this host`, "NOT_FOUND");
    }
    mkdirSync(t.dir, { recursive: true });
    return withFileLock(t.file, () => {
        const cached = t.kind === "tenant" ? tenants?.get(t.id) : accounts.get(t.id);
        const before = readPolicyFile(t, { lastRev: cached?.rev ?? 0 }) ?? { rev: 0, policy: {} };
        const wanted =
            ifMatch === null || ifMatch === undefined || ifMatch === "" || ifMatch === "*"
                ? null
                : Number(String(ifMatch).replace(/"/g, ""));
        if (wanted !== null && wanted !== before.rev) {
            audit({ actor, target: t.label, op, keys, oldRev: before.rev, result: "conflict" });
            throw new PolicyError(`the policy is at rev ${before.rev}, not ${ifMatch}: read it again`, "CONFLICT", {
                rev: before.rev,
            });
        }
        const next = op === "put" ? v.policy : mergePolicy(before.policy, v.policy);
        const changed = changedKeys(before.policy, next);
        if (!changed.length)
            return {
                target: t.label,
                rev: before.rev,
                oldRev: before.rev,
                changed,
                policy: before.policy,
                accounts: [],
            };
        const doc = { rev: before.rev + 1, updatedAt: new Date().toISOString(), updatedBy: actor, policy: next };
        writeSealedJson(t.file, scopeOfDir(t.dir), SPEC, doc);
        if (t.kind === "tenant") loadTenants().set(t.id, doc);
        else accounts.set(t.id, doc);
        const reached = reachedAccounts(t, before, doc);
        audit({ actor, target: t.label, op, keys: changed, oldRev: before.rev, newRev: doc.rev, result: "applied" });
        emit({ target: t.label, kind: t.kind, id: t.id, rev: doc.rev, changed, accounts: reached });
        return { target: t.label, rev: doc.rev, oldRev: before.rev, changed, policy: next, accounts: reached };
    });
}

/**
 * Re-read one file after it changed on disk (the watcher): a sealed file another writer wrote, or a drop. A drop that
 * does not validate is moved to `<file>.rejected`, the last good policy is written back, and nothing changes.
 *
 * @param {{kind: "account"|"tenant", id: string}} target
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {{applied: boolean, rejected?: boolean, rev?: number, changed?: string[]}}
 */
export function reloadPolicy(target, { log = (l) => console.error(l) } = {}) {
    const t = resolveTarget(target);
    const cache = t.kind === "tenant" ? loadTenants() : accounts;
    const before = cache.get(t.id) ?? null;
    let doc;
    try {
        doc = readPolicyFile(t, { lastRev: before?.rev ?? 0 });
    } catch (e) {
        if (!(e instanceof PolicyError)) {
            log(`[policy] ${t.file} could not be read (${e.message}); the last good policy stays`);
            return { applied: false, rejected: true };
        }
        try {
            renameSync(t.file, `${t.file}.rejected`);
            if (before) writeSealedJson(t.file, scopeOfDir(t.dir), SPEC, before);
        } catch (err) {
            log(`[policy] could not set the rejected file aside: ${err.message}`);
        }
        audit({ actor: "file", target: t.label, op: "drop", result: "invalid" });
        log(
            `[policy] ${e.message}. The last good policy stays (rev ${before?.rev ?? 0}); the file is kept as ${t.file}.rejected`,
        );
        return { applied: false, rejected: true };
    }
    if ((doc?.rev ?? 0) === (before?.rev ?? 0) && !doc?.dropped) return { applied: false };
    if (doc) cache.set(t.id, doc);
    else cache.delete(t.id);
    const changed = changedKeys(before?.policy ?? {}, doc?.policy ?? {});
    const reached = reachedAccounts(t, before, doc);
    audit({
        actor: "file",
        target: t.label,
        op: doc ? "drop" : "remove",
        keys: changed,
        oldRev: before?.rev ?? 0,
        newRev: doc?.rev ?? 0,
        result: "applied",
    });
    if (changed.length) {
        log(`[policy] ${t.label} rev ${doc?.rev ?? 0} from a file: ${changed.join(", ")}`);
        emit({ target: t.label, kind: t.kind, id: t.id, rev: doc?.rev ?? 0, changed, accounts: reached });
    }
    return { applied: true, rev: doc?.rev ?? 0, changed };
}

/**
 * Watch one account's policy file and the tenants' folder for drops and other writers (a daemon). Debounced.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {(line: string) => void} [args.log]
 * @param {number} [args.debounceMs]
 * @returns {{stop: () => void}}
 */
export function watchPolicies({ ownId, log = (l) => console.error(l), debounceMs = 500 }) {
    const timers = new Map();
    const watchers = [];
    const later = (key, target) => {
        clearTimeout(timers.get(key));
        const timer = setTimeout(() => {
            timers.delete(key);
            reloadPolicy(target, { log });
        }, debounceMs);
        timer.unref?.();
        timers.set(key, timer);
    };
    const account = resolveTarget({ kind: "account", id: ownId });
    for (const [dir, onName] of [
        [account.dir, (name) => name === POLICY_FILE && later("account", { kind: "account", id: ownId })],
        [
            tenantsDir(),
            (name) => {
                const id = name.endsWith(".json") ? name.slice(0, -5) : "";
                if (TENANT_ID.test(id)) later(`tenant:${id}`, { kind: "tenant", id });
            },
        ],
    ]) {
        try {
            mkdirSync(dir, { recursive: true });
            const w = watch(dir, { persistent: false }, (_event, name) => name && onName(String(name)));
            w.on("error", () => {});
            watchers.push(w);
        } catch (e) {
            log(`[policy] cannot watch ${dir} (${e.message}): file drops there are picked up at the next start`);
        }
    }
    return {
        stop() {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
            for (const w of watchers) w.close();
        },
    };
}

/** Forget every cached policy (tests). */
export function resetPolicyCache() {
    accounts.clear();
    tenants = null;
    warned.clear();
}

/**
 * Write a policy as a config-management tool would (plain JSON, atomic). For tests and the docs' examples.
 *
 * @param {string} file
 * @param {object} policy
 */
export function dropPolicyFile(file, policy) {
    writeFileAtomic(file, JSON.stringify({ policy }, null, 2));
}

/**
 * What a daemon runs: the account's and the tenants' policies loaded now (a file that cannot be used stops the start),
 * the watcher for drops, and one hook for every change that reaches this account.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {(changed: string[], change: object) => void} [args.onChange]
 * @param {(line: string) => void} [args.log]
 * @returns {{stop: () => void, describe: () => string}}
 * @throws {PolicyError} when a policy file is invalid
 */
export function startPolicyRuntime({ ownId, onChange, log = (l) => console.error(l) }) {
    const loaded = loadPoliciesStrict(ownId);
    const watcher = watchPolicies({ ownId, log });
    const off = onPolicyChange((change) => {
        if (!change.accounts.includes(String(ownId))) return;
        onChange?.(change.changed, change);
    });
    return {
        stop() {
            watcher.stop();
            off();
        },
        describe: () =>
            `account rev ${loaded.account?.rev ?? 0}` +
            (loaded.tenants.length ? `, tenant(s) ${loaded.tenants.join(", ")}` : ""),
    };
}

/**
 * Whether a change names any of these keys or a key under them (`media` covers `media.linkAuth`).
 *
 * @param {string[]} changed
 * @param {string[]} prefixes
 * @returns {boolean}
 */
export function touches(changed, prefixes) {
    return changed.some((k) => prefixes.some((p) => k === p || k.startsWith(`${p}.`)));
}

/**
 * The daemon side of `policy set|unset` over the daemon channel.
 *
 * @param {{target: {kind: string, id: string}, op: string, policy: object, ifMatch?: unknown}} params
 * @returns {object}
 */
export function servePolicyRequest(params) {
    const op = params?.op === "put" ? "put" : "patch";
    return applyPolicy({
        target: params?.target,
        op,
        policy: params?.policy,
        ifMatch: params?.ifMatch ?? null,
        actor: "cli via daemon",
    });
}
