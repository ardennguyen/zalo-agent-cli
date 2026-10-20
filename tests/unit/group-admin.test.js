/**
 * src/core/group-admin.js -- how `zalo_group` reads Zalo's answers.
 *
 * Zalo reports a partial failure inside a successful reply (`errorMembers`),
 * and zca-js spells one of its fields `sucessMembers`. These pin both, plus the
 * group-details reshape that deliberately leaves the member list to
 * `zalo_get_group_members`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NOT_A_MEMBER, createdGroupFrom, groupInfoFrom, memberChangeFrom } from "../../src/core/group-admin.js";

const G = "7000000000000000001";
const A = "9100000000000000001";
const B = "9100000000000000002";

describe("groupInfoFrom", () => {
    const full = {
        gridInfoMap: {
            [G]: {
                groupId: G,
                name: "Team",
                desc: "",
                type: 1,
                creatorId: A,
                adminIds: [A, B],
                memVerList: [`${A}_0`, `${B}_0`],
                totalMember: 2,
                maxMember: 200,
                createdTime: 1790000000000,
                fullAvt: "https://example.invalid/full.jpg",
                avt: "https://example.invalid/small.jpg",
                visibility: 0,
                pendingApprove: { time: 1, uids: [B] },
                setting: { joinAppr: 1 },
            },
        },
    };

    it("reports the group's details and leaves the member list to zalo_get_group_members", () => {
        const info = groupInfoFrom(full, G);
        assert.deepEqual(info, {
            groupId: G,
            name: "Team",
            description: null,
            type: 1,
            creatorId: A,
            adminIds: [A, B],
            totalMember: 2,
            maxMember: 200,
            createdAt: new Date(1790000000000).toISOString(),
            avatar: "https://example.invalid/full.jpg",
            visibility: 0,
            pendingApproval: 1,
            settings: { joinAppr: 1 },
        });
        assert.ok(!("members" in info) && !("memVerList" in info));
    });

    it("is null for a group Zalo's answer does not include, and survives a thin answer", () => {
        assert.equal(groupInfoFrom({ gridInfoMap: {} }, G), null);
        assert.equal(groupInfoFrom(undefined, G), null);
        const thin = groupInfoFrom({ gridInfoMap: { [G]: { name: "N" } } }, G);
        assert.equal(thin.groupId, G);
        assert.deepEqual(thin.adminIds, []);
        assert.equal(thin.pendingApproval, 0);
        assert.equal(thin.createdAt, null);
    });
});

describe("createdGroupFrom", () => {
    it("reads zca-js's misspelled sucessMembers, and the corrected spelling too", () => {
        assert.deepEqual(createdGroupFrom({ groupId: G, sucessMembers: [A], errorMembers: [B] }, [A, B]), {
            groupId: G,
            added: [A],
            failed: [B],
        });
        // Zalo's own list wins over the inference: B is neither added nor listed as failed here, so
        // only reading `sucessMembers` gives [A] (inferring from the requested ids would give [A, B]).
        assert.deepEqual(createdGroupFrom({ groupId: G, sucessMembers: [A], errorMembers: [] }, [A, B]).added, [A]);
        assert.deepEqual(createdGroupFrom({ groupId: G, successMembers: [A, B], errorMembers: [] }, [A, B]).added, [
            A,
            B,
        ]);
    });

    it("works out who was added when Zalo lists no successes, and has no group id when none came back", () => {
        assert.deepEqual(createdGroupFrom({ groupId: G, errorMembers: [B] }, [A, B]).added, [A]);
        assert.equal(createdGroupFrom({}, [A]).groupId, null);
        assert.equal(createdGroupFrom(undefined, [A]).groupId, null);
    });
});

describe("memberChangeFrom", () => {
    it("separates the members Zalo took from the ones it refused", () => {
        assert.deepEqual(memberChangeFrom({ errorMembers: [B], error_data: { 270: [B] } }, [A, B]), {
            done: [A],
            failed: [B],
            errorData: { 270: [B] },
        });
    });

    it("treats an empty error list and an empty error_data as success", () => {
        assert.deepEqual(memberChangeFrom({ errorMembers: [], error_data: {} }, [A]), {
            done: [A],
            failed: [],
            errorData: null,
        });
        assert.deepEqual(memberChangeFrom(undefined, [A]).done, [A]);
    });

    it("exports the code zca-js documents for leaving a group you are not in", () => {
        assert.equal(NOT_A_MEMBER, 166);
    });
});
