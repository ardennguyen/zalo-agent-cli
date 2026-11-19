/**
 * `ownMyDocuments` — the owner's own messages in their own My Documents reaching the agents (src/mcp/self-messages.js).
 *
 * `mcp start` drops every message the account sends itself before the buffer, the notifier and the webhook. With the
 * setting off that stays exactly so. With it on, a message the account sends in its own My Documents (the session's
 * `send2me_id`, or a 1-1 under the own uid) reaches the buffer and the webhook payload marked `isSelf: true`; a
 * message the account sends anywhere else is still dropped, and the echo of the agent's own zalo_send_message is
 * never handed back. Red if any of those changes, or if the marker lets a hidden chat through.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMCPWebhookPayload, normalizeMessage } from "../../src/commands/mcp.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import {
    createAgentSends,
    isMyDocumentsMessage,
    ownMyDocumentsView,
    selfMessageRoute,
} from "../../src/mcp/self-messages.js";
import { resolveOwnMyDocuments } from "../../src/core/deploy-policy.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
import { getDefaultConfig } from "../../src/mcp/mcp-config.js";
import { hiddenEventView } from "../../src/core/hidden-chats.js";

const OWN = "1000000000000000001";
const SEND2ME = "1000000000000000009";
const FRIEND = "1000000000000000004";
const GROUP = "2000000000000000004";
const IDS = { ownId: OWN, send2meId: SEND2ME };

const ev = (threadId, { type = 0, isSelf = true, ...data } = {}) => ({
    threadId,
    type,
    isSelf,
    data: {
        msgId: "5001",
        cliMsgId: "7001",
        uidFrom: OWN,
        ts: String(Date.now()),
        msgType: "webchat",
        content: "remind me at 5",
        ...data,
    },
});

/** What `mcp start`'s listener does with one message, the way src/commands/mcp.js wires it. */
async function agentsGet(msg, { enabled, agentSends = null }) {
    const route = selfMessageRoute(msg, { enabled, ...IDS });
    if (route === "drop") return null;
    if (route === "pass") return normalizeMessage(msg);
    return ownMyDocumentsView(msg, null, { normalize: normalizeMessage, agentSends });
}

describe("ownMyDocuments: which self-sent messages reach the agents", () => {
    it("off (the default): the owner's own My Documents message is dropped, as before", async () => {
        assert.equal(selfMessageRoute(ev(SEND2ME), { enabled: false, ...IDS }), "drop");
        assert.equal(await agentsGet(ev(SEND2ME), { enabled: false }), null);
        assert.equal(
            resolveOwnMyDocuments({ config: getDefaultConfig(), env: {}, accountId: OWN, policy: null }).enabled,
            false,
        );
    });

    it("on: the owner's own My Documents message reaches the buffer and the webhook, marked isSelf", async () => {
        const n = await agentsGet(ev(SEND2ME), { enabled: true });
        assert.ok(n, "delivered");
        assert.equal(n.isSelf, true);
        assert.equal(n.threadId, SEND2ME);
        assert.equal(n.text, "remind me at 5");
        assert.equal(n.senderId, OWN);

        const buffer = new MessageBuffer(10, 60 * 60_000);
        buffer.push(n.threadId, n);
        const [read] = buffer.read(null, 0).messages;
        assert.equal(read.isSelf, true, "the buffer entry carries the marker");
        assert.equal(read.msgId, "5001");

        const payload = buildMCPWebhookPayload(n, { accountId: OWN });
        assert.equal(payload.event, "message");
        assert.equal(payload.isSelf, true, "the webhook payload carries the marker");
        assert.equal(payload.threadId, SEND2ME);
    });

    it("on: a 1-1 under the account's own uid is the same self-chat", () => {
        assert.equal(selfMessageRoute(ev(OWN), { enabled: true, ...IDS }), "agents");
        assert.equal(isMyDocumentsMessage(ev(SEND2ME), { ownId: OWN, send2meId: null }), false);
    });

    it("on: every other message the account sends itself is still dropped", async () => {
        for (const msg of [ev(FRIEND), ev(GROUP, { type: 1 }), ev(SEND2ME, { type: 1 })]) {
            assert.equal(selfMessageRoute(msg, { enabled: true, ...IDS }), "drop", msg.threadId);
            assert.equal(await agentsGet(msg, { enabled: true }), null, msg.threadId);
        }
    });

    it("someone else's message is untouched either way, and never marked", async () => {
        const msg = ev(FRIEND, { isSelf: false, uidFrom: FRIEND });
        for (const enabled of [false, true]) {
            assert.equal(selfMessageRoute(msg, { enabled, ...IDS }), "pass");
            assert.equal((await agentsGet(msg, { enabled })).isSelf, undefined);
        }
    });

    it("on: the echo of the agent's own send is not handed back, even when it arrives before the reply", async () => {
        const agentSends = createAgentSends();
        let reply;
        const sending = agentSends.track(
            () =>
                new Promise((resolve) => {
                    reply = () =>
                        resolve({
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({ success: true, msgId: "5001", cliMsgId: "7001" }),
                                },
                            ],
                        });
                }),
        );
        // The echo comes in while the send is still in flight.
        const echo = agentsGet(ev(SEND2ME), { enabled: true, agentSends });
        reply();
        await sending;
        assert.equal(await echo, null, "the agent's own reply is not a new message for it");

        // The owner's next note in the same chat still gets through.
        const note = await agentsGet(ev(SEND2ME, { msgId: "5002", cliMsgId: "7002" }), { enabled: true, agentSends });
        assert.equal(note?.isSelf, true);
    });

    it("hidden-chat rules are unchanged: the marker does not let a hidden My Documents through", async () => {
        const n = await agentsGet(ev(SEND2ME), { enabled: true });
        const hidden = { ids: new Set([SEND2ME]), isHidden: (id) => String(id) === SEND2ME };
        assert.equal(hiddenEventView(n, hidden, "exclude"), null);
        const dot = hiddenEventView(n, hidden, "contentless", { name: "message" });
        assert.deepEqual(dot, { event: "message", hidden: true });
        assert.equal(hiddenEventView(n, hidden, "include"), n);
    });
});

describe("ownMyDocuments: where the setting is read", () => {
    const resolve = (sources) => resolveOwnMyDocuments({ accountId: OWN, policy: null, env: {}, ...sources });

    it("mcp-config.json, the environment, the per-account variable, then the live policy, highest last", () => {
        assert.deepEqual(resolve({ config: { ownMyDocuments: true } }), { enabled: true, source: "ownMyDocuments" });
        assert.deepEqual(resolve({ config: { ownMyDocuments: true }, env: { ZALO_MCP_OWN_MY_DOCUMENTS: "0" } }), {
            enabled: false,
            source: "ZALO_MCP_OWN_MY_DOCUMENTS",
        });
        assert.deepEqual(
            resolve({
                env: { ZALO_MCP_OWN_MY_DOCUMENTS: "0", [`ZALO_MCP_OWN_MY_DOCUMENTS_${OWN}`]: "1" },
            }),
            { enabled: true, source: `ZALO_MCP_OWN_MY_DOCUMENTS_${OWN}` },
        );
        assert.deepEqual(
            resolve({ env: { [`ZALO_MCP_OWN_MY_DOCUMENTS_${OWN}`]: "1" }, policy: { ownMyDocuments: false } }),
            { enabled: false, source: "policy:ownMyDocuments" },
        );
    });

    it("the live policy takes it as a yes/no key", () => {
        assert.equal(validatePolicy({ ownMyDocuments: true }).errors?.length ?? 0, 0);
        assert.ok((validatePolicy({ ownMyDocuments: "sometimes" }).errors ?? []).length > 0);
    });
});
