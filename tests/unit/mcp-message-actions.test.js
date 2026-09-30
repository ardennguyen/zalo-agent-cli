/**
 * The MCP tools that act on a message or send one: `zalo_react`, `zalo_undo`,
 * and `zalo_send_message`'s `urgency` and `me`.
 *
 * Each mirrors a `msg` subcommand and calls the code that command calls:
 * `reactionCliMsgId` / `recallCliMsgId` / `cachedMessageById`
 * (src/core/cached-message.js), `resolveSelfThread` (src/utils/my-documents.js)
 * and `urgencyLevel` (src/utils/urgency.js). The CLI side of each is pinned on
 * the wire by msg-react-cache, msg-my-documents and msg-urgency; what is
 * asserted here is what the tool hands the zca-js api — the call a live
 * session would encrypt and post — and that a refusal hands it nothing.
 *
 * `registerTools` only needs an object with `registerTool()`, so the handlers
 * run offline against a recording api and a real zalo.db in the sandbox.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { initDb, insertMessage, upsertThread, upsertContact } from "../../src/core/db.js";

/** Made-up ids. None of them belongs to anyone. */
const OWN = "100000000000000091";
const SEND2ME = "400000000000000091";
const GROUP = "200000000000000091";
const PEER = "300000000000000091";
const MEMBER = "500000000000000091";

const GROUP_MSG = { msgId: "7100000000091", cliMsgId: "1700000000091" };
const DM_MSG = { msgId: "7100000000092", cliMsgId: "1700000000092" };
const NOTE_MSG = { msgId: "7100000000093", cliMsgId: "1700000000093" };
const UNCACHED = "7100000000099";

const THREAD_USER = 0;
const THREAD_GROUP = 1;

const ROOT = mkdtempSync(join(SANDBOX_HOME, "mcp-actions-"));
const handles = [];
let n = 0;

before(() => assertSandboxed(CONFIG_DIR));

beforeEach(() => {
    handles.push(initDb(join(ROOT, `actions${n++}.sqlite`)));
    upsertThread({ threadId: GROUP, type: "group", name: "Nhóm thử", lastUpdate: 1700000000000 });
    upsertThread({ threadId: PEER, type: "dm", name: "Chị Lan", lastUpdate: 1700000000000 });
    upsertThread({ threadId: SEND2ME, type: "dm", name: "My Documents", lastUpdate: 1700000000000 });
    const cache = (m, threadId, senderId) =>
        insertMessage({
            msgId: m.msgId,
            threadId,
            senderId,
            senderName: "",
            text: "offline target",
            timestamp: 1700000000500,
            type: "text",
            raw_data: JSON.stringify({ msgType: "webchat", cliMsgId: m.cliMsgId, content: "offline target" }),
            has_attachment: 0,
        });
    cache(GROUP_MSG, GROUP, MEMBER);
    cache(DM_MSG, PEER, OWN);
    cache(NOTE_MSG, SEND2ME, OWN);
});

after(() => {
    for (const h of handles) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
});

/** Records what registerTools() registers, standing in for McpServer. */
function fakeServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, meta, handler) {
            tools.set(name, { meta, handler });
        },
        call(name, args) {
            return tools.get(name).handler(args);
        },
    };
}

/**
 * A logged-in api that records every call and answers like Zalo does.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.send2me] - null: the session reported no send2me_id
 * @param {Error} [opts.fail] - thrown by addReaction/undo
 */
function recordingApi({ send2me = SEND2ME, fail = null } = {}) {
    const calls = [];
    return {
        calls,
        getOwnId: () => OWN,
        getContext: () => ({ loginInfo: send2me === null ? {} : { send2me_id: send2me } }),
        sendMessage: async (content, threadId, type) => {
            calls.push({ fn: "sendMessage", content, threadId, type });
            return { message: { msgId: "7100000000900", cliMsgId: "1700000000900" } };
        },
        addReaction: async (icon, dest) => {
            calls.push({ fn: "addReaction", icon, dest });
            if (fail) throw fail;
            return { msgIds: [1] };
        },
        undo: async (payload, threadId, type) => {
            calls.push({ fn: "undo", payload, threadId, type });
            if (fail) throw fail;
            return { status: 0 };
        },
    };
}

/** Register the tools over `api` and call one. */
async function call(name, args, api) {
    const server = fakeServer();
    const buffer = {
        read: () => ({ messages: [] }),
        getStats: () => [],
        getThreadType: () => "dm",
        readCursor: () => 0,
    };
    registerTools(server, api, buffer, {}, { limits: {} }, { ready: true, get: () => null, search: () => [] });
    return server.call(name, args);
}

const payloadOf = (r) => JSON.parse(r.content[0].text);

describe("zalo_react", () => {
    it("refuses a message with no known cliMsgId, and never touches the api", async () => {
        const api = recordingApi();
        const r = await call("zalo_react", { msgId: UNCACHED, threadId: GROUP, reaction: "/-strong" }, api);
        // Red if the tool falls back to keying the reaction on the msgId: Zalo
        // accepts that and never shows it, which is why `msg react` refuses.
        assert.equal(r.isError, true);
        assert.deepEqual(api.calls, [], "a refusal must not reach Zalo");
        assert.match(r.content[0].text, /not in the local cache/);
        assert.match(r.content[0].text, /`cliMsgId` parameter/, "names the way out an agent has, not the CLI's -c");
    });

    it("reacts with the cached cliMsgId, typed from the cache when threadType is omitted", async () => {
        const api = recordingApi();
        const r = await call("zalo_react", { msgId: GROUP_MSG.msgId, threadId: GROUP, reaction: "/-heart" }, api);
        assert.equal(r.isError, undefined, r.content[0].text);
        // Red if cliMsgId is the msgId, or the group goes out as a DM.
        assert.deepEqual(api.calls, [
            {
                fn: "addReaction",
                icon: "/-heart",
                dest: { data: { msgId: GROUP_MSG.msgId, cliMsgId: GROUP_MSG.cliMsgId }, threadId: GROUP, type: 1 },
            },
        ]);
        assert.equal(payloadOf(r).success, true);
        assert.equal(payloadOf(r).cliMsgId, GROUP_MSG.cliMsgId);
    });

    it("an explicit cliMsgId and threadType win over the cache", async () => {
        const api = recordingApi();
        await call(
            "zalo_react",
            { msgId: GROUP_MSG.msgId, threadId: GROUP, reaction: ":>", cliMsgId: "1700000000555", threadType: 0 },
            api,
        );
        assert.deepEqual(api.calls[0].dest, {
            data: { msgId: GROUP_MSG.msgId, cliMsgId: "1700000000555" },
            threadId: GROUP,
            type: THREAD_USER,
        });
    });

    it("a msgId cached under a different conversation is not this one's message", async () => {
        // msgIds are account-wide; a row from another conversation must not
        // lend its cliMsgId to a reaction aimed somewhere else.
        const api = recordingApi();
        const r = await call("zalo_react", { msgId: GROUP_MSG.msgId, threadId: PEER, reaction: "/-strong" }, api);
        assert.equal(r.isError, true);
        assert.deepEqual(api.calls, []);
    });

    it("`me` reacts in My Documents, as a 1-1", async () => {
        const api = recordingApi();
        const r = await call("zalo_react", { msgId: NOTE_MSG.msgId, threadId: "me", reaction: "/-strong" }, api);
        // Red if the literal "me" goes out as the thread id.
        assert.deepEqual(api.calls[0].dest, {
            data: { msgId: NOTE_MSG.msgId, cliMsgId: NOTE_MSG.cliMsgId },
            threadId: SEND2ME,
            type: THREAD_USER,
        });
        assert.equal(payloadOf(r).threadId, SEND2ME);
    });

    it("reports an API failure as an MCP error, not a throw", async () => {
        const api = recordingApi({ fail: new Error("Tham số không hợp lệ") });
        const r = await call("zalo_react", { msgId: DM_MSG.msgId, threadId: PEER, reaction: "/-strong" }, api);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /Tham số không hợp lệ/);
    });
});

describe("zalo_undo", () => {
    it("refuses a message with no known cliMsgId, and never touches the api", async () => {
        const api = recordingApi();
        const r = await call("zalo_undo", { msgId: UNCACHED, threadId: PEER }, api);
        assert.equal(r.isError, true);
        assert.deepEqual(api.calls, [], "a recall without its cliMsgId must not be sent");
        assert.match(r.content[0].text, /cliMsgId is required to recall a message/);
        assert.doesNotMatch(r.content[0].text, /--cli-msg-id/, "an agent has no flag to pass");
    });

    it("recalls with {msgId, cliMsgId} from the cache, typed from the cache", async () => {
        const api = recordingApi();
        const r = await call("zalo_undo", { msgId: DM_MSG.msgId, threadId: PEER }, api);
        assert.equal(r.isError, undefined, r.content[0].text);
        // Red if the payload loses the cached cliMsgId, or the DM goes out as a group.
        assert.deepEqual(api.calls, [
            { fn: "undo", payload: { msgId: DM_MSG.msgId, cliMsgId: DM_MSG.cliMsgId }, threadId: PEER, type: 0 },
        ]);
        assert.equal(payloadOf(r).success, true);
    });

    it("a group message recalls on the group endpoint's type", async () => {
        const api = recordingApi();
        await call("zalo_undo", { msgId: GROUP_MSG.msgId, threadId: GROUP }, api);
        assert.equal(api.calls[0].type, THREAD_GROUP);
    });

    it("an explicit cliMsgId recalls a message the cache never saw", async () => {
        // The one way to recall something this server did not capture: the
        // id zalo_send_message handed back.
        const api = recordingApi();
        const r = await call("zalo_undo", { msgId: UNCACHED, threadId: PEER, cliMsgId: "1700000000777" }, api);
        assert.equal(r.isError, undefined);
        assert.deepEqual(api.calls[0].payload, { msgId: UNCACHED, cliMsgId: "1700000000777" });
    });
});

describe("zalo_send_message urgency", () => {
    it("urgent is level 2 and important level 1, as `msg send --urgency` maps them", async () => {
        const api = recordingApi();
        await call("zalo_send_message", { threadId: GROUP, text: "offline urgent", urgency: "urgent" }, api);
        await call("zalo_send_message", { threadId: PEER, text: "offline important", urgency: "important" }, api);
        // zca-js turns `urgency` into the metaData {urgency} Zalo Web sends
        // (pinned on the wire for the CLI in msg-urgency.test.js). Red if the
        // mapping drifts, or the field is dropped.
        assert.deepEqual(api.calls[0].content, { msg: "offline urgent", urgency: 2 });
        assert.deepEqual(api.calls[1].content, { msg: "offline important", urgency: 1 });
    });

    it("normal is an ordinary message: a bare string, no urgency field", async () => {
        const api = recordingApi();
        await call("zalo_send_message", { threadId: PEER, text: "offline normal", urgency: "normal" }, api);
        assert.strictEqual(api.calls[0].content, "offline normal");
    });

    it("rides along with a mention", async () => {
        upsertContact({ userId: MEMBER, name: "Bích Ngọc", phone: null });
        const api = recordingApi();
        await call("zalo_send_message", { threadId: GROUP, text: `@[${MEMBER}] xem nhé`, urgency: "urgent" }, api);
        const { msg, mentions, urgency } = api.calls[0].content;
        assert.equal(msg, "@Bích Ngọc xem nhé");
        assert.equal(mentions.length, 1);
        assert.equal(urgency, 2);
    });
});

describe("zalo_send_message to `me`", () => {
    it("sends to My Documents' own thread id, as a 1-1, and says which", async () => {
        const api = recordingApi();
        const r = await call("zalo_send_message", { threadId: "me", text: "offline note" }, api);
        // Red if "me" (or anything but send2me_id) reaches sendMessage.
        assert.deepEqual(api.calls, [{ fn: "sendMessage", content: "offline note", threadId: SEND2ME, type: 0 }]);
        const out = payloadOf(r);
        assert.equal(out.threadId, SEND2ME, "the reply names the thread it really went to");
        assert.equal(out.threadType, THREAD_USER);
        assert.match(out.notice, /My Documents/);
    });

    it("`ME` is the same alias", async () => {
        const api = recordingApi();
        await call("zalo_send_message", { threadId: "ME", text: "offline note" }, api);
        assert.equal(api.calls[0].threadId, SEND2ME);
    });

    it("the own uid means My Documents too, since Zalo rejects it as a thread", async () => {
        const api = recordingApi();
        const r = await call("zalo_send_message", { threadId: OWN, text: "offline via uid" }, api);
        assert.equal(api.calls[0].threadId, SEND2ME);
        assert.match(payloadOf(r).notice, /own uid/);
    });

    it("refuses `me` with threadType 1: My Documents is not a group", async () => {
        const api = recordingApi();
        const r = await call("zalo_send_message", { threadId: "me", text: "offline", threadType: 1 }, api);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not a group/);
        assert.deepEqual(api.calls, []);
    });

    it("refuses `me` when the session reported no send2me_id, rather than guess", async () => {
        const api = recordingApi({ send2me: null });
        const r = await call("zalo_send_message", { threadId: "me", text: "offline" }, api);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /send2me_id/);
        assert.deepEqual(api.calls, []);
    });

    it("an ordinary thread id is untouched and the reply keeps its shape", async () => {
        const api = recordingApi();
        const r = await call("zalo_send_message", { threadId: PEER, text: "offline hi" }, api);
        assert.equal(api.calls[0].threadId, PEER);
        assert.deepEqual(Object.keys(payloadOf(r)).sort(), ["cliMsgId", "messageId", "success", "threadType"]);
    });
});
