/**
 * src/core/oa/gmf.js and `oa group` (src/commands/oa/gmf.js): the OA's GMF group chats.
 *
 * Every request is asserted against Zalo's OA docs "Nhóm chat GMF" pages: method, URL, the access_token header,
 * the query (reads) or JSON body (writes), and the documented limits checked before anything is sent (1-99
 * members on create, a 2,000-character image caption, one of url/attachment_id, GIF width/height, the quota
 * enums). The guarded commands (`remove-members`, `delete`) are run as the real CLI: without --yes they exit 2
 * and send nothing. globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { saveOACreds } from "../../src/core/oa/transport.js";
import {
    GMF_URLS,
    acceptPendingMembers,
    addAdmins,
    buildGroupMessage,
    createGroup,
    deleteGroup,
    getGroup,
    getGroupConversation,
    getGroupQuota,
    inviteMembers,
    listGroups,
    listMembers,
    listPendingMembers,
    listRecentChats,
    mentionText,
    parseIdList,
    rejectPendingMembers,
    removeAdmins,
    removeMembers,
    sendGroupFile,
    sendGroupImage,
    sendGroupMention,
    sendGroupSticker,
    sendGroupText,
    updateGroup,
    updateGroupAsset,
    walkPages,
} from "../../src/core/oa/gmf.js";
import { registerGmfCommands } from "../../src/commands/oa/gmf.js";
import { runCli } from "../helpers/cli.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const V3 = "https://openapi.zalo.me/v3.0";
const G = "group-0000000001";
const U1 = "1000000000000000001";
const U2 = "1000000000000000002";

/** Replace fetch; `reply(url, init)` returns `{ json?, status? }` (default a success with empty data). */
function mockFetch(reply = () => ({})) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        return new Response(JSON.stringify(r.json ?? { error: 0, message: "Success", data: {} }), {
            status: r.status ?? 200,
            headers: { "content-type": "application/json" },
        });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

/** The one recorded call: method, URL without query, query params, header token, parsed JSON body. */
function only(calls) {
    assert.equal(calls.length, 1, "exactly one request");
    return describeCall(calls[0]);
}

function describeCall(c) {
    const u = new URL(c.url);
    return {
        method: c.init.method,
        url: `${u.origin}${u.pathname}`,
        query: Object.fromEntries(u.searchParams),
        token: c.init.headers.access_token,
        type: c.init.headers["Content-Type"],
        body: c.init.body === undefined ? undefined : JSON.parse(c.init.body),
    };
}

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-gmf" });
});
afterEach(() => m?.restore());

describe("GMF endpoints match the docs", () => {
    it("every URL is the documented v3.0 path", () => {
        assert.deepEqual(GMF_URLS, {
            message: `${V3}/oa/group/message`,
            create: `${V3}/oa/group/creategroupwithoa`,
            get: `${V3}/oa/group/getgroup`,
            updateInfo: `${V3}/oa/group/updateinfo`,
            updateAsset: `${V3}/oa/group/updateasset`,
            invite: `${V3}/oa/group/invite`,
            listPending: `${V3}/oa/group/listpendinginvite`,
            acceptPending: `${V3}/oa/group/acceptpendinginvite`,
            rejectPending: `${V3}/oa/group/rejectpendinginvite`,
            listMembers: `${V3}/oa/group/listmember`,
            addAdmins: `${V3}/oa/group/addadmins`,
            removeAdmins: `${V3}/oa/group/removeadmins`,
            removeMembers: `${V3}/oa/group/removemembers`,
            delete: `${V3}/oa/group/delete`,
            listGroups: `${V3}/oa/group/getgroupsofoa`,
            recentChat: `${V3}/oa/group/listrecentchat`,
            conversation: `${V3}/oa/group/conversation`,
            quota: `${V3}/oa/quota/group`,
        });
    });

    it("create: POST creategroupwithoa with group_name, group_description, asset_id, member_user_ids", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { group_id: G, status: "enabled" } } }));
        const r = await createGroup({ name: "Support", description: "d", assetId: "asset-1", memberUserIds: [U1] });
        const c = only(m.calls);
        assert.equal(c.method, "POST");
        assert.equal(c.url, `${V3}/oa/group/creategroupwithoa`);
        assert.equal(c.token, "tok-gmf");
        assert.equal(c.type, "application/json");
        assert.deepEqual(c.body, {
            group_name: "Support",
            group_description: "d",
            asset_id: "asset-1",
            member_user_ids: [U1],
        });
        assert.equal(r.data.group_id, G);
    });

    it("create: refuses 0 or more than 99 members, and a missing asset id, before sending", async () => {
        m = mockFetch();
        const hundred = Array.from({ length: 100 }, (_, i) => String(1000000000000000001n + BigInt(i)));
        await assert.rejects(createGroup({ name: "x", assetId: "a", memberUserIds: [] }), /at least one user id/);
        await assert.rejects(createGroup({ name: "x", assetId: "a", memberUserIds: hundred }), /at most 99/);
        await assert.rejects(createGroup({ name: "x", memberUserIds: [U1] }), /asset id/);
        assert.equal(m.calls.length, 0);
        await createGroup({ name: "x", assetId: "a", memberUserIds: hundred.slice(0, 99) });
        assert.equal(only(m.calls).body.member_user_ids.length, 99);
        assert.equal("group_description" in only(m.calls).body, false);
    });

    it("info: GET getgroup?group_id=", async () => {
        m = mockFetch();
        await getGroup(G);
        const c = only(m.calls);
        assert.equal(c.method, "GET");
        assert.equal(c.url, `${V3}/oa/group/getgroup`);
        assert.deepEqual(c.query, { group_id: G });
        assert.equal(c.body, undefined);
    });

    it("update: POST updateinfo with only the fields given, booleans as booleans", async () => {
        m = mockFetch();
        await updateGroup(G, {
            name: "N",
            avatar: "https://example.com/a.png",
            lockSendMsg: true,
            enableLinkJoin: false,
        });
        const c = only(m.calls);
        assert.equal(c.method, "POST");
        assert.equal(c.url, `${V3}/oa/group/updateinfo`);
        assert.deepEqual(c.body, {
            group_id: G,
            group_name: "N",
            group_avatar: "https://example.com/a.png",
            lock_send_msg: true,
            enable_link_join: false,
        });
    });

    it("update: nothing to change, or a non-boolean setting, sends nothing", async () => {
        m = mockFetch();
        await assert.rejects(updateGroup(G, {}), /nothing to update/);
        await assert.rejects(updateGroup(G, { joinAppr: "yes" }), /join_appr must be true or false/);
        assert.equal(m.calls.length, 0);
    });

    it("update-asset: POST updateasset { group_id, asset_id }", async () => {
        m = mockFetch();
        await updateGroupAsset(G, "asset-2");
        const c = only(m.calls);
        assert.equal(c.url, `${V3}/oa/group/updateasset`);
        assert.equal(c.method, "POST");
        assert.deepEqual(c.body, { group_id: G, asset_id: "asset-2" });
    });

    it("delete: POST delete { group_id }", async () => {
        m = mockFetch();
        await deleteGroup(G);
        const c = only(m.calls);
        assert.equal(c.url, `${V3}/oa/group/delete`);
        assert.equal(c.method, "POST");
        assert.deepEqual(c.body, { group_id: G });
    });

    for (const [name, fn, path] of [
        ["invite", inviteMembers, "invite"],
        ["accept", acceptPendingMembers, "acceptpendinginvite"],
        ["reject", rejectPendingMembers, "rejectpendinginvite"],
        ["add-admins", addAdmins, "addadmins"],
        ["remove-admins", removeAdmins, "removeadmins"],
        ["remove-members", removeMembers, "removemembers"],
    ]) {
        it(`${name}: POST ${path} { group_id, member_user_ids }`, async () => {
            m = mockFetch();
            await fn(G, `${U1}, ${U2},${U1}`);
            const c = only(m.calls);
            assert.equal(c.method, "POST");
            assert.equal(c.url, `${V3}/oa/group/${path}`);
            assert.deepEqual(c.body, { group_id: G, member_user_ids: [U1, U2] });
        });

        it(`${name}: no user ids sends nothing`, async () => {
            m = mockFetch();
            await assert.rejects(fn(G, []), /at least one user id/);
            await assert.rejects(fn("", [U1]), /group id is required/);
            assert.equal(m.calls.length, 0);
        });
    }

    for (const [name, call, path, withGroup] of [
        ["pending", (p) => listPendingMembers(G, p), "listpendinginvite", true],
        ["members", (p) => listMembers(G, p), "listmember", true],
        ["history", (p) => getGroupConversation(G, p), "conversation", true],
        ["list", (p) => listGroups(p), "getgroupsofoa", false],
        ["recent", (p) => listRecentChats(p), "listrecentchat", false],
    ]) {
        it(`${name}: GET ${path} with plain offset/count (docs' defaults 0 and 5)`, async () => {
            m = mockFetch();
            await call();
            await call({ offset: 10, count: 20 });
            const [a, b] = m.calls.map(describeCall);
            for (const c of [a, b]) {
                assert.equal(c.method, "GET");
                assert.equal(c.url, `${V3}/oa/group/${path}`);
                assert.equal(c.body, undefined);
                assert.equal("data" in c.query, false, "plain params, not ?data=");
            }
            const g = withGroup ? { group_id: G } : {};
            assert.deepEqual(a.query, { ...g, offset: "0", count: "5" });
            assert.deepEqual(b.query, { ...g, offset: "10", count: "20" });
        });
    }

    it("a bad offset or count sends nothing", async () => {
        m = mockFetch();
        await assert.rejects(listGroups({ offset: -1 }), /offset/);
        await assert.rejects(listGroups({ count: 0 }), /count/);
        await assert.rejects(listMembers(G, { count: 2.5 }), /count/);
        assert.equal(m.calls.length, 0);
    });

    it("quota: POST v3.0/oa/quota/group, quota_owner OA by default, optional product_type and quota_type", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: [{ asset_id: "asset-1", status: "available" }] } }));
        const r = await getGroupQuota();
        await getGroupQuota({ quotaOwner: "APP", productType: "gmf50", quotaType: "reward_quota" });
        const [a, b] = m.calls.map(describeCall);
        assert.equal(a.method, "POST");
        assert.equal(a.url, `${V3}/oa/quota/group`);
        assert.deepEqual(a.body, { quota_owner: "OA" });
        assert.deepEqual(b.body, { quota_owner: "APP", product_type: "gmf50", quota_type: "reward_quota" });
        assert.equal(r.data[0].asset_id, "asset-1");
    });

    it("quota: values outside the documented enums send nothing", async () => {
        m = mockFetch();
        await assert.rejects(getGroupQuota({ quotaOwner: "USER" }), /quota owner/);
        await assert.rejects(getGroupQuota({ productType: "gmf20" }), /product type/);
        await assert.rejects(getGroupQuota({ quotaType: "free" }), /quota type/);
        assert.equal(m.calls.length, 0);
    });

    it("a Zalo error comes back as the transport's OAError (e.g. -237 the group expired)", async () => {
        m = mockFetch(() => ({ json: { error: -237, message: "expired" } }));
        await assert.rejects(getGroup(G), (e) => e.code === -237 && /expired/.test(e.message));
    });
});

describe("group messages match the docs", () => {
    const sent = () => only(m.calls);

    it("text: { recipient: { group_id }, message: { text } }", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { message_id: "m1", group_id: G } } }));
        const r = await sendGroupText(G, "hello");
        const c = sent();
        assert.equal(c.method, "POST");
        assert.equal(c.url, `${V3}/oa/group/message`);
        assert.equal(c.type, "application/json");
        assert.deepEqual(c.body, { recipient: { group_id: G }, message: { text: "hello" } });
        assert.equal(r.data.message_id, "m1");
    });

    it("file: attachment type file with payload.token", async () => {
        m = mockFetch();
        await sendGroupFile(G, "file-token-1");
        assert.deepEqual(sent().body.message, { attachment: { type: "file", payload: { token: "file-token-1" } } });
    });

    it("image: media template, one image element by url, caption in text", async () => {
        m = mockFetch();
        await sendGroupImage(G, { text: "cap", url: "https://example.com/a.jpg" });
        assert.deepEqual(sent().body.message, {
            text: "cap",
            attachment: {
                type: "template",
                payload: {
                    template_type: "media",
                    elements: [{ media_type: "image", url: "https://example.com/a.jpg" }],
                },
            },
        });
    });

    it("image: a GIF by attachment_id carries width and height", async () => {
        m = mockFetch();
        await sendGroupImage(G, { text: "cap", attachmentId: "att-1", gif: true, width: "320", height: 240 });
        assert.deepEqual(sent().body.message.attachment.payload.elements, [
            { media_type: "gif", attachment_id: "att-1", width: 320, height: 240 },
        ]);
    });

    it("image: the documented limits are checked before sending", () => {
        assert.throws(() => buildGroupMessage("image", { url: "u" }), /caption/);
        assert.throws(() => buildGroupMessage("image", { text: "x".repeat(2001), url: "u" }), /2000/);
        assert.doesNotThrow(() => buildGroupMessage("image", { text: "x".repeat(2000), url: "u" }));
        assert.throws(() => buildGroupMessage("image", { text: "c" }), /exactly one/);
        assert.throws(() => buildGroupMessage("image", { text: "c", url: "u", attachmentId: "a" }), /exactly one/);
        assert.throws(() => buildGroupMessage("image", { text: "c", url: "u", gif: true }), /width and height/);
    });

    it("sticker: media template, one sticker element by attachment_id", async () => {
        m = mockFetch();
        await sendGroupSticker(G, "stk-1");
        assert.deepEqual(sent().body.message, {
            attachment: {
                type: "template",
                payload: { template_type: "media", elements: [{ media_type: "sticker", attachment_id: "stk-1" }] },
            },
        });
    });

    it("mention: [@user_id] tags in the text, [@group_id] for the whole group", async () => {
        m = mockFetch();
        await sendGroupMention(G, "hello", { userIds: [U1, U2] });
        assert.deepEqual(sent().body.message, { text: `[@${U1}] [@${U2}] hello` });
        m.restore();
        m = mockFetch();
        await sendGroupMention(G, "all hands", { all: true });
        assert.deepEqual(sent().body.message, { text: `[@${G}] all hands` });
    });

    it("mention: a tag already in the text is not repeated; no target at all sends nothing", async () => {
        assert.equal(mentionText(`hi [@${U1}]`, [U1, U2]), `[@${U2}] hi [@${U1}]`);
        m = mockFetch();
        await assert.rejects(sendGroupMention(G, "hello", {}), /at least one user id/);
        assert.equal(m.calls.length, 0);
    });

    it("an empty text sends nothing", async () => {
        m = mockFetch();
        await assert.rejects(sendGroupText(G, "  "), /empty/);
        assert.equal(m.calls.length, 0);
    });
});

describe("helpers", () => {
    it("parseIdList splits on commas and spaces, drops blanks and duplicates", () => {
        assert.deepEqual(parseIdList([`${U1},${U2}`, ` ${U1} `, ""]), [U1, U2]);
        assert.deepEqual(parseIdList(undefined), []);
    });

    it("walkPages follows data.total, not a short page", async () => {
        const all = Array.from({ length: 7 }, (_, i) => ({ user_id: String(i) }));
        const asked = [];
        const r = await walkPages(
            async ({ offset, count }) => {
                asked.push([offset, count]);
                // Zalo answering fewer than asked (a cap) must not end the walk while total says more.
                return { error: 0, data: { total: 7, members: all.slice(offset, offset + Math.min(count, 3)) } };
            },
            "members",
            { count: 5 },
        );
        assert.deepEqual(asked, [
            [0, 5],
            [3, 5],
            [6, 5],
        ]);
        assert.deepEqual(r.data.members, all);
        assert.equal(r.data.count, 7);
    });

    it("walkPages without a total stops on a short page", async () => {
        let n = 0;
        const r = await walkPages(async () => ({ data: { groups: n++ ? [{}] : [{}, {}] } }), "groups", { count: 2 });
        assert.equal(r.data.groups.length, 3);
    });
});

describe("`oa group` commands", () => {
    /** Run `oa group …` in process with --json; returns the parsed stdout. */
    async function run(args) {
        const root = new Command().option("--json").exitOverride();
        const oa = root.command("oa");
        registerGmfCommands(oa);
        const lines = [];
        const log = console.log;
        const err = console.error;
        console.log = (s) => lines.push(String(s));
        console.error = () => {};
        process.env.ZALO_JSON_MODE = "1";
        _resetErrorLatch();
        try {
            await root.parseAsync(["node", "zalo-agent", "--json", "oa", "group", ...args]);
        } finally {
            console.log = log;
            console.error = err;
            delete process.env.ZALO_JSON_MODE;
        }
        const exitCode = process.exitCode;
        process.exitCode = undefined;
        return { out: lines.length ? JSON.parse(lines.join("\n")) : undefined, exitCode };
    }

    it("registers every documented operation", () => {
        const root = new Command();
        registerGmfCommands(root.command("oa"));
        const group = root.commands[0].commands.find((c) => c.name() === "group");
        assert.deepEqual(
            group.commands.map((c) => c.name()),
            [
                "create",
                "info",
                "update",
                "avatar",
                "update-asset",
                "invite",
                "pending",
                "accept",
                "reject",
                "members",
                "add-admins",
                "remove-admins",
                "remove-members",
                "delete",
                "list",
                "recent",
                "history",
                "send",
                "quota",
            ],
        );
        for (const name of ["remove-members", "delete"]) {
            const c = group.commands.find((x) => x.name() === name);
            assert.ok(c.zaloGuard, `${name} is guarded`);
            assert.ok(
                c.options.some((o) => o.long === "--yes"),
                `${name} has --yes`,
            );
        }
        assert.equal(group.commands.find((x) => x.name() === "remove-members").zaloGuard.key, "oa.group.removeMembers");
        assert.equal(group.commands.find((x) => x.name() === "delete").zaloGuard.key, "oa.group.delete");
    });

    it("the guards' targets name the group and the users", () => {
        const root = new Command();
        registerGmfCommands(root.command("oa"));
        const group = root.commands[0].commands.find((c) => c.name() === "group");
        const rm = group.commands.find((x) => x.name() === "remove-members").zaloGuard;
        assert.deepEqual(rm.target(G, [`${U1},${U2}`], { oaId: "default" }), {
            groupId: G,
            userIds: [U1, U2],
            oaId: "default",
        });
        const del = group.commands.find((x) => x.name() === "delete").zaloGuard;
        assert.deepEqual(del.target(G, { oaId: "shop" }), { groupId: G, oaId: "shop" });
    });

    it("create --members takes a comma list and prints Zalo's reply", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { group_id: G } } }));
        const { out, exitCode } = await run(["create", "Support", "--asset-id", "asset-1", "--members", `${U1},${U2}`]);
        assert.equal(exitCode, undefined);
        assert.equal(out.data.group_id, G);
        assert.deepEqual(only(m.calls).body.member_user_ids, [U1, U2]);
    });

    it("update maps on/off flags to the documented booleans", async () => {
        m = mockFetch();
        await run(["update", G, "--lock-send-msg", "on", "--join-approval", "off", "--msg-history", "on"]);
        assert.deepEqual(only(m.calls).body, {
            group_id: G,
            lock_send_msg: true,
            join_appr: false,
            enable_msg_history: true,
        });
    });

    it("avatar sends updateinfo with group_avatar only", async () => {
        m = mockFetch();
        await run(["avatar", G, "https://example.com/a.png"]);
        const c = only(m.calls);
        assert.equal(c.url, `${V3}/oa/group/updateinfo`);
        assert.deepEqual(c.body, { group_id: G, group_avatar: "https://example.com/a.png" });
    });

    it("members --all walks the pages by total", async () => {
        m = mockFetch((url) => {
            const off = Number(new URL(url).searchParams.get("offset"));
            const members = off === 0 ? [{ user_id: U1 }, { oa_id: "oa-1" }] : [{ user_id: U2 }];
            return { json: { error: 0, data: { total: 3, members } } };
        });
        const { out } = await run(["members", G, "--all", "--count", "2"]);
        assert.equal(m.calls.length, 2);
        assert.deepEqual(
            m.calls.map((c) => new URL(c.url).searchParams.get("offset")),
            ["0", "2"],
        );
        assert.equal(out.data.members.length, 3);
    });

    it("send picks the documented message shape from the flags", async () => {
        m = mockFetch();
        await run(["send", G, "hi", "--mention", `${U1},${U2}`]);
        await run(["send", G, "cap", "--image-url", "https://example.com/a.jpg"]);
        await run(["send", G, "--file-token", "tok"]);
        await run(["send", G, "--sticker", "stk"]);
        const bodies = m.calls.map((c) => JSON.parse(c.init.body).message);
        assert.equal(bodies[0].text, `[@${U1}] [@${U2}] hi`);
        assert.equal(bodies[1].attachment.payload.elements[0].url, "https://example.com/a.jpg");
        assert.equal(bodies[2].attachment.type, "file");
        assert.equal(bodies[3].attachment.payload.elements[0].media_type, "sticker");
    });

    it("send refuses two kinds at once, and an image without a caption, sending nothing", async () => {
        m = mockFetch();
        const a = await run(["send", G, "--file-token", "t", "--sticker", "s"]);
        assert.equal(a.exitCode, 1);
        assert.match(a.out.error, /one kind/);
        const b = await run(["send", G, "--image-url", "https://example.com/a.jpg"]);
        assert.equal(b.exitCode, 1);
        assert.match(b.out.error, /caption/);
        assert.equal(m.calls.length, 0);
    });

    it("a Zalo error exits 1 with {error}", async () => {
        m = mockFetch(() => ({ json: { error: -403, message: "not owner" } }));
        const { out, exitCode } = await run(["info", G]);
        assert.equal(exitCode, 1);
        assert.match(out.error, /-403/);
    });
});

describe("guarded `oa group` commands, as the real CLI", () => {
    // A home with no OA credentials: if the guard let a command through, it would fail "not configured" (exit 1),
    // so exit 2 proves the guard stopped it before any request.
    const home = mkdtempSync(join(tmpdir(), "zalo-oa-gmf-guard-"));
    const opts = { home, timeout: 240_000 };

    it("remove-members without --yes exits 2 and sends nothing", async () => {
        const r = await runCli(["--json", "oa", "group", "remove-members", G, U1, U2], opts);
        assert.equal(r.code, 2, r.all);
        const out = JSON.parse(r.stdout);
        assert.equal(out.confirmationRequired, true);
        assert.equal(out.action, "oa group remove-members");
        assert.deepEqual(out.target.userIds, [U1, U2]);
    });

    it("delete without --yes exits 2; --dry-run exits 0 and says nothing was sent", async () => {
        const r = await runCli(["oa", "group", "delete", G], opts);
        assert.equal(r.code, 2, r.all);
        assert.match(r.all, /delete Official Account group chat/);
        const d = await runCli(["--json", "oa", "group", "delete", G, "--dry-run"], opts);
        assert.equal(d.code, 0, d.all);
        assert.equal(JSON.parse(d.stdout).sent, false);
    });

    it("with --yes the guard lets it through to the request (here: no OA configured, exit 1)", async () => {
        const r = await runCli(["oa", "group", "delete", G, "--yes"], opts);
        assert.equal(r.code, 1, r.all);
        assert.match(r.all, /OA not configured/);
    });
});
