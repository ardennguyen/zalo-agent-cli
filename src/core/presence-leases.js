/**
 * CRM leases on an account's socket (on-demand presence, ./presence.js): how a CRM says "a person has this inbox
 * open, keep the account connected" and "they closed it".
 *
 *     POST   /zalo/presence/leases            {holder, ttlSec?} -> 201 {leaseId, expiresAt, state}   (wakes the socket)
 *     PUT    /zalo/presence/leases/<leaseId>  {ttlSec?}         -> 200 {leaseId, expiresAt, state}   (renew; 404 once expired)
 *     DELETE /zalo/presence/leases/<leaseId>                    -> 204                               (release)
 *     GET    /zalo/presence                                     -> {mode, state, holds, leases, ...} (counts only)
 *
 * - Served by the account's own MCP HTTP server behind the agent's bearer token (the one `/events/wait` takes). A
 *   lease cannot change the mode, only hold the socket, so the admin credential is not needed.
 * - `holder` is the CRM's opaque id (`^[A-Za-z0-9_-]{1,64}$`): kept for the lease's life, never logged, never returned
 *   by `GET /zalo/presence` (that shows counts).
 * - TTL default 90 s, at least 15 s, at most 600 s; renew every ttl/3. At most `maxLeases` (64) per account: 429 above.
 * - In memory only: a restart drops every lease, and the CRM's next renew gets 404 and creates a new one.
 * - With no presence (an always-on daemon, or one not wired to presence yet) a lease is accepted and holds nothing:
 *   the socket is connected anyway.
 * - While the account is yielded (another session of the same login holds it) or signed out (Zalo refuses the saved
 *   login), a create or a renew is refused: 409 with `code` YIELDED or SIGNED_OUT. Nothing takes the account back on
 *   a lease; the user resumes it (`presence resume`) or adds it again by QR.
 */
import { randomBytes } from "node:crypto";

/** The CRM's opaque holder id. */
export const HOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The lease time-to-live bounds, in seconds (the plan's section 4). */
export const LEASE_TTL = Object.freeze({ defaultSec: 90, minSec: 15, maxSec: 600 });

/** Where the routes are mounted. */
export const PRESENCE_PATH_PREFIX = "/zalo/presence";

/** A lease request that cannot be served: `code` is INVALID, NOT_FOUND, TOO_MANY, YIELDED or SIGNED_OUT. */
export class LeaseError extends Error {
    /**
     * @param {string} message
     * @param {"INVALID"|"NOT_FOUND"|"TOO_MANY"|"YIELDED"|"SIGNED_OUT"} code
     */
    constructor(message, code) {
        super(message);
        this.name = "LeaseError";
        this.code = code;
    }
}

const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    },
    clearTimeout: (t) => clearTimeout(t),
};

/**
 * One account's leases.
 *
 * @param {object} [args]
 * @param {{hold: Function, state: string, settings?: object}|null} [args.presence] - the daemon's presence (null: no
 *   presence, every lease is a no-op hold)
 * @param {number} [args.maxLeases]
 * @param {number} [args.defaultTtlSec]
 * @param {number} [args.maxTtlSec]
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}} [args.clock]
 * @param {() => string} [args.makeId]
 * @returns {object}
 */
export function createLeaseStore({
    presence = null,
    maxLeases = presence?.settings?.maxLeases ?? 64,
    defaultTtlSec = Math.round((presence?.settings?.leaseTtlMs ?? LEASE_TTL.defaultSec * 1000) / 1000),
    maxTtlSec = Math.round((presence?.settings?.leaseTtlMaxMs ?? LEASE_TTL.maxSec * 1000) / 1000),
    clock = realClock,
    makeId = () => `pl_${randomBytes(16).toString("base64url")}`,
} = {}) {
    const leases = new Map();

    const ttlOf = (raw) => {
        if (raw === undefined || raw === null || raw === "") return defaultTtlSec;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < LEASE_TTL.minSec || n > maxTtlSec)
            throw new LeaseError(`ttlSec must be a whole number from ${LEASE_TTL.minSec} to ${maxTtlSec}`, "INVALID");
        return n;
    };

    function drop(id) {
        const l = leases.get(id);
        if (!l) return false;
        clock.clearTimeout(l.timer);
        leases.delete(id);
        l.hold?.release();
        return true;
    }

    function arm(l, ttlSec) {
        clock.clearTimeout(l.timer);
        l.expiresAt = clock.now() + ttlSec * 1000;
        l.timer = clock.setTimeout(() => drop(l.id), ttlSec * 1000);
    }

    /** Yielded or signed out: the account takes no lease (owner decision 2026-11-08). */
    const refuse = () => {
        const r = presence?.refusal?.();
        if (r) throw new LeaseError(r.message, r.code);
    };

    const view = (l) => ({
        leaseId: l.id,
        expiresAt: new Date(l.expiresAt).toISOString(),
        state: presence?.state ?? "connected",
    });

    return {
        /**
         * @param {{holder: string, ttlSec?: number}} body
         * @returns {{leaseId: string, expiresAt: string, state: string}}
         */
        create(body) {
            const holder = typeof body?.holder === "string" ? body.holder : "";
            if (!HOLDER_ID.test(holder))
                throw new LeaseError("holder must be an opaque id (letters, digits, - and _; at most 64)", "INVALID");
            const ttlSec = ttlOf(body?.ttlSec);
            refuse();
            if (leases.size >= maxLeases)
                throw new LeaseError(`this account already has ${maxLeases} leases; release one first`, "TOO_MANY");
            const l = {
                id: makeId(),
                holder,
                expiresAt: 0,
                timer: null,
                hold: presence ? presence.hold("lease") : null,
            };
            leases.set(l.id, l);
            arm(l, ttlSec);
            return view(l);
        },

        /** @returns {{leaseId: string, expiresAt: string, state: string}} */
        renew(id, body) {
            const l = leases.get(String(id));
            if (!l) throw new LeaseError("no such lease (expired or released): create a new one", "NOT_FOUND");
            refuse();
            arm(l, ttlOf(body?.ttlSec));
            return view(l);
        },

        /** @returns {boolean} */
        release(id) {
            if (!drop(String(id))) throw new LeaseError("no such lease (expired or released)", "NOT_FOUND");
            return true;
        },

        /** How many leases are open. */
        count: () => leases.size,

        /** Drop every lease (the daemon is shutting down). */
        stop() {
            for (const id of [...leases.keys()]) drop(id);
        },
    };
}

const STATUS = { INVALID: 400, NOT_FOUND: 404, TOO_MANY: 429, YIELDED: 409, SIGNED_OUT: 409 };

/**
 * The routes under {@link PRESENCE_PATH_PREFIX}, for an express app, behind the agent's bearer check.
 *
 * @param {object} args
 * @param {ReturnType<typeof createLeaseStore>} args.store
 * @param {() => object|null} [args.describe] - the presence snapshot (null: an always-on daemon)
 * @param {(line: string) => void} [args.log]
 * @returns {{handle: (req: object, res: object) => void}}
 */
export function createLeaseRoutes({ store, describe = () => null, log = () => {} }) {
    const send = (res, code, body) => {
        res.status(code).set({ "Cache-Control": "no-store" });
        return body === undefined ? res.end() : res.json(body);
    };
    return {
        handle(req, res) {
            const path = String(req.path || "/").replace(/\/+$/, "") || "/";
            const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
            try {
                if (path === "/") {
                    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
                    const snap = describe() ?? { mode: "always-on", state: "connected", holds: {} };
                    return send(res, 200, { ...snap, leases: store.count() });
                }
                if (path === "/leases") {
                    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
                    const lease = store.create(body);
                    log(`[presence] lease created (${store.count()} open)`);
                    return send(res, 201, lease);
                }
                const m = /^\/leases\/([A-Za-z0-9_-]{1,64})$/.exec(path);
                if (!m) return send(res, 404, { error: "not found" });
                if (req.method === "PUT") return send(res, 200, store.renew(m[1], body));
                if (req.method === "DELETE") {
                    store.release(m[1]);
                    log(`[presence] lease released (${store.count()} open)`);
                    return send(res, 204);
                }
                return send(res, 405, { error: "PUT or DELETE" });
            } catch (e) {
                if (!(e instanceof LeaseError)) return send(res, 500, { error: e.message });
                return send(res, STATUS[e.code] ?? 400, { error: e.message, code: e.code });
            }
        },
    };
}
