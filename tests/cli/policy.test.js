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
import { checkCli } from "../helpers/cli-fast.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
// Commands run in the in-process CLI worker; a check that fails there is re-run as a real child process
// (tests/helpers/cli-fast.js `checkCli`), so only a real process can fail a test.
const jsonOf = (args, check) => checkCli(args, options, (r) => check(json(r)));
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
        await checkCli(["--json", "policy", "set", "media.linkAuth", "bearer"], options, async (set) => {
            assert.equal(set.code, 0, set.all);
            assert.equal(json(set).rev, 1);
            assert.deepEqual(json(set).changed, ["media.linkAuth"]);
            assert.ok(isSealed(readFileSync(join(getAccountDir(OWN), "policy.json"))));
            await checkCli(["--json", "policy", "get", "media.linkAuth"], options, async (get) => {
                assert.equal(get.code, 0, get.all);
                assert.equal(json(get).value, "bearer");
                await checkCli(["--json", "policy", "unset", "media.linkAuth"], options, async (unset) => {
                    assert.equal(unset.code, 0, unset.all);
                    assert.equal(json(unset).rev, 2);
                    await jsonOf(["--json", "policy", "get"], (j) => assert.deepEqual(j.policy, {}));
                });
            });
        });
    });

    it("refuses a restart-only key, a bad value and a stale --if-match, with exit 1", async () => {
        // A real child process: the smoke check that the worker and a real process agree.
        const restart = await runCli(["policy", "set", "httpPort", "9000"], options);
        assert.equal(restart.code, 1);
        assert.match(restart.all, /restartRequired/);
        await checkCli(["policy", "set", "quota.warnAt", "7"], options, async (bad) => {
            assert.equal(bad.code, 1);
            assert.match(bad.all, /quota\.warnAt/);
            await checkCli(["policy", "set", "confirmMode", "human", "--if-match", "99"], options, (stale) => {
                assert.equal(stale.code, 1);
                assert.match(stale.all, /rev/);
            });
        });
    });

    it("--tenant writes a tenant's file, and the account's effective policy includes it", async () => {
        await checkCli(
            ["--json", "policy", "set", "quota.tenant.accounts", `["${OWN}"]`, "--tenant", "t1"],
            options,
            async (r) => {
                assert.equal(r.code, 0, r.all);
                await checkCli(["policy", "set", "confirmMode", "human", "--tenant", "t1"], options, (t) =>
                    assert.equal(t.code, 0, t.all),
                );
                await jsonOf(["--json", "policy", "get", "--effective"], (eff) => {
                    assert.deepEqual(eff.tenants, ["t1"]);
                    assert.equal(eff.policy.confirmMode, "human");
                });
            },
        );
    });

    it("--user sets a user's membership and policy; the account then has an owner; a bare key needs --user", async () => {
        await checkCli(["--json", "policy", "set", "tenant", "t1", "--user", "crmU1"], options, async (tenant) => {
            assert.equal(tenant.code, 0, tenant.all);
            await checkCli(["--json", "policy", "set", "accounts", OWN, "--user", "crmU1"], options, async (owned) => {
                assert.equal(owned.code, 0, owned.all);
                assert.deepEqual(json(owned).changed, ["accounts"]);
                await checkCli(
                    ["--json", "policy", "set", "presence.idleTimeout", "20m", "--user", "crmU1"],
                    options,
                    async (mode) => {
                        assert.equal(mode.code, 0, mode.all);
                        await jsonOf(["--json", "policy", "get", "--user", "crmU1"], async (user) => {
                            assert.deepEqual(
                                [user.tenant, user.accounts, user.policy.presence.idleTimeout],
                                ["t1", [OWN], "20m"],
                            );
                            await jsonOf(["--json", "policy", "get", "--effective"], async (acc) => {
                                assert.equal(acc.owner, "crmU1");
                                assert.equal(acc.policy.presence.idleTimeout, "20m");
                                await checkCli(["policy", "set", "tenant", "t1"], options, (bare) => {
                                    assert.equal(bare.code, 1);
                                    assert.match(bare.all, /--user/);
                                });
                            });
                        });
                    },
                );
            });
        });
    });

    it("token --rotate shows a token once; only its hash is kept; plain `token` says one is set", async () => {
        await checkCli(["--json", "policy", "token", "--rotate"], options, async (r) => {
            assert.equal(r.code, 0, r.all);
            const { token } = json(r);
            assert.match(token, /^zadm_/);
            assert.ok(!readFileSync(join(CONFIG_DIR, "admin", "admin-token.json"), "latin1").includes(token));
            await jsonOf(["--json", "policy", "token"], (j) => assert.equal(j.set, true));
        });
    });
});
