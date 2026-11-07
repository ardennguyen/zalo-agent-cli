/**
 * src/core/sync-action.js — the Web's `sync_action` media reports, built and not yet wired to any caller.
 *
 * The entry, the server's switch and the batching are checked against what Zalo Web's `SubmitActionDownloadResource`
 * does (read in its bundle); the payloads are hand-written, the ids throwaway constants. Nothing is sent: the submit
 * is injected, and the one test of the real request path uses `dryRun`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BATCH_MAX,
    DEFAULT_THROTTLE_MS,
    createSyncActionReporter,
    syncActionItem,
    syncActionSettings,
} from "../../src/core/sync-action.js";
import { WRITES } from "../../src/zalo/writes.js";

const OWN = "1001";

/** Timers the test fires by hand. */
function manualTimers() {
    const pending = [];
    return {
        pending,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            pending.push(t);
            return t;
        },
        clearTimer: (t) => {
            if (t) t.cleared = true;
        },
        fire: async () => {
            const live = pending.filter((t) => !t.cleared);
            pending.length = 0;
            for (const t of live) t.fn();
            await new Promise((r) => setTimeout(r, 0));
        },
    };
}

describe("one report entry, as the Web builds it", () => {
    it("names the sender, the conversation without the group prefix, the group flag and the client id as a number", () => {
        assert.deepEqual(syncActionItem({ threadId: "g5001", isGroup: true, senderId: "1002", cliMsgId: "42" }, OWN), {
            fromUid: "1002",
            destId: "5001",
            isGroup: 1,
            cmi: 42,
        });
    });

    it("puts the account itself as the sender of its own messages (sender 0)", () => {
        assert.equal(
            syncActionItem({ threadId: "1002", isGroup: false, senderId: "0", cliMsgId: 7 }, OWN).fromUid,
            OWN,
        );
        assert.equal(syncActionItem({ threadId: "1002", isGroup: false, cliMsgId: 7 }, OWN).fromUid, OWN);
    });

    it("refuses a message with no usable client id or conversation", () => {
        assert.equal(syncActionItem({ threadId: "1002", cliMsgId: null }, OWN), null);
        assert.equal(syncActionItem({ threadId: "1002", cliMsgId: "x" }, OWN), null);
        assert.equal(syncActionItem({ threadId: "", cliMsgId: 1 }, OWN), null);
    });
});

describe("the server's switch", () => {
    const api = (features) => ({ getContext: () => ({ settings: { features } }) });

    it("is on only when the login answer says so, and takes the server's throttle", () => {
        assert.deepEqual(syncActionSettings(api({ syncActionMedia: { enable: 1, submitActionThrottle: 7000 } })), {
            enable: true,
            throttleMs: 7000,
        });
        assert.deepEqual(syncActionSettings(api({ syncActionMedia: { enable: 0 } })), {
            enable: false,
            throttleMs: DEFAULT_THROTTLE_MS,
        });
        assert.equal(syncActionSettings(api({})).enable, false);
        assert.equal(syncActionSettings(null).enable, false);
    });
});

describe("the batching reporter", () => {
    const item = (cmi) => ({ fromUid: "1002", destId: "1002", isGroup: 0, cmi });

    it("de-duplicates, waits for the throttle, then sends at most 50 per request", async () => {
        const t = manualTimers();
        const sent = [];
        const r = createSyncActionReporter({ submit: async (b) => sent.push(b), throttleMs: 5000, ...t });
        const many = Array.from({ length: BATCH_MAX + 3 }, (_, i) => item(i + 1));
        assert.equal(r.add(many), BATCH_MAX + 3);
        assert.equal(r.add([item(1)]), 0, "an entry already queued is not queued twice");
        assert.equal(sent.length, 0, "nothing goes before the throttle");
        assert.equal(t.pending.at(-1).ms, 5000);
        await t.fire();
        assert.deepEqual(
            sent.map((b) => b.length),
            [BATCH_MAX, 3],
        );
        assert.equal(r.pending(), 0);
    });

    it("puts a failed batch back and tries again later", async () => {
        const t = manualTimers();
        let fail = true;
        const sent = [];
        const lines = [];
        const r = createSyncActionReporter({
            submit: async (b) => {
                if (fail) throw new Error("ERR_NO_NETWORK");
                sent.push(b);
            },
            retryMs: 30000,
            log: (l) => lines.push(l),
            ...t,
        });
        r.add([item(1), item(2)]);
        await t.fire();
        assert.equal(r.pending(), 2);
        assert.equal(t.pending.at(-1).ms, 30000);
        assert.ok(lines.some((l) => /retrying later/.test(l)));
        fail = false;
        await t.fire();
        assert.deepEqual(sent, [[item(1), item(2)]]);
    });

    it("sends nothing while the switch is off, and keeps the queue", async () => {
        const sent = [];
        const r = createSyncActionReporter({
            submit: async (b) => sent.push(b),
            enabled: () => false,
            ...manualTimers(),
        });
        r.add([item(1)]);
        assert.equal(await r.flush(), 0);
        assert.equal(r.pending(), 1);
        assert.equal(sent.length, 0);
    });
});

describe("the request it would send", () => {
    it("is the sync-action-media write: the entries as JSON text, unchanged, beside the client's imei", () => {
        const entry = syncActionItem({ threadId: "g5001", isGroup: true, senderId: "1002", cliMsgId: "42" }, OWN);
        const body = WRITES["sync-action-media"].body({ actions: [entry] }, { imei: "imei-1" });
        assert.deepEqual(body, {
            syncList: JSON.stringify([{ fromUid: "1002", destId: "5001", isGroup: 1, cmi: 42 }]),
            imei: "imei-1",
        });
        assert.equal(WRITES["sync-action-media"].host, "sync_action");
    });
});
