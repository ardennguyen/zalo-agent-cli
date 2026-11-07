/**
 * The SQLite driver (src/core/sqlite.js, `better-sqlite3-multiple-ciphers`): what the app relies on from it. It replaced
 * `better-sqlite3` in 3.0.0; these pin that the swap kept every feature the cache uses (the trigram full-text index,
 * the JSON functions, WAL, app functions) and that the cipher methods are there.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { Database } from "../../src/core/sqlite.js";
import { stripVietnamese } from "../../src/utils/vn-text.js";

const require = createRequire(import.meta.url);

describe("sqlite driver", () => {
    let dir;
    let db;
    before(() => {
        assertSandboxed(CONFIG_DIR);
        dir = join(CONFIG_DIR, "driver-tests");
        mkdirSync(dir, { recursive: true });
        db = new Database(join(dir, "driver.db"));
    });
    after(() => db?.close());

    it("is the pinned multiple-ciphers build, not better-sqlite3", () => {
        const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
        assert.equal(pkg.dependencies["better-sqlite3-multiple-ciphers"], "13.0.3");
        assert.equal(pkg.dependencies["better-sqlite3"], undefined);
        assert.equal(require("better-sqlite3-multiple-ciphers/package.json").version, "13.0.3");
    });

    it("runs WAL", () => {
        assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    });

    it("has the trigram FTS5 tokenizer the search index uses", () => {
        db.exec("CREATE VIRTUAL TABLE f USING fts5(t, tokenize='trigram')");
        db.prepare("INSERT INTO f (t) VALUES (?)").run("xin chao ban nhe");
        const hits = db.prepare("SELECT t FROM f WHERE f MATCH ?").all("chao");
        assert.deepEqual(
            hits.map((r) => r.t),
            ["xin chao ban nhe"],
        );
    });

    it("has json_valid / json_extract (the client-id expression guards with them)", () => {
        const row = db
            .prepare(
                "SELECT json_valid(?) AS ok, CASE WHEN json_valid(?) THEN json_extract(?, '$.cliMsgId') END AS cli",
            )
            .get('{"cliMsgId":"7"}', "not json", "not json");
        assert.equal(row.ok, 1);
        assert.equal(row.cli, null);
    });

    it("runs an app function like vn_strip", () => {
        db.function("vn_strip", { deterministic: true }, (s) => (s === null ? null : stripVietnamese(s)));
        assert.equal(db.prepare("SELECT vn_strip(?) AS v").get("Đà Nẵng").v, "da nang");
    });

    it("has the cipher methods (key / rekey) and the cipher pragmas", () => {
        assert.equal(typeof db.key, "function");
        assert.equal(typeof db.rekey, "function");
        const mem = new Database(":memory:");
        try {
            assert.deepEqual(mem.pragma("cipher = 'sqlcipher'"), [{ sqlcipher: "sqlcipher" }]);
        } finally {
            mem.close();
        }
    });
});
