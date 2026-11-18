/**
 * The account's own messages, and which of them reach the agents.
 *
 * `mcp start` keeps every message the account sends itself away from the agents (the buffer that zalo_get_messages and
 * zalo_wait_for_message read, the notifier, the webhook): they are the owner's own words or the agent's own replies.
 * One exception, opt-in per account (`ownMyDocuments`, src/core/deploy-policy.js): the owner's messages in their own
 * My Documents, the self-chat, so that an owner can talk to an assistant there. Such a message is marked
 * `isSelf: true`, the name the listener and `listen`'s webhook already use.
 *
 * My Documents is the conversation whose id is the session's `loginInfo.send2me_id` (src/utils/my-documents.js); a
 * 1-1 whose id is the account's own uid can only be the same chat, so it counts too. Nothing else does: a message the
 * account sends to anyone else, from any device, stays out whatever the setting says.
 *
 * With the setting on, the agent's own replies in My Documents would come back to it as new messages and it could
 * answer itself without end. A zalo_send_message call is therefore tracked ({@link createAgentSends}): the ids its
 * reply names are remembered, and a My Documents message waits for every send still in flight before it is compared
 * with them, so an echo that arrives before the send's reply is still recognized.
 */

/** How long the ids of an agent's send are remembered: far longer than an echo ever takes. */
const AGENT_SEND_TTL_MS = 10 * 60_000;
/** The longest a My Documents message waits for the sends in flight (an upload can take a while). */
const IN_FLIGHT_WAIT_MS = 60_000;

/**
 * Whether a listener message is in the account's own My Documents.
 *
 * @param {{threadId?: unknown, type?: number}} msg - a listener message (`type` 0 for a 1-1)
 * @param {{ownId?: string|null, send2meId?: string|null}} ids
 * @returns {boolean}
 */
export function isMyDocumentsMessage(msg, { ownId = null, send2meId = null } = {}) {
    if (!msg || Number(msg.type) !== 0) return false;
    const threadId = String(msg.threadId ?? "");
    if (!threadId) return false;
    return (Boolean(send2meId) && threadId === String(send2meId)) || (Boolean(ownId) && threadId === String(ownId));
}

/**
 * What happens to a message the account sent itself: `"drop"` (the rule since the start), or `"agents"` for one in
 * its own My Documents while `ownMyDocuments` is on. A message from anyone else is `"pass"`: the usual filters decide.
 *
 * @param {{isSelf?: boolean, threadId?: unknown, type?: number}} msg - a listener message
 * @param {{enabled: boolean, ownId?: string|null, send2meId?: string|null}} opts
 * @returns {"pass"|"drop"|"agents"}
 */
export function selfMessageRoute(msg, { enabled, ownId = null, send2meId = null }) {
    if (!msg?.isSelf) return "pass";
    if (!enabled) return "drop";
    return isMyDocumentsMessage(msg, { ownId, send2meId }) ? "agents" : "drop";
}

/**
 * The ids a tool reply names (`msgId`, `cliMsgId`, and each split part's).
 *
 * @param {object} result - an MCP tool result (`{content: [{type: "text", text: "<json>"}]}`)
 * @returns {string[]}
 */
function idsOfToolResult(result) {
    if (!result || result.isError) return [];
    const ids = [];
    for (const c of result.content ?? []) {
        if (c?.type !== "text" || typeof c.text !== "string") continue;
        let body;
        try {
            body = JSON.parse(c.text);
        } catch {
            continue;
        }
        for (const m of [body, ...(Array.isArray(body?.parts) ? body.parts : [])]) {
            for (const v of [m?.msgId, m?.cliMsgId]) if (v !== undefined && v !== null && v !== "") ids.push(String(v));
        }
    }
    return ids;
}

/**
 * The agents' own sends, so that their echo in My Documents is not handed back to them as a new message.
 *
 * @param {{ttlMs?: number, maxWaitMs?: number, now?: () => number}} [opts]
 * @returns {{track: <T>(run: () => Promise<T>) => Promise<T>, remember: (ids: string[]) => void,
 *   wasSentByAgent: (msg: {msgId?: unknown, cliMsgId?: unknown}) => Promise<boolean>}}
 */
export function createAgentSends({ ttlMs = AGENT_SEND_TTL_MS, maxWaitMs = IN_FLIGHT_WAIT_MS, now = Date.now } = {}) {
    const seen = new Map(); // id -> when it is forgotten
    const inFlight = new Set();

    const prune = () => {
        const t = now();
        for (const [id, until] of seen) if (until <= t) seen.delete(id);
    };
    const remember = (ids) => {
        prune();
        const until = now() + ttlMs;
        for (const id of ids) seen.set(String(id), until);
    };

    return {
        remember,
        /**
         * Run one send tool call, and remember the ids its reply names before anyone waiting on it goes on.
         */
        async track(run) {
            let done;
            const settled = new Promise((resolve) => (done = resolve));
            inFlight.add(settled);
            try {
                const result = await run();
                remember(idsOfToolResult(result));
                return result;
            } finally {
                inFlight.delete(settled);
                done();
            }
        },
        /**
         * Whether a message is the echo of an agent's send: waits for the sends in flight first.
         */
        async wasSentByAgent(msg) {
            if (inFlight.size) {
                let timer;
                const timeout = new Promise((resolve) => {
                    timer = setTimeout(resolve, maxWaitMs);
                    timer.unref?.();
                });
                await Promise.race([Promise.all([...inFlight]), timeout]);
                clearTimeout(timer);
            }
            prune();
            return [msg?.msgId, msg?.cliMsgId].some((v) => v !== undefined && v !== null && seen.has(String(v)));
        },
    };
}

/**
 * The agents' view of the account's own message in its own My Documents: the normalized message marked
 * `isSelf: true`, or null when it is the echo of an agent's own send.
 *
 * @param {object} msg - the listener message
 * @param {object|null} info - its classification
 * @param {object} deps
 * @param {(msg: object, info: object|null) => object} deps.normalize - normalizeMessage (src/commands/mcp.js)
 * @param {ReturnType<typeof createAgentSends>|null} [deps.agentSends]
 * @returns {Promise<object|null>}
 */
export async function ownMyDocumentsView(msg, info, { normalize, agentSends = null }) {
    const normalized = normalize(msg, info);
    if (agentSends && (await agentSends.wasSentByAgent(normalized))) return null;
    return { ...normalized, isSelf: true };
}
