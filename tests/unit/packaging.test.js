/**
 * The published tarball must carry a *patched* zca-js, on every install path.
 *
 * We patch zca-js (patches/zca-js+2.2.0.patch) to add `logoutV2`,
 * `pullMobileMsg`, `getCrossDB` and `deleteSnapshotMobileMsg`, and to modify
 * `loginQR` and `sendMessage`. Without those, `logout` and `account remove`
 * die on "is not a function" against a real session.
 *
 * Two separate defects have already shipped from this one file:
 *
 * 1. `postinstall: patch-package` with patch-package in devDependencies and
 *    `patches/` missing from `files` -- a consumer install ran a binary that
 *    was not there, against patches that were not shipped, and aborted before
 *    node_modules/zca-js existed.
 * 2. Even once both were fixed, patch-package resolves `node_modules/zca-js`
 *    relative to its own cwd. On a global install npm nests zca-js under our
 *    package and that works; installed as a *dependency* npm hoists zca-js to
 *    the consumer's root, patch-package cannot see it, and the install still
 *    exits 0 -- so the patch silently did nothing.
 *
 * The fix is to stop patching in the consumer's tree at all: `prepare` applies
 * the patch here, and `bundleDependencies` ships that patched copy inside the
 * tarball. These assertions pin the parts of that arrangement which are easy
 * to undo by accident and which nothing else would catch until someone ran
 * `logout` against a real account.
 *
 * Offline and static -- reads package.json and the patches/ directory only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Package names under patches/, mapped to the exact version each patch is stamped for. */
function patchedPackages() {
    const dir = join(ROOT, "patches");
    if (!existsSync(dir)) return new Map();
    const found = new Map();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".patch"))) {
        // patch-package names files "<package>+<version>.patch", scopes as "@scope+name".
        const m = /^(.+)\+(\d+\.\d+\.\d+.*)\.patch$/.exec(file);
        if (m) found.set(m[1].replace(/^(@[^+]+)\+/, "$1/"), m[2]);
    }
    return found;
}

/** The first word of each `&&`/`;`-separated segment of a script -- i.e. the binaries it runs. */
function binariesInvokedBy(script) {
    return script
        .split(/&&|\|\||;/)
        .map((segment) => segment.trim().split(/\s+/)[0])
        .filter(Boolean);
}

/** Paths inside zca-js that the patch touches, and which of them it creates. */
function patchedPaths() {
    const file = join(ROOT, "patches", "zca-js+2.2.0.patch");
    if (!existsSync(file)) return { touched: [], created: [] };
    const touched = [];
    const created = [];
    // Split on the per-file headers rather than matching across lines: each
    // block is one file, and "new file mode" inside it means the patch
    // creates that file rather than editing it.
    for (const block of readFileSync(file, "utf8")
        .split(/^diff --git /m)
        .slice(1)) {
        const m = /^a\/node_modules\/zca-js\/(\S+) /.exec(block);
        if (!m) continue;
        touched.push(m[1]);
        if (/^new file mode /m.test(block)) created.push(m[1]);
    }
    return { touched, created };
}

describe("packaging: the patched zca-js must reach consumers", () => {
    it("pins every patched package to an exact version", () => {
        for (const [name, version] of patchedPackages()) {
            const range = pkg.dependencies[name] ?? pkg.devDependencies[name];
            assert.ok(range, `${name} has a patch but is not a dependency`);
            assert.equal(
                range,
                version,
                `${name} is declared as "${range}" but patches/ only carries ${version}. ` +
                    `patch-package matches by FILENAME, so any other resolution is silently unpatched.`,
            );
        }
    });

    it("ships a patch file for the exact version of zca-js it depends on", () => {
        const patches = patchedPackages();
        assert.ok(patches.has("zca-js"), "patches/zca-js+<version>.patch is missing");
        assert.equal(patches.get("zca-js"), pkg.dependencies["zca-js"]);
    });

    it("bundles every patched runtime dependency into the tarball", () => {
        const bundled = new Set(pkg.bundleDependencies ?? pkg.bundledDependencies ?? []);
        for (const name of patchedPackages().keys()) {
            if (!pkg.dependencies[name]) continue; // dev-only patches never reach consumers
            assert.ok(
                bundled.has(name),
                `${name} is patched but not in bundleDependencies. Unbundled, npm hoists it into ` +
                    `the consumer's tree and they get the UNPATCHED published copy.`,
            );
        }
    });

    it("declares everything it bundles as a real dependency", () => {
        for (const name of pkg.bundleDependencies ?? []) {
            assert.ok(pkg.dependencies[name], `${name} is bundled but not in dependencies -- npm will not pack it`);
        }
    });

    it("applies patches in prepare, so the bundled copy is patched before packing", () => {
        assert.equal(
            pkg.scripts.prepare,
            "patch-package",
            "prepare must run patch-package: it is what guarantees node_modules/zca-js is patched " +
                "before npm pack reads it for bundleDependencies.",
        );
    });

    it("runs no install script that a consumer would need a devDependency for", () => {
        // An install script runs in the CONSUMER's tree, where devDependencies do not exist.
        for (const phase of ["preinstall", "install", "postinstall"]) {
            const script = pkg.scripts[phase];
            if (!script) continue;
            for (const binary of binariesInvokedBy(script)) {
                if (binary === "node" || binary === "npm") continue;
                assert.ok(
                    pkg.dependencies[binary],
                    `scripts.${phase} runs "${binary}", which is not in dependencies. ` +
                        `Consumers do not install devDependencies, so their install would fail.`,
                );
            }
        }
    });

    it("ships patches/ in files, so the git install path can still apply them", () => {
        // `npm i github:ardennguyen/zalo-agent-cli` (zalo-mcp.ps1/.sh) packs from a clone and
        // runs prepare, which needs the patch files to be present.
        assert.ok(pkg.files.includes("patches/"), "files must include patches/");
    });
    // zca-js ships two builds and its exports map sends `require()` to the CJS
    // one. We load the ESM tree, so for a long time only that half was
    // patched -- leaving a library whose two entry points disagreed about
    // whether `logoutV2` exists. These pin the halves back together.

    it("patches both of zca-js's builds, not just the one we load", () => {
        const { touched } = patchedPaths();
        const esm = touched
            .filter((p) => /^dist\/apis\/[\w$]+\.js$/.test(p))
            .map((p) => p.replace(/^dist\/apis\/|\.js$/g, ""));
        const cjs = new Set(
            touched
                .filter((p) => /^dist\/cjs\/apis\/[\w$]+\.cjs$/.test(p))
                .map((p) => p.replace(/^dist\/cjs\/apis\/|\.cjs$/g, "")),
        );
        assert.ok(esm.length > 0, "the patch stopped touching dist/apis -- has zca-js restructured?");
        assert.deepEqual(
            esm.filter((n) => !cjs.has(n)),
            [],
            "these APIs are patched in zca-js's ESM build but not its CJS one, so require() gets the unpatched code",
        );
        assert.ok(
            touched.includes("dist/apis.js") && touched.includes("dist/cjs/apis.cjs"),
            "both barrels must be patched, or the added methods are never wired onto the API class",
        );
    });

    it("adds the four extra methods to both builds", () => {
        const { created } = patchedPaths();
        for (const m of ["logoutV2", "pullMobileMsg", "getCrossDB", "deleteSnapshotMobileMsg"]) {
            assert.ok(created.includes(`dist/apis/${m}.js`), `the patch no longer creates the ESM ${m}`);
            assert.ok(
                created.includes(`dist/cjs/apis/${m}.cjs`),
                `the patch no longer creates the CJS ${m} -- require("zca-js") would lack it`,
            );
        }
    });

    it("stays ESM, so the bundled zca-js resolves through its default condition", () => {
        assert.equal(
            pkg.type,
            "module",
            'this package stopped being "type": "module" -- zca-js would now resolve through its CJS build, ' +
                "which must therefore stay patched (see the two assertions above)",
        );
    });
});
