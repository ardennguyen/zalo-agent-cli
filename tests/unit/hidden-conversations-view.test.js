/**
 * src/core/conversation-actions.js hiddenConversationsView — what `conv hidden` and zalo_conversation `hidden` hand
 * out.
 *
 * Zalo's get-all answer carries `pin`, the unsalted MD5 of the 4-digit hidden-chat PIN. Both surfaces passed it
 * through until 2026-11-07, so anyone reading the output could recover the PIN in ten thousand guesses. Red if the
 * hash, or any other field of Zalo's answer, comes back out.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hiddenConversationsView } from "../../src/core/conversation-actions.js";
import { CONVERSATION_ACTIONS } from "../../src/mcp/actions-conversation.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { SecurePage } from "../../src/core/secure-page.js";

const MD5_OF_A_PIN = "81dc9bdb52d04dc20036dbd8313ed055";
const RAW = { pin: MD5_OF_A_PIN, threads: [{ thread_id: "1000000000000000001", is_group: 0 }], extra: "x" };

describe("hiddenConversationsView", () => {
    it("keeps the threads, says a PIN is set, and drops the PIN hash", () => {
        const view = hiddenConversationsView(RAW);
        assert.deepEqual(view, { threads: RAW.threads, hasPin: true });
        assert.doesNotMatch(JSON.stringify(view), new RegExp(MD5_OF_A_PIN));
    });

    it("answers an empty or missing reply with no threads and no PIN", () => {
        for (const raw of [undefined, null, "", {}, { pin: "" }]) {
            assert.deepEqual(hiddenConversationsView(raw), { threads: [], hasPin: false });
        }
    });
});

describe("zalo_conversation hidden", () => {
    it("never returns the PIN hash to the agent: without the PIN, the count and a one-time page only", async () => {
        const hidden = CONVERSATION_ACTIONS.hidden;
        assert.ok(hidden, "the hidden action is where this test expects it");
        const set = new HiddenChats();
        const page = new SecurePage({ accountId: "1" }).configure({ localBaseUrl: "http://127.0.0.1:9" });
        const ctx = {
            api: { getHiddenConversations: async () => RAW },
            hidden: () => set,
            securePage: () => page,
            ownId: () => "1",
            config: {},
            stateless: true,
        };
        const out = await hidden.run({}, ctx, {});
        assert.equal(out.needsReply.pinRequired, true);
        assert.equal(out.needsReply.count, 1);
        assert.doesNotMatch(JSON.stringify(out), new RegExp(MD5_OF_A_PIN));
        assert.doesNotMatch(JSON.stringify(out), /1000000000000000001/, "no thread before the PIN");

        const unlocked = await hidden.run({ pin: "1234" }, { ...ctx, config: { allowPinArgument: true } }, {});
        assert.equal(unlocked.count, 1);
        assert.doesNotMatch(JSON.stringify(unlocked), new RegExp(MD5_OF_A_PIN));
    });
});
