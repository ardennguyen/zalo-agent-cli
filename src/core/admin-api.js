/**
 * The admin API on the MCP HTTP server: how an operator's console reads and changes the runtime policy
 * (./policy-store.js) and reads storage usage, while the server runs.
 *
 *     GET|PUT|PATCH /zalo/admin/policy                  this server's account
 *     GET|PUT|PATCH /zalo/admin/policy/<ownId>          another account on this host
 *     GET|PUT|PATCH /zalo/admin/policy/tenants/<id>     a tenant (a group of accounts)
 *     GET|PUT|PATCH /zalo/admin/policy/users/<userId>   a user: its tenant, the accounts it owns, its policy
 *     GET           /zalo/admin/presence/always-on      always-on accounts per user and capped tenant, against the caps
 *     GET           /zalo/admin/presence                this server's presence: mode, state, holds (counts only)
 *     POST          /zalo/admin/presence/resume         take the account back after a yield (the user closed the other
 *                                                       session of this login): the admin's explicit confirmation
 *     GET           /zalo/admin/usage                   storage usage of this server's account (and its tenants)
 *     POST|GET|DELETE /zalo/admin/export/<ownId>[/...]    "export my data" jobs and their download links
 *                                                         (src/core/data-export.js)
 *
 * - **Its own credential**, never the agent's: an admin token (`Authorization: Bearer <admin token>`) or a client
 *   certificate (mTLS, `admin.clientCa`). The MCP bearer token, the OAuth client secrets and the access tokens the
 *   server signs are refused here, so an AI agent can never change its own limits. With no admin credential set the
 *   API does not exist (404).
 * - The admin token comes from the key layer (`zalo-agent policy token --rotate`: only its SHA-256 is kept, sealed in
 *   `<configDir>/admin/admin-token.json`), or a file a provider fills (`ZALO_MCP_ADMIN_TOKEN_FILE`, `admin.tokenFile`:
 *   a systemd credential, a KMS-decrypted mount), or `ZALO_MCP_ADMIN_TOKEN` (development).
 * - `If-Match: <rev>` on a write: another rev is 412 and nothing changes. The reply carries `ETag: "<rev>"`.
 * - A key that needs a restart (the port, TLS, the key provider, a secret) is 422 `restartRequired`.
 * - Every write is in the audit log (keys and revs, never a value or a credential).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import { readSealedJson, scopeOfDir, writeSealedJson } from "./keystore/index.js";
import { resolveConfirmMode } from "./confirm-guard.js";
import { resolveApproval, resolveHiddenChats, resolveMediaDelivery, resolveMediaLinkAuth } from "./deploy-policy.js";
import { PolicyError, alwaysOnUsage, applyPolicy, audit, getPolicy, ownerOf, tenantsOf } from "./policy-store.js";
import { resolvePresenceSettings } from "./presence-config.js";
import { envForAccount, resolveWebhookDelivery } from "../mcp/mcp-config.js";

/** Where the admin API is mounted. */
export const ADMIN_PATH_PREFIX = "/zalo/admin";
const TOKEN_SPEC = Object.freeze({ kind: "admin-token", use: "boot" });

const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest();

/** @returns {string} the sealed admin token's folder (its own keyring) */
export function adminDir() {
    return join(CONFIG_DIR, "admin");
}

/** @returns {string} */
export function adminTokenFile() {
    return join(adminDir(), "admin-token.json");
}

/**
 * Make a new admin token: only its SHA-256 is kept (sealed). The token is returned once and never again.
 *
 * @returns {{token: string, createdAt: string}}
 */
export function rotateAdminToken() {
    const token = `zadm_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    mkdirSync(adminDir(), { recursive: true });
    writeSealedJson(adminTokenFile(), scopeOfDir(adminDir()), TOKEN_SPEC, {
        sha256: sha256(token).toString("hex"),
        createdAt,
    });
    audit({ actor: "cli", target: "admin-token", op: "rotate", result: "applied" });
    return { token, createdAt };
}

/**
 * Whether a sealed admin token is set, and since when.
 *
 * @returns {{set: boolean, createdAt: string|null}}
 */
export function adminTokenStatus() {
    if (!existsSync(adminTokenFile())) return { set: false, createdAt: null };
    const rec = readSealedJson(adminTokenFile(), scopeOfDir(adminDir()), TOKEN_SPEC);
    return { set: Boolean(rec?.sha256), createdAt: rec?.createdAt ?? null };
}

let sealedCache = { mtimeMs: -1, hash: null };
/** The sealed token's hash, re-read when the file changes (a rotation counts at once). */
function sealedHash() {
    let st;
    try {
        st = statSync(adminTokenFile());
    } catch {
        sealedCache = { mtimeMs: -1, hash: null };
        return null;
    }
    if (st.mtimeMs !== sealedCache.mtimeMs) {
        try {
            const rec = readSealedJson(adminTokenFile(), scopeOfDir(adminDir()), TOKEN_SPEC);
            sealedCache = { mtimeMs: st.mtimeMs, hash: rec?.sha256 ? Buffer.from(rec.sha256, "hex") : null };
        } catch (e) {
            console.error(`[admin] the sealed admin token cannot be read (${e.message}); it is not accepted`);
            sealedCache = { mtimeMs: st.mtimeMs, hash: null };
        }
    }
    return sealedCache.hash;
}

/**
 * The admin credentials of one server, read at its start (a token file or variable is a bootstrap setting; the sealed
 * token is re-read on each request).
 *
 * @param {object} args
 * @param {{admin?: {tokenFile?: string|null, clientCa?: string|null}}|null} [args.config]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {string} [args.accountId]
 * @returns {{hashes: Buffer[], sources: string[], clientCaFile: string|null, problems: string[]}}
 */
export function resolveAdminCredentials({ config, env = process.env, accountId } = {}) {
    const hashes = [];
    const sources = [];
    const problems = [];
    const tokenFile = envForAccount("ZALO_MCP_ADMIN_TOKEN_FILE", accountId, env) || config?.admin?.tokenFile || null;
    if (tokenFile) {
        try {
            const t = readFileSync(tokenFile, "utf8").trim();
            if (t.length >= 16) {
                hashes.push(sha256(t));
                sources.push("ZALO_MCP_ADMIN_TOKEN_FILE");
            } else problems.push(`the admin token file ${tokenFile} holds fewer than 16 characters; it is not used`);
        } catch (e) {
            problems.push(`the admin token file ${tokenFile} cannot be read (${e.code || e.message})`);
        }
    }
    const direct = envForAccount("ZALO_MCP_ADMIN_TOKEN", accountId, env);
    if (direct) {
        if (direct.length >= 16) {
            hashes.push(sha256(direct));
            sources.push("ZALO_MCP_ADMIN_TOKEN");
        } else problems.push("ZALO_MCP_ADMIN_TOKEN holds fewer than 16 characters; it is not used");
    }
    const clientCaFile = envForAccount("ZALO_MCP_ADMIN_CLIENT_CA", accountId, env) || config?.admin?.clientCa || null;
    return { hashes, sources, clientCaFile, problems };
}

/**
 * The settings in effect for one account, with where each came from: what the admin API answers after a change.
 *
 * @param {string} ownId
 * @param {object} [config] - the MCP config
 * @param {{publicUrl?: string|null, extra?: (ownId: string) => object}} [opts]
 * @returns {object}
 */
export function describeEffective(ownId, config = {}, { publicUrl = null, extra } = {}) {
    const media = resolveMediaDelivery({ config, accountId: ownId });
    const auth = resolveMediaLinkAuth({ config, accountId: ownId, publicUrl });
    const webhook = resolveWebhookDelivery(ownId, config);
    return {
        confirmMode: resolveConfirmMode({ config, accountId: ownId }),
        hiddenChats: resolveHiddenChats({ config, accountId: ownId }),
        approval: resolveApproval({ config, accountId: ownId }),
        media: {
            deliver: media.deliver,
            allowDeliver: media.allowDeliver,
            inlineMaxBytes: media.inlineMaxBytes,
            linkTtlMs: media.linkTtlMs,
            tempfileTtlMs: media.tempfileTtlMs,
            linkRateLimit: media.linkRateLimit,
            linkAuth: auth.linkAuth,
            linkAuthSource: auth.source,
            capability: { maxClients: auth.maxClients, ttlMs: auth.clientTtlMs },
        },
        webhook: { batchSize: webhook.batchSize, maxAgeMs: webhook.maxAgeMs },
        presence: resolvePresenceSettings({ config, accountId: ownId }).settings,
        ...(extra ? extra(ownId) : {}),
    };
}

const STATUS = { INVALID: 400, NOT_FOUND: 404, MEMBERSHIP: 409, CONFLICT: 412, RESTART_REQUIRED: 422, BUSY: 503 };

/**
 * The admin API's request handler (mounted at {@link ADMIN_PATH_PREFIX}, before the MCP bearer check, after a JSON
 * body parser).
 *
 * @param {object} args
 * @param {string} args.ownId - this server's account
 * @param {object} [args.config] - the MCP config (for the effective settings)
 * @param {Buffer[]} [args.hashes] - SHA-256 of each admin token from a file or variable ({@link resolveAdminCredentials})
 * @param {boolean} [args.mtls] - a client certificate the server verified against `admin.clientCa` admits
 * @param {(token: string) => boolean} [args.isAgentCredential] - the MCP server's own check (refused here)
 * @param {() => object} [args.usage] - GET /usage
 * @param {(ownId: string) => object} [args.effectiveExtra] - more effective settings (quota, retention)
 * @param {string|null} [args.publicUrl]
 * @param {{handle: (req: object, res: object, ctx: object) => Promise<void>}|null} [args.exportApi] - the export
 *   routes (src/core/data-export.js createExportApi)
 * @param {((req: object, res: object, ctx: {who: string, ip: string, path: string}) => Promise<boolean>)|null}
 *   [args.routes] - more routes behind the same credential (the fleet controller's `/accounts...` and `/events`);
 *   false: not one of them (404)
 * @param {{serve: (p: {action: string}) => Promise<object>}|null} [args.presence] - this server's on-demand presence
 *   (src/core/daemon-presence.js): `/presence` and `/presence/resume`
 * @param {(line: string) => void} [args.log]
 * @returns {{enabled: () => boolean, handle: (req: object, res: object) => void}}
 */
export function createAdminApi({
    ownId,
    config = {},
    hashes = [],
    mtls = false,
    isAgentCredential = () => false,
    usage = null,
    effectiveExtra,
    publicUrl = null,
    exportApi = null,
    routes = null,
    presence = null,
    log = (l) => console.error(l),
}) {
    const enabled = () => mtls || hashes.length > 0 || Boolean(sealedHash());

    /** Who this request is, or null. Never logs or returns the credential. */
    const admit = (req) => {
        if (mtls && req.socket?.authorized === true && req.socket.getPeerCertificate?.()?.subject) return "mtls";
        const header = String(req.headers?.authorization || "");
        const token = /^bearer\s+/i.test(header) ? header.slice(7).trim() : "";
        if (!token) return null;
        const h = sha256(token);
        const sealed = sealedHash();
        for (const known of sealed ? [sealed, ...hashes] : hashes) {
            if (known.length === h.length && timingSafeEqual(known, h)) return "token";
        }
        return null;
    };

    const send = (res, code, body, headers = {}) => {
        res.status(code)
            .set({ "Cache-Control": "no-store", ...headers })
            .json(body);
    };

    const docReply = (target, doc) => ({
        target: `${target.kind}:${target.id}`,
        rev: doc.rev,
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
        policy: doc.policy,
        ...(target.kind === "account"
            ? {
                  tenants: tenantsOf(target.id).map((t) => t.id),
                  owner: ownerOf(target.id)?.id ?? null,
                  effective: describeEffective(target.id, config, { publicUrl, extra: effectiveExtra }),
              }
            : {}),
        ...(target.kind === "user" ? { tenant: doc.tenant ?? null, accounts: doc.accounts ?? [] } : {}),
    });

    const handle = (req, res) => {
        if (!enabled()) return send(res, 404, { error: "the admin API is not enabled on this server" });
        const ip = req.socket?.remoteAddress || "-";
        const header = String(req.headers?.authorization || "");
        const token = /^bearer\s+/i.test(header) ? header.slice(7).trim() : "";
        // The agent's credential is refused before anything else, even if an admin token was set to the same value.
        const agent = Boolean(token) && (self.isAgentToken(token) || isAgentCredential(token));
        const who = agent ? null : admit(req);
        if (!who) {
            if (agent)
                audit({ actor: `admin-api ${ip}`, target: "admin", op: req.method, result: "agentCredentialRefused" });
            log(
                `[admin] ${req.method} ${ADMIN_PATH_PREFIX}${req.path} refused: ` +
                    `${agent ? "the agent's credential" : "no admin credential"} (ip=${ip})`,
            );
            return send(
                res,
                401,
                {
                    error: agent
                        ? "this is the MCP server's agent credential; the admin API takes its own (an admin token or a client certificate)"
                        : "an admin credential is required",
                },
                { "WWW-Authenticate": 'Bearer realm="zalo-admin"' },
            );
        }
        const path = String(req.path || "/").replace(/\/+$/, "") || "/";
        if (path === "/usage") {
            if (req.method !== "GET") return send(res, 405, { error: "GET only" }, { Allow: "GET" });
            if (!usage) return send(res, 501, { error: "this server does not measure usage" });
            try {
                return send(res, 200, usage());
            } catch (e) {
                return send(res, 500, { error: e.message });
            }
        }
        if (path === "/export" || path.startsWith("/export/")) {
            if (!exportApi) return send(res, 501, { error: "this server does not make exports" });
            exportApi.handle(req, res, { who, ip, path }).catch((e) => {
                log(`[admin] ${req.method} ${path} failed: ${e.message}`);
                if (!res.headersSent) send(res, 500, { error: e.message });
            });
            return;
        }
        if (routes && (path === "/events" || path === "/accounts" || path.startsWith("/accounts/"))) {
            Promise.resolve(routes(req, res, { who, ip, path }))
                .then((handled) => {
                    if (!handled && !res.headersSent) send(res, 404, { error: "not found" });
                })
                .catch((e) => {
                    log(`[admin] ${req.method} ${path} failed: ${e.message}`);
                    if (!res.headersSent) send(res, 500, { error: e.message });
                });
            return;
        }
        if (path === "/presence/always-on") {
            if (req.method !== "GET") return send(res, 405, { error: "GET only" }, { Allow: "GET" });
            return send(res, 200, alwaysOnUsage());
        }
        // This server's on-demand presence (src/core/daemon-presence.js): its state, and the resume after a yield.
        if (path === "/presence" || path === "/presence/resume") {
            if (!presence) return send(res, 404, { error: "this server runs no on-demand presence" });
            const resume = path === "/presence/resume";
            if (req.method !== (resume ? "POST" : "GET"))
                return send(res, 405, { error: resume ? "POST only" : "GET only" }, { Allow: resume ? "POST" : "GET" });
            if (resume) log(`[admin] presence resume of ${ownId} (${who} ${ip})`);
            Promise.resolve(presence.serve({ action: resume ? "resume" : "status" }))
                .then((r) => send(res, 200, r))
                .catch((e) =>
                    send(res, e?.code ? 409 : 500, { error: e.message, ...(e?.code ? { code: e.code } : {}) }),
                );
            return;
        }
        const m = /^\/policy(?:\/tenants\/([^/]+)|\/users\/([^/]+)|\/([^/]+))?$/.exec(path);
        if (!m) return send(res, 404, { error: "not found" });
        const target = m[1]
            ? { kind: "tenant", id: decodeURIComponent(m[1]) }
            : m[2]
              ? { kind: "user", id: decodeURIComponent(m[2]) }
              : { kind: "account", id: m[3] ? decodeURIComponent(m[3]) : ownId };
        try {
            if (req.method === "GET") {
                const doc = getPolicy(target);
                return send(res, 200, docReply(target, doc), { ETag: `"${doc.rev}"` });
            }
            if (req.method !== "PUT" && req.method !== "PATCH")
                return send(res, 405, { error: "GET, PUT or PATCH" }, { Allow: "GET, PUT, PATCH" });
            const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
            if (!body) return send(res, 400, { error: "the body must be a JSON object (the policy, or {policy})" });
            const keys = Object.keys(body);
            // A user's body is {tenant?, accounts?, policy?}; anyone else's is the policy, or {policy}.
            const wrapped =
                target.kind === "user"
                    ? keys.every((k) => ["tenant", "accounts", "policy"].includes(k))
                    : keys.length === 1 && keys[0] === "policy";
            const policy = wrapped ? (body.policy && typeof body.policy === "object" ? body.policy : {}) : body;
            const r = applyPolicy({
                target,
                op: req.method === "PUT" ? "put" : "patch",
                policy,
                ifMatch: req.headers["if-match"] ?? null,
                actor: `admin-api ${who} ${ip}`,
                ...(target.kind === "user" && wrapped && "tenant" in body ? { tenant: body.tenant } : {}),
                ...(target.kind === "user" && wrapped && "accounts" in body ? { accounts: body.accounts } : {}),
            });
            const doc = getPolicy(target);
            log(
                `[admin] ${r.target} rev ${r.oldRev} -> ${r.rev}${r.changed.length ? `: ${r.changed.join(", ")}` : " (no change)"}`,
            );
            if (r.demoted?.length)
                log(`[admin] always-on cap: ${r.demoted.map((d) => `${d.accountId} -> on-demand`).join(", ")}`);
            return send(
                res,
                200,
                { ...docReply(target, doc), changed: r.changed, ...(r.demoted?.length ? { demoted: r.demoted } : {}) },
                { ETag: `"${doc.rev}"` },
            );
        } catch (e) {
            if (!(e instanceof PolicyError)) {
                log(`[admin] ${req.method} ${path} failed: ${e.message}`);
                return send(res, 500, { error: e.message });
            }
            return send(res, STATUS[e.code] ?? 400, {
                error: e.message,
                code: e.code,
                ...(e.errors?.length ? { errors: e.errors } : {}),
                ...(e.restartRequired?.length ? { restartRequired: e.restartRequired } : {}),
                ...(e.code === "CONFLICT" ? { rev: e.rev } : {}),
            });
        }
    };
    // The HTTP transport installs its own check of the agent's credentials here when it mounts the API.
    const self = { enabled, handle, isAgentToken: () => false };
    return self;
}
