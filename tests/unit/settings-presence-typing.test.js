/**
 * Workstream A of the 3.0.0 settings plan (agent/docs/plan_v3.0.0-settings-hidden-chats.md): the settings map and
 * its shared reply, presence (`friend last-online`, the 602 `online_status` push and its cache), the 601
 * `my_settings` control, typing (self dropped, `fsending`, the stranger rule) and quick messages on/off.
 *
 * The CLI and MCP surfaces call the same src/core functions; where a surface is exercised here, it is to show both
 * answer the same JSON. Ids are throwaway constants; payloads are written from the key names Zalo Web reads.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { walkAst } from "../helpers/api-call-sites.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getLastOnline } from "../../src/core/db.js";
import {
    SETTING_MAP,
    describeSettings,
    describeSettingChanges,
    settingValueError,
    updateSetting,
    setQuickMessageStatus,
} from "../../src/core/profile-settings.js";
import { applyControlEvents } from "../../src/core/control-events.js";
import { dispatchAction, onlineStatusOf } from "../../src/zalo/listener/dispatch.js";
import { LAST_ONLINE } from "../../src/zalo/api/people.js";
import {
    attachLastOnline,
    cachedLastOnline,
    clearLastOnlineMemory,
    lastOnlineStatus,
} from "../../src/core/last-online.js";
import { rememberFriends, sendTyping } from "../../src/core/typing.js";
import { PROFILE_ACTIONS } from "../../src/mcp/actions-profile.js";
import { QUICK_MESSAGE_ACTIONS } from "../../src/mcp/actions-business.js";
import { FRIEND_EXTRA_ACTIONS } from "../../src/mcp/actions-social.js";
import { CONVERSATION_ACTIONS } from "../../src/mcp/actions-conversation.js";

const OWN = "9100000000000000001";
const PEER = "9300000000000000002";
const GROUP = "9200000000000000003";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-settings-presence-"));
let n = 0;
const opened = [];

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    rmSync(ROOT, { recursive: true, force: true });
});

/** A fake session that records each call by name and answers from `answers`. */
function fakeApi(answers = {}) {
    const calls = [];
    const handler = {
        get(_t, name) {
            if (name === "calls") return calls;
            if (name === "then") return undefined;
            return async (...args) => {
                calls.push({ name, args });
                const a = answers[name];
                if (a instanceof Error) throw a;
                return typeof a === "function" ? a(...args) : a;
            };
        },
    };
    return new Proxy({}, handler);
}

/** The context an action-table row runs with (src/mcp/action-tool.js), on a fake api. */
const ctxOf = (api) => ({
    api,
    ownId: () => OWN,
    threadType: (_id, t) => (t === "group" ? 1 : 0),
    threadTypeName: (t) => (Number(t) === 1 ? "group" : "dm"),
});

describe("settings: one map, one reply for `profile settings` and zalo_profile `settings`", () => {
    it("maps add-by-card and focused-tabs, shows the read-only ones, and keeps unknown keys under `other`", () => {
        const raw = {
            show_online_status: true,
            add_friend_via_contact: 0,
            archived_chat_status: 1,
            setting_show_stranger_msg_directly: 1,
            setting_2FA_status: 0,
            quick_message_status: 1,
            some_new_key: "x",
        };
        const r = describeSettings(raw);
        const by = Object.fromEntries(r.settings.map((s) => [s.setting, s]));
        assert.equal(by["online-status"].value, 1, "a bool reads as 1");
        assert.equal(by["add-by-card"].key, "add_friend_via_contact");
        assert.equal(by["add-by-card"].meaning, "disabled");
        assert.equal(by["focused-tabs"].value, 1);
        const ro = Object.fromEntries(r.readOnly.map((s) => [s.setting, s]));
        assert.equal(ro["stranger-messages"].value, 1);
        assert.equal(ro["two-factor"].value, 0);
        assert.equal(ro["quick-messages"].changeWith, "quick-msg enable|disable");
        // Red if a key we do not map is dropped instead of passed through.
        assert.deepEqual(r.other, { some_new_key: "x" });
    });

    it("writes focused-tabs under the key Zalo Web writes (archivedChatStatus), not the one it reads", async () => {
        const api = fakeApi({ updateSettings: "" });
        const r = await updateSetting(api, "focused-tabs", "0");
        assert.deepEqual(api.calls, [{ name: "updateSettings", args: ["archivedChatStatus", 0] }]);
        assert.deepEqual(r, { success: true, setting: "focused-tabs", value: 0, meaning: "off (one list)" });
        await updateSetting(api, "add-by-card", 1);
        assert.deepEqual(api.calls[1], { name: "updateSettings", args: ["add_friend_via_contact", 1] });
    });

    it("refuses a read-only setting or a bad value before any request", async () => {
        assert.match(settingValueError("two-factor", 1), /read-only/);
        assert.match(settingValueError("quick-messages", 1), /quick-msg enable\|disable/);
        assert.match(settingValueError("focused-tabs", 7), /Invalid value/);
        assert.match(settingValueError("focused-tabs", "1x"), /Invalid value/);
        const api = fakeApi();
        await assert.rejects(updateSetting(api, "two-factor", 1), /read-only/);
        assert.equal(api.calls.length, 0);
    });

    it("the MCP actions answer what the core answers", async () => {
        const raw = { show_online_status: 0, archived_chat_status: 1, foo: 1 };
        const api = fakeApi({ getSettings: raw, updateSettings: "" });
        assert.deepEqual(await PROFILE_ACTIONS.settings.run({}, ctxOf(api)), describeSettings(raw));
        assert.equal(
            PROFILE_ACTIONS.set.check({ setting: "two-factor", value: 1 }),
            settingValueError("two-factor", 1),
        );
        const set = await PROFILE_ACTIONS.set.run({ setting: "focused-tabs", value: 1 }, ctxOf(api));
        assert.deepEqual(set, {
            success: true,
            setting: "focused-tabs",
            value: 1,
            meaning: SETTING_MAP["focused-tabs"].values[1],
        });
    });
});

describe("quick messages on/off: `quick-msg enable|disable` and zalo_quick_message", () => {
    it("writes quickMessageStatus 1 / 0 and answers {success, enabled}", async () => {
        const api = fakeApi({ updateSettings: "" });
        assert.deepEqual(await setQuickMessageStatus(api, true), { success: true, enabled: true });
        assert.deepEqual(await QUICK_MESSAGE_ACTIONS.disable.run({}, ctxOf(api)), { success: true, enabled: false });
        assert.deepEqual(
            api.calls.map((c) => c.args),
            [
                ["quickMessageStatus", 1],
                ["quickMessageStatus", 0],
            ],
        );
    });
});

describe("601 my_settings: a settings_changed event", () => {
    it("names each known key with its profile-set name, by the read key or the write key", () => {
        const data = {
            controls: [
                {
                    actionId: "5001",
                    content: {
                        act_type: "my_settings",
                        act: "update",
                        data: JSON.stringify({ show_online_status: 0, archivedChatStatus: 1, other_thing: 2 }),
                    },
                },
            ],
        };
        const [ev] = applyControlEvents({ data });
        assert.equal(ev.event, "settings_changed");
        assert.equal(ev.act, "update");
        assert.deepEqual(ev.settings, { show_online_status: 0, archivedChatStatus: 1, other_thing: 2 });
        assert.deepEqual(
            ev.changed.map((c) => `${c.setting}=${c.value}`),
            ["online-status=0", "focused-tabs=1"],
        );
        assert.deepEqual(describeSettingChanges({ quickMessageStatus: 0 })[0].setting, "quick-messages");
    });
});

describe("602 actions: typing, file sending, presence", () => {
    const typing = (uid, extra = {}) => ({
        act_type: "typing",
        act: "typing",
        data: `"uid":"${uid}","ts":"1"`,
        ...extra,
    });

    it("drops our own devices' typing, as Zalo Web does, and marks the rest not self", () => {
        const steps = dispatchAction({ actions: [typing(OWN), typing(PEER)] }, OWN);
        assert.equal(steps.length, 1, "red if our own typing reaches subscribers");
        const [ev] = steps[0].args;
        assert.equal(ev.threadId, PEER);
        assert.equal(ev.isSelf, false);
        assert.equal(ev.action, "typing");
    });

    it("maps fsending (a peer sending a file) to a typing event with action fsending, in a DM and a group", () => {
        const steps = dispatchAction(
            {
                actions: [
                    { act_type: "fsending", act: "sending", data: JSON.stringify({ uid: PEER, ts: "1" }) },
                    { act_type: "fsending", act: "gsending", data: JSON.stringify({ uid: PEER, gid: GROUP, ts: "1" }) },
                    { act_type: "fsending", act: "sending", data: JSON.stringify({ uid: OWN, ts: "1" }) },
                ],
            },
            OWN,
        );
        assert.deepEqual(
            steps.map((s) => [s.emit, s.args[0].action, s.args[0].threadId, s.args[0].type]),
            [
                ["typing", "fsending", PEER, 0],
                ["typing", "fsending", GROUP, 1],
            ],
        );
    });

    it("reads profile/online_status as {userId, lastOnline}, and nothing else as one", () => {
        assert.deepEqual(
            onlineStatusOf({
                act_type: "profile",
                act: "online_status",
                data: JSON.stringify({ uid: PEER, lastOnline: 1790000000000 }),
            }),
            { userId: PEER, lastOnline: 1790000000000 },
        );
        assert.equal(onlineStatusOf(typing(PEER)), null);
    });
});

describe("the presence cache: attachLastOnline and friend last-online --cached", () => {
    beforeEach(() => {
        opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
        clearLastOnlineMemory();
    });

    it("keeps each push in memory and the db, tells online_status, and never moves back in time", () => {
        let handler;
        const tap = { on: (cmd, fn) => ((handler = cmd === 602 ? fn : handler), () => {}) };
        const events = [];
        attachLastOnline({ tap, onEvent: (e) => events.push(e), log: () => {} });
        const push = (t) =>
            handler({
                data: {
                    actions: [
                        {
                            act_type: "profile",
                            act: "online_status",
                            data: JSON.stringify({ uid: PEER, lastOnline: t }),
                        },
                    ],
                },
            });
        push(1790000000500);
        push(1790000000100);
        assert.deepEqual(events[0], { event: "online_status", userId: PEER, lastOnline: 1790000000500 });
        assert.equal(getLastOnline(PEER).lastOnline, 1790000000500, "red if an older push overwrites a newer one");
        clearLastOnlineMemory();
        assert.equal(cachedLastOnline(PEER).lastOnline, 1790000000500, "the db answers once memory is gone");
    });

    it("--cached sends nothing and says where the answer came from", async () => {
        let handler;
        attachLastOnline({ tap: { on: (_c, fn) => ((handler = fn), () => {}) }, log: () => {} });
        handler({
            data: {
                actions: [{ act_type: "profile", act: "online_status", data: `{"uid":"${PEER}","lastOnline":5}` }],
            },
        });
        const r = await lastOnlineStatus(null, PEER, { cached: true });
        assert.equal(r.lastOnline, 5);
        assert.equal(r.source, "cache");
        assert.equal(r.asked, false);
        const none = await lastOnlineStatus(null, "9300000000000000999", { cached: true });
        assert.equal(none.lastOnline, null);
        assert.equal(none.source, null);
    });
});

describe("friend last-online: Zalo Web's rules", () => {
    it("asks nothing when our own online status is hidden, and says hiddenBy you", async () => {
        const api = fakeApi({ getSettings: { show_online_status: false } });
        const r = await lastOnlineStatus(api, PEER);
        assert.deepEqual(
            api.calls.map((c) => c.name),
            ["getSettings"],
            "red if lastOnline is asked while our own status is hidden",
        );
        assert.equal(r.hiddenBy, "you");
        assert.equal(r.myShowOnlineStatus, false);
        assert.equal(r.asked, false);
    });

    it("asks anyway with askAnyway, and reports hiddenBy them from the answer's settings", async () => {
        const api = fakeApi({
            getSettings: { show_online_status: false },
            getUserInfo: { changed_profiles: { [PEER]: { userId: PEER, type: 0 } } },
            lastOnline: { settings: { show_online_status: false }, lastOnline: 0 },
        });
        const r = await lastOnlineStatus(api, PEER, { askAnyway: true });
        assert.deepEqual(api.calls.at(-1), { name: "lastOnline", args: [PEER, 1] });
        assert.equal(r.hiddenBy, "them");
        assert.equal(r.lastOnline, null);
    });

    it("uses conv_type 2 for an OA (profile type 1 or more), 1 otherwise", async () => {
        const oa = fakeApi({
            getSettings: { show_online_status: 1 },
            getUserInfo: { changed_profiles: { [PEER]: { type: 1 } } },
            lastOnline: { lastOnline: 1790000000000 },
        });
        const r = await lastOnlineStatus(oa, PEER);
        assert.deepEqual(oa.calls.at(-1).args, [PEER, 2]);
        assert.equal(r.convType, 2);
        assert.equal(r.hiddenBy, null);
        assert.equal(r.lastOnline, 1790000000000);
        assert.deepEqual(LAST_ONLINE.body({ uid: PEER, convType: 2 }, { imei: "i" }), {
            uid: PEER,
            conv_type: 2,
            imei: "i",
        });
        assert.equal(LAST_ONLINE.body({ uid: PEER }, { imei: "i" }).conv_type, 1);
        // `isOA` given: no profile lookup.
        const given = fakeApi({ getSettings: {}, lastOnline: {} });
        await lastOnlineStatus(given, PEER, { isOA: false });
        assert.deepEqual(
            given.calls.map((c) => c.name),
            ["getSettings", "lastOnline"],
        );
    });

    it("zalo_friend last_online answers what friend last-online answers", async () => {
        const api = fakeApi({ getSettings: { show_online_status: 0 } });
        const viaMcp = await FRIEND_EXTRA_ACTIONS.last_online.run({ userId: PEER }, ctxOf(api));
        assert.deepEqual(viaMcp, await lastOnlineStatus(fakeApi({ getSettings: { show_online_status: 0 } }), PEER));
    });
});

describe("msg typing / zalo_conversation typing: never to a stranger", () => {
    after(() => rememberFriends(null));

    it("refuses a stranger in a DM before any request", async () => {
        rememberFriends([{ userId: "9300000000000000777" }]);
        const api = fakeApi();
        await assert.rejects(sendTyping(api, { threadId: PEER, type: 0, ownId: OWN }), /not a friend/);
        assert.equal(api.calls.length, 0);
    });

    it("sends to a friend and to a group (not checked)", async () => {
        rememberFriends([{ userId: PEER }]);
        const api = fakeApi({ sendTypingEvent: "" });
        assert.equal((await sendTyping(api, { threadId: PEER, type: 0, ownId: OWN })).friendCheck, "friend");
        assert.equal((await sendTyping(api, { threadId: GROUP, type: 1, ownId: OWN })).friendCheck, "group");
        assert.deepEqual(
            api.calls.map((c) => c.args),
            [
                [PEER, 0],
                [GROUP, 1],
            ],
        );
    });

    it("with no friend list loaded it sends and says so; the MCP action answers the same", async () => {
        rememberFriends(null);
        const api = fakeApi({ sendTypingEvent: "" });
        const r = await sendTyping(api, { threadId: PEER, type: 0, ownId: OWN });
        assert.equal(r.friendCheck, "unknown");
        assert.match(r.note, /no friend list/);
        const viaMcp = await CONVERSATION_ACTIONS.typing.run({ threadId: PEER }, ctxOf(api));
        assert.deepEqual(viaMcp, r);
    });
});

describe("`listen` and `mcp start` both keep the presence cache", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const calls = [];
            walkAst(ast, (node) => {
                if (node.type === "CallExpression" && node.callee?.name === "attachLastOnline") calls.push(node);
            });
            // Red if one entry point stops keeping it: AGENTS.md §13 calls that asymmetry a defect.
            assert.equal(calls.length, 1, `${file} must attach the presence cache once`);
        });
    }
});
