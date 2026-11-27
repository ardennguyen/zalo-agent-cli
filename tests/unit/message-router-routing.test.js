/**
 * The Companion Router, phases 3-6: routes and the test box, claims and the owner's human pause, sticky focus and reply
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
import {
    RECONNECT_GRACE_MS,
    connectionState,
    createAgentPresence,
    createSentByStore,
    resolveRouting,
} from "../../src/mcp/agents.js";
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

    const longAgo = new Date(DAY - 3600_000).toISOString();
    const awayAll = () => ({ state: "away", since: longAgo });
    const offline = (slugs) => (slug) =>
        slugs.includes(slug) ? { online: false, since: 0 } : { online: true, since: 0 };

    it("a service (the companion) is always routed: never away, never queued, whatever its presence", () => {
        assert.equal(AGENTS[0].type, "service");
        const d = decide(msg({}), { ...base, cfg: cfg(), presenceOf: awayAll, connectionOf: offline(["ai"]) });
        assert.deepEqual([d.to, d.by, d.before, d.queued, d.notice], ["ai", "rule", undefined, undefined, undefined]);
        const def = decide(msg({ threadType: "group" }), {
            ...base,
            cfg: cfg({ routes: [], default: { target: "ai" } }),
            presenceOf: awayAll,
            connectionOf: offline(["ai"]),
        });
        assert.deepEqual([def.to, def.by, def.queued], ["ai", "default", undefined]);
    });

    it("an offline client keeps its message, queued for it: no other agent answers in its place", () => {
        const c = cfg({ default: { target: "ai" } });
        const d = decide(msg({}), { ...base, cfg: c, labelsOf: () => ["vip"], connectionOf: offline(["dev"]) });
        assert.deepEqual([d.to, d.by, d.ruleId, d.queued, d.before], ["dev", "rule", "vip", true, undefined]);
        assert.deepEqual(d.notice, { away: { agent: "dev", name: "Dev", since: 0 } });
        assert.deepEqual(d.effects.claim, { holder: "dev", state: "assigned" }, "the conversation stays the client's");
        // Its presence says nothing: a client with an open wait is there even after `status away`; one without is not,
        // however recently it called.
        const there = decide(msg({}), { ...base, cfg: c, labelsOf: () => ["vip"], presenceOf: awayAll });
        assert.deepEqual([there.to, there.queued], ["dev", undefined]);
        const polled = decide(msg({}), {
            ...base,
            cfg: c,
            labelsOf: () => ["vip"],
            presenceOf: listening,
            connectionOf: offline(["dev"]),
        });
        assert.deepEqual([polled.to, polled.queued], ["dev", true]);
    });

    it("only an agent turned off hands its message on: its route's list, the default route, then the owner", () => {
        const off = (slugs) => AGENTS.map((a) => (slugs.includes(a.slug) ? { ...a, enabled: false } : a));
        const d = decide(msg({}), { ...base, agents: off(["ai"]), cfg: cfg() });
        assert.deepEqual(
            [d.to, d.by, d.before, d.reason, d.notice],
            ["dev", "fallback", "ai", "disabled", { owner: true }],
        );
        const toDefault = decide(msg({}), {
            ...base,
            agents: off(["dev"]),
            cfg: cfg({ default: { target: "ai" } }),
            labelsOf: () => ["vip"],
        });
        assert.deepEqual([toDefault.to, toDefault.before], ["ai", "dev"]);
        const listed = cfg({
            default: { target: "ai" },
            routes: [{ id: "d", target: "dev", match: {}, fallback: ["human"] }],
        });
        assert.equal(
            decide(msg({}), { ...base, agents: off(["dev"]), cfg: listed }).to,
            "human",
            "as the owner wrote it",
        );
        const none = decide(msg({}), {
            ...base,
            agents: off(["dev"]),
            cfg: cfg({ routes: [{ id: "d", target: "dev", match: {} }] }),
        });
        assert.deepEqual([none.to, none.notice], ["human", { owner: true }]);
        const auto = cfg({ routes: [{ id: "d", target: "dev", match: {}, fallback: [{ autoReply: "Back soon" }] }] });
        const a = decide(msg({}), { ...base, agents: off(["dev"]), cfg: auto });
        assert.deepEqual([a.to, a.notice], ["human", { autoReply: "Back soon", owner: true }]);
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
        // A client stays out of a conversation never routed to it; the companion (a service) is refused only where
        // another agent has the conversation.
        assert.equal(guardSend({ cfg: c, claims, agent: dev, threadId: "other" }).code, "NOT_ROUTED");
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: "other" }).ok, true);
        claims.noteRouted("dev", "devs", 60_000);
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: "devs" }).code, "NOT_ROUTED");
        // The default route's agent is open the same way, whatever its type.
        const devDefault = cfg({ isolation: true, default: { target: "dev" } });
        assert.equal(guardSend({ cfg: devDefault, claims, agent: dev, threadId: "other" }).ok, true);
        claims.assign("g1", "ai", { ms: 60_000, ownership: "message", msgId: "q1" });
        assert.equal(guardSend({ cfg: cfg(), claims, agent: dev, threadId: "g1", quoteMsgId: "q1" }).code, "CLAIMED");
        assert.equal(guardSend({ cfg: c, claims, agent: ai, threadId: MYDOCS, ownerChat: true }).ok, true);
    });
});

/** A runtime over a fake session that records every send. */
function rig(routing = ROUTING, presenceOf = null, connectionOf = null) {
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
    const logs = [];
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
        connectionOf,
        now: () => DAY,
        log: (line) => logs.push(line),
    });
    return { sent, api, runtime, presence, sentBy, routingNow, logs };
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

    it("under privacy the companion may write to a friend the owner names, and the conversation is then its own", async () => {
        const FRIEND = "5009";
        const { runtime } = rig({ ...ROUTING, isolation: true });
        const ai = { agent: AGENTS[0] };
        const dev = { agent: AGENTS[1] };
        // Never routed to anyone (2026-11-27: refused NOT_ROUTED): the companion's send goes out and claims it.
        assert.equal(runtime.guard(ai, FRIEND, null).ok, true);
        assert.equal(runtime.mayRead(ai, FRIEND), true);
        runtime.onAgentSend("ai", FRIEND);
        // Another agent is kept out, and the friend's reply comes back to the companion.
        assert.deepEqual(
            [runtime.guard(dev, FRIEND, null).code, runtime.guard(dev, FRIEND, null).holder],
            ["CLAIMED", "ai"],
        );
        assert.equal(runtime.mayRead(dev, FRIEND), false);
        const reply = await runtime.onIncoming(msg({ threadId: FRIEND, senderId: FRIEND, text: "ok" }));
        assert.deepEqual([reply.route.to, reply.route.by], ["ai", "claim"]);
        // A conversation another agent holds still refuses the companion.
        runtime.claims.assign("5010", "dev", { ms: 60_000, held: true });
        assert.equal(runtime.guard(ai, "5010", null).code, "CLAIMED");
        assert.equal(runtime.mayRead(ai, "5010"), false);
        // A client is not opened that way.
        assert.equal(runtime.guard(dev, "5011", null).code, "NOT_ROUTED");
    });

    it("an agent turned off: the auto-reply step answers the customer once, the owner is told in My Documents", async () => {
        const { runtime, sent, logs } = rig(
            { ...ROUTING, routes: [{ id: "d", target: "dev", match: {}, fallback: [{ autoReply: "Back soon" }] }] },
            (slug) => (slug === "dev" ? { state: "disabled" } : { state: "listening" }),
        );
        await runtime.onIncoming(msg({}));
        await runtime.onIncoming(msg({}));
        await new Promise((r) => setTimeout(r, 5));
        assert.deepEqual(
            sent.map((x) => [x.threadId, x.text]),
            [
                [CUSTOMER, "Back soon"],
                [MYDOCS, `⚠️ dev is turned off: a message waits for you (conversation ${CUSTOMER}).`],
            ],
        );
        assert.equal(logs.filter((l) => /\[router\] fallback: dev is disabled/.test(l)).length, 2, "each one logged");
        const ev = (await runtime.serve({ action: "events" })).events.at(-1);
        assert.deepEqual([ev.kind, ev.to, ev.before, ev.reason], ["fallback", "human", "dev", "disabled"]);
    });

    it("an offline client: queued for it, the companion tells the sender once per conversation and absence", async () => {
        let conn = { online: false, since: 0 };
        const { runtime, sent, logs } = rig(
            {
                ...ROUTING,
                routes: [{ id: "d", target: "dev", match: {} }],
                default: { target: "ai" },
                awayNotice: "Be brief.",
            },
            null,
            (slug) => (slug === "dev" ? conn : { online: true, since: 0 }),
        );
        const m1 = await runtime.onIncoming(msg({ msgId: "m1", text: "first" }));
        const m2 = await runtime.onIncoming(msg({ msgId: "m2", text: "second" }));
        const other = await runtime.onIncoming(msg({ msgId: "m3", threadId: "5002", senderId: "5002" }));
        await new Promise((r) => setTimeout(r, 5));
        assert.deepEqual([m1.route.to, m1.route.queued], ["dev", true]);
        assert.deepEqual(m1.route.absence, { agent: "dev", name: "Dev", notifier: "ai", guidance: "Be brief." });
        assert.equal(m2.route.absence, undefined, "once per conversation and absence");
        assert.equal(other.route.absence.notifier, "ai", "another conversation is told too");
        assert.deepEqual(sent, [], "the engine sends no text of its own: the companion writes the notice");
        const events = (await runtime.serve({ action: "events" })).events;
        assert.deepEqual(
            events.map((e) => [e.kind, e.to, e.notifier ?? null]),
            [
                ["queued", "dev", "ai"],
                ["queued", "dev", null],
                ["queued", "dev", "ai"],
            ],
        );
        assert.match(logs[0], /dev is offline: message m1 in 5001 is queued for it; ai tells the sender/);
        // The companion sees the message it must notice, and may send its one notice though Dev holds the conversation.
        const ai = { agent: AGENTS[0] };
        assert.deepEqual(
            runtime.viewFilter([m1, m2], ai).map((x) => x.msgId),
            ["m1"],
        );
        assert.equal(runtime.guard(ai, CUSTOMER, null).ok, true);
        assert.equal(runtime.guard(ai, CUSTOMER, null).code, "CLAIMED", "one notice, then the client's again");
        // Dev comes back: it gets what was queued, in order.
        conn = { online: true, since: 0 };
        const dev = { agent: AGENTS[1] };
        assert.deepEqual(
            runtime.viewFilter([m1, m2], dev).map((x) => [x.msgId, x.role ?? null]),
            [
                ["m1", null],
                ["m2", null],
            ],
        );
        const back = await runtime.onIncoming(msg({ msgId: "m4" }));
        assert.deepEqual([back.route.to, back.route.queued, back.route.absence], ["dev", undefined, undefined]);
        // It leaves again (a new absence): the conversation is told again, once.
        conn = { online: false, since: DAY - 1000 };
        const again = await runtime.onIncoming(msg({ msgId: "m5" }));
        assert.equal(again.route.absence.notifier, "ai");
        assert.equal((await runtime.onIncoming(msg({ msgId: "m6" }))).route.absence, undefined);
    });

    it("the companion's messages are never held back for its presence in the daemon", async () => {
        const { runtime, presence, sent } = rig({ ...ROUTING, default: { target: "ai" } }, null, () => ({
            online: false,
            since: 0,
        }));
        presence.setStatus({ key: "ai", agent: AGENTS[0], sub: null, credential: AGENTS[0].credential }, "away", null);
        const d = await runtime.onIncoming(msg({}));
        assert.deepEqual([d.route.to, d.route.by, d.route.queued], ["ai", "rule", undefined]);
        assert.equal(sent.length, 0, "no notice: nothing was held back");
    });
});

describe("a client's connection (owner, 2026-11-27)", () => {
    const at = 1_000_000;
    it("is its open waits, plus the reconnect grace after the last one ended; never the time since a call", () => {
        const e = (o) => ({ key: "dev", waits: 0, waitEndAt: null, ...o });
        assert.deepEqual(connectionState([e({ waits: 1 })], "dev", { now: at }), { online: true, since: 0 });
        assert.deepEqual(connectionState([e({ key: "dev/build", waits: 1 })], "dev", { now: at }).online, true);
        assert.equal(connectionState([e({ waitEndAt: at - RECONNECT_GRACE_MS })], "dev", { now: at }).online, true);
        assert.deepEqual(connectionState([e({ waitEndAt: at - RECONNECT_GRACE_MS - 1 })], "dev", { now: at }), {
            online: false,
            since: at - RECONNECT_GRACE_MS - 1,
        });
        // A client that only polls (calls, no wait) is offline; so is one never seen.
        assert.deepEqual(connectionState([e({ lastSeen: at - 1 })], "dev", { now: at }), { online: false, since: 0 });
        assert.deepEqual(connectionState([], "dev", { now: at }), { online: false, since: 0 });
    });

    it("the daemon's presence records when a client's wait closes", () => {
        let t = at;
        const p = createAgentPresence({ now: () => t });
        const who = { key: "dev", agent: AGENTS[1], sub: null, credential: AGENTS[1].credential };
        const end = p.begin(who, { waiting: true });
        const entries = () =>
            p.list().map((x) => ({
                key: x.key,
                waits: x.waiting ? 1 : 0,
                waitEndAt: Date.parse(x.waitEndAt ?? "") || null,
            }));
        assert.equal(connectionState(entries(), "dev", { now: t }).online, true);
        t += 5000;
        end();
        t += RECONNECT_GRACE_MS + 1;
        assert.deepEqual(connectionState(entries(), "dev", { now: t }), { online: false, since: at + 5000 });
        p.begin(who)();
        assert.equal(
            connectionState(entries(), "dev", { now: t }).online,
            false,
            "a call without a wait connects nothing",
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

describe("routing state survives a restart (owner, 2026-11-20)", () => {
    it("claims, the human pause and sticky focus are saved sealed and read back; expired ones are dropped", async () => {
        const { mkdirSync, mkdtempSync, existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
        const dir = mkdtempSync(join(SANDBOX_CONFIG_DIR, "routing-"));
        let t = DAY;
        const make = () =>
            createRouterRuntime({
                routingNow: () => resolveRouting({ policy: { routing: { ...ROUTING, agents: [] } } }),
                getApi: () => ({}),
                ids: () => ({ ownId: "1001", send2meId: MYDOCS }),
                accountDir: dir,
                now: () => t,
            });
        const first = make();
        first.claims.startHuman(CUSTOMER, 15 * 60_000);
        first.claims.setSticky(OWNER, "dev", 60_000);
        first.claims.assign("t9", "dev", { ms: 60 * 60_000, held: true });
        first.flush();
        assert.ok(existsSync(join(dir, "routing-state.json")));
        assert.doesNotMatch(readFileSync(join(dir, "routing-state.json"), "utf8"), /"dev"/, "sealed");
        t += 5 * 60_000;
        const again = make();
        assert.equal(again.guard({ agent: AGENTS[0] }, CUSTOMER, null).code, "HUMAN_ACTIVE");
        assert.equal(again.claims.holder("t9"), "dev");
        assert.equal(again.claims.sticky(OWNER), null, "the 1-minute focus expired while down");
    });
});

describe("the group-mention condition", () => {
    it("matches only a group message that mentions the account", () => {
        const c = cfg({ routes: [{ id: "m", target: "ai", match: { threadType: "group", mentionsAccount: true } }] });
        const g = msg({ threadType: "group", threadId: "g1" });
        assert.equal(decide(g, { agents: AGENTS, cfg: c, now: DAY, mentionsMe: true, presenceOf: listening }).to, "ai");
        assert.equal(
            decide(g, { agents: AGENTS, cfg: c, now: DAY, mentionsMe: false, presenceOf: listening }).to,
            "human",
        );
    });
});
