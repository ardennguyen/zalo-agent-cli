/**
 * The access and secrets of one account, for an operator's console: what may reach the account's MCP server and with
 * which secrets. Served by the admin API (./admin-api.js) behind the admin credential, on the fleet controller and on
 * each daemon's HTTP server alike: every route reads and writes the account's files, and a running daemon picks each
 * change up at its next request (no restart).
 *
 *     GET    /access/<ownId>                              everything below at once (no secret, no hash)
 *     GET    /access/<ownId>/oauth/settings               {mode, source, approverSet, publicUrl}
 *     PUT    /access/<ownId>/oauth/settings               {mode: off|automatic|specific}, applied live
 *     GET    /access/<ownId>/oauth/clients                OAuth clients: configured, registered and made here
 *     POST   /access/<ownId>/oauth/clients                {name, clientId?, redirectUris} -> 201, the secret once
 *     DELETE /access/<ownId>/oauth/clients/<clientId>     remove a registered or made client and its grants
 *     GET    /access/<ownId>/oauth/grants                 live grants (token families)
 *     DELETE /access/<ownId>/oauth/grants/<grantId>       revoke one grant: its refresh and access tokens stop
 *     POST   /access/<ownId>/oauth/revoke-all             {clientId?} revoke every grant (of one client)
 *     GET    /access/<ownId>/api-keys                     named keys: id, label, dates
 *     POST   /access/<ownId>/api-keys                     {label, expiresAt?} -> 201, the key shown once
 *     DELETE /access/<ownId>/api-keys/<keyId>             revoke one key
 *     PUT    /access/<ownId>/webhook                      {url|null}: the account's `webhook` policy key
 *     POST   /access/<ownId>/webhook/secret               rotate: the new signing secret shown once
 *     DELETE /access/<ownId>/webhook/secret               back to the flag, environment or config secret
 *     POST   /access/<ownId>/webhook/test                 send one signed `webhook_test` event now
 *     PUT    /access/<ownId>/approver                     {password}: set the approver password (hashed)
 *     DELETE /access/<ownId>/approver                     clear it
 *     GET    /access/<ownId>/agents                       the account's agents (routing.agents), their presence and
 *                                                  marks, and its credentials with the agent each is bound to
 *     POST   /access/<ownId>/routing                      {action, ...}: the running daemon's routing for the console:
 *                                                  events, claims (release, assign, human, endHuman), the staff
 *                                                  inbox (inbox, thread, claim, unclaim, send); 409 when no daemon
 *     POST   /access/<ownId>/route-test                   {message, routing?, agents?}: who would get the message and
 *                                                  why (the routes as saved, or the unsaved ones given); changes nothing
 *     GET    /access/<ownId>/cloud-key                    whether a zCloud key is stored (never the key)
 *     DELETE /access/<ownId>/cloud-key                    delete it
 *
 * Every change is one line in the policy audit log (./policy-store.js audit): the account, an action code and the id it
 * touched, never a value. Every refusal carries a stable `code` beside the English `error`.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAccountDir } from "./credentials.js";
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey } from "./api-keys.js";
import { approverPasswordProblem, approverStatus, removeApproverPassword, setApproverPassword } from "./approval.js";
import { cloudKeyStatus, forgetCloudKey } from "./cloud-key-store.js";
import { PolicyError, applyPolicy, audit } from "./policy-store.js";
import { clearWebhookSecret, readWebhookSecret, rotateWebhookSecret, webhookSecretStatus } from "./webhook-secret.js";
import { describeWebhookUrl, webhookHeaders } from "./webhook-outbox.js";
import { envForAccount, resolvePrimaryOAuthClient, resolveWebhookUrl } from "../mcp/mcp-config.js";
import { resolvePublicUrl } from "./deploy-policy.js";
import { agentsReport, resolveRouting } from "../mcp/agents.js";
import { checkRouting, decide } from "./message-router.js";
import { checkAgents } from "./routing-policy.js";
import { callViaDaemon } from "./daemon-channel.js";
import {
    MAX_ACCOUNT_CLIENTS,
    OAUTH_STATE_FILE,
    configuredOAuthClients,
    createOAuthStore,
    hashClientSecret,
    redirectUriProblem,
} from "../mcp/mcp-oauth.js";
import {
    OAUTH_MODES,
    configDynamicRegistration,
    defaultOAuthMode,
    readOAuthSettings,
    writeOAuthSettings,
} from "../mcp/oauth-settings.js";

const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;
/** What the console may ask a daemon's Message Router (src/mcp/router-runtime.js `serve`). */
const ROUTING_ACTIONS = Object.freeze([
    "events",
    "claims",
    "release",
    "assign",
    "human",
    "endHuman",
    "inbox",
    "thread",
    "claim",
    "unclaim",
    "send",
]);
/** A client id the owner chooses for a client made here. */
const NEW_CLIENT_ID = /^[A-Za-z0-9._-]{3,64}$/;

/**
 * @param {object} [args]
 * @param {object} [args.config] - the MCP config: its configured OAuth clients, its webhook URL and secret fallbacks
 * @param {(ownId: string) => Record<string, string>} [args.accountEnv] - the account's own environment (the fleet's
 *   `<envDir>/<ownId>.env`), read for the legacy token and the webhook's environment fallbacks
 * @param {(ownId: string) => string|null|undefined} [args.publicUrlOf] - the account's publicUrl as its server knows it
 *   (a daemon passes its own, which may come from a flag); undefined falls back to the environment and config
 * @param {typeof fetch} [args.fetchFn]
 * @param {(ownId: string, path: string, params: object) => Promise<object|null>} [args.relay] - the account's running
 *   daemon (its channel); null answer: no daemon runs
 * @param {(line: string) => void} [args.log]
 * @returns {{handle: (req: object, res: object, ctx: {who: string, ip: string, path: string}) => Promise<boolean>}}
 */
export function createAccessApi({
    config = {},
    accountEnv = () => ({}),
    publicUrlOf = () => undefined,
    fetchFn = fetch,
    relay = (ownId, path, params) => callViaDaemon(getAccountDir(ownId), path, params),
    log = () => {},
} = {}) {
    const send = (res, code, body) => {
        res.status(code).set({ "Cache-Control": "no-store" }).json(body);
        return true;
    };
    const fail = (res, status, code, error, extra = {}) => send(res, status, { error, code, ...extra });
    const envOf = (ownId) => ({ ...process.env, ...(accountEnv(ownId) ?? {}) });

    const oauthOf = (dir) => createOAuthStore({ file: join(dir, OAUTH_STATE_FILE) });
    // The account's configured clients as its daemon serves them: the primary one from its own environment
    // (`ZALO_MCP_OAUTH_CLIENT_ID_<ownId>`, the env dir's file, then mcp-config.json), plus `oauth.clients[]`.
    const configured = (ownId) => [
        ...configuredOAuthClients({
            ...(config?.oauth ?? {}),
            ...resolvePrimaryOAuthClient({ config, accountId: ownId, env: envOf(ownId) }),
        }).clients.values(),
    ];

    function clientsOf(ownId, dir) {
        return [
            ...configured(ownId).map((c) => ({
                clientId: c.clientId,
                name: c.name ?? null,
                redirectUris: c.redirectUris,
                confidential: Boolean(c.secret),
                kind: "configured",
                source: "config",
            })),
            ...oauthOf(dir)
                .listClients()
                .map((c) => ({ ...c, kind: c.source === "account" ? "account" : "registered" })),
        ];
    }

    /** The account's publicUrl: what its server says, else its environment and the config; null when none. */
    function publicUrlFor(ownId) {
        const known = publicUrlOf(ownId);
        if (known !== undefined) return known || null;
        const r = resolvePublicUrl({ config, env: envOf(ownId), accountId: ownId, note: () => {} });
        return r.error ? null : r.publicUrl;
    }

    /** The account's OAuth mode, where it comes from, and what turning it on needs. */
    function oauthSettingsView(ownId, dir) {
        const savedMode = readOAuthSettings(dir);
        const mode =
            savedMode?.mode ??
            defaultOAuthMode({
                dynamic: configDynamicRegistration({ config, accountId: ownId, env: envOf(ownId) }),
                configuredClients: configured(ownId).length,
            });
        return {
            mode,
            source: savedMode ? "account" : "config",
            approverSet: Boolean(approverStatus(dir).set),
            publicUrl: publicUrlFor(ownId),
        };
    }

    /** Make a confidential client for this account: its secret is returned once, only its hash is kept. */
    function createClient(ownId, dir, body) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (name.length < 1 || name.length > 60) return { error: [400, "INVALID_NAME", "name: 1 to 60 characters"] };
        let clientId = body.clientId;
        if (clientId !== undefined && clientId !== null && clientId !== "") {
            if (typeof clientId !== "string" || !NEW_CLIENT_ID.test(clientId))
                return { error: [400, "INVALID_CLIENT_ID", "clientId: 3 to 64 characters of A-Z a-z 0-9 . _ -"] };
        } else clientId = null;
        const uris = body.redirectUris;
        if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10)
            return { error: [400, "INVALID_REDIRECT_URIS", "redirectUris: 1 to 10 https URLs"] };
        for (const u of uris) {
            const why =
                typeof u === "string" && !u.startsWith("https://") ? "it must be an https URL" : redirectUriProblem(u);
            if (why)
                return { error: [400, "INVALID_REDIRECT_URIS", `redirectUris: ${why}: ${String(u).slice(0, 200)}`] };
        }
        const store = oauthOf(dir);
        const taken = (id) => configured(ownId).some((c) => c.clientId === id) || Boolean(store.client(id));
        if (clientId && taken(clientId))
            return { error: [409, "CLIENT_EXISTS", `an OAuth client ${clientId} already exists on this account`] };
        if (store.accountClientCount() >= MAX_ACCOUNT_CLIENTS)
            return { error: [409, "CLIENT_LIMIT", `at most ${MAX_ACCOUNT_CLIENTS} clients can be made per account`] };
        while (!clientId || taken(clientId)) clientId = `app_${randomBytes(12).toString("hex")}`;
        const clientSecret = `zmcp_cs_${randomBytes(32).toString("base64url")}`;
        const createdAt = new Date().toISOString();
        store.addClient({
            clientId,
            name,
            authMethod: "client_secret_post",
            redirectUris: [...uris],
            secretHash: hashClientSecret(clientSecret),
            createdAt,
            lastUsedAt: null,
            source: "account",
        });
        return { made: { clientId, clientSecret, name, redirectUris: [...uris], createdAt } };
    }

    function webhookView(ownId, dir) {
        const env = envOf(ownId);
        const url = resolveWebhookUrl({ accountId: ownId, config, env });
        const admin = webhookSecretStatus(dir);
        const fallback = envForAccount("ZALO_WEBHOOK_SECRET", ownId, env) || config?.webhookSecret || null;
        return {
            url: url ? describeWebhookUrl(url) : null,
            secret: {
                source: admin.set ? "admin" : fallback ? "environment-or-config" : null,
                rotatedAt: admin.rotatedAt,
            },
        };
    }

    function summary(ownId, dir) {
        const cloud = cloudKeyStatus(ownId);
        return {
            accountId: ownId,
            apiKeys: listApiKeys(dir),
            legacyToken: { set: Boolean(envForAccount("ZALO_MCP_AUTH_TOKEN", ownId, envOf(ownId))) },
            oauth: {
                settings: oauthSettingsView(ownId, dir),
                clients: clientsOf(ownId, dir),
                grants: oauthOf(dir).listGrants(),
            },
            webhook: webhookView(ownId, dir),
            approver: approverStatus(dir),
            cloudKey: {
                stored: cloud.stored,
                locked: cloud.locked,
                keyVersion: cloud.keyVersion,
                savedAt: cloud.savedAt ? new Date(cloud.savedAt).toISOString() : null,
            },
        };
    }

    const note = (ctx, ownId, op, id = null, result = "applied") =>
        audit({
            actor: `admin-api ${ctx.who} ${ctx.ip}`,
            target: `account:${ownId}`,
            op,
            ...(id ? { id } : {}),
            result,
        });

    async function testWebhook(ownId, dir) {
        const env = envOf(ownId);
        const url = resolveWebhookUrl({ accountId: ownId, config, env });
        if (!url) return null;
        let secret = null;
        try {
            secret = readWebhookSecret(dir)?.secret ?? null;
        } catch {
            secret = null;
        }
        secret = secret || envForAccount("ZALO_WEBHOOK_SECRET", ownId, env) || config?.webhookSecret || null;
        const body = JSON.stringify({ event: "webhook_test", accountId: ownId, at: new Date().toISOString() });
        const started = Date.now();
        try {
            const r = await fetchFn(url, {
                method: "POST",
                headers: webhookHeaders(body, secret),
                body,
                signal: AbortSignal.timeout(10_000),
            });
            return { delivered: r.ok, status: r.status, signed: Boolean(secret), ms: Date.now() - started };
        } catch (e) {
            return {
                delivered: false,
                status: null,
                signed: Boolean(secret),
                ms: Date.now() - started,
                reason: e?.name === "TimeoutError" ? "timeout" : "unreachable",
            };
        }
    }

    /**
     * Serve `/access/...` (already authorized). False for any other path.
     *
     * @param {object} req
     * @param {object} res
     * @param {{who: string, ip: string, path: string}} ctx
     * @returns {Promise<boolean>}
     */
    async function handle(req, res, ctx) {
        const m = /^\/access\/([^/]+)(\/.*)?$/.exec(ctx.path);
        if (!m) return false;
        const ownId = decodeURIComponent(m[1]);
        if (!ACCOUNT_ID.test(ownId)) return fail(res, 400, "INVALID_ACCOUNT_ID", "not an account id");
        const dir = getAccountDir(ownId);
        if (!existsSync(dir)) return fail(res, 404, "ACCOUNT_NOT_FOUND", `account ${ownId} has no folder on this host`);
        const rest = m[2] ?? "";
        const method = req.method;
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        const only = (...allowed) =>
            allowed.includes(method)
                ? false
                : (res.set("Allow", allowed.join(", ")),
                  fail(res, 405, "METHOD_NOT_ALLOWED", `${allowed.join(" or ")} only`));

        try {
            if (rest === "") return only("GET") || send(res, 200, summary(ownId, dir));

            // ── OAuth ──
            if (rest === "/oauth/settings") {
                if (only("GET", "PUT")) return true;
                if (method === "GET") return send(res, 200, oauthSettingsView(ownId, dir));
                const mode = body.mode;
                if (!OAUTH_MODES.includes(mode))
                    return fail(res, 400, "INVALID_OAUTH_MODE", `mode is one of ${OAUTH_MODES.join(", ")}`);
                if (mode !== "off") {
                    if (!approverStatus(dir).set)
                        return fail(
                            res,
                            409,
                            "APPROVER_REQUIRED",
                            "connecting an app asks the owner for the approver password: set one first (PUT approver)",
                        );
                    if (!publicUrlFor(ownId))
                        return fail(
                            res,
                            409,
                            "PUBLIC_URL_REQUIRED",
                            "OAuth needs a fixed issuer: set the account's publicUrl first",
                        );
                }
                writeOAuthSettings(dir, mode);
                note(ctx, ownId, `oauth.mode.${mode}`);
                return send(res, 200, oauthSettingsView(ownId, dir));
            }
            if (rest === "/oauth/clients") {
                if (only("GET", "POST")) return true;
                if (method === "GET") return send(res, 200, { clients: clientsOf(ownId, dir) });
                const out = createClient(ownId, dir, body);
                if (out.error) return fail(res, ...out.error);
                note(ctx, ownId, "oauth.client.create", out.made.clientId);
                log(`[admin] OAuth client ${out.made.clientId} made for ${ownId} (${ctx.who} ${ctx.ip})`);
                return send(res, 201, out.made);
            }
            let r = /^\/oauth\/clients\/([^/]+)$/.exec(rest);
            if (r) {
                if (only("DELETE")) return true;
                const clientId = decodeURIComponent(r[1]);
                if (!ID.test(clientId)) return fail(res, 400, "INVALID_CLIENT_ID", "not a client id");
                const n = oauthOf(dir).removeClient(clientId);
                if (n < 0) {
                    if (configured(ownId).some((c) => c.clientId === clientId))
                        return fail(
                            res,
                            409,
                            "CLIENT_CONFIGURED",
                            "this client comes from the server's configuration (oauth.clients): remove it there; " +
                                "its grants can be revoked with oauth/revoke-all {clientId}",
                        );
                    return fail(res, 404, "CLIENT_NOT_FOUND", `no OAuth client ${clientId} on this account`);
                }
                note(ctx, ownId, "oauth.client.remove", clientId);
                return send(res, 200, { clientId, removed: true, grantsRevoked: n });
            }
            // ── Agents (the Message Router's free part): read-only here, set through the policy ──
            if (rest === "/agents") {
                if (only("GET")) return true;
                const credentials = [
                    ...listApiKeys(dir).map((k) => ({
                        credential: `apikey:${k.keyId}`,
                        label: k.label,
                        kind: "mcp-key",
                        expired: k.expired,
                    })),
                    ...clientsOf(ownId, dir).map((c) => ({
                        credential: `oauth:${c.clientId}`,
                        label: c.name ?? c.clientId,
                        kind: "mcp-oauth",
                    })),
                ];
                return send(res, 200, agentsReport({ accountId: ownId, accountDir: dir, config, credentials }));
            }
            if (rest === "/routing") {
                if (only("POST")) return true;
                const action = typeof body.action === "string" ? body.action : "";
                if (!ROUTING_ACTIONS.includes(action))
                    return fail(res, 400, "INVALID_ROUTING_ACTION", `action is one of ${ROUTING_ACTIONS.join(", ")}`);
                const params = { action };
                for (const k of ["threadId", "to", "staff", "text", "threadType", "bootId"])
                    if (typeof body[k] === "string") params[k] = body[k];
                for (const k of ["since", "limit", "minutes"]) if (Number.isInteger(body[k])) params[k] = body[k];
                const r = await relay(ownId, "/routing", params);
                if (!r) return fail(res, 409, "DAEMON_NOT_RUNNING", "the account's daemon is not running");
                if (!r.ok) return fail(res, 409, "ROUTING_REFUSED", r.error || "the daemon refused the request");
                const out = { ...r };
                delete out.ok;
                if (out.refused) return fail(res, 409, out.code || "ROUTING_REFUSED", out.message || "refused", out);
                if (!["events", "claims", "inbox", "thread"].includes(action)) note(ctx, ownId, `routing.${action}`);
                return send(res, 200, out);
            }
            if (rest === "/route-test") {
                if (only("POST")) return true;
                const saved = resolveRouting({ config, accountId: ownId });
                let cfg = saved.cfg;
                let agents = saved.agents;
                if (body.routing && typeof body.routing === "object") {
                    const c = checkRouting({ ...body.routing, enabled: true });
                    if (c.error) return fail(res, 400, "INVALID_ROUTING", c.error);
                    cfg = c.value;
                }
                if (Array.isArray(body.agents)) {
                    const a = checkAgents(body.agents);
                    if (a.error) return fail(res, 400, "INVALID_AGENTS", a.error);
                    agents = a.value;
                }
                const m = body.message && typeof body.message === "object" ? body.message : {};
                if (typeof m.threadId !== "string" || !m.threadId)
                    return fail(res, 400, "INVALID_MESSAGE", "message.threadId is required");
                const at = typeof body.at === "string" && Date.parse(body.at) ? Date.parse(body.at) : Date.now();
                const d = decide(
                    {
                        threadId: m.threadId,
                        threadType: m.threadType === "group" ? "group" : "dm",
                        senderId: typeof m.senderId === "string" ? m.senderId : null,
                        isSelf: m.fromOwner === true,
                        text: typeof m.text === "string" ? m.text.slice(0, 4000) : "",
                        type: typeof m.kind === "string" ? m.kind : "text",
                        replyTo: null,
                    },
                    {
                        cfg,
                        agents,
                        now: at,
                        myDocuments: m.myDocuments === true,
                        labelsOf: () => (Array.isArray(m.labels) ? m.labels.map(String) : []),
                    },
                );
                return send(res, 200, {
                    to: d.to,
                    by: d.by,
                    ruleId: d.ruleId,
                    observers: d.observers,
                    ownership: d.ownership,
                    text: d.text ?? null,
                    trace: d.trace,
                });
            }
            if (rest === "/oauth/grants") return only("GET") || send(res, 200, { grants: oauthOf(dir).listGrants() });
            r = /^\/oauth\/grants\/([^/]+)$/.exec(rest);
            if (r) {
                if (only("DELETE")) return true;
                const grantId = decodeURIComponent(r[1]);
                if (!/^[0-9a-f]{24}$/.test(grantId) || !oauthOf(dir).revokeFamily(grantId))
                    return fail(res, 404, "GRANT_NOT_FOUND", `no grant ${grantId} on this account`);
                note(ctx, ownId, "oauth.grant.revoke", grantId);
                return send(res, 200, { grantId, revoked: true });
            }
            if (rest === "/oauth/revoke-all") {
                if (only("POST")) return true;
                const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
                if (clientId !== null && !ID.test(clientId))
                    return fail(res, 400, "INVALID_CLIENT_ID", "not a client id");
                const n = oauthOf(dir).revokeAll({ clientId });
                note(ctx, ownId, "oauth.grant.revokeAll", clientId);
                return send(res, 200, { revoked: n, ...(clientId ? { clientId } : {}) });
            }

            // ── API keys ──
            if (rest === "/api-keys") {
                if (only("GET", "POST")) return true;
                if (method === "GET") return send(res, 200, { keys: listApiKeys(dir) });
                const made = createApiKey(dir, { label: body.label, expiresAt: body.expiresAt ?? null });
                note(ctx, ownId, "apiKey.create", made.keyId);
                log(`[admin] API key ${made.keyId} made for ${ownId} (${ctx.who} ${ctx.ip})`);
                return send(res, 201, made);
            }
            r = /^\/api-keys\/([^/]+)$/.exec(rest);
            if (r) {
                if (only("DELETE")) return true;
                const keyId = decodeURIComponent(r[1]);
                if (!/^[0-9a-f]{12}$/.test(keyId))
                    return fail(res, 404, "API_KEY_NOT_FOUND", `no API key ${keyId} on this account`);
                const out = revokeApiKey(dir, keyId);
                note(ctx, ownId, "apiKey.revoke", keyId);
                return send(res, 200, out);
            }

            // ── Webhook ──
            if (rest === "/webhook") {
                if (only("GET", "PUT")) return true;
                if (method === "GET") return send(res, 200, webhookView(ownId, dir));
                if (!("url" in body))
                    return fail(res, 400, "INVALID_BODY", 'the body is {"url": "<https URL>"} or {"url": null}');
                applyPolicy({
                    target: { kind: "account", id: ownId },
                    op: "patch",
                    policy: { webhook: body.url === "" ? null : body.url },
                    actor: `admin-api ${ctx.who} ${ctx.ip}`,
                });
                return send(res, 200, webhookView(ownId, dir));
            }
            if (rest === "/webhook/secret") {
                if (only("POST", "DELETE")) return true;
                if (method === "POST") {
                    const out = rotateWebhookSecret(dir);
                    note(ctx, ownId, "webhook.secret.rotate");
                    return send(res, 200, out);
                }
                const had = clearWebhookSecret(dir);
                if (!had)
                    return fail(res, 404, "WEBHOOK_SECRET_NOT_SET", "no admin-set webhook secret on this account");
                note(ctx, ownId, "webhook.secret.clear");
                return send(res, 200, { cleared: true });
            }
            if (rest === "/webhook/test") {
                if (only("POST")) return true;
                const out = await testWebhook(ownId, dir);
                if (!out) return fail(res, 409, "WEBHOOK_NOT_SET", "this account has no webhook URL");
                note(ctx, ownId, "webhook.test", null, out.delivered ? "delivered" : "failed");
                return send(res, 200, out);
            }

            // ── Approver password ──
            if (rest === "/approver") {
                if (only("GET", "PUT", "DELETE")) return true;
                if (method === "GET") return send(res, 200, approverStatus(dir));
                if (method === "PUT") {
                    const problem =
                        typeof body.password === "string" ? approverPasswordProblem(body.password) : "password missing";
                    if (problem) return fail(res, 400, "APPROVER_PASSWORD_INVALID", problem);
                    const out = setApproverPassword(dir, body.password);
                    note(ctx, ownId, "approver.set");
                    return send(res, 200, { set: true, setAt: out.setAt });
                }
                if (!removeApproverPassword(dir))
                    return fail(res, 404, "APPROVER_NOT_SET", "this account has no approver password");
                note(ctx, ownId, "approver.clear");
                return send(res, 200, { cleared: true });
            }

            // ── zCloud key ──
            if (rest === "/cloud-key") {
                if (only("GET", "DELETE")) return true;
                const st = cloudKeyStatus(ownId);
                if (method === "GET")
                    return send(res, 200, {
                        stored: st.stored,
                        locked: st.locked,
                        keyVersion: st.keyVersion,
                        savedAt: st.savedAt ? new Date(st.savedAt).toISOString() : null,
                    });
                if (!forgetCloudKey(ownId))
                    return fail(res, 404, "CLOUD_KEY_NOT_FOUND", "this account has no stored cloud key");
                note(ctx, ownId, "cloudKey.delete");
                return send(res, 200, { deleted: true });
            }
            return fail(res, 404, "NOT_FOUND", "not found");
        } catch (e) {
            if (e instanceof ApiKeyError)
                return fail(
                    res,
                    e.code === "API_KEY_NOT_FOUND" ? 404 : e.code === "API_KEY_LIMIT" ? 409 : 400,
                    e.code,
                    e.message,
                );
            if (e instanceof PolicyError)
                return fail(
                    res,
                    e.code === "INVALID" ? 400 : 409,
                    e.code,
                    e.message,
                    e.errors?.length ? { errors: e.errors } : {},
                );
            log(`[admin] ${method} ${ctx.path} failed: ${e.message}`);
            return fail(res, 500, "INTERNAL", "the request failed on the server");
        }
    }

    return { handle };
}
