/**
 * The real MCP tools against a fake api that records every send, for tests of what `zalo_send_message` hands to Zalo.
 */
import { registerTools } from "../../../src/mcp/mcp-tools.js";

/** The real tools against a fake api that records every send; `failOn` (1-based) makes that send throw like Zalo. */
export function tool({ failOn = 0 } = {}) {
    const sent = [];
    const tools = new Map();
    const server = { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
    const api = {
        sendMessage: async (content, threadId, type) => {
            sent.push({ content, threadId, type });
            if (sent.length === failOn) throw Object.assign(new Error("Lỗi không xác định"), { code: 112 });
            return { message: { msgId: `m${sent.length}`, cliMsgId: `c${sent.length}` } };
        },
    };
    registerTools(
        server,
        api,
        {
            read: () => ({ messages: [], cursor: 0 }),
            getStats: () => [],
            getThreadType: () => "group",
            markRead: () => 0,
            readCursor: () => 0,
        },
        { isWatched: () => true },
        { limits: { maxMessagesPerPoll: 20 } },
        { ready: true, get: () => null, search: () => [] },
        undefined,
    );
    const call = async (args) => {
        const res = await tools.get("zalo_send_message").handler({ threadType: 1, ...args });
        const text = res.content[0].text;
        // A refusal is the plain text "Error: ...", not JSON.
        return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    };
    return { sent, call, tools };
}
