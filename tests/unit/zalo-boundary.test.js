/**
 * src/zalo is a library the application uses, never the other way round.
 *
 * Everything that speaks Zalo's protocol lives in src/zalo, and src/zalo is meant to stand on its own: nothing in
 * it may import the CLI (src/core, src/utils, src/commands, src/mcp, src/index.js). The caller hands in what is its
 * own instead -- paths, a proxy, a logger, the answers of the local reads. The ESLint rule scoped to src/zalo/**
 * says the same for static imports; this walks every file and also catches `export ... from`, a dynamic
 * `import("...")`, and a dynamic import whose target cannot be read (which could lead anywhere).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as acorn from "acorn";
import { jsFiles, walkAst } from "../helpers/api-call-sites.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const ZALO = join(SRC, "zalo");

/**
 * Every module specifier a source text imports or re-exports, with `null` for a dynamic import whose target is not
 * a string literal.
 *
 * @param {string} src
 * @returns {Array<string|null>}
 */
function specifiersOf(src) {
    const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
    const out = [];
    walkAst(ast, (n) => {
        if (
            n.type === "ImportDeclaration" ||
            n.type === "ExportAllDeclaration" ||
            (n.type === "ExportNamedDeclaration" && n.source)
        ) {
            out.push(n.source.value);
        } else if (n.type === "ImportExpression") {
            out.push(n.source.type === "Literal" && typeof n.source.value === "string" ? n.source.value : null);
        }
    });
    return out;
}

/**
 * What is wrong with one import of a file under src/zalo, or null when it stays inside the layer (or is a package).
 *
 * @param {string} file - absolute path of the importing file
 * @param {string|null} spec
 * @returns {string|null}
 */
function violationOf(file, spec) {
    if (spec === null) return "a dynamic import whose target is not a string literal";
    if (!spec.startsWith(".")) return null; // node: builtins and packages
    const target = resolve(dirname(file), spec);
    const inside = relative(ZALO, target);
    if (!inside.startsWith("..") && !inside.startsWith(sep) && inside !== "index.js") return null;
    const rel = relative(ROOT, target).split(sep).join("/");
    return `imports ${spec} (${rel}), outside src/zalo`;
}

/**
 * Every import of every file under a directory that leaves src/zalo.
 *
 * @param {Array<{file: string, src: string}>} sources
 * @returns {string[]}
 */
function violations(sources) {
    const found = [];
    for (const { file, src } of sources) {
        for (const spec of specifiersOf(src)) {
            const why = violationOf(file, spec);
            if (why) found.push(`${relative(ROOT, file).split(sep).join("/")}: ${why}`);
        }
    }
    return found;
}

describe("src/zalo imports nothing from the application", () => {
    const sources = jsFiles(ZALO).map((file) => ({ file, src: readFileSync(file, "utf8") }));

    it("walks the whole layer", () => {
        // Red if the walk finds nothing (a moved directory, a broken helper): then the check below passes vacuously.
        assert.ok(sources.length > 80, `expected the whole protocol layer, found ${sources.length} files`);
        const imports = sources.reduce((n, s) => n + specifiersOf(s.src).length, 0);
        assert.ok(imports > 200, `expected the layer's own imports, found ${imports}`);
    });

    it("has no import of src/core, src/utils, src/commands, src/mcp or src/index.js", () => {
        assert.deepEqual(violations(sources), []);
    });

    it("loads its public entry on its own", async () => {
        const zalo = await import("../../src/zalo/index.js");
        for (const name of ["createApi", "openSession", "openQrSession", "createListener", "ZaloApiError"]) {
            assert.equal(typeof zalo[name], "function", name);
        }
        assert.equal(typeof zalo.syncChannel.createSyncChannel, "function");
    });

    it("would catch each kind of escape", () => {
        // The detector itself: one planted file per way out. Red if any of them slips through.
        const file = join(ZALO, "api", "planted.js");
        const planted = [
            'import { x } from "../../core/db.js";',
            'export { y } from "../../utils/output.js";',
            'export * from "../../commands/msg.js";',
            'const m = await import("../../mcp/mcp-tools.js");',
            'import "../../index.js";',
            'import { z } from "../index.js";',
            "const n = await import(name);",
        ];
        for (const line of planted) {
            assert.equal(violations([{ file, src: line }]).length, 1, line);
        }
        for (const line of [
            'import { a } from "../kernel/bound.js";',
            'import fs from "node:fs";',
            'import ws from "ws";',
        ]) {
            assert.deepEqual(violations([{ file, src: line }]), [], line);
        }
    });
});
