/**
 * Hidden chats stay hidden in `db query` and `db export` until the PIN is given, through the binary against the fake
 * session (tests/helpers/fake-api.js): without `--include-hidden` no row of a hidden chat comes out (even through the
 * search index's own tables or the schema), with it and the right PIN (`--pin-stdin`) they do, and a wrong PIN is
 * refused (exit 1, nothing read or written) and counted toward the lockout. `db export --plaintext` leaves them out of
 * the file it writes unless the PIN was given. A machine that does not know which chats are hidden reads nothing.
 *
 * Red if a hidden message, thread id or name appears in a reply or file without the PIN, if the right PIN does not show
 * them, or if a wrong PIN reads anything or is not counted.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, getAccountDbPath, getAccountDir, saveCredentials } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { closeDb, ensureSearchIndex, initDb, insertMessage } from "../../src/core/db.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { FAKE_OWN_ID } from "../helpers/fake-api.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "index.js");
const FAKE_API = join(ROOT, "tests", "helpers", "fake-api.js");
const NO_NETWORK = join(ROOT, "tests", "helpers", "no-network.mjs");

const PIN = "4826";
const HIDDEN = "1000000000000000016";
const VISIBLE = "1000000000000000017";
const SECRET = "words-only-in-the-hidden-chat";
const md5 = (s) => createHash("md5").update(s).digest("hex");
const replies = { getHiddenConversations: { pin: md5(PIN), threads: [{ thread_id: HIDDEN, is_group: 0 }] } };

/** Run the CLI with the fake session (or none), `stdin` piped in. */
function run(argv, { stdin = "", fake = true } = {}) {
    const env = {
        ...process.env,
        USERPROFILE: SANDBOX_HOME,
        HOME: SANDBOX_HOME,
        ZALO_SANDBOX_ACTIVE: "1",
        ZALO_TEST_FAKE_API_MODE: "normal",
        ZALO_TEST_FAKE_API_REPLIES: JSON.stringify(replies),
        ZALO_AGENT_NO_UPDATE_CHECK: "1",
        NODE_OPTIONS: `--import=${pathToFileURL(NO_NETWORK).href}`,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
    };
    if (fake) env.ZALO_TEST_FAKE_API = FAKE_API;
    else delete env.ZALO_TEST_FAKE_API;
    return new Promise((res) => {
        const child = spawn(process.execPath, [CLI, "--json", ...argv], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 90_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            let out = null;
            try {
                out = JSON.parse(stdout.trim());
            } catch {
                /* left null */
            }
            res({ code, stdout, stderr, out, all: stdout + stderr });
        });
        child.stdin.end(stdin);
    });
}

const dir = () => getAccountDir(FAKE_OWN_ID);
const lockout = () => {
    try {
        return JSON.parse(readFileSync(join(dir(), "hidden-pin-lockout.json"), "utf8"));
    } catch {
        return null;
    }
};
const resetLockout = () => rmSync(join(dir(), "hidden-pin-lockout.json"), { force: true });
/** The id mirror a listener keeps: the hidden thread, as Zalo listed it. */
const writeMirror = () =>
    new HiddenChats({ accountId: FAKE_OWN_ID, stateDir: dir() }).setFromServer({ threads: [{ thread_id: HIDDEN }] });

before(() => {
    assertSandboxed(CONFIG_DIR);
    addAccount(FAKE_OWN_ID, "Fake Self");
    saveCredentials(FAKE_OWN_ID, { imei: "fake-imei", cookie: [], userAgent: "fake-agent", language: "vi" });
    mkdirSync(dir(), { recursive: true });
    initDb(getAccountDbPath(FAKE_OWN_ID));
    insertMessage({ msgId: "v1", threadId: VISIBLE, senderId: "2", text: "visible words", timestamp: 1, type: "text" });
    insertMessage({ msgId: "h1", threadId: HIDDEN, senderId: "3", text: SECRET, timestamp: 2, type: "text" });
    ensureSearchIndex();
    closeDb();
});

describe("db query: hidden chats only with the PIN", () => {
    it("without --include-hidden no statement reaches a hidden row (the search index and the schema included)", async () => {
        writeMirror();
        for (const sql of [
            "SELECT msgId, threadId, text FROM messages",
            "SELECT * FROM messages_fts_content",
            "SELECT m.text FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH 'hidden'",
            "SELECT name, (SELECT group_concat(threadId) FROM messages) AS ids FROM sqlite_master",
        ]) {
            const r = await run(["db", "query", sql], { fake: false });
            assert.equal(r.code, 0, `${sql}\n${r.all}`);
            assert.ok(!r.stdout.includes(SECRET) && !r.stdout.includes(HIDDEN), `${sql}: ${r.stdout}`);
        }
        const r = await run(["db", "query", "SELECT msgId FROM messages ORDER BY msgId"], { fake: false });
        assert.deepEqual(r.out.rows, [{ msgId: "v1" }]);
    });

    it("with --include-hidden and the right PIN the hidden rows are there", async () => {
        resetLockout();
        const r = await run(
            ["db", "query", "SELECT msgId, text FROM messages ORDER BY msgId", "--include-hidden", "--pin-stdin"],
            {
                stdin: `${PIN}\n`,
            },
        );
        assert.equal(r.code, 0, r.all);
        assert.deepEqual(
            r.out.rows.map((x) => x.msgId),
            ["h1", "v1"],
        );
        assert.ok(r.stdout.includes(SECRET));
        assert.doesNotMatch(r.all, new RegExp(PIN), "the PIN is never printed");
    });

    it("a wrong PIN reads nothing (exit 1) and counts toward the lockout", async () => {
        resetLockout();
        const r = await run(["db", "query", "SELECT text FROM messages", "--include-hidden", "--pin-stdin"], {
            stdin: "0000\n",
        });
        assert.equal(r.code, 1, r.all);
        assert.match(r.all, /Wrong PIN/);
        assert.ok(!r.stdout.includes(SECRET) && !r.stdout.includes("visible words"), "nothing was read");
        assert.equal(lockout()?.failures, 1);
    });

    it("without a terminal and without --pin-stdin it asks for the PIN (exit 2) and reads nothing", async () => {
        resetLockout();
        const r = await run(["db", "query", "SELECT text FROM messages", "--include-hidden"]);
        assert.equal(r.code, 2, r.all);
        assert.equal(r.out?.pinRequired, true);
    });

    it("when this machine does not know which chats are hidden and Zalo cannot be asked, it reads nothing", async () => {
        rmSync(join(dir(), "hidden-threads.json"), { force: true });
        const r = await run(["db", "query", "SELECT text FROM messages"], { fake: false });
        assert.equal(r.code, 1, r.all);
        assert.match(r.all, /not known/);
        assert.ok(!r.stdout.includes(SECRET));
        // One login reads the list: then it answers, without them.
        const asked = await run(["db", "query", "SELECT text FROM messages"]);
        assert.equal(asked.code, 0, asked.all);
        assert.deepEqual(asked.out.rows, [{ text: "visible words" }]);
    });
});

describe("db export --plaintext: hidden chats only with the PIN", () => {
    it("without --include-hidden the decrypted file has no trace of a hidden chat; the guard sentence says so", async () => {
        writeMirror();
        const out = join(SANDBOX_HOME, "hidden-left-out.db");
        const dry = await run(["db", "export", "--out", out, "--plaintext", "--dry-run"], { fake: false });
        assert.equal(dry.code, 0, dry.all);
        assert.match(dry.all, /hidden chats are left out unless --include-hidden/);
        const r = await run(["db", "export", "--out", out, "--plaintext", "--yes"], { fake: false });
        assert.equal(r.code, 0, r.all);
        assert.equal(r.out.hiddenChats, "excluded");
        assert.equal(r.out.messages, 1);
        const bytes = readFileSync(out);
        assert.ok(!bytes.includes(SECRET) && !bytes.includes(HIDDEN));
        assert.ok(bytes.includes("visible words"));
    });

    it("with the right PIN they are in the file; a wrong PIN writes nothing and is counted", async () => {
        resetLockout();
        const wrongOut = join(SANDBOX_HOME, "hidden-wrong.db");
        const wrong = await run(
            ["db", "export", "--out", wrongOut, "--plaintext", "--yes", "--include-hidden", "--pin-stdin"],
            { stdin: "1111\n" },
        );
        assert.equal(wrong.code, 1, wrong.all);
        assert.ok(!existsSync(wrongOut));
        assert.equal(lockout()?.failures, 1);
        const out = join(SANDBOX_HOME, "hidden-included.db");
        const r = await run(["db", "export", "--out", out, "--plaintext", "--yes", "--include-hidden", "--pin-stdin"], {
            stdin: `${PIN}\n`,
        });
        assert.equal(r.code, 0, r.all);
        assert.equal(r.out.hiddenChats, null);
        assert.equal(r.out.messages, 2);
        assert.ok(readFileSync(out).includes(SECRET));
        assert.equal(lockout()?.failures, 0, "the right PIN clears the count");
    });
});
