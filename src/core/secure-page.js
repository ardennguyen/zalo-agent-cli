/**
 * The secure input page: a one-time web page where a person types what the agent must never see (the hidden-chat
 * PIN) or approves what the agent cannot approve for them (confirmMode "human"), from any browser, with no terminal
 * and no persistent MCP connection.
 *
 * - A ticket is a random 128-bit token, kept in this process's memory only, bound to the account, the action and its
 *   target, alive for TICKET_TTL_MS, used once. Several server processes share nothing: the fleet runs one process
 *   per account, so a reverse proxy routes by account.
 * - The page is `/zalo/secure/<token>`: on the MCP HTTP server's own port (`mcp start --http`), or on a 127.0.0.1
 *   listener started on first use (stdio). The link is built from `publicUrl` when set
 *   (resolvePublicUrl, src/core/deploy-policy.js), else from the local address: never from a request's Host header.
 *   The form posts to its own path relatively, so it also works under a base path (`https://example.com/zalo`).
 * - Every answer carries `Cache-Control: no-store` and a CSP that allows no external asset: only the page's own style
 *   and language script, by a per-response nonce (src/utils/page-kit.js). The pages look like the QR login page and
 *   speak English and Vietnamese (src/core/secure-page-view.js). The form posts back to the same token path, the token is the only secret in the link, a PIN typed is never written back
 *   into any page, and request logs show the path with the token masked (maskSecurePath).
 * - When the person submits, the ticket becomes "approved" (or "done", for an action the page carried out itself,
 *   like changing the PIN). It holds no PIN. The agent repeats its call with `ticket`, which consumes it.
 * - An approve page can also ask for an approver secret (the hidden-chat PIN or the approver password,
 *   src/core/approval.js), so an agent that can open the link it relays cannot approve its own action.
 * - Where the link goes (`approval.deliver`): the tool result, the MCP webhook as an `approval_requested` event, or
 *   both. When the link does not go to the agent, the ticket the agent repeats its call with is a separate claim token,
 *   so the agent cannot rebuild the page's link from it.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import { newNonce, pageHeaders, requestedLang } from "../utils/page-kit.js";
import {
    CHOOSE_NOTICE,
    NO_CHECK_NOTICE,
    couldNotNotice,
    formView,
    noticeOf,
    renderView,
    statusView,
    successText,
} from "./secure-page-view.js";

/** How long a ticket lives. */
export const TICKET_TTL_MS = 5 * 60_000;
/** The path prefix of the page. */
export const SECURE_PATH_PREFIX = "/zalo/secure/";
/** Most tickets kept at once; the oldest goes first. */
const MAX_TICKETS = 500;
/** How long a used or expired ticket is remembered, so its page can say so. */
const TOMBSTONE_MS = 30 * 60_000;
/** A token: 16 random bytes, base64url (22 characters). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const PATH_SHAPE = /^\/zalo\/secure\/([^/?#]*)\/?$/;

/** A request path or URL with any secure-page token replaced, for logs. */
export function maskSecurePath(url) {
    return String(url ?? "").replace(/\/zalo\/secure\/[^/?#\s]*/g, "/zalo/secure/***");
}

/** Canonical JSON (sorted keys), to compare targets. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

/**
 * The tickets of one process.
 */
export class TicketStore {
    /**
     * @param {{now?: () => number, ttlMs?: number}} [opts]
     */
    constructor({ now = Date.now, ttlMs = TICKET_TTL_MS } = {}) {
        this.now = now;
        this.ttlMs = ttlMs;
        /** @type {Map<string, object>} */
        this.tickets = new Map();
        /** A separate claim token (the agent's) -> the page token, for a link the agent never sees. */
        this.claims = new Map();
        this.waiters = new Map();
    }

    #prune() {
        const t = this.now();
        for (const [token, ticket] of this.tickets) {
            if (ticket.expiresAt + TOMBSTONE_MS < t) this.#drop(token);
        }
        while (this.tickets.size >= MAX_TICKETS) this.#drop(this.tickets.keys().next().value);
    }

    #drop(token) {
        const ticket = this.tickets.get(token);
        if (ticket && ticket.claim !== token) this.claims.delete(ticket.claim);
        this.tickets.delete(token);
    }

    /**
     * Issue a ticket.
     *
     * @param {object} spec
     * @param {string} spec.accountId
     * @param {string} spec.action - what it is for, e.g. "conv.unhide" or a GUARDS key
     * @param {object} [spec.target] - the ids it acts on
     * @param {"confirm"|"pin"|"pin-change"} spec.kind - which form the page shows
     * @param {string} spec.title - the page's heading
     * @param {string} spec.description - what approving does, in a sentence
     * @param {boolean} [spec.hasPin] - for pin-change: ask the current PIN first
     * @param {"pin"|"password"|null} [spec.secretKind] - for confirm: the approver secret the page asks for, which
     *   `onSubmit` checks (`{secret}`)
     * @param {boolean} [spec.separateClaim] - the agent repeats its call with a claim token of its own instead of the
     *   page's token (a link the agent must not be able to rebuild)
     * @param {(fields: object) => Promise<object>|object} [spec.onSubmit] - checks what was typed; returns
     *   `{status: "approved"|"done"|"retry"|"failed", message?, outcome?, redirect?}`; the fields are dropped
     *   afterwards. `redirect` (approved or done only): the browser is sent there instead of shown a status page
     * @param {string[]} [spec.formActionOrigins] - other origins the form's answer may redirect to (the page's CSP
     *   `form-action` allows them): an OAuth client's callback
     * @param {string|null} [spec.declineRedirect] - where Decline sends the browser, instead of a status page
     * @param {object|null} [spec.view] - what the page alone shows besides title and description, in both languages
     *   (src/core/secure-page-view.js): an OAuth request's app, account and return host, or `{heading, lead, done}`
     * @returns {{token: string, claim: string, expiresAt: number}}
     */
    issue({
        accountId,
        action,
        target = {},
        kind,
        title,
        description,
        hasPin = false,
        secretKind = null,
        separateClaim = false,
        onSubmit,
        formActionOrigins = [],
        declineRedirect = null,
        view = null,
    }) {
        this.#prune();
        const token = randomBytes(16).toString("base64url");
        const claim = separateClaim ? randomBytes(16).toString("base64url") : token;
        const ticket = {
            token,
            claim,
            accountId: String(accountId ?? ""),
            action: String(action),
            target: canonical(target),
            kind,
            title,
            description,
            hasPin,
            secretKind,
            onSubmit,
            formActionOrigins: formActionOrigins.filter((o) => /^https?:\/\/[^\s;,'"]+$/.test(String(o))),
            declineRedirect,
            view,
            status: "pending",
            message: null,
            outcome: null,
            createdAt: this.now(),
            expiresAt: this.now() + this.ttlMs,
        };
        this.tickets.set(token, ticket);
        if (claim !== token) this.claims.set(claim, token);
        return { token, claim, expiresAt: ticket.expiresAt };
    }

    /** The live ticket of a page token (never a separate claim token), or why there is none. */
    lookup(token) {
        if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return { error: "unknown" };
        const ticket = this.tickets.get(token);
        if (!ticket) return { error: "unknown" };
        if (ticket.status === "consumed") return { error: "used", ticket };
        if (ticket.expiresAt <= this.now()) return { error: "expired", ticket };
        return { ticket };
    }

    /** Set a ticket's decision and wake whoever waits on it. */
    settle(ticket, status, { message = null, outcome = null } = {}) {
        ticket.status = status;
        ticket.message = message;
        ticket.outcome = outcome;
        ticket.onSubmit = null;
        for (const wake of this.waiters.get(ticket.token) ?? []) wake(status);
        this.waiters.delete(ticket.token);
    }

    /**
     * Wait for a ticket to leave "pending" (URL-mode elicitation over a live connection).
     *
     * @param {string} token
     * @param {number} timeoutMs
     * @param {AbortSignal} [signal]
     * @returns {Promise<string>} the status, or "timeout"
     */
    waitForDecision(token, timeoutMs, signal) {
        const found = this.lookup(token);
        if (!found.ticket) return Promise.resolve(found.error);
        if (found.ticket.status !== "pending") return Promise.resolve(found.ticket.status);
        return new Promise((resolve) => {
            const list = this.waiters.get(token) ?? [];
            let timer = null;
            const done = (status) => {
                clearTimeout(timer);
                resolve(status);
            };
            timer = setTimeout(() => {
                const l = this.waiters.get(token);
                if (l)
                    this.waiters.set(
                        token,
                        l.filter((w) => w !== done),
                    );
                resolve("timeout");
            }, timeoutMs);
            signal?.addEventListener?.("abort", () => done("cancelled"), { once: true });
            list.push(done);
            this.waiters.set(token, list);
        });
    }

    /**
     * Use a ticket: it must exist, be alive, be for this account, action and target, and be approved (or done).
     * It is used up whatever the outcome, except while it is still pending.
     *
     * @param {string} token - the claim token (the page token, unless the ticket has a separate claim)
     * @param {{accountId: string, action: string, target?: object}} expect
     * @returns {{ok: true, ticket: object} | {ok: false, reason: string, message: string}}
     */
    consume(token, { accountId, action, target = {} }) {
        // The agent holds the claim token: the page token itself, unless the ticket was issued with a separate one.
        const pageToken = typeof token === "string" && this.claims.has(token) ? this.claims.get(token) : token;
        const found = this.lookup(pageToken);
        if (found.error) return { ok: false, reason: found.error, message: refusalMessage(found.error) };
        const { ticket } = found;
        if (ticket.claim !== token) return { ok: false, reason: "unknown", message: refusalMessage("unknown") };
        const mismatch =
            ticket.accountId !== String(accountId ?? "")
                ? "account"
                : ticket.action !== String(action)
                  ? "action"
                  : ticket.target !== canonical(target)
                    ? "target"
                    : null;
        if (mismatch) return { ok: false, reason: mismatch, message: refusalMessage(mismatch) };
        if (ticket.status === "pending") return { ok: false, reason: "pending", message: refusalMessage("pending") };
        const status = ticket.status;
        ticket.status = "consumed";
        if (status === "declined" || status === "failed") {
            return { ok: false, reason: status, message: ticket.message || refusalMessage(status) };
        }
        return { ok: true, ticket: { ...ticket, status } };
    }
}

/** Why a ticket cannot be used, in a sentence. */
function refusalMessage(reason) {
    return (
        {
            unknown: "That ticket is unknown to this server (wrong server, restarted, or mistyped).",
            expired: "That ticket has expired; ask again for a new link.",
            used: "That ticket was already used; each link works once.",
            account: "That ticket belongs to another account.",
            action: "That ticket was issued for another action.",
            target: "That ticket was issued for other conversations or ids.",
            pending: "The person has not completed the page yet; ask them to open the link, then repeat the call.",
            declined: "The person declined on the page; nothing was done.",
            failed: "The page could not complete it; nothing was done.",
        }[reason] ?? "That ticket cannot be used."
    );
}

// --- the page ---

/** Headers of an answer without a page (a redirect). */
const BARE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Answer with a page: a fresh nonce for its style and script, and a CSP whose `form-action` also allows the ticket's
 * other origins (an OAuth client's callback), when a form is shown.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} code
 * @param {{title: object, body: string, cardClass?: string}} view
 * @param {{lang?: "en"|"vi"|null, ticket?: object|null}} [o]
 */
function send(res, code, view, { lang = null, ticket = null } = {}) {
    const nonce = newNonce();
    const formAction = ["'self'", ...(ticket?.formActionOrigins ?? [])];
    res.writeHead(code, pageHeaders(nonce, { formAction }));
    res.end(renderView(view, { nonce, lang: lang ?? "en" }));
}

/** A status page (see statusView). */
const statusOf = (title, text, tone = "bad") => statusView({ title, text, tone });

/** Send the browser on (303, so the form's POST becomes a GET there). */
function redirectTo(res, location) {
    res.writeHead(303, { ...BARE_HEADERS, Location: location });
    res.end();
}

/** The form fields of a POST: express's parsed body, else read here (small bodies only). */
async function formFields(req) {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new Error("too large");
        chunks.push(chunk);
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** True when a POST comes from this page's own origin (or names none, as a plain form post may not). */
function sameOrigin(req, publicUrl) {
    if (String(req.headers["sec-fetch-site"] ?? "") === "cross-site") return false;
    const origin = req.headers.origin;
    if (!origin || origin === "null") return true;
    let host;
    try {
        host = new URL(origin).host;
    } catch {
        return false;
    }
    const allowed = new Set(
        [
            req.headers.host,
            String(req.headers["x-forwarded-host"] ?? "")
                .split(",")[0]
                .trim(),
        ].filter(Boolean),
    );
    if (publicUrl) {
        try {
            allowed.add(new URL(publicUrl).host);
        } catch {
            /* resolvePublicUrl only passes valid URLs */
        }
    }
    return allowed.has(host);
}

/**
 * The page's request handler. Returns false for a path that is not the page's (the caller goes on), true once it
 * answered.
 *
 * @param {import("http").IncomingMessage & {body?: object}} req
 * @param {import("http").ServerResponse} res
 * @param {{store: TicketStore, accountId: string, publicUrl?: string|null}} ctx
 * @returns {Promise<boolean>}
 */
export async function handleSecureRequest(req, res, { store, accountId, publicUrl = null }) {
    const path = String(req.url ?? "").split("?")[0];
    const m = PATH_SHAPE.exec(path);
    if (!m) return false;
    // The page opens in the language its link asks for (`?lang=vi`); its script then follows the saved choice or the
    // browser's language when the link asks none.
    const lang = requestedLang(req.url);
    if (req.method !== "GET" && req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        send(res, 405, statusOf("notAllowedTitle", "notAllowedText"), { lang });
        return true;
    }
    const found = store.lookup(m[1]);
    if (found.error) {
        const views = {
            unknown: () => statusOf("notFoundTitle", "notFoundText"),
            expired: () => statusOf("expiredTitle", "expiredText", "warn"),
            used: () => statusOf("usedTitle", "usedText", "warn"),
        };
        send(res, found.error === "unknown" ? 404 : 410, views[found.error](), { lang });
        return true;
    }
    const { ticket } = found;
    if (ticket.accountId !== String(accountId ?? "")) {
        send(res, 403, statusOf("wrongAccountTitle", "wrongAccountText"), { lang });
        return true;
    }
    if (ticket.status !== "pending") {
        const ok = ticket.status === "approved" || ticket.status === "done";
        send(res, 409, statusOf("answeredTitle", ok ? "answeredOk" : "answeredDeclined", ok ? "ok" : "warn"), {
            lang,
        });
        return true;
    }
    if (req.method === "GET") {
        send(res, 200, formView(ticket, null, { lang }), { lang, ticket });
        return true;
    }

    if (!sameOrigin(req, publicUrl)) {
        send(res, 403, statusOf("refusedTitle", "refusedOrigin"), { lang });
        return true;
    }
    let fields;
    try {
        fields = await formFields(req);
    } catch {
        send(res, 413, statusOf("refusedTitle", "refusedLarge"), { lang });
        return true;
    }
    if (fields.decision === "decline") {
        store.settle(ticket, "declined", { message: "The person declined on the page; nothing was done." });
        if (ticket.declineRedirect) redirectTo(res, ticket.declineRedirect);
        else send(res, 200, statusOf("declinedTitle", "declinedText", "warn"), { lang });
        return true;
    }
    if (ticket.kind === "confirm") {
        if (fields.decision !== "approve") {
            send(res, 400, formView(ticket, CHOOSE_NOTICE, { lang }), { lang, ticket });
            return true;
        }
        if (!ticket.secretKind) {
            store.settle(ticket, "approved");
            const said = successText(ticket, "approved");
            send(res, 200, statusOf(said.title, said.text, "ok"), { lang });
            return true;
        }
    }
    // Only the named fields are passed on, and nothing typed is written back into a page.
    const typed = {
        pin: fields.pin,
        newPin: fields.newPin,
        newPin2: fields.newPin2,
        secret: fields.secret,
        // Not secrets: the OAuth approve page's agent choice (Companion Router).
        agent: typeof fields.agent === "string" ? fields.agent : undefined,
        agentNew: typeof fields.agentNew === "string" ? fields.agentNew : undefined,
    };
    fields = null;
    let result;
    let notice = null;
    try {
        result = await ticket.onSubmit?.(typed);
        if (!result) {
            notice = NO_CHECK_NOTICE;
            result = { status: "failed", message: notice.en };
        }
    } catch (e) {
        notice = couldNotNotice(e.message);
        result = { status: "failed", message: notice.en };
    }
    typed.pin = typed.newPin = typed.newPin2 = typed.secret = undefined;
    notice ??= noticeOf(result);
    if (result.status === "retry") {
        send(res, 400, formView(ticket, notice, { lang }), { lang, ticket });
        return true;
    }
    store.settle(ticket, result.status, { message: result.message ?? null, outcome: result.outcome ?? null });
    const ok = result.status === "approved" || result.status === "done";
    if (ok && typeof result.redirect === "string" && result.redirect) {
        redirectTo(res, result.redirect);
        return true;
    }
    if (ok) {
        const said = successText(ticket, result.status, result.message ?? null);
        send(res, 200, statusOf(said.title, said.text, "ok"), { lang });
    } else {
        send(res, 400, statusOf("notDoneTitle", notice), { lang });
    }
    return true;
}

// --- the service ---

/**
 * One process's secure page: its tickets, where it is served, and the links it hands out.
 */
export class SecurePage {
    /**
     * @param {{store?: TicketStore, accountId?: string, publicUrl?: string|null,
     *   accountName?: string|(() => string)|null}} [opts]
     */
    constructor({ store = new TicketStore(), accountId = "", publicUrl = null, accountName = null } = {}) {
        this.store = store;
        this.accountId = String(accountId ?? "");
        /** The account's display name, or a function that reads it, for a page that says which account it is for. */
        this.accountName = accountName;
        this.publicUrl = publicUrl;
        /** The local base URL of the server the page is mounted on (`--http`), or of the stdio listener. */
        this.localBaseUrl = null;
        this.listener = null;
        this.mounted = false;
        /** Where `approval.deliver: "webhook"` sends a link (the MCP webhook outbox), or null when none is set. */
        this.notify = null;
    }

    /**
     * Settings from `mcp start`: the account served, the public base URL, the HTTP server's own address, and the
     * function that queues an `approval_requested` event for the webhook (`(payload) => void`), and the account's
     * display name (a string, or a function that reads the current one) for the pages to show.
     */
    configure({ accountId, publicUrl, localBaseUrl, notify, accountName } = {}) {
        if (accountId !== undefined) this.accountId = String(accountId ?? "");
        if (accountName !== undefined) this.accountName = accountName;
        if (notify !== undefined) this.notify = notify;
        if (publicUrl !== undefined) this.publicUrl = publicUrl;
        if (localBaseUrl !== undefined) {
            this.localBaseUrl = localBaseUrl;
            this.mounted = Boolean(localBaseUrl);
        }
        return this;
    }

    /**
     * The account's display name for a page ("" when unknown): never more than the name.
     * @returns {string}
     */
    accountDisplayName() {
        try {
            const name = typeof this.accountName === "function" ? this.accountName() : this.accountName;
            return typeof name === "string" ? name.trim() : "";
        } catch {
            return "";
        }
    }

    /** The request handler, for an HTTP server to mount (src/mcp/mcp-http-transport.js). */
    handle(req, res) {
        return handleSecureRequest(req, res, {
            store: this.store,
            accountId: this.accountId,
            publicUrl: this.publicUrl,
        });
    }

    /** Start the 127.0.0.1 listener, when no HTTP server serves the page (stdio). */
    async ensureServed() {
        if (this.mounted || this.listener) return;
        const server = http.createServer((req, res) => {
            this.handle(req, res)
                .then((handled) => {
                    if (!handled) send(res, 404, statusOf("nothingTitle", "nothingText"));
                })
                .catch(() => {
                    if (!res.headersSent) send(res, 500, statusOf("errorTitle", "errorText"));
                });
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        server.unref();
        this.listener = server;
        this.localBaseUrl = `http://127.0.0.1:${server.address().port}`;
    }

    /** Stop the stdio listener (tests, shutdown). */
    async close() {
        const l = this.listener;
        this.listener = null;
        if (l) await new Promise((resolve) => l.close(() => resolve()));
    }

    /**
     * Issue a ticket and the link to its page.
     *
     * @param {object} spec - as for TicketStore#issue (accountId defaults to the page's)
     * @returns {Promise<{token: string, claim: string, expiresAt: number, url: string}>}
     */
    async open(spec) {
        await this.ensureServed();
        // A process serves one account; the first ticket names it when `mcp start` did not.
        if (!this.accountId && spec.accountId) this.accountId = String(spec.accountId);
        const { token, claim, expiresAt } = this.store.issue({ ...spec, accountId: spec.accountId ?? this.accountId });
        const base = this.publicUrl || this.localBaseUrl;
        return { token, claim, expiresAt, url: `${base}${SECURE_PATH_PREFIX}${token}` };
    }
}

let current = null;

/** The process's secure page (one per process: tickets are per process). */
export function getSecurePage() {
    if (!current) current = new SecurePage();
    return current;
}

/** Test seam: use this one instead (null resets). */
export function setSecurePage(page) {
    current = page;
}

/** How long a person may take on the page while a live call waits (URL-mode elicitation). */
export const PAGE_WAIT_MS = TICKET_TTL_MS;

/** The flag a page's kind sets in a "needs X" reply. */
const NEEDS = { confirm: "confirmationRequired", pin: "pinRequired", "pin-change": "pinRequired" };

/**
 * The `approval_requested` event a webhook receiver (a CRM's approval UI) gets for one page: what it is for, its link
 * and its expiry. Signed and queued like every other webhook event (src/core/webhook-outbox.js).
 *
 * @param {object} opts
 * @param {{url: string, expiresAt: number}} opts.opened
 * @param {object} opts.spec - the ticket
 * @param {{action?: string, wouldDo?: string, target?: object}} [opts.about]
 * @param {"pin"|"password"|null} [opts.secretKind]
 * @returns {object}
 */
export function approvalEvent({ opened, spec, about = {}, secretKind = null }) {
    return {
        event: "approval_requested",
        accountId: spec.accountId ?? null,
        kind: spec.kind,
        action: about.action ?? spec.action,
        wouldDo: about.wouldDo ?? spec.description,
        target: about.target ?? spec.target ?? {},
        secureUrl: opened.url,
        expiresAt: new Date(opened.expiresAt).toISOString(),
        approverSecret: secretKind,
    };
}

/**
 * Ask a person on the secure page, delivering the link the best way the deployment and the transport allow:
 * - a live connection (stdio) whose client declares URL-mode elicitation: the client is asked to open the link, the call
 *   waits for the page to be completed (then `notifications/elicitation/complete` is sent), and the reply never
 *   carries the link;
 * - `deliver: "webhook"`: the link goes to the MCP webhook as an `approval_requested` event, and the reply carries
 *   only `approvalPending`, `deliveredTo: "webhook"` and a claim `ticket` from which the link cannot be rebuilt;
 * - otherwise (`result`, or `both`, which also posts the event): the reply carries the link, for the agent to show the
 *   person and repeat its call with `ticket`.
 * The PIN never travels through the client: form elicitation is not used for it.
 *
 * For an approve page (`spec.kind` "confirm"), `approver(throughAgent)` says what the page asks besides a click
 * (src/core/approval.js approverFor): it is asked once the delivery is known, as the link reaching the agent is what
 * calls for a secret.
 *
 * @param {object} opts
 * @param {SecurePage} opts.page
 * @param {object} [opts.server] - the McpServer (its `.server` elicits)
 * @param {object} [opts.extra] - the tool call's request context
 * @param {boolean} [opts.stateless] - the stateless HTTP transport: never elicit
 * @param {object} opts.spec - the ticket (see TicketStore#issue)
 * @param {"confirmationRequired"|"pinRequired"} opts.needs - the flag the reply carries
 * @param {object} [opts.retryWith] - what the repeat call adds besides `ticket`
 * @param {"result"|"webhook"|"both"} [opts.deliver] - approval.deliver
 * @param {(throughAgent: boolean) => object} [opts.approver] - for an approve page: approverFor's answer
 * @param {{action?: string, wouldDo?: string, target?: object}} [opts.about] - for the webhook event
 * @returns {Promise<{token: string} | {declined: string} | {reply: object} | {error: string}>}
 */
export async function askOnSecurePage({
    page,
    server,
    extra,
    stateless = false,
    spec,
    needs,
    retryWith = {},
    deliver = "result",
    approver = null,
    about = {},
}) {
    const flag = needs ?? NEEDS[spec.kind] ?? "confirmationRequired";
    /** The ticket's spec once the delivery is known, or {error} when the page cannot ask what it must. */
    const specFor = (throughAgent) => {
        if (!approver) return { spec };
        const a = approver(throughAgent);
        if (a.error) return { error: a.error };
        return {
            spec: { ...spec, secretKind: a.kind, ...(a.check && { onSubmit: ({ secret }) => a.check(secret) }) },
            approverSecret: a.approverSecret,
        };
    };

    const asker = stateless ? null : server?.server;
    if (asker?.getClientCapabilities?.()?.elicitation?.url) {
        const built = specFor(false);
        if (built.error) return { error: built.error };
        const opened = await page.open(built.spec);
        const elicitationId = randomBytes(12).toString("hex");
        let answer = null;
        try {
            answer = await asker.elicitInput(
                { mode: "url", message: `Zalo: ${spec.description}`, url: opened.url, elicitationId },
                {
                    timeout: PAGE_WAIT_MS,
                    ...(extra?.requestId !== undefined && { relatedRequestId: extra.requestId }),
                },
            );
        } catch (e) {
            console.error(`[secure-page] URL elicitation failed (${e.message}); delivering the link another way`);
        }
        const ticket = page.store.lookup(opened.token).ticket;
        if (answer && answer.action !== "accept") {
            if (ticket?.status === "pending") page.store.settle(ticket, "declined");
            return { declined: answer.action ?? "cancel" };
        }
        if (answer) {
            const status = await page.store.waitForDecision(
                opened.token,
                Math.max(0, opened.expiresAt - page.store.now()),
                extra?.signal,
            );
            try {
                await asker.createElicitationCompletionNotifier?.(elicitationId, {
                    ...(extra?.requestId !== undefined && { relatedRequestId: extra.requestId }),
                })?.();
            } catch {
                /* the completion notice is a courtesy */
            }
            if (["approved", "done", "declined", "failed"].includes(status)) return { token: opened.token };
            // Not completed in time: the link went through the client only, and it stays out of the reply.
            const left = page.store.lookup(opened.token).ticket;
            if (left?.status === "pending") page.store.settle(left, "declined");
            return { declined: status === "cancelled" ? "cancel" : "timeout" };
        }
        // The client could not be asked: this ticket is dropped, and the link goes the configured way instead.
        if (ticket?.status === "pending") page.store.settle(ticket, "declined");
    }

    const toWebhook = deliver === "webhook" || deliver === "both";
    if (toWebhook && typeof page.notify !== "function") {
        if (deliver === "webhook") {
            return {
                error:
                    'approval.deliver is "webhook" but this server has no webhook (-w, ZALO_WEBHOOK_URL or webhook in ' +
                    "mcp-config.json), so the link could not reach anyone; nothing was done.",
            };
        }
        console.error('[secure-page] approval.deliver is "both" but no webhook is set; the link is in the reply only');
    }
    const onlyWebhook = deliver === "webhook";
    const built = specFor(!onlyWebhook);
    if (built.error) return { error: built.error };
    const opened = await page.open({ ...built.spec, separateClaim: onlyWebhook });
    let deliveredTo = "result";
    if (toWebhook && typeof page.notify === "function") {
        page.notify(approvalEvent({ opened, spec: built.spec, about, secretKind: built.spec.secretKind ?? null }));
        deliveredTo = onlyWebhook ? "webhook" : "both";
    }
    const expiresAt = new Date(opened.expiresAt).toISOString();
    const what = flag === "pinRequired" ? "the hidden-chat PIN" : "approval";
    const approverField = spec.kind === "confirm" ? { approverSecret: built.approverSecret === true } : {};
    if (onlyWebhook) {
        return {
            reply: {
                error:
                    `Not done yet: this needs ${what} from the account owner, who was sent a one-time page through ` +
                    "the deployment's approval channel.",
                [flag]: true,
                approvalPending: true,
                ticket: opened.claim,
                ticketExpiresAt: expiresAt,
                deliveredTo,
                retryWith: { ...retryWith, ticket: opened.claim },
                how:
                    "The account owner completes the page in the app that receives this server's webhook. Once they " +
                    "have, repeat this call unchanged plus `ticket` (before ticketExpiresAt). Never ask them for the " +
                    "PIN or a password in chat.",
            },
        };
    }
    return {
        reply: {
            error: `Not done yet: this needs ${what} from the account owner on a one-time page.`,
            [flag]: true,
            secureUrl: opened.url,
            ticketExpiresAt: expiresAt,
            ...approverField,
            ...(deliveredTo !== "result" && { deliveredTo }),
            retryWith: { ...retryWith, ticket: opened.claim },
            how:
                "Give the person secureUrl to open in a browser (it works once and expires at ticketExpiresAt). " +
                "Once they complete it, repeat this call unchanged plus `ticket`. Never ask them for the PIN in chat." +
                (approverField.approverSecret ? " The page asks them for a secret only they know." : ""),
        },
    };
}
