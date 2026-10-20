/**
 * `friend search` finds a friend by the alias the account owner gave them.
 *
 * The command matched `displayName` and `zaloName` only. The alias is not in
 * `getAllFriends`; it comes from a separate list (`getAliasList`), so a friend
 * saved as "Arden AI" could not be found by that name. These run the pure
 * matcher, then the real command over zca-js's own HTTP seam with a friend
 * list and an alias list.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerFriendCommands } from "../../src/commands/friend.js";
import { searchFriends } from "../../src/core/friend-search.js";
import { installFakeZalo, loginFake, runCommand } from "./fake-zalo-session.js";

const A = "9100000000000000001";
const B = "9100000000000000002";
const C = "9100000000000000003";
const D = "9100000000000000004";
const FRIENDS = [
    { userId: A, displayName: "Companion Account", zaloName: "Companion Account" },
    { userId: B, displayName: "Bình", zaloName: "Nguyễn Thanh Bình" },
    { userId: C, displayName: "Someone Else", zaloName: "Someone Else" },
    { userId: D, displayName: "Nickname Only", zaloName: "Real Name" },
];

describe("searchFriends", () => {
    const aliases = new Map([[A, "Arden AI"]]);

    it("finds a friend by the owner's alias, and says which alias it was", () => {
        const m = searchFriends(FRIENDS, aliases, "arden ai");
        assert.deepEqual(
            m.map((f) => [f.userId, f.alias]),
            [[A, "Arden AI"]],
        );
    });

    it("still finds by display name and Zalo name, case-insensitively, and adds no alias field when there is none", () => {
        assert.deepEqual(
            searchFriends(FRIENDS, aliases, "COMPANION").map((f) => f.userId),
            [A],
        );
        const byZaloName = searchFriends(FRIENDS, aliases, "thanh");
        assert.deepEqual(
            byZaloName.map((f) => f.userId),
            [B],
        );
        assert.ok(!("alias" in byZaloName[0]));
        // The display name alone (it differs from the Zalo name and there is no alias).
        assert.deepEqual(
            searchFriends(FRIENDS, aliases, "nickname").map((f) => f.userId),
            [D],
        );
    });

    it("matches a substring of the alias and returns each friend once", () => {
        const both = new Map([[B, "Companion pal"]]);
        // B matches "companion" through its alias only; A through its display name; neither twice.
        assert.deepEqual(
            searchFriends(FRIENDS, both, "companion")
                .map((f) => f.userId)
                .sort(),
            [A, B],
        );
    });

    it("does not mutate the friend list, ignores an alias for someone who is not a friend, and survives no aliases", () => {
        const before = JSON.stringify(FRIENDS);
        searchFriends(FRIENDS, aliases, "arden");
        assert.equal(JSON.stringify(FRIENDS), before);
        assert.deepEqual(searchFriends(FRIENDS, new Map([["9100000000000000099", "Ghost"]]), "ghost"), []);
        assert.deepEqual(searchFriends(FRIENDS, undefined, "someone").length, 1);
        assert.deepEqual(searchFriends(undefined, aliases, "x"), []);
    });
});

describe("friend search over the wire", () => {
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
        fake.route("/api/social/friend/getfriends", () => FRIENDS);
        fake.route("/api/alias/list", () => ({ items: [{ userId: A, alias: "Arden AI" }] }));
    });

    it("finds a friend by alias and reports the alias", async () => {
        const r = await runCommand(registerFriendCommands, ["--json", "friend", "search", "Arden AI"]);
        assert.equal(r.exitCode, null, `search failed: ${r.stdout} ${r.stderr}`);
        const out = JSON.parse(r.stdout);
        assert.deepEqual(
            out.map((f) => [f.userId, f.alias]),
            [[A, "Arden AI"]],
        );
        // Red if the command goes back to matching names only: the alias list is never asked for.
        assert.equal(fake.calls("/api/alias/list").length, 1);
    });

    it("still finds by name, and falls back to names alone when the alias list cannot be read", async () => {
        fake.route("/api/alias/list", () => {
            throw new Error("alias service down");
        });
        const r = await runCommand(registerFriendCommands, ["--json", "friend", "search", "someone"]);
        assert.deepEqual(
            JSON.parse(r.stdout).map((f) => f.userId),
            [C],
        );
    });
});
