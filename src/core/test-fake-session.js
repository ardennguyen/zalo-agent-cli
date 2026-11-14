/**
 * Test seam: run a CLI command against an injected fake session instead of logging in.
 *
 * `ZALO_TEST_FAKE_API=<path to a module>` makes `autoLogin()` (src/core/zalo-client.js) import that module and
 * use the session its `createFakeSession(env)` returns, so an offline test can execute any command's action
 * without a Zalo account (tests/cli/json-contract.test.js runs every personal command this way).
 *
 * It must be impossible to reach in normal use, so the variable is REFUSED -- the command fails before
 * anything else happens, it never falls back to a real login -- unless every one of these holds:
 *
 *   1. `ZALO_SANDBOX_ACTIVE=1`, which only the offline test sandbox sets (tests/helpers/sandbox.js, cli.js);
 *   2. the home directory is a sandbox home: a `zalo-agent-test-*` folder directly inside the OS temp folder;
 *   3. the config directory in use (after `--config-dir` / `ZALO_CONFIG_DIR`) lies inside that home;
 *   4. the module is a file under this package's own `tests/` folder, which the npm package does not ship
 *      (package.json `files` lists `src/` only), so an installed CLI has no module it could load.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEST_FAKE_API_ENV = "ZALO_TEST_FAKE_API";

/** `.code` of the error a refused {@link TEST_FAKE_API_ENV} raises. */
export const TEST_FAKE_API_REFUSED = "TEST_FAKE_API_REFUSED";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests");

const real = (p) => {
    try {
        return realpathSync(p);
    } catch {
        return resolve(p);
    }
};

/** Whether `child` is `parent` itself or lies inside it. */
const inside = (child, parent) => {
    const rel = relative(real(parent), real(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The fake-session module to load, or null when the variable is not set.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} opts.configDir - the config directory in use
 * @param {string} [opts.home]
 * @param {string} [opts.temp]
 * @returns {string|null} absolute module path
 * @throws {Error} when the variable is set outside the offline test sandbox
 */
export function resolveTestFakeApi({ env = process.env, configDir, home = homedir(), temp = tmpdir() } = {}) {
    const raw = env[TEST_FAKE_API_ENV];
    if (!raw) return null;
    const refuse = (why) => {
        const e = new Error(`${TEST_FAKE_API_ENV} is a test-only setting and is refused here: ${why}. Unset it.`);
        e.code = TEST_FAKE_API_REFUSED;
        throw e;
    };
    if (env.ZALO_SANDBOX_ACTIVE !== "1") refuse("not running in the offline test sandbox");
    if (!basename(home).startsWith("zalo-agent-test-") || real(dirname(home)) !== real(temp)) {
        refuse("the home directory is not a test sandbox home");
    }
    if (!configDir || !inside(configDir, home)) refuse("the config directory is outside the test sandbox");
    const modulePath = resolve(raw);
    if (!existsSync(modulePath) || !existsSync(TESTS_DIR) || !inside(modulePath, TESTS_DIR)) {
        refuse("the module is not part of this package's test suite");
    }
    return modulePath;
}

/**
 * Load the fake session the module makes.
 *
 * @param {string} modulePath - from {@link resolveTestFakeApi}
 * @returns {Promise<{api: object, ownId: string|null}>}
 */
export async function loadTestFakeSession(modulePath) {
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.createFakeSession !== "function") {
        throw new Error(`${TEST_FAKE_API_ENV}: ${modulePath} does not export createFakeSession()`);
    }
    return mod.createFakeSession(process.env);
}
