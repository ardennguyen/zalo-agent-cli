#!/usr/bin/env node
/**
 * Build the published runtime: bundle our own source (everything under src/, reached by relative import) into a
 * minified, node22-targeted ESM bundle under dist/, and keep every third-party package external so npm installs it
 * as usual. The npm package ships dist/ instead of src/ (package.json `files`), so the engine's source is not
 * distributed — only this compiled runtime.
 *
 * Three entry points ({@link ENTRIES}):
 *   - src/index.js                          -> dist/index.js            the CLI/MCP bin (shebang kept)
 *   - src/core/keystore/worker.js           -> dist/keystore-worker.js  the key layer's short-lived child process,
 *                                                                       spawned by dist/index.js via process.execPath
 *   - src/zalo/transfer-sync/decode-worker.js -> dist/decode-worker.js  the sync's decode worker thread, started by
 *                                                                       dist/index.js as `new URL("./decode-worker.js",
 *                                                                       import.meta.url)`
 *
 * A file the bundle loads by a path beside itself must be an entry here, or the published package lacks it (3.6.0
 * shipped without the decode worker, and every restore decoded on the main thread). tests/unit/packaging-dist.test.js
 * builds the bundle and fails on any such path it does not find.
 *
 * Three build-time substitutions (see the matching `typeof … !== "undefined"` guards in source). They matter only in
 * the bundle, where a module no longer sits where it did in src/:
 *   - __ZALO_PKG_VERSION__          the version string (several modules read it from package.json by relative path)
 *   - __ZALO_KEYSTORE_WORKER_NAME__ the worker's filename beside dist/index.js
 *   - __ZALO_CLI_ENTRY_SPEC__       the CLI entry, relative to dist/index.js, that `oa`/`zbs`/`social` re-invoke
 *
 * `--packages=external` leaves every bare import (commander, express, undici, better-sqlite3-multiple-ciphers native
 * addon, google-protobuf loaded via createRequire, the optional KMS SDKs loaded via dynamic import, …) as a runtime
 * import resolved from node_modules — only our relative imports are inlined. No sourcemap is emitted: a sourcemap
 * would carry the original source into the package.
 */
import { build } from "esbuild";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Every file of the runtime: source entry -> file name under dist/. */
export const ENTRIES = Object.freeze([
    { from: "src/index.js", to: "index.js" },
    { from: "src/core/keystore/worker.js", to: "keystore-worker.js" },
    { from: "src/zalo/transfer-sync/decode-worker.js", to: "decode-worker.js" },
]);

const define = {
    __ZALO_PKG_VERSION__: JSON.stringify(pkg.version),
    __ZALO_KEYSTORE_WORKER_NAME__: JSON.stringify("keystore-worker.js"),
    __ZALO_CLI_ENTRY_SPEC__: JSON.stringify("./index.js"),
};

/**
 * Build every entry into `outdir` (emptied first).
 *
 * @param {string} [outdir] - dist/ of this checkout by default; a test builds elsewhere
 * @param {{logLevel?: string}} [opts]
 * @returns {Promise<string[]>} the files written, by name
 */
export async function buildDist(outdir = join(root, "dist"), { logLevel = "info" } = {}) {
    rmSync(outdir, { recursive: true, force: true });
    mkdirSync(outdir, { recursive: true });
    const common = {
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        minify: true,
        packages: "external",
        sourcemap: false,
        legalComments: "none",
        logLevel,
        define,
    };
    // esbuild preserves the entry file's own `#!/usr/bin/env node` shebang (src/index.js line 1) at the top of the
    // bundle, so no banner is added here — a second shebang would land on line 2 and break the ESM parse.
    for (const { from, to } of ENTRIES) {
        await build({ ...common, entryPoints: [join(root, from)], outfile: join(outdir, to) });
    }
    return ENTRIES.map((e) => e.to);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await buildDist();
    console.log(`built dist/ for ${pkg.name}@${pkg.version}`);
}
