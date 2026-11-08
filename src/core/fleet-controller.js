/**
 * The fleet controller (`zalo-agent fleet serve`): the account-lifecycle admin API for a whole host.
 *
 * A stopped account has no process and a new account has no server, so a per-account MCP server cannot host this.
 * The controller is one process per host. It holds **no account lock and no Zalo socket** (AGENTS.md section 13): it
 * starts and stops daemons (./fleet-supervisor.js: systemd units or spawned processes), relays to a running daemon's
 * loopback channel, and runs the CLI for a logout or a removal, so every guard those have still applies.
 *
 * Routes, under `/zalo/admin` and behind the admin credential (./admin-api.js; an agent's token is refused):
 *
 *     GET    /accounts                              every account: state, presence, user, port, pid
 *     POST   /accounts/<ownId>/start|stop|restart   drive its unit or process
 *     POST   /accounts/<ownId>/presence/wake|park   relayed to the daemon's channel (on-demand presence)
 *     POST   /accounts/<ownId>/presence/resume      relayed: take the account back after a yield (the user closed the
 *                                                   other session of this login; the admin's explicit confirmation)
 *     POST   /accounts/<ownId>/logout               guarded: 409 {confirmToken} first, then X-Confirm: <token>
 *     DELETE /accounts/<ownId>                      guarded the same way: stop, `account remove` (crypto-shred)
 *     GET    /events                                SSE: `account_state` for every account
 *     ...    /accounts/qr[...]                      the QR add flow (./fleet-qr.js)
 *     ...    /policy/..., /presence/always-on       the host-level policy (users, tenants, accounts)
 *
 * `account_state` comes from polling each daemon's channel every `pollMs` (5 s), plus `stopped` for an account with
 * no process; each change goes to the SSE clients and the admin webhook once.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ACCOUNT_STATES, accountStateOfHealth } from "./account-state.js";

/** How long a guard's confirm token lives. */
export const CONFIRM_TTL_MS = 2 * 60_000;

/** What each guarded action ends, in the words the CLI's guard uses. */
export const GUARDED_EFFECTS = Object.freeze({
    logout:
        "Ends this machine's Zalo session for the account (its saved login is deleted; chat history stays). " +
        "It does not sign the device out on the phone: the phone's device list is what revokes it.",
    remove:
        "Stops the account's daemon, logs it out and removes it from this machine for good: its credentials, its " +
        "local database and media, its keys (crypto-shred), its port and its env file. Zalo itself is not changed.",
});

const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;

/**
 * @param {object} args
 * @param {{kind: string, start: Function, stop: Function, restart: Function, status: Function}} args.driver
 * @param {() => Array<{ownId: string}>} args.listAccounts
 * @param {(ownId: string) => Promise<{running: boolean, pid?: number|null, health: object|null, kicked?: boolean}>} args.probe
 * @param {(ownId: string, path: string, params: object) => Promise<object|null>} args.relay - the daemon channel
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} args.runCli
 * @param {(ownId: string) => {port?: number|null, userId?: string|null, presence?: string|null}} [args.describe]
 * @param {(ownId: string) => Promise<void>|void} [args.forget] - drop a removed account from the port table, its env
 *   file and its user
 * @param {{handle: (req: object, res: object, ctx: object) => boolean|Promise<boolean>}|null} [args.qr] - WP8
 * @param {(event: object) => void} [args.webhook] - the admin webhook
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {number} [args.pollMs]
 * @returns {object}
 */
export function createFleetController({
    driver,
    listAccounts,
    probe,
    relay,
    runCli,
    describe = () => ({}),
    forget = () => {},
    qr = null,
    webhook = () => {},
    log = () => {},
    now = Date.now,
    pollMs = 5000,
}) {
    const states = new Map(); // ownId -> {state, at, pid}
    const clients = new Set();
    const confirms = new Map(); // token -> {action, ownId, expiresAt}
    let timer = null;
    let polling = null;

    const send = (res, code, body, headers = {}) => {
        res.status(code)
            .set({ "Cache-Control": "no-store", ...headers })
            .json(body);
    };

    function publish(event) {
        const line = `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const c of clients) {
            try {
                c.write(line);
            } catch {
                clients.delete(c);
            }
        }
        try {
            webhook(event);
        } catch (e) {
            log(`[fleet] the admin webhook failed: ${e.message}`);
        }
    }

    function noteState(ownId, state, detail = {}) {
        if (!ACCOUNT_STATES.includes(state)) return;
        const prev = states.get(ownId);
        if (prev?.state === state) return;
        const at = now();
        states.set(ownId, { state, at, pid: detail.pid ?? prev?.pid ?? null });
        publish({
            event: "account_state",
            accountId: ownId,
            state,
            previous: prev?.state ?? null,
            at: new Date(at).toISOString(),
            detail: { source: "controller", ...detail },
        });
    }

    /** Ask every account where it stands; each change is published once. */
    async function poll() {
        if (polling) return polling;
        polling = (async () => {
            for (const { ownId } of listAccounts()) {
                try {
                    const p = await probe(ownId);
                    const state = p.running ? accountStateOfHealth(p.health) : p.kicked ? "kicked" : "stopped";
                    noteState(ownId, state, {
                        pid: p.pid ?? null,
                        ...(p.health?.presence ? { presence: p.health.presence.mode } : {}),
                    });
                } catch (e) {
                    log(`[fleet] ${ownId}: ${e.message}`);
                }
            }
        })().finally(() => {
            polling = null;
        });
        return polling;
    }

    /** A guarded action: the first call names what it does and hands a single-use token; the second runs it. */
    function guard(req, res, action, ownId) {
        const given = String(req.headers?.["x-confirm"] ?? "");
        for (const [t, c] of confirms) if (c.expiresAt <= now()) confirms.delete(t);
        if (!given) {
            const token = randomBytes(18).toString("base64url");
            const expiresAt = now() + CONFIRM_TTL_MS;
            confirms.set(token, { action, ownId, expiresAt });
            send(res, 409, {
                confirmationRequired: true,
                action,
                accountId: ownId,
                effect: GUARDED_EFFECTS[action],
                confirmToken: token,
                expiresAt: new Date(expiresAt).toISOString(),
            });
            return false;
        }
        let match = null;
        for (const [t, c] of confirms) {
            const a = Buffer.from(t);
            const b = Buffer.from(given);
            if (a.length === b.length && timingSafeEqual(a, b)) match = [t, c];
        }
        if (!match || match[1].action !== action || match[1].ownId !== ownId || match[1].expiresAt <= now()) {
            send(res, 409, { error: "the confirm token is not valid for this action (expired, used or another one)" });
            return false;
        }
        confirms.delete(match[0]);
        return true;
    }

    const known = (ownId) => listAccounts().some((a) => a.ownId === ownId);

    async function accountsView() {
        const out = [];
        for (const { ownId } of listAccounts()) {
            const s = states.get(ownId);
            out.push({
                accountId: ownId,
                state: s?.state ?? null,
                since: s ? new Date(s.at).toISOString() : null,
                pid: s?.pid ?? null,
                ...describe(ownId),
            });
        }
        return out;
    }

    /**
     * Serve a route under `/zalo/admin` (already authorized). Returns false for a path that is not the controller's.
     *
     * @param {object} req
     * @param {object} res
     * @param {{who: string, ip: string, path: string}} ctx
     * @returns {Promise<boolean>}
     */
    async function handle(req, res, ctx) {
        const path = ctx.path;
        if (qr && (path === "/accounts/qr" || path.startsWith("/accounts/qr/"))) return qr.handle(req, res, ctx);
        if (path === "/events") {
            if (req.method !== "GET") return (send(res, 405, { error: "GET only" }), true);
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write(`event: snapshot\ndata: ${JSON.stringify({ accounts: await accountsView() })}\n\n`);
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return true;
        }
        if (path === "/accounts") {
            if (req.method !== "GET") return (send(res, 405, { error: "GET only" }), true);
            send(res, 200, { supervisor: driver.kind, accounts: await accountsView() });
            return true;
        }
        const m =
            /^\/accounts\/([^/]+)(?:\/(start|stop|restart|logout|presence\/wake|presence\/park|presence\/resume))?$/.exec(
                path,
            );
        if (!m) return false;
        const ownId = decodeURIComponent(m[1]);
        if (!ACCOUNT_ID.test(ownId)) return (send(res, 400, { error: "not an account id" }), true);
        if (!known(ownId)) return (send(res, 404, { error: `account ${ownId} is not registered on this host` }), true);
        const action = m[2] ?? null;
        if (!action) {
            if (req.method !== "DELETE") return (send(res, 405, { error: "DELETE only" }), true);
            if (!guard(req, res, "remove", ownId)) return true;
            log(`[fleet] remove ${ownId} (${ctx.who} ${ctx.ip})`);
            await driver.stop(ownId);
            const r = await runCli(["--json", "account", "remove", ownId]);
            if (r.code !== 0) {
                send(res, 500, { error: "account remove failed", detail: r.stderr.trim().slice(0, 500) });
                return true;
            }
            await forget(ownId);
            states.delete(ownId);
            publish({
                event: "account_state",
                accountId: ownId,
                state: "stopped",
                previous: null,
                at: new Date(now()).toISOString(),
                detail: { source: "controller", removed: true },
            });
            send(res, 200, { removed: true, accountId: ownId });
            return true;
        }
        if (req.method !== "POST") return (send(res, 405, { error: "POST only" }), true);
        if (action === "start" || action === "stop" || action === "restart") {
            const before = states.get(ownId)?.state ?? null;
            const r = await driver[action](ownId);
            // A start after a kick takes the account back from the other session: a person's decision, logged.
            if (action !== "stop" && before === "kicked") log(`[fleet] ${action} ${ownId} after a kick (takeover)`);
            log(`[fleet] ${action} ${ownId}: ${r.detail} (${ctx.who} ${ctx.ip})`);
            if (action === "stop" && r.ok) noteState(ownId, "stopped");
            send(res, r.ok ? 200 : 502, {
                accountId: ownId,
                action,
                ok: r.ok,
                detail: r.detail,
                takeover: before === "kicked" && action !== "stop",
            });
            return true;
        }
        if (action === "presence/wake" || action === "presence/park" || action === "presence/resume") {
            if (action === "presence/resume") log(`[fleet] presence resume ${ownId} (${ctx.who} ${ctx.ip})`);
            const r = await relay(ownId, "/presence", { action: action.slice(9) });
            if (!r) return (send(res, 409, { error: "no daemon runs for this account" }), true);
            if (!r.ok) return (send(res, 409, { error: r.error, ...(r.code ? { code: r.code } : {}) }), true);
            send(res, 200, r);
            return true;
        }
        if (action === "logout") {
            if (!guard(req, res, "logout", ownId)) return true;
            log(`[fleet] logout ${ownId} (${ctx.who} ${ctx.ip})`);
            await driver.stop(ownId);
            const r = await runCli(["--json", "--account", ownId, "logout"]);
            if (r.code !== 0) {
                send(res, 500, { error: "logout failed", detail: r.stderr.trim().slice(0, 500) });
                return true;
            }
            noteState(ownId, "login_needed", { reason: "logout" });
            send(res, 200, { loggedOut: true, accountId: ownId });
            return true;
        }
        return false;
    }

    return {
        handle,
        poll,
        noteState,
        publish,
        /** Start polling every account's state. */
        start() {
            if (timer) return;
            void poll();
            timer = setInterval(() => void poll(), pollMs);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            for (const c of clients) {
                try {
                    c.end();
                } catch {
                    /* gone */
                }
            }
            clients.clear();
        },
        /** For tests and `/accounts`: the last state seen per account. */
        states: () => Object.fromEntries([...states].map(([k, v]) => [k, v.state])),
        clients: () => clients.size,
    };
}
