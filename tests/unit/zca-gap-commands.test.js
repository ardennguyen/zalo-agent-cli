/**
 * The commands that wrap zca-js calls the CLI had never used, driven end to end offline.
 *
 * A gap sweep found 21 zca-js methods with no command. Each now has one, and
 * each test here runs the real command over zca-js's own HTTP seam
 * (./fake-zalo-session.js), then checks what went out on the wire -- service
 * host, path, method and decrypted params -- and what the command printed from
 * the answer. A command that reached the wrong endpoint, swapped two
 * arguments, or dropped a flag fails here without a Zalo account.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { registerFriendCommands } from "../../src/commands/friend.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { registerProfileCommands } from "../../src/commands/profile.js";
import { registerCatalogCommands } from "../../src/commands/catalog.js";
import { registerBankCommands } from "../../src/commands/bank.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serviceHost } from "./fake-zalo-session.js";

const U = "9100000000000000001";
const U2 = "9100000000000000002";
const G = "7000000000000000001";

describe("zca-js gap commands over the wire", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1"; // what `--json` sets in src/index.js
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    /** Run one command with `--json`; returns its parsed stdout (or raw text) and the requests it made. */
    async function run(register, argv, route) {
        if (route) for (const [suffix, handler] of Object.entries(route)) fake.route(suffix, handler);
        const r = await runCommand(register, ["--json", ...argv]);
        let out = r.stdout;
        try {
            out = JSON.parse(r.stdout);
        } catch {
            /* human text */
        }
        return { ...r, out };
    }
    /** The single request whose path contains `part`, which must exist exactly once. */
    function one(part) {
        const calls = fake.calls(part);
        assert.equal(calls.length, 1, `expected one ${part} request, got ${calls.length}`);
        return calls[0];
    }
    const ok = (r) => assert.equal(r.exitCode, null, `command failed: ${r.stdout} ${r.stderr}`);
    // This CLI reports a failure as a printed {"error": ...} (with --json) and exits 0, so a refusal is read from its output.
    const failed = (r, re, what = "") => {
        assert.equal(typeof r.out?.error, "string", `${what} expected an error, got: ${r.stdout}`);
        if (re) assert.match(r.out.error, re, what);
    };

    describe("msg", () => {
        it("typing sends the indicator to a user, then to a group", async () => {
            let r = await run(registerMsgCommands, ["msg", "typing", U], {
                "/api/message/typing": () => ({ status: 0 }),
            });
            ok(r);
            let req = one("/api/message/typing");
            assert.equal(req.host, serviceHost("chat"));
            assert.equal(req.method, "POST");
            assert.equal(req.params.toid, U);
            assert.equal(req.params.imei, FAKE.imei);

            fake.requests.length = 0;
            r = await run(registerMsgCommands, ["msg", "typing", G, "-t", "1"], {
                "/api/group/typing": () => ({ status: 0 }),
            });
            ok(r);
            req = one("/api/group/typing");
            assert.equal(req.host, serviceHost("group"));
            assert.equal(req.params.grid, G);
            assert.ok(!("toid" in req.params));
        });

        it("typing refuses a thread type that is not 0 or 1, without a request", async () => {
            const r = await run(registerMsgCommands, ["msg", "typing", U, "-t", "2"]);
            failed(r, /--type must be 0/);
            assert.equal(fake.calls("/api/").filter((c) => !c.path.includes("login")).length, 0);
        });

        it("report sends the reason code and, for 'other', the text, to the user or group endpoint", async () => {
            const route = {
                "/api/report/abuse-v2": () => ({ reportId: "r1" }),
                "/api/social/profile/reportabuse": () => ({ reportId: "r2" }),
            };
            let r = await run(registerMsgCommands, ["msg", "report", U, "-r", "fraud"], route);
            ok(r);
            assert.equal(r.out.reportId, "r1");
            let req = one("/api/report/abuse-v2");
            assert.equal(req.host, serviceHost("profile"));
            assert.deepEqual(req.params, { idTo: U, objId: "person.profile", reason: "3" });

            fake.requests.length = 0;
            r = await run(registerMsgCommands, ["msg", "report", U, "-r", "other", "-c", "spam links"], route);
            ok(r);
            assert.deepEqual(one("/api/report/abuse-v2").params, {
                idTo: U,
                objId: "person.profile",
                reason: "0",
                content: "spam links",
            });

            fake.requests.length = 0;
            r = await run(registerMsgCommands, ["msg", "report", G, "-r", "sensitive", "-t", "1"], route);
            ok(r);
            req = one("/api/social/profile/reportabuse");
            assert.deepEqual(req.params, { uidTo: G, type: 14, reason: 1, content: "", imei: FAKE.imei });
        });

        it("report refuses a bad reason, 'other' without text, and text with another reason, without a request", async () => {
            for (const argv of [
                ["-r", "rude"],
                ["-r", "other"],
                ["-r", "annoy", "-c", "text that would be dropped"],
            ]) {
                const r = await run(registerMsgCommands, ["msg", "report", U, ...argv]);
                failed(r, undefined, argv.join(" "));
            }
            assert.equal(fake.calls("abuse").length + fake.calls("reportabuse").length, 0, "nothing was reported");
        });

        it("link-preview asks parselink for the link and prints what Zalo returned", async () => {
            const r = await run(registerMsgCommands, ["msg", "link-preview", "https://example.invalid/a"], {
                "/api/message/parselink": () => ({
                    data: { title: "T", desc: "D", src: "example.invalid" },
                    error_maps: {},
                }),
            });
            ok(r);
            const req = one("/api/message/parselink");
            assert.equal(req.host, serviceHost("file"));
            assert.equal(req.method, "GET");
            assert.deepEqual(req.params, { link: "https://example.invalid/a", version: 1, imei: FAKE.imei });
            assert.equal(r.out.data.title, "T");
        });

        it("scan-url reports Zalo's verdict", async () => {
            const r = await run(registerMsgCommands, ["msg", "scan-url", "https://example.invalid/x"], {
                "/api/message/scanurl": () => ({ isSafe: false }),
            });
            ok(r);
            assert.deepEqual(one("/api/message/scanurl").params, { url: "https://example.invalid/x" });
            assert.equal(r.out.isSafe, false);
        });
    });

    describe("friend", () => {
        it("qr asks for every id at once", async () => {
            const r = await run(registerFriendCommands, ["friend", "qr", U, U2], {
                "/api/friend/mget-qr": () => ({
                    [U]: "https://example.invalid/qr1",
                    [U2]: "https://example.invalid/qr2",
                }),
            });
            ok(r);
            const req = one("/api/friend/mget-qr");
            assert.equal(req.host, serviceHost("friend"));
            assert.deepEqual(req.params, { fids: [U, U2] });
            assert.deepEqual(Object.keys(r.out), [U, U2]);
        });

        it("common-groups sends the ids as a JSON string, the way zca-js does", async () => {
            const r = await run(registerFriendCommands, ["friend", "common-groups", U, U2], {
                "/api/friend/group/related": () => ({ groupRelateds: { [U]: [G] } }),
            });
            ok(r);
            assert.deepEqual(one("/api/friend/group/related").params, {
                friend_ids: JSON.stringify([U, U2]),
                imei: FAKE.imei,
            });
            assert.deepEqual(r.out.groupRelateds[U], [G]);
        });

        it("biz asks for the one user's business account", async () => {
            const r = await run(registerFriendCommands, ["friend", "biz", U], {
                "/api/social/friend/get-bizacc": () => ({ pkgId: 0 }),
            });
            ok(r);
            assert.deepEqual(one("/api/social/friend/get-bizacc").params, { fid: U });
        });

        it("block-feed hides by default and --unblock shows again", async () => {
            const route = { "/api/friend/feed/block": () => "" };
            ok(await run(registerFriendCommands, ["friend", "block-feed", U], route));
            assert.deepEqual(one("/api/friend/feed/block").params, { fid: U, isBlockFeed: 1, imei: FAKE.imei });
            fake.requests.length = 0;
            ok(await run(registerFriendCommands, ["friend", "block-feed", U, "--unblock"], route));
            // Red if the flag is parsed and then ignored: the wire would still say 1.
            assert.equal(one("/api/friend/feed/block").params.isBlockFeed, 0);
        });
    });

    describe("group", () => {
        it("link-preview asks for the link, with the member page", async () => {
            const link = "https://zalo.me/g/abcdef";
            const r = await run(registerGroupCommands, ["group", "link-preview", link, "-p", "2"], {
                "/api/group/link/ginfo": () => ({ groupId: G, name: "Linked", totalMember: 3 }),
            });
            ok(r);
            const req = one("/api/group/link/ginfo");
            assert.equal(req.host, serviceHost("group"));
            assert.deepEqual(req.params, { link, avatar_size: 120, member_avatar_size: 120, mpage: 2 });
            assert.equal(r.out.name, "Linked");
        });

        it("invite-info asks for the invitation with its page and count", async () => {
            const r = await run(registerGroupCommands, ["group", "invite-info", G, "--member-count", "5"], {
                "/api/group/inv-box/inv-info": () => ({
                    groupInfo: { groupId: G, topic: { params: "{}" } },
                    inviterInfo: {},
                }),
            });
            ok(r);
            assert.deepEqual(one("/api/group/inv-box/inv-info").params, { grId: G, mcount: 5, mpage: 1 });
            assert.equal(r.out.groupInfo.groupId, G);
        });

        it("invite-info works for a group with no topic (zca-js's own call throws there) and unpacks one that has it", async () => {
            // A group without a pinned message comes back with no `topic` at all.
            let r = await run(registerGroupCommands, ["group", "invite-info", G], {
                "/api/group/inv-box/inv-info": () => ({ groupInfo: { groupId: G }, inviterInfo: { id: U } }),
            });
            ok(r);
            assert.equal(typeof r.out.error, "undefined", r.stdout);
            assert.equal(r.out.inviterInfo.id, U);

            fake.requests.length = 0;
            r = await run(registerGroupCommands, ["group", "invite-info", G], {
                "/api/group/inv-box/inv-info": () => ({
                    groupInfo: { groupId: G, topic: { params: JSON.stringify({ extra: JSON.stringify({ k: 1 }) }) } },
                }),
            });
            ok(r);
            assert.deepEqual(r.out.groupInfo.topic.params, { extra: { k: 1 } });
        });
    });

    describe("conv, profile, catalog", () => {
        it("conv muted lists both kinds of muted entry", async () => {
            const r = await run(registerConvCommands, ["conv", "muted"], {
                "/api/social/profile/getmute": () => ({
                    chatEntries: [{ id: U, duration: -1, muteMode: 1 }],
                    groupChatEntries: [{ id: G, duration: 3600, muteMode: 1 }],
                }),
            });
            ok(r);
            const req = one("/api/social/profile/getmute");
            assert.equal(req.host, serviceHost("profile"));
            assert.deepEqual(req.params, { imei: FAKE.imei });
            assert.equal(r.out.chatEntries[0].id, U);
            assert.equal(r.out.groupChatEntries[0].id, G);
        });

        it("profile active on pings, off deactivates", async () => {
            const route = {
                "/api/social/profile/ping": () => ({ status: true }),
                "/api/social/profile/deactive": () => ({ status: true }),
            };
            ok(await run(registerProfileCommands, ["profile", "active", "on"], route));
            assert.deepEqual(one("/api/social/profile/ping").params, { status: 1, imei: FAKE.imei });
            assert.equal(fake.calls("/deactive").length, 0);
            fake.requests.length = 0;
            ok(await run(registerProfileCommands, ["profile", "active", "off"], route));
            assert.deepEqual(one("/api/social/profile/deactive").params, { status: 0, imei: FAKE.imei });
            assert.equal(fake.calls("/ping").length, 0);
        });

        it("profile active refuses anything but on/off without a request", async () => {
            const r = await run(registerProfileCommands, ["profile", "active", "maybe"]);
            failed(r, /must be "on" or "off"/);
            assert.equal(fake.calls("/api/social/profile/").length, 0);
        });

        it("profile lang sends VI or EN and refuses other languages", async () => {
            const route = { "/api/social/profile/updatelang": () => "" };
            ok(await run(registerProfileCommands, ["profile", "lang", "en"], route));
            assert.deepEqual(one("/api/social/profile/updatelang").params, { language: "EN" });
            fake.requests.length = 0;
            ok(await run(registerProfileCommands, ["profile", "lang", "VI"], route));
            assert.equal(one("/api/social/profile/updatelang").params.language, "VI");
            fake.requests.length = 0;
            const bad = await run(registerProfileCommands, ["profile", "lang", "fr"]);
            failed(bad, /language must be one of/);
            assert.equal(fake.calls("updatelang").length, 0);
        });

        it("profile lost-focus posts to changefgtobg", async () => {
            ok(
                await run(registerProfileCommands, ["profile", "lost-focus"], {
                    "/api/social/profile/changefgtobg": () => ({ status: true }),
                }),
            );
            const req = one("/api/social/profile/changefgtobg");
            assert.equal(req.method, "POST");
            assert.deepEqual(req.params, {});
        });

        it("catalog register on/off sends enable 1/0", async () => {
            const route = { "/api/prodcatalog/catalog/register": () => "" };
            ok(await run(registerCatalogCommands, ["catalog", "register", "on"], route));
            const req = one("/api/prodcatalog/catalog/register");
            assert.equal(req.host, serviceHost("catalog"));
            assert.deepEqual(req.params, { enable: 1 });
            fake.requests.length = 0;
            ok(await run(registerCatalogCommands, ["catalog", "register", "off"], route));
            assert.deepEqual(one("/api/prodcatalog/catalog/register").params, { enable: 0 });
        });
    });

    describe("bank", () => {
        const ACCOUNT = {
            id: "a1",
            bin: 970448,
            default: false,
            bank_number: "123456789",
            holder_name: "TEST HOLDER",
            account_id: 42,
        };

        it("list reads the directory and --query filters it", async () => {
            const banks = [
                {
                    bin: 970448,
                    name: "Ngân hàng Phương Đông",
                    short_name: "OCB",
                    name_eng: "Orient",
                    search_key_word: "ocb",
                },
                {
                    bin: 970436,
                    name: "Ngoại thương",
                    short_name: "Vietcombank",
                    name_eng: "Vietcombank",
                    search_key_word: "vcb",
                },
            ];
            const route = { "/api/transfer/conf": () => ({ banks }) };
            let r = await run(registerBankCommands, ["bank", "list"], route);
            ok(r);
            assert.equal(one("/api/transfer/conf").host, serviceHost("zimsg"));
            assert.equal(r.out.banks.length, 2);
            r = await run(registerBankCommands, ["bank", "list", "-q", "vcb"], route);
            assert.deepEqual(
                r.out.banks.map((b) => b.bin),
                [970436],
            );
        });

        it("accounts passes the page and limit", async () => {
            const r = await run(registerBankCommands, ["bank", "accounts", "-p", "1", "-l", "5"], {
                "/api/transfer/list": () => ({ hasMore: false, total: 1, myBanks: [ACCOUNT] }),
            });
            ok(r);
            assert.deepEqual(one("/api/transfer/list").params, { page: 1, limit: 5 });
            assert.equal(r.out.myBanks[0].account_id, 42);
        });

        it("add resolves the bank to its BIN and sends number and holder", async () => {
            const r = await run(registerBankCommands, ["bank", "add", "123456789", "-b", "ocb", "-n", "Test Holder"], {
                "/api/transfer/create": () => ACCOUNT,
            });
            ok(r);
            const req = one("/api/transfer/create");
            assert.equal(req.method, "POST");
            assert.equal(req.params.bin, 970448);
            assert.equal(req.params.bank_number, "123456789");
            assert.match(req.params.holder_name, /TEST HOLDER/i);
        });

        it("add and update refuse an unknown bank without a request", async () => {
            for (const argv of [
                ["add", "1", "-b", "nosuchbank", "-n", "X"],
                ["update", "42", "1", "-b", "nosuchbank", "-n", "X"],
            ]) {
                const r = await run(registerBankCommands, ["bank", ...argv]);
                failed(r, /Unknown bank/, argv[0]);
            }
            assert.equal(fake.calls("/api/transfer/").length, 0);
        });

        it("update sends the account id as a number with the new details", async () => {
            const r = await run(
                registerBankCommands,
                ["bank", "update", "42", "987654321", "-b", "970448", "-n", "New Name"],
                {
                    "/api/transfer/update": () => ACCOUNT,
                },
            );
            ok(r);
            const p = one("/api/transfer/update").params;
            assert.equal(p.account_id, 42);
            assert.equal(typeof p.account_id, "number");
            assert.equal(p.bin, 970448);
            assert.equal(p.bank_number, "987654321");
        });

        it("remove looks the account up first and passes whether it is the default", async () => {
            const route = {
                "/api/transfer/list": () => ({
                    hasMore: false,
                    total: 2,
                    myBanks: [
                        { ...ACCOUNT, account_id: 7 },
                        { ...ACCOUNT, account_id: 42, default: true },
                    ],
                }),
                "/api/transfer/delete": () => ({ hasMore: false, total: 1, myBanks: [] }),
            };
            ok(await run(registerBankCommands, ["bank", "remove", "42"], route));
            // Red if is_default is hard-coded or guessed instead of read from the saved account.
            assert.deepEqual(one("/api/transfer/delete").params.account_id, 42);
            assert.equal(one("/api/transfer/delete").params.is_default, true);
            fake.requests.length = 0;
            ok(await run(registerBankCommands, ["bank", "remove", "7"], route));
            assert.equal(one("/api/transfer/delete").params.is_default, false);
        });

        it("remove deletes nothing when the id is not a saved account", async () => {
            const r = await run(registerBankCommands, ["bank", "remove", "999"], {
                "/api/transfer/list": () => ({ hasMore: false, total: 1, myBanks: [ACCOUNT] }),
            });
            failed(r, /No saved bank account with id 999/);
            assert.equal(fake.calls("/api/transfer/delete").length, 0);
        });
    });
});
