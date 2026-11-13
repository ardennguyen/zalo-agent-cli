/**
 * `cloud ls` / `cloud plan` (decision D27): a report on the local zCloud index, never an action. The planner is a pure
 * function of the index rows, so the filters, the exclusions and the risk counts are asserted on made-up rows.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CLEANUP_WARNING,
    CLOUD_PAGE_SIZE,
    applyCloudCleanup,
    cloudDeleteTarget,
    describeItem,
    planCloudCleanup,
} from "../../src/core/cloud-plan.js";
import { GUARDS, describeGuarded } from "../../src/core/confirm-guard.js";

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

    it("lists every match by default; a limit is the caller's choice and the totals still cover every match", () => {
        assert.equal(plan({ limit: 1 }).listed, 1);
        assert.equal(plan({ limit: 1 }).matched, 3);
        const many = Array.from({ length: 2500 }, (_, i) => row(`n${i}`, { mediaSize: i + 1 }));
        // Red under the old defaults (200 listed, at most 2000).
        const all = planCloudCleanup({ rows: many, ownId: OWN, now: NOW });
        assert.equal(all.listed, 2500);
        assert.equal(all.matched, 2500);
        assert.equal(all.bytes, (2500 * 2501) / 2, "the total size the confirm quotes covers every match");
        assert.equal(planCloudCleanup({ rows: many, ownId: OWN, filters: { limit: 2400 }, now: NOW }).listed, 2400);
    });

    it("lists every conversation by size, not only the 20 largest (cloud ls, zalo_cloud summary)", () => {
        const rows = Array.from({ length: 25 }, (_, i) =>
            row(`c${i}`, { threadId: `10000000000000001${String(i).padStart(2, "0")}`, mediaSize: 1000 + i }),
        );
        const p = planCloudCleanup({ rows, ownId: OWN, now: NOW });
        assert.equal(p.byConversation.length, 25);
        assert.ok(p.byConversation[0].bytes >= p.byConversation[24].bytes, "largest first");
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

describe("cloud apply: the message reference a cloud delete sends", () => {
    const item = (r) => describeItem(r, OWN);

    it("names a peer's message by its global id and sender, in the DM it belongs to", () => {
        const t = cloudDeleteTarget(item(row("p", { msgInfo: { glbMsgId: "777" } })), OWN);
        assert.deepEqual(t, { data: { cliMsgId: "c-p", msgId: "777", uidFrom: PEER }, threadId: PEER, type: 0 });
    });

    it("writes this account as 0 for its own message, and keeps the queue's literal 0 global id as it is", () => {
        // Zalo expects `glbMsgId || cliMsgId_001`: the string "0" is not empty, so it is sent as it is.
        const t = cloudDeleteTarget(item(row("m", { msgInfo: { srcId: OWN, destId: PEER } })), OWN);
        assert.deepEqual(t.data, { cliMsgId: "c-m", msgId: "0", uidFrom: "0" });
        assert.equal(t.threadId, PEER);
    });

    it("falls back to <cliMsgId>_001 when the queue names no global id, and marks a group item type 1", () => {
        const g = row("g", { threadId: GROUP, msgInfo: { destId: GROUP, destType: 6, glbMsgId: "" } });
        const t = cloudDeleteTarget(item(g), OWN);
        assert.equal(t.data.msgId, "c-g_001");
        assert.equal(t.type, 1);
        assert.equal(t.threadId, GROUP);
    });

    it("names nothing for an encrypted item or one without a client id", () => {
        assert.equal(cloudDeleteTarget(item(row("e", { msgInfo: { isE2EE: 1 } })), OWN), null);
        assert.equal(cloudDeleteTarget(item(row("n", { msgInfo: { cliMsgId: null } })), OWN), null);
    });
});

describe("cloud apply: deleting, conversation by conversation", () => {
    const items = [
        describeItem(row("a1"), OWN),
        describeItem(row("a2"), OWN),
        describeItem(row("a3"), OWN),
        describeItem(row("g1", { threadId: GROUP, mediaSize: 7, msgInfo: { destId: GROUP, destType: 6 } }), OWN),
        describeItem(row("x", { msgInfo: { isE2EE: 1 } }), OWN),
    ];

    it("deletes each named message for this account only and counts the bytes", async () => {
        const sent = [];
        const r = await applyCloudCleanup({ items, ownId: OWN, deleteForMe: async (t) => sent.push(t) });
        assert.equal(r.deleted, 4);
        assert.equal(r.bytes, 3_007);
        assert.deepEqual(
            sent.map((t) => t.data.cliMsgId),
            ["c-a1", "c-a2", "c-a3", "c-g1"],
        );
        assert.deepEqual(r.skipped, [{ noiseId: "x", reason: "end-to-end encrypted" }]);
        assert.deepEqual(r.failed, []);
    });

    it("stops a conversation at its first failure, and goes on with the next", async () => {
        const sent = [];
        const r = await applyCloudCleanup({
            items,
            ownId: OWN,
            deleteForMe: async (t) => {
                sent.push(t.data.cliMsgId);
                if (t.data.cliMsgId === "c-a2") throw new Error("refused");
            },
        });
        // Red if one refusal went on deleting the rest of that conversation, or stopped the other conversations.
        assert.deepEqual(sent, ["c-a1", "c-a2", "c-g1"]);
        assert.equal(r.deleted, 2);
        assert.deepEqual(
            r.failed.map((f) => [f.noiseId, f.error]),
            [
                ["a2", "refused"],
                ["a3", "not tried: an earlier delete failed"],
            ],
        );
    });

    it("applies all of 250 matches in pages of 60, and stops a conversation at its first failure across pages", async () => {
        const OTHER = "1000000000000000003";
        // 250 items alternating between two DMs; PEER's 70th delete fails (in page 3), OTHER's never does.
        const rows = Array.from({ length: 250 }, (_, i) =>
            i % 2
                ? row(`o${i}`, { threadId: OTHER, msgInfo: { srcId: OTHER, destId: OWN } })
                : row(`p${i}`, { msgInfo: { srcId: PEER } }),
        );
        const r0 = planCloudCleanup({ rows, ownId: OWN, now: NOW });
        assert.equal(r0.listed, 250);
        const sent = [];
        const pagesSeen = new Set();
        let peerDeletes = 0;
        const r = await applyCloudCleanup({
            items: r0.items,
            ownId: OWN,
            deleteForMe: async (t) => {
                sent.push(t.threadId);
                if (t.threadId === PEER && ++peerDeletes === 70) throw new Error("refused");
            },
            onProgress: (p) => pagesSeen.add(p.page),
        });
        assert.equal(CLOUD_PAGE_SIZE, 60);
        assert.equal(r.pages, 5, "250 items: four full pages of 60 and one of 10");
        assert.deepEqual([...pagesSeen], [1, 2, 3, 4, 5]);
        // Every OTHER item was deleted; PEER stopped at its 70th and no later PEER item was sent.
        assert.equal(sent.filter((t) => t === OTHER).length, 125);
        assert.equal(sent.filter((t) => t === PEER).length, 70);
        assert.equal(r.deleted, 125 + 69);
        assert.equal(r.failed.length, 125 - 69);
        assert.deepEqual(r.stoppedConversations, [{ threadId: PEER, error: "refused" }]);
    });

    it("is guarded, final, and says how much it deletes", () => {
        assert.equal(GUARDS["cloud.delete"].cli, "cloud apply");
        const d = describeGuarded("cloud.delete", { items: 3, size: "2.0 MB", conversations: 2 });
        assert.equal(d.irreversible, true);
        assert.match(d.wouldDo, /3 zCloud item\(s\) \(2\.0 MB\) in 2 conversation\(s\), for this account/);
    });
});
