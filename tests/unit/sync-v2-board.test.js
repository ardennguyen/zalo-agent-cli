/**
 * src/core/sync-v2/board.js — notes, pinned messages, polls and reminders.
 *
 * These never appear in the transfer-sync message stream, so they are fetched
 * per thread over REST. The api object is stubbed: what is under test is the
 * normalization of Zalo's several payload shapes and the guarantee that one
 * failing thread cannot abort a run spanning hundreds.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, getBoardItems, getReminders } from "../../src/core/db.js";
import { syncBoards, normalizeBoardItem, normalizeReminder, BOARD_TYPES } from "../../src/core/sync-v2/board.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-board-test-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

const NOTE = {
    boardType: 1,
    data: {
        id: "note-1",
        type: 1,
        color: -16777216,
        emoji: "📌",
        startTime: 1_750_000_000_000,
        duration: 3600000,
        params: { title: "Standup at 9" },
        creatorId: "111",
        editorId: "111",
        createTime: 1_749_000_000_000,
        editTime: 1_749_500_000_000,
        repeat: 0,
    },
};

const PINNED = {
    boardType: 2,
    data: { ...NOTE.data, id: "pin-1", params: { title: "Read this" } },
};

const POLL = {
    boardType: 3,
    data: {
        poll_id: 90210,
        question: "Lunch where?",
        creator: "222",
        created_time: 1_749_000_000_000,
        updated_time: 1_749_100_000_000,
        expired_time: 1_749_900_000_000,
        options: [{ content: "Pho", votes: 3, option_id: 1 }],
        closed: false,
    },
};

const DM_REMINDER = {
    reminderId: "rem-dm-1",
    creatorUid: "333",
    toUid: "444",
    emoji: "⏰",
    color: 1,
    createTime: 1_749_000_000_000,
    editTime: 1_749_000_000_000,
    startTime: 1_750_000_000_000,
    endTime: 1_750_003_600_000,
    repeat: 1,
    params: { title: "Call the vendor", setTitle: true },
    type: 0,
};

const GROUP_REMINDER = {
    id: "rem-gr-1",
    creatorId: "555",
    editorId: "555",
    groupId: "g1",
    emoji: "🎉",
    color: 2,
    eventType: 1,
    createTime: 1_749_000_000_000,
    editTime: 1_749_000_000_000,
    startTime: 1_751_000_000_000,
    duration: 7200000,
    repeat: 2,
    params: { title: "Team offsite" },
    type: 1,
};

/** Minimal stub of the zca-js surface syncBoards touches. */
function stubApi({ board = [], reminders = [], fail = {} } = {}) {
    const calls = { board: [], reminder: [] };
    return {
        calls,
        getListBoard: async (opts, groupId) => {
            calls.board.push({ groupId, page: opts.page });
            if (fail.board) throw new Error(fail.board);
            return opts.page === 1 ? { items: board, count: board.length } : { items: [], count: 0 };
        },
        getListReminder: async (opts, threadId, type) => {
            calls.reminder.push({ threadId, type });
            if (fail.reminder) throw new Error(fail.reminder);
            return reminders;
        },
    };
}

describe("normalizeBoardItem", () => {
    it("unpacks a note", () => {
        const r = normalizeBoardItem(NOTE, "g1", "group");
        assert.equal(r.boardType, 1);
        assert.equal(r.itemId, "note-1");
        assert.equal(r.title, "Standup at 9");
        assert.equal(r.creatorId, "111");
    });

    it("reads a params object that arrived as a JSON string", () => {
        const item = { boardType: 1, data: { ...NOTE.data, params: JSON.stringify({ title: "From a string" }) } };
        assert.equal(normalizeBoardItem(item, "g1", "group").title, "From a string");
    });

    it("unpacks a poll from its differently-named fields", () => {
        // Polls use poll_id/question/creator/created_time, not id/params/creatorId.
        const r = normalizeBoardItem(POLL, "g1", "group");
        assert.equal(r.boardType, 3);
        assert.equal(r.itemId, "90210");
        assert.equal(r.title, "Lunch where?");
        assert.equal(r.creatorId, "222");
        assert.equal(r.duration, POLL.data.expired_time - POLL.data.created_time);
    });

    it("rejects an item with no id or no type", () => {
        assert.equal(normalizeBoardItem({ boardType: 1, data: {} }, "g1", "group"), null);
        assert.equal(normalizeBoardItem({ boardType: 3, data: { question: "?" } }, "g1", "group"), null);
        assert.equal(normalizeBoardItem({ data: NOTE.data }, "g1", "group"), null);
        assert.equal(normalizeBoardItem(null, "g1", "group"), null);
    });
});

describe("normalizeReminder", () => {
    it("reads a DM reminder (creatorUid, reminderId)", () => {
        const r = normalizeReminder(DM_REMINDER, "u1", "dm");
        assert.equal(r.reminderId, "rem-dm-1");
        assert.equal(r.creatorId, "333");
        assert.equal(r.title, "Call the vendor");
        assert.equal(r.repeatMode, 1);
    });

    it("reads a group reminder (creatorId, id)", () => {
        const r = normalizeReminder(GROUP_REMINDER, "g1", "group");
        assert.equal(r.reminderId, "rem-gr-1");
        assert.equal(r.creatorId, "555");
        assert.equal(r.title, "Team offsite");
        assert.equal(r.eventType, 1);
    });

    it("rejects a reminder with no id", () => {
        assert.equal(normalizeReminder({ params: { title: "x" } }, "g1", "group"), null);
        assert.equal(normalizeReminder(null, "g1", "group"), null);
    });
});

describe("syncBoards", () => {
    it("stores notes, pinned messages and polls for a group", async () => {
        const api = stubApi({ board: [NOTE, PINNED, POLL] });
        const stats = await syncBoards({
            api,
            threads: [{ threadId: "g1", type: "group", name: "Team" }],
            delayMs: 0,
        });
        assert.equal(stats.boardItems, 3);
        assert.equal(stats.failed, 0);
        assert.equal(getBoardItems("g1").length, 3);
        assert.equal(getBoardItems("g1", 3)[0].title, "Lunch where?");
    });

    it("asks for a DM board too, on the oneone endpoint rather than the group one", async () => {
        // Boards are NOT group-only: a 1-1 conversation has notes, pinned
        // messages and reminders behind /api/board/oneone/*. An earlier version
        // asked DMs for reminders and nothing else, so every pinned message and
        // note in a 1-1 conversation was silently missing.
        const api = stubApi({ board: [NOTE] });
        const stats = await syncBoards({ api, threads: [{ threadId: "u1", type: "dm" }], delayMs: 0 });
        assert.equal(api.calls.board.length, 0, "a DM must not use the GROUP board endpoint");
        assert.equal(api.calls.reminder.length, 1, "reminders still come from the reminder endpoint");
        // The stub carries no zpwServiceMap, so the oneone call fails - which is
        // itself the proof that it was attempted at all.
        assert.ok(stats.failed >= 1, "a DM board request should have been made");
        assert.ok(
            stats.failures.some((f) => f.what === "board"),
            "the failure should be the board request",
        );
    });

    it("routes reminders to the right thread type", async () => {
        const api = stubApi({ reminders: [DM_REMINDER] });
        await syncBoards({
            api,
            threads: [
                { threadId: "u1", type: "dm" },
                { threadId: "g1", type: "group" },
            ],
            boards: false,
            concurrency: 1,
            delayMs: 0,
        });
        // ThreadType.User = 0, ThreadType.Group = 1
        assert.deepEqual(
            api.calls.reminder.map((c) => c.type),
            [0, 1],
        );
    });

    it("accepts the several shapes a reminder list arrives in", async () => {
        for (const resp of [
            [DM_REMINDER],
            { items: [DM_REMINDER] },
            { list: [DM_REMINDER] },
            { data: { items: [DM_REMINDER] } },
        ]) {
            opened.push(initDb(join(ROOT, `db-shape${n++}.sqlite`)));
            const api = stubApi({ reminders: resp });
            const stats = await syncBoards({
                api,
                threads: [{ threadId: "u1", type: "dm" }],
                boards: false,
                delayMs: 0,
            });
            assert.equal(stats.reminders, 1, `shape ${JSON.stringify(resp).slice(0, 40)} not handled`);
        }
    });

    it("keeps going when one thread fails", async () => {
        const api = stubApi({ board: [NOTE] });
        const original = api.getListBoard;
        api.getListBoard = async (opts, groupId) => {
            if (groupId === "bad") throw new Error("403 forbidden");
            return original(opts, groupId);
        };
        const stats = await syncBoards({
            api,
            threads: [
                { threadId: "bad", type: "group" },
                { threadId: "g1", type: "group" },
            ],
            reminders: false,
            concurrency: 1,
            delayMs: 0,
        });
        assert.equal(stats.threads, 2, "both threads should be visited");
        assert.equal(stats.boardItems, 1);
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /403/);
    });

    it("stops paging once a short page arrives", async () => {
        const api = stubApi({ board: [NOTE] });
        await syncBoards({
            api,
            threads: [{ threadId: "g1", type: "group" }],
            reminders: false,
            pageSize: 50,
            delayMs: 0,
        });
        assert.equal(api.calls.board.length, 1, "a page shorter than pageSize means the end");
    });

    it("respects maxPages when every page is full", async () => {
        const full = Array.from({ length: 5 }, (_, i) => ({
            boardType: 1,
            data: { ...NOTE.data, id: `n${i}` },
        }));
        const api = {
            calls: { board: [] },
            getListBoard: async (opts, groupId) => {
                api.calls.board.push({ groupId, page: opts.page });
                return { items: full, count: full.length };
            },
        };
        await syncBoards({
            api,
            threads: [{ threadId: "g1", type: "group" }],
            reminders: false,
            pageSize: 5,
            maxPages: 3,
            delayMs: 0,
        });
        assert.equal(api.calls.board.length, 3);
    });

    it("re-running updates rather than duplicating", async () => {
        const api = stubApi({ board: [NOTE], reminders: [GROUP_REMINDER] });
        const threads = [{ threadId: "g1", type: "group" }];
        await syncBoards({ api, threads, delayMs: 0 });
        await syncBoards({ api, threads, delayMs: 0 });
        assert.equal(getBoardItems("g1").length, 1);
        assert.equal(getReminders("g1").length, 1);
    });

    it("scopes ids by thread so the same item id in two threads coexists", async () => {
        const api = stubApi({ board: [NOTE] });
        await syncBoards({
            api,
            threads: [
                { threadId: "g1", type: "group" },
                { threadId: "g2", type: "group" },
            ],
            reminders: false,
            concurrency: 1,
            delayMs: 0,
        });
        assert.equal(getBoardItems().length, 2);
        assert.equal(getBoardItems("g1").length, 1);
    });

    it("does nothing without an api or threads", async () => {
        assert.equal((await syncBoards({ threads: [{ threadId: "g1", type: "group" }] })).threads, 0);
        assert.equal((await syncBoards({ api: stubApi(), threads: [] })).threads, 0);
    });

    it("reports progress per thread", async () => {
        const seen = [];
        await syncBoards({
            api: stubApi({ board: [NOTE] }),
            threads: [
                { threadId: "g1", type: "group" },
                { threadId: "g2", type: "group" },
            ],
            reminders: false,
            concurrency: 1,
            delayMs: 0,
            onProgress: (p) => seen.push(p),
        });
        assert.equal(seen.length, 2);
        assert.equal(seen[1].done, 2);
        assert.equal(seen[1].total, 2);
    });
});

describe("BOARD_TYPES", () => {
    it("matches zca-js BoardType", () => {
        assert.deepEqual(BOARD_TYPES, { 1: "note", 2: "pinned_message", 3: "poll" });
    });
});
