/**
 * Approve pages an agent cannot approve for itself, and links that never reach the agent (src/core/approval.js,
 * src/core/secure-page.js, src/core/confirm-guard.js gateMcp), plus the hidden-chat fixes on the MCP side.
 *
 * What would turn each test red:
 * - the approver password: a file holding the password (not a salted hash), a wrong one approving, a typed secret
 *   written back into a page, no lockout after six wrong ones;
 * - `approverSecret`: a reply that hides whether the page asks for a secret;
 * - `approval.deliver: "webhook"`: a tool result carrying the link (or anything a link can be rebuilt from), an event
 *   missing its link or what it is for, the event not signed like other webhook events, a webhook delivery with no
 *   webhook pretending it worked;
 * - URL-mode elicitation: a page left unanswered putting the link in the tool result;
 * - hidden chats: a wrong PIN accepted because nothing is hidden; `archived`/`muted` showing a hidden chat under
 *   exclude or contentless, or dropping it under include.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    APPROVER_FILE,
    approverFor,
    approverStatus,
    removeApproverPassword,
    setApproverPassword,
    verifyApproverPassword,
} from "../../src/core/approval.js";
import { isSealed, readSealedJson, scopeOfDir } from "../../src/core/keystore/index.js";
import { resolveApproval } from "../../src/core/deploy-policy.js";
import { SecurePage, TicketStore, askOnSecurePage } from "../../src/core/secure-page.js";
import { gateMcp } from "../../src/core/confirm-guard.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { CONVERSATION_ACTIONS } from "../../src/mcp/actions-conversation.js";
import { createWebhookDispatcher, openOutbox } from "../../src/core/webhook-outbox.js";
import { getDefaultConfig, mergeMCPConfigLayer } from "../../src/mcp/mcp-config.js";
import { warnApprovalPolicy } from "../../src/commands/mcp.js";

const ACCOUNT = "1000000000000000001";
const THREAD = "1000000000000000002";
const OTHER = "1000000000000000004";
const PASSWORD = "correct horse battery";
const PIN = "3916";
const ROOT = mkdtempSync(join(tmpdir(), "zalo-approval-"));
let dirs = 0;
const freshDir = () => join(ROOT, `acc-${++dirs}`);

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const form = (fields) => new URLSearchParams(fields).toString();
const post = (url, fields) =>
    fetch(url, {
        method: "POST",
        body: form(fields),
        headers: { "content-type": "application/x-www-form-urlencoded" },
    });
const pinned = () => new HiddenChats().setFromServer({ pin: createHash("md5").update(PIN).digest("hex"), threads: [] });

describe("the policy keys", () => {
    it("approval.secret and approval.deliver: per-account env, env, config, default; bad values skipped", () => {
        assert.deepEqual(resolveApproval({ env: {} }), {
            secret: "auto",
            secretSource: "default",
            deliver: "result",
            deliverSource: "default",
        });
        const config = { approval: { secret: "pin", deliver: "webhook" } };
        assert.equal(resolveApproval({ config, env: {} }).secret, "pin");
        assert.equal(resolveApproval({ config, env: {} }).deliver, "webhook");
        const env = { ZALO_MCP_APPROVAL_SECRET: "password", [`ZALO_MCP_APPROVAL_DELIVER_${ACCOUNT}`]: "both" };
        const r = resolveApproval({ config, env, accountId: ACCOUNT });
        assert.deepEqual([r.secret, r.deliver], ["password", "both"]);
        assert.equal(resolveApproval({ config: { approval: { secret: "sometimes" } }, env: {} }).secret, "auto");
    });

    it("mcp-config merges an approval block over the defaults", () => {
        const merged = mergeMCPConfigLayer(getDefaultConfig(), { approval: { deliver: "webhook" } });
        assert.deepEqual(merged.approval, { secret: null, deliver: "webhook" });
    });
});

describe("the approver password", () => {
    it("is kept only as a salted scrypt hash; checks right and wrong; a seventh wrong one waits", async () => {
        const dir = freshDir();
        assert.equal(approverStatus(dir).set, false);
        assert.throws(() => setApproverPassword(dir, "short"), /at least 8/);
        setApproverPassword(dir, PASSWORD);
        const file = readFileSync(join(dir, APPROVER_FILE));
        assert.equal(file.includes(PASSWORD), false, "never the password itself");
        assert.equal(isSealed(file), true, "sealed like the other account secrets");
        const rec = readSealedJson(join(dir, APPROVER_FILE), scopeOfDir(dir), { kind: "approver-secret", use: "boot" });
        assert.equal(rec.kdf, "scrypt");
        assert.ok(rec.salt && rec.hash);
        setApproverPassword(freshDir(), PASSWORD);
        assert.equal(approverStatus(dir).set, true);

        let now = 1_000_000;
        const clock = { now: () => now };
        assert.deepEqual(await verifyApproverPassword(dir, PASSWORD, clock), { ok: true });
        for (let i = 1; i <= 6; i++) {
            const r = await verifyApproverPassword(dir, "wrong password", clock);
            assert.equal(r.reason, "wrong");
            assert.equal(r.failures, i);
        }
        const locked = await verifyApproverPassword(dir, PASSWORD, clock);
        assert.equal(locked.reason, "locked", "even the right one waits out the back-off");
        now += locked.retryAfterMs;
        assert.deepEqual(await verifyApproverPassword(dir, PASSWORD, clock), { ok: true });
        assert.equal(removeApproverPassword(dir), true);
        assert.equal(approverStatus(dir).set, false);
    });

    it("two salts: the same password hashes differently", () => {
        const a = freshDir();
        const b = freshDir();
        setApproverPassword(a, PASSWORD);
        setApproverPassword(b, PASSWORD);
        const hash = (d) =>
            readSealedJson(join(d, APPROVER_FILE), scopeOfDir(d), { kind: "approver-secret", use: "boot" }).hash;
        assert.notEqual(hash(a), hash(b));
    });

    it("approverFor: auto asks for the password only when one is set and the link reaches the agent", () => {
        const none = freshDir();
        assert.deepEqual(approverFor({ mode: "auto", throughAgent: true, accountDir: none }), {
            kind: null,
            approverSecret: false,
        });
        const set = freshDir();
        setApproverPassword(set, PASSWORD);
        assert.equal(approverFor({ mode: "auto", throughAgent: true, accountDir: set }).kind, "password");
        assert.equal(approverFor({ mode: "auto", throughAgent: false, accountDir: set }).kind, null);
        assert.equal(approverFor({ mode: "password", throughAgent: false, accountDir: set }).kind, "password");
        assert.match(approverFor({ mode: "password", throughAgent: true, accountDir: none }).error, /approver set/);
        assert.match(approverFor({ mode: "pin", throughAgent: true, hidden: () => new HiddenChats() }).error, /PIN/);
        assert.equal(approverFor({ mode: "pin", throughAgent: true, hidden: pinned }).kind, "pin");
        assert.equal(approverFor({ mode: "none", throughAgent: true, accountDir: set }).approverSecret, false);
    });
});

describe("approve pages over HTTP (confirmMode human, stateless)", () => {
    let page;
    before(async () => {
        page = new SecurePage({ accountId: ACCOUNT });
        await page.ensureServed();
    });
    after(() => page.close());
    const target = { threadId: THREAD };
    const gate = (over = {}) =>
        gateMcp("conv.delete", target, {
            env: {},
            accountId: ACCOUNT,
            stateless: true,
            securePage: page,
            ...over,
            config: { confirmMode: "human", ...over.config },
        });
    const payloadOf = (res) => JSON.parse(res.content[0].text);

    it("no approver secret configured: still works, and says approverSecret: false", async () => {
        const res = await gate({ accountDir: freshDir() });
        const p = payloadOf(res);
        assert.equal(p.confirmationRequired, true);
        assert.equal(p.approverSecret, false);
        const html = await (await fetch(p.secureUrl)).text();
        assert.doesNotMatch(html, /type="password"/, "a click approves");
        await post(p.secureUrl, { decision: "approve" });
        assert.equal(await gate({ accountDir: freshDir(), ticket: p.retryWith.ticket }), null);
    });

    it("an approver password: asked on the page, never reflected, wrong ones locked out, the right one approves", async () => {
        const dir = freshDir();
        setApproverPassword(dir, PASSWORD);
        const p = payloadOf(await gate({ accountDir: dir }));
        assert.equal(p.approverSecret, true);
        const html = await (await fetch(p.secureUrl)).text();
        assert.match(html, /Approver password/);
        assert.match(html, /name="secret" type="password"/);

        const wrong = await post(p.secureUrl, { decision: "approve", secret: "guessed-by-agent" });
        assert.equal(wrong.status, 400);
        const wrongHtml = await wrong.text();
        assert.doesNotMatch(wrongHtml, /guessed-by-agent/, "the secret typed is never written back");
        assert.match(wrongHtml, /Wrong approver password/);
        const noSecret = await post(p.secureUrl, { decision: "approve" });
        assert.equal(noSecret.status, 400, "a bare Approve click does not approve");
        assert.equal(await gate({ accountDir: dir, ticket: p.retryWith.ticket }).then((r) => r?.isError), true);

        const ok = await post(p.secureUrl, { decision: "approve", secret: PASSWORD });
        assert.equal(ok.status, 200);
        assert.doesNotMatch(await ok.text(), new RegExp(PASSWORD));
        // The pending call above did not use the ticket up; the approved one goes ahead once.
        assert.equal(await gate({ accountDir: dir, ticket: p.retryWith.ticket }), null);

        // Six more wrong ones: the next page refuses for good, even the right password.
        const q = payloadOf(await gate({ accountDir: dir }));
        for (let i = 0; i < 6; i++) await post(q.secureUrl, { decision: "approve", secret: `wrong-${i}-password` });
        const locked = await post(q.secureUrl, { decision: "approve", secret: PASSWORD });
        assert.equal(locked.status, 400);
        assert.match(await locked.text(), /Too many wrong passwords/);
        const refused = await gate({ accountDir: dir, ticket: q.retryWith.ticket });
        assert.equal(refused.isError, true);
    });

    it('approval.secret "pin": the hidden-chat PIN approves, with its lockout', async () => {
        const set = pinned();
        const config = { approval: { secret: "pin" } };
        const p = payloadOf(await gate({ config, hidden: () => set }));
        assert.equal(p.approverSecret, true);
        assert.match(await (await fetch(p.secureUrl)).text(), /Hidden-chat PIN \(to approve\)/);
        const wrong = await post(p.secureUrl, { decision: "approve", secret: "8257" });
        assert.equal(wrong.status, 400);
        assert.doesNotMatch(await wrong.text(), /8257/);
        assert.equal(set.lockoutStatus().failures, 1, "counted like the PIN page's");
        await post(p.secureUrl, { decision: "approve", secret: PIN });
        assert.equal(await gate({ config, hidden: () => set, ticket: p.retryWith.ticket }), null);
    });

    it('approval.secret "password" with none set: refused, nothing opened', async () => {
        const res = await gate({ config: { approval: { secret: "password" } }, accountDir: freshDir() });
        assert.equal(res.isError, true);
        assert.match(payloadOf(res).error, /mcp approver set/);
        assert.equal(payloadOf(res).secureUrl, undefined);
    });
});

describe('approval.deliver "webhook": the link goes to the webhook only', () => {
    let page;
    const events = [];
    before(async () => {
        page = new SecurePage({ accountId: ACCOUNT }).configure({ notify: (e) => events.push(e) });
        await page.ensureServed();
    });
    after(() => page.close());
    const config = { confirmMode: "human", approval: { deliver: "webhook" } };

    it("the tool result carries no link and no page token; the event carries both what and where", async () => {
        events.length = 0;
        const res = await gateMcp(
            "conv.delete",
            { threadId: THREAD },
            {
                config,
                env: {},
                accountId: ACCOUNT,
                stateless: true,
                securePage: page,
                accountDir: freshDir(),
            },
        );
        const text = res.content.map((c) => c.text).join("\n");
        const p = JSON.parse(res.content[0].text);
        assert.equal(res.isError, true);
        assert.deepEqual([p.confirmationRequired, p.approvalPending, p.deliveredTo], [true, true, "webhook"]);
        assert.ok(p.ticket);
        assert.equal(p.secureUrl, undefined);
        assert.doesNotMatch(text, /https?:\/\/|\/zalo\/secure\//, "nothing the agent could open");

        assert.equal(events.length, 1);
        const e = events[0];
        assert.deepEqual(Object.keys(e).sort(), [
            "accountId",
            "action",
            "approverSecret",
            "event",
            "expiresAt",
            "kind",
            "secureUrl",
            "target",
            "wouldDo",
        ]);
        assert.equal(e.event, "approval_requested");
        assert.equal(e.action, "zalo_conversation delete");
        assert.match(e.wouldDo, new RegExp(THREAD));
        assert.deepEqual(e.target, { threadId: THREAD });
        assert.ok(Date.parse(e.expiresAt) > Date.now());
        const pageToken = e.secureUrl.split("/").pop();
        assert.notEqual(pageToken, p.ticket, "the claim ticket is not the page's token");
        assert.equal(text.includes(pageToken), false);

        // The agent cannot use the page token as its ticket, and the claim works once the person approved.
        const expect = { accountId: ACCOUNT, action: "conv.delete", target: { threadId: THREAD } };
        assert.equal(page.store.consume(pageToken, expect).ok, false);
        assert.equal((await post(e.secureUrl, { decision: "approve" })).status, 200);
        const again = await gateMcp(
            "conv.delete",
            { threadId: THREAD },
            {
                config,
                env: {},
                accountId: ACCOUNT,
                stateless: true,
                securePage: page,
                ticket: p.ticket,
            },
        );
        assert.equal(again, null);
    });

    it("a PIN page goes the same way: pinRequired, approvalPending, no link", async () => {
        events.length = 0;
        const set = pinned();
        const ctx = {
            api: {
                getHiddenConversations: async () => ({ pin: createHash("md5").update(PIN).digest("hex"), threads: [] }),
            },
            hidden: () => set,
            securePage: () => page,
            ownId: () => ACCOUNT,
            config: { approval: { deliver: "webhook" } },
            stateless: true,
        };
        const out = await CONVERSATION_ACTIONS.hidden.run({}, ctx, {});
        const r = out.needsReply;
        assert.deepEqual([r.pinRequired, r.approvalPending, r.deliveredTo], [true, true, "webhook"]);
        assert.equal(r.secureUrl, undefined);
        assert.doesNotMatch(JSON.stringify(out), /https?:\/\//);
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, "pin");
        assert.equal(events[0].action, "conv.hidden");
    });

    it('"both" posts the event and keeps the link in the result; "webhook" with no webhook is refused', async () => {
        events.length = 0;
        const both = await askOnSecurePage({
            page,
            spec: { accountId: ACCOUNT, action: "conv.hidden", target: {}, kind: "pin", title: "t", description: "d" },
            needs: "pinRequired",
            deliver: "both",
        });
        assert.ok(both.reply.secureUrl);
        assert.equal(both.reply.deliveredTo, "both");
        assert.equal(events[0].secureUrl, both.reply.secureUrl);

        const bare = new SecurePage({ accountId: ACCOUNT }).configure({ localBaseUrl: "http://127.0.0.1:9" });
        const none = await askOnSecurePage({
            page: bare,
            spec: { accountId: ACCOUNT, action: "conv.hidden", target: {}, kind: "pin", title: "t", description: "d" },
            needs: "pinRequired",
            deliver: "webhook",
        });
        assert.match(none.error, /no webhook/);
    });

    it("the event is queued and signed like every other webhook event", async () => {
        const dir = freshDir();
        const outbox = openOutbox(dir);
        const sent = [];
        const dispatcher = createWebhookDispatcher({
            outbox,
            url: "https://crm.example.com/hooks/zalo",
            secret: "fake-signing-secret",
            accountId: ACCOUNT,
            pollMs: 0,
            fetchFn: async (url, init) => {
                sent.push(init);
                return { status: 200, body: null };
            },
        });
        const p = new SecurePage({ accountId: ACCOUNT }).configure({
            localBaseUrl: "http://127.0.0.1:9",
            notify: (payload) => outbox.enqueue(null, JSON.stringify(payload)),
        });
        await gateMcp(
            "conv.delete",
            { threadId: OTHER },
            {
                config,
                env: {},
                accountId: ACCOUNT,
                stateless: true,
                securePage: p,
            },
        );
        await dispatcher.drain();
        await dispatcher.stop();
        outbox.close();
        assert.equal(sent.length, 1);
        const body = JSON.parse(sent[0].body);
        assert.equal(body.event, "approval_requested");
        const sig = createHmac("sha256", "fake-signing-secret").update(sent[0].body).digest("hex");
        assert.equal(sent[0].headers["X-Zalo-Signature"], `sha256=${sig}`);
        assert.equal(sent[0].headers.Authorization, "Bearer fake-signing-secret");
    });
});

describe("URL-mode elicitation: the link goes through the client only", () => {
    it("a page left unanswered times out without putting the link in the result", async () => {
        const page = new SecurePage({ accountId: ACCOUNT, store: new TicketStore({ ttlMs: 50 }) }).configure({
            localBaseUrl: "http://127.0.0.1:9",
        });
        const server = {
            server: {
                getClientCapabilities: () => ({ elicitation: { url: {} } }),
                elicitInput: async () => ({ action: "accept" }),
            },
        };
        const r = await askOnSecurePage({
            page,
            server,
            spec: { accountId: ACCOUNT, action: "conv.hidden", target: {}, kind: "pin", title: "t", description: "d" },
            needs: "pinRequired",
        });
        assert.equal(r.reply, undefined);
        assert.equal(r.declined, "timeout");
        assert.doesNotMatch(JSON.stringify(r), /https?:\/\//);
    });
});

describe("the start-up warning", () => {
    it("human mode with a click-only link through the agent recommends a secret; a password or webhook silences it", () => {
        const lines = [];
        const log = (l) => lines.push(l);
        const human = { confirmMode: "human" };
        const none = freshDir();
        assert.equal(
            warnApprovalPolicy({ config: human, accountId: ACCOUNT, accountDir: none, hasWebhook: false, env: {}, log })
                .length,
            1,
        );
        assert.match(lines[0], /mcp approver set/);
        const set = freshDir();
        setApproverPassword(set, PASSWORD);
        assert.equal(
            warnApprovalPolicy({ config: human, accountId: ACCOUNT, accountDir: set, hasWebhook: false, env: {}, log })
                .length,
            0,
        );
        const hook = { ...human, approval: { deliver: "webhook" } };
        assert.equal(
            warnApprovalPolicy({ config: hook, accountId: ACCOUNT, accountDir: none, hasWebhook: true, env: {}, log })
                .length,
            0,
        );
        const noHook = warnApprovalPolicy({
            config: hook,
            accountId: ACCOUNT,
            accountDir: none,
            hasWebhook: false,
            env: {},
            log,
        });
        assert.match(noHook[0], /no webhook/);
        assert.equal(
            warnApprovalPolicy({ config: {}, accountId: ACCOUNT, accountDir: none, hasWebhook: false, env: {}, log })
                .length,
            0,
            "agent mode",
        );
    });
});

describe("zalo_conversation: hidden chats", () => {
    const hash = createHash("md5").update(PIN).digest("hex");
    const ctxFor = ({ threads = [], config = {}, set = new HiddenChats(), api = {} } = {}) => {
        const page = new SecurePage({ accountId: ACCOUNT }).configure({ localBaseUrl: "http://127.0.0.1:9" });
        return {
            api: { getHiddenConversations: async () => ({ pin: hash, threads }), ...api },
            hidden: () => set,
            hiddenMode: () => config.hiddenChats ?? "exclude",
            securePage: () => page,
            ownId: () => ACCOUNT,
            config,
            stateless: true,
        };
    };

    it("hidden: with a PIN set and nothing hidden, a wrong PIN is refused and counted; the right one lists nothing", async () => {
        const set = new HiddenChats();
        const ctx = ctxFor({ set, config: { allowPinArgument: true } });
        await assert.rejects(CONVERSATION_ACTIONS.hidden.run({ pin: "0000" }, ctx, {}), /Wrong PIN/);
        assert.equal(set.lockoutStatus().failures, 1);
        const ok = await CONVERSATION_ACTIONS.hidden.run({ pin: PIN }, ctx, {});
        assert.deepEqual(ok, { count: 0, hasPin: true, threads: [] });
        // And without a PIN input: the needs-PIN page, not the empty list.
        const asked = await CONVERSATION_ACTIONS.hidden.run({}, ctxFor({ config: {} }), {});
        assert.equal(asked.needsReply?.pinRequired, true);
    });

    for (const hiddenChats of ["exclude", "contentless", "include"]) {
        it(`archived and muted under ${hiddenChats}`, async () => {
            const shows = hiddenChats === "include";
            const set = new HiddenChats().setFromServer({ pin: hash, threads: [{ thread_id: THREAD, is_group: 0 }] });
            const api = {
                getArchivedChatList: async () => ({
                    items: [
                        { id: THREAD, type: 0 },
                        { id: OTHER, type: 0 },
                    ],
                    version: 2,
                }),
                getMute: async () => ({
                    chatEntries: [{ id: THREAD }, { id: OTHER }],
                    groupChatEntries: [],
                }),
            };
            const ctx = ctxFor({ set, api, config: { hiddenChats } });
            const archived = await CONVERSATION_ACTIONS.archived.run({}, ctx, {});
            assert.deepEqual(
                archived.data.items.map((i) => i.id),
                shows ? [THREAD, OTHER] : [OTHER],
            );
            assert.equal(archived.data.version, 2);
            const muted = await CONVERSATION_ACTIONS.muted.run({}, ctx, {});
            assert.deepEqual(
                muted.conversations.map((m) => m.threadId),
                shows ? [THREAD, OTHER] : [OTHER],
            );
        });
    }
});
