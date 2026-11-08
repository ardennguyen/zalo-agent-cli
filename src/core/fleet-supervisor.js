/**
 * Who starts and stops an account's daemon on this host: systemd (the `zalo-mcp@<ownId>.service` template unit that
 * `fleet generate` writes) or a plain spawn (`fleet start` / `fleet stop`). One interface for both, so the fleet
 * controller (`fleet serve`, ./fleet-controller.js) and the `fleet` commands drive either the same way:
 *
 *     driver.start(ownId) / stop(ownId) / restart(ownId)  -> {ok, detail, code?}
 *     driver.status(ownId)                                -> {running, state, pid?}
 *
 * - **systemd**: `systemctl start|stop|restart zalo-mcp@<ownId>.service`, run without a shell, the unit name built
 *   from a checked account id only. A service user drives it through a polkit rule that names `zalo-mcp@*.service`
 *   and nothing else (docs/config-samples/systemd/zalo-fleet-polkit.rules). `RestartPreventExitStatus=3 4` keeps a
 *   kicked or refused account down until a person starts it.
 * - **spawn**: `spawnDaemonProcess` / `stopDaemon` (./daemon-channel.js), as `fleet start` / `fleet stop` do.
 *
 * `ZALO_FLEET_SUPERVISOR=systemd|spawn` picks one; unset: systemd when `/run/systemd/system` exists, else spawn
 * ({@link detectSupervisor}, for the controller), or per account by its unit's state ({@link supervisorOf}, for
 * `fleet start|stop|restart`, which must not start a daemon beside a unit or stop one its unit restarts).
 * The runner is injectable, so tests drive a fake `systemctl`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** The template unit `fleet generate` writes. */
export const UNIT_TEMPLATE_NAME = "zalo-mcp@.service";

const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;

/**
 * The unit of one account. Throws on anything that is not an account id, so no other unit can be named.
 *
 * @param {string} ownId
 * @returns {string}
 */
export function unitName(ownId) {
    const id = String(ownId ?? "");
    if (!ACCOUNT_ID.test(id)) throw new Error(`"${id}" is not an account id`);
    return `zalo-mcp@${id}.service`;
}

/**
 * Run `systemctl` with these arguments, no shell.
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [o]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runSystemctl(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
        execFile("systemctl", args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
        });
    });
}

/**
 * Which supervisor this host uses.
 *
 * @param {{env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean}} [o]
 * @returns {"systemd"|"spawn"}
 */
export function detectSupervisor({ env = process.env, exists = existsSync } = {}) {
    const asked = String(env.ZALO_FLEET_SUPERVISOR ?? "")
        .trim()
        .toLowerCase();
    if (asked === "systemd" || asked === "spawn") return asked;
    return exists("/run/systemd/system") ? "systemd" : "spawn";
}

/** Unit states in which systemd owns the account's daemon (running, starting, stopping, or kept down). */
const UNIT_OWNS = new Set(["active", "activating", "deactivating", "reloading", "failed"]);

/**
 * Who runs this one account's daemon: systemd when its `zalo-mcp@<ownId>` unit is loaded and either running
 * (or starting, stopping, kept down as `failed`) or enabled; else a plain spawn. `ZALO_FLEET_SUPERVISOR`
 * decides for every account when set. A daemon started beside a running unit races the unit for `daemon.lock`
 * (the unit then loops to its start limit), and a spawn-stopped one is restarted by `Restart=always`: so
 * `fleet start|stop|restart` ask this per account, and go through systemctl for a unit.
 *
 * @param {string} ownId
 * @param {{env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, run?: typeof runSystemctl}} [o]
 * @returns {Promise<"systemd"|"spawn">}
 */
export async function supervisorOf(ownId, { env = process.env, exists = existsSync, run = runSystemctl } = {}) {
    const asked = String(env.ZALO_FLEET_SUPERVISOR ?? "")
        .trim()
        .toLowerCase();
    if (asked === "systemd" || asked === "spawn") return asked;
    if (!exists("/run/systemd/system")) return "spawn";
    const r = await run(["show", unitName(ownId), "--property=LoadState,ActiveState,UnitFileState"], {
        timeoutMs: 15_000,
    });
    if (r.code !== 0) return "spawn";
    const p = Object.fromEntries(
        r.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    if (p.LoadState !== "loaded") return "spawn";
    return UNIT_OWNS.has(p.ActiveState) || p.UnitFileState === "enabled" ? "systemd" : "spawn";
}

/**
 * The systemd driver.
 *
 * @param {{run?: typeof runSystemctl}} [o]
 * @returns {object}
 */
export function createSystemdDriver({ run = runSystemctl } = {}) {
    const act = async (verb, ownId) => {
        const unit = unitName(ownId);
        const r = await run([verb, unit]);
        return r.code === 0
            ? { ok: true, detail: `${verb} ${unit}` }
            : { ok: false, code: r.code, detail: `systemctl ${verb} ${unit} failed: ${r.stderr.trim() || r.code}` };
    };
    return {
        kind: "systemd",
        start: (id) => act("start", id),
        stop: (id) => act("stop", id),
        restart: (id) => act("restart", id),
        async status(ownId) {
            const r = await run(["is-active", unitName(ownId)]);
            const state = r.stdout.trim() || "unknown";
            return { running: state === "active" || state === "activating" || state === "reloading", state };
        },
    };
}

/**
 * The spawn driver: the daemons are this host's own child processes, as `fleet start` makes them.
 *
 * @param {object} o
 * @param {(args: {accountDir: string, args: string[], env: object}) => Promise<object>} o.spawnDaemon
 * @param {(accountDir: string) => Promise<{stopped: boolean, graceful?: boolean, pid?: number}>} o.stopDaemon
 * @param {(accountDir: string) => {running: boolean, pid: number|null}} o.daemonStatus
 * @param {(ownId: string) => string} o.accountDir
 * @param {(ownId: string) => string[]} o.argsFor - the daemon's command line (e.g. `mcp start --http <port>`)
 * @param {(ownId: string) => object} [o.envFor] - extra environment (the account's env file)
 * @returns {object}
 */
export function createSpawnDriver({ spawnDaemon, stopDaemon, daemonStatus, accountDir, argsFor, envFor = () => ({}) }) {
    const start = async (ownId) => {
        unitName(ownId);
        const r = await spawnDaemon({ accountDir: accountDir(ownId), args: argsFor(ownId), env: envFor(ownId) });
        if (r.ok) return { ok: true, detail: `started (pid ${r.pid})`, pid: r.pid };
        if (r.alreadyRunning) return { ok: true, detail: `already running (pid ${r.pid})`, pid: r.pid };
        return { ok: false, detail: `failed: ${r.error}${r.logPath ? ` (log: ${r.logPath})` : ""}` };
    };
    const stop = async (ownId) => {
        unitName(ownId);
        const r = await stopDaemon(accountDir(ownId));
        return {
            ok: true,
            detail: r.stopped
                ? `stopped (pid ${r.pid}${r.graceful === false ? ", forced" : ""})`
                : "no daemon was running",
        };
    };
    return {
        kind: "spawn",
        start,
        stop,
        async restart(ownId) {
            await stop(ownId);
            return start(ownId);
        },
        async status(ownId) {
            unitName(ownId);
            const s = daemonStatus(accountDir(ownId));
            return { running: Boolean(s.running), state: s.running ? "active" : "inactive", pid: s.pid ?? null };
        },
    };
}
