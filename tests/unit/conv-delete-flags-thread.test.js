/**
 * `conv delete` flags the thread it deleted in the local cache -- checked in a
 * process where the command is the first thing to touch zalo.db, as it is in
 * every real CLI invocation.
 *
 * The flag (markThreadGone, which lets `conv forget --orphans` find the
 * thread's leftovers) writes to the db that newestMessageAnchor() opened only
 * as a side effect of its cache fallback. Once a group's anchor came from
 * Zalo's cloud-message store instead, nothing on that path opened the db, the
 * write threw "Database not initialized", and the catch around it swallowed
 * it: the delete reported success and the thread was never flagged.
 *
 * db.js keeps one module-level handle and offers no way to close it, so this
 * cannot share a file with tests that open the db first -- an earlier
 * initDb() in the same process would hide the bug. For the same reason the
 * thread row is seeded, and the flag read back, from child processes.
 */
import { SANDBOX_CONFIG_DIR, SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerConvCommands } from "../../src/commands/conv.js";
import { FAKE, installFakeZalo, loginFake, runCommand } from "./fake-zalo-session.js";

const GID = "7000000000000000001";
const DB_PATH = join(CONFIG_DIR, "accounts", FAKE.ownId, "zalo.db");
const DB_MODULE = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "core", "db.js")).href;

/**
 * Run `body` against zalo.db in a child process, leaving this process's
 * db.js unopened. `db` is src/core/db.js, already initialized on DB_PATH.
 *
 * @param {string} body - ES module source
 * @returns {string} the child's stdout
 */
function withDbInChild(body) {
    const source = `import * as db from ${JSON.stringify(DB_MODULE)};\ndb.initDb(${JSON.stringify(DB_PATH)});\n${body}`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
        encoding: "utf8",
        env: { ...process.env, USERPROFILE: SANDBOX_HOME, HOME: SANDBOX_HOME },
    });
}

describe("conv delete flags the deleted thread in the cache", () => {
    let fake;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        mkdirSync(join(CONFIG_DIR, "accounts", FAKE.ownId), { recursive: true });
        // The listener or a sync would have recorded the group; seed that row.
        withDbInChild(
            `db.upsertThread({ threadId: ${JSON.stringify(GID)}, type: "group", name: "Disposable", lastUpdate: 1 });`,
        );
        fake = installFakeZalo();
        await loginFake();
    });

    after(() => fake.uninstall());

    it("when the anchor came from Zalo's cloud-message store", async () => {
        fake.route("/api/cm/getrecentv2", () =>
            JSON.stringify({
                error: 0,
                lastMsgId: "0",
                hasMore: 0,
                isOld: 0,
                groupMsgs: [
                    {
                        msgId: "8300000000003",
                        cliMsgId: "1790000000003",
                        msgType: "webchat",
                        uidFrom: "2000000000000000002",
                        idTo: GID,
                        ts: "1790000003000",
                        content: "newest",
                    },
                ],
            }),
        );
        fake.route("/api/group/deleteconver", () => ({}));

        const r = await runCommand(registerConvCommands, ["--json", "conv", "delete", GID, "-t", "1"]);

        assert.equal(fake.calls("/api/group/deleteconver").length, 1, `the delete itself did not go out: ${r.stdout}`);
        const flagged = JSON.parse(
            withDbInChild(
                `console.log(JSON.stringify(db.getOrphanThreads().find((t) => t.threadId === ${JSON.stringify(GID)}) ?? null));`,
            ),
        );
        assert.ok(flagged, "conv delete succeeded but never flagged the thread as gone");
        assert.ok(flagged.leftAt > 0, "leftAt must hold the time of the delete");
    });
});
