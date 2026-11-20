/**
 * `zalo_inbox`: the caller's own place among the account's agents (src/mcp/agents.js). Free on every plan.
 *
 * | action   | what it does |
 * |----------|--------------|
 * | `whoami` | the caller's agent, sub-name, mark, delivery; whether routing is on; the other agents and their presence |
 * | `status` | set the caller's presence: `listening` or `away`, with an optional note |
 * | `agents` | every agent of the account with its presence, and the connections seen that no agent is bound to |
 *
 * Nothing here changes a setting: agents, credentials and marks are set by the owner (console or policy), never by a
 * tool, so an agent cannot raise its own rights.
 */
import { z } from "zod";
import { agentView } from "./agents.js";
import { markFor } from "../core/routing-policy.js";

export const INBOX_ACTIONS = Object.freeze([
    "whoami",
    "status",
    "agents",
    "claim",
    "release",
    "handoff",
    "claims",
    "route_test",
]);

const ok = (result) => ({ content: [{ type: "text", text: JSON.stringify(result) }] });
const err = (message) => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });

/**
 * Every agent with its presence, and the credentials seen that are bound to none.
 *
 * @param {ReturnType<import("./agents.js").resolveRouting>} routing
 * @param {ReturnType<import("./agents.js").createAgentPresence>|null} presence
 * @returns {{agents: object[], unbound: object[]}}
 */
export function agentsWithPresence(routing, presence) {
    const windowMs = routing.presenceWindowMs;
    const agents = routing.agents.map((a) => ({
        ...agentView(a, routing),
        presence: presence ? presence.stateOf(a.slug, { agent: a, windowMs }) : { state: "idle", lastSeen: null },
        subs: presence
            ? presence
                  .list()
                  .filter((e) => e.agent === a.slug && e.sub)
                  .map((e) => e.sub)
            : [],
    }));
    const unbound = presence
        ? presence
              .list()
              .filter((e) => !e.agent && !e.sub)
              .map((e) => ({ credential: e.credential, lastSeen: e.lastSeen }))
        : [];
    return { agents, unbound };
}

/** The routing state an agent is told. */
const routingSummary = (routing) =>
    routing.cfg?.enabled
        ? { enabled: true, claims: routing.cfg.claims, isolation: routing.cfg.isolation }
        : { enabled: false, note: "Routing is not on for this account: every caller sees every message." };

/** `zalo_inbox`'s metadata (mcp-tools.js registers it). */
export const INBOX_META = {
    title: "Agents on this Zalo account",
    description:
        "Who you are among the agents that share this Zalo account, and your presence. " +
        "`whoami`: your agent (name, mark, delivery), your sub-name (`consumer`), whether routing is on, and the " +
        "other agents with their presence. `status`: tell the others you are `listening` or `away` (with a short " +
        "`note`). `agents`: every agent of the account with its presence (listening, away, onDemand, idle, " +
        "disabled). The owner sets agents, routes and marks in the console; no tool changes them. Every text you send " +
        "with zalo_send_message starts with your mark when the account shows marks, so do not add it yourself. " +
        "With the account's Message Router on: `claim` takes a conversation (`threadId`), `release` gives it back, " +
        "`handoff` moves it to another agent, `human` (the owner) or `staff:<id>` with a `note`, `claims` lists the " +
        "open ones, and `route_test` says who would get a message (`threadId`, `text`, `senderId`) and why, changing " +
        "nothing. A send into a conversation the owner is answering himself is refused (HUMAN_ACTIVE), as is one " +
        "another agent holds (CLAIMED).",
    inputSchema: z
        .object({
            action: z
                .enum(INBOX_ACTIONS)
                .describe("whoami, status, agents, claim, release, handoff, claims or route_test"),
            status: z
                .enum(["listening", "away"])
                .optional()
                .describe("For `status`: listening (taking messages) or away"),
            note: z
                .string()
                .max(200)
                .optional()
                .describe("For `status` and `handoff`: a short note the others see (e.g. back at 14:00)"),
            threadId: z
                .string()
                .min(1)
                .optional()
                .describe("For claim, release, handoff and route_test: the conversation"),
            to: z
                .string()
                .min(1)
                .max(80)
                .optional()
                .describe("For handoff: an agent's slug, human (the owner) or staff:<id>"),
            text: z
                .string()
                .max(4000)
                .optional()
                .describe("For route_test: the message text to try (a trigger, a hashtag, anything)"),
            senderId: z
                .string()
                .min(1)
                .optional()
                .describe("For route_test: the sender's user id; omit it to try a message from the owner"),
            consumer: z
                .string()
                .min(1)
                .max(64)
                .regex(/^[A-Za-z0-9._:@-]+$/)
                .optional()
                .describe("Your sub-name, when several sessions share one connection (a label, not a boundary)"),
        })
        .strict(),
};

/**
 * `zalo_inbox`'s handler.
 *
 * @param {object} ctx
 * @param {(consumer?: string|null) => ReturnType<import("./agents.js").resolveCaller>} ctx.callerOf
 * @param {() => ReturnType<import("./agents.js").resolveRouting>} ctx.routingNow
 * @param {ReturnType<import("./agents.js").createAgentPresence>|null} ctx.presence
 * @param {ReturnType<import("./router-runtime.js").createRouterRuntime>|null} [ctx.router]
 * @returns {(args: object) => Promise<object>}
 */
export function inboxHandler({ callerOf, routingNow, presence, router = null }) {
    return async ({ action, status, note, consumer, threadId, to, text, senderId }) => {
        const routing = routingNow();
        const who = callerOf(consumer ?? null);
        if (action === "status") {
            if (!status) return err("`status` needs `status`: listening or away.");
            if (!presence) return err("This server keeps no presence.");
            const state = presence.setStatus(who, status, note ?? null);
            return ok({ action, agent: who.agent?.slug ?? null, sub: who.sub, presence: state });
        }
        if (["claim", "release", "handoff", "claims", "route_test"].includes(action)) {
            if (!router || !routing.cfg?.enabled)
                return err("The Message Router is off on this account: nothing is routed or claimed.");
            if (action === "claims") {
                const all = router.claims.list();
                return ok({ action, claims: who.agent ? all.filter((c) => c.holder === who.agent.slug) : all });
            }
            if (!threadId) return err(`${action} needs threadId.`);
            if (action === "route_test") {
                const d = router.test({
                    threadId,
                    threadType: "dm",
                    senderId: senderId ?? null,
                    isSelf: !senderId,
                    text: text ?? "",
                });
                return ok({ action, to: d.to, by: d.by, ruleId: d.ruleId, before: d.before ?? null, trace: d.trace });
            }
            if (!who.agent) return err("Your connection is not bound to an agent: it cannot hold conversations.");
            if (action === "claim") {
                const g = router.guard(who, threadId, null);
                if (!g.ok) return err(`${g.code}: ${g.message}`);
                router.onAgentSend(who.agent.slug, threadId);
                return ok({ action, threadId, holder: who.agent.slug });
            }
            if (action === "release")
                return ok({ action, threadId, released: router.claims.release(threadId, who.agent.slug) });
            if (!to) return err("handoff needs `to`: an agent's slug, human or staff:<id>.");
            const r = router.handoff(who, threadId, to, note ?? null);
            return r.ok ? ok({ action, threadId, to }) : err(r.message);
        }
        const all = agentsWithPresence(routing, presence);
        if (action === "agents") {
            return ok({
                action,
                routing: routingSummary(routing),
                marks: routing.marks,
                presenceWindowSec: Math.round(routing.presenceWindowMs / 1000),
                ...all,
            });
        }
        const credentialType = who.credential.split(":")[0];
        return ok({
            action: "whoami",
            agent: who.agent ? agentView(who.agent, routing) : null,
            sub: who.sub,
            credential: { type: credentialType, ...(who.label && { label: who.label }) },
            bound: Boolean(who.agent),
            mark: who.agent ? markFor(who.agent, { marks: routing.marks }) || null : null,
            marks: routing.marks,
            routing: routingSummary(routing),
            ...(who.agent
                ? {}
                : {
                      note: routing.agents.length
                          ? "Your connection is not bound to an agent of this account; the owner binds it in the console."
                          : "This account names no agents yet.",
                  }),
            presence: presence
                ? presence.stateOf(who.agent?.slug ?? who.credential, {
                      agent: who.agent,
                      windowMs: routing.presenceWindowMs,
                  })
                : null,
            others: all.agents
                .filter((a) => a.slug !== who.agent?.slug)
                .map((a) => ({ slug: a.slug, name: a.name, presence: a.presence })),
        });
    };
}
