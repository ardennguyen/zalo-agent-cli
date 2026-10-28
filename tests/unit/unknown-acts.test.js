/**
 * src/core/unknown-acts.js — the control actions the server sends that this client has no handler for are named once, in
 * a small local file, and never disturb the socket. Frames are shaped like the captured 602 and 601 pushes.
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
import {
    CMD_PUSH_ACTIONS,
    CMD_PUSH_CONTROLS,
    MAX_NAMES,
    SAVE_EVERY_MS,
    attachUnknownActs,
    createUnknownActs,
    readActions,
} from "../../src/core/unknown-acts.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-unknown-acts-"));
let n = 0;
const fresh = () => join(ROOT, `acts${n++}.json`);
after(() => {
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering handle is not worth failing the run over */
    }
});

const actions = (...list) => ({ actions: list });
const saved = (file) => JSON.parse(readFileSync(file, "utf8")).names;

describe("unknown actions — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("reading a 602 frame", () => {
    it("takes act_type, act and the key NAMES of data, from an object or a JSON string", () => {
        const out = readActions(
            actions(
                { act_type: "banner", act: "update", data: { id: "x", text: "secret" } },
                { act_type: "poll", act: "vote", data: JSON.stringify({ a: 1, b: 2 }) },
            ),
        );
        assert.deepEqual(out, [
            { actType: "banner", act: "update", keys: ["id", "text"] },
            { actType: "poll", act: "vote", keys: ["a", "b"] },
        ]);
    });

    it("skips what is not an action, and survives a data that is not JSON, an array or absent", () => {
        const out = readActions(
            actions(
                null,
                7,
                { act_type: "a", act: "b", data: "{not json" },
                { act_type: "c", data: [1, 2] },
                { act: "d" },
            ),
        );
        assert.deepEqual(out, [
            { actType: "a", act: "b", keys: [] },
            { actType: "c", act: "", keys: [] },
            { actType: "", act: "d", keys: [] },
        ]);
        for (const junk of [null, undefined, {}, { actions: "x" }, { actions: {} }])
            assert.deepEqual(readActions(junk), []);
    });
});

describe("what gets noted", () => {
    it("notes an unknown action once, with its key names and never its values, and logs it once", () => {
        const file = fresh();
        const lines = [];
        const acts = createUnknownActs({ file, now: () => 1000, log: (l) => lines.push(l) });
        const frame = actions({ act_type: "banner", act: "update", data: { text: "private words", id: 7 } });
        assert.equal(acts.observe(CMD_PUSH_ACTIONS, frame), 1);
        assert.equal(acts.observe(CMD_PUSH_ACTIONS, frame), 0);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /banner\/update \(cmd 602\)/);
        const names = saved(file);
        assert.deepEqual(Object.keys(names), ["banner/update"]);
        assert.deepEqual(names["banner/update"].keys, ["text", "id"]);
        assert.equal(names["banner/update"].cmd, 602);
        assert.doesNotMatch(readFileSync(file, "utf8"), /private words/);
    });

    it("does not note typing, which zca-js already reads", () => {
        const file = fresh();
        const acts = createUnknownActs({ file });
        assert.equal(acts.observe(CMD_PUSH_ACTIONS, actions({ act_type: "typing", act: "typing", data: {} })), 0);
        assert.equal(existsSync(file), false, "nothing to write");
    });

    it("notes a 601 control nobody handles, and none that something does", () => {
        const file = fresh();
        const acts = createUnknownActs({ file });
        const controls = {
            controls: [
                { content: { act_type: "transfer_sync2", act: "upload_batch" } },
                { content: { act_type: "mark_unread", act: "add" } },
                {
                    content: {
                        act_type: "brand_new",
                        act: "thing",
                        data: JSON.stringify({ req_id: "r1", text: "secret words" }),
                    },
                },
            ],
        };
        assert.equal(acts.observe(CMD_PUSH_CONTROLS, controls), 1);
        assert.deepEqual(Object.keys(saved(file)), ["brand_new/thing"]);
        assert.equal(saved(file)["brand_new/thing"].cmd, 601);
        assert.deepEqual(saved(file)["brand_new/thing"].keys, ["req_id", "text"], "the key names of its data");
        assert.doesNotMatch(readFileSync(file, "utf8"), /secret words/, "never the values");
    });

    it("counts a name it has seen, writing the count back at most once a minute", () => {
        const file = fresh();
        let t = 1000;
        const acts = createUnknownActs({ file, now: () => t });
        const frame = actions({ act_type: "x", act: "y", data: {} });
        acts.observe(CMD_PUSH_ACTIONS, frame);
        t += 1000;
        acts.observe(CMD_PUSH_ACTIONS, frame);
        assert.equal(saved(file)["x/y"].count, 1, "not yet written");
        t += SAVE_EVERY_MS;
        acts.observe(CMD_PUSH_ACTIONS, frame);
        assert.equal(saved(file)["x/y"].count, 3);
        assert.equal(saved(file)["x/y"].firstSeen, 1000);
        assert.equal(saved(file)["x/y"].lastSeen, t);
    });

    it("keeps a bounded number of names", () => {
        const file = fresh();
        const acts = createUnknownActs({ file });
        for (let i = 0; i < MAX_NAMES + 25; i++)
            acts.observe(CMD_PUSH_ACTIONS, actions({ act_type: `t${i}`, act: "a" }));
        assert.equal(Object.keys(saved(file)).length, MAX_NAMES);
    });

    it("keeps 200 names at most: a bound of ours, pinned so that a change is a decision", () => {
        assert.equal(MAX_NAMES, 200);
    });

    it("carries on from the file of an earlier run, and from a damaged one", () => {
        const file = fresh();
        writeFileSync(
            file,
            JSON.stringify({ names: { "old/one": { firstSeen: 1, lastSeen: 1, count: 4, cmd: 602, keys: [] } } }),
        );
        const acts = createUnknownActs({ file });
        assert.equal(acts.observe(CMD_PUSH_ACTIONS, actions({ act_type: "old", act: "one" })), 0, "already known");
        assert.equal(acts.observe(CMD_PUSH_ACTIONS, actions({ act_type: "new", act: "one" })), 1);
        assert.deepEqual(Object.keys(saved(file)).sort(), ["new/one", "old/one"]);
        const bad = fresh();
        writeFileSync(bad, "not json at all");
        assert.equal(
            createUnknownActs({ file: bad }).observe(CMD_PUSH_ACTIONS, actions({ act_type: "a", act: "b" })),
            1,
        );
    });

    it("never throws into the socket: junk frames, a broken logger, an unwritable file", () => {
        const acts = createUnknownActs({
            file: join(ROOT, "no", "such", "dir", "x.json"),
            log: () => {
                throw new Error("logger broke");
            },
        });
        for (const junk of [null, undefined, 5, "x", { actions: [{ act_type: {} }] }]) {
            assert.doesNotThrow(() => acts.observe(CMD_PUSH_ACTIONS, junk));
            assert.doesNotThrow(() => acts.observe(CMD_PUSH_CONTROLS, junk));
        }
        assert.doesNotThrow(() => acts.observe(CMD_PUSH_ACTIONS, actions({ act_type: "q", act: "r" })));
        assert.ok("q/r" in acts.names(), "still noted in memory when the file cannot be written");
    });
});

describe("attached to a socket tap", () => {
    it("listens to 602 and 601 and lets go on stop", () => {
        const subs = new Map();
        const tap = {
            on(cmd, fn) {
                subs.set(cmd, fn);
                return () => subs.delete(cmd);
            },
        };
        const file = fresh();
        const a = attachUnknownActs({ tap, file });
        assert.deepEqual([...subs.keys()].sort(), [601, 602]);
        subs.get(602)({ data: actions({ act_type: "banner", act: "remove" }) });
        subs.get(601)({ data: { controls: [{ content: { act_type: "zz", act: "top" } }] } });
        assert.deepEqual(Object.keys(a.names()).sort(), ["banner/remove", "zz/top"]);
        a.stop();
        assert.equal(subs.size, 0);
    });
});

describe("`listen` and `mcp start` both collect them from their socket tap", () => {
    for (const file of ["listen.js", "mcp.js"]) {
        it(file, () => {
            const src = join(import.meta.dirname, "..", "..", "src", "commands", file);
            const ast = acorn.parse(readFileSync(src, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
            const taps = [];
            const calls = [];
            walkAst(ast, (node) => {
                if (node.type === "VariableDeclarator" && node.init?.callee?.name === "createSocketTap")
                    taps.push(node.id.name);
                if (node.type === "CallExpression" && node.callee?.name === "attachUnknownActs") calls.push(node);
            });
            // Red if one entry point stops noting unknown actions: AGENTS.md §13 calls that asymmetry a defect.
            assert.equal(calls.length, 1, `${file} must attach one collector`);
            const tap = calls[0].arguments[0]?.properties?.find((p) => p.key?.name === "tap");
            assert.equal(tap?.value?.name, taps[0], "it must ride the daemon's socket tap");
        });
    }
});
