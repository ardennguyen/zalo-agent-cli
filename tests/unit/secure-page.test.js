/**
 * The one-time secure input page (src/core/secure-page.js), over real HTTP on 127.0.0.1.
 *
 * What would turn each test red:
 * - tickets: a second use, an expired ticket, or one for another account, action or target being accepted;
 * - the page: a reply without `Cache-Control: no-store`, a page loading anything from elsewhere, a typed PIN written
 *   back into a page, a form posting anywhere but its own token path, a cross-site POST being acted on;
 * - the MCP HTTP server: the page needing the bearer token (a person's browser has none), or the token appearing in
 *   the request log.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SecurePage, TICKET_TTL_MS, TicketStore, askOnSecurePage, maskSecurePath } from "../../src/core/secure-page.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

const ACCOUNT = "1000000000000000001";
const TYPED = "7391";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const spec = (over = {}) => ({
    accountId: ACCOUNT,
    action: "conv.unhide",
    target: { threadIds: ["1000000000000000002"] },
    kind: "pin",
    title: "Zalo hidden chats",
    description: "Type the PIN.",
    onSubmit: ({ pin }) => (pin === TYPED ? { status: "approved" } : { status: "retry", message: "Wrong PIN." }),
    ...over,
});

describe("tickets", () => {
    it("128-bit random tokens, bound to account, action and target, used once, alive for 5 minutes", () => {
        let now = 0;
        const store = new TicketStore({ now: () => now });
        const a = store.issue(spec());
        const b = store.issue(spec());
        assert.match(a.token, /^[A-Za-z0-9_-]{22}$/, "16 random bytes, base64url");
        assert.notEqual(a.token, b.token);
        assert.equal(a.expiresAt, TICKET_TTL_MS);
        const expect = { accountId: ACCOUNT, action: "conv.unhide", target: spec().target };
        assert.equal(store.consume(a.token, expect).reason, "pending", "not before the person answered");
        store.settle(store.lookup(a.token).ticket, "approved");
        assert.equal(store.consume(a.token, { ...expect, accountId: "1000000000000000009" }).reason, "account");
        assert.equal(store.consume(a.token, { ...expect, action: "conv.hidden" }).reason, "action");
        assert.equal(
            store.consume(a.token, { ...expect, target: { threadIds: ["1000000000000000005"] } }).reason,
            "target",
        );
        assert.equal(store.consume(a.token, expect).ok, true);
        assert.equal(store.consume(a.token, expect).reason, "used");
        store.settle(store.lookup(b.token).ticket, "approved");
        now = TICKET_TTL_MS + 1;
        assert.equal(store.consume(b.token, expect).reason, "expired");
        assert.equal(store.consume("not-a-token", expect).reason, "unknown");
    });

    it("a declined ticket is used up and says so", () => {
        const store = new TicketStore();
        const t = store.issue(spec());
        store.settle(store.lookup(t.token).ticket, "declined");
        const r = store.consume(t.token, { accountId: ACCOUNT, action: "conv.unhide", target: spec().target });
        assert.deepEqual([r.ok, r.reason], [false, "declined"]);
    });

    it("maskSecurePath hides the token in a logged path", () => {
        assert.equal(maskSecurePath("/zalo/secure/AbCdEfGhIjKlMnOpQrStUv?x=1"), "/zalo/secure/***?x=1");
        assert.equal(maskSecurePath("/mcp"), "/mcp");
    });
});

describe("the page over HTTP (the stdio listener on 127.0.0.1)", () => {
    let page;
    before(async () => {
        page = new SecurePage({ accountId: ACCOUNT });
        await page.ensureServed();
    });
    after(() => page.close());

    const form = (fields) => new URLSearchParams(fields).toString();
    const post = (url, fields, headers = {}) =>
        fetch(url, {
            method: "POST",
            body: form(fields),
            headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
            redirect: "manual",
        });

    it("GET: the form, no-store, no external asset, posting back to its own token path", async () => {
        const { url, token } = await page.open(spec());
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/zalo\/secure\/[A-Za-z0-9_-]{22}$/);
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control"), /no-store/);
        assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
        assert.equal(res.headers.get("x-frame-options"), "DENY");
        const html = await res.text();
        assert.match(html, new RegExp(`<form method="post" action="/zalo/secure/${token}"`));
        assert.doesNotMatch(html, /<script|src=|href=|https?:\/\//, "nothing loaded from anywhere");
        assert.match(html, /type="password"/);
    });

    it("POST: a wrong PIN is not written back; the right one approves; the link then refuses reuse", async () => {
        const { url, token } = await page.open(spec());
        const wrong = await post(url, { pin: "0000", decision: "approve" });
        assert.equal(wrong.status, 400);
        assert.match(wrong.headers.get("cache-control"), /no-store/);
        const wrongHtml = await wrong.text();
        assert.doesNotMatch(wrongHtml, /0000/, "the typed PIN is never reflected");
        assert.match(wrongHtml, /Wrong PIN/);
        assert.equal(page.store.lookup(token).ticket.status, "pending");

        const right = await post(url, { pin: TYPED, decision: "approve" });
        assert.equal(right.status, 200);
        assert.doesNotMatch(await right.text(), new RegExp(TYPED));
        assert.equal(page.store.lookup(token).ticket.status, "approved");
        assert.equal((await fetch(url)).status, 409, "already answered");
        page.store.consume(token, { accountId: ACCOUNT, action: "conv.unhide", target: spec().target });
        const used = await fetch(url);
        assert.equal(used.status, 410);
        assert.match(await used.text(), /already used/);
    });

    it("a cross-site POST is refused and changes nothing", async () => {
        const { url, token } = await page.open(spec());
        const r = await post(url, { pin: TYPED, decision: "approve" }, { origin: "https://evil.example" });
        assert.equal(r.status, 403);
        const r2 = await post(url, { pin: TYPED, decision: "approve" }, { "sec-fetch-site": "cross-site" });
        assert.equal(r2.status, 403);
        assert.equal(page.store.lookup(token).ticket.status, "pending");
    });

    it("a token answers only for its own path: another ticket's form cannot settle it", async () => {
        const first = await page.open(spec());
        const second = await page.open(spec());
        await post(second.url, { pin: TYPED, decision: "approve" });
        assert.equal(page.store.lookup(first.token).ticket.status, "pending");
        assert.equal(page.store.lookup(second.token).ticket.status, "approved");
    });

    it("unknown, expired, wrong-account and wrong-method requests get clear pages", async () => {
        const base = (await page.open(spec())).url.replace(/[^/]+$/, "");
        const unknown = await fetch(`${base}AAAAAAAAAAAAAAAAAAAAAA`);
        assert.equal(unknown.status, 404);
        assert.match(unknown.headers.get("cache-control"), /no-store/);
        assert.match(await unknown.text(), /not found/i);

        const expiring = await page.open(spec());
        page.store.tickets.get(expiring.token).expiresAt = Date.now() - 1;
        const expired = await fetch(expiring.url);
        assert.equal(expired.status, 410);
        assert.match(await expired.text(), /expired/i);

        const other = await page.open(spec({ accountId: "1000000000000000009" }));
        const wrongAccount = await fetch(other.url);
        assert.equal(wrongAccount.status, 403);
        assert.match(await wrongAccount.text(), /another account/);

        const put = await fetch((await page.open(spec())).url, { method: "PUT" });
        assert.equal(put.status, 405);
    });

    it("confirm: Approve and Decline settle the ticket", async () => {
        const approve = await page.open(spec({ kind: "confirm", onSubmit: undefined }));
        const html = await (await fetch(approve.url)).text();
        assert.match(html, /value="approve"/);
        assert.match(html, /value="decline"/);
        await post(approve.url, { decision: "approve" });
        assert.equal(page.store.lookup(approve.token).ticket.status, "approved");
        const decline = await page.open(spec({ kind: "confirm", onSubmit: undefined }));
        await post(decline.url, { decision: "decline" });
        assert.equal(page.store.lookup(decline.token).ticket.status, "declined");
    });
});

describe("delivering the link", () => {
    const page = new SecurePage({ accountId: ACCOUNT }).configure({ localBaseUrl: "http://127.0.0.1:9" });

    it("no elicitation (or stateless HTTP): the reply carries the link, its expiry and the ticket", async () => {
        for (const how of [
            {},
            { stateless: true, server: { server: { getClientCapabilities: () => ({ elicitation: { url: {} } }) } } },
        ]) {
            const r = await askOnSecurePage({ page, spec: spec(), needs: "pinRequired", ...how });
            assert.equal(r.reply.pinRequired, true);
            assert.match(r.reply.secureUrl, /^http:\/\/127\.0\.0\.1:9\/zalo\/secure\//);
            assert.equal(r.reply.secureUrl.endsWith(r.reply.retryWith.ticket), true);
            assert.ok(Date.parse(r.reply.ticketExpiresAt) > Date.now());
            assert.match(r.reply.how, /Never ask them for the PIN in chat/);
        }
    });

    it("a public base URL builds the link (reverse proxy / TLS)", async () => {
        const p = new SecurePage({ accountId: ACCOUNT, publicBaseUrl: "https://zalo.example.com" }).configure({
            localBaseUrl: "http://127.0.0.1:9",
        });
        const r = await askOnSecurePage({ page: p, spec: spec(), needs: "pinRequired" });
        assert.match(r.reply.secureUrl, /^https:\/\/zalo\.example\.com\/zalo\/secure\/[A-Za-z0-9_-]{22}$/);
    });

    it("a form-only client is never asked for the PIN through the client", async () => {
        const asked = [];
        const server = {
            server: {
                getClientCapabilities: () => ({ elicitation: { form: {} } }),
                elicitInput: async (p) => asked.push(p),
            },
        };
        const r = await askOnSecurePage({ page, server, spec: spec(), needs: "pinRequired" });
        assert.equal(r.reply.pinRequired, true);
        assert.deepEqual(asked, []);
    });
});

describe("the page on the MCP HTTP server", () => {
    let server;
    let base;
    const page = new SecurePage({ accountId: ACCOUNT });
    const logged = [];
    let restore;
    before(async () => {
        const original = console.error;
        console.error = (...a) => logged.push(a.join(" "));
        restore = () => (console.error = original);
        process.env.ZALO_LOG_LEVEL = "debug";
        const deps = { buffer: { getStats: () => [], readCursor: () => 0 }, securePage: page };
        server = createHTTPServer(() => {}, deps, 0, "test-bearer-token-not-real", "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        base = `http://127.0.0.1:${server.address().port}`;
        page.configure({ localBaseUrl: base });
    });
    after(async () => {
        restore();
        delete process.env.ZALO_LOG_LEVEL;
        await new Promise((r) => server.close(r));
    });

    it("is served without the bearer token, while /mcp still needs it; the log masks the token", async () => {
        const { url, token } = await page.open(spec());
        assert.ok(url.startsWith(base));
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control"), /no-store/);
        const post = await fetch(url, {
            method: "POST",
            body: new URLSearchParams({ pin: TYPED, decision: "approve" }).toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
        });
        assert.equal(post.status, 200);
        assert.equal(page.store.lookup(token).ticket.status, "approved");
        assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 401);
        await new Promise((r) => setImmediate(r));
        assert.ok(
            logged.some((l) => l.includes("/zalo/secure/***")),
            "the request was logged, masked",
        );
        assert.ok(
            logged.every((l) => !l.includes(token)),
            "the token never reaches the log",
        );
        assert.ok(
            logged.every((l) => !l.includes(TYPED)),
            "nor the PIN",
        );
    });
});
