/**
 * The Message Router, phases 3-6: routes and the test box, claims and the owner's human pause, sticky focus and reply
 * affinity, fallback, staff on their own Zalo, `@agents`, and per-agent privacy.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    checkRouting,
    createClaims,
    decide,
    guardSend,
    inWindow,
    agentsListText,
} from "../../src/core/message-router.js";
import { checkAgents } from "../../src/core/routing-policy.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
import { createRouterRuntime } from "../../src/mcp/router-runtime.js";
import { createAgentPresence, createSentByStore, resolveRouting } from "../../src/mcp/agents.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const OWNER = "9001";
const CUSTOMER = "5001";
const STAFF_UID = "7001";
const MYDOCS = "9009";
const AGENTS = checkAgents([
    { slug: "ai", name: "AI", credential: "apikey:0123456789ab", kind: "companion" },
    { slug: "dev", name: "Dev", credential: "apikey:ba9876543210" },
    { slug: "night", name: "Night", credential: "legacy" },
]).value;

const ROUTING = {
    enabled: true,
    claims: true,
    owners: [OWNER],
    routes: [
        { id: "dev", target: "dev", match: { trigger: { word: "@dev", sticky: true } } },
        { id: "ticket", target: "staff:lan", match: { trigger: { word: "#ticket", who: "anyone" } } },
        { id: "vip", target: "dev", match: { labels: ["VIP"] } },
        { id: "groups", target: "nobody", match: { threadType: "group" } },
        {
            id: "night",
            target: "night",
            match: { window: { days: ["mon", "tue", "wed", "thu", "fri"], from: "18:00", to: "08:00", tz: "UTC" } },
        },
        { id: "dms", target: "ai", match: { threadType: "dm", senders: ["anyone"] }, fallback: ["dev", "human"] },
    ],
    default: { target: "human" },
    staff: [{ id: "lan", name: "Lan", zaloUserId: STAFF_UID, channels: ["zalo", "console"] }],
};
// A Wednesday 10:00 UTC, and the same day 20:00 UTC.
const DAY = Date.parse("2026-11-18T10:00:00Z");
const NIGHT = Date.parse("2026-11-18T20:00:00Z");
const cfg = (patch = {}) => checkRouting({ ...ROUTING, ...patch }).value;
const msg = (o) => ({ threadId: CUSTOMER, threadType: "dm", senderId: CUSTOMER, text: "hello", type: "text", ...o });
const listening = () => ({ state: "listening" });

describe("routing settings", () => {
    it("checks routes, and lets customers use only a hashtag trigger", () => {
        assert.equal(cfg().routes.length, 6);
        assert.match(
            checkRouting({ routes: [{ id: "x", target: "dev", match: { trigger: { word: "@dev", who: "anyone" } } }] })
                .error,
            /hashtag/,
        );
        assert.match(checkRouting({ routes: [{ id: "x", target: "Bad Target" }] }).error, /target/);
        assert.match(
            checkRouting({
                routes: [
                    { id: "a", target: "dev" },
                    { id: "a", target: "ai" },
                ],
            }).error,
            /twice/,
        );
        assert.match(checkRouting({ staff: [{ id: "s", channels: ["zalo"] }] }).error, /zaloUserId/);
        assert.match(checkRouting({ settings: { claimTtl: "1s" } }).error, /10s/);
        assert.equal(checkRouting({ settings: { humanPause: "20m" } }).value.settings.humanPause, 20 * 60_000);
    });

    it("is a set of live policy keys of an account", () => {
        const ok = validatePolicy({
            routing: { enabled: true, claims: true, routes: ROUTING.routes, default: { target: "ai" } },
        });
        assert.deepEqual(ok.errors, []);
        const bad = validatePolicy({ routing: { routes: [{ id: "x" }] } });
        assert.equal(bad.errors[0].key, "routing.routes");
        assert.equal(resolveRouting({ policy: { routing: { ...ROUTING, agents: [] } } }).cfg.enabled, true);
        assert.equal(resolveRouting({ policy: null }).cfg.enabled, false);
    });

    it("reads a window in its time zone, across midnight", () => {
        const w = { days: ["wed"], from: "18:00", to: "08:00", tz: "UTC" };
        assert.equal(inWindow(w, NIGHT), true);
        assert.equal(inWindow(w, DAY), false);
        // Thursday 03:00 still belongs to Wednesday's night.
        assert.equal(inWindow(w, Date.parse("2026-11-19T03:00:00Z")), true);
    });
});

describe("decide: one handler per message, with the reason", () => {
    const base = { agents: AGENTS, now: DAY, presenceOf: listening };

    it("the owner's @dev goes to Dev without the trigger, and sets the focus", () => {
        const d = decide(msg({ senderId: OWNER, text: "@dev fix the export" }), { ...base, cfg: cfg() });
        assert.deepEqual(
            [d.to, d.by, d.ruleId, d.text, d.effects.sticky],
            ["dev", "trigger", "dev", "fix the export", "dev"],
        );
    });

    it("a customer typing @dev is not routed by it; a customer's #ticket is, the hashtag kept", () => {
        assert.equal(decide(msg({ text: "@dev hi" }), { ...base, cfg: cfg() }).to, "ai");
        const t = decide(msg({ text: "my order #ticket please" }), { ...base, cfg: cfg() });
        assert.deepEqual([t.to, t.by, t.text], ["staff:lan", "trigger", undefined]);
    });

    it("labels, thread type and time windows pick the route; the default catches the rest", () => {
        const c = cfg();
        assert.equal(decide(msg({}), { ...base, cfg: c, labelsOf: () => ["vip"] }).ruleId, "vip");
        assert.equal(decide(msg({ threadType: "group", threadId: "g1" }), { ...base, cfg: c }).to, "nobody");
        assert.equal(decide(msg({}), { ...base, cfg: c, now: NIGHT }).to, "night");
        assert.equal(decide(msg({ threadType: "group" }), { ...base, cfg: cfg({ routes: [] }) }).by, "default");
    });

    it("the owner's human pause, sticky focus, reply affinity and claims come before the table", () => {
        const c = cfg();
        const claims = createClaims({ now: () => DAY });
        claims.startHuman(CUSTOMER, 60_000);
        assert.equal(decide(msg({}), { ...base, cfg: c, state: claims }).to, "human");
        claims.endHuman(CUSTOMER);
        claims.setSticky(CUSTOMER, "dev", 60_000);
        assert.equal(
            decide(msg({ senderId: OWNER, text: "and also this" }), { ...base, cfg: c, state: claims }).by,
            "sticky",
        );
        const ended = decide(msg({ senderId: OWNER, text: "@end" }), { ...base, cfg: c, state: claims });
        assert.equal(ended.effects.sticky, "clear");
        const reply = decide(msg({ replyTo: { msgId: "m9" } }), {
            ...base,
            cfg: c,
            sentByOf: (id) => (id === "m9" ? { agent: "dev", at: new Date(DAY - 1000).toISOString() } : null),
        });
        assert.deepEqual([reply.to, reply.by], ["dev", "reply"]);
        claims.setSticky(CUSTOMER, null);
        claims.assign(CUSTOMER, "night", { ms: 60_000 });
        assert.deepEqual([decide(msg({}), { ...base, cfg: c, state: claims }).to], ["night"]);
    });

    it("without the claims feature, only triggers and the table apply", () => {
        const claims = createClaims({ now: () => DAY });
        claims.startHuman(CUSTOMER, 60_000);
        assert.equal(decide(msg({}), { ...base, cfg: cfg({ claims: false }), state: claims }).to, "ai");
    });

    it("falls back when the target is away past fallbackAfter: the route's chain, then the owner with a notice", () => {
        const away = (slug) =>
            slug === "ai"
                ? { state: "away", since: new Date(DAY - 10 * 60_000).toISOString() }
                : { state: "listening" };
        const d = decide(msg({}), { ...base, cfg: cfg(), presenceOf: away });
        assert.deepEqual([d.to, d.by, d.before], ["dev", "fallback", "ai"]);
        const both = decide(msg({}), {
            ...base,
            cfg: cfg(),
            presenceOf: (s) => ({
                state: s === "night" ? "listening" : "away",
                since: new Date(DAY - 3600_000).toISOString(),
            }),
        });
        assert.deepEqual([both.to, both.notice], ["human", { owner: true }]);
        const recent = decide(msg({}), {
            ...base,
            cfg: cfg(),
            presenceOf: () => ({ state: "away", since: new Date(DAY - 60_000).toISOString() }),
        });
        assert.equal(recent.to, "ai", "not away long enough");
        const auto = cfg({ routes: [{ id: "d", target: "ai", match: {}, fallback: [{ autoReply: "Back soon" }] }] });
        const old = new Date(DAY - 3600_000).toISOString();
        const a = decide(msg({}), { ...base, cfg: auto, presenceOf: () => ({ state: "away", since: old }) });
        assert.deepEqual(a.notice, { autoReply: "Back soon" });
        // Never seen (a webhook receiver): its messages wait for it.
        assert.equal(decide(msg({}), { ...base, cfg: auto, presenceOf: () => ({ state: "idle" }) }).to, "ai");
    });

    it("`@agents` from the owner is the system's, never an agent's", () => {
        assert.equal(decide(msg({ senderId: OWNER, text: "@agents" }), { ...base, cfg: cfg() }).by, "agents");
        assert.match(
            agentsListText([{ slug: "dev", name: "Dev", presence: { state: "away" } }], "en"),
            /Dev \(@dev\): away/,
        );
    });
});

describe("the send guard", () => {
    it("refuses during the human pause, into another agent's conversation or message, and outside privacy", () => {
        const c = cfg({ isolation: true });
        const claims = createClaims();
        const [ai, dev] = AGENTS;
        assert.equal(guardSend({ cfg: cfg({ enabled: false }), claims, agent: ai, threadId: CUSTOMER }).ok, true);
        claims.startHuman(CUSTOMER, 60_000);
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: CUSTOMER }).code, "HUMAN_ACTIVE");
        claims.endHuman(CUSTOMER);
        claims.assign(CUSTOMER, "dev", { ms: 60_000, held: true });
        const g = guardSend({ cfg: c, claims, agent: ai, threadId: CUSTOMER });
        assert.deepEqual([g.code, g.holder], ["CLAIMED", "dev"]);
        assert.equal(guardSend({ cfg: c, claims, agent: dev, threadId: CUSTOMER }).ok, true);
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: "other" }).code, "NOT_ROUTED");
        claims.assign("g1", "ai", { ms: 60_000, ownership: "message", msgId: "q1" });
        assert.equal(guardSend({ cfg: cfg(), claims, agent: dev, threadId: "g1", quoteMsgId: "q1" }).code, "CLAIMED");
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: MYDOCS, ownerChat: true }).ok, true);
    });
});

/** A runtime over a fake session that records every send. */
function rig(routing = ROUTING, presenceOf = null) {
    const sent = [];
    let seq = 0;
    const api = {
        sendMessage: async (content, threadId, type) => {
            seq++;
            sent.push({ text: typeof content === "string" ? content : content.msg, threadId, type });
            return { message: { msgId: `s${seq}`, cliMsgId: `c${seq}` } };
        },
        getLabels: async () => ({ labelData: [{ text: "VIP", conversations: ["vip1"] }] }),
        getOwnId: () => "1001",
        getContext: () => ({ loginInfo: { send2me_id: MYDOCS } }),
    };
    const presence = createAgentPresence();
    const sentBy = createSentByStore(null);
    const routingNow = () =>
        resolveRouting({
            policy: {
                routing: {
                    ...routing,
                    agents: AGENTS.map(({ slug, name, credential, kind }) => ({ slug, name, credential, kind })),
                },
            },
        });
    const runtime = createRouterRuntime({
        routingNow,
        getApi: () => api,
        ids: () => ({ ownId: "1001", send2meId: MYDOCS }),
        presence,
        sentBy,
        lang: "en",
        presenceOf,
        now: () => DAY,
    });
    return { sent, api, runtime, presence, sentBy, routingNow };
}

describe("the runtime in the daemon", () => {
    it("routes a message, strips the owner's trigger, keeps the raw text and the focus", async () => {
        const { runtime } = rig();
        const m = await runtime.onIncoming(msg({ senderId: OWNER, threadId: OWNER, text: "@dev look" }));
        assert.deepEqual([m.route.to, m.text, m.rawText], ["dev", "look", "@dev look"]);
        const next = await runtime.onIncoming(msg({ senderId: OWNER, threadId: OWNER, text: "more" }));
        assert.deepEqual([next.route.to, next.route.by], ["dev", "sticky"]);
    });

    it("the owner's own send from his phone pauses the agents; @agents is answered in My Documents only", async () => {
        const { runtime, sent } = rig();
        assert.equal(await runtime.onOwn(msg({ isSelf: true, text: "I'll take this" }), { byAgent: false }), null);
        const g = runtime.guard({ agent: AGENTS[0] }, CUSTOMER, null);
        assert.equal(g.code, "HUMAN_ACTIVE");
        assert.equal((await runtime.onIncoming(msg({}))).route.to, "human");
        // An agent's own echo starts nothing.
        await runtime.onOwn(msg({ threadId: "other", isSelf: true }), { byAgent: true });
        assert.equal(runtime.guard({ agent: AGENTS[0] }, "other", null).ok, true);
        assert.equal(await runtime.onOwn(msg({ isSelf: true, text: "@agents" }), { byAgent: false }), "answered");
        assert.equal(sent.at(-1).threadId, MYDOCS);
        assert.match(sent.at(-1).text, /AI \(@ai\)/);
    });

    it("forwards a #ticket to the staff member's own Zalo and relays his reply to the customer with his mark", async () => {
        const { runtime, sent, sentBy } = rig();
        const m = await runtime.onIncoming(msg({ text: "broken #ticket", senderName: "Customer" }));
        assert.equal(m.route.to, "staff:lan");
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(sent[0].threadId, STAFF_UID);
        assert.match(sent[0].text, /Customer: broken #ticket/);
        const reply = await runtime.onIncoming(
            msg({ threadId: STAFF_UID, senderId: STAFF_UID, text: "On it", replyTo: { msgId: "s1" } }),
        );
        assert.equal(reply, null, "a relayed reply never reaches the agents");
        assert.deepEqual([sent[1].threadId, sent[1].text], [CUSTOMER, "👤 Lan: On it"]);
        assert.equal(sentBy.lookup({ msgId: "s2" }).agent, "staff:lan");
    });

    it("gives each agent its own view, and under privacy hides conversations never routed to it", async () => {
        const { runtime } = rig({ ...ROUTING, isolation: true });
        const a = await runtime.onIncoming(msg({}));
        const g = await runtime.onIncoming(msg({ threadId: "g1", threadType: "group" }));
        const ai = { agent: AGENTS[0] };
        const dev = { agent: AGENTS[1] };
        assert.deepEqual(
            runtime.viewFilter([a, g], ai).map((x) => x.threadId),
            [CUSTOMER],
        );
        assert.deepEqual(runtime.viewFilter([a, g], dev), []);
        assert.deepEqual(runtime.viewFilter([a, g], { agent: null }), []);
        assert.equal(runtime.mayRead(ai, CUSTOMER), true);
        assert.equal(runtime.mayRead(dev, CUSTOMER), false);
    });

    it("the auto-reply step answers the customer once, the owner's notice goes to My Documents", async () => {
        const { runtime, sent } = rig(
            { ...ROUTING, routes: [{ id: "d", target: "ai", match: {}, fallback: [{ autoReply: "Back soon" }] }] },
            () => ({ state: "away", since: new Date(DAY - 3600_000).toISOString() }),
        );
        await runtime.onIncoming(msg({}));
        await runtime.onIncoming(msg({}));
        await new Promise((r) => setTimeout(r, 5));
        assert.deepEqual(
            sent.map((s) => [s.threadId, s.text]),
            [[CUSTOMER, "Back soon"]],
        );
    });
});

describe("the tools with routing on", () => {
    function tools(caller) {
        const { runtime, api } = rig();
        const registered = new Map();
        const server = { caller, registerTool: (n, meta, h) => registered.set(n, h) };
        const buffer = {
            router: runtime,
            read: () => ({ messages: [], cursor: 0 }),
            getStats: () => [],
            getThreadType: () => "dm",
            markRead: () => 0,
            readCursor: () => 0,
        };
        registerTools(
            server,
            api,
            buffer,
            { isWatched: () => true },
            { routing: { ...ROUTING, agents: AGENTS } },
            { ready: true, get: () => null, search: () => [] },
            undefined,
        );
        const call = async (n, args) => {
            const r = await registered.get(n)(args, {});
            return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
        };
        return { call, runtime };
    }

    it("refuses an agent's send while the owner answers, and route_test says who would get a message", async () => {
        const { call, runtime } = tools({ credential: "apikey:0123456789ab" });
        await runtime.onOwn(msg({ isSelf: true }), { byAgent: false });
        const r = await call("zalo_send_message", { threadId: CUSTOMER, threadType: 0, text: "hi", format: "plain" });
        assert.match(r.error, /HUMAN_ACTIVE/);
        const t = await call("zalo_inbox", {
            action: "route_test",
            threadId: CUSTOMER,
            text: "#ticket",
            senderId: CUSTOMER,
        });
        assert.deepEqual([t.to, t.by], ["human", "human"]);
        const who = await call("zalo_inbox", { action: "whoami" });
        assert.deepEqual(who.routing, { enabled: true, claims: true, isolation: false });
    });

    it("claim, handoff and claims", async () => {
        const { call } = tools({ credential: "apikey:ba9876543210" });
        assert.equal((await call("zalo_inbox", { action: "claim", threadId: "t1" })).holder, "dev");
        assert.equal((await call("zalo_inbox", { action: "claims" })).claims.length, 1);
        assert.equal(
            (await call("zalo_inbox", { action: "handoff", threadId: "t1", to: "ai", note: "yours" })).to,
            "ai",
        );
        assert.equal((await call("zalo_inbox", { action: "claims" })).claims.length, 0);
    });
});
