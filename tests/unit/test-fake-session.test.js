/**
 * The test-only fake session (src/core/test-fake-session.js) is refused everywhere but the offline test sandbox.
 *
 * `ZALO_TEST_FAKE_API` swaps the login for a fake session, which in normal use would make every command answer
 * from a fake instead of Zalo. So the seam must be unreachable outside a test run: each guard condition is shown
 * to refuse on its own, and the real binary is shown to fail -- not to fall back to a login -- when one does not
 * hold.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { TEST_FAKE_API_REFUSED, resolveTestFakeApi } from "../../src/core/test-fake-session.js";
import { runCli } from "../helpers/cli.js";

const FAKE_API = resolve(import.meta.dirname, "..", "helpers", "fake-api.js");
const SANDBOX_ENV = { ZALO_SANDBOX_ACTIVE: "1", ZALO_TEST_FAKE_API: FAKE_API };

/** resolveTestFakeApi in the sandbox, with `over` changed. */
const resolveWith = (over = {}) =>
    resolveTestFakeApi({ env: SANDBOX_ENV, configDir: CONFIG_DIR, home: SANDBOX_HOME, ...over });

const refused = (fn, why) =>
    assert.throws(fn, (e) => e.code === TEST_FAKE_API_REFUSED && why.test(e.message), `expected a refusal: ${why}`);

describe("the test-only fake session", () => {
    it("operates inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    it("is off when the variable is not set", () => {
        assert.equal(resolveTestFakeApi({ env: {}, configDir: CONFIG_DIR, home: SANDBOX_HOME }), null);
    });

    it("is honored inside the sandbox, for a module of this package's test suite", () => {
        assert.equal(resolveWith(), FAKE_API);
    });

    it("is refused without the sandbox marker", () => {
        refused(() => resolveWith({ env: { ZALO_TEST_FAKE_API: FAKE_API } }), /not running in the offline test/);
        refused(() => resolveWith({ env: { ...SANDBOX_ENV, ZALO_SANDBOX_ACTIVE: "0" } }), /offline test sandbox/);
    });

    it("is refused for a home that is not a sandbox home", () => {
        refused(() => resolveWith({ home: mkdtempSync(join(tmpdir(), "zalo-agent-other-")) }), /home directory/);
        // The right name, in the wrong place.
        refused(() => resolveWith({ home: join(SANDBOX_HOME, "zalo-agent-test-nested") }), /home directory/);
    });

    it("is refused when the config directory is outside the sandbox home", () => {
        refused(() => resolveWith({ configDir: tmpdir() }), /config directory/);
    });

    it("is refused for a module outside this package's tests/ folder", () => {
        const copy = join(SANDBOX_HOME, "fake-api.js");
        copyFileSync(FAKE_API, copy);
        refused(() => resolveWith({ env: { ...SANDBOX_ENV, ZALO_TEST_FAKE_API: copy } }), /test suite/);
        refused(
            () => resolveWith({ env: { ...SANDBOX_ENV, ZALO_TEST_FAKE_API: join(SANDBOX_HOME, "none.js") } }),
            /test suite/,
        );
    });

    it("makes the real binary fail, not log in, when a guard does not hold", { timeout: 120_000 }, async () => {
        const r = await runCli(["--json", "friend", "list"], {
            home: SANDBOX_HOME,
            env: { ZALO_TEST_FAKE_API: FAKE_API, ZALO_SANDBOX_ACTIVE: "0" },
        });
        assert.equal(r.code, 1, r.all);
        const out = JSON.parse(r.stdout);
        assert.equal(Object.keys(out)[0], "error");
        assert.match(out.error, /ZALO_TEST_FAKE_API is a test-only setting and is refused/);
    });

    it("answers from the fake inside the sandbox", { timeout: 120_000 }, async () => {
        const r = await runCli(["--json", "friend", "list"], {
            home: SANDBOX_HOME,
            env: { ZALO_TEST_FAKE_API: FAKE_API },
        });
        assert.equal(r.code, 0, r.all);
        // The fake's friend, named by the fake's alias for them (src/core/contact-names.js), its Zalo name beside it.
        assert.equal(JSON.parse(r.stdout)[0].zaloName, "Fake Friend");
        assert.equal(JSON.parse(r.stdout)[0].displayName, "Fake Alias");
    });
});
