/**
 * The Companion Router's first phase: who an MCP caller is (its credential bound to an agent), the agent's mark on
 * what it sends, its presence, the record of which agent sent which message, and `zalo_inbox`.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { checkAgents, markFor, agentForCredential, defaultMark } from "../../src/core/routing-policy.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
import {
    PRESENCE_FILE,
    agentsReport,
    annotateSentBy,
    createAgentPresence,
    createSentByStore,
    inboxInstructions,
    prefixMark,
    presenceState,
    resolveCaller,
    resolveRouting,
} from "../../src/mcp/agents.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { createApiKey, createApiKeyChecker } from "../../src/core/api-keys.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
});

const AGENTS = [
    { slug: "dev", name: "Dev", credential: "apikey:0123456789ab" },
    { slug: "ai", name: "AI", kind: "companion", credential: "apikey:ba9876543210", mark: "🤖 AI:" },
    { slug: "claude", name: "Claude", credential: "oauth:claude-app" },
    { slug: "quiet", name: "Quiet", credential: "legacy", markDisplay: "owner" },
];

describe("routing.agents: the agents list", () => {
    it("fills every default, and the kind and delivery follow the credential", () => {
        const { value, error } = checkAgents(AGENTS);
        assert.equal(error, undefined);
        assert.deepEqual(
            value.map((a) => [a.slug, a.kind, a.type, a.delivery, a.markDisplay, a.enabled]),
            [
                ["dev", "mcp-key", "client", "live", "inherit", true],
                ["ai", "companion", "service", "live", "inherit", true],
                ["claude", "mcp-oauth", "client", "onDemand", "inherit", true],
                ["quiet", "legacy", "client", "live", "owner", true],
            ],
        );
    });

    it("takes the type as set: an owner's agent may be a service, a companion a client; nothing else", () => {
        const { value } = checkAgents([
            { ...AGENTS[0], type: "service" },
            { ...AGENTS[1], type: "client" },
        ]);
        assert.deepEqual(
            value.map((a) => a.type),
            ["service", "client"],
        );
        assert.match(checkAgents([{ ...AGENTS[0], type: "robot" }]).error, /type is not one of service, client/);
    });

    it("refuses a slug twice, a credential bound twice, an unknown field and a credential it cannot name", () => {
        assert.match(checkAgents([AGENTS[0], { ...AGENTS[1], slug: "dev" }]).error, /used twice/);
        assert.match(checkAgents([AGENTS[0], { ...AGENTS[1], credential: AGENTS[0].credential }]).error, /two agents/);
        assert.match(checkAgents([{ ...AGENTS[0], role: "admin" }]).error, /unknown field "role"/);
        assert.match(checkAgents([{ ...AGENTS[0], credential: "zak_secret" }]).error, /credential/);
        assert.match(checkAgents([{ ...AGENTS[0], slug: "Dev Team" }]).error, /slug/);
        assert.match(checkAgents({}).error, /list/);
    });

    it("is a policy key of an account's file, with routing.marks and routing.presenceWindow", () => {
        const ok = validatePolicy({ routing: { agents: AGENTS, marks: "hidden", presenceWindow: "2m" } });
        assert.deepEqual(ok.errors, []);
        assert.equal(ok.policy.routing.agents.length, 4);
        const bad = validatePolicy({ routing: { marks: "sometimes", presenceWindow: "1s" } });
        assert.deepEqual(bad.errors.map((e) => e.key).sort(), ["routing.marks", "routing.presenceWindow"]);
        const tenant = validatePolicy({ routing: { agents: AGENTS } }, { scope: "tenant" });
        assert.equal(tenant.errors[0].key, "routing.agents");
    });

    it("binds an OAuth grant to its client's agent unless the grant has its own", () => {
        const { value } = checkAgents([...AGENTS, { slug: "proj", name: "Proj", credential: "oauth:claude-app/g2" }]);
        assert.equal(agentForCredential(value, "oauth:claude-app/g1").slug, "claude");
        assert.equal(agentForCredential(value, "oauth:claude-app/g2").slug, "proj");
        assert.equal(agentForCredential(value, "apikey:ffffffffffff"), null);
    });
});

describe("marks", () => {
    const agents = checkAgents(AGENTS).value;
    const [dev, ai, , quiet] = agents;

    it("an agent with no mark of its own gets the visible default", () => {
        assert.equal(markFor(dev), "🤖 Dev:");
        assert.equal(defaultMark(dev), "🤖 Dev:");
        assert.equal(markFor(ai), "🤖 AI:");
    });

    it("the account hides marks unless the agent overrides, and `owner` shows only in My Documents", () => {
        assert.equal(markFor(dev, { marks: "hidden" }), "");
        assert.equal(markFor({ ...dev, markDisplay: "everywhere" }, { marks: "hidden" }), "🤖 Dev:");
        assert.equal(markFor({ ...dev, markDisplay: "none" }), "");
        assert.equal(markFor(quiet, { ownerChat: false }), "");
        assert.equal(markFor(quiet, { ownerChat: true }), "🤖 Quiet:");
    });

    it("the companion sending on its own key is its agent: its mark goes on in My Documents and elsewhere", () => {
        const routing = resolveRouting({ policy: { routing: { agents: AGENTS } } });
        const own = resolveCaller({ credential: "apikey:ba9876543210" }, routing);
        assert.equal(own.agent?.slug, "ai");
        assert.equal(own.agent.type, "service");
        assert.equal(markFor(own.agent, { marks: routing.marks, ownerChat: true }), "🤖 AI:");
        assert.equal(markFor(own.agent, { marks: routing.marks, ownerChat: false }), "🤖 AI:");
        // The same send on a credential bound to no agent (the deploy token, once the agent moved to its key) has no mark:
        // why SAGENT keeps the companion's agent on the key the companion signs in with.
        const unbound = resolveCaller({ credential: "apikey:ffffffffffff" }, routing);
        assert.equal(unbound.agent, null);
        assert.equal(markFor(unbound.agent, { ownerChat: true }), "");
    });

    it("prefixMark moves styles and mentions by the mark's length, and never doubles a mark", () => {
        const out = prefixMark(
            { text: "Hi @An", styles: [{ start: 0, len: 2, st: "b" }], mentions: [{ pos: 3, len: 3, uid: "1" }] },
            "🤖 Dev:",
        );
        assert.equal(out.text, "🤖 Dev: Hi @An");
        assert.equal(out.text.slice(out.styles[0].start, out.styles[0].start + 2), "Hi");
        assert.equal(out.text.slice(out.mentions[0].pos, out.mentions[0].pos + 3), "@An");
        assert.equal(prefixMark({ text: "🤖 Dev: again" }, "🤖 Dev:").text, "🤖 Dev: again");
        assert.equal(prefixMark({ text: "" }, "🤖 Dev:").text, "🤖 Dev:");
        assert.equal(prefixMark({ text: "plain" }, "").text, "plain");
    });
});

describe("the caller", () => {
    it("the live policy wins over mcp-config.json; a list that does not check binds no one", () => {
        const config = { routing: { agents: [AGENTS[0]], marks: "hidden" } };
        const fromConfig = resolveRouting({ config, policy: null });
        assert.equal(fromConfig.agents.length, 1);
        assert.equal(fromConfig.marks, "hidden");
        const fromPolicy = resolveRouting({ config, policy: { routing: { agents: AGENTS } } });
        assert.equal(fromPolicy.agents.length, 4);
        assert.equal(fromPolicy.source, "policy:routing.agents");
        const lines = [];
        const bad = resolveRouting({ policy: { routing: { agents: [{ slug: "x" }] } }, log: (l) => lines.push(l) });
        assert.equal(bad.agents.length, 0);
        assert.equal(lines.length, 1);
        assert.equal(resolveRouting({ policy: null }).presenceWindowMs, 90_000);
    });

    it("is the agent its credential is bound to; consumer is only a sub-name", () => {
        const routing = resolveRouting({ policy: { routing: { agents: AGENTS } } });
        const dev = resolveCaller({ credential: "apikey:0123456789ab", label: "laptop" }, routing, "review");
        assert.equal(dev.agent.slug, "dev");
        assert.equal(dev.sub, "review");
        assert.equal(dev.key, "dev/review");
        // A caller cannot become another agent by naming it.
        const stranger = resolveCaller({ credential: "apikey:ffffffffffff" }, routing, "dev");
        assert.equal(stranger.agent, null);
        assert.equal(stranger.key, "apikey:ffffffffffff/dev");
        assert.equal(resolveCaller(null, routing).credential, "open");
    });

    it("an API key identifies itself by id and label, and the checker still answers verify", () => {
        const dir = mkdtempSync(join(SANDBOX_CONFIG_DIR, "keys-"));
        const made = createApiKey(dir, { label: "laptop" });
        const checker = createApiKeyChecker(dir);
        assert.deepEqual(checker.identify(made.key), { keyId: made.keyId, label: "laptop" });
        assert.equal(checker.verify(made.key), true);
        // A changed last character (never the one it already has: a key ending in "A" made this a no-op, 1 run in 64).
        const tampered = `${made.key.slice(0, -1)}${made.key.endsWith("A") ? "B" : "A"}`;
        assert.equal(checker.identify(tampered), null);
        assert.equal(checker.verify("zak_nothing"), false);
    });

    it("each caller is told who it is, and an unbound one why it is not anyone", () => {
        const routing = resolveRouting({ policy: { routing: { agents: AGENTS } } });
        const text = inboxInstructions(resolveCaller({ credential: "apikey:0123456789ab" }, routing), routing);
        assert.match(text, /You are Dev \(agent `dev`\)/);
        assert.match(text, /"🤖 Dev:"/);
        assert.match(text, /Other agents on this account: AI, Claude, Quiet/);
        const lost = inboxInstructions(resolveCaller({ credential: "open" }, routing), routing);
        assert.match(lost, /not bound to an agent/);
        assert.equal(
            inboxInstructions(resolveCaller(null, resolveRouting({ policy: null })), resolveRouting({ policy: null })),
            "",
        );
    });
});

describe("presence", () => {
    const agents = checkAgents(AGENTS).value;
    const who = (agent, sub = null) => ({
        key: sub ? `${agent.slug}/${sub}` : agent.slug,
        agent,
        sub,
        credential: agent.credential,
    });

    it("a wait is listening while open; seen within the window is listening; then away", () => {
        let t = 1_000_000;
        const p = createAgentPresence({ now: () => t });
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "idle");
        const end = p.begin(who(agents[0], "build"), { waiting: true });
        t += 600_000;
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "listening");
        end();
        t += 60_000;
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "listening");
        t += 60_000;
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "away");
    });

    it("an on-demand agent not seen lately is onDemand, a disabled one disabled, `status away` away", () => {
        let t = 5_000_000;
        const p = createAgentPresence({ now: () => t });
        p.begin(who(agents[2]))();
        t += 3_600_000;
        assert.equal(p.stateOf("claude", { agent: agents[2] }).state, "onDemand");
        assert.equal(p.stateOf("dev", { agent: { ...agents[0], enabled: false } }).state, "disabled");
        const away = p.setStatus(who(agents[0]), "away", "lunch");
        assert.equal(away.state, "away");
        assert.equal(away.note, "lunch");
        t += 1000;
        p.begin(who(agents[0]))();
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "away", "a plain call does not undo `away`");
        p.begin(who(agents[0]), { waiting: true });
        assert.equal(p.stateOf("dev", { agent: agents[0] }).state, "listening", "an open wait does");
    });

    it("writes a snapshot the operator's report reads back (names and times only)", () => {
        const dir = mkdtempSync(join(SANDBOX_CONFIG_DIR, "presence-"));
        const p = createAgentPresence({ file: join(dir, PRESENCE_FILE) });
        p.begin(who(agents[0]), { waiting: true });
        p.begin({ key: "apikey:ffffffffffff", agent: null, sub: null, credential: "apikey:ffffffffffff" })();
        p.flush();
        const report = agentsReport({
            accountId: "1001",
            accountDir: dir,
            config: { routing: { agents: AGENTS } },
            credentials: [
                { credential: "apikey:0123456789ab", label: "laptop", kind: "mcp-key" },
                { credential: "apikey:ffffffffffff", label: "new", kind: "mcp-key" },
            ],
        });
        assert.equal(report.agents.find((a) => a.slug === "dev").presence.state, "listening");
        assert.deepEqual(
            report.credentials.map((c) => c.agent),
            ["dev", null],
        );
        assert.deepEqual(
            report.unbound.map((u) => u.credential),
            ["apikey:ffffffffffff"],
        );
        assert.doesNotMatch(readFileSync(join(dir, PRESENCE_FILE), "utf8"), /zak_/);
    });

    it("a service is ready whatever its calls say, even after `status away`; only turning it off stops it", () => {
        let t = 9_000_000;
        const p = createAgentPresence({ now: () => t });
        const ai = agents[1];
        assert.equal(ai.type, "service");
        assert.equal(p.stateOf("ai", { agent: ai }).state, "ready", "never seen: ready");
        p.begin(who(ai))();
        t += 3_600_000;
        assert.equal(p.stateOf("ai", { agent: ai }).state, "ready", "not seen for an hour: ready");
        p.setStatus(who(ai), "away", null);
        assert.equal(p.stateOf("ai", { agent: ai }).state, "ready", "said away: still ready");
        assert.equal(p.stateOf("ai", { agent: { ...ai, enabled: false } }).state, "disabled");
        // The same record as a client goes away once unseen past the window.
        assert.equal(p.stateOf("ai", { agent: { ...ai, type: "client" } }).state, "away");
    });

    it("presenceState is pure over entries", () => {
        const s = presenceState([{ key: "x", lastSeen: 1000, waits: 0, status: null, statusAt: null }], "x", {
            now: 2000,
        });
        assert.equal(s.state, "listening");
    });
});

describe("sentBy", () => {
    const routing = resolveRouting({ policy: { routing: { agents: AGENTS } } });
    const dev = resolveCaller({ credential: "apikey:0123456789ab" }, routing, "build");

    it("remembers each send's ids with the agent, sealed in the account folder across a restart", () => {
        const dir = mkdtempSync(join(SANDBOX_CONFIG_DIR, "sentby-"));
        const store = createSentByStore(dir);
        store.record(["m1", "c1", "m2"], dev, "t1");
        assert.deepEqual(
            { ...store.lookup({ cliMsgId: "c1" }), at: undefined },
            { agent: "dev", name: "Dev", sub: "build", credential: "apikey:0123456789ab", at: undefined },
        );
        store.flush();
        assert.ok(existsSync(join(dir, "sent-by.json")));
        assert.doesNotMatch(readFileSync(join(dir, "sent-by.json"), "utf8"), /"dev"/, "sealed, not plain JSON");
        const again = createSentByStore(dir);
        assert.equal(again.lookup({ msgId: "m2" }).agent, "dev");
        assert.equal(again.lookup({ msgId: "nope" }), null);
    });

    it("keeps the newest sends only, and forgets old ones", () => {
        let t = 0;
        const store = createSentByStore(null, { max: 2, ttlMs: 1000, now: () => t });
        store.record(["a"], dev);
        store.record(["b"], dev);
        store.record(["c"], dev);
        assert.equal(store.lookup({ msgId: "a" }), null);
        t = 5000;
        store.record(["d"], dev);
        assert.equal(store.lookup({ msgId: "b" }), null);
        assert.equal(store.lookup({ msgId: "d" }).agent, "dev");
    });

    it("names the agent on the messages of a reply, and leaves errors and other messages alone", () => {
        const store = createSentByStore(null);
        store.record(["m1"], dev);
        const reply = {
            content: [{ type: "text", text: JSON.stringify({ messages: [{ msgId: "m1" }, { msgId: "m9" }] }) }],
        };
        const out = JSON.parse(annotateSentBy(reply, store).content[0].text);
        assert.deepEqual(out.messages[0].sentBy, { agent: "dev", name: "Dev", sub: "build" });
        assert.equal(out.messages[1].sentBy, undefined);
        const error = { content: [{ type: "text", text: "Error: x" }], isError: true };
        assert.equal(annotateSentBy(error, store), error);
    });
});

describe("the tools: zalo_send_message marks and records, zalo_inbox answers", () => {
    function rig({ caller, routing }) {
        const sent = [];
        const tools = new Map();
        const server = { caller, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
        const api = {
            getOwnId: () => "1001",
            getContext: () => ({ loginInfo: { send2me_id: "9009" } }),
            sendMessage: async (content, threadId, type) => {
                sent.push({ content, threadId, type });
                return { message: { msgId: `m${sent.length}`, cliMsgId: `c${sent.length}` } };
            },
            sendLink: async (opts) => {
                sent.push({ content: opts });
                return { msgId: "l1", cliMsgId: "lc1" };
            },
        };
        const buffer = {
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
            { routing },
            { ready: true, get: () => null, search: () => [] },
            undefined,
        );
        const call = async (name, args) => {
            const r = await tools.get(name).handler(args, {});
            if (r.isError) throw new Error(r.content[0].text);
            return JSON.parse(r.content[0].text);
        };
        return { sent, call, buffer, tools };
    }

    it("a bound agent's text and link caption start with its mark, and the send is recorded as its own", async () => {
        const { sent, call, buffer } = rig({
            caller: { credential: "apikey:0123456789ab" },
            routing: { agents: AGENTS },
        });
        const r = await call("zalo_send_message", { threadId: "g1", threadType: 1, text: "**Done**", consumer: "x" });
        assert.equal(sent[0].content.msg, "🤖 Dev: Done");
        const bold = sent[0].content.styles[0];
        assert.equal(sent[0].content.msg.slice(bold.start, bold.start + bold.len), "Done");
        assert.equal(r.mark, "🤖 Dev:");
        assert.equal(buffer.sentBy.lookup({ msgId: r.msgId }).agent, "dev");
        await call("zalo_send_message", { threadId: "g1", threadType: 1, link: "https://example.com" });
        assert.equal(sent[1].content.msg, "🤖 Dev:");
    });

    it("hidden marks send the text as written; an unbound caller is recorded by its credential", async () => {
        const { sent, call, buffer } = rig({
            caller: { credential: "apikey:ffffffffffff" },
            routing: { agents: AGENTS, marks: "hidden" },
        });
        const r = await call("zalo_send_message", { threadId: "g1", threadType: 1, text: "hello", format: "plain" });
        assert.equal(sent[0].content, "hello");
        assert.equal(r.mark, undefined);
        assert.deepEqual(
            {
                agent: buffer.sentBy.lookup({ msgId: r.msgId }).agent,
                c: buffer.sentBy.lookup({ msgId: r.msgId }).credential,
            },
            { agent: null, c: "apikey:ffffffffffff" },
        );
    });

    it("an `owner` mark goes on in My Documents only", async () => {
        const { sent, call } = rig({ caller: { credential: "legacy" }, routing: { agents: AGENTS } });
        await call("zalo_send_message", { threadId: "g1", threadType: 1, text: "a", format: "plain" });
        await call("zalo_send_message", { threadId: "me", text: "b", format: "plain" });
        assert.equal(sent[0].content, "a");
        assert.equal(sent[1].content, "🤖 Quiet: b");
    });

    it("zalo_inbox whoami, status and agents", async () => {
        const { call } = rig({ caller: { credential: "apikey:0123456789ab" }, routing: { agents: AGENTS } });
        const me = await call("zalo_inbox", { action: "whoami", consumer: "build" });
        assert.equal(me.agent.slug, "dev");
        assert.equal(me.sub, "build");
        assert.equal(me.bound, true);
        assert.equal(me.mark, "🤖 Dev:");
        assert.equal(me.credential.type, "apikey");
        assert.equal(me.routing.enabled, false);
        assert.equal(me.presence.state, "listening", "this very call counts as seen");
        assert.deepEqual(
            me.others.map((o) => o.slug),
            ["ai", "claude", "quiet"],
        );
        const st = await call("zalo_inbox", { action: "status", status: "away", note: "back at 2" });
        assert.equal(st.presence.state, "away");
        const all = await call("zalo_inbox", { action: "agents" });
        assert.equal(all.agents.find((a) => a.slug === "claude").presence.state, "onDemand", "never offline");
        assert.equal(all.marks, "shown");
    });

    it("with no agents, whoami says so and nothing is marked", async () => {
        const { sent, call } = rig({ caller: { credential: "open" }, routing: null });
        const me = await call("zalo_inbox", { action: "whoami" });
        assert.equal(me.agent, null);
        assert.match(me.note, /no agents/);
        await call("zalo_send_message", { threadId: "g1", threadType: 1, text: "x", format: "plain" });
        assert.equal(sent[0].content, "x");
    });
});
