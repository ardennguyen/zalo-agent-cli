/**
 * The agent rule files: `AGENTS.md`, `CLAUDE.md`, `.clinerules` and `.cursor/rules/project.mdc` are four copies of one text,
 * each read by a different tool, and Google Antigravity silently drops the tail of any rule file past 24,000 bytes.
 * AGENTS.md says so itself, and until this test nothing enforced either rule: a hand edit of one copy, or a rule that
 * pushed the file over the limit, would have passed the gate and failed only in a tool nobody was watching.
 *
 * It also holds the MCP tool list in AGENTS.md (section 10) to `src/mcp/mcp-tools.js`, as that section demands.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COPIES = ["AGENTS.md", "CLAUDE.md", ".clinerules", ".cursor/rules/project.mdc"];
/** Antigravity's cutoff: a file of this size or more loses its tail. */
const LIMIT = 24_000;

const bytes = (f) => readFileSync(join(ROOT, f));
const sha = (b) => createHash("sha256").update(b).digest("hex");

describe("the agent rule files", () => {
    it("are four byte-identical copies of AGENTS.md", () => {
        const want = sha(bytes("AGENTS.md"));
        const odd = COPIES.filter((f) => sha(bytes(f)) !== want);
        assert.deepEqual(odd, [], `copy over AGENTS.md: ${odd.join(", ")}`);
    });

    it(`are under ${LIMIT} bytes, the size at which Antigravity starts to truncate`, () => {
        for (const f of COPIES) {
            const n = bytes(f).length;
            assert.ok(n < LIMIT, `${f} is ${n} bytes, ${n - LIMIT + 1} over the limit`);
        }
    });

    it("name exactly the MCP tools that src/mcp/mcp-tools.js defines", () => {
        const source = readFileSync(join(ROOT, "src/mcp/mcp-tools.js"), "utf8");
        const defined = [
            ...new Set([...source.matchAll(/registerTool\(\s*"(zalo_[a-z_]+)"/g)].map((m) => m[1])),
        ].sort();
        assert.ok(defined.length >= 20, `found only ${defined.length} tools in the source`);
        const rules = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
        const named = [...new Set([...rules.matchAll(/`(zalo_[a-z_]+)`/g)].map((m) => m[1]))].sort();
        assert.deepEqual(named, defined, "the tool list in AGENTS.md section 10 differs from mcp-tools.js");
    });
});
