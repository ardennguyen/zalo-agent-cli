/**
 * src/core/friend-requests.js -- how friend requests are read, for `friend` and `zalo_friend` alike.
 *
 * Zalo has no list of incoming requests: they ride in the recommendations feed
 * as items of type 2, among type-1 suggestions, so the filter is the whole
 * feature. These pin it, the timestamp-unit handling (not yet measured on a
 * live account) and the error wording shared with `friend add`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    RECEIVED_FRIEND_REQUEST,
    describeFriendAddError,
    extractErrorCode,
    friendStatusFrom,
    friendsFrom,
    receivedRequestsFrom,
    sentRequestsFrom,
    toIso,
} from "../../src/core/friend-requests.js";

describe("toIso", () => {
    it("reads a small number as seconds and a large one as milliseconds", () => {
        assert.equal(toIso(1790000000), "2026-09-21T14:13:20.000Z");
        assert.equal(toIso(1790000000000), "2026-09-21T14:13:20.000Z");
    });

    it("is null for anything that is not a time", () => {
        for (const bad of [undefined, null, "", 0, -5, "abc", NaN]) assert.equal(toIso(bad), null, String(bad));
    });
});

describe("receivedRequestsFrom", () => {
    const item = (userId, recommType, extra = {}) => ({ dataInfo: { userId, recommType, ...extra } });

    it("keeps type-2 items only, newest first, with the sender's message", () => {
        assert.equal(RECEIVED_FRIEND_REQUEST, 2);
        const out = receivedRequestsFrom({
            recommItems: [
                item("s1", 1, { recommTime: 9e12 }),
                item("a", 2, { recommTime: 1000, recommInfo: { message: "first" }, displayName: "A" }),
                item("b", 2, {
                    recommTime: 2000,
                    recommInfo: { message: "second" },
                    zaloName: "B",
                    isSeenFriendReq: true,
                }),
            ],
        });
        assert.deepEqual(
            out.map((r) => [r.userId, r.displayName, r.message, r.seen]),
            [
                ["b", "B", "second", true],
                ["a", "A", "first", false],
            ],
        );
        assert.ok(!("_t" in out[0]), "the sort key is not part of the result");
    });

    it("survives an empty, malformed or id-less feed", () => {
        assert.deepEqual(receivedRequestsFrom(null), []);
        assert.deepEqual(receivedRequestsFrom({ recommItems: "x" }), []);
        assert.deepEqual(receivedRequestsFrom({ recommItems: [null, {}, item("", 2), item(undefined, 2)] }), []);
    });
});

describe("sentRequestsFrom", () => {
    it("reads the object keyed by user id, falling back to the key when the entry has no id", () => {
        const out = sentRequestsFrom({
            u1: { userId: "u1", zaloName: "Z", fReqInfo: { message: "hello", time: 1790000000 } },
            u2: { displayName: "D" },
        });
        assert.deepEqual(out, [
            { userId: "u1", displayName: "Z", message: "hello", requestedAt: "2026-09-21T14:13:20.000Z" },
            { userId: "u2", displayName: "D", message: "", requestedAt: null },
        ]);
        assert.deepEqual(sentRequestsFrom(null), []);
    });
});

describe("friendStatusFrom and friendsFrom", () => {
    it("turns Zalo's 0/1 flags into booleans", () => {
        assert.deepEqual(friendStatusFrom({ is_friend: 1, is_requested: 0, is_requesting: 1 }, 55), {
            userId: "55",
            is_friend: true,
            is_requested: false,
            is_requesting: true,
        });
        assert.deepEqual(friendStatusFrom(null, "7"), {
            userId: "7",
            is_friend: false,
            is_requested: false,
            is_requesting: false,
        });
    });

    it("sorts by recent activity, caps, and reports the total", () => {
        const out = friendsFrom(
            [
                { userId: 1, displayName: "a", lastActionTime: 1 },
                { userId: 2, zaloName: "b", lastActionTime: 3 },
                { userId: 3, displayName: "c" },
            ],
            2,
        );
        assert.equal(out.total, 3);
        assert.deepEqual(
            out.friends.map((f) => [f.userId, f.displayName, f.lastActionTime]),
            [
                ["2", "b", 3],
                ["1", "a", 1],
            ],
        );
        assert.deepEqual(friendsFrom(undefined, 5), { total: 0, friends: [] });
    });
});

describe("error wording shared with `friend add`", () => {
    it("extracts the numeric code from a zca-js message", () => {
        assert.equal(extractErrorCode("Zalo said no (225)"), 225);
        assert.equal(extractErrorCode("bad id (-1)"), -1);
        assert.equal(extractErrorCode("no code here"), null);
    });

    it("keeps the CLI's original wording and names the codes Zalo Web itself names", () => {
        assert.match(describeFriendAddError(225, "9"), /Already friends with 9/);
        assert.match(describeFriendAddError("215", "9"), /blocked you/);
        assert.match(describeFriendAddError(222, "9"), /friend accept 9/);
        assert.match(describeFriendAddError(-1, "9"), /Invalid userId "9"/);
        for (const code of [221, 223, 224]) assert.ok(describeFriendAddError(code, "9"), `code ${code}`);
        assert.equal(describeFriendAddError(999, "9"), undefined, "an unknown code is left for the caller to report");
        assert.equal(describeFriendAddError(null, "9"), undefined);
    });
});
