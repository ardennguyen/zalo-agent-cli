/**
 * The numbers the docs quote (commands, containers, MCP tools, OA commands, reads, writes) are the numbers of the code.
 *
 * AGENTS.md §10 says "re-measure; never trust the number written down", and a surface change that moved a count has
 * left stale figures behind more than once (227 where 228, "20 command groups", a read count one behind). This test
 * measures the commander tree, the MCP tool source and the two registries, then reads every place a doc states one of
 * them and requires it to agree. It is the twin of `tests/cli/surface.test.js`, which holds the command LIST.
 *
 * The method is the one in docs/agent-notes.md: load every `register*` export that `src/index.js` calls into a fresh
 * commander tree and count the invokable leaves, plus the one inline `update` command.
 */
import "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { READS } from "../../src/zalo/reads.js";
import { WRITES } from "../../src/zalo/writes.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const read = (f) => readFileSync(resolve(ROOT, f), "utf8");

/** @type {{leaves: number, containers: number, groups: number, oaLeaves: number, mcpTools: number, reads: number, writes: number}} */
let measured;

before(async () => {
    const src = read("src/index.js");
    const imports = [...src.matchAll(/import \{ (register\w+) \} from "(\.\/commands\/[\w-]+\.js)";/g)].map((m) => [
        m[1],
        m[2],
    ]);
    const calls = new Set([...src.matchAll(/^(register\w+)\(program\);/gm)].map((m) => m[1]));
    const program = new Command();
    for (const [name, file] of imports) {
        if (!calls.has(name)) continue;
        const mod = await import(pathToFileURL(resolve(ROOT, "src", file)).href);
        mod[name](program);
    }
    const inline = [...src.matchAll(/^\s*\.command\("([\w-]+)"\)/gm)].length;
    let leaves = 0;
    let containers = 0;
    let oaLeaves = 0;
    const walk = (cmd, top) => {
        for (const c of cmd.commands) {
            const t = top ?? c.name();
            if (c.commands.length) {
                containers++;
                walk(c, t);
            } else {
                leaves++;
                if (t === "oa") oaLeaves++;
            }
        }
    };
    walk(program, null);
    const groups = program.commands.filter((c) => c.commands.length).length;
    const tools = new Set(
        [...read("src/mcp/mcp-tools.js").matchAll(/registerTool\(\s*"(zalo_[a-z_]+)"/g)].map((m) => m[1]),
    );
    measured = {
        leaves: leaves + inline,
        containers,
        groups,
        oaLeaves,
        mcpTools: tools.size,
        reads: Object.keys(READS).length,
        writes: Object.keys(WRITES).length,
    };
});

/** Every place a doc states a count: file, a regex with ONE capture group for the number, and what it counts. */
const QUOTES = [
    ["AGENTS.md", /CLI commands \(\*\*(\d+)\*\*\)/g, "leaves"],
    ["AGENTS.md", /command groups \(\*\*(\d+)\*\* containers\)/g, "containers"],
    ["AGENTS.md", /MCP tools \(\*\*(\d+)\*\*\)/g, "mcpTools"],
    ["AGENTS.md", /OA commands \(\*\*(\d+)\*\*\)/g, "oaLeaves"],
    ["skill/SKILL.md", /\*\*(\d+) CLI commands\*\*/g, "leaves"],
    ["skill/SKILL.md", /across (\d+) command containers/g, "containers"],
    ["skill/SKILL.md", /\*\*(\d+) MCP tools\*\*/g, "mcpTools"],
    ["skill/SKILL.md", /\(all (\d+) commands \+ /g, "leaves"],
    ["skill/SKILL.md", /Official Account \(all (\d+) commands\)/g, "oaLeaves"],
    ["skill/SKILL.md", /use the (\d+) MCP tools/g, "mcpTools"],
    ["skill/references/command-reference.md", /\*\*(\d+) CLI commands\*\*/g, "leaves"],
    ["skill/references/command-reference.md", /\*\*(\d+) MCP tools exposed\*\*/g, "mcpTools"],
    ["skill/references/command-reference.md", /\+ (\d+) MCP tools/g, "mcpTools"],
    ["skill/references/command-reference.md", /The (\d+) reads \(/g, "reads"],
    ["skill/references/mcp-guide.md", /Tham chiếu Tools \((\d+) tools\)/g, "mcpTools"],
    ["skill/references/mcp-guide.md", /đăng ký cả (\d+) tools/g, "mcpTools"],
    ["README.md", /· (\d+) commands ·/g, "leaves"],
    ["README.md", /\*\*(\d+) commands\*\* covering/g, "leaves"],
    ["README.md", /(\d+) command groups/g, "groups"],
    ["README.md", /(\d+) nhóm lệnh/g, "groups"],
    ["README.md", /\*\*(\d+) lệnh\*\*/g, "leaves"],
    ["README.md", /· (\d+) lệnh ·/g, "leaves"],
    ["skill/SKILL.md", /\((\d+) top-level groups/g, "groups"],
    ["INSTALLATION.md", /all (\d+) commands/g, "leaves"],
    ["docs/agent-notes.md", /\*\*(\d+)\*\* invokable leaves \(\d+ personal \+ \d+ OA\)/g, "leaves"],
    ["docs/agent-notes.md", /\*\*\d+\*\* invokable leaves \((\d+) personal \+ \d+ OA\)/g, "personalLeaves"],
    ["docs/agent-notes.md", /\*\*\d+\*\* invokable leaves \(\d+ personal \+ (\d+) OA\)/g, "oaLeaves"],
    ["docs/agent-notes.md", /is a table of (\d+) reads/g, "reads"],
    ["docs/agent-notes.md", /There are (\d+) reads and \d+ writes now/g, "reads"],
    ["docs/agent-notes.md", /There are \d+ reads and (\d+) writes now/g, "writes"],
];

describe("the counts the docs quote are the code's", () => {
    it("measures a plausible tree (so a broken count cannot make every comparison trivially pass)", () => {
        assert.ok(measured.leaves > 200, `only ${measured.leaves} leaves`);
        assert.ok(measured.containers >= 20);
        assert.ok(measured.mcpTools >= 25);
        assert.ok(measured.oaLeaves >= 30);
        assert.ok(measured.reads >= 30);
        assert.ok(measured.writes >= 20);
    });

    for (const [file, re, what] of QUOTES) {
        it(`${file}: ${re.source.slice(0, 48)} is the number of ${what}`, () => {
            const text = read(file);
            const found = [...text.matchAll(re)].map((m) => Number(m[1]));
            assert.ok(found.length > 0, `${file} no longer states this count (the pattern ${re} found nothing)`);
            const want = what === "personalLeaves" ? measured.leaves - measured.oaLeaves : measured[what];
            for (const n of found) assert.equal(n, want, `${file} says ${n}; the code has ${want} (${what})`);
        });
    }
});
