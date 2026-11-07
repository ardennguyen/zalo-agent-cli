/**
 * The MCP action tools (src/mcp/action-tool.js, src/mcp/actions-*.js): zalo_conversation, zalo_profile,
 * zalo_auto_reply, zalo_quick_message, zalo_catalog, zalo_bank, zalo_cloud, zalo_sticker, zalo_link, and the actions
 * zalo_friend and zalo_group gained with them.
 *
 * Every action is driven through the real registered tool, its input parsed by the tool's own schema as the MCP SDK
 * parses it, against a fake session that records each call. What is asserted for each action:
 * - a happy path reaches the session call its CLI command makes (or Zalo's transport, for the actions built on it);
 * - a call missing what the action needs, or carrying an input the tool does not take, is refused and calls nothing;
 * - an action Zalo Web asks about first is refused without `confirm` (agent mode), previews with `dryRun`, and acts
 *   with `confirm`, as the guard's GUARDS table says.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, insertMessage, upsertCloudItem, upsertThread } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { sealSession } from "../../src/zalo/kernel/cipher.js";
import { GUARDS } from "../../src/core/confirm-guard.js";
import { CONVERSATION_ACTIONS } from "../../src/mcp/actions-conversation.js";
import { PROFILE_ACTIONS } from "../../src/mcp/actions-profile.js";
import {
    AUTO_REPLY_ACTIONS,
    BANK_ACTIONS,
    CATALOG_ACTIONS,
    QUICK_MESSAGE_ACTIONS,
} from "../../src/mcp/actions-business.js";
import { CLOUD_ACTIONS, LINK_ACTIONS, STICKER_ACTIONS } from "../../src/mcp/actions-media.js";
import { FRIEND_EXTRA_ACTIONS, GROUP_EXTRA_ACTIONS } from "../../src/mcp/actions-social.js";
import { resetHiddenChatsRegistry } from "../../src/core/hidden-chats.js";
import { SecurePage, setSecurePage } from "../../src/core/secure-page.js";
import { createMcpStageRunners } from "../../src/mcp/sync-stages.js";
import { GROUP_SETTING_FIELDS } from "../../src/zalo/custom/group-settings.js";

const OWN = "100";
/** Zalo's get-all answer for an account whose hidden-chat PIN is 1234 (the hash is md5 of the PIN; a test value). */
const HIDDEN_WITH_PIN = { getHiddenConversations: { pin: "81dc9bdb52d04dc20036dbd8313ed055", threads: [] } };
/** A deployment that takes the PIN as an input (allowPinArgument), for the rows that need one. */
const PIN_INPUT = { allowPinArgument: true };
const PEER = "777";
const GROUP = "555";
const KEY = Buffer.alloc(16, 0x22).toString("base64");
const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-actions-"));
const IMAGE = join(ROOT, "photo.png");

let db;
before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    writeFileSync(IMAGE, "not really a png");
    db = initDb(join(ROOT, "zalo.sqlite"));
    // One incoming message the listener cached, for 'read' to anchor its seen receipt on.
    upsertThread({ threadId: "779", type: "dm", name: "Lan", lastUpdate: 1 });
    insertMessage({
        msgId: "9001",
        threadId: "779",
        senderId: "779",
        senderName: "Lan",
        text: "hi",
        timestamp: 1_750_000_000_000,
        type: "text",
        raw_data: JSON.stringify({ cliMsgId: "8001", msgType: "webchat" }),
    });
});
after(() => {
    try {
        db?.close();
    } catch {
        /* already closed */
    }
    rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A fake session. A method call is recorded in `calls` and answered from `answers` (a value, an Error to throw, or a
 * function of the arguments). The actions built on Zalo's transport (pin, archive, the seen receipt, group settings,
 * invite info) reach `polyfill`, recorded in `http`.
 */
function fakeApi(answers = {}) {
    const calls = [];
    const http = [];
    const ctx = {
        secretKey: KEY,
        imei: "test-imei-0000",
        uid: OWN,
        userAgent: "offline-test",
        language: "vi",
        API_VERSION: 694,
        API_TYPE: 30,
        options: {
            logging: false,
            async polyfill(url, init = {}) {
                http.push({ url: String(url), method: init.method || "GET" });
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: async () => ({
                        error_code: 0,
                        data: sealSession(KEY, JSON.stringify({ error_code: 0, data: { ok: 1 } })),
                    }),
                };
            },
        },
    };
    const host = (name) => [`https://${name}.test.invalid`];
    const base = {
        getOwnId: () => OWN,
        getContext: () => ctx,
        zpwServiceMap: {
            conversation: host("conv"),
            label: host("label"),
            chat: host("chat"),
            group: host("group"),
            group_cloud_message: host("gcm"),
        },
    };
    const api = new Proxy(base, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop !== "string" || prop === "then" || prop === "listener") return undefined;
            return async (...args) => {
                calls.push({ method: prop, args });
                const a = answers[prop];
                if (a instanceof Error) throw a;
                return typeof a === "function" ? a(...args) : (a ?? {});
            };
        },
    });
    return { api, calls, http };
}

/** The real tools on a stand-in McpServer; `call` parses the input with the tool's schema first, as the SDK does. */
function tools({ api, config = {}, stateless = false, elicit } = {}) {
    const map = new Map();
    const server = {
        registerTool: (name, meta, handler) => map.set(name, { meta, handler }),
        ...(stateless && { statelessHttp: true }),
        ...(elicit && { server: elicit }),
    };
    registerTools(
        server,
        api,
        { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], markRead: () => 0, readCursor: () => 0 },
        { isWatched: () => true },
        { limits: { maxMessagesPerPoll: 20 }, ...config },
        { ready: true, get: () => null, search: () => [] },
        ROOT,
    );
    const call = async (name, args) => {
        const { meta, handler } = map.get(name);
        const res = await handler(meta.inputSchema.parse(args), {});
        const text = res.content[0].text;
        return { res, isError: res.isError === true, body: res.isError ? null : JSON.parse(text), text };
    };
    return { map, call };
}

/** What each tool's happy path sends, and the session method (or "http") that proves it reached Zalo. */
const HAPPY = {
    zalo_conversation: [
        ["pinned", {}, "getPinConversations", { getPinConversations: { conversations: [`g${GROUP}`, "m1"] } }],
        ["pin", { threadId: GROUP, threadType: "group" }, "http"],
        ["unpin", { threadId: PEER }, "http"],
        ["archived", {}, "getArchivedChatList"],
        ["archive", { threadId: PEER }, "http", { getArchivedChatList: { version: 3 } }],
        ["unarchive", { threadId: GROUP, threadType: "group" }, "http", { getArchivedChatList: { version: 3 } }],
        ["muted", {}, "getMute", { getMute: { chatEntries: [{ id: PEER, muteMode: 1, duration: -1 }] } }],
        ["mute", { threadId: PEER, durationSeconds: 3600 }, "setMute"],
        ["unmute", { threadId: PEER }, "setMute"],
        ["read", { threadId: "779" }, "removeUnreadMark"],
        ["seen", { threadId: "779" }, "http"],
        ["block_sharing", { threadId: PEER, enabled: true }, "http"],
        ["unread", { threadId: PEER }, "addUnreadMark"],
        ["hidden", {}, "getHiddenConversations"],
        ["hide", { threadIds: [PEER, "778"] }, "setHiddenConversations", HIDDEN_WITH_PIN],
        [
            "unhide",
            { threadIds: [PEER], confirm: true, pin: "1234" },
            "setHiddenConversations",
            HIDDEN_WITH_PIN,
            PIN_INPUT,
        ],
        ["hidden_pin", { pin: "1234", newPin: "4321" }, "updateHiddenConversPin", HIDDEN_WITH_PIN, PIN_INPUT],
        ["hidden_pin_reset", { confirm: true }, "resetHiddenConversPin"],
        ["auto_delete_status", {}, "getAutoDeleteChat"],
        ["auto_delete", { threadId: PEER, ttl: "7d" }, "updateAutoDeleteChat"],
        ["delete", { threadId: PEER, senderId: PEER, cliMsgId: "11", msgId: "12", confirm: true }, "deleteChat"],
        ["forget", { threadId: "4242", confirm: true }, null],
        ["typing", { threadId: GROUP, threadType: "group" }, "sendTypingEvent"],
        ["report", { threadId: PEER, reason: "fraud" }, "sendReport", { sendReport: { reportId: 9 } }],
    ],
    zalo_profile: [
        ["avatar", { filePath: IMAGE }, "changeAccountAvatar"],
        ["bio", {}, "fetchAccountInfo", { fetchAccountInfo: { profile: { status: "hi" } } }],
        ["update", { name: "Lan" }, "updateProfile", { fetchAccountInfo: { profile: { sdob: "01/02/2000" } } }],
        ["settings", {}, "getSettings", { getSettings: { show_online_status: true } }],
        ["set", { setting: "online-status", value: 0 }, "updateSettings"],
        ["avatars", {}, "getAvatarList"],
        ["full_avatar", { userId: PEER }, "getFullAvatar"],
        ["avatar_url", { userIds: [PEER] }, "getAvatarUrlProfile"],
        ["delete_avatar", { photoIds: ["p1"], confirm: true }, "deleteAvatar"],
        ["reuse_avatar", { photoId: "p1" }, "reuseAvatar"],
        ["active", { enabled: false }, "updateActiveStatus"],
        ["lang", { language: "en" }, "updateLang"],
        ["devices", {}, "getListDevice"],
        ["usage", {}, null],
    ],
    zalo_auto_reply: [
        ["list", {}, "getAutoReplyList"],
        ["create", { content: "Away" }, "createAutoReply"],
        ["update", { autoReplyId: "5", content: "Back" }, "updateAutoReply"],
        ["delete", { autoReplyId: "5", confirm: true }, "deleteAutoReply"],
    ],
    zalo_quick_message: [
        ["list", {}, "getQuickMessageList"],
        ["add", { keyword: "hi", title: "Xin chào" }, "addQuickMessage"],
        ["update", { quickMessageId: "3", keyword: "hi", title: "Chào" }, "updateQuickMessage"],
        ["remove", { quickMessageIds: ["3"], confirm: true }, "removeQuickMessage"],
        ["enable", {}, "updateSettings"],
        ["disable", {}, "updateSettings"],
    ],
    zalo_catalog: [
        ["list", {}, "getCatalogList"],
        ["create", { name: "Áo" }, "createCatalog"],
        ["rename", { catalogId: "c1", name: "Quần" }, "updateCatalog"],
        ["delete", { catalogId: "c1", confirm: true }, "deleteCatalog"],
        ["products", { catalogId: "c1" }, "getProductCatalogList"],
        ["product", { productId: "p1" }, "getProductInfo"],
        [
            "add_product",
            { catalogId: "c1", name: "Áo", price: "150000", description: "Cotton" },
            "createProductCatalog",
        ],
        [
            "update_product",
            { catalogId: "c1", productId: "p1", name: "Áo", price: "1", description: "x" },
            "updateProductCatalog",
        ],
        ["delete_product", { catalogId: "c1", productIds: ["p1"], confirm: true }, "deleteProductCatalog"],
        ["upload_photo", { filePath: IMAGE }, "uploadProductPhoto"],
        ["register", { enabled: true }, "registerCatalog"],
    ],
    zalo_bank: [
        [
            "banks",
            { query: "vietcom" },
            "getListBank",
            { getListBank: { banks: [{ bin: 970436, short_name: "VCB", name: "Vietcombank" }] } },
        ],
        ["accounts", {}, "getListBankAccount"],
        ["add", { bank: "vcb", accountNumber: "0123456789", holderName: "A" }, "createBankAccount"],
        ["update", { bankAccountId: "11", bank: "vcb", accountNumber: "1", holderName: "A" }, "updateBankAccount"],
        [
            "remove",
            { bankAccountId: "11", confirm: true },
            "deleteBankAccount",
            { getListBankAccount: { myBanks: [{ account_id: 11, default: true }] } },
        ],
    ],
    zalo_cloud: [
        ["summary", {}, null],
        ["plan", { includeGroups: true }, null],
        ["apply", { threadIds: ["4444"], confirm: true }, null],
    ],
    zalo_sticker: [
        ["search", { keyword: "mèo" }, "getStickers", { getStickers: [1, 2] }],
        ["detail", { stickerIds: ["1"] }, "getStickersDetail"],
    ],
    zalo_link: [
        ["preview", { url: "https://example.com/a" }, "parseLink", { parseLink: { data: { title: "T" } } }],
        ["scan", { url: "https://example.com/a" }, "scanURL", { scanURL: { isSafe: true } }],
    ],
    zalo_friend: [
        ["online", {}, "getFriendOnlines"],
        ["remove", { userId: PEER, confirm: true }, "removeFriend"],
        ["block", { userId: PEER, confirm: true }, "blockUser"],
        ["unblock", { userId: PEER }, "unblockUser"],
        ["last_online", { userId: PEER }, "lastOnline"],
        ["close", {}, "getCloseFriends", { getCloseFriends: [{ userId: PEER, displayName: "Lan" }] }],
        ["find_phones", { phones: ["0901234567"] }, "getMultiUsersByPhones"],
        ["qr", { userIds: [PEER] }, "getQR", { getQR: { [PEER]: "https://qr.test.invalid/1" } }],
        ["common_groups", { userIds: [PEER] }, "getRelatedFriendGroup"],
        ["biz", { userId: PEER }, "getBizAccount"],
        ["block_feed", { userId: PEER }, "blockViewFeed"],
    ],
    zalo_group: [
        ["avatar", { groupId: GROUP, filePath: IMAGE }, "changeGroupAvatar"],
        ["add_admin", { groupId: GROUP, userIds: [PEER] }, "addGroupDeputy"],
        ["remove_admin", { groupId: GROUP, userIds: [PEER], confirm: true }, "removeGroupDeputy"],
        ["transfer_owner", { groupId: GROUP, userId: PEER, confirm: true }, "changeGroupOwner"],
        ["block_member", { groupId: GROUP, userIds: [PEER], confirm: true }, "addGroupBlockedMember"],
        ["unblock_member", { groupId: GROUP, userIds: [PEER] }, "removeGroupBlockedMember"],
        ["blocked", { groupId: GROUP }, "getGroupBlockedMember"],
        ["upgrade_community", { groupId: GROUP }, "upgradeGroupToCommunity"],
        ["settings", { groupId: GROUP, settings: { lockCreatePoll: true } }, "http", { getGroupInfo: groupSetting }],
        ["disperse", { groupId: GROUP, confirm: true }, "disperseGroup"],
        ["pending", { groupId: GROUP }, "getPendingGroupMembers"],
        ["approve", { groupId: GROUP, userIds: [PEER] }, "reviewPendingMemberRequest"],
        ["reject_member", { groupId: GROUP, userIds: [PEER] }, "reviewPendingMemberRequest"],
        ["enable_link", { groupId: GROUP }, "enableGroupLink"],
        ["disable_link", { groupId: GROUP, confirm: true }, "disableGroupLink"],
        ["link_info", { groupId: GROUP }, "getGroupLinkDetail"],
        ["link_preview", { link: "https://zalo.me/g/abc" }, "getGroupLinkInfo"],
        ["join", { link: "https://zalo.me/g/abc" }, "joinGroupLink"],
        ["invite_boxes", {}, "getGroupInviteBoxList"],
        ["invite_info", { groupId: GROUP }, "http"],
        ["join_invite", { groupId: GROUP }, "joinGroupInviteBox"],
        ["delete_invite", { groupIds: [GROUP] }, "deleteGroupInviteBox"],
        ["invite_to", { userId: PEER, groupIds: [GROUP] }, "inviteUserToGroups"],
        ["members_info", { userIds: [PEER] }, "getGroupMembersInfo"],
    ],
};

/** A group's settings as getGroupInfo returns them: every field Zalo stores, all off. */
function groupSetting() {
    const setting = Object.fromEntries(GROUP_SETTING_FIELDS.map((k) => [k, 0]));
    return { gridInfoMap: { [GROUP]: { setting: { ...setting, joinAppr: 1 } } } };
}

/** Each tool's action table: the parity between the table and the HAPPY rows above is checked first. */
const TABLES = {
    zalo_conversation: CONVERSATION_ACTIONS,
    zalo_profile: PROFILE_ACTIONS,
    zalo_auto_reply: AUTO_REPLY_ACTIONS,
    zalo_quick_message: QUICK_MESSAGE_ACTIONS,
    zalo_catalog: CATALOG_ACTIONS,
    zalo_bank: BANK_ACTIONS,
    zalo_cloud: CLOUD_ACTIONS,
    zalo_sticker: STICKER_ACTIONS,
    zalo_link: LINK_ACTIONS,
    zalo_friend: FRIEND_EXTRA_ACTIONS,
    zalo_group: GROUP_EXTRA_ACTIONS,
};

describe("action tools: the tests cover every action", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    for (const [tool, table] of Object.entries(TABLES)) {
        it(`${tool}: a happy path for each of its actions`, () => {
            const covered = new Set(HAPPY[tool].map(([action]) => action));
            assert.deepEqual(
                Object.keys(table).filter((a) => !covered.has(a)),
                [],
                "an action without a happy path here",
            );
        });
    }

    it("every guarded row names a GUARDS key whose MCP name is this tool's action", () => {
        for (const [tool, table] of Object.entries(TABLES)) {
            for (const [action, def] of Object.entries(table)) {
                if (!def.guard) continue;
                const { key } = def.guard({ settings: {}, threadIds: [], userIds: [], photoIds: [] });
                assert.equal(GUARDS[key]?.mcp, `${tool} ${action}`, `${tool} ${action} -> ${key}`);
            }
        }
    });
});

for (const [tool, rows] of Object.entries(HAPPY)) {
    describe(`${tool}: happy paths`, () => {
        for (const [action, args, expect, answers, config] of rows) {
            it(`${action} reaches ${expect ?? "the local cache only"}`, async () => {
                // A hide must not leave its threads hidden for the tests after it.
                resetHiddenChatsRegistry();
                rmSync(join(ROOT, "hidden-threads.json"), { force: true });
                const fa = fakeApi(answers);
                const r = await tools({ api: fa.api, config }).call(tool, { action, ...args });
                assert.equal(r.isError, false, r.text);
                assert.equal(r.body.action, action);
                if (expect === "http") assert.ok(fa.http.length > 0, "a request reached the transport");
                else if (expect)
                    assert.ok(
                        fa.calls.some((c) => c.method === expect),
                        `${expect} was called`,
                    );
                else assert.deepEqual([fa.calls, fa.http], [[], []], "Zalo is not contacted");
                for (const banned of ["id", "uid", "messageId", "type"]) {
                    assert.equal(banned in r.body, false, `the reply carries no \`${banned}\``);
                }
            });
        }
    });

    describe(`${tool}: refusals`, () => {
        for (const [action] of rows) {
            const def = TABLES[tool][action];
            it(`${action}: refused without what it needs, or with an input the tool does not take`, async () => {
                const fa = fakeApi();
                const t = tools({ api: fa.api });
                if (def.needs?.length) {
                    const r = await t.call(tool, { action });
                    assert.equal(r.isError, true);
                    assert.match(r.text, /is required for action=/);
                } else {
                    const parsed = t.map.get(tool).meta.inputSchema.safeParse({ action, notAnInput: 1 });
                    assert.equal(parsed.success, false, "an unknown key is refused");
                }
                assert.deepEqual([fa.calls, fa.http], [[], []]);
            });
        }
    });
}

/** Every guarded row: its happy args without `confirm`. */
const GUARDED = Object.entries(HAPPY).flatMap(([tool, rows]) =>
    rows
        // The guarded case only: 'settings' is asked about only when it turns join approval off (tested below).
        .filter(([action, args]) => TABLES[tool][action].guard && TABLES[tool][action].guard(args).applies !== false)
        .map(([action, args, , answers, config]) => {
            const rest = { ...args };
            delete rest.confirm;
            return [tool, action, rest, answers, config];
        }),
);

describe("guarded actions", () => {
    it("cover every GUARDS entry these action tables serve (settings has its own test below)", () => {
        const tested = new Set([...GUARDED.map(([t, a]) => `${t} ${a}`), "zalo_group settings"]);
        const served = Object.entries(TABLES).flatMap(([tool, table]) =>
            Object.keys(table).map((action) => `${tool} ${action}`),
        );
        const want = Object.values(GUARDS)
            .map((g) => g.mcp)
            .filter((m) => served.includes(m));
        assert.deepEqual([...tested].sort(), want.sort());
        assert.equal(want.length, 19);
    });

    for (const [tool, action, args, answers, config] of GUARDED) {
        it(`${tool} ${action}: refused unconfirmed, previewed with dryRun, done with confirm`, async () => {
            let fa = fakeApi(answers);
            const refused = await tools({ api: fa.api }).call(tool, { action, ...args });
            assert.equal(refused.isError, true);
            assert.equal(JSON.parse(refused.text).confirmationRequired, true);
            assert.equal(JSON.parse(refused.text).action, `${tool} ${action}`);
            assert.deepEqual([fa.calls, fa.http], [[], []], "nothing is sent unconfirmed");

            fa = fakeApi(answers);
            const dry = await tools({ api: fa.api }).call(tool, { action, ...args, dryRun: true });
            assert.equal(dry.isError, false);
            assert.equal(dry.body.dryRun, true);
            assert.equal(dry.body.sent, false);
            assert.deepEqual([fa.calls, fa.http], [[], []], "a dry run sends nothing");

            fa = fakeApi(answers);
            const done = await tools({ api: fa.api, config }).call(tool, { action, ...args, confirm: true });
            assert.equal(done.isError, false, done.text);
            assert.equal(done.body.action, action);
        });
    }

    it("group settings asks only when it turns join approval off", async () => {
        const fa = fakeApi({ getGroupInfo: groupSetting });
        const off = await tools({ api: fa.api }).call("zalo_group", {
            action: "settings",
            groupId: GROUP,
            settings: { joinAppr: false },
        });
        assert.equal(off.isError, true);
        assert.match(JSON.parse(off.text).wouldDo, /turn off membership approval/);
        assert.deepEqual(fa.http, []);
        const on = await tools({ api: fa.api }).call("zalo_group", {
            action: "settings",
            groupId: GROUP,
            settings: { lockCreatePoll: true },
        });
        assert.equal(on.isError, false, on.text);
    });

    it("forget's dry run lists what would go, as `conv forget --dry-run` does", async () => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api }).call("zalo_conversation", {
            action: "forget",
            threadId: "4242",
            dryRun: true,
        });
        assert.equal(r.body.dryRun, true);
        assert.deepEqual(r.body.conversations, [{ threadId: "4242" }]);
    });

    it("dryRun on an action that is not asked about is refused, not ignored", async () => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api }).call("zalo_group", {
            action: "add_admin",
            groupId: GROUP,
            userIds: [PEER],
            dryRun: true,
        });
        assert.equal(r.isError, true);
        assert.match(r.text, /dryRun previews only/);
        assert.deepEqual(fa.calls, [], "the admin was not added");
    });

    it("confirmMode off: a guarded action goes ahead without confirm", async () => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api, config: { confirmMode: "off" } }).call("zalo_friend", {
            action: "remove",
            userId: PEER,
        });
        assert.equal(r.isError, false, r.text);
        assert.ok(fa.calls.some((c) => c.method === "removeFriend"));
    });
});

describe("confirmMode human over the stateless HTTP transport", () => {
    let page;
    before(() => {
        // The page is mounted on an HTTP server in production; here only its tickets matter, so nothing listens.
        page = new SecurePage().configure({ accountId: OWN, localBaseUrl: "http://127.0.0.1:9" });
        setSecurePage(page);
    });
    after(() => setSecurePage(null));

    it("hands out a one-time approve page instead of asking, then acts on the approved ticket once", async () => {
        const asked = [];
        const elicit = {
            getClientCapabilities: () => ({ elicitation: { form: {}, url: {} } }),
            elicitInput: async (p) => {
                asked.push(p);
                return { action: "accept", content: { confirm: true } };
            },
        };
        const human = { confirmMode: "human" };
        const fa = fakeApi();
        const r = await tools({ api: fa.api, config: human, stateless: true, elicit }).call("zalo_friend", {
            action: "block",
            userId: PEER,
            confirm: true,
        });
        assert.equal(r.isError, true);
        const p = JSON.parse(r.text);
        assert.equal(p.confirmationRequired, true);
        assert.equal(p.statelessTransport, true);
        assert.match(p.secureUrl, /^http:\/\/127\.0\.0\.1:9\/zalo\/secure\/[A-Za-z0-9_-]{22}$/);
        assert.ok(Date.parse(p.ticketExpiresAt) > Date.now());
        assert.equal(p.secureUrl.endsWith(p.retryWith.ticket), true, "the ticket is the page's token");
        assert.deepEqual(asked, [], "no MCP question over a transport that cannot hear the answer");
        assert.deepEqual(fa.calls, []);

        // Before the owner answers, the ticket does not work.
        const early = await tools({ api: fa.api, config: human, stateless: true }).call("zalo_friend", {
            action: "block",
            userId: PEER,
            ticket: p.retryWith.ticket,
        });
        assert.equal(early.isError, true);
        assert.equal(JSON.parse(early.text).ticketRefused, "pending");
        assert.deepEqual(fa.calls, []);

        page.store.settle(page.store.lookup(p.retryWith.ticket).ticket, "approved");
        // A ticket approved for another target does not carry over.
        const other = await tools({ api: fa.api, config: human, stateless: true }).call("zalo_friend", {
            action: "block",
            userId: "778",
            ticket: p.retryWith.ticket,
        });
        assert.equal(JSON.parse(other.text).ticketRefused, "target");
        assert.deepEqual(fa.calls, []);
    });

    it("the approved ticket acts once; a second use is refused", async () => {
        const human = { confirmMode: "human" };
        const fa = fakeApi();
        const first = await tools({ api: fa.api, config: human, stateless: true }).call("zalo_friend", {
            action: "block",
            userId: PEER,
        });
        const ticket = JSON.parse(first.text).retryWith.ticket;
        page.store.settle(page.store.lookup(ticket).ticket, "approved");
        const done = await tools({ api: fa.api, config: human, stateless: true }).call("zalo_friend", {
            action: "block",
            userId: PEER,
            ticket,
        });
        assert.equal(done.isError, false, done.text);
        assert.ok(fa.calls.some((c) => c.method === "blockUser"));
        const again = await tools({ api: fakeApi().api, config: human, stateless: true }).call("zalo_friend", {
            action: "block",
            userId: PEER,
            ticket,
        });
        assert.equal(JSON.parse(again.text).ticketRefused, "used");
    });

    it("still asks over a stateful transport (stdio)", async () => {
        const asked = [];
        const elicit = {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            elicitInput: async (p) => {
                asked.push(p);
                return { action: "accept", content: { confirm: true } };
            },
        };
        const fa = fakeApi();
        const r = await tools({ api: fa.api, config: { confirmMode: "human" }, elicit }).call("zalo_friend", {
            action: "block",
            userId: PEER,
        });
        assert.equal(r.isError, false, r.text);
        assert.equal(asked.length, 1);
        assert.ok(fa.calls.some((c) => c.method === "blockUser"));
    });
});

describe("action tools: specific refusals", () => {
    const refusedWith = async (tool, args, re) => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api }).call(tool, args);
        assert.equal(r.isError, true, JSON.stringify(args));
        assert.match(r.text, re);
        assert.deepEqual([fa.calls, fa.http], [[], []]);
    };

    it("ids must be numeric", async () => {
        await refusedWith("zalo_friend", { action: "remove", userId: "bob", confirm: true }, /numeric/);
        await refusedWith("zalo_group", { action: "pending", groupId: "g555" }, /numeric/);
        await refusedWith("zalo_conversation", { action: "hide", threadIds: [PEER, "x"] }, /numeric/);
    });

    it("hide takes one thread type per call", async () => {
        upsertThread({ threadId: "556", type: "group", name: "G", lastUpdate: 1 });
        await refusedWith("zalo_conversation", { action: "hide", threadIds: [PEER, "556"] }, /mixes DMs and groups/);
    });

    it("hidden_pin is four digits; report's content goes only with reason other", async () => {
        await refusedWith("zalo_conversation", { action: "hidden_pin", newPin: "12a4" }, /4 digits/);
        // Without allowPinArgument a PIN input is refused, and nothing reaches Zalo past the hidden-list read.
        const fa = fakeApi(HIDDEN_WITH_PIN);
        const r = await tools({ api: fa.api }).call("zalo_conversation", {
            action: "unhide",
            threadIds: [PEER],
            confirm: true,
            pin: "1234",
        });
        assert.equal(r.isError, true);
        assert.match(r.text, /allowPinArgument/);
        assert.deepEqual(
            fa.calls.map((c) => c.method),
            ["getHiddenConversations"],
        );
        await refusedWith("zalo_conversation", { action: "report", threadId: PEER, reason: "other" }, /needs/);
        await refusedWith(
            "zalo_conversation",
            { action: "report", threadId: PEER, reason: "fraud", content: "x" },
            /only sent with/,
        );
    });

    it("delete takes all three anchor ids or none; forget takes threadId or orphans", async () => {
        await refusedWith(
            "zalo_conversation",
            { action: "delete", threadId: PEER, msgId: "1", confirm: true },
            /all three/,
        );
        await refusedWith("zalo_conversation", { action: "forget", confirm: true }, /threadId, or orphans/);
    });

    it("a missing local file, an unknown bank and an empty settings change are refused", async () => {
        await refusedWith("zalo_profile", { action: "avatar", filePath: join(ROOT, "nope.png") }, /File not found/);
        await refusedWith(
            "zalo_bank",
            { action: "add", bank: "nobank", accountNumber: "1", holderName: "A" },
            /Unknown/,
        );
        await refusedWith("zalo_group", { action: "settings", groupId: GROUP, settings: {} }, /nothing to change/);
        await refusedWith("zalo_profile", { action: "update" }, /at least one/);
    });

    it("a nested settings object takes only the known setting names", () => {
        const { map } = tools({ api: fakeApi().api });
        const schema = map.get("zalo_group").meta.inputSchema;
        assert.equal(
            schema.safeParse({ action: "settings", groupId: GROUP, settings: { lockEverything: true } }).success,
            false,
        );
    });
});

describe("action tools: what the replies say", () => {
    it("pinned skips Zalo's m1 entry; muted names each thread by threadId", async () => {
        const fa = fakeApi({
            getPinConversations: { conversations: [`g${GROUP}`, "m1"] },
            getMute: { chatEntries: [{ id: PEER, muteMode: 1, duration: -1 }], groupChatEntries: [{ id: GROUP }] },
        });
        const t = tools({ api: fa.api });
        assert.deepEqual((await t.call("zalo_conversation", { action: "pinned" })).body.conversations, [`g${GROUP}`]);
        const muted = (await t.call("zalo_conversation", { action: "muted" })).body.conversations;
        assert.deepEqual(
            muted.map((m) => [m.threadId, m.threadType]),
            [
                [PEER, "dm"],
                [GROUP, "group"],
            ],
        );
    });

    it("auto_delete sends the period in milliseconds; mute defaults to forever", async () => {
        const fa = fakeApi();
        const t = tools({ api: fa.api });
        await t.call("zalo_conversation", { action: "auto_delete", threadId: PEER, ttl: "7d" });
        await t.call("zalo_conversation", { action: "mute", threadId: PEER });
        assert.equal(fa.calls[0].args[0], 604800000);
        assert.equal(fa.calls[1].args[0].duration, -1);
    });

    it("devices never returns a companion's signed identity", async () => {
        const fa = fakeApi({
            getListDevice: {
                devices: { masterId: "m", companions: [{ id: 5, platform: 2, status: 1, encIdentity: "SECRET" }] },
            },
        });
        const r = await tools({ api: fa.api }).call("zalo_profile", { action: "devices" });
        assert.doesNotMatch(r.text, /SECRET/);
        assert.equal(r.body.companions[0].companionId, "5");
    });

    it("bank remove tells Zalo whether it was the default account, from the list", async () => {
        const fa = fakeApi({ getListBankAccount: { myBanks: [{ account_id: 11, default: true }] } });
        await tools({ api: fa.api }).call("zalo_bank", { action: "remove", bankAccountId: "11", confirm: true });
        assert.deepEqual(fa.calls.at(-1).args[0], { accountId: 11, isDefault: true });
    });

    it("read clears the unread mark and sends a seen receipt for the newest incoming cached message", async () => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api }).call("zalo_conversation", { action: "read", threadId: "779" });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual(r.body.seen.msgIds, ["9001"]);
        assert.ok(fa.calls.some((c) => c.method === "removeUnreadMark"));
        assert.ok(fa.http.length > 0, "the seen receipt reached the transport");
    });

    it("read with nothing cached to anchor on is refused, saying why", async () => {
        const fa = fakeApi();
        const r = await tools({ api: fa.api }).call("zalo_conversation", { action: "read", threadId: "4343" });
        assert.equal(r.isError, true);
        assert.match(r.text, /No incoming message/);
    });
});

describe("zalo_cloud apply", () => {
    it("deletes the message behind each planned item for this account, as `cloud apply` does", async () => {
        upsertCloudItem({
            noiseId: "cloudA",
            threadId: "780",
            msgId: "9100",
            mediaSize: 2048,
            timestamp: 1_700_000_000_000,
            raw_data: { msgInfo: { msgType: "chat.photo", srcId: PEER, destType: 0, cliMsgId: "8100" } },
        });
        const t = (fa) => tools({ api: fa.api });
        let fa = fakeApi();
        const dry = await t(fa).call("zalo_cloud", { action: "apply", threadIds: ["780"], dryRun: true });
        assert.equal(dry.body.dryRun, true);
        assert.equal(dry.body.plan.listed, 1);
        assert.match(dry.body.wouldDo, /1 zCloud item/);
        assert.deepEqual(fa.calls, []);

        fa = fakeApi();
        const done = await t(fa).call("zalo_cloud", { action: "apply", threadIds: ["780"], confirm: true });
        assert.equal(done.isError, false, done.text);
        assert.equal(done.body.deleted, 1);
        // The message each item names is the core planner's (src/core/cloud-plan.js), deleted for this account only.
        assert.equal(fa.calls.length, 1);
        assert.equal(fa.calls[0].method, "deleteMessage");
        const [target, onlyMe] = fa.calls[0].args;
        assert.equal(onlyMe, true);
        assert.equal(target.threadId, "780");
        assert.equal(target.data.cliMsgId, "8100");
        assert.equal(target.data.uidFrom, PEER);
    });
});

describe("the MCP-run sync stages", () => {
    it("boards skips with nothing cached for the thread, and never needs the phone", async () => {
        const runners = createMcpStageRunners({ getApi: () => fakeApi().api, accountDir: ROOT });
        const r = await runners.boards({ threadId: "999999" });
        assert.equal(r.status, "skipped");
    });

    it("media reports what it fetched from the cache's pending attachments", async () => {
        const runners = createMcpStageRunners({ getApi: () => fakeApi().api, accountDir: ROOT });
        const stats = await runners.media({ limit: 1 });
        assert.equal(typeof stats.downloaded, "number");
        assert.equal(existsSync(join(ROOT, "media")) || stats.downloaded === 0, true);
    });
});
