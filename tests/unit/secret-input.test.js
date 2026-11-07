/**
 * src/utils/secret-input.js: a secret handed over at run time (the zCloud key of `cloud get`), from standard input or
 * a prompt that does not echo. The value is only returned: nothing typed is written back to the terminal.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { promptSecret, readSecretFromStream } from "../../src/utils/secret-input.js";

/** A terminal stand-in: raw mode recorded, keys fed by the test. */
function fakeTty() {
    const t = new EventEmitter();
    t.isTTY = true;
    t.modes = [];
    t.setRawMode = (on) => t.modes.push(on);
    t.resume = () => {};
    t.pause = () => {};
    return t;
}

const sink = () => {
    const out = { text: "", write: (s) => (out.text += s) };
    return out;
};

describe("secret input", () => {
    it("reads the whole of standard input, trimmed", async () => {
        assert.equal(await readSecretFromStream(Readable.from(["  abc", "def\n"])), "abcdef");
    });

    it("prompts without echoing what is typed, handles backspace, and leaves raw mode", async () => {
        const input = fakeTty();
        const output = sink();
        const p = promptSecret("Key: ", { input, output });
        input.emit("data", Buffer.from("s3x\u007fcr"));
        input.emit("data", Buffer.from("et\r"));
        assert.equal(await p, "s3cret");
        // Red if a typed character reached the terminal, or the terminal was left in raw mode.
        assert.equal(output.text, "Key: \n");
        assert.deepEqual(input.modes, [true, false]);
    });

    it("Ctrl+C cancels, and no terminal is a clear error", async () => {
        const input = fakeTty();
        const p = promptSecret("Key: ", { input, output: sink() });
        input.emit("data", Buffer.from("ab\u0003"));
        await assert.rejects(p, /cancelled/);
        await assert.rejects(promptSecret("Key: ", { input: { isTTY: false }, output: sink() }), /standard input/);
    });
});
