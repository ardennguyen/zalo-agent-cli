/**
 * Adding an account from a CRM: the QR flows of the fleet controller (./fleet-controller.js, `fleet serve`).
 *
 *     POST   /zalo/admin/accounts/qr                {userId, presence?, start?: true, proxy?}
 *              -> 202 {flowId, pageUrl: "<publicUrl>/zalo/qr/<token>", eventsUrl, imageUrl, expiresAt}
 *     GET    /zalo/admin/accounts/qr/<flowId>/events   SSE: qr, scanned, expired, done {ownId}, failed {reason}
 *     GET    /zalo/admin/accounts/qr/<flowId>/image    the current PNG (admin credential, no-store)
 *     DELETE /zalo/admin/accounts/qr/<flowId>          cancel
 *
 * - **One login per flow, in its own process** (`zalo-agent --json login --qr-port 0`): a login sets its process's
 *   session, so two flows in one process would share it. The child is the same `login` a person runs: it saves the
 *   credentials and registers the account, and it opens **no chat socket** (a QR login is HTTP; the session it makes
 *   is saved, never listened on). Its loopback page takes a free port and is never offered.
 * - **Per-flow page.** Each flow has its own `QrPage` (its own token, state and image file), served by the controller
 *   at `/zalo/qr/<token>` under `publicUrl`, so a CRM can hand the link to the person who scans.
 * - **At most `ZALO_FLEET_QR_FLOWS` (4) flows at once**: 429 above.
 * - **Finish**: register (the child did) -> a port (`fleet.json`) -> `<envDir>/<ownId>.env` with a generated token
 *   (when an env dir is set and the file is new) -> the user's `accounts` -> `presence` if given (the always-on cap
 *   applies) -> start if asked. An account that was already running is kicked by the new login (exit 3), so it is
 *   restarted on purpose and the flow says `restarted: "relogin"`.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QrPage } from "../utils/qr-http-server.js";

/** The default concurrent flows. */
export const DEFAULT_QR_FLOWS = 4;

/** A flow that never ends is cancelled after this. */
export const FLOW_MAX_MS = 15 * 60_000;

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * @param {object} args
 * @param {(o: {proxy?: string|null}) => {lines: AsyncIterable<string>|null, onLine: Function, kill: () => void,
 *   exited: Promise<number>}} args.spawnLogin - one child login; `onLine(fn)` subscribes to its stdout lines
 * @param {(o: {ownId: string, userId: string, presence: string|null, start: boolean, wasRunning: boolean}) =>
 *   Promise<object>} args.finish - the finish steps; returns what `done` carries (port, restarted, ...)
 * @param {(ownId: string) => Promise<boolean>|boolean} [args.isRunning]
 * @param {string} args.dir - where the flows' QR images are kept (0600, removed at the end)
 * @param {string|null} [args.publicUrl]
 * @param {string|null} [args.localBaseUrl]
 * @param {number} [args.maxFlows]
 * @param {(event: object) => void} [args.webhook] - the admin webhook mirror
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @returns {object}
 */
export function createQrFlows({
    spawnLogin,
    finish,
    isRunning = () => false,
    dir,
    publicUrl = null,
    localBaseUrl = null,
    maxFlows = DEFAULT_QR_FLOWS,
    webhook = () => {},
    log = () => {},
    now = Date.now,
}) {
    const flows = new Map(); // flowId -> flow

    const send = (res, code, body) => {
        res.status(code).set({ "Cache-Control": "no-store" }).json(body);
    };

    function emit(flow, type, data = {}) {
        const event = { event: `qr_${type}`, flowId: flow.id, at: new Date(now()).toISOString(), ...data };
        flow.events.push(event);
        const line = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const c of flow.clients) {
            try {
                c.write(line);
            } catch {
                flow.clients.delete(c);
            }
        }
        try {
            webhook(event);
        } catch {
            /* the mirror is best-effort */
        }
    }

    function end(flow, type, data) {
        if (flow.ended) return;
        flow.ended = true;
        emit(flow, type, data);
        clearTimeout(flow.timer);
        flow.page.revoke();
        try {
            rmSync(flow.imagePath, { force: true });
        } catch {
            /* already gone */
        }
        for (const c of flow.clients) {
            try {
                c.end();
            } catch {
                /* gone */
            }
        }
        flow.clients.clear();
        // Keep the record a little for a late reader of the events; then forget it.
        const t = setTimeout(() => flows.delete(flow.id), 60_000);
        t.unref?.();
    }

    async function onLine(flow, raw) {
        let m;
        try {
            m = JSON.parse(raw);
        } catch {
            return; // a human line
        }
        if (flow.ended || !m || typeof m !== "object") return;
        if (m.event === "qr" && m.image) {
            flow.image = Buffer.from(String(m.image), "base64");
            writeFileSync(flow.imagePath, flow.image, { mode: 0o600 });
            if (!flow.link) flow.link = flow.page.open({ qrImagePath: flow.imagePath, ttlMs: FLOW_MAX_MS });
            else flow.page.extend();
            flow.page.noteLayer(m.layer === 2 ? 2 : 1);
            emit(flow, "qr", { layer: m.layer === 2 ? 2 : 1, expiresAt: new Date(now() + 100_000).toISOString() });
        } else if (m.event === "qr_scanned") {
            flow.page.noteScanned("");
            emit(flow, "scanned"); // the name the phone shows stays out of the event: ids only
        } else if (m.event === "qr_expired") {
            flow.page.noteExpired(null);
            emit(flow, "expired");
        } else if (m.event === "qr_declined") {
            flow.page.noteOutcome("failed", "declined on the phone");
            end(flow, "failed", { reason: "declined" });
        } else if (m.event === "login_success" && m.ownId) {
            // The finish runs once, whatever the child prints after it.
            if (flow.finishing) return;
            flow.finishing = true;
            const ownId = String(m.ownId);
            try {
                const wasRunning = Boolean(await isRunning(ownId));
                const result = await finish({
                    ownId,
                    userId: flow.userId,
                    presence: flow.presence,
                    start: flow.start,
                    wasRunning,
                });
                flow.page.noteOutcome("done");
                end(flow, "done", { ownId, ...result });
            } catch (e) {
                flow.page.noteOutcome("failed", e.message);
                end(flow, "failed", { reason: "finish", ownId, error: e.message });
            }
        } else if (m.event === "login_error") {
            flow.page.noteOutcome("failed", "login failed");
            end(flow, "failed", { reason: "login", error: String(m.message ?? "").slice(0, 300) });
        }
    }

    function create(body) {
        const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
        if (!USER_ID.test(userId)) return { code: 400, body: { error: "userId must be an opaque id" } };
        const presence = body?.presence ?? null;
        if (presence !== null && presence !== "on-demand" && presence !== "always-on")
            return { code: 400, body: { error: "presence is on-demand or always-on" } };
        const live = [...flows.values()].filter((f) => !f.ended).length;
        if (live >= maxFlows) return { code: 429, body: { error: `${live} QR logins run already; try again` } };
        const id = `qf_${randomBytes(12).toString("base64url")}`;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const page = new QrPage({ now }).configure({ publicUrl, localBaseUrl, mounted: true });
        const flow = {
            id,
            userId,
            presence,
            start: body?.start !== false,
            page,
            link: null,
            image: null,
            imagePath: join(dir, `${id}.png`),
            events: [],
            clients: new Set(),
            ended: false,
            finishing: false,
            createdAt: now(),
        };
        // The link is issued now so the CRM has it at once; it shows "waiting" until the first code.
        flow.link = page.open({ qrImagePath: flow.imagePath, ttlMs: FLOW_MAX_MS });
        flows.set(id, flow);
        const child = spawnLogin({ proxy: typeof body?.proxy === "string" ? body.proxy : null });
        flow.child = child;
        child.onLine((l) => void onLine(flow, l));
        child.exited.then((code) => {
            if (!flow.ended && !flow.finishing) end(flow, "failed", { reason: "exited", exitCode: code });
        });
        flow.timer = setTimeout(() => cancel(id, "timeout"), FLOW_MAX_MS);
        flow.timer.unref?.();
        log(`[fleet] QR flow ${id} started`);
        return {
            code: 202,
            body: {
                flowId: id,
                pageUrl: flow.link.url,
                eventsUrl: `/zalo/admin/accounts/qr/${id}/events`,
                imageUrl: `/zalo/admin/accounts/qr/${id}/image`,
                expiresAt: new Date(flow.createdAt + FLOW_MAX_MS).toISOString(),
            },
        };
    }

    function cancel(id, why = "cancelled") {
        const flow = flows.get(id);
        if (!flow || flow.ended) return false;
        try {
            flow.child?.kill();
        } catch {
            /* gone */
        }
        end(flow, "failed", { reason: why });
        return true;
    }

    return {
        create,
        cancel,
        /** The flow pages, for the `/zalo/qr/<token>` route. */
        async servePage(req, res) {
            for (const f of flows.values()) if (!f.ended && f.page.owns(req.url)) return f.page.handle(req, res);
            return false;
        },
        /** The admin routes under `/accounts/qr`. */
        async handle(req, res, ctx) {
            const path = ctx.path;
            if (path === "/accounts/qr") {
                if (req.method !== "POST") return (send(res, 405, { error: "POST only" }), true);
                const r = create(req.body);
                send(res, r.code, r.body);
                return true;
            }
            const m = /^\/accounts\/qr\/([A-Za-z0-9_-]{1,64})(\/events|\/image)?$/.exec(path);
            if (!m) return false;
            const flow = flows.get(m[1]);
            if (!flow) return (send(res, 404, { error: "no such QR flow" }), true);
            if (!m[2]) {
                if (req.method !== "DELETE") return (send(res, 405, { error: "DELETE only" }), true);
                send(res, cancel(flow.id) ? 200 : 409, { flowId: flow.id, cancelled: true });
                return true;
            }
            if (m[2] === "/image") {
                if (!flow.image) return (send(res, 404, { error: "no QR yet" }), true);
                res.status(200).set({ "Content-Type": "image/png", "Cache-Control": "no-store" }).send(flow.image);
                return true;
            }
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            });
            for (const e of flow.events) res.write(`event: ${e.event.slice(3)}\ndata: ${JSON.stringify(e)}\n\n`);
            if (flow.ended) {
                res.end();
                return true;
            }
            flow.clients.add(res);
            req.on("close", () => flow.clients.delete(res));
            return true;
        },
        count: () => [...flows.values()].filter((f) => !f.ended).length,
        stop() {
            for (const id of [...flows.keys()]) cancel(id, "controller stopped");
        },
    };
}
