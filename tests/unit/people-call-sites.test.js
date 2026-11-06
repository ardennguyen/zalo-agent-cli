/**
 * The engine's people and conversation call sites, driven end to end offline (design 6.2, package FX).
 *
 * Each test runs the real command over the fake Zalo server (./fake-zalo-session.js) and checks what it printed
 * from Zalo's answer, or what it sent. They pin call-site fixes that a wire test of the endpoint alone cannot see:
 *
 * - `friend find-username` reads the snake_case names Zalo answers with (spec-people 4);
 * - `friend sent-requests` reads "none sent" from the engine's `{}` (Zalo's 112), never from an error's text;
 * - `friend undo-request` explains Zalo's 301 (too many requests taken back), in Zalo Web's sense;
 * - `group info` asks for its one group as a list;
 * - `conv mute` / `conv unmute` send the mute action Zalo expects (1 and 3);
 * - the media renewal of a restore (src/core/sync-v2/renewlink.js) seals its request on the session.
 *
 * Every id is made up.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getApi } from "../../src/core/zalo-client.js";
import { registerFriendCommands } from "../../src/commands/friend.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { makeRenewLink } from "../../src/core/sync-v2/renewlink.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serviceHost } from "./fake-zalo-session.js";

const U = "9100000000000000071";
const U2 = "9100000000000000072";
const G = "7000000000000000071";

describe("people call sites over the wire", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        delete process.env.ZALO_JSON_MODE; // human output: these tests read what a person sees
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    /** Run one command in human mode; `text` is everything it printed, colors and all. */
    async function run(register, argv) {
        const r = await runCommand(register, argv);
        return { ...r, text: `${r.stdout}\n${r.stderr}` };
    }

    /** The single request whose path contains `part`. */
    function one(part) {
        const calls = fake.calls(part);
        assert.equal(calls.length, 1, `expected one ${part} request, got ${calls.length}`);
        return calls[0];
    }

    describe("friend find-username", () => {
        it("prints the name from Zalo's snake_case answer", async () => {
            fake.route("/api/friend/search/by-user-name", () => ({
                uid: U,
                display_name: "Fake Display",
                zalo_name: "Fake Zalo",
                avatar: "https://avatar.invalid/a.jpg",
            }));
            const r = await run(registerFriendCommands, ["friend", "find-username", "fake.user"]);
            assert.equal(one("/api/friend/search/by-user-name").params.user_name, "fake.user");
            assert.match(r.text, new RegExp(`User ID: ${U}`));
            // Red while only displayName/zaloName are read: the name printed was "?".
            assert.match(r.text, /Name: Fake Display/);
        });

        it("falls back to the Zalo name, then to the camelCase names", async () => {
            fake.route("/api/friend/search/by-user-name", () => ({ uid: U, zalo_name: "Only Zalo Name" }));
            let r = await run(registerFriendCommands, ["friend", "find-username", "fake.user"]);
            assert.match(r.text, /Name: Only Zalo Name/);

            fake.route("/api/friend/search/by-user-name", () => ({ uid: U, displayName: "Camel Name" }));
            r = await run(registerFriendCommands, ["friend", "find-username", "fake.user"]);
            assert.match(r.text, /Name: Camel Name/);
        });
    });

    describe("friend sent-requests", () => {
        it("Zalo's 'none sent' (112) reads as no sent requests, not as a failure or a count of 0", async () => {
            fake.routeAnswer("/api/friend/requested/list", {
                inner: { error_code: 112, error_message: "fake: nothing" },
            });
            const r = await run(registerFriendCommands, ["friend", "sent-requests"]);
            assert.equal(one("/api/friend/requested/list").method, "GET");
            // Red before the fix: the engine answers 112 with {}, which printed "0 sent request(s)".
            assert.match(r.text, /No sent friend requests/);
            assert.doesNotMatch(r.text, /failed|✗/);
        });

        it("an empty answer reads the same", async () => {
            fake.route("/api/friend/requested/list", () => ({}));
            const r = await run(registerFriendCommands, ["friend", "sent-requests"]);
            assert.match(r.text, /No sent friend requests/);
        });

        it("lists what Zalo has, keyed by user id", async () => {
            fake.route("/api/friend/requested/list", () => ({
                [U]: { userId: U, displayName: "First Fake", fReqInfo: { message: "hi", time: 1790000000 } },
                [U2]: { userId: U2, zaloName: "Second Fake" },
            }));
            const r = await run(registerFriendCommands, ["friend", "sent-requests"]);
            assert.match(r.text, /2 sent request\(s\)/);
            assert.match(r.text, new RegExp(`${U}  First Fake`));
            assert.match(r.text, new RegExp(`${U2}  Second Fake`));
        });

        it("another error is reported as a failure, whatever its text says", async () => {
            fake.routeAnswer("/api/friend/requested/list", {
                inner: { error_code: 500, error_message: "fake failure 112" },
            });
            const r = await run(registerFriendCommands, ["friend", "sent-requests"]);
            // Red while the code is looked for in the message: "112" in the text read as "none sent".
            assert.match(r.text, /Get sent requests failed: fake failure 112/);
            assert.doesNotMatch(r.text, /No sent friend requests/);
        });
    });

    describe("friend undo-request", () => {
        it("explains Zalo's 301 the way Zalo Web does: too many taken back, wait 24 hours", async () => {
            fake.routeAnswer("/api/friend/undo", { inner: { error_code: 301, error_message: "fake refusal" } });
            const r = await run(registerFriendCommands, ["friend", "undo-request", U]);
            assert.deepEqual(one("/api/friend/undo").params, { fid: U });
            // Red without the 301 wording: Zalo's own message was printed bare.
            assert.match(r.text, /too many requests were taken back/);
            assert.match(r.text, /Try again in 24 hours \(code 301\)/);
        });

        it("any other refusal keeps Zalo's own message", async () => {
            fake.routeAnswer("/api/friend/undo", { inner: { error_code: 999, error_message: "fake other" } });
            const r = await run(registerFriendCommands, ["friend", "undo-request", U]);
            assert.match(r.text, /Undo friend request failed: fake other/);
        });
    });

    describe("group info", () => {
        it("asks getmg-v2 for that one group", async () => {
            fake.route("/api/group/getmg-v2", () => ({
                removedsGroup: [],
                unchangedsGroup: [],
                gridInfoMap: { [G]: { groupId: G, name: "Fake Group" } },
            }));
            const r = await run(registerGroupCommands, ["group", "info", G]);
            const req = one("/api/group/getmg-v2");
            assert.equal(req.host, serviceHost("group"));
            assert.deepEqual(JSON.parse(req.params.gridVerMap), { [G]: 0 });
            assert.match(r.text, /Fake Group/);
        });
    });

    describe("conv mute and unmute", () => {
        it("mute sends action 1 with the duration given; unmute sends action 3 and duration -1", async () => {
            fake.route("/api/social/profile/setmute", () => "");
            await run(registerConvCommands, ["conv", "mute", U, "-d", "3600"]);
            let req = one("/api/social/profile/setmute");
            assert.equal(req.host, serviceHost("profile"));
            assert.equal(req.params.toid, U);
            // Red if conv.js hands setMute the wrong action, or none (which mutes).
            assert.equal(req.params.action, 1);
            assert.equal(req.params.duration, 3600);
            assert.equal(req.params.muteType, 1);

            fake.requests.length = 0;
            await run(registerConvCommands, ["conv", "unmute", G, "-t", "1"]);
            req = one("/api/social/profile/setmute");
            assert.equal(req.params.toid, G);
            assert.equal(req.params.action, 3);
            assert.equal(req.params.duration, -1);
            assert.equal(req.params.muteType, 2);
        });
    });

    describe("media renewal (renewlink)", () => {
        it("POSTs the sealed request to the file service and hands back Zalo's answer", async () => {
            fake.route("/api/message/renewlink", () => ({ normalUrl: "https://media.invalid/fresh.jpg" }));
            const renew = makeRenewLink(getApi());
            const answer = await renew({
                threadId: G,
                threadType: "group",
                msgType: 32,
                clientId: "1790000000123",
                msgInfo: {
                    normalUrl: "jxl://media.invalid/old.jpg",
                    hdUrl: "https://media.invalid/old-hd.jpg",
                    thumbUrl: undefined,
                },
            });
            assert.deepEqual(answer, { normalUrl: "https://media.invalid/fresh.jpg" });

            const req = one("/api/message/renewlink");
            assert.equal(req.host, serviceHost("file"));
            assert.equal(req.method, "POST");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"], "params ride in the form, not the query");
            assert.ok(req.form?.params, "a sealed params field in the form");
            assert.deepEqual(req.params, {
                toId: G,
                msgType: 32,
                msgInfo: JSON.stringify({
                    normalUrl: "media.invalid/old.jpg",
                    hdUrl: "https://media.invalid/old-hd.jpg",
                    isE2EE: 0,
                    isOriginal: 0,
                }),
                clientId: "1790000000123",
                imei: FAKE.imei,
                isGroup: 1,
            });
        });

        it("a 1-1 thread takes the user form, and Zalo's refusal is thrown with its code", async () => {
            fake.routeAnswer("/api/message/renewlink", { inner: { error_code: 1012, error_message: "fake gone" } });
            const renew = makeRenewLink(getApi());
            const err = await renew({ threadId: U, threadType: "dm", msgType: 32, msgInfo: {} }).catch((e) => e);
            assert.equal(err.code, 1012);
            assert.match(err.message, /fake gone/);
            assert.equal(one("/api/message/renewlink").params.isGroup, 0);
        });
    });
});
