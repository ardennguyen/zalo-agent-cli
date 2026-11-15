/**
 * `session renew` driven as the binary: with no daemon it exits 1 and logs nothing in itself (the CLI never opens a
 * socket or a login beside a daemon; AGENTS.md section 13); with a daemon it asks the daemon's channel (`POST /session`)
 * and prints the link the daemon opened; a daemon without a public address says why.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { startDaemonChannel } from "../../src/core/daemon-channel.js";
import { runCli, stripAnsi } from "../helpers/cli.js";
import { checkCli } from "../helpers/cli-fast.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
// Commands run in the in-process CLI worker; a check that fails there is re-run as a real child process
// (tests/helpers/cli-fast.js `checkCli`), so only a real process can fail a test.

const OWN = "6464";
const OTHER = "6465";
const LINK = "https://host.example/a/6464/zalo/qr/AAAAAAAAAAAAAAAAAAAAAA";

describe("session renew", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([
                { ownId: OWN, name: "Tester", active: true },
                { ownId: OTHER, name: "Other", active: false },
            ]),
        );
        mkdirSync(getAccountDir(OWN), { recursive: true });
        mkdirSync(getAccountDir(OTHER), { recursive: true });
    });

    it("with no daemon: exit 1, and it says how to renew instead", async () => {
        // A real child process: the smoke check that the worker and a real process agree.
        const r = await runCli(["session", "renew"], options);
        assert.equal(r.code, 1, r.all);
        assert.match(r.all, /No daemon runs for this account/);
        assert.match(r.all, new RegExp(`zalo-agent --account ${OWN} login`));
    });

    describe("with a daemon", () => {
        let channel;
        let other;
        const asked = [];
        before(async () => {
            channel = await startDaemonChannel({
                getApi: () => null,
                accountDir: getAccountDir(OWN),
                onSession: (p) => {
                    asked.push(p);
                    return {
                        accountId: OWN,
                        issued: true,
                        renewUrl: LINK,
                        renewExpiresAt: "2026-06-02T00:00:00.000Z",
                        session: { expiresAt: "2026-06-05T00:00:00.000Z", daysLeft: 4, expired: false },
                    };
                },
            });
            other = await startDaemonChannel({
                getApi: () => null,
                accountDir: getAccountDir(OTHER),
                onSession: () => {
                    throw Object.assign(new Error("this server has no public address"), { code: "NO_PUBLIC_URL" });
                },
            });
        });
        after(() => {
            channel?.stop();
            other?.stop();
        });

        it("prints the link the daemon opened (--json: the fields), and passes --fresh on", async () => {
            await checkCli(["--json", "session", "renew", "--fresh"], options, async (r) => {
                assert.equal(r.code, 0, r.all);
                const out = JSON.parse(stripAnsi(r.stdout));
                assert.deepEqual(
                    [out.accountId, out.renewUrl, out.renewExpiresAt, out.issued],
                    [OWN, LINK, "2026-06-02T00:00:00.000Z", true],
                );
                assert.deepEqual(asked.at(-1), { action: "renew", fresh: true });
                await checkCli(["session", "renew"], options, (human) => {
                    assert.equal(human.code, 0, human.all);
                    assert.match(human.all, /Renewal link opened/);
                    assert.ok(human.all.includes(LINK));
                });
            });
        });

        it("--account picks the account whose daemon is asked; its refusal is the error, exit 1", async () => {
            await checkCli(["session", "renew", "--account", OTHER], options, (r) => {
                assert.equal(r.code, 1, r.all);
                assert.match(r.all, /no public address/);
            });
        });
    });
});
