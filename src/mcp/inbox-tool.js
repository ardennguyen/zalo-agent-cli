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

export const INBOX_ACTIONS = Object.freeze(["whoami", "status", "agents"]);

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

/** `zalo_inbox`'s metadata (mcp-tools.js registers it). */
export const INBOX_META = {
    title: "Agents on this Zalo account",
    description:
        "Who you are among the agents that share this Zalo account, and your presence. " +
        "`whoami`: your agent (name, mark, delivery), your sub-name (`consumer`), whether routing is on, and the " +
        "other agents with their presence. `status`: tell the others you are `listening` or `away` (with a short " +
        "`note`). `agents`: every agent of the account with its presence (listening, away, onDemand, idle, " +
        "disabled). The owner sets agents and marks in the console; no tool changes them. Every text you send " +
        "with zalo_send_message starts with your mark when the account shows marks, so do not add it yourself.",
    inputSchema: z
        .object({
            action: z.enum(INBOX_ACTIONS).describe("whoami, status or agents"),
            status: z
                .enum(["listening", "away"])
                .optional()
                .describe("For `status`: listening (taking messages) or away"),
            note: z
                .string()
                .max(200)
                .optional()
                .describe("For `status`: a short note the others see (e.g. back at 14:00)"),
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
 * @returns {(args: object) => Promise<object>}
 */
export function inboxHandler({ callerOf, routingNow, presence }) {
    return async ({ action, status, note, consumer }) => {
        const routing = routingNow();
        const who = callerOf(consumer ?? null);
        if (action === "status") {
            if (!status) return err("`status` needs `status`: listening or away.");
            if (!presence) return err("This server keeps no presence.");
            const state = presence.setStatus(who, status, note ?? null);
            return ok({ action, agent: who.agent?.slug ?? null, sub: who.sub, presence: state });
        }
        const all = agentsWithPresence(routing, presence);
        if (action === "agents") {
            return ok({
                action,
                routing: { enabled: false },
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
            routing: {
                enabled: false,
                note: "Routing is not on for this account: every caller sees every message.",
            },
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
