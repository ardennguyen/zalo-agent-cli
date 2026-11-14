/**
 * `db usage` and `db purge` driven as the binary on a sandbox account with no daemon and no login: the purge is
 * guarded (exit 2 without --yes or --dry-run, nothing removed), --dry-run counts, --yes removes what the retention
 * policy (set with `policy set`) makes due, and `db usage` reports the result.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, getMessageById, initDb, insertMessage } from "../../src/core/db.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
const OWN = "5353";
const DAY = 86_400_000;
const json = (r) => JSON.parse(stripAnsi(r.stdout));

describe("db usage / db purge", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        mkdirSync(getAccountDir(OWN), { recursive: true });
        initDb(getAccountDbPath(OWN));
        const now = Date.now();
        for (let i = 0; i < 6; i++) {
            insertMessage({
                msgId: `m${i}`,
                threadId: "t1",
                senderId: "u",
                text: `hello ${i}`,
                // m0..m2 are 100+ days old, m3..m5 a day old.
                timestamp: i < 3 ? now - (100 + i) * DAY : now - DAY,
                type: "text",
            });
        }
        closeDb();
    });

    it("purge without --yes or --dry-run exits 2 and removes nothing", async () => {
        const set = await runCli(["policy", "set", "retention.messages", "30d"], options);
        assert.equal(set.code, 0, set.all);
        const r = await runCli(["db", "purge"], options);
        assert.equal(r.code, 2, r.all);
        initDb(getAccountDbPath(OWN));
        assert.ok(getMessageById("m0"));
        closeDb();
    });

    it("--dry-run counts what is due; --yes removes it; usage shows the purge", async () => {
        const dry = await runCli(["--json", "db", "purge", "--dry-run"], options);
        assert.equal(dry.code, 0, dry.all);
        assert.equal(json(dry).retention.messages.rows, 3);
        assert.equal(json(dry).via, "local");
        const run = await runCli(["--json", "db", "purge", "--yes"], options);
        assert.equal(run.code, 0, run.all);
        assert.equal(json(run).retention.messages.rows, 3);
        initDb(getAccountDbPath(OWN));
        assert.equal(getMessageById("m0"), null);
        assert.ok(getMessageById("m5"));
        closeDb();
        const usage = await runCli(["--json", "db", "usage"], options);
        assert.equal(usage.code, 0, usage.all);
        const u = json(usage);
        assert.equal(u.retention.messages, "30d");
        assert.ok(u.usage.db > 0);
        assert.ok(u.lastPurge?.at, "the purge is recorded");
    });
});
