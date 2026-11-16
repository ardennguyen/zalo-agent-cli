/**
 * The access and secrets of one account, for an operator's console: what may reach the account's MCP server and with
 * which secrets. Served by the admin API (./admin-api.js) behind the admin credential, on the fleet controller and on
 * each daemon's HTTP server alike: every route reads and writes the account's files, and a running daemon picks each
 * change up at its next request (no restart).
 *
 *     GET    /access/<ownId>                              everything below at once (no secret, no hash)
 *     GET    /access/<ownId>/oauth/clients                OAuth clients: registered and configured
 *     DELETE /access/<ownId>/oauth/clients/<clientId>     remove a registered client and every grant it holds
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
 *     GET    /access/<ownId>/cloud-key                    whether a zCloud key is stored (never the key)
 *     DELETE /access/<ownId>/cloud-key                    delete it
 *
 * Every change is one line in the policy audit log (./policy-store.js audit): the account, an action code and the id it
 * touched, never a value. Every refusal carries a stable `code` beside the English `error`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAccountDir } from "./credentials.js";
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey } from "./api-keys.js";
import { approverPasswordProblem, approverStatus, removeApproverPassword, setApproverPassword } from "./approval.js";
import { cloudKeyStatus, forgetCloudKey } from "./cloud-key-store.js";
import { PolicyError, applyPolicy, audit } from "./policy-store.js";
import { clearWebhookSecret, readWebhookSecret, rotateWebhookSecret, webhookSecretStatus } from "./webhook-secret.js";
import { describeWebhookUrl, webhookHeaders } from "./webhook-outbox.js";
import { envForAccount, resolveWebhookUrl } from "../mcp/mcp-config.js";
import { OAUTH_STATE_FILE, configuredOAuthClients, createOAuthStore } from "../mcp/mcp-oauth.js";

const ACCOUNT_ID = /^[1-9][0-9]{0,30}$/;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * @param {object} [args]
 * @param {object} [args.config] - the MCP config: its configured OAuth clients, its webhook URL and secret fallbacks
 * @param {(ownId: string) => Record<string, string>} [args.accountEnv] - the account's own environment (the fleet's
 *   `<envDir>/<ownId>.env`), read for the legacy token and the webhook's environment fallbacks
 * @param {typeof fetch} [args.fetchFn]
 * @param {(line: string) => void} [args.log]
 * @returns {{handle: (req: object, res: object, ctx: {who: string, ip: string, path: string}) => Promise<boolean>}}
 */
export function createAccessApi({ config = {}, accountEnv = () => ({}), fetchFn = fetch, log = () => {} } = {}) {
    const send = (res, code, body) => {
        res.status(code).set({ "Cache-Control": "no-store" }).json(body);
        return true;
    };
    const fail = (res, status, code, error, extra = {}) => send(res, status, { error, code, ...extra });
    const envOf = (ownId) => ({ ...process.env, ...(accountEnv(ownId) ?? {}) });

    const oauthOf = (dir) => createOAuthStore({ file: join(dir, OAUTH_STATE_FILE) });
    const configured = () => [...configuredOAuthClients(config?.oauth ?? null).clients.values()];

    function clientsOf(dir) {
        return [
            ...configured().map((c) => ({
                clientId: c.clientId,
                name: c.name ?? null,
                redirectUris: c.redirectUris,
                confidential: Boolean(c.secret),
                kind: "configured",
            })),
            ...oauthOf(dir)
                .listClients()
                .map((c) => ({ ...c, kind: "registered" })),
        ];
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
            oauth: { clients: clientsOf(dir), grants: oauthOf(dir).listGrants() },
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
            if (rest === "/oauth/clients") return only("GET") || send(res, 200, { clients: clientsOf(dir) });
            let r = /^\/oauth\/clients\/([^/]+)$/.exec(rest);
            if (r) {
                if (only("DELETE")) return true;
                const clientId = decodeURIComponent(r[1]);
                if (!ID.test(clientId)) return fail(res, 400, "INVALID_CLIENT_ID", "not a client id");
                const n = oauthOf(dir).removeClient(clientId);
                if (n < 0) {
                    if (configured().some((c) => c.clientId === clientId))
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
