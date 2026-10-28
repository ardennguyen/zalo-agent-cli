/**
 * `cloud ls` / `cloud plan` (decision D27): a report on the local zCloud index, never an action. The planner is a pure
 * function of the index rows, so the filters, the exclusions and the risk counts are asserted on made-up rows.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CLEANUP_WARNING,
    PLAN_DEFAULT_LIMIT,
    PLAN_MAX_LIMIT,
    describeItem,
    planCloudCleanup,
} from "../../src/core/cloud-plan.js";

const OWN = "1000000000000000001";
const PEER = "1000000000000000002";
const GROUP = "2000000000000000001";
const NOW = Date.UTC(2026, 9, 28);
const DAY = 86_400_000;

/** One `cloud_items` row, as the cloud stage stores it. */
function row(noiseId, over = {}) {
    const { msgInfo = {}, ...rest } = over;
    const info = {
        cliMsgId: `c-${noiseId}`,
        glbMsgId: "0",
        msgType: "chat.photo",
        srcId: PEER,
        destId: OWN,
        destType: 3,
        ts: NOW - 10 * DAY,
        isE2EE: 0,
        ...msgInfo,
    };
    return {
        noiseId,
        threadId: PEER,
        mediaSize: 1000,
        timestamp: info.ts,
        zKey: `${info.cliMsgId}_${PEER}_${info.srcId}`,
        raw_data: JSON.stringify({ msgInfo: info }),
        ...rest,
    };
}

const ROWS = [
    row("small-photo", { mediaSize: 1_000 }),
    row("big-video", { mediaSize: 9_000_000, msgInfo: { msgType: "chat.video.msg", ts: NOW - 400 * DAY } }),
    row("my-file", { mediaSize: 500_000, msgInfo: { msgType: "share.file", srcId: OWN, destId: PEER } }),
    row("group-photo", { threadId: GROUP, mediaSize: 7_000, msgInfo: { destId: GROUP, destType: 6 } }),
    row("self-chat", { threadId: OWN, mediaSize: 3_000, msgInfo: { srcId: OWN, destId: OWN } }),
    row("encrypted", { mediaSize: 2_000, msgInfo: { isE2EE: 1 } }),
];

const plan = (filters = {}, extra = {}) =>
    planCloudCleanup({
        rows: ROWS,
        ownId: OWN,
        filters,
        now: NOW,
        nameOf: (id) => (id === PEER ? "A friend" : null),
        ...extra,
    });

describe("describeItem", () => {
    it("reads the kind, the side and the flags from the stored queue entry", () => {
        const v = describeItem(ROWS[1], OWN);
        assert.equal(v.kind, "video");
        assert.equal(v.incoming, true, "sent by the other side");
        assert.equal(v.group, false);
        assert.equal(describeItem(ROWS[2], OWN).incoming, false, "my own message");
        assert.equal(describeItem(ROWS[3], OWN).group, true);
        assert.equal(describeItem(ROWS[4], OWN).selfChat, true);
        assert.equal(describeItem(ROWS[5], OWN).e2ee, true);
        assert.equal(describeItem({ noiseId: "x", raw_data: "not json" }, OWN).kind, "unknown");
    });
});

describe("planCloudCleanup", () => {
    it("leaves out end-to-end encrypted items, groups and My Cloud unless asked, and counts what it left out", () => {
        const p = plan();
        assert.deepEqual(
            p.items.map((i) => i.noiseId),
            ["big-video", "my-file", "small-photo"],
            "largest first",
        );
        assert.deepEqual(p.excluded, { e2ee: 1, groups: 1, myCloud: 1, notSavedLocally: 0 });
        assert.equal(p.bytes, 9_501_000);
        const all = plan({ includeGroups: true, includeMyCloud: true });
        assert.equal(all.matched, 5, "the encrypted item is never included");
        assert.equal(all.excluded.e2ee, 1);
    });

    it("filters by conversation, kind, age and size", () => {
        assert.deepEqual(
            plan({ threads: [GROUP], includeGroups: true }).items.map((i) => i.noiseId),
            ["group-photo"],
        );
        assert.deepEqual(
            plan({ kinds: ["VIDEO"] }).items.map((i) => i.noiseId),
            ["big-video"],
        );
        assert.deepEqual(
            plan({ olderThanDays: 365 }).items.map((i) => i.noiseId),
            ["big-video"],
        );
        assert.deepEqual(
            plan({ largerThanBytes: 400_000 }).items.map((i) => i.noiseId),
            ["big-video", "my-file"],
        );
    });

    it("keeps only what this machine already holds when asked, and counts the risk of losing the rest", () => {
        const saved = (it) => it.noiseId === "big-video";
        const only = plan({ onlySavedLocally: true }, { savedLocally: saved });
        assert.deepEqual(
            only.items.map((i) => i.noiseId),
            ["big-video"],
        );
        assert.equal(only.excluded.notSavedLocally, 2);
        const any = plan({}, { savedLocally: saved });
        assert.equal(any.risks.notSavedLocally, 2);
        assert.equal(any.risks.incoming, 2, "the video and the photo came from the other side");
        const flagged = Object.fromEntries(any.items.map((i) => [i.noiseId, i.risk]));
        assert.deepEqual(flagged["big-video"], ["incoming-message"]);
        assert.deepEqual(flagged["my-file"], ["not-saved-locally"]);
    });

    it("totals every match but lists only up to the limit, and never more than the hard limit", () => {
        assert.equal(plan({ limit: 1 }).listed, 1);
        assert.equal(plan({ limit: 1 }).matched, 3);
        const many = Array.from({ length: 2500 }, (_, i) => row(`n${i}`, { mediaSize: i + 1 }));
        const big = planCloudCleanup({ rows: many, ownId: OWN, filters: { limit: 99_999 }, now: NOW });
        assert.equal(big.listed, PLAN_MAX_LIMIT);
        assert.equal(big.matched, 2500);
        assert.equal(planCloudCleanup({ rows: many, ownId: OWN, now: NOW }).listed, PLAN_DEFAULT_LIMIT);
    });

    it("groups the bytes by kind and by conversation, with names where it knows them", () => {
        const p = plan();
        assert.deepEqual(p.byKind.photo, { items: 1, bytes: 1_000 });
        assert.equal(p.byConversation.length, 1);
        assert.deepEqual(p.byConversation[0], { threadId: PEER, name: "A friend", items: 3, bytes: 9_501_000 });
    });

    it("says in plain words that nothing is sent and nothing is deleted", () => {
        assert.match(CLEANUP_WARNING, /no endpoint that deletes a zCloud item/);
        assert.match(CLEANUP_WARNING, /cannot be undone/);
        assert.match(CLEANUP_WARNING, /nothing was deleted/);
    });
});
