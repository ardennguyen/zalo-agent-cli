/**
 * `msg search` driven as the binary: the local cache only, with no login and no network, accent-insensitive by default.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath } from "../../src/core/credentials.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";
import { runCli, stripAnsi } from "../helpers/cli.js";
import { indexProgressReporter } from "../../src/commands/msg-search.js";

const options = { home: SANDBOX_HOME, timeout: 40_000 };
const OWN = "4242";
const NOW = Date.now();
const DAY = 86_400_000;

function json(result) {
    return JSON.parse(stripAnsi(result.stdout));
}

describe("msg search", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        mkdirSync(join(CONFIG_DIR, "accounts", OWN), { recursive: true });
        initDb(getAccountDbPath(OWN));
        upsertThread({ threadId: "g1", name: "Nhóm Dự Án", type: "group", lastUpdate: NOW });
        const base = { threadId: "g1", senderId: "u2", senderName: "Anh Minh", type: "text" };
        insertMessage({ ...base, msgId: "a1", text: "Được rồi, hẹn gặp lại", timestamp: NOW - 3 * DAY });
        insertMessage({
            ...base,
            msgId: "a2",
            text: "duoc nhe",
            timestamp: NOW - 2 * DAY,
            senderId: OWN,
            senderName: "Tester",
        });
        insertMessage({
            ...base,
            msgId: "a3",
            text: "báo cáo được duyệt.xlsx",
            timestamp: NOW - 1 * DAY,
            type: "file",
        });
        insertMessage({ ...base, msgId: "a4", text: "họp cũ được hủy", timestamp: NOW - 60 * DAY });
    });

    it("lists its options", async () => {
        const r = await runCli(["msg", "search", "--help"], options);
        assert.equal(r.code, 0);
        for (const flag of [
            "--thread",
            "--from",
            "--since",
            "--until",
            "--last",
            "--type",
            "--limit",
            "--cursor",
            "--context",
            "--exact",
        ]) {
            assert.match(r.all, new RegExp(flag), flag);
        }
    });

    it("finds a word typed without accents, offline and without logging in", async () => {
        const r = await runCli(["--json", "msg", "search", "duoc"], options);
        assert.equal(r.code, 0, r.all);
        const out = json(r);
        assert.equal(out.accents, "fold");
        assert.deepEqual(
            out.hits.map((h) => h.msgId),
            ["a3", "a2", "a1", "a4"],
        );
        assert.equal(out.hits[0].threadName, "Nhóm Dự Án");
        assert.equal(
            out.hits[0].snippet.text.slice(out.hits[0].snippet.matchStart, out.hits[0].snippet.matchEnd),
            "được",
        );
        assert.deepEqual(out.counts, { text: 3, file: 1 });
        assert.match(out.coverage.note, /local cache only/);
        assert.doesNotMatch(
            r.all,
            /AutoLogin|Auto-login|login failed/i,
            "a search that reads the cache logs in to nothing",
        );
    });

    it("needs accents to match with --exact, and --type narrows to files", async () => {
        const exact = json(await runCli(["--json", "msg", "search", "duoc", "--exact"], options));
        assert.deepEqual(
            exact.hits.map((h) => h.msgId),
            ["a2"],
        );
        assert.equal(exact.accents, "exact");
        const files = json(await runCli(["--json", "msg", "search", "duoc", "--type", "files"], options));
        assert.deepEqual(
            files.hits.map((h) => h.msgId),
            ["a3"],
        );
    });

    it("filters by period, date, sender and conversation", async () => {
        const last = json(await runCli(["--json", "msg", "search", "duoc", "--last", "7d"], options));
        assert.deepEqual(
            last.hits.map((h) => h.msgId),
            ["a3", "a2", "a1"],
            "the one from 60 days ago is out",
        );
        const day = new Date(NOW - 2 * DAY);
        const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        const one = json(await runCli(["--json", "msg", "search", "duoc", "--since", ymd, "--until", ymd], options));
        assert.deepEqual(
            one.hits.map((h) => h.msgId),
            ["a2"],
        );
        const mine = json(await runCli(["--json", "msg", "search", "duoc", "--from", "me"], options));
        assert.deepEqual(
            mine.hits.map((h) => h.msgId),
            ["a2"],
            "--from me is the active account",
        );
        const here = json(await runCli(["--json", "msg", "search", "duoc", "--thread", "nowhere"], options));
        assert.equal(here.count, 0);
    });

    it("pages with a cursor and shows context", async () => {
        const first = json(await runCli(["--json", "msg", "search", "duoc", "--limit", "2"], options));
        assert.equal(first.hasMore, true);
        const second = json(
            await runCli(["--json", "msg", "search", "duoc", "--limit", "2", "--cursor", first.nextCursor], options),
        );
        assert.deepEqual(
            [...first.hits, ...second.hits].map((h) => h.msgId),
            ["a3", "a2", "a1", "a4"],
        );
        assert.equal(second.hasMore, false);
        const ctx = json(await runCli(["--json", "msg", "search", "duoc", "--exact", "--context", "1"], options));
        assert.deepEqual(
            ctx.hits[0].context.before.map((m) => m.msgId),
            ["a1"],
        );
        assert.deepEqual(
            ctx.hits[0].context.after.map((m) => m.msgId),
            ["a3"],
        );
    });

    it("prints a readable result with the coverage line, and the next-page hint", async () => {
        const r = await runCli(["msg", "search", "duoc", "--limit", "1"], options);
        const text = stripAnsi(r.all);
        assert.equal(r.code, 0, text);
        assert.match(text, /1 result\(s\) for "duoc" \(accents ignored\), more below/);
        assert.match(text, /Nhóm Dự Án/);
        assert.match(text, /More: add --cursor /);
        assert.match(text, /Matches by type: text 3 · file 1/);
        assert.match(text, /Searched the local cache only/);
    });

    it("refuses what cannot be searched, with a message and a failing exit", async () => {
        for (const args of [
            ["msg", "search", "   "],
            ["msg", "search", "x", "--since", "tomorrow-ish"],
            ["msg", "search", "x", "--last", "soon"],
            ["msg", "search", "x", "--since", "2026-10-02", "--until", "2026-10-01"],
            ["msg", "search", "x", "--cursor", "garbage"],
        ]) {
            const r = await runCli(args, options);
            assert.equal(r.code, 1, args.join(" "));
            assert.match(stripAnsi(r.all), /✗/, args.join(" "));
        }
    });
});

describe("the index progress line", () => {
    it("says what it is doing once, then reports at most every fifth of the way", () => {
        const lines = [];
        const report = indexProgressReporter((l) => lines.push(l));
        for (let done = 1000; done <= 10_000; done += 1000) report({ phase: "fold", done, total: 10_000 });
        report({ phase: "index", done: 5000, total: 5000 });
        assert.match(lines[0], /Preparing the search index/);
        const steps = lines.slice(1).filter((l) => l.includes("reading the messages"));
        assert.equal(steps.length, 5, "20%, 40%, 60%, 80%, 100%");
        assert.ok(steps[0].includes("20% (2000 of 10000)"), steps[0]);
        assert.match(lines.at(-1), /building the index: 100%/);
    });

    it("says nothing about a phase whose size it does not know, but still announces itself", () => {
        const lines = [];
        indexProgressReporter((l) => lines.push(l))({ phase: "fold", done: 10, total: null });
        assert.equal(lines.length, 1);
    });
});
