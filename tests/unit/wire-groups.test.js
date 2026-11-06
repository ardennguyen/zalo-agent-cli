/**
 * The groups area on the wire, ours (src/zalo/api/groups.js) against zca-js's, both built by `createApi` on ONE
 * logged-in context (design 3.1, package GRP): all 28 methods.
 *
 * Each case has the three parts of design 3.1:
 *
 * 1. `assertSameWire`: every request and the outcome, zca against own. Every difference must be a row of
 *    tests/helpers/wire-diff/allow/groups.js (or a global row), and every declared row must actually be seen, so
 *    the list cannot go stale. Red when our request differs from zca-js's anywhere the Web does not differ.
 * 2. `expectGolden`: our record against its reviewed entry in tests/helpers/wire-diff/golden/groups.js. Red when
 *    our wire changes at all; this is what keeps guarding the wire once zca-js is gone.
 * 3. Error cases: an outer error, an inner error, HTTP 500 and an undecryptable `data`, for every method, plus the
 *    codes the MCP tools read (165 kickout, 166/167 leave). The thrown code is compared always, the message where
 *    zca-js wrote the same text; our side is also checked against a literal, so the case outlives zca-js.
 *
 * A few cases also assert the Web facts on our side directly (verb, host, key order, member types), so a reader
 * sees them here and not only in the golden file. Every id is fake.
 */
import { assertSandboxed, SANDBOX_HOME } from "../helpers/sandbox.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWN_READY } from "../../src/zalo/api/groups.js";
import { GLOBAL_EXEMPT } from "../helpers/wire-diff/allow/groups.js";
import { ALLOW, FAKE, T0, assertSameWire, expectGolden, openPair } from "../helpers/wire-diff/index.js";

const G = "9000000000000000001";
const G2 = "9000000000000000002";
const U = "8000000000000000001";
const U2 = "8000000000000000002";
const LINK = "https://zalo.me/g/fakelink";
/** A tiny stand-in for a JPEG: the bytes travel as they are, nothing decodes them. */
const AVATAR = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("fake jpeg"),
    Buffer.from([0xff, 0xd9]),
]);
const AVATAR_PATH = join(SANDBOX_HOME, "avatar.jpg");
/** What the session's imageMetadataGetter says about AVATAR_PATH (the engine's getter reads real images). */
const AVATAR_META = { width: 640, height: 480, size: AVATAR.length };

/** n fake group ids, 9000000000000000000 + i (i < 1000 keeps them fakes by the convention). */
const groupIds = (n) => Array.from({ length: n }, (_, i) => `9000000000000000${String(i).padStart(3, "0")}`);
/** n fake user ids. */
const userIds = (n) => Array.from({ length: n }, (_, i) => `8000000000000000${String(i).padStart(3, "0")}`);

/** A getmg-v2 answer for these groups. */
function groupInfoReply(ids, extra = {}) {
    return {
        removedsGroup: [],
        unchangedsGroup: [],
        gridInfoMap: Object.fromEntries(
            ids.map((id) => [
                id,
                {
                    groupId: id,
                    name: `group ${id.slice(-3)}`,
                    desc: "",
                    type: 1,
                    creatorId: U,
                    adminIds: [U2],
                    totalMember: 2,
                    maxMember: 1000,
                    createdTime: T0,
                    memberIds: [],
                    memVerList: [`${U}_0`, `${U2}_0`],
                    pendingApprove: { uids: [] },
                    setting: { blockName: 0, signAdminMsg: 1, lockSendMsg: 0 },
                    globalId: `G${id.slice(-3)}`,
                },
            ]),
        ),
        ...extra,
    };
}

/** A social/group/members answer: one key with `_0`, one without (both forms are seen live). */
const MEMBERS_REPLY = {
    profiles: {
        [`${U}_0`]: { displayName: "Member One", zaloName: "one", id: U, avatar: "", accountStatus: 0 },
        [U2]: { zaloName: "two", id: U2 },
    },
    unchangeds_profile: [],
};

/**
 * Every success case: `[case, method, args, reply]`. The case name is the golden entry's name and what the allow
 * rows of a single case (`<method>/<case>`) match on.
 */
const CASES = [
    ["getGroupInfo", "getGroupInfo", [G], groupInfoReply([G])],
    ["getGroupInfo/array", "getGroupInfo", [[G, G2]], groupInfoReply([G, G2])],
    ["getGroupInfo/notMember", "getGroupInfo", [[G]], { removedsGroup: [], unchangedsGroup: [], gridInfoMap: {} }],
    ["getAllGroups", "getAllGroups", [], { version: "1", gridVerMap: { [G]: "1", [G2]: "2" } }],
    ["getGroupMembersInfo", "getGroupMembersInfo", [[U, `${U2}_0`]], MEMBERS_REPLY],
    ["getGroupMembersInfo/one", "getGroupMembersInfo", [U], MEMBERS_REPLY],
    [
        "createGroup",
        "createGroup",
        [{ name: "Fake group", members: [U, U2] }],
        { groupType: 1, sucessMembers: [U], groupId: G, errorMembers: [U2], error_data: { 270: [U2] } },
    ],
    ["addUserToGroup", "addUserToGroup", [[U, U2], G], { errorMembers: [U2], error_data: { 270: [U2] } }],
    ["addUserToGroup/one", "addUserToGroup", [U, G], { errorMembers: [], error_data: {} }],
    ["removeUserFromGroup", "removeUserFromGroup", [[U], G], { errorMembers: [] }],
    ["leaveGroup", "leaveGroup", [G, false], { memberError: [] }],
    ["leaveGroup/silent", "leaveGroup", [G, true], { memberError: [] }],
    ["changeGroupName", "changeGroupName", ["Renamed", G], ""],
    ["changeGroupAvatar", "changeGroupAvatar", [AVATAR_PATH, G], ""],
    [
        "changeGroupAvatar/bytes",
        "changeGroupAvatar",
        () => [{ data: Buffer.from(AVATAR), metadata: { width: 10, height: 20 } }, G],
        "",
    ],
    ["addGroupDeputy", "addGroupDeputy", [[U], G], ""],
    ["removeGroupDeputy", "removeGroupDeputy", [U, G], ""],
    ["changeGroupOwner", "changeGroupOwner", [U, G], { time: T0 }],
    ["addGroupBlockedMember", "addGroupBlockedMember", [[U, U2], G], ""],
    ["removeGroupBlockedMember", "removeGroupBlockedMember", [[U], G], ""],
    ["getGroupBlockedMember", "getGroupBlockedMember", [{}, G], { blocked_members: [{ id: U }], has_more: 0 }],
    ["getGroupBlockedMember/page", "getGroupBlockedMember", [{ page: 2, count: 20 }, G], { blocked_members: [] }],
    ["upgradeGroupToCommunity", "upgradeGroupToCommunity", [G], ""],
    ["joinGroupLink", "joinGroupLink", [LINK], ""],
    ["getPendingGroupMembers", "getPendingGroupMembers", [G], { users: [{ uid: U, dpn: "Pending" }], time: 0 }],
    [
        "reviewPendingMemberRequest",
        "reviewPendingMemberRequest",
        () => [{ members: [U, U2], isApprove: true }, G],
        { [U]: 0, [U2]: 0 },
    ],
    [
        "reviewPendingMemberRequest/reject",
        "reviewPendingMemberRequest",
        () => [{ members: U, isApprove: false }, G],
        { [U]: 0 },
    ],
    ["enableGroupLink", "enableGroupLink", [G], { link: LINK, expiration_date: 0, enabled: 1 }],
    ["disableGroupLink", "disableGroupLink", [G], ""],
    ["getGroupLinkDetail", "getGroupLinkDetail", [G], { link: LINK, expiration_date: 0, enabled: 1 }],
    ["getGroupLinkInfo", "getGroupLinkInfo", [{ link: LINK }], { groupId: G, name: "Linked", totalMember: 3 }],
    ["getGroupLinkInfo/page", "getGroupLinkInfo", [{ link: LINK, memberPage: 2 }], { groupId: G }],
    ["getGroupInviteBoxList", "getGroupInviteBoxList", [], { invitations: [], total: 0, hasMore: false }],
    [
        "getGroupInviteBoxList/page",
        "getGroupInviteBoxList",
        [{ mpage: 2, page: 1, invPerPage: 6, mcount: 5 }],
        { invitations: [], total: 0, hasMore: false },
    ],
    ["joinGroupInviteBox", "joinGroupInviteBox", [G], ""],
    ["deleteGroupInviteBox", "deleteGroupInviteBox", [[G, G2], false], { delInvitaionIds: [G, G2] }],
    ["deleteGroupInviteBox/block", "deleteGroupInviteBox", [G, true], { delInvitaionIds: [G] }],
    ["inviteUserToGroups", "inviteUserToGroups", [U, [G, G2]], { grid_message_map: { [G]: { error_code: 0 } } }],
    ["inviteUserToGroups/one", "inviteUserToGroups", [U, G], { grid_message_map: {} }],
    ["disperseGroup", "disperseGroup", [G], ""],
];

/** The 28 methods of the area (spec-groups 1-8, spec-sweep 1.2 groups). */
const METHODS = [...new Set(CASES.map(([, method]) => method))];

/** One call each method makes for the error cases. */
const ERROR_CALLS = Object.fromEntries(
    CASES.filter(([name, method]) => name === method).map(([, m, args]) => [m, args]),
);

/**
 * The allow rows of one case: the global rows (less the ones the method makes untrue, GLOBAL_EXEMPT), the method's
 * own rows carried over to the case name (unless `inherit` is false: a call refused before any request has no
 * request to differ in), and the case's own rows.
 *
 * @param {string} name - the case
 * @param {string} method
 * @param {{inherit?: boolean}} [opts]
 * @returns {object[]}
 */
function allowFor(name, method, { inherit = true } = {}) {
    const exempt = new Set([...(GLOBAL_EXEMPT["*"] ?? []), ...(GLOBAL_EXEMPT[method] ?? [])]);
    return ALLOW.groups.flatMap((row) => {
        if (row.method === "*") return exempt.has(row.id) ? [] : [row];
        if (row.method === name) return [row];
        if (inherit && row.method === method) return [{ ...row, method: name }];
        return [];
    });
}

/**
 * Part 1: the two sides of a record are the same, apart from what the case's rows declare.
 *
 * @param {object} rec - a `pair.run` record
 * @param {string} name - the case
 * @param {{inherit?: boolean}} [opts]
 */
function sameWire(rec, name, opts) {
    assertSameWire({ ...rec, name }, allowFor(name, rec.name, opts));
}

describe("groups: ours against zca-js on one context (wire-groups)", () => {
    let pair;
    /** Each case's record, by case name. */
    const recs = {};

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        writeFileSync(AVATAR_PATH, AVATAR);
        pair = await openPair({ zaloOptions: { imageMetadataGetter: async () => ({ ...AVATAR_META }) } });
        // A cookie every fake host gets, so the Cookie header is compared on a value (the saved login's cookie is
        // for chat.zalo.me, which no fake host matches).
        pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://group.zalo.invalid/");
        for (const [name, method, args, reply] of CASES) {
            recs[name] = await pair.run(method, args, { reply });
        }
    });

    after(() => pair?.close());

    it("covers all 28 methods, and lists each of them as own-ready but the one another test still pins", () => {
        // Red when a method of the area has no case here, or is missing from (or extra in) OWN_READY.
        // getGroupLinkInfo passes here too; zca-gap-commands.test.js still expects zca-js's 120 px avatars.
        const held = ["getGroupLinkInfo"];
        assert.equal(METHODS.length, 28);
        assert.deepEqual([...OWN_READY].sort(), METHODS.filter((m) => !held.includes(m)).sort());
    });

    describe("every case: the same wire as zca-js but for the declared differences, and its golden record", () => {
        for (const [name] of CASES) {
            it(name, async () => {
                const rec = recs[name];
                assert.equal(rec.own.error, null, `our side threw: ${JSON.stringify(rec.own.error)}`);
                assert.equal(rec.zca.error, null, `zca-js threw: ${JSON.stringify(rec.zca.error)}`);
                assert.ok(rec.own.requests.length >= 1, "our side made its request");
                sameWire(rec, name);
                await expectGolden("groups", name, rec.own);
            });
        }
    });

    describe("the Web facts, on our side", () => {
        const only = (name) => {
            assert.equal(recs[name].own.requests.length, 1, `${name}: one request`);
            return recs[name].own.requests[0];
        };

        it("getGroupInfo: a form POST to group getmg-v2 with gridVerMap a JSON string of id -> 0, string or array", () => {
            for (const [name, ids] of [
                ["getGroupInfo", [G]],
                ["getGroupInfo/array", [G, G2]],
            ]) {
                const req = only(name);
                assert.equal(req.method, "POST");
                assert.equal(req.service, "group");
                assert.equal(req.path, "/api/group/getmg-v2");
                assert.equal(typeof req.params.gridVerMap, "string", "gridVerMap is a JSON string inside the JSON");
                assert.deepEqual(JSON.parse(req.params.gridVerMap), Object.fromEntries(ids.map((id) => [id, 0])));
            }
            assert.deepEqual(recs.getGroupInfo.own.result, groupInfoReply([G]), "the reply is returned unchanged");
        });

        it("getAllGroups: a GET on the group host with no params", () => {
            const req = only("getAllGroups");
            assert.deepEqual([req.method, req.service, req.path], ["GET", "group", "/api/group/getlg/v4"]);
            assert.equal(req.params, null);
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
        });

        it("getGroupMembersInfo: a form POST on profile, each id as <uid>_0 and an id already ending _0 kept", () => {
            const req = only("getGroupMembersInfo");
            assert.deepEqual([req.method, req.service, req.path], ["POST", "profile", "/api/social/group/members"]);
            assert.deepEqual(req.params, { friend_pversion_map: [`${U}_0`, `${U2}_0`] });
            assert.deepEqual(only("getGroupMembersInfo/one").params, { friend_pversion_map: [`${U}_0`] });
            // The keys come back as Zalo sent them, with or without _0 (the engine strips them itself).
            assert.deepEqual(Object.keys(recs.getGroupMembersInfo.own.result.profiles), [`${U}_0`, U2]);
        });

        it("createGroup: a GET with params in the query, memberTypes -1 each, groupType 1, no zsource", () => {
            const req = only("createGroup");
            assert.deepEqual([req.method, req.service, req.path], ["GET", "group", "/api/group/create/v2"]);
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.deepEqual(req.params, {
                clientId: T0,
                gname: "Fake group",
                gdesc: null,
                members: [U, U2],
                memberTypes: [-1, -1],
                nameChanged: 1,
                createLink: 1,
                clientLang: "vi",
                imei: FAKE.imei,
                groupType: 1,
            });
            // Zalo's own spelling of the field stays as it came.
            assert.deepEqual(recs.createGroup.own.result.sucessMembers, [U]);
        });

        it("changeGroupOwner: a form POST with {grid, newAdminId, imei, language}", () => {
            const req = only("changeGroupOwner");
            assert.deepEqual([req.method, req.service, req.path], ["POST", "group", "/api/group/change-owner"]);
            assert.deepEqual(req.formOrder, ["params"]);
            assert.deepEqual(req.paramsOrder, ["grid", "newAdminId", "imei", "language"]);
            assert.deepEqual(req.params, { grid: G, newAdminId: U, imei: FAKE.imei, language: "vi" });
        });

        it("leaveGroup: silent reaches the wire as 1 or 0", () => {
            assert.deepEqual(only("leaveGroup").params, { grids: [G], imei: FAKE.imei, silent: 0, language: "vi" });
            assert.equal(only("leaveGroup/silent").params.silent, 1);
        });

        it("changeGroupAvatar: a multipart POST on file with the image as fileContent and 160 px", () => {
            const req = only("changeGroupAvatar");
            assert.deepEqual([req.method, req.service, req.path], ["POST", "file", "/api/group/upavatar"]);
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.equal(req.headers["content-type"], "multipart/form-data; boundary=<boundary>");
            assert.deepEqual(
                req.parts.map(({ name, filename, type, size }) => ({ name, filename, type, size })),
                [{ name: "fileContent", filename: "blob", type: "image/jpeg", size: AVATAR.length }],
            );
            // T0 is 2023-11-14T22:13:20Z, 05:13 on the 15th in the harness's zone (Asia/Ho_Chi_Minh).
            assert.deepEqual(req.params, {
                grid: G,
                avatarSize: 160,
                clientId: `${FAKE.ownId}05:13 15/11/2023`,
                originWidth: 640,
                originHeight: 480,
                imei: FAKE.imei,
            });
            const bytes = only("changeGroupAvatar/bytes");
            assert.deepEqual([bytes.params.originWidth, bytes.params.originHeight], [10, 20]);
        });

        it("disperseGroup: a form POST with {imei, grid} in that order", () => {
            const req = only("disperseGroup");
            assert.deepEqual([req.method, req.path], ["POST", "/api/group/disperse"]);
            assert.deepEqual(req.paramsOrder, ["imei", "grid"]);
        });

        it("the link and invitation-box reads ask for 160 px avatars, with the default pages", () => {
            assert.deepEqual(only("getGroupLinkInfo").params, {
                link: LINK,
                avatar_size: 160,
                member_avatar_size: 160,
                mpage: 1,
            });
            assert.equal(only("getGroupLinkInfo/page").params.mpage, 2);
            assert.deepEqual(only("getGroupInviteBoxList").params, {
                mpage: 1,
                page: 0,
                invPerPage: 12,
                mcount: 10,
                lastGroupId: null,
                avatar_size: 160,
                member_avatar_size: 160,
            });
        });

        it("deleteGroupInviteBox: invitations is a JSON string of [{grid}], block 1 or 0", () => {
            assert.deepEqual(only("deleteGroupInviteBox").params, {
                invitations: JSON.stringify([{ grid: G }, { grid: G2 }]),
                block: 0,
            });
            assert.equal(only("deleteGroupInviteBox/block").params.block, 1);
        });

        it("reviewPendingMemberRequest: isApprove 1 or 0, a lone member as a list", () => {
            assert.deepEqual(only("reviewPendingMemberRequest").params, {
                grid: G,
                members: [U, U2],
                isApprove: 1,
            });
            assert.deepEqual(only("reviewPendingMemberRequest/reject").params, { grid: G, members: [U], isApprove: 0 });
        });

        it("every other call is a sealed GET on the group host (the admin, link and invitation calls)", () => {
            const gets = [
                "addGroupDeputy",
                "removeGroupDeputy",
                "addGroupBlockedMember",
                "removeGroupBlockedMember",
                "getGroupBlockedMember",
                "upgradeGroupToCommunity",
                "joinGroupLink",
                "getPendingGroupMembers",
                "enableGroupLink",
                "disableGroupLink",
                "getGroupLinkDetail",
                "joinGroupInviteBox",
                "inviteUserToGroups",
            ];
            for (const name of gets) {
                const req = only(name);
                assert.deepEqual([req.method, req.service], ["GET", "group"], name);
                assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"], name);
                assert.equal(req.headers["content-type"], undefined, `${name}: no content type on a GET`);
            }
            assert.deepEqual(only("getGroupBlockedMember").params, { grid: G, page: 1, count: 50, imei: FAKE.imei });
            assert.deepEqual(only("upgradeGroupToCommunity").params, { grId: G, language: "vi" });
            assert.deepEqual(only("inviteUserToGroups").params, {
                grids: [G, G2],
                member: U,
                memberType: -1,
                srcInteraction: 2,
                clientLang: "vi",
            });
            assert.deepEqual(only("inviteUserToGroups/one").params.grids, [G]);
        });
    });

    describe("batches", () => {
        it("getGroupInfo asks 100 groups at a time and merges the answers", async () => {
            const ids = groupIds(150);
            const rec = await pair.run("getGroupInfo", [ids], {
                replies: {
                    "/api/group/getmg-v2": [
                        // One group answered per batch keeps the golden entry small; what matters is the merge.
                        { data: groupInfoReply([ids[0]]) },
                        { data: groupInfoReply([ids[100]], { removedsGroup: ["9000000000000000199"] }) },
                    ],
                },
            });
            const [first, second] = rec.own.requests;
            assert.equal(rec.own.requests.length, 2);
            assert.deepEqual(Object.keys(JSON.parse(first.params.gridVerMap)), ids.slice(0, 100));
            assert.deepEqual(Object.keys(JSON.parse(second.params.gridVerMap)), ids.slice(100));
            assert.deepEqual(
                Object.keys(rec.own.result.gridInfoMap),
                [ids[0], ids[100]],
                "both batches' answers are in it",
            );
            assert.deepEqual(rec.own.result.removedsGroup, ["9000000000000000199"]);
            sameWire(rec, "getGroupInfo/batches");
            await expectGolden("groups", "getGroupInfo/batches", rec.own);
        });

        it("getGroupMembersInfo asks 300 ids at a time and merges the profiles", async () => {
            const ids = userIds(350);
            const profiles = (list) => ({
                profiles: Object.fromEntries(list.map((id) => [`${id}_0`, { zaloName: `z${id.slice(-3)}` }])),
                unchangeds_profile: [],
            });
            const rec = await pair.run("getGroupMembersInfo", [ids], {
                replies: {
                    "/api/social/group/members": [{ data: profiles([ids[0]]) }, { data: profiles([ids[300]]) }],
                },
            });
            assert.equal(rec.own.requests.length, 2);
            assert.equal(rec.own.requests[0].params.friend_pversion_map.length, 300);
            assert.deepEqual(
                rec.own.requests[1].params.friend_pversion_map,
                ids.slice(300).map((id) => `${id}_0`),
            );
            assert.deepEqual(
                Object.keys(rec.own.result.profiles),
                [`${ids[0]}_0`, `${ids[300]}_0`],
                "both batches' profiles",
            );
            sameWire(rec, "getGroupMembersInfo/batches");
            await expectGolden("groups", "getGroupMembersInfo/batches", rec.own);
        });
    });

    describe("refusals before any request", () => {
        it("createGroup leaves the own account out of members", async () => {
            const rec = await pair.run("createGroup", () => [{ name: "With me", members: [FAKE.ownId, U] }], {
                reply: { groupId: G, sucessMembers: [U], errorMembers: [] },
            });
            assert.deepEqual(rec.own.requests[0].params.members, [U]);
            assert.deepEqual(rec.own.requests[0].params.memberTypes, [-1]);
            sameWire(rec, "createGroup/withSelf");
            await expectGolden("groups", "createGroup/withSelf", rec.own);
        });

        it("createGroup refuses an empty name, which zca-js replaced by a timestamp", async () => {
            const rec = await pair.run("createGroup", () => [{ name: "", members: [U] }], { reply: { groupId: G } });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "A group name must not be empty", code: null });
            sameWire(rec, "createGroup/emptyName", { inherit: false });
            await expectGolden("groups", "createGroup/emptyName", rec.own);
        });

        it("createGroup refuses a group with no other member, as zca-js did", async () => {
            for (const members of [[], [FAKE.ownId]]) {
                const rec = await pair.run("createGroup", () => [{ name: "Alone", members }], { reply: {} });
                assert.equal(rec.own.requests.length, 0);
                assert.deepEqual(rec.own.error, { message: "Group must have at least one member", code: null });
                if (members.length === 0) sameWire(rec, "createGroup/noMember", { inherit: false });
            }
        });

        it("changeGroupName refuses an empty name, which zca-js replaced by a timestamp", async () => {
            const rec = await pair.run("changeGroupName", ["", G], { reply: "" });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "A group name must not be empty", code: null });
            sameWire(rec, "changeGroupName/emptyName", { inherit: false });
            await expectGolden("groups", "changeGroupName/emptyName", rec.own);
        });
    });

    describe("errors: the same code (and message, where zca-js wrote the same text) for every method", () => {
        const ERRORS = [
            [
                "an outer error",
                { outer: { error_code: 102, error_message: "fake outer" } },
                { message: "fake outer", code: 102 },
            ],
            [
                "an inner error",
                { inner: { error_code: 114, error_message: "fake inner" } },
                { message: "fake inner", code: 114 },
            ],
            ["HTTP 500", { status: 500 }, { message: "HTTP 500", code: null }],
            [
                "an undecryptable data",
                { undecryptable: true },
                { message: "Failed to parse response data", code: null },
            ],
        ];
        for (const method of METHODS) {
            it(method, async () => {
                for (const [what, error, expected] of ERRORS) {
                    const rec = await pair.run(method, ERROR_CALLS[method], { error });
                    assert.deepEqual(rec.own.error, expected, `${method}, ${what}`);
                    assert.equal(rec.zca.error?.code, expected.code, `${method}, ${what}: zca-js's code`);
                    sameWire(rec, method);
                }
            });
        }

        it("keeps the codes the MCP tools map: 165 and 166 on kickout, 166 and 167 on leave", async () => {
            const cases = [
                ["removeUserFromGroup", [[U], G], 165],
                ["removeUserFromGroup", [[U], G], 166],
                ["leaveGroup", [G, false], 166],
                ["leaveGroup", [G, true], 167],
            ];
            for (const [method, args, code] of cases) {
                const rec = await pair.run(method, args, {
                    error: { inner: { error_code: code, error_message: "fake" } },
                });
                // Red if the code were lost or turned into text: mcp-tools reads e.code for exactly these.
                assert.deepEqual(rec.own.error, { message: "fake", code }, `${method} ${code}`);
                sameWire(rec, method);
            }
        });
    });
});
