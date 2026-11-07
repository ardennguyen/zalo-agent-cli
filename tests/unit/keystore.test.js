/**
 * The key layer (src/core/keystore/): the sealed container, every key provider (with fakes for the OS tools and the
 * cloud SDKs), the keyring, the migration of plaintext files, the dkey layer, rekey and provider change.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR, getAccountDir, loadCredentials, saveCredentials } from "../../src/core/credentials.js";
import {
    KeystoreError,
    SealError,
    attachLoginSession,
    changeProvider,
    getDataKey,
    isSealed,
    migrateAccount,
    migratePlaintext,
    openBuffer,
    openFile,
    rekeyAccount,
    scopeOf,
    sealBuffer,
    securityStatus,
} from "../../src/core/keystore/index.js";
import { openSealed, seal, unwrapKey, wrapKey } from "../../src/core/keystore/container.js";
import { createProviders, defaultProvider, inTestSandbox } from "../../src/core/keystore/providers.js";
import { createKmsBackends, runKmsTask } from "../../src/core/keystore/kms.js";
import { currentKey, lockAll, readKeyring } from "../../src/core/keystore/keyring.js";
import { createTrustStore } from "../../src/zalo/trust-store.js";
import { loadTranscripts, voiceTextFile } from "../../src/core/voice-text.js";

assertSandboxed(CONFIG_DIR);

const CREDS = { imei: "fake-imei-0001", cookie: [{ key: "zpw_sek", value: "fake-cookie-value" }], userAgent: "ua" };
const FAKE_DKEY = "0123456789abcdef0123456789abcdef";

let n = 0;
/** A fresh account id per test, so keyrings never leak between cases. */
const freshId = () => String(1000000000000000800n + BigInt(n++));

const resetEnv = () => {
    delete process.env.ZALO_STORAGE_DKEY_LAYER;
    delete process.env.ZALO_STORAGE_PROVIDER;
    delete process.env.ZALO_STORAGE_KEY;
};

after(resetEnv);
beforeEach(() => {
    resetEnv();
    lockAll();
});

/** Every encoding a 32-byte key could leak in. */
const leaks = (key) => [key.toString("hex"), key.toString("base64"), key.toString("base64url")];

describe("the sealed container", () => {
    const key = randomBytes(32);
    const meta = { acct: "a1", kind: "credentials", use: "boot", kid: "k1" };

    it("round-trips and starts with the magic", () => {
        const box = seal(key, meta, "secret text");
        assert.ok(isSealed(box));
        assert.ok(!isSealed(Buffer.from('{"imei":"x"}')));
        assert.equal(
            openSealed(() => key, box, { acct: "a1", kind: "credentials" }).plaintext.toString(),
            "secret text",
        );
        assert.ok(!box.includes(Buffer.from("secret text")), "the plaintext is not in the container");
    });

    it("fails authentication when one ciphertext byte changes", () => {
        const box = seal(key, meta, "secret text");
        box[box.length - 20] ^= 1;
        assert.throws(
            () => openSealed(() => key, box),
            (e) => e instanceof SealError && e.code === "AUTH_FAILED",
        );
    });

    it("fails authentication when the header is edited (it is the AAD)", () => {
        const box = seal(key, meta, "secret text");
        const at = box.indexOf(Buffer.from('"use":"boot"'));
        box.write('"use":"data"', at, "utf8");
        assert.throws(
            () => openSealed(() => key, box),
            (e) => e.code === "AUTH_FAILED",
        );
    });

    it("refuses a file of another account or kind before decrypting", () => {
        const box = seal(key, meta, "x");
        assert.throws(
            () => openSealed(() => key, box, { acct: "a2" }),
            (e) => e.code === "MISMATCH",
        );
        assert.throws(
            () => openSealed(() => key, box, { kind: "voice-text" }),
            (e) => e.code === "MISMATCH",
        );
    });

    it("fails with the wrong key", () => {
        const box = seal(key, meta, "x");
        assert.throws(
            () => openSealed(() => randomBytes(32), box),
            (e) => e.code === "AUTH_FAILED",
        );
    });

    it("wraps keys bound to their AAD", () => {
        const kek = randomBytes(32);
        const w = wrapKey(kek, key, "here");
        assert.deepEqual(unwrapKey(kek, w, "here"), key);
        assert.throws(
            () => unwrapKey(kek, w, "there"),
            (e) => e.code === "AUTH_FAILED",
        );
    });
});

/** A fake `spawnSync` that answers for the OS tools by name. */
function fakeRun(handlers) {
    const calls = [];
    const run = (cmd, args, opts = {}) => {
        calls.push({ cmd, args, input: opts.input });
        const tool = String(cmd).split(/[\\/]/).pop();
        const h = handlers[tool];
        if (!h)
            return { status: 1, stdout: "", stderr: "", error: Object.assign(new Error("nope"), { code: "ENOENT" }) };
        return { stdout: "", stderr: "", status: 0, ...h(args, opts) };
    };
    return { run, calls };
}

const ctx = (extra = {}) => ({ account: "a1", ref: "r1", options: {}, state: {}, ...extra });
const mk = randomBytes(32);

describe("the dpapi provider (fake PowerShell)", () => {
    // Protect = reverse the bytes; Unprotect = reverse again, unless the blob was marked as from another user.
    const ps = {
        "powershell.exe": (args, { input }) => {
            const script = args.at(-1);
            const bytes = Buffer.from(String(input).trim(), "base64");
            if (script.includes("::Protect(")) return { stdout: Buffer.from(bytes).reverse().toString("base64") };
            if (bytes[0] === 0xee) return { status: 1, stderr: "Key not valid for use in specified state." };
            return { stdout: Buffer.from(bytes).reverse().toString("base64") };
        },
    };

    it("wraps and unwraps with the blob on stdin, never on the command line", () => {
        const { run, calls } = fakeRun(ps);
        const p = createProviders({ run, platform: "win32" }).dpapi;
        assert.equal(p.check({}), null);
        const { wrapped } = p.wrap(mk, ctx());
        assert.deepEqual(p.unwrap(wrapped, ctx()), mk);
        for (const c of calls) {
            assert.ok(c.args.includes("-NoProfile") && c.args.includes("-NonInteractive"));
            for (const leak of leaks(mk)) assert.ok(!c.args.join(" ").includes(leak), "no key on the command line");
        }
        assert.match(calls[0].args.at(-1), /DataProtectionScope\]::CurrentUser/);
    });

    it("uses LocalMachine when asked, and refuses any other scope", () => {
        const { run, calls } = fakeRun(ps);
        const p = createProviders({ run, platform: "win32" }).dpapi;
        p.wrap(mk, ctx({ options: { scope: "LocalMachine" } }));
        assert.match(calls[0].args.at(-1), /::LocalMachine\)/);
        assert.throws(
            () => p.wrap(mk, ctx({ options: { scope: "Everyone" } })),
            (e) => e.code === "CONFIG",
        );
    });

    it("is unavailable off Windows, and when PowerShell is missing", () => {
        assert.match(createProviders({ platform: "linux" }).dpapi.check({}), /only on Windows/);
        const p = createProviders({ run: fakeRun({}).run, platform: "win32" }).dpapi;
        assert.throws(
            () => p.wrap(mk, ctx()),
            (e) => e instanceof KeystoreError && e.code === "UNAVAILABLE",
        );
    });

    it("says another user or machine sealed it, for a blob DPAPI refuses", () => {
        const p = createProviders({ run: fakeRun(ps).run, platform: "win32" }).dpapi;
        const foreign = Buffer.from([0xee, ...randomBytes(31)])
            .reverse()
            .toString("base64");
        assert.throws(
            () => p.unwrap(Buffer.from(foreign, "base64").reverse().toString("base64"), ctx()),
            (e) => e.code === "WRONG_KEY" && /another Windows user or machine/.test(e.message),
        );
    });
});

/** A fake keychain / Secret Service: a map of items. */
function fakeItemTools() {
    const items = new Map();
    return {
        items,
        handlers: {
            security: (args, { input }) => {
                if (args[0] === "-i") {
                    const m = /-a (\S+) -s (\S+) -w (\S+)/.exec(String(input));
                    items.set(m[1], m[3]);
                    return {};
                }
                if (args[0] === "find-generic-password") {
                    const v = items.get(args[2]);
                    return v ? { stdout: `${v}\n` } : { status: 44 };
                }
                if (args[0] === "delete-generic-password") items.delete(args[2]);
                return {};
            },
            "secret-tool": (args, { input }) => {
                if (args[0] === "store") items.set(args.at(-1), String(input));
                if (args[0] === "lookup")
                    return items.has(args.at(-1)) ? { stdout: items.get(args.at(-1)) } : { status: 1 };
                if (args[0] === "clear") items.delete(args.at(-1));
                return {};
            },
            which: () => ({}),
        },
    };
}

describe("the keychain and secret-service providers (fake tools)", () => {
    for (const [name, platform, env] of [
        ["keychain", "darwin", {}],
        ["secret-service", "linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/fake" }],
    ]) {
        it(`${name}: a KEK in the OS store, the master key wrapped under it, no secret on a command line`, () => {
            const t = fakeItemTools();
            const { run, calls } = fakeRun(t.handlers);
            const p = createProviders({ run, platform, env })[name];
            assert.equal(p.check({}), null);
            const { wrapped, state } = p.wrap(mk, ctx());
            assert.deepEqual(p.unwrap(wrapped, ctx({ state })), mk);
            const kek = t.items.get(state.item);
            for (const c of calls) assert.ok(!c.args.join(" ").includes(kek), "the KEK travels over stdin only");
            p.forget(ctx({ state }));
            assert.equal(t.items.size, 0);
        });

        it(`${name}: a missing item is a wrong-key error`, () => {
            const p = createProviders({ run: fakeRun(fakeItemTools().handlers).run, platform, env })[name];
            assert.throws(
                () => p.unwrap("AAAA", ctx({ state: { item: "gone" } })),
                (e) => e.code === "WRONG_KEY",
            );
        });
    }

    it("secret-service is unavailable without a session bus, keychain off macOS", () => {
        assert.match(createProviders({ platform: "linux", env: {} })["secret-service"].check({}), /session bus/);
        assert.match(createProviders({ platform: "linux", env: {} }).keychain.check({}), /only on macOS/);
    });
});

describe("the systemd-creds provider (fake tool)", () => {
    const handlers = {
        which: () => ({}),
        "systemd-creds": (args, { input }) => {
            if (args[0] === "encrypt") return { stdout: Buffer.from(`SEALED:${Buffer.from(input).toString("hex")}`) };
            const text = String(input);
            if (!text.startsWith("SEALED:")) return { status: 1, stderr: "Failed to decrypt credential: Bad message" };
            return { stdout: Buffer.from(text.slice(7), "hex") };
        },
    };

    it("encrypts and decrypts through stdin, with --with-key when set", () => {
        const { run, calls } = fakeRun(handlers);
        const p = createProviders({ run, platform: "linux" })["systemd-creds"];
        assert.equal(p.check({}), null);
        const { wrapped } = p.wrap(mk, ctx({ options: { withKey: "tpm2" } }));
        assert.deepEqual(p.unwrap(wrapped, ctx()), mk);
        assert.ok(calls.find((c) => c.args[0] === "encrypt").args.includes("--with-key=tpm2"));
        assert.throws(
            () => p.wrap(mk, ctx({ options: { withKey: "; rm" } })),
            (e) => e.code === "CONFIG",
        );
    });

    it("a blob it cannot decrypt is a wrong-key error; no tool, unavailable", () => {
        const p = createProviders({ run: fakeRun(handlers).run, platform: "linux" })["systemd-creds"];
        assert.throws(
            () => p.unwrap("garbage", ctx()),
            (e) => e.code === "WRONG_KEY",
        );
        const none = createProviders({ run: () => ({ status: 1 }), platform: "linux" })["systemd-creds"];
        assert.match(none.check({}), /not installed/);
    });
});

describe("the kms backends (fake SDKs)", () => {
    const store = new Map();
    const fakeSeal = (plain, tag) => {
        const id = randomBytes(6).toString("hex");
        store.set(id, { plain: Buffer.from(plain), tag });
        return Buffer.from(id);
    };
    const fakeOpen = (blob, tag) => {
        const hit = store.get(Buffer.from(blob).toString());
        if (!hit || hit.tag !== tag) throw Object.assign(new Error("bad"), { name: "InvalidCiphertextException" });
        return hit.plain;
    };
    const sdks = {
        "@aws-sdk/client-kms": {
            KMSClient: class {
                send(cmd) {
                    const ctxTag = JSON.stringify(cmd.input.EncryptionContext);
                    if (cmd.kind === "enc") return { CiphertextBlob: fakeSeal(cmd.input.Plaintext, ctxTag) };
                    return { Plaintext: fakeOpen(cmd.input.CiphertextBlob, ctxTag) };
                }
            },
            EncryptCommand: class {
                constructor(input) {
                    Object.assign(this, { input, kind: "enc" });
                }
            },
            DecryptCommand: class {
                constructor(input) {
                    Object.assign(this, { input, kind: "dec" });
                }
            },
        },
        "@google-cloud/kms": {
            KeyManagementServiceClient: class {
                async encrypt(r) {
                    return [{ ciphertext: fakeSeal(r.plaintext, `${r.name}|${r.additionalAuthenticatedData}`) }];
                }
                async decrypt(r) {
                    return [{ plaintext: fakeOpen(r.ciphertext, `${r.name}|${r.additionalAuthenticatedData}`) }];
                }
            },
        },
        "@azure/identity": { DefaultAzureCredential: class {} },
        "@azure/keyvault-keys": {
            CryptographyClient: class {
                constructor(key) {
                    this.key = key;
                }
                async wrapKey(alg, plain) {
                    return { result: fakeSeal(plain, `${this.key}|${alg}`) };
                }
                async unwrapKey(alg, blob) {
                    return { result: fakeOpen(blob, `${this.key}|${alg}`) };
                }
            },
        },
    };
    const importer = async (name) => {
        if (!sdks[name]) throw new Error(`the kms backend needs ${name}, which is not installed`);
        return sdks[name];
    };
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(init.headers["X-Vault-Token"], "fake-token");
        if (url.includes("/encrypt/"))
            return {
                ok: true,
                json: async () => ({
                    data: {
                        ciphertext: `vault:v1:${fakeSeal(Buffer.from(body.plaintext, "base64"), url.split("/encrypt/")[1]).toString()}`,
                    },
                }),
            };
        const id = body.ciphertext.slice(9);
        try {
            return {
                ok: true,
                json: async () => ({
                    data: { plaintext: fakeOpen(Buffer.from(id), url.split("/decrypt/")[1]).toString("base64") },
                }),
            };
        } catch {
            return { ok: false, status: 400 };
        }
    };
    const deps = { importer, fetchImpl, env: { VAULT_ADDR: "https://vault.invalid", VAULT_TOKEN: "fake-token" } };

    for (const backend of ["aws", "gcp", "azure", "vault"]) {
        it(`${backend}: wraps and unwraps; a different key or context fails`, async () => {
            const options = { backend, key: "fake-key-1" };
            const blob = await runKmsTask({ action: "wrap", options, ref: "r1", data: mk.toString("base64") }, deps);
            const back = await runKmsTask({ action: "unwrap", options, ref: "r1", data: blob }, deps);
            assert.equal(back, mk.toString("base64"));
            assert.ok(!blob.includes(mk.toString("base64")));
            await assert.rejects(
                runKmsTask(
                    {
                        action: "unwrap",
                        options: { backend, key: "fake-key-2" },
                        ref: backend === "azure" ? "r1" : "r2",
                        data: blob,
                    },
                    deps,
                ),
            );
        });
    }

    it("names the SDK to install when it is missing", async () => {
        const b = createKmsBackends();
        await assert.rejects(
            b.aws.wrap(mk, { options: { key: "k" }, ref: "r" }).catch((e) => {
                throw e;
            }),
            /@aws-sdk\/client-kms/,
        );
    });

    it("refuses an unknown backend and a missing key", async () => {
        await assert.rejects(
            runKmsTask({ action: "wrap", options: { backend: "nope", key: "k" }, data: "" }),
            /unknown backend/,
        );
        await assert.rejects(runKmsTask({ action: "wrap", options: { backend: "aws" }, data: "" }), /no key/);
    });

    it("the kms provider runs the backend in a child process, synchronously (sandbox test backend)", () => {
        const p = createProviders({ env: { ...process.env, ZALO_KMS_TEST_SEED: "one" } }).kms;
        const c = ctx({ options: { backend: "test", key: "k" } });
        const { wrapped } = p.wrap(mk, c);
        assert.deepEqual(p.unwrap(wrapped, c), mk);
        const other = createProviders({ env: { ...process.env, ZALO_KMS_TEST_SEED: "two" } }).kms;
        assert.throws(
            () => other.unwrap(wrapped, c),
            (e) => e instanceof KeystoreError && e.code === "WRONG_KEY",
        );
        assert.match(p.check({}), /needs a backend/);
    });
});

describe("the passphrase, env and test providers", () => {
    it("passphrase: from a file; a wrong one is a wrong-key error; without file or terminal it refuses", () => {
        const file = join(SANDBOX_HOME, "pass.txt");
        writeFileSync(file, "correct horse battery\n");
        const p = createProviders().passphrase;
        const { wrapped, state } = p.wrap(mk, ctx({ options: { file } }));
        assert.deepEqual(p.unwrap(wrapped, ctx({ options: { file }, state })), mk);
        writeFileSync(file, "wrong horse battery\n");
        const fresh = createProviders().passphrase;
        assert.throws(
            () => fresh.unwrap(wrapped, ctx({ options: { file }, state })),
            (e) => e.code === "WRONG_KEY",
        );
        if (!process.stdin.isTTY) {
            assert.throws(
                () => createProviders({ env: {} }).passphrase.wrap(mk, ctx()),
                (e) => e.code === "UNAVAILABLE" && /no passphrase file/.test(e.message),
            );
        }
    });

    it("env: works only with the variable set, warns once on stderr, and a different key is a wrong-key error", () => {
        const lines = [];
        const key = randomBytes(32).toString("base64");
        const p = createProviders({ env: { ZALO_STORAGE_KEY: key }, warn: (l) => lines.push(l) }).env;
        const { wrapped } = p.wrap(mk, ctx());
        assert.deepEqual(p.unwrap(wrapped, ctx()), mk);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /WARNING/);
        assert.ok(!lines[0].includes(key));
        assert.match(createProviders({ env: {} }).env.check({}), /needs ZALO_STORAGE_KEY/);
        const other = createProviders({
            env: { ZALO_STORAGE_KEY: randomBytes(32).toString("base64") },
            warn: () => {},
        }).env;
        assert.throws(
            () => other.unwrap(wrapped, ctx()),
            (e) => e.code === "WRONG_KEY",
        );
    });

    it("test: exists in this sandbox only", () => {
        assert.ok(inTestSandbox());
        assert.equal(createProviders().test.check({}), null);
        assert.match(createProviders({ env: {} }).test.check({}), /offline test sandbox/);
    });

    it("the default refuses (fail closed) on a Linux server, naming what to configure", () => {
        const providers = createProviders({ platform: "linux", env: {}, run: () => ({ status: 1 }) });
        const d = defaultProvider({ platform: "linux", env: {}, providers });
        assert.match(d.refused, /systemd-creds/);
        assert.match(d.refused, /kms/);
        assert.match(d.refused, /passphrase/);
        assert.equal(defaultProvider({ platform: "win32", env: {}, providers }).name, "dpapi");
        assert.equal(defaultProvider({ platform: "darwin", env: {}, providers }).name, "keychain");
    });
});

describe("sealed credentials and the keyring", () => {
    it("saves the login sealed, loads it back, and the keyring holds no raw key", () => {
        const id = freshId();
        const file = saveCredentials(id, CREDS);
        const bytes = readFileSync(file);
        assert.ok(isSealed(bytes));
        assert.ok(!bytes.includes(Buffer.from("fake-cookie-value")));
        assert.deepEqual(loadCredentials(id), CREDS);
        const ring = readFileSync(join(getAccountDir(id), "keyring.json"), "utf8");
        const scope = scopeOf(id);
        for (const use of ["boot", "data"]) {
            for (const leak of leaks(currentKey(scope, use).key))
                assert.ok(!ring.includes(leak), `${use} key is in the keyring`);
        }
        assert.equal(JSON.parse(ring).provider.name, "test");
    });

    it("seals a plaintext login on first read (idempotent), and the read returns it unchanged", () => {
        const id = freshId();
        const file = join(CONFIG_DIR, "credentials", `cred_${id}.json`);
        mkdirSync(join(CONFIG_DIR, "credentials"), { recursive: true });
        writeFileSync(file, JSON.stringify(CREDS));
        assert.deepEqual(loadCredentials(id), CREDS);
        assert.ok(isSealed(readFileSync(file)));
        const once = readFileSync(file);
        assert.deepEqual(loadCredentials(id), CREDS);
        assert.deepEqual(readFileSync(file), once, "a second read changes nothing");
        assert.deepEqual(
            readdirSync(join(CONFIG_DIR, "credentials")).filter((f) => f.includes(".sealing")),
            [],
            "no side file is left behind",
        );
    });

    it("migration writes the sealed copy and verifies it before the plaintext is replaced", () => {
        const id = freshId();
        const file = join(getAccountDir(id), "voice-text.json");
        mkdirSync(getAccountDir(id), { recursive: true });
        const plain = Buffer.from(JSON.stringify({ items: {} }));
        writeFileSync(file, plain);
        let seen = false;
        migratePlaintext(file, id, { kind: "voice-text", use: "data" }, plain, {
            afterVerify(side) {
                seen = true;
                assert.ok(isSealed(readFileSync(side)), "the verified side file is sealed");
                assert.deepEqual(readFileSync(file), plain, "the plaintext is still there at that point");
            },
        });
        assert.ok(seen);
        assert.ok(isSealed(readFileSync(file)));
    });

    it("a crash before the rename leaves the plaintext readable, and the next run finishes", () => {
        const id = freshId();
        const file = join(getAccountDir(id), "voice-text.json");
        mkdirSync(getAccountDir(id), { recursive: true });
        const plain = Buffer.from(JSON.stringify({ items: { r: { at: 1, err: 0, text: "x", done: true } } }));
        writeFileSync(file, plain);
        assert.throws(() =>
            migratePlaintext(file, id, { kind: "voice-text", use: "data" }, plain, {
                afterVerify() {
                    throw new Error("simulated crash");
                },
            }),
        );
        assert.deepEqual(readFileSync(file), plain);
        const report = migrateAccount(id);
        assert.equal(report.find((r) => r.kind === "voice-text").result, "sealed");
        assert.equal(migrateAccount(id).find((r) => r.kind === "voice-text").result, "already-sealed");
        assert.equal(loadTranscripts(file).r.text, "x");
    });

    it("fails closed: no provider, no write, and the plaintext is kept", () => {
        const id = freshId();
        process.env.ZALO_STORAGE_PROVIDER = "env"; // without ZALO_STORAGE_KEY
        const file = join(CONFIG_DIR, "credentials", `cred_${id}.json`);
        writeFileSync(file, JSON.stringify(CREDS));
        assert.throws(
            () => saveCredentials(freshId(), CREDS),
            (e) => e.code === "UNAVAILABLE",
        );
        assert.throws(
            () => loadCredentials(id),
            (e) => e.code === "UNAVAILABLE",
        );
        assert.equal(readFileSync(file, "utf8"), JSON.stringify(CREDS));
    });

    it("a sealed file whose keyring is gone says so (never a silent 'not logged in')", () => {
        const id = freshId();
        saveCredentials(id, CREDS);
        rmSync(join(getAccountDir(id), "keyring.json"));
        lockAll();
        assert.throws(
            () => loadCredentials(id),
            (e) => e.code === "NO_KEYRING",
        );
    });

    it("a file copied to another account does not open there", () => {
        const a = freshId();
        const b = freshId();
        const box = sealBuffer(a, { kind: "credentials", use: "boot" }, "x");
        saveCredentials(b, CREDS);
        assert.throws(
            () => openBuffer(b, { kind: "credentials" }, box),
            (e) => e.code === "MISMATCH",
        );
    });

    it("status names the provider and each file's state, never key material", () => {
        const id = freshId();
        saveCredentials(id, CREDS);
        const s = securityStatus(id);
        assert.equal(s.provider.name, "test");
        assert.equal(s.files.find((f) => f.kind === "credentials").state, "sealed");
        assert.equal(s.files.find((f) => f.kind === "voice-text").state, "absent");
        const text = JSON.stringify(s);
        for (const use of ["boot", "data"])
            for (const leak of leaks(currentKey(scopeOf(id), use).key)) assert.ok(!text.includes(leak));
        assert.ok(!text.includes("wrapped"));
    });

    it("seals the trusted-device identity through the protocol layer's codec", () => {
        const id = freshId();
        const store = createTrustStore(getAccountDir);
        const bytes = new Uint8Array(randomBytes(32));
        assert.ok(
            store.save({
                uid: id,
                masterId: "m",
                publicKey: bytes,
                privateKey: bytes,
                linkingSecret: bytes,
                primaryPublicIdentityKey: bytes,
            }),
        );
        assert.ok(isSealed(readFileSync(join(getAccountDir(id), "trusted-device.json"))));
        assert.deepEqual(store.load(id).privateKey, bytes);
    });
});

describe("the dkey layer", () => {
    const fakeApi = (dkey) => ({ getContext: () => ({ loginInfo: dkey === undefined ? {} : { dkey } }) });

    it("boot files open without a login; data files need BOTH the provider and the login's dkey", () => {
        process.env.ZALO_STORAGE_DKEY_LAYER = "1";
        const id = freshId();
        saveCredentials(id, CREDS);
        const vt = voiceTextFile(getAccountDir(id));
        assert.throws(
            () => sealBuffer(id, { kind: "voice-text", use: "data" }, "x"),
            (e) => e.code === "LOCKED" && /log in/i.test(e.message),
        );
        assert.ok(attachLoginSession(id, fakeApi(FAKE_DKEY), { log: () => {} }).ok);
        lockAll();
        assert.throws(
            () => loadTranscripts(vt) && sealBuffer(id, { kind: "voice-text", use: "data" }, "x"),
            (e) => e.code === "LOCKED",
        ); // a new process: provider still there, no login yet
        assert.deepEqual(loadCredentials(id), CREDS, "the saved login opens before any login");
        const box = sealBufferAfterAttach(id);
        lockAll();
        assert.throws(
            () => openBuffer(id, { kind: "voice-text" }, box),
            (e) => e.code === "LOCKED",
        );
        attachLoginSession(id, fakeApi(FAKE_DKEY), { log: () => {} });
        assert.equal(openBuffer(id, { kind: "voice-text" }, box).toString(), "data");
        assert.equal(readKeyring(getAccountDir(id)).keys.find((k) => k.use === "data").dkey, true);
        assert.ok(
            !readFileSync(join(getAccountDir(id), "keyring.json"), "utf8").includes(FAKE_DKEY),
            "the dkey is never stored",
        );
    });

    function sealBufferAfterAttach(id) {
        attachLoginSession(id, fakeApi(FAKE_DKEY), { log: () => {} });
        return sealBuffer(id, { kind: "voice-text", use: "data" }, "data");
    }

    it("a different dkey does not open the data key; a login without one leaves it locked and says why", () => {
        process.env.ZALO_STORAGE_DKEY_LAYER = "1";
        const id = freshId();
        saveCredentials(id, CREDS);
        const box = sealBufferAfterAttach(id);
        lockAll();
        attachLoginSession(id, fakeApi("ffffffffffffffffffffffffffffffff"), { log: () => {} });
        assert.throws(
            () => openBuffer(id, { kind: "voice-text" }, box),
            (e) => e.code === "WRONG_KEY",
        );
        lockAll();
        const lines = [];
        attachLoginSession(id, fakeApi(undefined), { log: (l) => lines.push(l) });
        assert.throws(
            () => openBuffer(id, { kind: "voice-text" }, box),
            (e) => e.code === "LOCKED",
        );
        assert.match(lines.join("\n"), /carried no data key/);
    });

    it("turning the layer off after a login releases the data key from it, keeping every file readable", () => {
        process.env.ZALO_STORAGE_DKEY_LAYER = "1";
        const id = freshId();
        saveCredentials(id, CREDS);
        const box = sealBufferAfterAttach(id);
        process.env.ZALO_STORAGE_DKEY_LAYER = "0";
        attachLoginSession(id, fakeApi(FAKE_DKEY), { log: () => {} });
        lockAll();
        assert.equal(openBuffer(id, { kind: "voice-text" }, box).toString(), "data", "opens with no login now");
    });
});

describe("rekey, provider change, phase-2 subkeys, and logs", () => {
    it("rekey re-seals every file under new keys and drops the old ones", () => {
        const id = freshId();
        saveCredentials(id, CREDS);
        const vt = voiceTextFile(getAccountDir(id));
        writeFileSync(vt, JSON.stringify({ items: { a: { at: 1, err: 0, text: "t", done: true } } }));
        loadTranscripts(vt);
        const before = readKeyring(getAccountDir(id)).keys.map((k) => k.id);
        const res = rekeyAccount(id);
        assert.equal(res.resealed, 2);
        const ring = readKeyring(getAccountDir(id));
        assert.equal(ring.retired.length, 0);
        assert.ok(ring.keys.every((k) => !before.includes(k.id)));
        lockAll();
        assert.deepEqual(loadCredentials(id), CREDS);
        assert.equal(loadTranscripts(vt).a.text, "t");
        assert.ok(
            securityStatus(id)
                .files.filter((f) => f.state === "sealed")
                .every((f) => f.currentKey),
        );
    });

    it("provider change re-wraps the master key only; every file still opens", () => {
        const id = freshId();
        saveCredentials(id, CREDS);
        process.env.ZALO_STORAGE_KEY = randomBytes(32).toString("base64");
        const errs = [];
        const orig = console.error;
        console.error = (...a) => errs.push(a.join(" "));
        try {
            assert.deepEqual(changeProvider(id, "env"), { from: "test", to: "env" });
            lockAll();
            assert.deepEqual(loadCredentials(id), CREDS);
        } finally {
            console.error = orig;
        }
        assert.equal(readKeyring(getAccountDir(id)).provider.name, "env");
        assert.ok(!errs.join("\n").includes(process.env.ZALO_STORAGE_KEY));
    });

    it("phase-2 subkeys: one per purpose, stable across processes, unknown purposes refused", () => {
        const id = freshId();
        saveCredentials(id, CREDS);
        const a = getDataKey(id, "sqlcipher");
        const b = getDataKey(id, "media");
        assert.equal(a.key.length, 32);
        assert.notDeepEqual(a.key, b.key);
        lockAll();
        assert.deepEqual(getDataKey(id, "sqlcipher").key, a.key);
        assert.throws(
            () => getDataKey(id, "everything"),
            (e) => e.code === "CONFIG",
        );
    });

    it("nothing the layer prints carries a key, a cookie or a dkey", () => {
        const errs = [];
        const orig = console.error;
        console.error = (...a) => errs.push(a.join(" "));
        let keys = [];
        try {
            process.env.ZALO_STORAGE_DKEY_LAYER = "1";
            const id = freshId();
            saveCredentials(id, CREDS);
            attachLoginSession(id, { getContext: () => ({ loginInfo: { dkey: FAKE_DKEY } }) });
            rekeyAccount(id);
            securityStatus(id);
            keys = ["boot", "data"].map((u) => currentKey(scopeOf(id), u).key);
            lockAll();
            try {
                openFile(join(getAccountDir(id), "voice-text.json"), id, { kind: "voice-text" });
            } catch {
                /* absent */
            }
        } finally {
            console.error = orig;
        }
        const text = errs.join("\n");
        for (const k of keys) for (const leak of leaks(k)) assert.ok(!text.includes(leak));
        assert.ok(!text.includes(FAKE_DKEY));
        assert.ok(!text.includes("fake-cookie-value"));
        assert.ok(existsSync(CONFIG_DIR));
    });
});
