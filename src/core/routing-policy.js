/**
 * The agents of one account, as its live policy (or mcp-config.json) names them: who each MCP caller is, its name and
 * the mark put on what it sends. The first part of the Message Router; routes, claims and fallback build on it.
 *
 *     "routing": {
 *       "marks": "shown",                      // or "hidden": the account's default for every agent's mark
 *       "presenceWindow": "90s",               // seen this recently = listening
 *       "agents": [
 *         {"slug": "dev", "name": "Dev", "credential": "apikey:0123456789ab", "mark": "🤖 Dev:"},
 *         {"slug": "ai", "name": "AI", "kind": "companion", "credential": "apikey:ba9876543210",
 *          "markDisplay": "everywhere"},
 *         {"slug": "claude", "name": "Claude", "credential": "oauth:claude-ai", "delivery": "onDemand"}
 *       ]
 *     }
 *
 * A credential is the engine's own: `apikey:<keyId>` (a named API key), `oauth:<clientId>` or
 * `oauth:<clientId>/<grantId>` (an OAuth client, or one grant of it), `legacy` (the deploy token), `open` (a server
 * that asks for no token), `stdio` or `stdio:<name>` (a local stdio server; the name is ZALO_MCP_AGENT). The agent is
 * never a name the caller types.
 *
 * This module has no imports: the policy schema (./policy-schema.js) checks the same shape with it.
 */

/** The most agents one account names. */
export const MAX_AGENTS = 50;
export const AGENT_KINDS = Object.freeze(["companion", "mcp-key", "mcp-oauth", "legacy", "stdio", "open"]);
export const MARK_DISPLAYS = Object.freeze(["inherit", "everywhere", "owner", "none"]);
export const ACCOUNT_MARKS = Object.freeze(["shown", "hidden"]);
export const DELIVERIES = Object.freeze(["live", "onDemand"]);
/** The presence window when the policy sets none: seen this recently counts as listening. */
export const DEFAULT_PRESENCE_WINDOW_MS = 90_000;

const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
const CREDENTIAL =
    /^(apikey:[0-9a-f]{12}|oauth:[A-Za-z0-9._:-]{1,128}(\/[A-Za-z0-9_-]{1,128})?|connector:[a-z][a-z0-9-]{0,23}|legacy|open|stdio(:[a-z0-9][a-z0-9-]{0,23})?)$/;
const NAME_MAX = 40;
const MARK_MAX = 40;

const printable = (text) => [...text].every((c) => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127);

/** The kind a credential implies, when the agent names none. */
export function kindOfCredential(credential) {
    const c = String(credential ?? "");
    if (c.startsWith("apikey:")) return "mcp-key";
    if (c.startsWith("oauth:") || c.startsWith("connector:")) return "mcp-oauth";
    if (c.startsWith("stdio")) return "stdio";
    if (c === "open") return "open";
    return "legacy";
}

/**
 * Check and normalize an agents list. Every field but `slug`, `name` and `credential` has a default, filled in here
 * so the reader never guesses.
 *
 * @param {unknown} value
 * @returns {{value: Array<object>} | {error: string}}
 */
export function checkAgents(value) {
    if (!Array.isArray(value)) return { error: "is not a list of agents" };
    if (value.length > MAX_AGENTS) return { error: `names more than ${MAX_AGENTS} agents` };
    const out = [];
    const slugs = new Set();
    const credentials = new Set();
    for (const [i, a] of value.entries()) {
        const at = `[${i}]`;
        if (!a || typeof a !== "object" || Array.isArray(a)) return { error: `${at} is not an object` };
        const known = ["slug", "name", "kind", "credential", "mark", "markDisplay", "delivery", "enabled"];
        const extra = Object.keys(a).find((k) => !known.includes(k));
        if (extra) return { error: `${at} has an unknown field "${extra}"` };
        const slug = String(a.slug ?? "").trim();
        if (!SLUG.test(slug)) return { error: `${at}.slug is not 1 to 24 lowercase letters, digits or -` };
        if (slugs.has(slug)) return { error: `${at}.slug "${slug}" is used twice` };
        const name = String(a.name ?? "").trim();
        if (!name || name.length > NAME_MAX || !printable(name))
            return { error: `${at}.name is not 1 to ${NAME_MAX} printable characters` };
        const credential = String(a.credential ?? "").trim();
        if (!CREDENTIAL.test(credential))
            return {
                error: `${at}.credential is not apikey:<id>, oauth:<clientId>[/<grantId>], connector:<slug>, legacy, open or stdio[:<name>]`,
            };
        // The agent's own connector address (`/mcp/a/<slug>`): every OAuth grant made for that address is this agent's.
        if (credential.startsWith("connector:") && credential !== `connector:${slug}`)
            return { error: `${at}.credential connector:<slug> names the agent's own slug (connector:${slug})` };
        if (credentials.has(credential)) return { error: `${at}.credential is bound to two agents` };
        const kind = a.kind === undefined || a.kind === null ? kindOfCredential(credential) : String(a.kind);
        if (!AGENT_KINDS.includes(kind)) return { error: `${at}.kind is not one of ${AGENT_KINDS.join(", ")}` };
        let mark = null;
        if (a.mark !== undefined && a.mark !== null) {
            mark = String(a.mark).trim();
            if (mark.length > MARK_MAX || !printable(mark))
                return { error: `${at}.mark is more than ${MARK_MAX} characters or not printable` };
        }
        const markDisplay = a.markDisplay ?? "inherit";
        if (!MARK_DISPLAYS.includes(markDisplay))
            return { error: `${at}.markDisplay is not one of ${MARK_DISPLAYS.join(", ")}` };
        const delivery = a.delivery ?? (kind === "mcp-oauth" ? "onDemand" : "live");
        if (!DELIVERIES.includes(delivery)) return { error: `${at}.delivery is not one of ${DELIVERIES.join(", ")}` };
        if (a.enabled !== undefined && typeof a.enabled !== "boolean")
            return { error: `${at}.enabled is not true or false` };
        slugs.add(slug);
        credentials.add(credential);
        out.push({ slug, name, kind, credential, mark, markDisplay, delivery, enabled: a.enabled !== false });
    }
    return { value: out };
}

/**
 * The mark an agent's text starts with when no mark is set: `🤖 <name>:`. The console shows it as the effective mark.
 *
 * @param {{name: string}} agent
 * @returns {string}
 */
export function defaultMark(agent) {
    return `🤖 ${agent.name}:`;
}

/**
 * The agent a credential is bound to: a grant made for an agent's connector address (`/mcp/a/<slug>`) or bound to an
 * agent on the approve page (carried as `agentHint`) is the agent bound by `connector:<slug>`, else the agent with that
 * slug, and nobody's when there is none (it fails closed); else an
 * exact grant binding (`oauth:<client>/<grant>`) wins over the client's.
 *
 * @param {Array<object>} agents - a checked list
 * @param {string|null} credential
 * @param {string|null} [agentHint] - the agent the OAuth grant was made for
 * @returns {object|null}
 */
export function agentForCredential(agents, credential, agentHint = null) {
    if (!credential) return null;
    if (agentHint)
        return (
            agents.find((a) => a.credential === `connector:${agentHint}`) ??
            // The owner picked this agent on the approve page (or approved its address): it is that agent's.
            agents.find((a) => a.slug === agentHint) ??
            null
        );
    const exact = agents.find((a) => a.credential === credential);
    if (exact) return exact;
    const slash = credential.indexOf("/");
    if (credential.startsWith("oauth:") && slash > 0) {
        const client = credential.slice(0, slash);
        return agents.find((a) => a.credential === client) ?? null;
    }
    return null;
}

/**
 * The mark text for one send, or "" when none goes on: the agent's display setting, else the account's.
 *
 * @param {object|null} agent
 * @param {{marks?: "shown"|"hidden", ownerChat?: boolean}} opts - `ownerChat`: the send goes to My Documents
 * @returns {string}
 */
export function markFor(agent, { marks = "shown", ownerChat = false } = {}) {
    if (!agent) return "";
    const display = agent.markDisplay === "inherit" ? (marks === "hidden" ? "none" : "everywhere") : agent.markDisplay;
    if (display === "none") return "";
    if (display === "owner" && !ownerChat) return "";
    return agent.mark || defaultMark(agent);
}
