/**
 * The Companion Router's console side in the daemon: routing events (ids only), the claims card's actions, and the staff
 * inbox (option A): a staff member sees, reads and answers only the conversations routed to him or held by him.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { createRouterRuntime } from "../../src/mcp/router-runtime.js";
import { createSentByStore, resolveRouting } from "../../src/mcp/agents.js";
import { staffInboxRow } from "../../src/commands/mcp.js";
import { createAccessApi } from "../../src/core/access-api.js";
import { mkdirSync } from "node:fs";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const OWNER = "9001";
const CUSTOMER = "5001";
const OTHER = "5002";
const MYDOCS = "9009";
const ROUTING = {
    enabled: true,
    claims: true,
    owners: [OWNER],
    routes: [
        { id: "ticket", target: "staff:lan", match: { trigger: { word: "#ticket", who: "anyone" } } },
        { id: "dms", target: "ai", match: { threadType: "dm" } },
    ],
    default: { target: "human" },
    staff: [
        { id: "lan", name: "Lan", channels: ["console"] },
        { id: "minh", name: "Minh", channels: ["console"], mark: "👤 M:" },
        { id: "zalo-only", name: "Z", zaloUserId: "7001", channels: ["zalo"] },
    ],
};
const msg = (o) => ({ threadId: CUSTOMER, threadType: "dm", senderId: CUSTOMER, text: "hello", type: "text", ...o });

function rig({ routing = ROUTING } = {}) {
    const sent = [];
    let n = 0;
    const t = Date.parse("2026-11-18T10:00:00Z");
    const api = {
        sendMessage: async (text, threadId, type) => {
            n++;
            sent.push({ text, threadId, type });
            return { message: { msgId: `s${n}`, cliMsgId: `c${n}` } };
        },
    };
    const sentBy = createSentByStore(null);
    const rows = {
        [CUSTOMER]: [
            {
                msgId: "m1",
                threadId: CUSTOMER,
                senderId: CUSTOMER,
                text: "#ticket my order",
                type: "text",
                timestamp: 1,
            },
        ],
    };
    const runtime = createRouterRuntime({
        routingNow: () =>
            resolveRouting({
                policy: { routing: { ...routing, agents: [{ slug: "ai", name: "AI", credential: "legacy" }] } },
            }),
        getApi: () => api,
        ids: () => ({ ownId: "1001", send2meId: MYDOCS }),
        sentBy,
        lang: "en",
        presenceOf: () => ({ state: "listening" }),
        now: () => t,
        history: (threadId, limit) => (rows[threadId] ?? []).slice(0, limit).map((m) => staffInboxRow(m, "1001")),
        threadNames: () => new Map([[CUSTOMER, { name: "Customer A" }]]),
    });
    return { runtime, sent, sentBy };
}

describe("routing events", () => {
    it("records each decision with ids only, and reads from where the console stopped", async () => {
        const { runtime } = rig();
        await runtime.onIncoming(msg({ text: "#ticket my order", msgId: "m1" }));
        await runtime.onIncoming(msg({ threadId: OTHER, senderId: OTHER, msgId: "m2" }));
        const head = runtime.eventsHead();
        assert.equal(head.seq, 2);
        const all = await runtime.serve({ action: "events" });
        assert.deepEqual(
            all.events.map((e) => [e.kind, e.threadId, e.to, e.by, e.msgId]),
            [
                ["routed", CUSTOMER, "staff:lan", "trigger", "m1"],
                ["routed", OTHER, "ai", "rule", "m2"],
            ],
        );
        assert.equal(JSON.stringify(all).includes("my order"), false, "no message text in an event");
        const later = await runtime.serve({ action: "events", bootId: head.bootId, since: 1 });
        assert.deepEqual(
            later.events.map((e) => e.seq),
            [2],
        );
        // Another boot's position reads everything this boot has.
        assert.equal((await runtime.serve({ action: "events", bootId: "other", since: 2 })).events.length, 2);
    });
});

describe("the claims card", () => {
    it("lists claims and pauses, releases, reassigns and pauses for the owner, each one an event", async () => {
        const { runtime } = rig();
        await runtime.onIncoming(msg({ threadId: OTHER, senderId: OTHER, msgId: "m2" }));
        assert.deepEqual(
            (await runtime.serve({ action: "claims" })).claims.map((c) => [c.threadId, c.holder, c.state]),
            [[OTHER, "ai", "assigned"]],
        );
        const moved = await runtime.serve({ action: "assign", threadId: OTHER, to: "staff:lan" });
        assert.equal(moved.claim.holder, "staff:lan");
        await assert.rejects(runtime.serve({ action: "assign", threadId: OTHER, to: "ghost" }), /not an agent/);
        assert.equal((await runtime.serve({ action: "release", threadId: OTHER })).released, true);
        assert.equal((await runtime.serve({ action: "release", threadId: OTHER })).released, false);
        const paused = await runtime.serve({ action: "human", threadId: OTHER, minutes: 5 });
        assert.match(paused.humanUntil, /T10:05:00/);
        assert.deepEqual(
            (await runtime.serve({ action: "claims" })).human.map((h) => h.threadId),
            [OTHER],
        );
        await runtime.serve({ action: "endHuman", threadId: OTHER });
        assert.deepEqual((await runtime.serve({ action: "claims" })).human, []);
        const kinds = (await runtime.serve({ action: "events" })).events.map((e) => e.kind);
        assert.deepEqual(kinds, ["routed", "handoff", "released", "humanPause", "humanEnd"]);
        await assert.rejects(runtime.serve({ action: "release", threadId: "not-a-thread" }), /threadId/);
    });

    it("refuses everything but events while routing is off", async () => {
        const { runtime } = rig({ routing: { ...ROUTING, enabled: false } });
        await assert.rejects(runtime.serve({ action: "claims" }), /routing is off/);
        assert.deepEqual((await runtime.serve({ action: "events" })).events, []);
    });
});

describe("the staff inbox (option A)", () => {
    it("shows a staff member his routed conversations only; he reads, claims and answers with his mark", async () => {
        const { runtime, sent, sentBy } = rig();
        await runtime.onIncoming(msg({ text: "#ticket my order", msgId: "m1" }));
        await runtime.onIncoming(msg({ threadId: OTHER, senderId: OTHER, msgId: "m2" }));
        const inbox = await runtime.serve({ action: "inbox", staff: "lan" });
        assert.deepEqual(
            inbox.threads.map((x) => [x.threadId, x.name]),
            [[CUSTOMER, "Customer A"]],
        );
        assert.deepEqual((await runtime.serve({ action: "inbox", staff: "minh" })).threads, []);
        // Another staff member, and a conversation not routed to him, are refused by the daemon itself.
        const notMine = await runtime.serve({ action: "thread", staff: "minh", threadId: CUSTOMER });
        assert.equal(notMine.code, "NOT_ROUTED");
        assert.equal((await runtime.serve({ action: "thread", staff: "lan", threadId: OTHER })).code, "NOT_ROUTED");
        const sneaky = await runtime.serve({ action: "send", staff: "lan", threadId: OTHER, text: "x" });
        assert.equal(sneaky.code, "NOT_ROUTED");
        await assert.rejects(runtime.serve({ action: "inbox", staff: "zalo-only" }), /does not answer in the console/);
        await assert.rejects(runtime.serve({ action: "inbox", staff: "ghost" }), /no staff member/);

        const thread = await runtime.serve({ action: "thread", staff: "lan", threadId: CUSTOMER });
        assert.deepEqual(
            thread.messages.map((m) => [m.msgId, m.text, m.isSelf]),
            [["m1", "#ticket my order", false]],
        );
        // A trigger hands the message over without a claim; answering makes the conversation his.
        assert.equal(thread.claim, null);

        const r = await runtime.serve({ action: "send", staff: "lan", threadId: CUSTOMER, text: "  On its way  " });
        assert.deepEqual([r.sent, r.msgId], [true, "s1"]);
        assert.deepEqual(sent.at(-1), { text: "👤 Lan: On its way", threadId: CUSTOMER, type: 0 });
        assert.deepEqual(
            [sentBy.lookup({ msgId: "s1" }).agent, sentBy.lookup({ msgId: "s1" }).name],
            ["staff:lan", "Lan"],
        );
        const held = (await runtime.serve({ action: "claims" })).claims.find((c) => c.threadId === CUSTOMER);
        assert.deepEqual([held.holder, held.state], ["staff:lan", "held"]);

        // Minh cannot take Lan's conversation; once it is handed to him, he answers with his own mark.
        assert.equal((await runtime.serve({ action: "claim", staff: "minh", threadId: CUSTOMER })).code, "NOT_ROUTED");
        assert.equal((await runtime.serve({ action: "unclaim", staff: "lan", threadId: CUSTOMER })).released, true);
        await runtime.serve({ action: "assign", threadId: CUSTOMER, to: "staff:minh" });
        const took = await runtime.serve({ action: "claim", staff: "minh", threadId: CUSTOMER });
        assert.equal(took.claim.holder, "staff:minh");
        await runtime.serve({ action: "send", staff: "minh", threadId: CUSTOMER, text: "Hi" });
        assert.equal(sent.at(-1).text, "👤 M: Hi");
        // Lan still sees the conversation (it was routed to him) but cannot answer over Minh's claim.
        const refused = await runtime.serve({ action: "send", staff: "lan", threadId: CUSTOMER, text: "me too" });
        assert.deepEqual([refused.code, refused.holder], ["CLAIMED", "staff:minh"]);
        assert.equal(sent.length, 2);
    });

    it("stops a staff send while the owner answers himself", async () => {
        const { runtime, sent } = rig();
        await runtime.onIncoming(msg({ text: "#ticket my order", msgId: "m1" }));
        await runtime.onOwn(msg({ isSelf: true, senderId: "1001", text: "I have it" }), { byAgent: false });
        const r = await runtime.serve({ action: "send", staff: "lan", threadId: CUSTOMER, text: "hello" });
        assert.equal(r.code, "HUMAN_ACTIVE");
        assert.equal(sent.length, 0);
        await assert.rejects(runtime.serve({ action: "send", staff: "lan", threadId: CUSTOMER, text: "  " }), /empty/);
    });
});

describe("the admin API's routing route", () => {
    const ACCOUNT = "1000000000000000901";
    async function call(relay, body, method = "POST") {
        mkdirSync(getAccountDir(ACCOUNT), { recursive: true });
        const access = createAccessApi({ relay, log: () => {} });
        let out = null;
        const res = {
            status(code) {
                out = { status: code };
                return this;
            },
            set() {
                return this;
            },
            json(b) {
                out.body = b;
                return this;
            },
        };
        await access.handle({ method, body }, res, {
            who: "token",
            ip: "127.0.0.1",
            path: `/access/${ACCOUNT}/routing`,
        });
        return out;
    }

    it("relays the known actions with their checked fields to the daemon, and says when none runs", async () => {
        const seen = [];
        const relay = async (id, path, params) => (seen.push([id, path, params]), { ok: true, threads: [] });
        const r = await call(relay, { action: "inbox", staff: "lan", extra: "dropped", limit: "x" });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { threads: [] });
        assert.deepEqual(seen, [[ACCOUNT, "/routing", { action: "inbox", staff: "lan" }]]);
        assert.equal((await call(relay, { action: "rm -rf" })).body.code, "INVALID_ROUTING_ACTION");
        assert.equal((await call(relay, { action: "claims" }, "GET")).status, 405);
        assert.equal((await call(async () => null, { action: "claims" })).body.code, "DAEMON_NOT_RUNNING");
        const off = await call(async () => ({ ok: false, error: "routing is off on this account" }), {
            action: "claims",
        });
        assert.deepEqual(
            [off.status, off.body.code, off.body.error],
            [409, "ROUTING_REFUSED", "routing is off on this account"],
        );
        const refused = await call(async () => ({ ok: true, refused: true, code: "NOT_ROUTED", message: "no" }), {
            action: "thread",
            staff: "lan",
            threadId: "5001",
        });
        assert.deepEqual([refused.status, refused.body.code], [409, "NOT_ROUTED"]);
    });
});

describe("routing events across a restart", () => {
    it("are kept sealed in the account folder for routing.logDays, with their stream position", async () => {
        const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(SANDBOX_CONFIG_DIR, "routing-events-"));
        let t = Date.parse("2026-11-18T10:00:00Z");
        const make = (logDays) =>
            createRouterRuntime({
                routingNow: () =>
                    resolveRouting({
                        policy: {
                            routing: {
                                ...ROUTING,
                                logDays,
                                agents: [{ slug: "ai", name: "AI", credential: "legacy" }],
                            },
                        },
                    }),
                getApi: () => ({ sendMessage: async () => ({}) }),
                ids: () => ({ ownId: "1001", send2meId: MYDOCS }),
                presenceOf: () => ({ state: "listening" }),
                accountDir: dir,
                now: () => t,
            });
        const first = make(2);
        await first.onIncoming(msg({ msgId: "m1" }));
        const head = first.eventsHead();
        first.flush();
        assert.ok(existsSync(join(dir, "routing-events.json")));
        assert.doesNotMatch(readFileSync(join(dir, "routing-events.json"), "utf8"), /routed/, "sealed");

        // Restarted: the same events and position, so the controller publishes nothing twice.
        const again = make(2);
        assert.deepEqual(again.eventsHead(), head);
        assert.equal((await again.serve({ action: "events", bootId: head.bootId, since: 0 })).events.length, 1);
        await again.onIncoming(msg({ msgId: "m2" }));
        assert.equal(again.eventsHead().seq, head.seq + 1);

        // Past the plan's retention, events are dropped at the next write.
        t += 3 * 24 * 60 * 60_000;
        await again.onIncoming(msg({ msgId: "m3" }));
        assert.deepEqual(
            (await again.serve({ action: "events" })).events.map((e) => e.msgId),
            ["m3"],
        );
    });
});
