/**
 * Key providers: what protects a keyring's master key on this machine.
 *
 * Each provider turns the 32-byte master key into a `wrapped` string the keyring may store, and back. They are all
 * synchronous, so the stores that read a secret file (the saved login, the trusted-device identity) stay synchronous:
 * an OS tool is run with `spawnSync`, and a provider whose SDK is asynchronous (`kms`) or that must ask a person
 * (`passphrase` at a terminal) runs in a short-lived child (./worker.js). The keyring layer caches the unwrapped master
 * key for the life of the process, so each of these runs once per account per process.
 *
 *  - `dpapi`          Windows DPAPI through the in-box Windows PowerShell (.NET ProtectedData), the blob over stdin;
 *                     CurrentUser scope by default, LocalMachine for a service that runs under several identities.
 *  - `keychain`       macOS: a random key-encryption key kept as a generic password in the login keychain
 *                     (`security`; the secret goes over stdin with `security -i`, never on a command line).
 *  - `secret-service` Linux desktop: the same, in the Secret Service (`secret-tool`, secret over stdin).
 *  - `systemd-creds`  Linux servers: `systemd-creds encrypt/decrypt` (host key and/or TPM2).
 *  - `kms`            AWS KMS, Google Cloud KMS, Azure Key Vault or HashiCorp Vault transit (./kms.js).
 *  - `passphrase`     scrypt from a passphrase: a file (systemd `LoadCredential=`, a mounted secret) or a prompt.
 *  - `env`            key material from an environment variable; explicit only, warned about on every start.
 *  - `test`           the offline test sandbox only (refused anywhere else).
 *
 * A provider never falls back to another, and none falls back to a key kept next to the data.
 */
import { spawnSync } from "node:child_process";
import { createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeystoreError, unwrapKey, wrapKey } from "./container.js";

/** The service name the keychain and Secret Service items carry. */
export const ITEM_SERVICE = "zalo-agent-cli.keyring";
/** The credential name systemd-creds binds the blob to. */
export const SYSTEMD_CRED_NAME = "zalo-agent-keyring";
/** DPAPI's optional entropy: public, it only keeps our blobs apart from other programs' ones. */
const DPAPI_ENTROPY = "zalo-agent-cli/keyring/v1";
/** scrypt cost for the passphrase provider (64 MiB, about a tenth of a second). */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 };

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "worker.js");

/**
 * Whether this process is the offline test sandbox (tests/helpers/sandbox.js): `ZALO_SANDBOX_ACTIVE=1` and a home
 * that is a `zalo-agent-test-*` folder directly inside the OS temp folder. The `test` provider exists only there.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function inTestSandbox(env = process.env) {
    if (env.ZALO_SANDBOX_ACTIVE !== "1") return false;
    const real = (p) => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const home = real(homedir());
    return basename(home).startsWith("zalo-agent-test-") && dirname(home) === real(tmpdir());
}

/** The first line of a tool's error output, cut short: enough to say why, never a blob. */
function reasonOf(result) {
    if (result.error) return result.error.code === "ENOENT" ? "the tool is not installed" : result.error.message;
    const text = String(result.stderr ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !/^[A-Za-z0-9+/=]{40,}$/.test(l));
    return (text ?? `exit code ${result.status}`).replace(/[A-Za-z0-9+/=]{40,}/g, "…").slice(0, 200);
}

/** The additional data every local wrap of a master key is bound to. */
const wrapAad = (ctx, provider) => `zalo-agent-cli/keyring/v1|${ctx.account}|${ctx.ref}|${provider}`;

/** A random item name for a keychain / Secret Service entry: a new one per wrap, so a re-wrap never overwrites. */
const newItem = (ctx) => `${ctx.ref}.${randomBytes(4).toString("hex")}`;

/**
 * Build the providers.
 *
 * @param {object} [deps] - for tests: `run` (spawnSync's signature), `platform`, `env`, `home`
 * @returns {Record<string, object>}
 */
export function createProviders({
    run = spawnSync,
    platform = process.platform,
    env = process.env,
    warn = (line) => console.error(line),
} = {}) {
    const passphrases = new Map();
    let envWarned = false;

    const dpapiShell = () => {
        const system = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
        const ps = join(system, "powershell.exe");
        return existsSync(ps) || run !== spawnSync ? ps : "pwsh.exe";
    };
    const dpapiCall = (op, input, options) => {
        const scope = options.scope ?? "CurrentUser";
        if (!/^(CurrentUser|LocalMachine)$/.test(scope)) {
            throw new KeystoreError(`dpapi scope must be CurrentUser or LocalMachine, not "${scope}"`, "CONFIG");
        }
        const script =
            "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
            "$i=[Console]::In.ReadToEnd().Trim();" +
            `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');` +
            `$o=[System.Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($i),$e,` +
            `[System.Security.Cryptography.DataProtectionScope]::${scope});` +
            "[Console]::Out.Write([Convert]::ToBase64String($o))";
        const r = run(
            dpapiShell(),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            {
                input,
                encoding: "utf8",
                windowsHide: true,
                timeout: 60_000,
            },
        );
        if (r.error?.code === "ENOENT")
            throw new KeystoreError("dpapi: Windows PowerShell was not found", "UNAVAILABLE");
        if (r.status !== 0 || !String(r.stdout ?? "").trim()) {
            const why = reasonOf(r);
            const wrong =
                op === "Unprotect" && /key not valid|data is invalid|CryptographicException/i.test(String(r.stderr));
            throw new KeystoreError(
                wrong
                    ? `dpapi could not unwrap the keyring: it was sealed for another Windows user or machine (${scope} scope)`
                    : `dpapi ${op.toLowerCase()} failed: ${why}`,
                wrong ? "WRONG_KEY" : "UNAVAILABLE",
            );
        }
        return String(r.stdout).trim();
    };

    /** Keychain / Secret Service: a random KEK in the OS store, the master key wrapped locally under it. */
    const itemStore = (name, { put, get, del, available }) => ({
        name,
        check: available,
        describe: () => ({ store: name === "keychain" ? "macOS login keychain" : "Secret Service (desktop keyring)" }),
        wrap(mk, ctx) {
            const kek = randomBytes(32);
            const item = newItem(ctx);
            put(item, kek.toString("hex"));
            return { wrapped: wrapKey(kek, mk, wrapAad(ctx, name)), state: { item } };
        },
        unwrap(wrapped, ctx) {
            const hex = get(ctx.state?.item);
            if (!/^[0-9a-f]{64}$/.test(hex))
                throw new KeystoreError(`${name}: the keyring's key item is damaged`, "WRONG_KEY");
            return unwrapKey(Buffer.from(hex, "hex"), wrapped, wrapAad(ctx, name));
        },
        forget(ctx) {
            if (ctx.state?.item) del(ctx.state.item);
        },
    });

    const tool = (cmd, args, opts = {}) =>
        run(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60_000, ...opts });
    const has = (cmd) => {
        const r = run(platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
        return r.status === 0;
    };

    const keychain = itemStore("keychain", {
        available: () => (platform !== "darwin" ? "the macOS keychain exists only on macOS" : null),
        put(item, secret) {
            const r = tool("security", ["-i"], {
                input: `add-generic-password -U -a ${item} -s ${ITEM_SERVICE} -w ${secret}\n`,
            });
            if (r.status !== 0)
                throw new KeystoreError(`keychain: could not store the key: ${reasonOf(r)}`, "UNAVAILABLE");
        },
        get(item) {
            const r = tool("security", ["find-generic-password", "-a", String(item), "-s", ITEM_SERVICE, "-w"]);
            if (r.status === 44)
                throw new KeystoreError("keychain: the keyring's key item is missing from the keychain", "WRONG_KEY");
            if (r.status !== 0)
                throw new KeystoreError(`keychain: could not read the key: ${reasonOf(r)}`, "UNAVAILABLE");
            return String(r.stdout).trim();
        },
        del(item) {
            tool("security", ["delete-generic-password", "-a", String(item), "-s", ITEM_SERVICE]);
        },
    });

    const secretService = itemStore("secret-service", {
        available: () => {
            if (platform !== "linux") return "the Secret Service is a Linux desktop service";
            if (!env.DBUS_SESSION_BUS_ADDRESS)
                return "there is no desktop session bus (DBUS_SESSION_BUS_ADDRESS is unset)";
            if (!has("secret-tool")) return "secret-tool is not installed (libsecret-tools)";
            return null;
        },
        put(item, secret) {
            const r = tool(
                "secret-tool",
                ["store", "--label=zalo-agent-cli keyring", "service", ITEM_SERVICE, "keyring", item],
                {
                    input: secret,
                },
            );
            if (r.status !== 0)
                throw new KeystoreError(`secret-service: could not store the key: ${reasonOf(r)}`, "UNAVAILABLE");
        },
        get(item) {
            const r = tool("secret-tool", ["lookup", "service", ITEM_SERVICE, "keyring", String(item)]);
            if (r.status !== 0 || !String(r.stdout).trim()) {
                throw new KeystoreError(
                    r.status === 1 && !String(r.stderr).trim()
                        ? "secret-service: the keyring's key item is missing (or the desktop keyring is locked)"
                        : `secret-service: could not read the key: ${reasonOf(r)}`,
                    r.status === 1 ? "WRONG_KEY" : "UNAVAILABLE",
                );
            }
            return String(r.stdout).trim();
        },
        del(item) {
            tool("secret-tool", ["clear", "service", ITEM_SERVICE, "keyring", String(item)]);
        },
    });

    const systemdArgs = (op, options) => {
        const args = [op, `--name=${SYSTEMD_CRED_NAME}`];
        if (op === "encrypt" && options.withKey) {
            if (!/^(auto|host|tpm2|host\+tpm2|tpm2-absent)$/.test(options.withKey)) {
                throw new KeystoreError(`systemd-creds withKey must be auto, host, tpm2 or host+tpm2`, "CONFIG");
            }
            args.push(`--with-key=${options.withKey}`);
        }
        if (options.user) args.push("--user");
        args.push("-", "-");
        return args;
    };

    /** Run the async-only work (KMS, a terminal prompt) in a child, synchronously. */
    const worker = (task, { tty = false } = {}) => {
        const r = run(process.execPath, [WORKER, task.op], {
            input: tty ? undefined : JSON.stringify(task),
            stdio: tty ? ["inherit", "pipe", "inherit"] : ["pipe", "pipe", "pipe"],
            encoding: "utf8",
            windowsHide: true,
            timeout: tty ? 10 * 60_000 : 120_000,
            env: { ...env, ZALO_KEYSTORE_TASK: tty ? JSON.stringify(task) : "" },
        });
        let reply = null;
        try {
            reply = JSON.parse(
                String(r.stdout ?? "")
                    .trim()
                    .split("\n")
                    .pop(),
            );
        } catch {
            /* no reply */
        }
        if (!reply?.ok) {
            throw new KeystoreError(
                reply?.error ?? `the key worker failed: ${reasonOf(r)}`,
                reply?.code ?? "UNAVAILABLE",
            );
        }
        return reply;
    };

    const passphraseOf = (options, { confirm = false } = {}) => {
        const file =
            options.file ??
            (env.CREDENTIALS_DIRECTORY && existsSync(join(env.CREDENTIALS_DIRECTORY, "zalo-storage-passphrase"))
                ? join(env.CREDENTIALS_DIRECTORY, "zalo-storage-passphrase")
                : null);
        const key = file ?? "<prompt>";
        if (passphrases.has(key)) return passphrases.get(key);
        let pass;
        if (file) {
            try {
                pass = readFileSync(file, "utf8").replace(/\r?\n$/, "");
            } catch (e) {
                throw new KeystoreError(
                    `passphrase: cannot read the passphrase file: ${e.code ?? e.message}`,
                    "UNAVAILABLE",
                );
            }
        } else {
            if (!process.stdin.isTTY) {
                throw new KeystoreError(
                    "passphrase: no passphrase file is set (storage.json passphrase.file or ZALO_STORAGE_PASSPHRASE_FILE) and there is no terminal to ask on",
                    "UNAVAILABLE",
                );
            }
            pass = worker({ op: "prompt", confirm }, { tty: true }).passphrase;
        }
        if (!pass || pass.length < 8) throw new KeystoreError("passphrase: it must be at least 8 characters", "CONFIG");
        passphrases.set(key, pass);
        return pass;
    };

    return {
        dpapi: {
            name: "dpapi",
            check: () => (platform !== "win32" ? "DPAPI exists only on Windows" : null),
            describe: (options) => ({ scope: options.scope ?? "CurrentUser" }),
            wrap: (mk, ctx) => ({ wrapped: dpapiCall("Protect", mk.toString("base64"), ctx.options), state: {} }),
            unwrap(wrapped, ctx) {
                const out = Buffer.from(dpapiCall("Unprotect", wrapped, ctx.options), "base64");
                if (out.length !== 32) throw new KeystoreError("dpapi returned a key of the wrong size", "WRONG_KEY");
                return out;
            },
        },
        keychain,
        "secret-service": secretService,
        "systemd-creds": {
            name: "systemd-creds",
            check: () => {
                if (platform !== "linux") return "systemd-creds exists only on Linux";
                if (!has("systemd-creds")) return "systemd-creds is not installed (systemd 250 or later)";
                return null;
            },
            describe: (options) => ({ withKey: options.withKey ?? "auto", user: Boolean(options.user) }),
            wrap(mk, ctx) {
                const r = run("systemd-creds", systemdArgs("encrypt", ctx.options), { input: mk, timeout: 60_000 });
                if (r.status !== 0)
                    throw new KeystoreError(`systemd-creds encrypt failed: ${reasonOf(r)}`, "UNAVAILABLE");
                return { wrapped: Buffer.from(r.stdout).toString("utf8").trim(), state: {} };
            },
            unwrap(wrapped, ctx) {
                const r = run("systemd-creds", systemdArgs("decrypt", ctx.options), {
                    input: wrapped,
                    timeout: 60_000,
                });
                if (r.status !== 0) {
                    throw new KeystoreError(`systemd-creds could not decrypt the keyring: ${reasonOf(r)}`, "WRONG_KEY");
                }
                const out = Buffer.from(r.stdout);
                if (out.length !== 32)
                    throw new KeystoreError("systemd-creds returned a key of the wrong size", "WRONG_KEY");
                return out;
            },
        },
        kms: {
            name: "kms",
            check: (options) => {
                if (!options.backend) return "kms needs a backend (aws, gcp, azure or vault): storage.json kms.backend";
                if (!options.key)
                    return "kms needs a key: storage.json kms.key (key ARN/id, key name, key URL or transit key)";
                return null;
            },
            describe: (options) => ({ backend: options.backend ?? null, key: options.key ?? null }),
            wrap(mk, ctx) {
                const reply = worker({
                    op: "kms",
                    action: "wrap",
                    options: ctx.options,
                    ref: ctx.ref,
                    data: mk.toString("base64"),
                });
                return { wrapped: reply.data, state: {} };
            },
            unwrap(wrapped, ctx) {
                const reply = worker({
                    op: "kms",
                    action: "unwrap",
                    options: ctx.options,
                    ref: ctx.ref,
                    data: wrapped,
                });
                const out = Buffer.from(reply.data, "base64");
                if (out.length !== 32) throw new KeystoreError("kms returned a key of the wrong size", "WRONG_KEY");
                return out;
            },
        },
        passphrase: {
            name: "passphrase",
            check: () => null,
            describe: (options) => ({ source: options.file ? "file" : "prompt" }),
            wrap(mk, ctx) {
                const salt = randomBytes(16);
                const kek = scryptSync(passphraseOf(ctx.options, { confirm: true }), salt, 32, {
                    ...SCRYPT,
                    maxmem: 256 * 1024 * 1024,
                });
                return {
                    wrapped: wrapKey(kek, mk, wrapAad(ctx, "passphrase")),
                    state: { salt: salt.toString("base64"), ...SCRYPT },
                };
            },
            unwrap(wrapped, ctx) {
                const { salt, N, r, p } = ctx.state ?? {};
                const kek = scryptSync(passphraseOf(ctx.options), Buffer.from(String(salt), "base64"), 32, {
                    N,
                    r,
                    p,
                    maxmem: 256 * 1024 * 1024,
                });
                try {
                    return unwrapKey(kek, wrapped, wrapAad(ctx, "passphrase"));
                } catch {
                    passphrases.clear();
                    throw new KeystoreError("passphrase: wrong passphrase for this keyring", "WRONG_KEY");
                }
            },
        },
        env: {
            name: "env",
            check: (options) => {
                const v = env[options.variable ?? "ZALO_STORAGE_KEY"];
                return v
                    ? null
                    : `the env provider needs ${options.variable ?? "ZALO_STORAGE_KEY"} (32 random bytes, base64)`;
            },
            describe: (options) => ({ variable: options.variable ?? "ZALO_STORAGE_KEY" }),
            wrap(mk, ctx) {
                return { wrapped: wrapKey(envKek(ctx), mk, wrapAad(ctx, "env")), state: {} };
            },
            unwrap(wrapped, ctx) {
                try {
                    return unwrapKey(envKek(ctx), wrapped, wrapAad(ctx, "env"));
                } catch {
                    throw new KeystoreError(
                        "env: the key in the environment is not the one this keyring was sealed with",
                        "WRONG_KEY",
                    );
                }
            },
        },
        test: {
            name: "test",
            check: () => (inTestSandbox(env) ? null : "the test provider exists only in the offline test sandbox"),
            describe: () => ({}),
            wrap: (mk, ctx) => ({ wrapped: wrapKey(testKek(), mk, wrapAad(ctx, "test")), state: {} }),
            unwrap(wrapped, ctx) {
                try {
                    return unwrapKey(testKek(), wrapped, wrapAad(ctx, "test"));
                } catch {
                    throw new KeystoreError("test: wrong key", "WRONG_KEY");
                }
            },
        },
    };

    function envKek(ctx) {
        const variable = ctx.options.variable ?? "ZALO_STORAGE_KEY";
        const raw = env[variable];
        if (!raw) throw new KeystoreError(`env: ${variable} is not set`, "UNAVAILABLE");
        const bytes = /^[0-9a-f]{64}$/i.test(raw.trim())
            ? Buffer.from(raw.trim(), "hex")
            : Buffer.from(raw.trim(), "base64");
        if (bytes.length < 32)
            throw new KeystoreError(`env: ${variable} must hold 32 random bytes (base64 or hex)`, "CONFIG");
        if (!envWarned) {
            envWarned = true;
            warn(
                `[keystore] WARNING: the key provider is "env": the key sits in ${variable}, readable by anything that can ` +
                    "read this process's environment or the file that sets it. Prefer dpapi, systemd-creds or kms.",
            );
        }
        return Buffer.from(
            hkdfSync("sha256", bytes, Buffer.from(ctx.ref, "utf8"), "zalo-agent-cli/v1/env-provider", 32),
        );
    }

    function testKek() {
        if (!inTestSandbox(env))
            throw new KeystoreError("the test provider exists only in the offline test sandbox", "UNAVAILABLE");
        return createHash("sha256").update(`zalo-agent-cli/test-provider/v1|${homedir()}`).digest();
    }
}

/**
 * The provider to use when none is configured, or why there is none.
 *
 * @param {object} deps - `platform`, `env`, `providers` (from {@link createProviders})
 * @returns {{name: string}|{refused: string}}
 */
export function defaultProvider({ platform = process.platform, env = process.env, providers }) {
    if (inTestSandbox(env)) return { name: "test" };
    if (platform === "win32") return { name: "dpapi" };
    if (platform === "darwin") return { name: "keychain" };
    if (platform === "linux") {
        const why = providers["secret-service"].check({});
        if (!why) return { name: "secret-service" };
        return {
            refused:
                `no key provider is configured, and the desktop keyring cannot be used (${why}). ` +
                'On a server set one in <config-dir>/storage.json ("provider": "systemd-creds", "kms" or "passphrase") ' +
                "or ZALO_STORAGE_PROVIDER; see docs/security.md. Saved logins are never kept unencrypted.",
        };
    }
    return {
        refused: `no default key provider on ${platform}: set "provider" in <config-dir>/storage.json (kms or passphrase); see docs/security.md`,
    };
}
