#!/usr/bin/env node
/**
 * Build the published runtime: bundle our own source (everything under src/, reached by relative import) into a
 * minified, node22-targeted ESM bundle under dist/, and keep every third-party package external so npm installs it
 * as usual. The npm package ships dist/ instead of src/ (package.json `files`), so the engine's source is not
 * distributed — only this compiled runtime.
 *
 * Two entry points:
 *   - src/index.js               -> dist/index.js            the CLI/MCP bin (shebang kept)
 *   - src/core/keystore/worker.js -> dist/keystore-worker.js  the key layer's short-lived child process, spawned by
 *                                                             dist/index.js via process.execPath
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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const define = {
    __ZALO_PKG_VERSION__: JSON.stringify(pkg.version),
    __ZALO_KEYSTORE_WORKER_NAME__: JSON.stringify("keystore-worker.js"),
    __ZALO_CLI_ENTRY_SPEC__: JSON.stringify("./index.js"),
};

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });

const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    packages: "external",
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    define,
};

// esbuild preserves the entry file's own `#!/usr/bin/env node` shebang (src/index.js line 1) at the top of the
// bundle, so no banner is added here — a second shebang would land on line 2 and break the ESM parse.
await build({
    ...common,
    entryPoints: [join(root, "src/index.js")],
    outfile: join(root, "dist/index.js"),
});

await build({
    ...common,
    entryPoints: [join(root, "src/core/keystore/worker.js")],
    outfile: join(root, "dist/keystore-worker.js"),
});

console.log(`built dist/ for ${pkg.name}@${pkg.version}`);
