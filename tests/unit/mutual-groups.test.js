/**
 * Mutual groups, as Zalo shows "Nhóm chung (N)" on a profile and in a new chat (src/core/mutual-groups.js):
 * read from the profile's extra fields (`/api/social/profile/extra`, `groupIds`), groups in hidden chats left out,
 * named from the groups' info. Driven offline over the session's HTTP seam; the answers are hand-written.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerFriendCommands } from "../../src/commands/friend.js";
import { getApi } from "../../src/core/zalo-client.js";
import { mutualGroupsLine, mutualGroupsOf, mutualGroupsOrError } from "../../src/core/mutual-groups.js";
import { installFakeZalo, loginFake, runCommand } from "./fake-zalo-session.js";

const U = "9100000000000000001";
const G1 = "7000000000000000001";
const G2 = "7000000000000000002";
const HIDDEN = "7000000000000000003";

describe("mutual groups", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
        fake.route("/api/social/profile/extra", () => ({ groupIds: [G1, G2, HIDDEN], photos: [], totalPhotos: 0 }));
        fake.route("/api/group/getmg-v2", () => ({
            gridInfoMap: { [G1]: { groupId: G1, name: "Nhà mình" }, [G2]: { groupId: G2, name: "Công việc" } },
        }));
    });

    it("reads the profile's groupIds for the user, and names them from the groups' info", async () => {
        const m = await mutualGroupsOf(getApi(), U);
        const [req] = fake.calls("/api/social/profile/extra");
        assert.equal(req.params.profile_id, U);
        assert.equal(m.count, 3);
        assert.deepEqual(m.groups.slice(0, 2), [
            { groupId: G1, name: "Nhà mình" },
            { groupId: G2, name: "Công việc" },
        ]);
        assert.deepEqual(m.groups[2], { groupId: HIDDEN, name: null }, "a name Zalo did not give stays null");
    });

    it("leaves out a group in a hidden chat, and says how many", async () => {
        const hidden = { isHidden: (id) => id === HIDDEN };
        const m = await mutualGroupsOf(getApi(), U, { hidden });
        // Red if the hidden chat's group is counted or listed: that would reveal it.
        assert.equal(m.count, 2);
        assert.deepEqual(
            m.groups.map((g) => g.groupId),
            [G1, G2],
        );
        assert.equal(m.hiddenLeftOut, 1);
        assert.equal(fake.calls("/api/group/getmg-v2").length, 1);
        assert.doesNotMatch(JSON.stringify(fake.calls("/api/group/getmg-v2")[0].params), new RegExp(HIDDEN));
    });

    it("a failed read is an error field, never a throw, for a reply that must not fail because of it", async () => {
        fake.clearRoutes();
        fake.route("/api/social/profile/extra", () => {
            throw Object.assign(new Error("Tham số không hợp lệ"), { code: 114 });
        });
        const m = await mutualGroupsOrError(getApi(), U);
        assert.match(m.error, /could not read the shared groups/);
        assert.equal(await mutualGroupsOrError(getApi(), null), null);
    });

    it("the line a person reads: count and names, or none", () => {
        assert.equal(
            mutualGroupsLine({
                count: 2,
                groups: [
                    { groupId: G1, name: "A" },
                    { groupId: G2, name: null },
                ],
            }),
            `2 mutual groups: A (${G1}), ${G2}`,
        );
        assert.equal(mutualGroupsLine({ count: 0, groups: [] }), "No mutual groups");
        assert.match(mutualGroupsLine({ error: "x" }), /\?/);
    });

    it("`friend info` shows them, beside the profile", async () => {
        fake.route("/api/social/friend/getprofiles/v2", () => ({
            changed_profiles: { [U]: { userId: U, displayName: "Lan", zaloName: "Lan" } },
        }));
        const r = await runCommand(registerFriendCommands, ["--json", "friend", "info", U]);
        assert.equal(r.exitCode, null, r.stdout + r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.mutualGroups.count, 3);
        assert.equal(out.mutualGroups.groups[0].name, "Nhà mình");
    });
});
