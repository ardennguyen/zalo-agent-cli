/**
 * Offline test sandbox.
 *
 * `src/core/credentials.js` computes CONFIG_DIR once, at module-evaluation
 * time, from `os.homedir()`. `os.homedir()` reads USERPROFILE (Windows) /
 * HOME (POSIX) on every call, so redirecting those env vars *before* the
 * module is first imported is enough to point the whole config tree at a
 * throwaway directory.
 *
 * ESM evaluates dependencies in the order their `import` declarations
 * appear, so a test file that puts
 *
 *     import { SANDBOX_HOME } from "../helpers/sandbox.js";
 *
 * above its `import ... from "../../src/core/..."` lines is guaranteed to
 * get a redirected CONFIG_DIR. `assertSandboxed()` exists to make a
 * regression in that ordering fail loudly instead of silently writing to
 * the developer's real ~/.zalo-agent-cli/.
 *
 * One sandbox per test *process*. `node --test` forks a process per file,
 * so each test file gets its own isolated home for free.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Absolute path to this process's throwaway home directory. */
export const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "zalo-agent-test-"));

/** What CONFIG_DIR *must* equal once src/core/credentials.js is imported. */
export const SANDBOX_CONFIG_DIR = join(SANDBOX_HOME, ".zalo-agent-cli");

// Redirect every variable os.homedir() consults, on every platform.
process.env.USERPROFILE = SANDBOX_HOME;
process.env.HOME = SANDBOX_HOME;
process.env.HOMEDRIVE = "";
process.env.HOMEPATH = "";
// Keep chalk deterministic so assertions never trip over ANSI escapes.
process.env.FORCE_COLOR = "0";
process.env.NO_COLOR = "1";

let cleaned = false;

/** Remove the sandbox home. Idempotent; also wired to process exit. */
export function cleanupSandbox() {
    if (cleaned) return;
    cleaned = true;
    try {
        rmSync(SANDBOX_HOME, { recursive: true, force: true });
    } catch {
        // A stray better-sqlite3 handle on Windows can hold a file open.
        // Leaving a temp dir behind is not worth failing a test run over.
    }
}

process.on("exit", cleanupSandbox);

/**
 * Assert the module under test actually resolved its config dir inside the
 * sandbox. Call this once per suite, before touching the filesystem.
 * @param {string} configDir - the CONFIG_DIR the module exported
 */
export function assertSandboxed(configDir) {
    if (configDir !== SANDBOX_CONFIG_DIR) {
        throw new Error(
            `Sandbox escape: CONFIG_DIR is "${configDir}" but should be "${SANDBOX_CONFIG_DIR}".\n` +
                `Import ../helpers/sandbox.js BEFORE any src/ module in this test file.`,
        );
    }
}

/** True if a path exists — small readability wrapper used across suites. */
export function exists(p) {
    return existsSync(p);
}
