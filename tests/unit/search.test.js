/**
 * Searching the local cache (src/core/db.js `text_norm` and the search queries, src/core/search.js): accent-insensitive
 * by default, exact on request, paged, with previews, tabs, context and a coverage note.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    backfillTextNorm,
    configureSearchIndex,
    countSearchMatchesByType,
    ensureSearchIndex,
    getMessagesAround,
    getOldestCachedTimestamp,
    initDb,
    insertMessage,
    insertMessageIfAbsent,
    markMessageRecalled,
    recordSyncGap,
    searchMessageRows,
    searchMessages,
    setSyncState,
    upsertThread,
} from "../../src/core/db.js";
import {
    decodeCursor,
    encodeCursor,
    makeSnippet,
    resolveTypes,
    searchCoverage,
    searchPage,
} from "../../src/core/search.js";

let file;
let n = 0;
const T0 = Date.UTC(2026, 9, 1);

const msg = (msgId, text, over = {}) => ({
    msgId,
    threadId: "t1",
    senderId: "100",
    senderName: "An",
    text,
    timestamp: T0 + Number(String(msgId).replace(/\D/g, "") || 0) * 1000,
    type: "text",
    raw_data: { src: "test" },
    ...over,
});

/** A second connection, to write rows the way an older version did. */
function rawDb() {
    return new Database(file);
}

describe("search", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    beforeEach(() => {
        mkdirSync(join(CONFIG_DIR, "search-tests"), { recursive: true });
        file = join(CONFIG_DIR, "search-tests", `zalo-${process.pid}-${++n}.db`);
        initDb(file);
    });

    describe("the folded text, kept by every message writer", () => {
        const norm = (id) => {
            const d = rawDb();
            const r = d.prepare("SELECT text_norm FROM messages WHERE msgId = ?").get(id);
            d.close();
            return r?.text_norm;
        };

        it("insertMessage stores it, and an update of the text replaces it", () => {
            insertMessage(msg("m1", "Được không?"));
            assert.equal(norm("m1"), "duoc khong?");
            insertMessage(msg("m1", "Cảm ơn"));
            assert.equal(norm("m1"), "cam on");
        });

        it("insertMessageIfAbsent stores it, and leaves an existing row alone", () => {
            insertMessageIfAbsent(msg("m2", "Chào bạn"));
            assert.equal(norm("m2"), "chao ban");
            insertMessageIfAbsent(msg("m2", "Tạm biệt"));
            assert.equal(norm("m2"), "chao ban");
        });

        it("keeps null for a message with no text", () => {
            insertMessage(msg("m3", null));
            assert.equal(norm("m3"), null);
        });

        it("a recall makes the row a tombstone, and a later write cannot bring its text back", () => {
            insertMessage(msg("m4", "bí mật"));
            markMessageRecalled("m4", T0);
            assert.equal(norm("m4"), "[deleted]");
            insertMessage(msg("m4", "bí mật"));
            assert.equal(norm("m4"), "[deleted]");
            assert.equal(searchMessages({ query: "bi mat" }).length, 0, "a withdrawn message is not a hit");
        });
    });

    describe("the one-way backfill", () => {
        function oldRow(id, text) {
            const d = rawDb();
            d.prepare(
                "INSERT INTO messages (msgId, threadId, senderId, text, timestamp, type, raw_data) VALUES (?,?,?,?,?,?,?)",
            ).run(id, "t1", "100", text, T0 + 1000, "text", '{"cliMsgId":"x"}');
            d.close();
        }

        it("fills in the rows an older version wrote, from their text, the first time a search runs", () => {
            oldRow("old1", "Được rồi nhé");
            assert.deepEqual(
                searchMessages({ query: "duoc roi" }).map((r) => r.msgId),
                ["old1"],
            );
        });

        it("changes nothing but the fold: not the text, not the raw data, not a fold that is already there", () => {
            oldRow("old2", "Xin chào");
            const d = rawDb();
            d.prepare(
                "INSERT INTO messages (msgId, threadId, text, text_norm, timestamp, type) VALUES ('keep','t1','Ơi','custom',1,'text')",
            ).run();
            const before = d.prepare("SELECT text, raw_data FROM messages WHERE msgId = 'old2'").get();
            d.close();
            const out = backfillTextNorm();
            assert.equal(out.updated, 1);
            assert.equal(out.remaining, false);
            const d2 = rawDb();
            assert.deepEqual(d2.prepare("SELECT text, raw_data FROM messages WHERE msgId = 'old2'").get(), before);
            assert.equal(d2.prepare("SELECT text_norm FROM messages WHERE msgId = 'keep'").get().text_norm, "custom");
            d2.close();
        });

        it("is done when it is done: a second run updates nothing, a row with no text stays without a fold", () => {
            oldRow("old3", "Vâng");
            const d = rawDb();
            d.prepare(
                "INSERT INTO messages (msgId, threadId, timestamp, type) VALUES ('notext','t1',1,'sticker')",
            ).run();
            d.close();
            assert.equal(backfillTextNorm().updated, 1);
            assert.deepEqual(backfillTextNorm(), { updated: 0, remaining: false });
        });

        it("works in chunks, and reports progress", () => {
            for (let i = 0; i < 25; i++) oldRow(`bulk${i}`, `Tin nhắn số ${i}`);
            const seen = [];
            const out = backfillTextNorm({ chunk: 10, onProgress: (d) => seen.push(d) });
            assert.equal(out.updated, 25);
            assert.deepEqual(seen, [10, 20, 25]);
            assert.equal(backfillTextNorm({ chunk: 10, maxRows: 0 }).updated, 0);
        });
    });

    describe("searchMessageRows", () => {
        beforeEach(() => {
            insertMessage(msg("m1", "Hẹn gặp lại nhé"));
            insertMessage(msg("m2", "Được thôi", { senderId: "200" }));
            insertMessage(msg("m3", "ĐƯỢC rồi", { threadId: "t2" }));
            insertMessage(msg("m4", "file được gửi", { type: "file" }));
        });
        const ids = (rows) => rows.map((r) => r.msgId);

        it("finds a word without its accents, whatever the accents or case in the text", () => {
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc" })), ["m4", "m3", "m2"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "gap lai" })), ["m1"]);
        });

        it("filters by conversation, sender, dates and type", () => {
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc", threadId: "t2" })), ["m3"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc", senderId: "200" })), ["m2"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc", since: T0 + 3000, until: T0 + 3000 })), ["m3"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc", types: ["file"] })), ["m4"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "duoc", types: ["file", "text"] })), ["m4", "m3", "m2"]);
        });

        it("takes % _ and \\ in a keyword as themselves", () => {
            insertMessage(msg("w1", "100% chắc"));
            insertMessage(msg("w2", "a_b"));
            insertMessage(msg("w3", "đường C:\\tmp"));
            assert.deepEqual(ids(searchMessageRows({ norm: "100%" })), ["w1"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "a_b" })), ["w2"]);
            assert.deepEqual(ids(searchMessageRows({ norm: "c:\\tmp" })), ["w3"]);
            assert.equal(searchMessageRows({ norm: "a_c" }).length, 0, "_ is not a wildcard");
            assert.equal(searchMessageRows({ norm: "%" }).length, 1, "a lone % finds only the % sign");
        });

        it("pages on (timestamp, msgId), so a message arriving between two pages shifts nothing", () => {
            const first = searchMessageRows({ norm: "duoc", limit: 2 });
            assert.deepEqual(ids(first), ["m4", "m3"]);
            insertMessage(msg("m9", "được mới", { timestamp: T0 + 99_000 }));
            const second = searchMessageRows({ norm: "duoc", after: first.at(-1), limit: 2 });
            assert.deepEqual(ids(second), ["m2"], "the new message is on the first page, not in the way of the second");
        });

        it("orders messages with the same timestamp by id, and pages through them without a repeat", () => {
            for (const id of ["s1", "s2", "s3"]) insertMessage(msg(id, "trùng giờ", { timestamp: T0 + 500_000 }));
            const a = searchMessageRows({ norm: "trung gio", limit: 2 });
            const b = searchMessageRows({ norm: "trung gio", after: a.at(-1), limit: 2 });
            assert.deepEqual([...ids(a), ...ids(b)], ["s3", "s2", "s1"]);
        });

        it("counts the matches by type, ignoring a type filter", () => {
            assert.deepEqual(countSearchMatchesByType({ norm: "duoc", types: ["file"] }), { text: 2, file: 1 });
            assert.deepEqual(countSearchMatchesByType({ norm: "duoc", threadId: "t2" }), { text: 1 });
        });
    });

    describe("the search index (a trigram full-text index, built a slice at a time)", () => {
        const ids = (rows) => rows.map((r) => r.msgId);
        const search = (norm, extra = {}) => ids(searchMessageRows({ norm, ...extra }));
        const ftsRows = () => {
            const d = rawDb();
            const n = d.prepare("SELECT COUNT(*) AS n FROM messages_fts").get().n;
            d.close();
            return n;
        };
        const flag = () => {
            const d = rawDb();
            const r = d.prepare("SELECT value FROM sync_state WHERE key = 'searchIndexReady'").get();
            d.close();
            return r?.value;
        };
        function oldRow(id, text, ts = 1000) {
            const d = rawDb();
            d.prepare(
                "INSERT INTO messages (msgId, threadId, senderId, text, timestamp, type) VALUES (?,?,?,?,?,?)",
            ).run(id, "t1", "100", text, ts, "text");
            d.close();
        }
        afterEach(() => configureSearchIndex({ budgetMs: 2000 }));

        it("answers by scanning while it is not built, and finds rows that have no fold yet", () => {
            oldRow("old1", "Được rồi nhé", 1000);
            oldRow("old2", "Không sao", 2000);
            insertMessage(msg("new1", "được luôn", { timestamp: 3000 }));
            configureSearchIndex({ budgetMs: 0 });
            assert.deepEqual(search("duoc"), ["new1", "old1"], "an old row is found without its fold");
            assert.deepEqual(search("khong"), ["old2"]);
            assert.equal(flag(), undefined, "nothing was built");
            assert.deepEqual(ensureSearchIndex({ budgetMs: 0 }), { ready: false, phase: "fold" });
        });

        it("finishes the fold first when the budget ran out in it, and says how far it is", () => {
            const d = rawDb();
            const add = d.prepare(
                "INSERT INTO messages (msgId, threadId, senderId, text, timestamp, type) VALUES (?,?,?,?,?,?)",
            );
            d.transaction(() => {
                for (let i = 0; i < 12_000; i++) add.run(`f${i}`, "t1", "100", `Được số ${i}`, 1000 + i, "text");
            })();
            d.close();
            const seen = [];
            configureSearchIndex({ budgetMs: 1e-9, onProgress: (p) => seen.push(p) });
            assert.equal(search("duoc so 11999", { limit: 5 }).length, 1);
            const folds = seen.filter((p) => p.phase === "fold");
            assert.ok(folds.at(-1).total > 0, "the total was known");
            assert.equal(folds.at(-1).done, folds.at(-1).total, "and the last report is the whole of it");
            const left = rawDb();
            assert.equal(left.prepare("SELECT COUNT(*) AS n FROM messages WHERE text_norm IS NULL").get().n, 0);
            left.close();
            assert.equal(
                flag(),
                undefined,
                "only the fold was finished in the foreground; the index is built in slices",
            );
        });

        it("builds the fold, the index and the order index, then says so", () => {
            oldRow("old1", "Được rồi nhé");
            insertMessage(msg("new1", "được luôn"));
            const out = ensureSearchIndex();
            assert.deepEqual(out, { ready: true, phase: "ready" });
            assert.equal(flag(), "1");
            assert.equal(ftsRows(), 2);
            const d = rawDb();
            const names = d
                .prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_messages_ts','messages_fts')")
                .all();
            d.close();
            assert.equal(names.length, 2);
            assert.deepEqual(search("duoc").sort(), ["new1", "old1"]);
        });

        it("keeps up with the writers: a new message, an edit, a recall and a delete", () => {
            insertMessage(msg("m1", "hẹn gặp lại"));
            ensureSearchIndex();
            insertMessage(msg("m2", "cảm ơn nhiều"));
            assert.deepEqual(search("cam on"), ["m2"], "a message written after the index is found");
            insertMessage(msg("m2", "xin chào bạn"));
            assert.deepEqual(search("cam on"), [], "an edit takes the old words out");
            assert.deepEqual(search("xin chao"), ["m2"], "and puts the new ones in");
            markMessageRecalled("m1", T0);
            assert.deepEqual(search("hen gap"), [], "a recalled message is not found");
            const d = rawDb();
            d.prepare("DELETE FROM messages WHERE msgId = 'm2'").run();
            d.close();
            assert.deepEqual(search("xin chao"), [], "a deleted row leaves the index");
            assert.equal(ftsRows(), 1, "only the recalled one's tombstone text is left, which a search never returns");
        });

        it("finds exactly what the scan finds, whatever the keyword: short, with spaces, quotes and wildcards", () => {
            for (const [i, text] of [
                "100% chắc",
                'nói "xin chào"',
                "a_b c",
                "đường C:\\tmp",
                "ab",
                "Được ạ",
            ].entries()) {
                insertMessage(msg(`q${i}`, text, { timestamp: T0 + i * 1000 }));
            }
            const keywords = [
                "100%",
                '"xin',
                'xin chao"',
                "a_b",
                "c:\\tmp",
                "ab",
                "duoc a",
                "o",
                "chac",
                "a_c",
                "xin chao",
            ];
            configureSearchIndex({ budgetMs: 0 });
            const scanned = keywords.map((k) => search(k));
            configureSearchIndex({ budgetMs: 2000 });
            ensureSearchIndex();
            const indexed = keywords.map((k) => search(k));
            assert.deepEqual(indexed, scanned);
            assert.deepEqual(search("100%"), ["q0"], "the keywords were found at all, not just equally missed");
        });

        it("indexes in slices and carries on where an interrupted run stopped", () => {
            for (let i = 0; i < 25; i++) oldRow(`bulk${i}`, `tin nhắn số ${i}`, 1000 + i);
            let slices = 0;
            assert.throws(
                () =>
                    ensureSearchIndex({
                        sliceRows: 10,
                        onProgress: (p) => {
                            if (p.phase === "index" && ++slices === 1) throw new Error("interrupted");
                        },
                    }),
                /interrupted/,
            );
            assert.equal(flag(), undefined, "not ready: it was cut short");
            assert.equal(ftsRows(), 10, "the slice that was committed stays");
            const seen = [];
            ensureSearchIndex({ sliceRows: 10, onProgress: (p) => seen.push(p) });
            assert.deepEqual(
                seen.map((p) => p.phase),
                ["index", "index"],
                "the second run did the rest, in two slices",
            );
            assert.equal(ftsRows(), 25);
            assert.equal(search("tin nhan so").length, 25);
        });

        it("indexing a row that is already indexed is harmless (a writer's trigger got there first)", () => {
            insertMessage(msg("m1", "được rồi"));
            insertMessage(msg("m2", "cảm ơn"));
            ensureSearchIndex();
            // Forget how far it got, as a run interrupted before it saved its place would.
            const d = rawDb();
            d.prepare("DELETE FROM sync_state WHERE key IN ('searchIndexCursor','searchIndexReady')").run();
            d.close();
            initDb(file);
            assert.deepEqual(ensureSearchIndex(), { ready: true, phase: "ready" });
            assert.equal(ftsRows(), 2, "each row once");
            assert.deepEqual(search("duoc roi"), ["m1"]);
        });

        it("stops at its budget and reports where it was", () => {
            for (let i = 0; i < 12; i++) oldRow(`b${i}`, `dòng ${i}`, 1000 + i);
            const out = ensureSearchIndex({ budgetMs: 1e-9, sliceRows: 5 });
            assert.equal(out.ready, false);
            assert.ok(["fold", "index"].includes(out.phase));
            assert.deepEqual(ensureSearchIndex({ sliceRows: 5 }), { ready: true, phase: "ready" });
        });

        it("is ready at once when the database was indexed before, and builds nothing twice", () => {
            insertMessage(msg("m1", "được"));
            ensureSearchIndex();
            initDb(file);
            const seen = [];
            assert.deepEqual(ensureSearchIndex({ onProgress: (p) => seen.push(p) }), { ready: true, phase: "ready" });
            assert.deepEqual(seen, []);
            assert.deepEqual(search("duoc"), ["m1"]);
        });
    });

    describe("around a message, and how far back the cache goes", () => {
        beforeEach(() => {
            for (let i = 1; i <= 7; i++) insertMessage(msg(`c${i}`, `dòng ${i}`));
            insertMessage(msg("other", "khác", { threadId: "t2", timestamp: T0 - 5000 }));
            insertMessage(msg("gone", "xóa", { timestamp: T0 + 4500 }));
            markMessageRecalled("gone", T0);
            upsertThread({ threadId: "t1", name: "A", type: "dm", lastUpdate: T0 });
            upsertThread({ threadId: "t2", name: "B", type: "dm", lastUpdate: T0 });
        });

        it("gives the neighbors on both sides, oldest first, never the message itself or a tombstone", () => {
            const got = getMessagesAround("t1", { timestamp: T0 + 4000, msgId: "c4" }, 2, 2);
            assert.deepEqual(
                got.before.map((r) => r.msgId),
                ["c2", "c3"],
            );
            assert.deepEqual(
                got.after.map((r) => r.msgId),
                ["c5", "c6"],
            );
        });

        it("gives fewer at the ends of the conversation, and none for 0", () => {
            const first = getMessagesAround("t1", { timestamp: T0 + 1000, msgId: "c1" }, 3, 1);
            assert.deepEqual(first.before, []);
            assert.deepEqual(
                first.after.map((r) => r.msgId),
                ["c2"],
            );
            const none = getMessagesAround("t1", { timestamp: T0 + 4000, msgId: "c4" }, 0, 0);
            assert.deepEqual(none, { before: [], after: [] });
        });

        it("tells the oldest message of one conversation and of the whole account", () => {
            assert.equal(getOldestCachedTimestamp("t1"), T0 + 1000);
            assert.equal(getOldestCachedTimestamp("t2"), T0 - 5000);
            assert.equal(getOldestCachedTimestamp(), T0 - 5000);
            assert.equal(getOldestCachedTimestamp("nowhere"), null);
        });
    });

    describe("searchPage", () => {
        beforeEach(() => {
            insertMessage(msg("m1", "Được rồi nhé"));
            insertMessage(msg("m2", "duoc roi"));
            insertMessage(msg("m3", "ĐƯỢC"));
            insertMessage(msg("m4", "Chào bạn, được không?", { type: "text" }));
            insertMessage(msg("m5", "báo cáo được duyệt.xlsx", { type: "file" }));
            insertMessage(msg("m6", "https://x.vn/được", { type: "link" }));
        });
        const ids = (page) => page.hits.map((h) => h.row.msgId);

        it("finds what people type without accents, which a plain LIKE did not (the measured misses)", () => {
            assert.equal(searchPage({ query: "duoc" }).count, 6);
            assert.equal(searchPage({ query: "khong" }).count, 1);
            assert.equal(searchPage({ query: "Chao" }).count, 1);
        });

        it("matches the accents too in the exact mode, and still ignores case", () => {
            const exact = searchPage({ query: "được", accents: "exact" });
            assert.deepEqual(ids(exact).sort(), ["m1", "m3", "m4", "m5", "m6"]);
            assert.deepEqual(
                ids(searchPage({ query: "duoc", accents: "exact" })),
                ["m2"],
                "no accents typed: only the unaccented text",
            );
            assert.equal(exact.accents, "exact");
        });

        it("treats the composed and the decomposed spelling of a keyword alike, in both modes", () => {
            for (const accents of ["fold", "exact"]) {
                const composed = searchPage({ query: "được".normalize("NFC"), accents });
                const decomposed = searchPage({ query: "được".normalize("NFD"), accents });
                assert.deepEqual(ids(decomposed), ids(composed), accents);
            }
        });

        it("cuts a keyword to 100 characters and says so; an empty one is an error", () => {
            const long = searchPage({ query: "được " + "x".repeat(150) });
            assert.equal(long.truncatedKeyword, true);
            assert.equal(long.query.length, 100);
            assert.throws(() => searchPage({ query: "   " }), /query is required/);
            assert.throws(() => searchPage({}), /query is required/);
        });

        it("pages with a cursor: every hit once, in order, and the last page has none", () => {
            const seen = [];
            let cursor;
            let pages = 0;
            do {
                const page = searchPage({ query: "duoc", limit: 4, cursor });
                seen.push(...ids(page));
                cursor = page.nextCursor;
                pages++;
                if (cursor) assert.equal(page.hasMore, true);
            } while (cursor);
            assert.equal(pages, 2);
            assert.deepEqual(seen, ["m6", "m5", "m4", "m3", "m2", "m1"]);
            assert.equal(new Set(seen).size, 6);
        });

        it("fills an exact page even when many candidates fail the accent check", () => {
            for (let i = 0; i < 250; i++) insertMessage(msg(`z${i}`, `duoc ${i}`, { timestamp: T0 + 900_000 + i }));
            const page = searchPage({ query: "được", accents: "exact", limit: 3 });
            assert.equal(
                page.count,
                3,
                "the 250 unaccented candidates, more than a batch, did not leave the page short",
            );
            assert.deepEqual(ids(page), ["m6", "m5", "m4"]);
            assert.equal(page.hasMore, true);
        });

        it("refuses a cursor that is not one of ours", () => {
            assert.throws(() => searchPage({ query: "duoc", cursor: "not-a-cursor" }), /Invalid cursor/);
            assert.throws(() => decodeCursor(Buffer.from('{"t":"x"}').toString("base64url")), /Invalid cursor/);
            assert.equal(decodeCursor(undefined), null);
            assert.deepEqual(decodeCursor(encodeCursor({ timestamp: 5, msgId: "a" })), { timestamp: 5, msgId: "a" });
        });

        it("gives the tabs' numbers on the first page, unless asked for on a later one, and counts exact ones exactly", () => {
            const first = searchPage({ query: "duoc", limit: 2 });
            assert.deepEqual(first.counts, { text: 4, file: 1, link: 1 });
            const later = searchPage({ query: "duoc", limit: 2, cursor: first.nextCursor });
            assert.equal(later.counts, null);
            assert.deepEqual(
                searchPage({ query: "duoc", limit: 2, cursor: first.nextCursor, counts: true }).counts,
                first.counts,
            );
            assert.deepEqual(searchPage({ query: "được", accents: "exact" }).counts, { text: 3, file: 1, link: 1 });
        });

        it("filters by type, with aliases for groups of them", () => {
            assert.deepEqual(ids(searchPage({ query: "duoc", types: "file" })), ["m5"]);
            assert.deepEqual(ids(searchPage({ query: "duoc", types: "files,links" })).sort(), ["m5", "m6"]);
            assert.deepEqual(resolveTypes("media"), ["photo", "video"]);
            assert.deepEqual(resolveTypes(["Text", "text"]), ["text"]);
            assert.equal(resolveTypes("all"), undefined);
            assert.equal(resolveTypes(""), undefined);
        });

        it("shows context around each hit when asked, and none otherwise", () => {
            assert.equal(searchPage({ query: "chào" }).hits[0].context, undefined);
            const withContext = searchPage({ query: "chào", context: 2 }).hits[0];
            assert.deepEqual(
                withContext.context.before.map((r) => r.msgId),
                ["m2", "m3"],
            );
            assert.deepEqual(
                withContext.context.after.map((r) => r.msgId),
                ["m5", "m6"],
            );
            assert.equal(
                searchPage({ query: "chào", context: 99 }).hits[0].context.before.length,
                3,
                "at most what exists",
            );
        });

        it("limits a page to 200 and defaults it to 50", () => {
            for (let i = 0; i < 260; i++) insertMessage(msg(`p${i}`, `trang ${i}`, { timestamp: T0 + 700_000 + i }));
            assert.equal(searchPage({ query: "trang", limit: 100000 }).count, 200);
            assert.equal(searchPage({ query: "trang", limit: 100000 }).hasMore, true);
            assert.equal(searchPage({ query: "trang" }).count, 50);
            assert.equal(searchPage({ query: "trang", limit: 0 }).count, 50);
            assert.equal(searchPage({ query: "trang", limit: "abc" }).count, 50);
        });

        it("builds a preview of each hit, with the match located in it", () => {
            const page = searchPage({ query: "duoc", limit: 1 });
            assert.equal(page.hits[0].snippet.text, "https://x.vn/được");
            const s = page.hits[0].snippet;
            assert.equal(s.text.slice(s.matchStart, s.matchEnd), "đượ".slice(0, 0) + "được");
        });
    });

    describe("makeSnippet", () => {
        it("keeps 70 characters before the match and 30 after, with ellipses where the text goes on", () => {
            const text = "a".repeat(100) + " được " + "b".repeat(100);
            const s = makeSnippet(text, "duoc");
            assert.equal(s.text.startsWith("…"), true);
            assert.equal(s.text.endsWith("…"), true);
            assert.equal(s.text.slice(s.matchStart, s.matchEnd), "được");
            assert.equal(s.text.length, 1 + 70 + 4 + 30 + 1);
            assert.equal(s.matchStart, 1 + 70);
        });

        it("shows a short text whole, without ellipses", () => {
            const s = makeSnippet("Hẹn gặp lại", "gap");
            assert.equal(s.text, "Hẹn gặp lại");
            assert.equal(s.text.slice(s.matchStart, s.matchEnd), "gặp");
        });

        it("finds the match through accents, in a decomposed text too, and turns line breaks into spaces", () => {
            const text = "dòng một\nCảm ơn bạn nhiều".normalize("NFD");
            const s = makeSnippet(text, "cam on");
            assert.equal(s.text.includes("\n"), false);
            assert.equal(s.text.slice(s.matchStart, s.matchEnd).normalize("NFC"), "Cảm ơn");
        });

        it("keeps the match where the text puts it however many spaces and line breaks come before it", () => {
            const s = makeSnippet("hai    chữ\n\n\n\n  rồi cảm ơn bạn", "cam on");
            assert.equal(s.text.slice(s.matchStart, s.matchEnd), "cảm ơn");
        });

        it("cuts a text that holds no match, without a highlight", () => {
            const s = makeSnippet("x".repeat(300), "duoc");
            assert.equal(s.matchStart, null);
            assert.equal(s.text.length, 101);
            assert.deepEqual(makeSnippet(null, "duoc"), { text: "", matchStart: null, matchEnd: null });
        });
    });

    describe("what the search could not see", () => {
        beforeEach(() => {
            insertMessage(msg("m1", "Được", { timestamp: Date.UTC(2026, 8, 20) }));
            upsertThread({ threadId: "t1", name: "A", type: "dm", lastUpdate: T0 });
        });

        it("says how far back the cache reaches, and that no phone restore has finished", () => {
            const c = searchCoverage();
            assert.equal(c.oldestCachedAt, "2026-09-20T00:00:00.000Z");
            assert.equal(c.lastSyncAt, null);
            assert.match(c.note, /local cache only, which holds messages since 2026-09-20/);
            assert.match(c.note, /No phone restore has finished/);
            assert.equal(c.pendingGaps, 0);
        });

        it("names the pending coverage gaps and the command that closes them", () => {
            recordSyncGap(Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 4), "reconnect-gap");
            const c = searchCoverage();
            assert.equal(c.pendingGaps, 1);
            assert.match(c.command, /^zalo-agent sync --from 2026-10-03/);
            assert.ok(c.note.includes(c.command));
        });

        it("is quiet about the restore once one has finished, and scopes the note to a conversation", () => {
            setSyncState("lastSyncOkAt", Date.UTC(2026, 9, 5));
            const c = searchCoverage({ threadId: "t1" });
            assert.equal(c.lastSyncAt, "2026-10-05T00:00:00.000Z");
            assert.doesNotMatch(c.note, /No phone restore/);
            assert.match(c.note, /in this conversation/);
        });

        it("is part of every page", () => {
            const page = searchPage({ query: "duoc" });
            assert.equal(page.coverage.oldestCachedAt, "2026-09-20T00:00:00.000Z");
        });
    });
});
