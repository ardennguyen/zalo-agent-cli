/**
 * The action tools: one MCP tool per area of the account (zalo_conversation, zalo_profile, zalo_catalog, …), whose
 * `action` input picks one row of a table. A row says which inputs the action needs, whether Zalo Web asks about it
 * first (its GUARDS key, src/core/confirm-guard.js), and the session call it makes, which is the call the matching
 * CLI command makes. Every action is settled in the same order: its inputs are checked, then a guarded one is settled
 * (dry run, refusal or question), and only then is Zalo asked.
 */

import { z } from "zod";
import { dryRunReport } from "../core/confirm-guard.js";

/** A Zalo user, group or conversation id: digits only. */
export const NUMERIC_ID = /^\d{1,30}$/;

/** The id inputs that must be digits, and where a refusal tells the agent to find a good one. */
const NUMERIC_INPUTS = {
    groupId: "zalo_search_threads finds a group by name",
    groupIds: "zalo_search_threads finds a group by name",
    userId: "zalo_lookup_user finds one from a phone number",
    userIds: "zalo_lookup_user finds one from a phone number",
    threadId: "zalo_search_threads or zalo_list_conversations finds one",
    threadIds: "zalo_search_threads or zalo_list_conversations finds one",
    autoReplyId: "'list' shows them",
    quickMessageId: "'list' shows them",
    quickMessageIds: "'list' shows them",
    bankAccountId: "'accounts' shows them",
    stickerIds: "zalo_sticker 'search' finds them",
};

/**
 * `confirm` for a tool with actions Zalo Web asks about first, which it settles through the guard after its
 * arguments are checked and before anything is sent.
 *
 * @param {string} which - the actions it applies to, for the description
 * @returns {import("zod").ZodOptional<import("zod").ZodBoolean>}
 */
export const confirmInput = (which) =>
    z
        .boolean()
        .optional()
        .describe(
            `Set true to go ahead with ${which}, which is asked about first. The deployment's confirmMode ` +
                'decides what counts: "agent" (the default) needs this; "human" asks the user through the client ' +
                'instead, and this does not answer for them; "off" asks nothing',
        );

/**
 * `ticket`: the token of a one-time secure page (src/core/secure-page.js) the account owner completed, which the call
 * consumes: an approval (confirmMode "human") or a hidden-chat PIN unlock. It never carries the PIN.
 *
 * @returns {import("zod").ZodOptional<import("zod").ZodString>}
 */
export const ticketInput = () =>
    z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
            "Only when a reply asked for it (confirmationRequired or pinRequired with a secureUrl): the ticket " +
                "from that reply, once the account owner completed the page. Repeat the same call with it; it " +
                "works once",
        );

/**
 * `dryRun` for the same tools: a preview that sends nothing.
 *
 * @param {string} which - the actions it applies to, for the description
 * @returns {import("zod").ZodOptional<import("zod").ZodBoolean>}
 */
export const dryRunInput = (which) =>
    z
        .boolean()
        .optional()
        .describe(`Set true to preview ${which}: the reply says what it would do, and nothing is sent`);

/** True for an input the caller left out or left empty. */
function missing(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return v.trim() === "";
    if (Array.isArray(v)) return v.length === 0;
    return false;
}

/**
 * The inputs an action needs, checked: each present, and an id that must be digits is digits. Ids come back trimmed
 * and id lists without repeats, so the call and the guard's sentence see the same values.
 *
 * @param {string} action
 * @param {object} args - the tool's input
 * @param {string[]} needs - the inputs this action requires
 * @returns {object} the args with ids normalized, or `{error}`
 */
export function checkInputs(action, args, needs) {
    const out = { ...args };
    for (const [field, hint] of Object.entries(NUMERIC_INPUTS)) {
        const v = out[field];
        if (v === undefined) continue;
        const list = Array.isArray(v);
        const values = (list ? v : [v]).map((x) => String(x).trim());
        const bad = values.find((x) => !NUMERIC_ID.test(x));
        if (bad !== undefined) return { error: `${field} must be numeric Zalo id(s) (got "${bad}"); ${hint}.` };
        out[field] = list ? [...new Set(values)] : values[0];
    }
    for (const field of needs) {
        if (missing(out[field])) return { error: `${field} is required for action='${action}'.` };
    }
    return out;
}

/**
 * The handler of an action tool.
 *
 * A row of `actions` is `{needs?, check?, prepare?, guard?, preview?, run, fail?}`:
 * - `needs`: the inputs it requires (see {@link checkInputs});
 * - `check(a)`: any further check; returns the refusal, or nothing;
 * - `prepare(a, ctx)`: what the guard and the call both need, read once before the guard (fields added to `a`);
 * - `guard(a)`: `{key, target, applies?}` for an action Zalo Web asks about first;
 * - `preview(a, ctx)`: more for a guarded action's dry run (what `conv forget --dry-run` lists);
 * - `run(a, ctx, extra)`: the session call; returns the reply's fields (the action's name is added), or
 *   `{needsReply}` for a "needs X" reply (pinRequired with a secure page link), returned as an error reply;
 * - `fail(e, a)`: a clearer message for a known refusal from Zalo, or nothing.
 *
 * `dryRun` on an action that is not asked about first is refused: it would otherwise be ignored, and the action done.
 *
 * @param {string} tool - the tool's name, for logs and refusals
 * @param {Record<string, object>} actions - the table
 * @param {{ok: Function, err: Function, gate: Function}} ctx - the reply wrappers and the guard, plus whatever the
 *   rows read (api, ownId, threadType, …)
 * @returns {(args: object, extra?: object) => Promise<object>}
 */
export function actionTool(tool, actions, ctx) {
    return async (args, extra) => {
        const action = args?.action;
        const def = Object.hasOwn(actions, action) ? actions[action] : null;
        if (!def) return ctx.err(`Unsupported ${tool} action: ${action}`);
        const a = checkInputs(action, args, def.needs ?? []);
        if (a.error) return ctx.err(a.error);
        const refused = def.check?.(a);
        if (refused) return ctx.err(refused);
        if (def.prepare) {
            try {
                Object.assign(a, await def.prepare(a, ctx));
            } catch (e) {
                return ctx.err(e.message);
            }
        }

        if (def.guard) {
            const g = def.guard(a);
            if (a.dryRun === true && def.preview) {
                return ctx.ok({ ...dryRunReport(g.key, g.target, "mcp"), ...(await def.preview(a, ctx)) });
            }
            const held = await ctx.gate(
                g.key,
                g.target,
                { confirm: a.confirm, dryRun: a.dryRun, ticket: a.ticket },
                extra,
                g.applies === undefined ? {} : { applies: g.applies },
            );
            if (held) return held;
        } else if (a.dryRun === true) {
            return ctx.err(
                `dryRun previews only the actions that are asked about first, and '${action}' is not one: nothing ` +
                    "was done. Call it again without dryRun to do it.",
            );
        }

        try {
            const out = await def.run(a, ctx, extra);
            // A "needs X" reply (a PIN or an approval on the secure page): an error reply with its fields, then the
            // line a person reads, as the guard's refusals are.
            if (out?.needsReply) {
                return {
                    content: [
                        { type: "text", text: JSON.stringify({ action, ...out.needsReply }) },
                        { type: "text", text: out.needsReply.error },
                    ],
                    isError: true,
                };
            }
            return ctx.ok({ action, ...out });
        } catch (e) {
            console.error(`[mcp-tools] ${tool} ${action} error:`, e.message);
            return ctx.err(def.fail?.(e, a) || e.message);
        }
    };
}
