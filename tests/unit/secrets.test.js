/**
 * src/utils/secrets.js -- secrets that arrive as command-line flags.
 *
 * `--webhook-secret` was documented for `listen` and `mcp start` in about
 * fifteen places while neither command defined it (the secret only came from
 * ZALO_WEBHOOK_SECRET), so copying the documented command failed with "unknown
 * option". It exists now, and with it two ways to leak or lose a secret that
 * these pin: an empty flag must not silently mean "unsigned webhooks", and the
 * argument list `-d` writes into daemon.log must not carry a secret's value
 * (it used to print `--auth <token>` in full).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import { SECRET_FLAGS, maskSecretArgs, resolveWebhookSecret } from "../../src/utils/secrets.js";
import { walkAst } from "../helpers/zca-call-sites.js";

describe("resolveWebhookSecret -- flag, then environment, then config", () => {
    it("takes the flag over the environment and the config", () => {
        assert.equal(resolveWebhookSecret({ flag: "from-flag", env: "from-env", config: "from-config" }), "from-flag");
    });

    it("takes the environment over the config, and the config last", () => {
        assert.equal(resolveWebhookSecret({ env: "from-env", config: "from-config" }), "from-env");
        assert.equal(resolveWebhookSecret({ config: "from-config" }), "from-config");
    });

    it("trims what it returns, and is null when nothing is set (unsigned)", () => {
        assert.equal(resolveWebhookSecret({ flag: "  s  " }), "s");
        assert.equal(resolveWebhookSecret({}), null);
        assert.equal(resolveWebhookSecret({ env: "   ", config: null }), null);
        assert.equal(resolveWebhookSecret(), null);
    });

    it("refuses a flag that is present but empty instead of falling back to unsigned", () => {
        // Red if an empty flag falls through to env/config/null: an unset shell
        // variable would then silently send unsigned webhooks.
        for (const empty of ["", "   "]) {
            assert.throws(
                () => resolveWebhookSecret({ flag: empty, env: "from-env" }),
                /--webhook-secret was given an empty secret/,
            );
        }
    });
});

describe("maskSecretArgs -- what daemon.log may show of the launch command", () => {
    it("masks the value of every secret flag, in both spellings", () => {
        const args = [
            "src/index.js",
            "mcp",
            "start",
            "--http",
            "3100",
            "--auth",
            "tok-123",
            "--client-secret=cs-456",
            "--webhook-secret",
            "wh-789",
        ];
        assert.deepEqual(maskSecretArgs(args), [
            "src/index.js",
            "mcp",
            "start",
            "--http",
            "3100",
            "--auth",
            "***",
            "--client-secret=***",
            "--webhook-secret",
            "***",
        ]);
        assert.ok(
            !maskSecretArgs(args)
                .join(" ")
                .match(/tok-123|cs-456|wh-789/),
        );
    });

    it("covers exactly the flags that carry a secret", () => {
        assert.deepEqual([...SECRET_FLAGS].sort(), ["--auth", "--client-secret", "--webhook-secret"]);
    });

    it("leaves everything else alone, does not mutate its input, and survives a flag with no value", () => {
        const args = ["--authority", "x", "--client-id", "public", "--http", "1", "--auth"];
        const copy = [...args];
        assert.deepEqual(maskSecretArgs(args), copy, "a lookalike flag and a trailing flag are not masked");
        assert.deepEqual(args, copy);
    });

    it("is what the daemon launcher writes into daemon.log", () => {
        const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "daemon-channel.js"), "utf8");
        // Red if the header goes back to the raw argument list.
        assert.match(src, /starting daemon: \$\{maskSecretArgs\(filteredArgs\)\.join\(" "\)\}/);
        assert.doesNotMatch(src, /starting daemon: \$\{filteredArgs\.join/);
    });
});

describe("`listen` and `mcp start` both pass the flag into resolveWebhookSecret", () => {
    const SRC = join(import.meta.dirname, "..", "..", "src", "commands");
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const ast = acorn.parse(readFileSync(join(SRC, file), "utf8"), {
                ecmaVersion: "latest",
                sourceType: "module",
            });
            const calls = [];
            walkAst(ast, (n) => {
                if (n.type === "CallExpression" && n.callee?.name === "resolveWebhookSecret") calls.push(n);
            });
            // Each command also calls it once only to validate the flag, so the call that matters is the one
            // that reads the environment: it must pass the flag too. Red if an entry point goes back to reading
            // only the environment, which would make the documented flag do nothing.
            const keys = (c) => (c.arguments[0]?.properties ?? []).map((p) => p.key?.name);
            const resolving = calls.filter((c) => keys(c).includes("env"));
            assert.ok(resolving.length >= 1, `${file} must still honour ZALO_WEBHOOK_SECRET`);
            for (const c of resolving) {
                assert.ok(
                    keys(c).includes("flag"),
                    `${file}: the resolution that reads the environment must also take the flag`,
                );
            }
        });
    }
});
