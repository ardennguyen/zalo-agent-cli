/**
 * src/core/voice-text.js: the text of a transcribed voice message is kept when its control push arrives, so
 * `read run voice-transcript` can give it back to a command that has no socket to hear it on.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acorn from "acorn";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { walkAst } from "../helpers/zca-call-sites.js";
import { createUnknownActs } from "../../src/core/unknown-acts.js";
import {
    CMD_PUSH_CONTROLS,
    MAX_ITEMS,
    attachVoiceText,
    createVoiceText,
    loadTranscripts,
    readTranscript,
    voiceTextFile,
} from "../../src/core/voice-text.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-voice-text-"));
let n = 0;
const fresh = () => join(ROOT, `vt${n++}.json`);
after(() => {
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering handle is not worth failing the run over */
    }
});

/** A 601 frame carrying one control, its data as the JSON text the server sends. */
const frame = (data, { actType = "voice2text", act = "convert_finish" } = {}) => ({
    controls: [{ actionId: "1", controlId: "2", content: { act_type: actType, act, data: JSON.stringify(data) } }],
});

describe("voice text — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("recording a transcript", () => {
    it("keeps the text, the request and when, and says so in the log without the text", () => {
        const file = fresh();
        const lines = [];
        const vt = createVoiceText({ file, now: () => 5000, log: (l) => lines.push(l) });
        const got = vt.observe(
            CMD_PUSH_CONTROLS,
            frame({ req_id: "r-1", err: 0, text: "xin chào các bạn", url: "https://voice.test/a", has_more: 0 }),
        );
        assert.equal(got, 1);
        assert.deepEqual(readTranscript(file, "r-1"), {
            reqId: "r-1",
            at: new Date(5000).toISOString(),
            err: 0,
            text: "xin chào các bạn",
            done: true,
        });
        assert.equal(lines.length, 1);
        assert.match(lines[0], /ready: request r-1/);
        assert.doesNotMatch(lines[0], /xin chào/, "the log never carries the text");
        assert.doesNotMatch(readFileSync(file, "utf8"), /voice\.test/, "the voice file's address is not kept");
    });

    it("joins the pieces of a long message in the order they arrive, and is done at the last one", () => {
        const file = fresh();
        const lines = [];
        const vt = createVoiceText({ file, log: (l) => lines.push(l) });
        vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r-2", err: 0, text: "một ", has_more: 1 }));
        assert.equal(readTranscript(file, "r-2").done, false);
        assert.equal(lines.length, 0, "nothing is announced until it is whole");
        vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r-2", err: 0, text: "hai ", has_more: true }));
        vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r-2", err: 0, text: "ba", has_more: 0 }));
        const t = readTranscript(file, "r-2");
        assert.equal(t.text, "một hai ba");
        assert.equal(t.done, true);
        assert.equal(lines.length, 1);
    });

    it("records a failure with its error code and an empty text", () => {
        const file = fresh();
        const lines = [];
        const vt = createVoiceText({ file, log: (l) => lines.push(l) });
        vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r-3", err: 7, text: "", has_more: 0 }));
        assert.equal(readTranscript(file, "r-3").err, 7);
        assert.match(lines[0], /failed \(error 7\)/);
    });

    it("lists the newest first, answers null for an unknown request, and keeps a bounded number", () => {
        const file = fresh();
        let t = 0;
        const vt = createVoiceText({ file, now: () => ++t });
        for (let i = 0; i < MAX_ITEMS + 5; i++) {
            vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: `r${i}`, err: 0, text: `t${i}`, has_more: 0 }));
        }
        const all = readTranscript(file);
        assert.equal(all.length, MAX_ITEMS);
        assert.equal(all[0].reqId, `r${MAX_ITEMS + 4}`, "newest first");
        assert.equal(readTranscript(file, "r0"), null, "the oldest were dropped");
        assert.equal(readTranscript(file, "never"), null);
    });

    it("ignores other controls, other commands and frames of a shape nobody expected, and never throws", () => {
        const file = fresh();
        const vt = createVoiceText({ file });
        assert.equal(vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "x" }, { actType: "other", act: "thing" })), 0);
        assert.equal(vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "x" }, { act: "something_else" })), 0);
        assert.equal(vt.observe(602, frame({ req_id: "x", text: "t" })), 0);
        assert.equal(vt.observe(CMD_PUSH_CONTROLS, frame({ text: "no request id" })), 0);
        for (const junk of [null, undefined, 5, "x", {}, { controls: "x" }, { controls: [null, 3] }]) {
            assert.doesNotThrow(() => vt.observe(CMD_PUSH_CONTROLS, junk));
        }
        assert.equal(existsSync(file), false, "nothing to write");
    });

    it("carries on from the file of an earlier run, and from a damaged one", () => {
        const file = fresh();
        writeFileSync(file, JSON.stringify({ items: { old: { at: 1, err: 0, text: "cũ", done: true } } }));
        const vt = createVoiceText({ file, now: () => 9 });
        vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "new", err: 0, text: "mới", has_more: 0 }));
        assert.deepEqual(Object.keys(loadTranscripts(file)).sort(), ["new", "old"]);
        const bad = fresh();
        writeFileSync(bad, "not json");
        assert.deepEqual(loadTranscripts(bad), {});
        assert.deepEqual(readTranscript(bad), []);
    });

    it("an unwritable file does not throw into the socket", () => {
        const vt = createVoiceText({ file: join(ROOT, "no", "such", "dir", "x.json") });
        assert.doesNotThrow(() =>
            vt.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r", err: 0, text: "t", has_more: 0 })),
        );
    });
});

describe("what the other collectors make of it", () => {
    it("the unknown-action collector does not flag a control this client now handles", () => {
        const acts = createUnknownActs({ file: fresh() });
        assert.equal(acts.observe(CMD_PUSH_CONTROLS, frame({ req_id: "r", text: "t", has_more: 0 })), 0);
        assert.deepEqual(acts.names(), {});
    });

    it("the file sits in the account folder", () => {
        assert.equal(voiceTextFile(join("a", "b")), join("a", "b", "voice-text.json"));
    });
});

describe("attached to a socket tap", () => {
    it("listens to 601 and lets go on stop", () => {
        const subs = new Map();
        const tap = {
            on(cmd, fn) {
                subs.set(cmd, fn);
                return () => subs.delete(cmd);
            },
        };
        const file = fresh();
        const a = attachVoiceText({ tap, file });
        assert.deepEqual([...subs.keys()], [601]);
        subs.get(601)({ data: frame({ req_id: "r-9", err: 0, text: "ok", has_more: 0 }) });
        assert.equal(readTranscript(file, "r-9").text, "ok");
        a.stop();
        assert.equal(subs.size, 0);
    });
});

describe("`listen` and `mcp start` both record transcripts from their socket tap", () => {
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const src = join(import.meta.dirname, "..", "..", "src", "commands", file);
            const ast = acorn.parse(readFileSync(src, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
            const taps = [];
            const calls = [];
            walkAst(ast, (node) => {
                if (node.type === "VariableDeclarator" && node.init?.callee?.name === "createSocketTap")
                    taps.push(node.id.name);
                if (node.type === "CallExpression" && node.callee?.name === "attachVoiceText") calls.push(node);
            });
            // Red if one entry point stops recording them: AGENTS.md section 13 calls that asymmetry a defect.
            assert.equal(calls.length, 1, `${file} must attach one recorder`);
            const tap = calls[0].arguments[0]?.properties?.find((p) => p.key?.name === "tap");
            assert.equal(tap?.value?.name, taps[0], "it must ride the daemon's socket tap");
        });
    }
});
