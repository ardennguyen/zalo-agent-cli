/**
 * Each MCP tool's presence class (on-demand presence, src/core/presence.js and src/core/daemon-presence.js): what a
 * call does when the account's socket is parked, waking, yielded or signed out. Every tool registerTools registers
 * must have one (tests/unit/tool-presence.test.js).
 *
 *   none     runs at once; the wake runs beside it (sends, lookups, everything that is plain HTTP)
 *   fresh    reads the local cache: waits up to `presence.warmWait` for the socket and its catch-up, then answers
 *            anyway, with a `presence` block {state, catchUp, coveredUntil} when it is still warming
 *   socket   needs the socket itself (a sync stage, an upload): waits up to `presence.warmWait`, then the retryable
 *            error WARMING with `retryAfterSec`
 *   wait     a long-poll: holds the socket while it waits (presence.waitHoldsSocket)
 *
 * Every class is refused while the account is yielded (YIELDED) or signed out (SIGNED_OUT), except the one call that
 * ends a yield: zalo_profile `presence_resume`.
 */

/** A file, a video or a voice clip goes up through the socket's upload callbacks; text, links and cards do not. */
const sendClass = (a) => (a?.filePath || (Array.isArray(a?.files) && a.files.length) || a?.video ? "socket" : "none");

/** Tool name -> class, or a function of the call's arguments. */
export const TOOL_PRESENCE = Object.freeze({
    zalo_get_messages: "fresh",
    zalo_send_message: sendClass,
    zalo_list_threads: "none",
    zalo_search_threads: "none",
    zalo_mark_read: "none",
    zalo_get_history: "fresh",
    zalo_view_media: "none",
    zalo_react: "none",
    zalo_undo: "none",
    zalo_get_group_members: "none",
    zalo_list_conversations: "fresh",
    zalo_coverage: "fresh",
    zalo_sync: "socket",
    zalo_sync_status: "none",
    zalo_search_messages: "fresh",
    zalo_lookup_user: "none",
    zalo_forward_message: "socket",
    zalo_delete_message: "none",
    zalo_reminder: "none",
    zalo_note: "none",
    zalo_poll: "none",
    zalo_wait_for_message: "wait",
    zalo_label: "none",
    zalo_friend: "none",
    zalo_group: "none",
    zalo_read: "none",
    zalo_write: "none",
    zalo_conversation: "none",
    zalo_profile: "none",
    zalo_auto_reply: "none",
    zalo_quick_message: "none",
    zalo_catalog: "none",
    zalo_bank: "none",
    zalo_cloud: "none",
    zalo_sticker: "none",
    zalo_link: "none",
});

/** The calls that are let through while yielded: the ones that end it. */
const passesRefusal = (tool, args) => tool === "zalo_profile" && args?.action === "presence_resume";

/**
 * The class of one call.
 *
 * @param {string} tool
 * @param {object} [args]
 * @returns {"none"|"fresh"|"socket"|"wait"}
 */
export function presenceClassOf(tool, args) {
    const c = TOOL_PRESENCE[tool];
    if (typeof c === "function") return c(args);
    return c ?? "none";
}

/** An MCP error reply for a refused call: the code first, then the words, as `Error: CODE: …`. */
function refusalReply(e) {
    const text =
        `Error: ${e.code}: ${e.message}` + (e.retryAfterSec !== undefined ? ` (retryAfterSec ${e.retryAfterSec})` : "");
    return {
        content: [
            { type: "text", text },
            {
                type: "text",
                text: JSON.stringify({
                    error: e.message,
                    code: e.code,
                    ...(e.state ? { state: e.state } : {}),
                    ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
                }),
            },
        ],
        isError: true,
    };
}

/** Add `presence` to a JSON reply (a warming answer); a reply that is not one JSON object is left as it is. */
function withPresence(reply, block) {
    const first = reply?.content?.[0];
    if (!block || reply?.isError || first?.type !== "text") return reply;
    try {
        const body = JSON.parse(first.text);
        if (!body || typeof body !== "object" || Array.isArray(body)) return reply;
        return { ...reply, content: [{ ...first, text: JSON.stringify({ ...body, presence: block }) }] };
    } catch {
        return reply;
    }
}

/**
 * Wrap one tool's handler in the daemon's presence: refused while yielded or signed out, a hold for the call, and the
 * warming behavior of its class.
 *
 * @param {string} tool
 * @param {Function} handler - `(args, extra) => reply`
 * @param {{admit: Function}} daemonPresence - src/core/daemon-presence.js
 * @returns {Function}
 */
export function presenceGatedHandler(tool, handler, daemonPresence) {
    return async (args, extra) => {
        if (passesRefusal(tool, args)) return handler(args, extra);
        const cls = presenceClassOf(tool, args);
        let ticket;
        try {
            ticket = await daemonPresence.admit({ kind: "tool", cls });
        } catch (e) {
            if (e?.code) return refusalReply(e);
            throw e;
        }
        try {
            return withPresence(await handler(args, extra), ticket.warming);
        } finally {
            ticket.release();
        }
    };
}

/**
 * Make every tool registered on `server` from now on go through the daemon's presence.
 *
 * @param {{registerTool: Function}} server
 * @param {object|null} daemonPresence - null: no presence (the tools run as they are)
 */
export function gateToolsByPresence(server, daemonPresence) {
    if (!daemonPresence || typeof server?.registerTool !== "function") return;
    const raw = server.registerTool.bind(server);
    server.registerTool = (name, meta, handler) => raw(name, meta, presenceGatedHandler(name, handler, daemonPresence));
}
