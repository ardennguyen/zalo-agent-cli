/**
 * src/core/overflow-repair.js — the no-tap group repair reads every group and every message back to the loss.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { OVERFLOW_GROUP_BATCH, repairGroupsFromCloud } from "../../src/core/overflow-repair.js";

before(() => assertSandboxed(CONFIG_DIR));

const FROM = 1_000_000;

describe("repairGroupsFromCloud reads until done", () => {
    it("reads all 120 groups, in batches of 50, and pages a busy group back to the start of the loss", async () => {
        const groups = Array.from({ length: 120 }, (_, i) => String(9000 + i));
        const calls = [];
        // Group 9000 had 400 messages after the loss (newer than FROM), then older ones; the others are quiet.
        const busy = Array.from({ length: 450 }, (_, i) => ({ data: { msgId: String(5000 - i), ts: FROM + 400 - i } }));
        const fetchGroup = async (_api, groupId, count, opts = {}) => {
            calls.push({ groupId, count, untilTs: opts.untilTs });
            if (groupId !== "9000") return { groupMsgs: [{ data: { msgId: "1", ts: FROM - 5 } }], more: 0 };
            if (count === Infinity) {
                // Stand-in for the paged walk: everything down to (and including) the page that reaches untilTs.
                const end = busy.findIndex((m) => m.data.ts <= opts.untilTs);
                return { groupMsgs: busy.slice(0, Math.ceil((end + 1) / 50) * 50), more: 1 };
            }
            return { groupMsgs: busy.slice(0, count), more: 1 };
        };
        const stored = [];
        const out = await repairGroupsFromCloud({
            api: {},
            fromTs: FROM,
            listGroups: async () => groups,
            recentGroups: () => [],
            fetchGroup,
            store: (msg) => (stored.push(msg), { stored: true, info: {} }),
            delayMs: 0,
            batchDelayMs: 0,
        });
        assert.equal(OVERFLOW_GROUP_BATCH, 50);
        // Red under the old cap of 50 groups.
        assert.equal(out.checked, 120);
        assert.equal(new Set(calls.map((c) => c.groupId)).size, 120);
        // Red under the old 200-per-group cap: all 400 messages after the loss came back.
        assert.equal(stored.length, 400);
        assert.equal(out.complete, true);
        const deep = calls.find((c) => c.groupId === "9000" && c.count === Infinity);
        assert.equal(deep.untilTs, FROM);
    });

    it("explicit maxGroups is still an opt-in bound and says so", async () => {
        const out = await repairGroupsFromCloud({
            api: {},
            fromTs: FROM,
            listGroups: async () => ["1", "2", "3"],
            recentGroups: () => [],
            fetchGroup: async () => ({ groupMsgs: [], more: 0 }),
            store: () => ({ stored: false }),
            maxGroups: 2,
            delayMs: 0,
        });
        assert.equal(out.checked, 2);
        assert.equal(out.complete, false);
    });
});
