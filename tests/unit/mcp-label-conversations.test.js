/**
 * `zalo_label` assign/unassign store each conversation the way a Zalo label names it (spec-actions 9): a group as
 * `g<groupId>`, a user by the bare id. Before, the caller's id went in as given, so a bare group id was filed under
 * the label as a user conversation and the label never showed on the group.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, upsertThread } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

const GROUP = "2000000000000000003";
const GROUP2 = "2000000000000000004";
const PEER = "1000000000000000002";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-label-"));
let handle;

before(() => {
    assertSandboxed(CONFIG_DIR);
    handle = initDb(join(ROOT, "zalo.db"));
    upsertThread({ threadId: GROUP, type: "group", name: "g", lastUpdate: 2 });
    upsertThread({ threadId: PEER, type: "dm", name: "u", lastUpdate: 1 });
});

after(() => {
    try {
        handle?.close();
    } catch {
        /* already closed */
    }
    rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A server with `zalo_label` registered over a label store, and the lists `updateLabels` was asked to write.
 *
 * @param {string[]} conversations - label 1's conversations before the call
 */
function labelServer(conversations = []) {
    let store = { version: 5, labelData: [{ id: 1, text: "Work", textKey: "work", conversations }] };
    const writes = [];
    const tools = new Map();
    const api = {
        getLabels: async () => structuredClone(store),
        updateLabels: async ({ labelData, version }) => {
            writes.push(structuredClone(labelData));
            store = { version: version + 1, labelData: structuredClone(labelData) };
            return structuredClone(store);
        },
    };
    const buffer = { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], getThreadType: () => null };
    const server = { registerTool: (name, _meta, handler) => tools.set(name, handler) };
    registerTools(server, api, buffer, { isWatched: () => true }, { limits: {} }, { ready: true, get: () => null });
    const call = async (args) => JSON.parse((await tools.get("zalo_label")(args)).content[0].text);
    return { call, writes };
}

describe("zalo_label: conversation ids in Zalo's form", () => {
    it("assign: a group known to the cache is stored as g<id>, a user as the bare id", async () => {
        const { call, writes } = labelServer();
        const r = await call({ action: "assign", labelId: 1, threadIds: [GROUP, PEER] });
        assert.equal(r.success, true, JSON.stringify(r));
        // Red if the bare group id went in (the bug): it would read as a user conversation.
        assert.deepEqual(writes[0][0].conversations, [`g${GROUP}`, PEER]);
        assert.deepEqual(r.conversations, [`g${GROUP}`, PEER]);
    });

    it("assign: threadType 'group' prefixes an id the cache does not know; a g<id> given is kept", async () => {
        const { call, writes } = labelServer();
        await call({ action: "assign", labelId: 1, threadId: GROUP2, threadType: "group" });
        await call({ action: "assign", labelId: 1, threadId: `g${GROUP}` });
        assert.deepEqual(writes[1][0].conversations, [`g${GROUP2}`, `g${GROUP}`]);
    });

    it("assign: an explicit threadType 'dm' wins over the cache", async () => {
        const { call, writes } = labelServer();
        await call({ action: "assign", labelId: 1, threadId: GROUP, threadType: "dm" });
        assert.deepEqual(writes[0][0].conversations, [GROUP]);
    });

    it("unassign: removes the group's g<id>, and a bare group id an earlier version stored", async () => {
        const { call, writes } = labelServer([`g${GROUP}`, GROUP, PEER]);
        const r = await call({ action: "unassign", labelId: 1, threadId: GROUP });
        assert.equal(r.success, true, JSON.stringify(r));
        // Red if unassign compared the bare id only (g<id> stays) or the prefixed one only (the bare leftover stays).
        assert.deepEqual(writes[0][0].conversations, [PEER]);
    });
});

describe("zalo_label update: removing a label is asked about first", () => {
    it("an update that leaves a label out is refused without confirm, previewed with dryRun, done with confirm", async () => {
        const { call, writes } = labelServer();
        const refused = await call({ action: "update", labelData: [], version: 5 });
        // Red if the guard is skipped: the label list would be written empty.
        assert.equal(refused.confirmationRequired, true);
        assert.match(refused.wouldDo, /remove 1 label \(1 \(Work\)\)/);
        const preview = await call({ action: "update", labelData: [], version: 5, dryRun: true });
        assert.equal(preview.dryRun, true);
        assert.deepEqual(writes, [], "nothing is written unconfirmed or in a dry run");
        assert.equal((await call({ action: "update", labelData: [], version: 5, confirm: true })).success, true);
        assert.deepEqual(writes, [[]]);
    });

    it("an update that keeps every label goes ahead without confirm", async () => {
        const { call, writes } = labelServer();
        const r = await call({ action: "update", labelData: [{ id: 1, text: "Renamed" }], version: 5 });
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(writes.length, 1);
    });
});
