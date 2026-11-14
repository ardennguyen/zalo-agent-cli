/**
 * `restoreViaDaemon` (src/commands/sync.js): Ctrl+C during a restore that runs on a daemon's socket.
 *
 * A restore routed through a daemon used to ignore Ctrl+C: the CLI died and the daemon finished the run beside a
 * user who thought it had stopped. The first Ctrl+C now asks the daemon to cancel (it keeps what arrived and
 * releases its sessions on the phone); a second quits at once.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { startDaemonChannel } from "../../src/core/daemon-channel.js";
import { restoreViaDaemon } from "../../src/commands/sync.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-restore-daemon-"));
const channels = [];
let n = 0;

after(() => {
    for (const c of channels) {
        try {
            c.stop();
        } catch {
            /* already stopped */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering handle is not worth failing the run over */
    }
});

/** A daemon whose restore waits for a cancel, and a stand-in process to press Ctrl+C on. */
async function rig() {
    const accountDir = join(ROOT, `acct${n++}`);
    rmSync(accountDir, { recursive: true, force: true });
    mkdirSync(accountDir, { recursive: true });
    const seen = { aborted: false };
    channels.push(
        await startDaemonChannel({
            getApi: () => ({}),
            accountDir,
            runners: {
                messages: (_params, _onEvent, signal) =>
                    new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            seen.aborted = true;
                            resolve({ reason: "cancelled", messagesSaved: 7 });
                        });
                    }),
            },
        }),
    );
    const proc = Object.assign(new EventEmitter(), { exits: [], exit: (code) => proc.exits.push(code) });
    return { accountDir, seen, proc };
}

describe("restoreViaDaemon", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    it("the first Ctrl+C cancels the stage on the daemon and the restore ends with its cancelled result", async () => {
        const { accountDir, seen, proc } = await rig();
        const running = restoreViaDaemon(accountDir, { stage: "messages" }, { proc });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(seen.aborted, false, "nothing stops it before Ctrl+C");
        proc.emit("SIGINT");
        const r = await running;
        assert.equal(r.ok, true);
        assert.deepEqual(r.result, { reason: "cancelled", messagesSaved: 7 });
        assert.equal(seen.aborted, true);
        assert.deepEqual(proc.exits, []);
        assert.equal(proc.listenerCount("SIGINT"), 0, "the handler is gone when the run ends");
    });

    it("a second Ctrl+C quits at once with 130 and leaves the daemon's cancel to finish by itself", async () => {
        const { accountDir, seen, proc } = await rig();
        const running = restoreViaDaemon(accountDir, { stage: "messages" }, { proc });
        await new Promise((r) => setTimeout(r, 80));
        proc.emit("SIGINT");
        proc.emit("SIGINT");
        assert.deepEqual(proc.exits, [130]);
        await running;
        assert.equal(seen.aborted, true);
    });
});
