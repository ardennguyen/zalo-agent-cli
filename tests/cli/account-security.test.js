/**
 * `account security …` against a 2.x-style config dir: a plaintext saved login is reported, migrated (sealed, verified,
 * the plaintext gone), rekeyed and re-wrapped, and `account export` still writes the login out exactly as before. A
 * plaintext zalo.db is reported, encrypted by `migrate` and re-encrypted by `rekey` the same way. Also:
 * a file the key layer cannot open is a message, never a stack trace or a silent "not logged in".
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { Database, dbFileState } from "../../src/core/sqlite.js";
import { runCli } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 60_000 };
const OWN = "1000000000000000901";
const CREDS = {
    imei: "fake-imei-cli",
    cookie: [{ key: "zpw_sek", value: "fake-cookie-cli" }],
    userAgent: "ua",
    language: "vi",
};
const CRED_FILE = join(CONFIG_DIR, "credentials", `cred_${OWN}.json`);
const DB_FILE = join(CONFIG_DIR, "accounts", OWN, "zalo.db");
const MARKER = "plaintext-row-cli-q4";
const MEDIA_FILE = join(CONFIG_DIR, "accounts", OWN, "media", "200000000000000901", "photo.jpg");
const MEDIA_MARKER = "plaintext-media-cli-q4";

const json = async (args, env = {}) => {
    const r = await runCli(["--json", ...args], { ...options, env });
    let value = null;
    try {
        value = JSON.parse(r.stdout);
    } catch {
        /* asserted below */
    }
    return { ...r, value };
};

before(() => {
    assertSandboxed(CONFIG_DIR);
    mkdirSync(join(CONFIG_DIR, "credentials"), { recursive: true });
    mkdirSync(join(CONFIG_DIR, "accounts", OWN), { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify([{ ownId: OWN, name: "Fake", proxy: null, active: true }]),
    );
    // What 2.x left behind: the login in plaintext.
    writeFileSync(CRED_FILE, JSON.stringify(CREDS, null, 2));
    // ...and its message cache in plaintext.
    const db = new Database(DB_FILE);
    db.exec("CREATE TABLE messages (msgId TEXT PRIMARY KEY, text TEXT)");
    db.prepare("INSERT INTO messages VALUES ('m1', ?)").run(MARKER);
    db.close();
    // ...and a downloaded photo in plaintext.
    mkdirSync(join(MEDIA_FILE, ".."), { recursive: true });
    writeFileSync(MEDIA_FILE, `${MEDIA_MARKER}${"x".repeat(5000)}`);
});

describe("account security", () => {
    it("status reports the plaintext login and no keyring yet, and reads no key", async () => {
        const r = await json(["account", "security", "status"]);
        assert.equal(r.code, 0, r.all);
        assert.equal(r.value.ownId, OWN);
        assert.equal(r.value.keyring, null);
        assert.equal(r.value.files.find((f) => f.kind === "credentials").state, "plaintext");
        assert.equal(r.value.files.find((f) => f.kind === "message-database").state, "plaintext");
        const media = r.value.files.find((f) => f.kind === "media");
        assert.deepEqual([media.state, media.plaintext, media.sealed], ["plaintext", 1, 0]);
        assert.equal(r.value.plaintextFiles, 3);
        assert.equal(readFileSync(CRED_FILE, "utf8"), JSON.stringify(CREDS, null, 2), "status changes nothing");
    });

    it("migrate seals it, the plaintext is gone, and a second run is a no-op", async () => {
        const r = await json(["account", "security", "migrate"]);
        assert.equal(r.code, 0, r.all);
        assert.equal(r.value.files.find((f) => f.kind === "credentials").result, "sealed");
        const bytes = readFileSync(CRED_FILE);
        assert.equal(bytes.subarray(0, 7).toString(), "ZACSEAL");
        assert.ok(!bytes.includes(Buffer.from("fake-cookie-cli")));
        assert.equal(r.value.files.find((f) => f.kind === "message-database").result, "encrypted");
        assert.equal(dbFileState(DB_FILE), "encrypted");
        assert.ok(!readFileSync(DB_FILE).includes(Buffer.from(MARKER)));
        const media = r.value.files.find((f) => f.kind === "media");
        assert.deepEqual([media.result, media.sealed], ["encrypted", 1]);
        assert.equal(readFileSync(MEDIA_FILE).subarray(0, 8).toString(), "ZACMEDIA");
        assert.ok(!readFileSync(MEDIA_FILE).includes(Buffer.from(MEDIA_MARKER)));
        const again = await json(["account", "security", "migrate"]);
        assert.equal(again.value.files.find((f) => f.kind === "credentials").result, "already-sealed");
        assert.equal(again.value.files.find((f) => f.kind === "message-database").result, "already-encrypted");
        assert.equal(again.value.files.find((f) => f.kind === "media").result, "already-encrypted");
        const s = await json(["account", "security", "status"]);
        assert.equal(s.value.provider.name, "test");
        assert.equal(s.value.keyring.version, 1);
        assert.equal(s.value.dkeyLayer.active, false);
        assert.ok(!r.all.includes("fake-cookie-cli") && !s.all.includes("wrapped"));
    });

    it("rekey re-seals under new keys; provider re-wraps; the login still opens", async () => {
        const before = (await json(["account", "security", "status"])).value.keyring.keys.map((k) => k.id);
        const r = await json(["account", "security", "rekey"]);
        assert.equal(r.code, 0, r.all);
        assert.equal(r.value.resealed, 1);
        assert.deepEqual(r.value.databases, [
            { kind: "message-database", state: "encrypted", currentKey: true },
            { kind: "webhook-outbox", state: "absent" },
        ]);
        // The photo's key slot was re-wrapped: sealed, none left under the old key.
        assert.deepEqual(r.value.media, { sealed: 1, staleKey: 0, plaintext: 0, unreadable: 0 });
        const after = (await json(["account", "security", "status"])).value;
        const db = after.files.find((f) => f.kind === "message-database");
        assert.equal(db.currentKey, true);
        assert.equal(db.keyId, after.keyring.keys.find((k) => k.use === "data").id);
        assert.ok(after.keyring.keys.every((k) => !before.includes(k.id)));
        assert.ok(after.files.find((f) => f.kind === "credentials").currentKey);
        const p = await json(["account", "security", "provider", "test"]);
        assert.equal(p.code, 0, p.all);
        assert.deepEqual(p.value.accounts, [{ ownId: OWN, from: "test", to: "test" }]);
    });

    it("provider kms <ownId> --key keeps a tenant's key for that account only; every later command opens it", async () => {
        const file = join(CONFIG_DIR, "storage.json");
        try {
            const p = await json([
                "account",
                "security",
                "provider",
                "kms",
                OWN,
                "--backend",
                "test",
                "--key",
                "tenant-a",
            ]);
            assert.equal(p.code, 0, p.all);
            const settings = JSON.parse(readFileSync(file, "utf8"));
            assert.equal(settings.provider, "kms");
            assert.equal(settings.kms, undefined, "the default is not the tenant's key");
            assert.deepEqual(settings.accounts[OWN].kms, { backend: "test", key: "tenant-a" });
            // A process whose default names another key (a purge or backup unit, `za`) still opens the account.
            const s = await json(["account", "security", "status"], { ZALO_KMS_KEY: "another-tenant" });
            assert.equal(s.code, 0, s.all);
            assert.equal(s.value.provider.name, "kms");
            assert.equal(s.value.provider.key, "tenant-a");
            const r = await json(["account", "security", "rekey"], { ZALO_KMS_KEY: "another-tenant" });
            assert.equal(r.code, 0, r.all);
            const back = await json(["account", "security", "provider", "test", OWN]);
            assert.equal(back.code, 0, back.all);
        } finally {
            rmSync(file, { force: true });
        }
    });

    it("account export still writes the login out in plaintext, as it always did", async () => {
        const out = join(SANDBOX_HOME, "exported.json");
        const r = await json(["account", "export", "--output", out, "--yes"]);
        assert.equal(r.code, 0, r.all);
        const exported = JSON.parse(readFileSync(out, "utf8"));
        assert.deepEqual(
            { ...exported, proxy: undefined, ownId: undefined, name: undefined },
            {
                ...CREDS,
                proxy: undefined,
                ownId: undefined,
                name: undefined,
            },
        );
        assert.equal(exported.ownId, OWN);
    });

    it("account export without --yes writes nothing and exits 2; --dry-run exits 0 and writes nothing", async () => {
        const out = join(SANDBOX_HOME, "unconfirmed.json");
        const refused = await json(["account", "export", "--output", out]);
        assert.equal(refused.code, 2, refused.all);
        assert.equal(existsSync(out), false);
        const preview = await json(["account", "export", "--output", out, "--dry-run"]);
        assert.equal(preview.code, 0, preview.all);
        assert.equal(existsSync(out), false);
    });

    it("a provider that cannot be used is a clear message (exit 1), never a stack trace", async () => {
        const r = await runCli(["account", "export", "--output", join(SANDBOX_HOME, "x.json"), "--yes"], {
            ...options,
            env: { ZALO_STORAGE_PROVIDER: "nope" },
        });
        assert.equal(r.code, 1, r.all);
        assert.match(r.all, /unknown key provider "nope"/);
        assert.doesNotMatch(r.all, /\n\s+at .*\.js:\d+/);
    });
});
