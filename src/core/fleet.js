/**
 * Running many accounts on one machine: which port each gets, which are healthy, and the files that
 * supervise them.
 *
 * One account is one process (AGENTS.md section 13), so hundreds of accounts are hundreds of daemons, each
 * with a port, a token and a systemd unit. Until this module the only tooling was the template unit in the
 * docs: the operator kept the port table by hand, found a dead account by probing each one, and a whole
 * fleet restarting at once was the heaviest moment of its life. `zalo-agent fleet ...` (src/commands/fleet.js)
 * is built on these.
 *
 *  - The port table (`fleet.json` in the config directory) gives each account a stable port. It is
 *    assigned once and never reshuffled, so adding an account never moves another one's port.
 *  - {@link classifyAccount} turns a daemon's health snapshot into one word, the one `fleet status` shows
 *    and `fleet restart --unhealthy` acts on.
 *  - {@link planBatches} orders a start-up: shuffled, in groups, so accounts that were set up together do
 *    not all log in together.
 *  - {@link generateFleetFiles} writes the systemd unit, env files with generated tokens, and a proxy.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import { withFileLock, writeFileAtomic } from "../utils/atomic-file.js";
import { COMMON_ENV_TEMPLATE, renderAccountEnv, renderCaddyfile, renderUnit } from "./fleet-templates.js";

export const DEFAULT_BASE_PORT = 3900;

/** The fleet's port table could not be read or used. Nothing was changed. */
export class FleetError extends Error {
    constructor(message) {
        super(message);
        this.name = "FleetError";
    }
}

/** @returns {string} */
export function fleetFile() {
    return join(CONFIG_DIR, "fleet.json");
}

/**
 * @returns {{ basePort: number, ports: Record<string, number> }}
 * @throws {FleetError} when the file exists but is not a usable table
 */
export function loadPortTable() {
    const file = fleetFile();
    if (!existsSync(file)) return { basePort: DEFAULT_BASE_PORT, ports: {} };
    let data;
    try {
        data = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        throw new FleetError(
            `${file} exists but cannot be read (${e.message}). It was left untouched; fix or remove it.`,
        );
    }
    const ports = data?.ports;
    if (!ports || typeof ports !== "object" || Array.isArray(ports)) {
        throw new FleetError(`${file} has no "ports" table. It was left untouched; fix or remove it.`);
    }
    for (const [id, p] of Object.entries(ports)) {
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
            throw new FleetError(
                `${file}: account ${id} has port ${JSON.stringify(p)}, which is not a port. It was left untouched.`,
            );
        }
    }
    return { basePort: Number.isInteger(data.basePort) ? data.basePort : DEFAULT_BASE_PORT, ports };
}

/**
 * Give every account in `ownIds` a port, keeping the ones it already has.
 *
 * A new account takes the lowest port at or above the base that no account holds, so a port freed by a
 * removed account is reused and an existing assignment never moves. The table is changed under a lock and
 * written atomically, as the registry is.
 *
 * @param {string[]} ownIds
 * @param {{ basePort?: number }} [options] - Only used while the table is still empty
 * @returns {{ basePort: number, ports: Record<string, number>, added: string[] }}
 */
export function assignPorts(ownIds, { basePort } = {}) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    return withFileLock(`${fleetFile()}.lock`, () => {
        const table = loadPortTable();
        const hasAny = Object.keys(table.ports).length > 0;
        const base = !hasAny && Number.isInteger(basePort) ? basePort : table.basePort;
        if (base < 1 || base > 65535) throw new FleetError(`base port ${base} is not a port`);
        const taken = new Set(Object.values(table.ports));
        const added = [];
        for (const id of [...ownIds].sort()) {
            if (table.ports[id] !== undefined) continue;
            let p = base;
            while (taken.has(p)) p++;
            if (p > 65535) throw new FleetError("no free port left above the base port");
            table.ports[id] = p;
            taken.add(p);
            added.push(id);
        }
        if (added.length || !existsSync(fleetFile())) {
            writeFileAtomic(fleetFile(), JSON.stringify({ version: 1, basePort: base, ports: table.ports }, null, 2), {
                mode: 0o644,
            });
        }
        return { basePort: base, ports: table.ports, added };
    });
}

/** The states `fleet status` reports, worst last. */
export const STATES = Object.freeze([
    "ok",
    "degraded",
    "starting",
    "maintenance",
    "relogin",
    "kicked",
    "down",
    "unresponsive",
    "stopped",
]);

/** The socket states a daemon reports that are neither up nor merely down: each says why the socket is not up. */
const HELD = new Set(["maintenance", "relogin", "kicked"]);

/**
 * One word for an account.
 *
 *  - `stopped`: no daemon runs for it
 *  - `unresponsive`: a daemon runs (its lock is held) but does not answer on its loopback channel
 *  - `down`: it answers, and its Zalo socket has been down at least `downForSec`
 *  - `maintenance`: it answers, and it is waiting for Zalo to come back from maintenance (nothing to do)
 *  - `relogin`: it answers, and Zalo refused its session, so it is logging in again (transient)
 *  - `kicked`: it answers, and another session took the account, so it will not reconnect (see the log; restarting it
 *    would only evict the other session in turn)
 *  - `starting`: it answers, and its socket is not up yet (or has not been down long enough to count)
 *  - `degraded`: the socket is up but it has warnings (a webhook backlog, dead letters, open gaps)
 *  - `ok`
 *
 * @param {{ running: boolean, health: object|null }} a - `health` is null when the daemon did not answer
 * @param {{ downForSec?: number }} [o]
 * @returns {"ok"|"degraded"|"starting"|"maintenance"|"relogin"|"kicked"|"down"|"unresponsive"|"stopped"}
 */
export function classifyAccount({ running, health }, { downForSec = 180 } = {}) {
    if (!running) return "stopped";
    if (!health) return "unresponsive";
    const socket = health.socket ?? {};
    if (HELD.has(socket.state)) return socket.state;
    if (socket.state === "down" && (socket.forSec ?? 0) >= downForSec) return "down";
    if (socket.state !== "up") return "starting";
    return health.warnings?.length ? "degraded" : "ok";
}

/** True for the states a restart can help: the account is not serving. */
export const needsRestart = (state) => state === "down" || state === "unresponsive";

/**
 * Split accounts into start-up batches: shuffled first, so accounts set up together do not log in together.
 *
 * @template T
 * @param {T[]} items
 * @param {{ size?: number, random?: () => number }} [o]
 * @returns {T[][]}
 */
export function planBatches(items, { size = 5, random = Math.random } = {}) {
    const n = Math.max(1, Math.floor(size) || 1);
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const batches = [];
    for (let i = 0; i < shuffled.length; i += n) batches.push(shuffled.slice(i, i + n));
    return batches;
}

/** @param {number|null|undefined} sec */
function age(sec) {
    if (sec === null || sec === undefined) return "-";
    if (sec < 90) return `${sec}s`;
    if (sec < 5400) return `${Math.round(sec / 60)}m`;
    if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
    return `${Math.round(sec / 86400)}d`;
}

/**
 * The table `fleet status` prints, one row per account.
 *
 * @param {Array<{ accountId: string, name?: string, port?: number|null, state: string, daemon: {running: boolean, pid: number|null}, health: object|null }>} rows
 * @returns {string[]} Lines
 */
export function renderStatusTable(rows) {
    const header = ["ACCOUNT", "NAME", "PORT", "STATE", "PID", "SOCKET", "LAST EVENT", "WEBHOOK", "GAPS", "MEM"];
    const body = rows.map((r) => {
        const h = r.health;
        const w = h?.webhook;
        return [
            r.accountId,
            (r.name || "").slice(0, 20),
            r.port ?? "-",
            r.state,
            r.daemon.running ? (r.daemon.pid ?? "?") : "-",
            h ? `${h.socket.state} ${age(h.socket.forSec)}` : "-",
            h ? age(h.events.lastEventAgeSec) : "-",
            w ? `${w.pending}q ${w.dead}d` : h ? "off" : "-",
            h ? h.coverage.pendingGaps : "-",
            h ? `${Math.round(h.process.rssBytes / 1048576)}M` : "-",
        ].map(String);
    });
    const widths = header.map((c, i) => Math.max(c.length, ...body.map((r) => r[i].length)));
    const line = (cells) =>
        cells
            .map((c, i) => c.padEnd(widths[i]))
            .join("  ")
            .trimEnd();
    return [line(header), ...body.map(line)];
}

/**
 * Write the files that supervise a fleet: the systemd unit, env files (with a generated bearer token per
 * account), the port table, and optionally a Caddyfile. An existing file is never overwritten unless `force`;
 * an existing account env file keeps its token even then unless `rotateTokens`.
 *
 * @param {object} args
 * @param {string} args.outDir
 * @param {Array<{ ownId: string, port: number }>} args.accounts
 * @param {{ user?: string, home?: string, bin?: string, mediaDir?: string, etcDir?: string }} [args.paths] -
 *   for the unit
 * @param {string|null} [args.domain] - Also write a Caddyfile for this hostname
 * @param {boolean} [args.force]
 * @param {boolean} [args.rotateTokens]
 * @param {() => string} [args.makeToken]
 * @returns {{ written: string[], kept: string[] }} Paths relative to outDir. Tokens are never returned.
 */
export function generateFleetFiles({
    outDir,
    accounts,
    paths = {},
    domain = null,
    force = false,
    rotateTokens = false,
    makeToken = () => randomBytes(32).toString("hex"),
}) {
    const written = [];
    const kept = [];
    const put = (rel, text, { secret = false, overwrite = force } = {}) => {
        const file = join(outDir, rel);
        if (existsSync(file) && !overwrite) {
            kept.push(rel);
            return false;
        }
        writeFileAtomic(file, text, { mode: secret ? 0o600 : 0o644 });
        written.push(rel);
        return true;
    };

    put("zalo-mcp@.service", renderUnit(paths));
    put("common.env", COMMON_ENV_TEMPLATE, { secret: true });
    for (const { ownId, port } of accounts) {
        const rel = join("accounts", `${ownId}.env`);
        const file = join(outDir, rel);
        // Never replace a token that is already in use just because the file is being regenerated.
        if (existsSync(file) && !rotateTokens) {
            kept.push(rel);
            continue;
        }
        put(rel, renderAccountEnv({ ownId, port, token: makeToken() }), { secret: true, overwrite: true });
    }
    put("ports.json", JSON.stringify(Object.fromEntries(accounts.map((a) => [a.ownId, a.port])), null, 2) + "\n", {
        overwrite: true,
    });
    if (domain) put("Caddyfile", renderCaddyfile({ domain, accounts }));
    return { written, kept };
}
