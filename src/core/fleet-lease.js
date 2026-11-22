/**
 * Leased mode: an engine of a pool runs an account only while it holds that account's lease.
 *
 * Several engines can see the same account folders (shared storage), and a Zalo login permits one client. Whoever
 * hands out the leases (a host agent that asks a control plane) writes them into one file per engine; this module is
 * the engine's side of it. Nothing here talks to the network.
 *
 *     ZALO_FLEET_LEASE_FILE=<path>        set: leased mode (unset: everything runs as before, nothing here applies)
 *     ZALO_FLEET_LEASE_STATE_FILE=<path>  where the fleet controller says what runs here (optional)
 *
 * The lease file (written by the lease client only, replaced atomically):
 *
 *     {"kind": "zalo-fleet-leases", "v": 1, "holder": "engine-2", "at": "<ISO>",
 *      "accounts": {"<ownId>": {"token": 8, "deadline": "<ISO>"}}}
 *
 * `deadline` is in this host's clock and already leaves the lease client's margin: by then the account is stopped here.
 * The writer computes it from the moment it SENT its renewal, so the lease cannot have run out elsewhere first. A file
 * that is missing, unreadable or of another shape holds no lease; an account it does not list has none here.
 *
 * The rules:
 * - The fleet controller ({@link createLeaseReconciler}) starts the accounts with a valid lease and stops the others
 *   {@link START_LEAD_MS} before their deadline at the latest; it writes the state file.
 * - Every account daemon ({@link createLeaseGuard}) takes its token from the file at start, refuses to log in without
 *   a valid lease, claims the account's fence file, and checks every second: its entry gone, its token changed, its
 *   deadline reached (also when the file can no longer be read: the last deadline stands), or a higher token in the
 *   fence -> it stops at once and exits with {@link EXIT_CODE}.LEASE_LOST, which its unit does not restart.
 * - Every saved-login session ({@link assertLeaseHeld}, called by the login paths) is refused without a valid lease.
 * - Actions (tool calls, daemon-channel requests, the listener's and the outbox's writes) are refused once the guard
 *   has tripped or the deadline passed ({@link assertLeaseCurrent}: a clock check, no I/O).
 *
 * The fence file (`accounts/<ownId>/lease-fence.json`, `{"token": 8, "holder": "engine-2", "at": "<ISO>"}`) is on the
 * shared account folder: a daemon whose token is lower than the fence never starts, and a running one that sees a
 * higher token stops. Tokens only grow (the lease service never reuses one).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { EXIT_CODE } from "./exit-codes.js";

export const LEASE_FILE_ENV = "ZALO_FLEET_LEASE_FILE";
export const LEASE_STATE_FILE_ENV = "ZALO_FLEET_LEASE_STATE_FILE";
export const LEASES_KIND = "zalo-fleet-leases";
export const LEASE_STATE_KIND = "zalo-fleet-lease-state";
export const FENCE_FILE = "lease-fence.json";

/** The controller stops an account this long before its deadline at the latest, and starts one only before that. */
export const START_LEAD_MS = 5000;
/** How often a daemon's guard and the controller's reconcile look. */
export const GUARD_INTERVAL_MS = 1000;
/** The controller asks its supervisor again after this long (its own starts and stops update it at once). */
export const STATUS_REFRESH_MS = 5000;
/** The controller writes the state file at least this often. */
export const STATE_EVERY_MS = 2000;

const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;
const HOLDER = /^[A-Za-z0-9._-]{1,64}$/;

/** A refusal of leased mode: `.code` is LEASE_NOT_HELD, LEASE_FENCED or LEASE_LOST. */
export class LeaseError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "LeaseError";
        this.code = code;
        this.exitCode = EXIT_CODE.LEASE_LOST;
    }
}

/**
 * The lease file of this process, or null outside leased mode.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function leaseFileOf(env = process.env) {
    const v = String(env[LEASE_FILE_ENV] ?? "").trim();
    return v || null;
}

/**
 * Whether this process runs in leased mode.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function leasedMode(env = process.env) {
    return leaseFileOf(env) !== null;
}

/**
 * Parse a lease file's text; null for anything that is not one.
 *
 * @param {string} text
 * @returns {{holder: string|null, at: string|null, accounts: Map<string, {token: number, deadlineMs: number}>}|null}
 */
export function parseLeases(text) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return null;
    }
    if (!doc || typeof doc !== "object" || doc.kind !== LEASES_KIND || doc.v !== 1) return null;
    if (!doc.accounts || typeof doc.accounts !== "object" || Array.isArray(doc.accounts)) return null;
    const accounts = new Map();
    for (const [id, l] of Object.entries(doc.accounts)) {
        if (!ACCOUNT_ID.test(id) || !l || typeof l !== "object") continue;
        const token = l.token;
        const deadlineMs = typeof l.deadline === "string" ? Date.parse(l.deadline) : NaN;
        if (!Number.isSafeInteger(token) || token < 1 || !Number.isFinite(deadlineMs)) continue;
        accounts.set(id, { token, deadlineMs });
    }
    const holder = typeof doc.holder === "string" && HOLDER.test(doc.holder) ? doc.holder : null;
    return { holder, at: typeof doc.at === "string" ? doc.at : null, accounts };
}

/**
 * Read the lease file; null when it is missing, unreadable or not a lease file.
 *
 * @param {string} file
 * @param {{readFile?: (file: string) => string}} [o]
 * @returns {ReturnType<typeof parseLeases>}
 */
export function readLeases(file, { readFile = (f) => readFileSync(f, "utf8") } = {}) {
    try {
        return parseLeases(readFile(file));
    } catch {
        return null;
    }
}

/**
 * The account's lease when it is valid at `now` with `leadMs` to spare, else null.
 *
 * @param {ReturnType<typeof parseLeases>} leases
 * @param {string} ownId
 * @param {number} now
 * @param {number} [leadMs]
 * @returns {{token: number, deadlineMs: number}|null}
 */
export function validLease(leases, ownId, now, leadMs = 0) {
    const l = leases?.accounts.get(String(ownId));
    return l && now < l.deadlineMs - leadMs ? l : null;
}

/**
 * The account's fence, or null when there is none (or it cannot be read).
 *
 * @param {string} accountDir
 * @returns {{token: number, holder: string|null, at: string|null}|null}
 */
export function readFence(accountDir) {
    const file = join(accountDir, FENCE_FILE);
    if (!existsSync(file)) return null;
    try {
        const f = JSON.parse(readFileSync(file, "utf8"));
        return Number.isSafeInteger(f?.token) && f.token > 0
            ? { token: f.token, holder: typeof f.holder === "string" ? f.holder : null, at: f.at ?? null }
            : null;
    } catch {
        return null;
    }
}

/**
 * Claim the account for `token`: refused (LEASE_FENCED) when the fence holds a higher one; the fence is raised to
 * `token` when it is lower or absent.
 *
 * @param {string} accountDir
 * @param {number} token
 * @param {string|null} holder
 * @param {{now?: () => number}} [o]
 */
export function claimFence(accountDir, token, holder, { now = Date.now } = {}) {
    const fence = readFence(accountDir);
    if (fence && fence.token > token) {
        throw new LeaseError(
            `a newer lease (${fence.token}${fence.holder ? `, ${fence.holder}` : ""}) holds this account; this one ` +
                `(${token}) is stale`,
            "LEASE_FENCED",
        );
    }
    if (fence && fence.token === token) return;
    writeFileAtomic(
        join(accountDir, FENCE_FILE),
        JSON.stringify({ token, holder: holder ?? null, at: new Date(now()).toISOString() }) + "\n",
        { mode: 0o600 },
    );
}

/**
 * In leased mode, the account's valid lease (and its fence not above it); throws LEASE_NOT_HELD / LEASE_FENCED.
 * Outside leased mode it returns null and checks nothing.
 *
 * @param {string} ownId
 * @param {{env?: NodeJS.ProcessEnv, now?: () => number, accountDir?: string|null, readFile?: Function}} [o]
 * @returns {{token: number, deadlineMs: number, holder: string|null}|null}
 */
export function assertLeaseHeld(ownId, { env = process.env, now = Date.now, accountDir = null, readFile } = {}) {
    const file = leaseFileOf(env);
    if (!file) return null;
    const leases = readLeases(file, readFile ? { readFile } : {});
    const l = validLease(leases, ownId, now());
    if (!l) {
        throw new LeaseError(
            `this engine holds no lease for account ${ownId} (leased mode, ${LEASE_FILE_ENV}): another engine of the ` +
                "pool may run it; a session here would be a second client",
            "LEASE_NOT_HELD",
        );
    }
    const fence = accountDir ? readFence(accountDir) : null;
    if (fence && fence.token > l.token) {
        throw new LeaseError(
            `a newer lease (${fence.token}) holds account ${ownId}; this engine's (${l.token}) is stale`,
            "LEASE_FENCED",
        );
    }
    return { ...l, holder: leases.holder };
}

/**
 * The lease guard of one account daemon. `start()` takes the token (throws when there is no valid lease or the fence
 * is higher) and claims the fence; from then on a timer checks the file and the fence, and `current()` refuses at once
 * when the guard has tripped or the deadline passed. A trip calls `onLost(reason)` once.
 *
 * @param {object} o
 * @param {string} o.ownId
 * @param {string} o.accountDir
 * @param {(reason: string) => void} o.onLost
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {() => number} [o.now]
 * @param {(file: string) => string} [o.readFile]
 * @param {number} [o.intervalMs]
 * @param {(fn: Function, ms: number) => any} [o.setInterval]
 * @param {(t: any) => void} [o.clearInterval]
 * @returns {{start: () => {token: number, deadlineMs: number}, check: () => string|null, current: () => void,
 *   stop: () => void, token: () => number|null, deadline: () => number|null, lost: () => string|null}}
 */
export function createLeaseGuard({
    ownId,
    accountDir,
    onLost,
    env = process.env,
    now = Date.now,
    readFile,
    intervalMs = GUARD_INTERVAL_MS,
    setInterval: every = setInterval,
    clearInterval: clear = clearInterval,
}) {
    const file = leaseFileOf(env);
    let token = null;
    let deadlineMs = null;
    let lostReason = null;
    let timer = null;

    function trip(reason) {
        if (lostReason) return lostReason;
        lostReason = reason;
        if (timer) clear(timer);
        timer = null;
        try {
            onLost?.(reason);
        } catch {
            /* the daemon's own exit path; nothing to add */
        }
        return reason;
    }

    function check() {
        if (lostReason) return lostReason;
        if (token === null) return null;
        const leases = readLeases(file, readFile ? { readFile } : {});
        if (leases) {
            const l = leases.accounts.get(String(ownId));
            if (!l) return trip("lease-gone");
            if (l.token !== token) return trip("token-changed");
            deadlineMs = l.deadlineMs;
        }
        // An unreadable file keeps the last deadline: it runs out by itself.
        if (now() >= deadlineMs) return trip("deadline");
        const fence = readFence(accountDir);
        if (fence && fence.token > token) return trip("fenced");
        return null;
    }

    return {
        start() {
            const held = assertLeaseHeld(ownId, { env, now, accountDir, readFile });
            if (!held) throw new LeaseError("not in leased mode", "LEASE_NOT_HELD");
            claimFence(accountDir, held.token, held.holder, { now });
            token = held.token;
            deadlineMs = held.deadlineMs;
            timer = every(check, intervalMs);
            timer?.unref?.();
            return { token, deadlineMs };
        },
        check,
        current() {
            if (!lostReason && deadlineMs !== null && now() >= deadlineMs) trip("deadline");
            if (lostReason) {
                throw new LeaseError(`this engine's lease of account ${ownId} has ended (${lostReason})`, "LEASE_LOST");
            }
        },
        stop() {
            if (timer) clear(timer);
            timer = null;
        },
        token: () => token,
        deadline: () => deadlineMs,
        lost: () => lostReason,
    };
}

let processGuard = null;

/**
 * Make `guard` the one {@link assertLeaseCurrent} consults in this process (a daemon runs one account).
 *
 * @param {ReturnType<typeof createLeaseGuard>|null} guard
 */
export function setProcessLeaseGuard(guard) {
    processGuard = guard;
}

/** Throws LEASE_LOST when this process's lease has ended; nothing outside leased mode. A clock check, no I/O. */
export function assertLeaseCurrent() {
    processGuard?.current();
}

/** Whether this process's lease has ended (false outside leased mode). */
export function leaseLost() {
    try {
        processGuard?.current();
        return false;
    } catch {
        return true;
    }
}

/**
 * Write the state file: what runs here and with which token.
 *
 * @param {string} file
 * @param {Record<string, {token: number|null, running: boolean, state: string|null}>} accounts
 * @param {{now?: () => number}} [o]
 */
export function writeLeaseState(file, accounts, { now = Date.now } = {}) {
    writeFileAtomic(
        file,
        JSON.stringify({ kind: LEASE_STATE_KIND, v: 1, at: new Date(now()).toISOString(), accounts }) + "\n",
        { mode: 0o664, durable: false },
    );
}

/**
 * The fleet controller's side of leased mode: every `intervalMs` it starts the accounts that hold a valid lease here
 * and stops the others, {@link START_LEAD_MS} before their deadline at the latest, and writes the state file.
 *
 * An account kept down after a kick (`kicked`) is not started on its own: a person decides (as without leases). A
 * start that fails waits longer each time (10 s doubling to 5 min).
 *
 * @param {object} o
 * @param {{start: Function, stop: Function, status: Function}} o.driver
 * @param {() => Array<{ownId: string}>} o.listAccounts
 * @param {() => ReturnType<typeof parseLeases>} o.readLeases
 * @param {((accounts: object) => void)|null} [o.writeState]
 * @param {(ownId: string) => boolean} [o.kicked]
 * @param {(ownId: string) => number|null} [o.fenceToken] - the token of the daemon that runs (its fence)
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.leadMs]
 * @param {number} [o.intervalMs]
 * @param {number} [o.refreshMs]
 * @returns {{tick: () => Promise<void>, start: () => void, stop: () => void, holds: (ownId: string) => boolean,
 *   view: () => object}}
 */
export function createLeaseReconciler({
    driver,
    listAccounts,
    readLeases: read,
    writeState = null,
    kicked = () => false,
    fenceToken = () => null,
    now = Date.now,
    log = () => {},
    leadMs = START_LEAD_MS,
    intervalMs = GUARD_INTERVAL_MS,
    refreshMs = STATUS_REFRESH_MS,
}) {
    const mem = new Map(); // ownId -> {running, checkedAt, token, nextStart, fails, state}
    let leases = null;
    let ticking = null;
    let timer = null;
    let lastWritten = "";
    let lastWriteAt = 0;

    const entry = (id) => {
        let e = mem.get(id);
        if (!e) {
            e = { running: null, checkedAt: 0, token: null, nextStart: 0, fails: 0, state: null };
            mem.set(id, e);
        }
        return e;
    };

    async function refresh(id, e) {
        try {
            const s = await driver.status(id);
            e.running = Boolean(s?.running);
            e.state = s?.state ?? null;
        } catch {
            e.running = e.running ?? null;
        }
        e.checkedAt = now();
        if (e.running && e.token === null) e.token = fenceToken(id);
        if (!e.running) e.token = null;
    }

    async function one(id) {
        const e = entry(id);
        const l = validLease(leases, id, now(), leadMs);
        if (e.running === null || now() - e.checkedAt >= refreshMs) await refresh(id, e);
        if (!l) {
            e.fails = 0;
            e.nextStart = 0;
            if (e.running !== false) {
                const r = await driver.stop(id);
                log(`[fleet] lease: ${id} stopped (no valid lease here): ${r?.detail ?? (r?.ok ? "ok" : "failed")}`);
                e.running = r?.ok ? false : null;
                e.state = r?.ok ? "stopped" : e.state;
                e.checkedAt = now();
                e.token = null;
            }
            return;
        }
        if (e.running) return;
        if (e.running === false && now() >= e.nextStart && !kicked(id)) {
            const r = await driver.start(id);
            e.checkedAt = now();
            if (r?.ok) {
                e.running = true;
                e.state = "started";
                e.token = l.token;
                e.fails = 0;
                log(`[fleet] lease: ${id} started (token ${l.token})`);
            } else {
                e.fails += 1;
                e.nextStart = now() + Math.min(300_000, 10_000 * 2 ** (e.fails - 1));
                log(`[fleet] lease: ${id} did not start: ${r?.detail ?? "failed"}`);
            }
        }
    }

    function stateOf() {
        const out = {};
        const ids = new Set([...mem.keys(), ...(leases?.accounts.keys() ?? [])]);
        for (const id of [...ids].sort()) {
            const e = mem.get(id);
            if (!e?.running && !leases?.accounts.has(id)) continue;
            out[id] = {
                token: e?.running ? (e.token ?? null) : null,
                running: Boolean(e?.running),
                state: e?.state ?? null,
            };
        }
        return out;
    }

    async function tick() {
        if (ticking) return ticking;
        ticking = (async () => {
            leases = read();
            const registered = new Set(listAccounts().map((a) => String(a.ownId)));
            for (const id of mem.keys()) if (!registered.has(id)) mem.delete(id);
            for (const id of registered) {
                try {
                    await one(id);
                } catch (e) {
                    log(`[fleet] lease: ${id}: ${e.message}`);
                }
            }
            if (writeState) {
                const state = stateOf();
                const text = JSON.stringify(state);
                if (text !== lastWritten || now() - lastWriteAt >= STATE_EVERY_MS) {
                    try {
                        writeState(state);
                        lastWritten = text;
                        lastWriteAt = now();
                    } catch (e) {
                        log(`[fleet] lease: the state file cannot be written: ${e.message}`);
                    }
                }
            }
        })().finally(() => {
            ticking = null;
        });
        return ticking;
    }

    return {
        tick,
        start() {
            if (timer) return;
            void tick();
            timer = setInterval(() => void tick(), intervalMs);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        /** Whether this engine holds a valid lease for the account now (read fresh). */
        holds(ownId) {
            return validLease(read(), ownId, now(), leadMs) !== null;
        },
        view: () => stateOf(),
    };
}

/**
 * A daemon's (`mcp start`, `listen`) start in leased mode, before it takes `daemon.lock` (another engine's lock in a
 * shared folder must never be taken over without the lease): the guard started, its token claimed in the fence, and
 * made the process's. Without a valid lease (or with a higher fence) it says why and exits with LEASE_LOST, as it does
 * later when the guard trips. Outside leased mode it does nothing and returns null.
 *
 * @param {object} o
 * @param {string} o.ownId
 * @param {string} o.accountDir
 * @param {(line: string) => void} o.log
 * @param {(code: number) => void} [o.exit]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @returns {{guard: ReturnType<typeof createLeaseGuard>, onRelease: (fn: () => void) => void}|null} `onRelease`: what
 *   to run before the exit (release the lock, close the channel)
 */
export function startDaemonLease({ ownId, accountDir, log, exit = (code) => process.exit(code), env = process.env }) {
    if (!leasedMode(env)) return null;
    let release = () => {};
    const guard = createLeaseGuard({
        ownId,
        accountDir,
        env,
        onLost: (reason) => {
            log(`The pool lease of account ${ownId} ended (${reason}): stopping now (exit ${EXIT_CODE.LEASE_LOST}).`);
            try {
                release();
            } catch {
                /* exiting anyway */
            }
            exit(EXIT_CODE.LEASE_LOST);
        },
    });
    try {
        const { token, deadlineMs } = guard.start();
        log(
            `Leased mode: lease ${token} of account ${ownId} until ${new Date(deadlineMs).toISOString()} (the lease client renews it).`,
        );
    } catch (e) {
        log(`Not started: ${e.code ?? "LEASE_NOT_HELD"}: ${e.message}`);
        exit(EXIT_CODE.LEASE_LOST);
        return null;
    }
    setProcessLeaseGuard(guard);
    return {
        guard,
        onRelease: (fn) => {
            release = fn;
        },
    };
}
