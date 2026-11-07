/**
 * The `policy` group driven as the binary, with no daemon (the file is written, sealed) and no login: set, get, unset,
 * a tenant's file, a restart-only key refused, a stale --if-match refused, and `policy token --rotate` showing the
 * token once while only its hash is kept.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { isSealed } from "../../src/core/keystore/index.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
const OWN = "5252";
const json = (r) => JSON.parse(stripAnsi(r.stdout));

describe("policy", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        mkdirSync(getAccountDir(OWN), { recursive: true });
    });

    it("set writes the sealed file and raises rev; get reads it back; unset removes the key", async () => {
        const set = await runCli(["--json", "policy", "set", "media.linkAuth", "bearer"], options);
        assert.equal(set.code, 0, set.all);
        assert.equal(json(set).rev, 1);
        assert.deepEqual(json(set).changed, ["media.linkAuth"]);
        assert.ok(isSealed(readFileSync(join(getAccountDir(OWN), "policy.json"))));
        const get = await runCli(["--json", "policy", "get", "media.linkAuth"], options);
        assert.equal(get.code, 0, get.all);
        assert.equal(json(get).value, "bearer");
        const unset = await runCli(["--json", "policy", "unset", "media.linkAuth"], options);
        assert.equal(unset.code, 0, unset.all);
        assert.equal(json(unset).rev, 2);
        assert.deepEqual(json(await runCli(["--json", "policy", "get"], options)).policy, {});
    });

    it("refuses a restart-only key, a bad value and a stale --if-match, with exit 1", async () => {
        const restart = await runCli(["policy", "set", "httpPort", "9000"], options);
        assert.equal(restart.code, 1);
        assert.match(restart.all, /restartRequired/);
        const bad = await runCli(["policy", "set", "quota.warnAt", "7"], options);
        assert.equal(bad.code, 1);
        assert.match(bad.all, /quota\.warnAt/);
        const stale = await runCli(["policy", "set", "confirmMode", "human", "--if-match", "99"], options);
        assert.equal(stale.code, 1);
        assert.match(stale.all, /rev/);
    });

    it("--tenant writes a tenant's file, and the account's effective policy includes it", async () => {
        const r = await runCli(
            ["--json", "policy", "set", "quota.tenant.accounts", `["${OWN}"]`, "--tenant", "t1"],
            options,
        );
        assert.equal(r.code, 0, r.all);
        await runCli(["policy", "set", "confirmMode", "human", "--tenant", "t1"], options);
        const eff = json(await runCli(["--json", "policy", "get", "--effective"], options));
        assert.deepEqual(eff.tenants, ["t1"]);
        assert.equal(eff.policy.confirmMode, "human");
    });

    it("token --rotate shows a token once; only its hash is kept; plain `token` says one is set", async () => {
        const r = await runCli(["--json", "policy", "token", "--rotate"], options);
        assert.equal(r.code, 0, r.all);
        const { token } = json(r);
        assert.match(token, /^zadm_/);
        assert.ok(!readFileSync(join(CONFIG_DIR, "admin", "admin-token.json"), "latin1").includes(token));
        assert.equal(json(await runCli(["--json", "policy", "token"], options)).set, true);
    });
});
