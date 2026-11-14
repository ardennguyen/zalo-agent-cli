/**
 * The published package carries its own protocol layer, and nothing of the endpoint library it replaced.
 *
 * Until 3.0.0 the package depended on `zca-js`, patched it in `prepare` (patch-package) and shipped the patched copy
 * inside the tarball through `bundleDependencies`. src/zalo/ now answers every call itself, so that whole
 * arrangement is gone, and these assertions keep it gone: a dependency, a bundled copy, a patch step, a `patches/`
 * folder, or a single import of the old library anywhere under src/ or tests/ fails here. A test that still
 * imported it would pass only while the shared node_modules happens to hold a copy, which a clean install no longer
 * does.
 *
 * Offline and static: reads package.json, package-lock.json and the source tree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

/** The library that is gone. Named once, here. */
const GONE = "zca-js";

/** Every dependency table of a package.json. */
const TABLES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Every way a file can load (or name the location of) the library: an import or export `from`, a bare `import`, a
 * dynamic `import()`, `require()` or `require.resolve()`, `import.meta.resolve()`, a JSDoc `import()` type, and a
 * path into `node_modules` (written out, or as `join(..., "node_modules", "<name>")`).
 */
const LOADS = new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*)` +
        String.raw`["'\x60]${GONE}(?:\/[^"'\x60]*)?["'\x60]|node_modules[\\/]+${GONE}\b` +
        String.raw`|["'\x60]node_modules["'\x60]\s*,\s*["'\x60]${GONE}["'\x60]`,
);

/**
 * Every JavaScript file under a folder.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== "node_modules") out.push(...jsFiles(p));
        } else if (/\.(?:c|m)?js$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

describe("packaging: the protocol layer is ours", () => {
    it(`declares no ${GONE} anywhere in package.json`, () => {
        for (const table of TABLES) {
            assert.equal(Object.hasOwn(pkg[table] ?? {}, GONE), false, `${GONE} is in ${table}`);
        }
        assert.deepEqual(pkg.bundleDependencies ?? pkg.bundledDependencies ?? [], [], "nothing is bundled");
        assert.equal((pkg.keywords ?? []).includes(GONE), false, `${GONE} is a keyword`);
    });

    it("has no patch step: no prepare that runs patch-package, no patch-package, no patches/", () => {
        for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
            assert.doesNotMatch(String(script), /patch-package/, `scripts.${name} runs patch-package`);
        }
        for (const table of TABLES) assert.equal(Object.hasOwn(pkg[table] ?? {}, "patch-package"), false, table);
        assert.equal((pkg.files ?? []).includes("patches/"), false, "files must not list patches/");
        assert.equal(existsSync(join(ROOT, "patches")), false, "the patches/ folder is gone");
    });

    it("declares what the protocol layer loads itself: ws and tough-cookie", () => {
        // The socket (src/zalo/listener/listener.js) and the cookie jar (src/zalo/kernel/cookies.js). Red if one
        // were left to arrive only as somebody else's dependency.
        assert.ok(pkg.dependencies.ws, "ws must be a direct dependency");
        assert.ok(pkg.dependencies["tough-cookie"], "tough-cookie must be a direct dependency");
    });

    it(`resolves no ${GONE} in the lock file`, () => {
        const names = Object.keys(lock.packages ?? {}).filter(
            (p) => p === `node_modules/${GONE}` || p.endsWith(`/node_modules/${GONE}`),
        );
        assert.deepEqual(names, [], `package-lock.json still installs ${GONE}`);
        assert.equal(Object.hasOwn(lock.packages?.[""]?.dependencies ?? {}, GONE), false);
    });

    it(`no file under src/ or tests/ loads ${GONE}`, () => {
        const self = join(import.meta.dirname, "packaging.test.js");
        const files = [...jsFiles(join(ROOT, "src")), ...jsFiles(join(ROOT, "tests"))].filter((f) => f !== self);
        // Guards the guard: a walk that found nothing would pass vacuously.
        assert.ok(files.length > 300, `only ${files.length} files found`);
        const offenders = files
            .filter((f) => LOADS.test(readFileSync(f, "utf8")))
            .map((f) => relative(ROOT, f).replace(/\\/g, "/"));
        assert.deepEqual(offenders, [], `these files load ${GONE}`);
    });

    it("the scan catches every way of loading it, and nothing else", () => {
        // Falsifiability: each of these would load the library (or reach into its install), and must be seen.
        for (const line of [
            `import { API } from "${GONE}";`,
            `import "${GONE}";`,
            `export { Zalo } from '${GONE}';`,
            `const { API } = await import("${GONE}");`,
            `const z = require("${GONE}");`,
            `const p = require.resolve("${GONE}");`,
            `const u = new URL(".", import.meta.resolve("${GONE}"));`,
            `/** @param {import("${GONE}").Listener} l */`,
            `import { encodeAES } from "../../node_modules/${GONE}/dist/utils.js";`,
            `const f = join(ROOT, "node_modules", "${GONE}", "dist");`,
            `const d = "node_modules/${GONE}/dist/apis";`,
            `require(join(dirname(require.resolve("${GONE}/package.json")), "utils.cjs"));`,
        ]) {
            assert.match(line, LOADS, line);
        }
        // A word in prose, or another package whose name merely starts the same, is not a load.
        for (const line of [`// the ${GONE} wrapper used to do this`, `import x from "${GONE}-extra";`, `"${GONE}"`]) {
            assert.doesNotMatch(line, LOADS, line);
        }
    });
});
