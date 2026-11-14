/**
 * Ctrl+C for a long run (src/utils/interrupt.js): the first press asks the run to stop through its signal, the
 * second leaves at once, and the handler is gone when the run is.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { whileInterruptible } from "../../src/utils/interrupt.js";

/** A process stand-in: an emitter that records `exit`. */
function fakeProc() {
    const proc = new EventEmitter();
    proc.exits = [];
    proc.exit = (code) => proc.exits.push(code);
    return proc;
}

describe("whileInterruptible", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    it("hands the run a signal that the first Ctrl+C aborts, and says so once", async () => {
        const proc = fakeProc();
        const said = [];
        let signal;
        const result = await whileInterruptible(
            async (s) => {
                signal = s;
                assert.equal(s.aborted, false);
                proc.emit("SIGINT");
                assert.equal(s.aborted, true);
                return "ran";
            },
            { proc, onStop: () => said.push("stop") },
        );
        assert.equal(result, "ran");
        assert.deepEqual(said, ["stop"]);
        assert.deepEqual(proc.exits, [], "one press does not leave");
        assert.equal(signal.aborted, true);
    });

    it("leaves at once, with 130, on the second Ctrl+C", async () => {
        const proc = fakeProc();
        await whileInterruptible(
            async () => {
                proc.emit("SIGINT");
                proc.emit("SIGINT");
            },
            { proc },
        );
        assert.deepEqual(proc.exits, [130]);
    });

    it("removes its handler when the run ends, and when the run throws", async () => {
        const proc = fakeProc();
        await whileInterruptible(async () => {}, { proc });
        assert.equal(proc.listenerCount("SIGINT"), 0);
        await assert.rejects(
            whileInterruptible(
                async () => {
                    throw new Error("boom");
                },
                { proc },
            ),
            /boom/,
        );
        assert.equal(proc.listenerCount("SIGINT"), 0);
    });

    it("holds the handler for exactly the run", async () => {
        const proc = fakeProc();
        await whileInterruptible(
            async () => {
                assert.equal(proc.listenerCount("SIGINT"), 1);
            },
            { proc },
        );
    });
});

describe("what sync says about a cancelled restore", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    it("is a partial result that names the person's stop, and does not claim the restore finished", async () => {
        const { reportRestore } = await import("../../src/commands/sync.js");
        const lines = [];
        const seen = { log: console.log, error: console.error };
        console.log = console.error = (...a) => lines.push(a.join(" "));
        process.env.ZALO_JSON_MODE = "1";
        let r;
        try {
            r = reportRestore(
                { reason: "cancelled", messagesSaved: 7, conversations: 3, threadsMapped: 3, threadsUnmapped: 0 },
                { label: "the full history", days: null, from: 0 },
            );
        } finally {
            Object.assign(console, seen);
            delete process.env.ZALO_JSON_MODE;
        }
        assert.deepEqual(r, { status: "partial", reason: "cancelled by you" });
        const text = lines.join("\n");
        assert.match(text, /Cancelled: 7 message\(s\) from 3 conversation\(s\) were stored/);
        assert.doesNotMatch(text, /Restored 7/);
    });
});
