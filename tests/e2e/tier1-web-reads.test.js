/**
 * TIER 1 — every registered read of Zalo Web, asked of a live account.
 *
 * The table in src/zalo/reads.js says which reads a live account has answered (`verified`). This is the check that keeps
 * it true: each read goes out as the CLI sends it and has to come back as an answer, so a read Zalo retires (it answers
 * 404, "Stop retry" or a parameter error on every call, as the personal todos and the media-store lists did) fails here
 * instead of lingering in the table for a month.
 *
 * Read-only: nothing changes on the account. Arguments come from tests/targets.json (the disposable group and one-to-one
 * conversation) and the account's own id. Gate: ZALO_TEST_LIVE=1.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { runJson } from "../helpers/cli.js";
import { gate, live, retryRead } from "../helpers/live.js";

const g = gate(1);
const skip = g.run ? false : g.skipReason;
const T = g.targets;

/** The arguments of each read that needs any, from the targets. */
function argsFor(name) {
    const user = T.dm.threadId;
    const group = T.group.threadId;
    const own = T.accountOwnId;
    return (
        {
            "friend-context": { ids: [user] },
            "friend-verify": { versions: [`${user}_0`] },
            "gif-search": { keyword: "hello" },
            "group-message-status": { data: [{ tId: group, ids: [] }] },
            "group-quota-members": { groupId: group, userId: user },
            "group-user-context": { groupIds: [group] },
            "important-messages": { uid: user },
            "last-messages": { items: [{ id: user }] },
            "last-seen": { group: [group], oneone: [user] },
            "message-status": { data: [{ tId: user }] },
            "mini-profiles": { ids: [user, own] },
            "noise-ids": { ids: [user] },
            "noised-uids": { friends: [user], groups: [group] },
            "offline-check": { queueInfo: {}, lastActId: "0", lastMsgId: "0" },
            "oa-convert-ids": { oaIds: ["1"] },
            "pin-list": { groupId: group },
            "profile-extra": { id: user },
            "profile-rank": { id: user },
            "sticker-category": { cid: 1 },
            "sticker-effects": { effectIds: [1] },
        }[name] ?? {}
    );
}

/**
 * A read whose answer depends on the target and has a documented error that is still an answer: the request is accepted
 * and Zalo says no for THIS conversation.
 */
const ANSWERED_WITH_ERROR = {
    // answers only for a group that has a pin board; a fresh disposable group has none
    "pin-list": /Lỗi không xác định|unknown/i,
    // needs a community administrator; the request itself is accepted ("not enough permission" or "not found")
    "group-quota-members": /Không đủ quyền|Không tìm thấy|permission|not found/i,
    // the ids of a conversation with no unsynced messages
    "group-message-status": /Lỗi không xác định|unknown/i,
};

describe("tier 1 · every read of the Zalo Web table answers", { skip }, () => {
    let names = [];
    before(async () => {
        const r = await runJson(["read", "list"], live(T, { timeout: 60_000 }));
        assert.equal(r.ok, true, r.error);
        names = (Array.isArray(r.data) ? r.data : r.data?.reads || []).map((x) => x.name);
        assert.ok(names.length >= 30, `the table lists only ${names.length} reads`);
    });

    it("each one is answered (or answered with the documented per-target error)", async () => {
        const failed = [];
        for (const name of names) {
            const r = await retryRead(() =>
                runJson(["read", "run", name, "--args", JSON.stringify(argsFor(name))], live(T, { timeout: 120_000 })),
            );
            if (r.ok) continue;
            const allowed = ANSWERED_WITH_ERROR[name];
            if (allowed && allowed.test(String(r.error))) continue;
            failed.push(`${name}: ${String(r.error).slice(0, 120)}`);
        }
        assert.deepEqual(failed, [], `reads that no longer answer:\n  ${failed.join("\n  ")}`);
    });

    it("account-status (the composed read) reports a plan for the account", async () => {
        const r = await retryRead(() => runJson(["read", "run", "account-status"], live(T, { timeout: 120_000 })));
        assert.equal(r.ok, true, r.error);
        const d = r.data?.data ?? r.data;
        assert.equal(String(d.ownId), T.accountOwnId);
        assert.ok(d.zcloud || d.problems?.length, "a zCloud section, or the reason there is none");
    });
});
