/**
 * `group leave -s/--silent`, driven end to end offline.
 *
 * zca-js's `leaveGroup(groupId, silent)` sends `silent: 1|0` to
 * {group}/api/group/leave. The command called it with no second argument, so a
 * silent leave was unreachable from the CLI. These run the real command over
 * zca-js's own HTTP seam and read what went out on the wire.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serviceHost } from "./fake-zalo-session.js";

const GID = "7000000000000000001";

describe("group leave --silent reaches Zalo", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1"; // what `--json` sets in src/index.js
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
        fake.route("/api/group/leave", () => ({ memberError: [] }));
    });

    /** The single leave request the command made. */
    function leaveRequest() {
        const calls = fake.calls("/api/group/leave");
        assert.equal(calls.length, 1, "expected exactly one leave request");
        return calls[0];
    }

    it("without the flag it leaves out loud (silent: 0)", async () => {
        const r = await runCommand(registerGroupCommands, ["--json", "group", "leave", GID]);
        assert.equal(r.exitCode, null, `leave failed: ${r.stdout} ${r.stderr}`);
        const req = leaveRequest();
        assert.equal(req.host, serviceHost("group"));
        assert.deepEqual(req.params, { grids: [GID], imei: FAKE.imei, silent: 0, language: req.params.language });
    });

    for (const flag of ["-s", "--silent"]) {
        it(`${flag} leaves silently (silent: 1)`, async () => {
            const r = await runCommand(registerGroupCommands, ["--json", "group", "leave", GID, flag]);
            assert.equal(r.exitCode, null, `leave failed: ${r.stdout} ${r.stderr}`);
            // Red if the flag is parsed but not passed on: the wire would still say silent: 0.
            assert.equal(leaveRequest().params.silent, 1);
            assert.deepEqual(leaveRequest().params.grids, [GID]);
        });
    }
});
