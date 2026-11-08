/**
 * The presence wiring both daemons share (`listen` and `mcp start`, AGENTS.md section 13: any asymmetry between them
 * is a defect). ./presence.js decides when the account's socket is held; ./socket-host.js opens and closes it; this
 * joins the two to everything else a daemon has:
 *
 *  - **Settings.** ./presence-config.js `resolvePresenceSettings` (files < env < policy, the role first: stdio MCP and a
 *    foreground `listen` printing to stdout are always-on). A policy change applies live (`applyPolicy`).
 *  - **The host.** A wake takes a connect slot (`ZALO_CONNECT_SLOTS`, ./startup-gate.js) and files the parked window as
 *    a planned gap (`lifecycle.noteWake`); a park flushes the delivered receipts, waits for a running stage, and marks
 *    the coming close as planned (`lifecycle.noteParking`, health `idle`) before the supervisor stops.
 *  - **States.** The supervisor's states feed presence, health and `account_state`; a kick on an on-demand daemon ends
 *    in `yielded` (the daemon stays up), a login Zalo keeps refusing ends in `signed-out` (the daemon stays up; exit 4
 *    only with `ZALO_EXIT_ON_SIGNED_OUT[_<ownId>]=1`).
 *  - **Demand.** `admit()` is the one door for every request that needs the account: an MCP tool call (by its class,
 *    src/mcp/tool-presence.js), a wait, a CLI request over the daemon channel. It refuses while yielded (`YIELDED`) or
 *    signed out (`SIGNED_OUT`), opens a hold, and for `fresh` / `socket` requests waits up to `presence.warmWait` for
 *    the socket; a `socket` request still not connected then gets the retryable `WARMING`.
 *  - **The routes.** The daemon channel's `/presence` (`presence status|wake|park|resume`), the CRM leases
 *    (./presence-leases.js) and `/status`'s `presence` block.
 */
import { readMCPConfig, resolveAccountMCPConfig, envForAccount } from "../mcp/mcp-config.js";
import { resolvePresenceSettings } from "./presence-config.js";
import { createPresence } from "./presence.js";
import { createLeaseRoutes, createLeaseStore } from "./presence-leases.js";
import { createStartupGate, resolveConnectSettings } from "./startup-gate.js";

/** A request the account cannot take now: `code` YIELDED, SIGNED_OUT or WARMING (retry after `retryAfterSec`). */
export class PresenceRefusal extends Error {
    /**
     * @param {{code: string, message: string, state?: string, retryAfterSec?: number}} r
     */
    constructor({ code, message, state = null, retryAfterSec = null }) {
        super(message);
        this.name = "PresenceRefusal";
        this.code = code;
        this.state = state;
        if (retryAfterSec !== null) this.retryAfterSec = retryAfterSec;
        this.details = { code, ...(state ? { state } : {}), ...(retryAfterSec !== null ? { retryAfterSec } : {}) };
    }
}

/**
 * Who reads a daemon (the role decides first, the plan's section 2.1).
 *
 * @param {{command: "mcp"|"listen", http?: boolean, background?: boolean}} o
 * @returns {"stdio"|"http"|"stdout"|"webhook"}
 */
export function presenceTransport({ command, http = false, background = false }) {
    if (command === "mcp") return http ? "http" : "stdio";
    return background ? "webhook" : "stdout";
}

/** Why on-demand without self-heal is refused at start (the plan's B3). */
export const NO_SELF_HEAL_REFUSAL =
    "--no-self-heal cannot run with on-demand presence: a parked socket comes back only through the self-heal's " +
    "catch-up, so everything that arrived while parked would be lost. Keep the self-heal, or set presence.mode " +
    '"always-on" (policy, mcp-config.json, or ZALO_PRESENCE_MODE).';

/**
 * The config files a `listen` daemon's presence reads: the same `mcp-config.json` (its `presence` block and
 * `accounts.<ownId>.presence`) and `<accountDir>/mcp-config.json` that `mcp start` merges, so one presence setting
 * covers both daemons. `listen` has no `--config`, so the default file is the one read. A file that cannot be used is
 * a `problem` (the caller decides: a background `listen` refuses, as `mcp start` does; a foreground one is always-on
 * and needs no file).
 *
 * @param {{ownId: string, accountDir?: string}} o
 * @returns {{config: object, problem: string|null}}
 */
export function presenceConfigFiles({ ownId, accountDir }) {
    const base = readMCPConfig();
    if (base.problem) return base;
    return resolveAccountMCPConfig(base.config, { accountId: ownId, accountDir });
}

/**
 * The settings a daemon starts with, and whether it may start with them.
 *
 * @param {object} o
 * @param {object} [o.config] - the merged MCP config (`listen` reads it through `presenceConfigFiles`)
 * @param {string} o.ownId
 * @param {"stdio"|"http"|"stdout"|"webhook"} o.transport
 * @param {boolean} [o.selfHeal]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @returns {{settings: object, forced: string|null, sources: object, problem: string|null}}
 */
export function resolveDaemonPresence({ config = {}, ownId, transport, selfHeal = true, env = process.env }) {
    const r = resolvePresenceSettings({ config, accountId: ownId, env, transport });
    const problem = !selfHeal && r.settings.mode === "on-demand" ? NO_SELF_HEAL_REFUSAL : null;
    return { ...r, problem };
}

/**
 * What a daemon does about its socket, in one line for the start-up banner: the mode, when it parks, and what
 * happens after a drop, a kick (another session took the socket) and a login Zalo refuses. The supervisor
 * (`src/core/socket-host.js`) owns every retry; nothing here reconnects.
 *
 * @param {{mode: string, idleTimeoutMs?: number, minConnectedMs?: number, onKick?: string}} settings
 * @param {{exitOnSignedOut?: boolean}} [o]
 * @returns {string}
 */
export function describeSocketPolicy(settings, { exitOnSignedOut = false } = {}) {
    const onDemand = settings.mode === "on-demand";
    const sec = (ms) => `${Math.round((Number(ms) || 0) / 1000)}s`;
    const parts = [
        onDemand
            ? `on-demand: the socket opens on demand and parks after ${sec(settings.idleTimeoutMs)} with none ` +
              `(never within ${sec(settings.minConnectedMs)} of a connect); while parked nothing reconnects, ` +
              "the next demand wakes it and the self-heal catches up"
            : "always-on: the socket stays connected",
        "a drop while connected is retried by Zalo's own reconnect table",
        onDemand && settings.onKick !== "exit"
            ? "if another session takes the account the daemon yields (stays up, refuses requests) until `presence resume`"
            : "if another session takes the account the daemon exits with code 3",
        exitOnSignedOut
            ? "a login Zalo keeps refusing exits with code 4"
            : "a login Zalo keeps refusing leaves the daemon up, signed out, until a QR login",
    ];
    return `Socket: ${parts.join("; ")}.`;
}

/** Whether a policy change touches the presence keys. */
const touchesPresence = (changed) => (changed ?? []).some((k) => k === "presence" || String(k).startsWith("presence."));

/**
 * @param {object} args
 * @param {string} args.ownId
 * @param {object} [args.config]
 * @param {"stdio"|"http"|"stdout"|"webhook"} args.transport
 * @param {boolean} [args.selfHeal]
 * @param {string} [args.configDir] - where the connect slots live (`ZALO_CONNECT_SLOTS`)
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {(line: string) => void} [args.log]
 * @param {() => object} args.getSocketHost - the daemon's socket host (built after this, so read late)
 * @param {{current: Function, acquire: Function}} [args.stageLock]
 * @param {{flush: () => Promise<unknown>}} [args.deliveredReceipts]
 * @param {{noteParking: Function, noteWake: Function}} [args.lifecycle] - ./listener-lifecycle.js gap tracker
 * @param {{noteSocketState: Function, noteParked: Function, noteYielded: Function, noteSignedOut: Function}} [args.health]
 * @param {{noteSocketState: Function, note: Function}} [args.accountState]
 * @param {() => number|null} [args.coveredUntil] - coverage watermark (ms) for the warming reply
 * @param {object} [args.clock] - test seam (./presence.js)
 * @param {object} [args.connectGate] - test seam: `{enter, leave}`
 * @returns {object}
 */
export function createDaemonPresence({
    ownId,
    config = {},
    transport,
    selfHeal = true,
    configDir = null,
    env = process.env,
    log = () => {},
    getSocketHost,
    stageLock = null,
    deliveredReceipts = null,
    lifecycle = null,
    health = null,
    accountState = null,
    coveredUntil = () => null,
    clock,
    connectGate = null,
}) {
    let resolved = resolveDaemonPresence({ config, ownId, transport, selfHeal, env });
    if (resolved.problem) throw new Error(resolved.problem);
    // ZALO_EXIT_ON_SIGNED_OUT[_<ownId>]: the per-account form wins, like every per-account variable.
    const exitOnSignedOut = ["1", "true", "yes", "on"].includes(
        String(envForAccount("ZALO_EXIT_ON_SIGNED_OUT", ownId, env) ?? "").toLowerCase(),
    );

    // Wakes across the machine (ZALO_CONNECT_SLOTS): a slot from the wake to its first catch-up, at most 60 s.
    const connectSettings = resolveConnectSettings({ env, ownId });
    for (const w of connectSettings.warnings) log(w);
    const slots =
        connectGate ??
        (connectSettings.slots > 0 && configDir
            ? createStartupGate({ configDir, ownId, settings: connectSettings, kind: "connect", log })
            : null);
    let slotHeld = false;
    let slotTimer = null;
    const releaseSlot = () => {
        if (slotTimer) clearTimeout(slotTimer);
        slotTimer = null;
        if (!slotHeld) return;
        slotHeld = false;
        slots?.leave();
    };

    let wakeSeq = 0;
    const host = {
        wake: () => {
            const seq = ++wakeSeq;
            const go = () => {
                // A park (or a yield, a sign-out) since: this wake is called off.
                if (seq !== wakeSeq || presence.state !== "waking") return releaseSlot();
                try {
                    lifecycle?.noteWake?.();
                } catch (e) {
                    log(`presence: the parked window could not be filed: ${e?.message ?? e}`);
                }
                getSocketHost().wake();
            };
            if (!slots) return go();
            slots
                .enter()
                .then(() => {
                    slotHeld = true;
                    slotTimer = setTimeout(releaseSlot, connectSettings.holdSec * 1000);
                    slotTimer.unref?.();
                })
                .catch((e) => log(`presence: no connect slot (${e?.message ?? e}); connecting anyway`))
                .finally(go);
        },
        park: (opts) => {
            wakeSeq++;
            return getSocketHost().park({
                ...opts,
                // Appendix A step 2: receipts out, and no park in the middle of a stage (a stage is a hold anyway).
                prepare: async () => {
                    try {
                        await deliveredReceipts?.flush?.();
                    } catch {
                        /* a receipt that could not go is not worth keeping the socket for */
                    }
                    if (stageLock?.current?.()) (await stageLock.acquire("park"))();
                },
            });
        },
    };

    const presence = createPresence({
        ownId,
        host,
        settings: resolved.settings,
        ...(clock ? { clock } : {}),
        log,
        onState: (next, _previous, detail) => {
            if (next !== "waking") releaseSlot();
            if (next === "parked") {
                health?.noteParked?.();
                accountState?.note?.("idle", detail.reason ? { reason: detail.reason } : {});
            } else if (next === "yielded") {
                health?.noteYielded?.();
                accountState?.note?.("yielded", { reason: "another session of this login took the socket" });
            } else if (next === "signed-out") {
                health?.noteSignedOut?.();
                accountState?.note?.("signed_out", { reason: "Zalo refuses the saved login" });
            }
        },
    });

    const leaseStore = createLeaseStore({ presence });

    /** The `presence` block of a warming reply, and of `/status`. */
    function snapshot() {
        const s = presence.snapshot();
        let covered = null;
        try {
            const ms = Number(coveredUntil());
            covered = ms > 0 ? new Date(ms).toISOString() : null;
        } catch {
            covered = null;
        }
        return { ...s, coveredUntil: covered, forced: resolved.forced, leases: leaseStore.count() };
    }

    const retryAfterSec = () => {
        const last = presence.snapshot().lastWakeMs;
        return Math.min(30, Math.max(2, Math.ceil((typeof last === "number" ? last : 5000) / 1000)));
    };

    /**
     * Let a request in: refused while yielded or signed out; a hold for its duration; for `fresh` and `socket`, the
     * socket first (at most `warmWait`).
     *
     * @param {{kind?: string, cls?: "none"|"fresh"|"socket"|"wait"}} [o]
     * @returns {Promise<{release: () => void, warming: object|null}>}
     */
    async function admit({ kind = "tool", cls = "none" } = {}) {
        const refused = presence.refusal();
        if (refused) throw new PresenceRefusal(refused);
        const h = presence.hold(cls === "wait" ? "wait" : kind);
        const release = () => {
            h.release();
        };
        if (cls === "none" || cls === "wait") return { release, warming: null };
        const ready = await presence.waitReady({
            timeoutMs: presence.settings.warmWaitMs,
            caughtUp: cls === "fresh",
        });
        if (ready) return { release, warming: null };
        const late = presence.refusal();
        if (late) {
            release();
            throw new PresenceRefusal(late);
        }
        if (cls === "socket" && presence.state !== "connected") {
            release();
            const after = retryAfterSec();
            throw new PresenceRefusal({
                code: "WARMING",
                state: presence.state,
                retryAfterSec: after,
                message:
                    `The account's socket is still connecting (on-demand presence woke it for this request). ` +
                    `Retry in ${after} s.`,
            });
        }
        const s = snapshot();
        return { release, warming: { state: s.state, catchUp: s.catchUp, coveredUntil: s.coveredUntil } };
    }

    /**
     * `POST /presence` on the daemon channel (`presence status|wake|park|resume`, the fleet controller's relay).
     *
     * @param {{action?: string}} params
     * @returns {Promise<object>}
     */
    async function serve(params = {}) {
        const action = String(params?.action ?? "status");
        if (action === "status") return snapshot();
        if (action === "wake") {
            const refused = presence.refusal();
            if (refused) throw new PresenceRefusal(refused);
            presence.wakeNow();
            return snapshot();
        }
        if (action === "park") {
            const parked = await presence.parkNow();
            return { parked, ...snapshot() };
        }
        if (action === "resume") {
            const r = presence.resume();
            if (!r.resumed) {
                const err = new PresenceRefusal({
                    code: presence.state === "signed-out" ? "SIGNED_OUT" : "NOT_YIELDED",
                    state: presence.state,
                    message: r.reason,
                });
                throw err;
            }
            return { resumed: true, ...snapshot() };
        }
        throw new Error(`unknown presence action "${action}" (status, wake, park or resume)`);
    }

    return {
        presence,
        get settings() {
            return presence.settings;
        },
        get mode() {
            return presence.settings.mode;
        },
        get forced() {
            return resolved.forced;
        },
        /** Whether a refused login exits 4 (`ZALO_EXIT_ON_SIGNED_OUT[_<ownId>]`) instead of staying up signed out. */
        get exitOnSignedOut() {
            return exitOnSignedOut;
        },
        exitOnSignedOut,
        snapshot,
        admit,
        serve,
        /** For `account_state`'s detail. */
        detail: () => ({ presence: presence.settings.mode }),
        /** The CRM lease routes (`deps.leases` of the MCP HTTP server). */
        leaseRoutes: createLeaseRoutes({
            store: leaseStore,
            describe: () => snapshot(),
            log,
        }),
        leases: leaseStore,

        /**
         * Begin: the socket host takes the session without opening it; presence opens it now (always-on, the
         * start-up catch-up) or on the first demand.
         *
         * @param {object} api
         */
        start(api) {
            getSocketHost().adopt(api);
            presence.start();
        },

        /** The supervisor's state (the socket host's `health.noteSocketState`). */
        noteSocketState(state) {
            presence.noteSocketState(state);
            health?.noteSocketState?.(state);
            // A kick is said by the daemon itself: exit 3 (`kicked`) or a yield (`yielded`), never both.
            if (state !== "kicked") accountState?.noteSocketState?.(state);
            // Without the self-heal (always-on only) a connect is all the catch-up there is.
            if (state === "connected" && !selfHeal) this.noteCatchUpDone({ ms: 0 });
        },

        /** The self-heal finished a catch-up. */
        noteCatchUpDone({ ms } = {}) {
            presence.noteCatchUpDone({ ms });
            releaseSlot();
        },

        /** The socket host's `yieldOnKick`: true when the daemon stays up (`yielded`). */
        yieldOnKick() {
            return presence.noteKicked() === "yield";
        },

        /** The socket host's `onParking`: the coming close is planned. */
        onParking() {
            lifecycle?.noteParking?.();
            health?.noteParked?.();
        },

        /**
         * Zalo keeps refusing the saved login. Unless `ZALO_EXIT_ON_SIGNED_OUT[_<ownId>]=1`, the daemon stays up in `signed-out`
         * (the socket is let go for good, requests are refused) and this returns true; false: end it with exit 4.
         *
         * @returns {boolean}
         */
        signOut() {
            if (exitOnSignedOut) return false;
            presence.noteSignedOut();
            leaseStore.stop();
            void getSocketHost()
                .halt()
                .catch(() => {});
            return true;
        },

        /**
         * A policy change: the presence keys apply at once (a switch to always-on holds the socket now; one to
         * on-demand starts the idle clock).
         *
         * @param {string[]} changed
         * @returns {boolean} whether presence changed
         */
        applyPolicy(changed) {
            if (!touchesPresence(changed)) return false;
            const next = resolveDaemonPresence({ config, ownId, transport, selfHeal: true, env });
            if (!selfHeal && next.settings.mode === "on-demand") {
                log(`presence: the policy asks for on-demand, refused: ${NO_SELF_HEAL_REFUSAL}`);
                next.settings = { ...next.settings, mode: "always-on" };
            }
            resolved = { ...next, problem: null };
            presence.update(resolved.settings);
            log(`presence: ${presence.settings.mode} (policy)`);
            return true;
        },

        /** The daemon is shutting down. */
        stop() {
            releaseSlot();
            leaseStore.stop();
            presence.stop();
        },
    };
}
