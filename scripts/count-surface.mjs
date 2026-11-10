#!/usr/bin/env node
/**
 * Measures the numbers that docs quote (AGENTS.md §10) straight from the code, so nobody has to
 * trust a number written down:
 *
 *   node scripts/count-surface.mjs            # commands, groups, OA commands, MCP tools
 *   node scripts/count-surface.mjs --json     # the same as one JSON object
 *   node scripts/count-surface.mjs --tests    # also run `npm test` and report its summary line
 *
 * Method (docs/agent-notes.md, "Counting the CLI surface — walk the tree, do not count strings"):
 * parse the `import { registerX } from "./commands/y.js"` lines of src/index.js, load each into a
 * fresh Commander tree, walk it, count nodes with no subcommands as invokable leaves and nodes with
 * subcommands as containers, then add the commands src/index.js registers inline with
 * `.command("...")`. MCP tools are the `server.registerTool("name", …)` calls in src/mcp/mcp-tools.js.
 *
 * Importing the command modules has no side effects beyond reading the environment; the config
 * directory is pointed at a throwaway folder so nothing real is touched.
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.ZALO_CONFIG_DIR = mkdtempSync(join(tmpdir(), "zalo-count-"));
process.env.ZALO_JSON_MODE = "1";

const { Command } = await import(pathToFileURL(join(root, "node_modules", "commander", "index.js")).href);
const indexSrc = readFileSync(join(root, "src", "index.js"), "utf8");

/** `import { registerX } from "./commands/y.js"` pairs, in file order. */
const registrars = [...indexSrc.matchAll(/import \{ (register\w+) \} from "(\.\/commands\/[\w-]+\.js)"/g)].map(
    (m) => ({ fn: m[1], file: m[2] }),
);
/** Commands registered inline on `program` in src/index.js (e.g. `update`). */
const inline = [...indexSrc.matchAll(/^program\s*\n?\s*\.command\("([\w-]+)"\)/gm)].map((m) => m[1]);

function walk(cmd, path, acc) {
    for (const sub of cmd.commands) {
        const name = [...path, sub.name()].join(" ");
        if (sub.commands.length === 0) acc.leaves.push(name);
        else {
            acc.containers.push(name);
            walk(sub, [...path, sub.name()], acc);
        }
    }
}

const acc = { leaves: [...inline], containers: [] };
const perGroup = {};
for (const { fn, file } of registrars) {
    const mod = await import(pathToFileURL(join(root, "src", file)).href);
    if (typeof mod[fn] !== "function") throw new Error(`${file} does not export ${fn}`);
    const program = new Command();
    mod[fn](program);
    const local = { leaves: [], containers: [] };
    walk(program, [], local);
    const group = program.commands[0]?.name() ?? fn;
    perGroup[group] = (perGroup[group] ?? 0) + local.leaves.length;
    acc.leaves.push(...local.leaves);
    acc.containers.push(...local.containers);
}
if (inline.length) perGroup["(inline top-level)"] = inline.length;

const oa = acc.leaves.filter((l) => l === "oa" || l.startsWith("oa ")).length;
const mcpSrc = readFileSync(join(root, "src", "mcp", "mcp-tools.js"), "utf8");
const tools = [...mcpSrc.matchAll(/registerTool\(\s*"([\w-]+)"/g)].map((m) => m[1]);

const result = {
    commands: acc.leaves.length,
    personalCommands: acc.leaves.length - oa,
    oaCommands: oa,
    groups: acc.containers.length,
    mcpTools: tools.length,
    mcpToolNames: tools,
    perGroup,
};

if (process.argv.includes("--tests")) {
    const r = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8", shell: true });
    const out = `${r.stdout}\n${r.stderr}`;
    // TAP prints `# tests 5906`; the spec reporter (Node's default on newer versions) prints `ℹ tests 5906`.
    const pick = (k) => Number(out.match(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`, "m"))?.[1] ?? NaN);
    result.offlineTests = { tests: pick("tests"), pass: pick("pass"), fail: pick("fail"), skipped: pick("skipped") };
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
} else {
    console.log(`CLI commands (invokable leaves): ${result.commands} (${result.personalCommands} personal + ${oa} OA)`);
    console.log(`Command groups (containers):     ${result.groups}`);
    console.log(`MCP tools:                       ${result.mcpTools}`);
    console.log(`  ${tools.join(", ")}`);
    console.log("Per group:");
    for (const [g, n] of Object.entries(perGroup).sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(22)} ${n}`);
    if (result.offlineTests) {
        const t = result.offlineTests;
        console.log(`Offline tests: ${t.tests} (${t.pass} pass, ${t.fail} fail, ${t.skipped} skipped)`);
    }
}
