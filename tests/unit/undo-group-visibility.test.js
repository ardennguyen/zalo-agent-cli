/**
 * A group recall carries the group's own `visibility`, as Zalo expects (spec-actions 1.3, open question 4; FX 13).
 *
 * The value comes from the group-info cache, 0 only when the cache has none; the previous engine always sent 0, and so did
 * `msg undo` and `zalo_undo`. Both now pass it: from the MCP thread cache when it holds the value, else from the
 * group's info (`getGroupInfo`). A 1-1 recall is untouched, and a group whose value nobody can read still recalls
 * with 0.
 *
 * The CLI case runs the real command against an offline session and reads the decrypted recall request; the MCP
 * cases run the tool against a recording api. Every id is fake.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";
import { groupVisibility, undoPayload } from "../../src/zalo/custom/group-visibility.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { seedAccount, seedThread, runOffline, requestsTo } from "./support/offline-cli.js";

const GROUP = "200000000000000093";
const PEER = "300000000000000093";
const MSG = { msgId: "7100000000093", cliMsgId: "1700000000093" };

/** A recording api: getGroupInfo answers `visibility` for GROUP (or throws), undo records its payload. */
function recordingApi({ visibility = 1, fail = false } = {}) {
    const calls = [];
    return {
        calls,
        getOwnId: () => "100000000000000093",
        getContext: () => ({ loginInfo: {} }),
        getGroupInfo: async (ids) => {
            calls.push({ fn: "getGroupInfo", ids });
            if (fail) throw new Error("offline: no group info");
            return { gridInfoMap: { [GROUP]: { groupId: GROUP, name: "Fake group", visibility } } };
        },
        undo: async (payload, threadId, type) => {
            calls.push({ fn: "undo", payload, threadId, type });
            return { status: 0 };
        },
    };
}

describe("groupVisibility / undoPayload", () => {
    it("reads the cache first, and asks Zalo only when the cache has no value", async () => {
        const api = recordingApi({ visibility: 2 });
        assert.equal(await groupVisibility(api, GROUP, { cache: { get: () => ({ visibility: 1 }) } }), 1);
        assert.deepEqual(api.calls, [], "a cached value needs no request");
        assert.equal(await groupVisibility(api, `g${GROUP}`, { cache: { get: () => ({ name: "x" }) } }), 2);
        assert.deepEqual(api.calls, [{ fn: "getGroupInfo", ids: [GROUP] }], "asked by the bare group id");
    });

    it("is undefined when nothing knows it, so the engine keeps sending 0", async () => {
        assert.equal(await groupVisibility(recordingApi({ fail: true }), GROUP), undefined);
        assert.equal(await groupVisibility(recordingApi({ visibility: null }), GROUP), undefined);
        assert.equal(await groupVisibility({}, GROUP), undefined);
        assert.deepEqual(await undoPayload(recordingApi({ fail: true }), MSG, GROUP, 1), MSG);
    });

    it("leaves a 1-1 recall alone, without a request", async () => {
        const api = recordingApi();
        assert.deepEqual(await undoPayload(api, MSG, PEER, 0), MSG);
        assert.deepEqual(api.calls, []);
    });
});

describe("zalo_undo in a group", () => {
    const DIR = mkdtempSync(join(SANDBOX_HOME, "undo-visibility-"));

    before(() => {
        assertSandboxed(CONFIG_DIR);
        initDb(join(DIR, "mcp.sqlite"));
        upsertThread({ threadId: GROUP, type: "group", name: "Fake group", lastUpdate: 1700000000000 });
    });

    /** Register the tools over `api` with a thread cache answering `entry` for the group, and recall MSG. */
    async function recall(api, entry) {
        const tools = new Map();
        const server = { registerTool: (name, _meta, handler) => tools.set(name, handler) };
        const buffer = { read: () => ({ messages: [] }), getStats: () => [], getThreadType: () => "group" };
        const cache = { ready: true, get: (id) => (id === GROUP ? entry : null), search: () => [] };
        registerTools(server, api, buffer, {}, { limits: {} }, cache);
        return tools.get("zalo_undo")({ ...MSG, threadId: GROUP, threadType: "group", confirm: true });
    }

    it("sends the visibility the thread cache holds", async () => {
        const api = recordingApi({ visibility: 0 });
        const r = await recall(api, { name: "Fake group", type: "group", visibility: 1 });
        assert.equal(r.isError, undefined, r.content[0].text);
        // Red when the tool sends {msgId, cliMsgId} alone: the engine then recalls with visibility 0.
        assert.deepEqual(api.calls, [{ fn: "undo", payload: { ...MSG, visibility: 1 }, threadId: GROUP, type: 1 }]);
    });

    it("asks Zalo for it when the cache has none", async () => {
        const api = recordingApi({ visibility: 1 });
        await recall(api, { name: "Fake group", type: "group" });
        assert.deepEqual(api.calls.at(-1).payload, { ...MSG, visibility: 1 });
    });
});

describe("msg undo in a group", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        seedAccount();
        seedThread(GROUP, "group");
        insertMessage({
            msgId: MSG.msgId,
            threadId: GROUP,
            senderId: "100000000000000001",
            senderName: "",
            text: "offline undo target",
            timestamp: 1700000000930,
            type: "text",
            raw_data: JSON.stringify({ msgType: "webchat", cliMsgId: MSG.cliMsgId, content: "offline undo target" }),
            has_attachment: 0,
        });
    });

    it("recalls with the group's visibility from its info", async () => {
        const r = await runOffline(["msg", "undo", MSG.msgId, GROUP, "-t", "1", "--yes"], {
            responses: { "/api/group/getmg-v2": { gridInfoMap: { [GROUP]: { groupId: GROUP, visibility: 1 } } } },
        });
        const recalls = requestsTo(r.requests, "/api/group/undomsg");
        assert.equal(recalls.length, 1, r.all);
        // Red without the fix: the command sent no visibility, and the engine wrote 0.
        assert.equal(recalls[0].params.visibility, 1, r.all);
        assert.equal(recalls[0].params.cliMsgIdUndo, MSG.cliMsgId);
    });

    it("still recalls, with 0, when the group's info cannot be read", async () => {
        const r = await runOffline(["msg", "undo", MSG.msgId, GROUP, "-t", "1", "--yes"], {
            responses: { "/api/group/getmg-v2": { __error: { code: 114, message: "offline refusal" } } },
        });
        const recalls = requestsTo(r.requests, "/api/group/undomsg");
        assert.equal(recalls.length, 1, r.all);
        assert.equal(recalls[0].params.visibility, 0);
    });
});
