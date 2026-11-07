/**
 * Hidden chats on every MCP path that hands out conversations or messages (src/mcp/mcp-tools.js), under each
 * hiddenChats policy, and the PIN flow of zalo_conversation's hidden-chat actions over the stateless HTTP transport.
 *
 * Red if a hidden thread appears anywhere under `exclude`; if a `contentless` event carries its thread id or text; if
 * `include` drops it; if the PIN hash or the PIN reaches any reply; or if a ticket unlocks more than one call.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { hiddenChatsFor, resetHiddenChatsRegistry } from "../../src/core/hidden-chats.js";
import { SecurePage, setSecurePage } from "../../src/core/secure-page.js";

const OWN = "1000000000000000001";
const HIDDEN = "1000000000000000002";
const VISIBLE = "1000000000000000004";
const PIN = "4826";
const RAW = { pin: createHash("md5").update(PIN).digest("hex"), threads: [{ thread_id: HIDDEN, is_group: 0 }] };
const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-hidden-"));

let db;
let page;
before(async () => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    db = initDb(join(ROOT, "zalo.sqlite"));
    for (const [id, name, ts] of [
        [HIDDEN, "Secret friend", 2],
        [VISIBLE, "Open friend", 1],
    ]) {
        upsertThread({ threadId: id, type: "dm", name, lastUpdate: ts });
        insertMessage({
            msgId: `${id.slice(-1)}001`,
            threadId: id,
            senderId: id,
            senderName: name,
            text: `meeting notes from ${name}`,
            timestamp: 1_750_000_000_000 + ts,
            type: "text",
            raw_data: "{}",
        });
    }
    page = new SecurePage({ accountId: OWN });
    await page.ensureServed();
    setSecurePage(page);
});
after(async () => {
    setSecurePage(null);
    await page.close();
    try {
        db?.close();
    } catch {
        /* already closed */
    }
    rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
    resetHiddenChatsRegistry();
    rmSync(join(ROOT, "hidden-threads.json"), { force: true });
    hiddenChatsFor(OWN, { stateDir: ROOT }).setFromServer(RAW);
});

/** A buffer holding one message in each conversation. */
function buffer() {
    const messages = [HIDDEN, VISIBLE].map((threadId, i) => ({
        msgId: `${i + 1}`,
        threadId,
        senderId: threadId,
        text: `hello from ${threadId}`,
        type: "text",
        timestamp: 1,
        _cursor: i + 1,
    }));
    return {
        read: () => ({ messages: messages.map((m) => ({ ...m })), cursor: 2, hasMore: false }),
        getStats: () => messages.map((m) => ({ threadId: m.threadId, unread: 1 })),
        getThreadType: () => "dm",
        readCursor: () => 0,
        markRead: () => 0,
        waitForMessages: async () => ({ messages: messages.map((m) => ({ ...m })), hasMore: false }),
        _globalCursor: 2,
    };
}

function tools({ config = {}, stateless = true } = {}) {
    const map = new Map();
    const calls = [];
    const api = new Proxy(
        { getOwnId: () => OWN, getContext: () => ({ uid: OWN }) },
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop !== "string" || prop === "then" || prop === "listener") return undefined;
                return async () => {
                    calls.push(prop);
                    if (prop === "getHiddenConversations") return RAW;
                    return {};
                };
            },
        },
    );
    const nameCache = {
        ready: true,
        get: (id) => ({ name: id === HIDDEN ? "Secret friend" : "Open friend", type: "dm" }),
        search: () => [
            { threadId: HIDDEN, name: "Secret friend", type: "dm" },
            { threadId: VISIBLE, name: "Open friend", type: "dm" },
        ],
    };
    registerTools(
        { registerTool: (n, meta, h) => map.set(n, { meta, h }), ...(stateless && { statelessHttp: true }) },
        api,
        buffer(),
        { isWatched: () => true },
        { limits: { maxMessagesPerPoll: 20 }, ...config },
        nameCache,
        ROOT,
    );
    const call = async (name, args = {}) => {
        const { meta, h } = map.get(name);
        const res = await h(meta.inputSchema.parse(args), {});
        return { res, isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
    };
    return { call, calls };
}

const POLICIES = ["exclude", "contentless", "include"];

describe("every MCP path, by hiddenChats policy", () => {
    for (const hiddenChats of POLICIES) {
        const shows = hiddenChats === "include";
        it(`${hiddenChats}: lists, search, history`, async () => {
            const t = tools({ config: { hiddenChats } });
            const checks = [
                ["zalo_list_conversations", {}],
                ["zalo_list_threads", {}],
                ["zalo_search_threads", { query: "friend" }],
                ["zalo_search_messages", { query: "meeting" }],
            ];
            for (const [tool, args] of checks) {
                const r = await t.call(tool, args);
                assert.equal(r.isError, false, `${tool}: ${r.text}`);
                assert.equal(r.text.includes(HIDDEN), shows, `${tool} under ${hiddenChats}`);
                assert.equal(r.text.includes(VISIBLE), true, `${tool} still lists the others`);
            }
            for (const [tool, args] of [
                ["zalo_get_history", { threadId: HIDDEN }],
                ["zalo_get_messages", { threadId: HIDDEN }],
                ["zalo_read", { name: "last-seen", args: { oneone: [HIDDEN] } }],
            ]) {
                const r = await t.call(tool, args);
                // Under include the call goes on to Zalo (which this stand-in session may not answer); otherwise
                // it is refused before anything is asked.
                if (shows) assert.doesNotMatch(r.text, /hidden chats/, `${tool} under include`);
                else {
                    assert.equal(r.isError, true, `${tool} on a hidden thread under ${hiddenChats}: ${r.text}`);
                    assert.match(r.text, /hidden chats/);
                }
            }
        });

        it(`${hiddenChats}: the live buffer (get_messages, wait_for_message)`, async () => {
            const t = tools({ config: { hiddenChats } });
            for (const tool of ["zalo_get_messages", "zalo_wait_for_message"]) {
                const r = await t.call(tool, tool === "zalo_wait_for_message" ? { limit: 10 } : {});
                const body = JSON.parse(r.res.content[0].text);
                const list = body.messages;
                assert.equal(r.text.includes(HIDDEN), shows, `${tool} under ${hiddenChats}`);
                assert.equal(r.text.includes(`hello from ${HIDDEN}`), shows, "no content of a hidden chat");
                const dots = list.filter((m) => m.hidden === true);
                if (hiddenChats === "contentless") {
                    assert.equal(dots.length, 1);
                    assert.deepEqual(Object.keys(dots[0]).sort(), ["_cursor", "event", "hidden"]);
                    assert.equal(dots[0].event, "message");
                } else {
                    assert.equal(dots.length, 0);
                }
                assert.ok(list.some((m) => m.threadId === VISIBLE));
            }
        });
    }
});

describe("zalo_conversation's hidden-chat actions over stateless HTTP", () => {
    const submit = (url, fields) =>
        fetch(url, {
            method: "POST",
            body: new URLSearchParams(fields).toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
        });

    it("hidden: count only, then a PIN page; its ticket lists the threads once; the hash never leaves", async () => {
        const t = tools();
        const first = await t.call("zalo_conversation", { action: "hidden" });
        assert.equal(first.isError, true, "a needs-PIN reply");
        const p = JSON.parse(first.res.content[0].text);
        assert.deepEqual([p.pinRequired, p.count, p.hasPin], [true, 1, true]);
        assert.ok(p.secureUrl && p.retryWith.ticket);
        assert.equal(first.text.includes(HIDDEN), false, "no thread before the PIN");

        await submit(p.secureUrl, { pin: "0000", decision: "approve" });
        const early = await t.call("zalo_conversation", { action: "hidden", ticket: p.retryWith.ticket });
        assert.equal(early.isError, true, "a wrong PIN on the page unlocks nothing");

        await submit(p.secureUrl, { pin: PIN, decision: "approve" });
        const listed = await t.call("zalo_conversation", { action: "hidden", ticket: p.retryWith.ticket });
        assert.equal(listed.isError, false, listed.text);
        const body = JSON.parse(listed.text);
        assert.deepEqual(body.threads, [{ threadId: HIDDEN, threadType: "dm", name: "Secret friend" }]);
        for (const r of [first, early, listed]) {
            assert.equal(r.text.includes(RAW.pin), false, "the PIN hash never reaches a reply");
            assert.equal(r.text.includes(PIN), false, "nor the PIN");
        }
        const again = await t.call("zalo_conversation", { action: "hidden", ticket: p.retryWith.ticket });
        assert.equal(again.isError, true, "a ticket works once");
    });

    it("unhide: the ticket is bound to the threads it was issued for", async () => {
        const t = tools({ config: { confirmMode: "off" } });
        const first = await t.call("zalo_conversation", { action: "unhide", threadIds: [HIDDEN] });
        const p = JSON.parse(first.res.content[0].text);
        assert.equal(p.pinRequired, true);
        await submit(p.secureUrl, { pin: PIN, decision: "approve" });
        const other = await t.call("zalo_conversation", {
            action: "unhide",
            threadIds: [VISIBLE],
            ticket: p.retryWith.ticket,
        });
        assert.equal(other.isError, true);
        assert.equal(t.calls.includes("setHiddenConversations"), false);
        const done = await t.call("zalo_conversation", {
            action: "unhide",
            threadIds: [HIDDEN],
            ticket: p.retryWith.ticket,
        });
        assert.equal(done.isError, false, done.text);
        assert.equal(t.calls.includes("setHiddenConversations"), true);
    });

    it("hidden_pin: the page changes the PIN itself; the ticket only reports it", async () => {
        const t = tools();
        const first = await t.call("zalo_conversation", { action: "hidden_pin" });
        const p = JSON.parse(first.res.content[0].text);
        const html = await (await fetch(p.secureUrl)).text();
        assert.match(html, /Current PIN/);
        await submit(p.secureUrl, { pin: PIN, newPin: "1593", newPin2: "1593", decision: "approve" });
        assert.equal(t.calls.includes("updateHiddenConversPin"), true, "sent when the owner submitted");
        const r = await t.call("zalo_conversation", { action: "hidden_pin", ticket: p.retryWith.ticket });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual(JSON.parse(r.text), { action: "hidden_pin", success: true, changed: true, hadPin: true });
    });

    it("pin and newPin inputs are refused unless allowPinArgument", async () => {
        const off = await tools().call("zalo_conversation", { action: "hidden", pin: PIN });
        assert.equal(off.isError, true);
        assert.match(off.text, /allowPinArgument/);
        const on = await tools({ config: { allowPinArgument: true } }).call("zalo_conversation", {
            action: "hidden",
            pin: PIN,
        });
        assert.equal(on.isError, false, on.text);
        assert.equal(JSON.parse(on.text).count, 1);
    });
});
