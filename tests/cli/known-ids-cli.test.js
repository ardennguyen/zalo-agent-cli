/**
 * Ids per account through the binary, against the fake session (tests/helpers/fake-api.js): a command naming an id the
 * account has never seen exits 1 with UNKNOWN_TO_ACCOUNT before its action runs; a friend's id goes through; a phone
 * lookup on this account makes the id it found usable; `--allow-unknown` skips the check.
 *
 * Red if `msg send` to a foreign id exits 0 (the guard is not in the preAction hook), if the friend's send is refused
 * (a false refusal), or if the id `friend find` returned is still refused afterwards (the lookup is not recorded).
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, saveCredentials } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { FAKE_OWN_ID, FAKE_PEER_ID, FAKE_GROUP_ID } from "../helpers/fake-api.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "index.js");
const FAKE_API = join(ROOT, "tests", "helpers", "fake-api.js");
const NO_NETWORK = join(ROOT, "tests", "helpers", "no-network.mjs");

/** Made-up ids: another account's id for someone, and a stranger this account finds by phone. */
const FOREIGN = "1000000000000000091";
const STRANGER = "1000000000000000092";

/** Run the CLI with the fake session and per-method replies; `--json` output parsed. */
function run(argv, { replies = {} } = {}) {
    const env = {
        ...process.env,
        USERPROFILE: SANDBOX_HOME,
        HOME: SANDBOX_HOME,
        ZALO_SANDBOX_ACTIVE: "1",
        ZALO_TEST_FAKE_API: FAKE_API,
        ZALO_TEST_FAKE_API_MODE: "normal",
        ZALO_TEST_FAKE_API_REPLIES: JSON.stringify(replies),
        ZALO_AGENT_NO_UPDATE_CHECK: "1",
        NODE_OPTIONS: `--import=${pathToFileURL(NO_NETWORK).href}`,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
    };
    return new Promise((res) => {
        const child = spawn(process.execPath, [CLI, "--json", ...argv], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            let out = null;
            try {
                out = JSON.parse(stdout.trim());
            } catch {
                /* left null */
            }
            res({ code, stdout, stderr, out });
        });
        child.stdin.end();
    });
}

before(() => {
    assertSandboxed(CONFIG_DIR);
    addAccount(FAKE_OWN_ID, "Fake Self");
    saveCredentials(FAKE_OWN_ID, { imei: "fake-imei", cookie: [], userAgent: "fake-agent", language: "vi" });
});

describe("CLI: an id unknown to the account is refused before anything is sent", () => {
    it("msg send to another account's id exits 1 with UNKNOWN_TO_ACCOUNT", async () => {
        const r = await run(["msg", "send", FOREIGN, "chào"]);
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.equal(r.out?.code, "UNKNOWN_TO_ACCOUNT", r.stdout);
        assert.match(r.out.error, /different user id on each account/);
        assert.match(r.out.error, /--allow-unknown/);
        assert.deepEqual(
            r.out.unknownIds.map((u) => u.id),
            [FOREIGN],
        );
    });

    it("friend remove and group members refuse ids the account does not know", async () => {
        for (const argv of [
            ["friend", "remove", FOREIGN, "--yes"],
            ["group", "members", FOREIGN],
            ["msg", "send", FAKE_GROUP_ID, `@[${FOREIGN}] xem`, "-t", "1"],
        ]) {
            const r = await run(argv);
            assert.equal(r.code, 1, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
            assert.equal(r.out?.code, "UNKNOWN_TO_ACCOUNT", `${argv.join(" ")}: ${r.stdout}`);
        }
    });

    it("msg send to a friend goes ahead", async () => {
        const r = await run(["msg", "send", FAKE_PEER_ID, "chào"]);
        assert.equal(r.code, 0, r.stdout + r.stderr);
        assert.notEqual(r.out?.code, "UNKNOWN_TO_ACCOUNT");
    });

    it("--allow-unknown sends to the id anyway", async () => {
        const r = await run(["msg", "send", FOREIGN, "chào", "--allow-unknown"]);
        assert.equal(r.code, 0, r.stdout + r.stderr);
    });

    it("friend find by phone, then msg send to the id it found", async () => {
        const before = await run(["msg", "send", STRANGER, "chào"]);
        assert.equal(before.out?.code, "UNKNOWN_TO_ACCOUNT", before.stdout);
        const found = await run(["friend", "find", "0901234567"], {
            replies: { findUser: { uid: STRANGER, displayName: "Người lạ", zaloName: "Người lạ" } },
        });
        assert.equal(found.code, 0, found.stdout + found.stderr);
        const r = await run(["msg", "send", STRANGER, "chào"]);
        assert.equal(r.code, 0, r.stdout + r.stderr);
    });
});
