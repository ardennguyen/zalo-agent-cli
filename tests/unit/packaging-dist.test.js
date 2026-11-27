/**
 * The published runtime holds every file it loads by a path beside itself.
 *
 * The package ships dist/ (scripts/build.mjs), not src/. A module that starts a worker or a child process by a path
 * relative to itself (`new URL("./decode-worker.js", import.meta.url)`) finds that file beside the bundle, so the
 * file has to be built there. 3.6.0 built only the CLI and the key worker: an installed engine could not start its
 * decode worker ("Cannot find module …/dist/decode-worker.js"), and every restore decoded on the main thread, which
 * stalled the event loop for seconds at a time.
 *
 * This builds the bundle into a scratch package laid out as npm installs it (package.json, dist/, node_modules), then
 * checks every such path, and starts the decode worker from there.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { ENTRIES, buildDist } from "../../scripts/build.mjs";
import { createDecodePool } from "../../src/zalo/transfer-sync/decode-pool.js";

const ROOT = join(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Every `new URL("<relative>", import.meta.url)` in a built file, as esbuild writes it (minified or not). */
const RELATIVE_URL = /new URL\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;

describe("packaging: the built runtime carries what it loads beside itself", () => {
    let pkgDir;
    let dist;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        pkgDir = mkdtempSync(join(tmpdir(), "zalo-pkg-"));
        dist = join(pkgDir, "dist");
        // As installed: the package's own package.json (it makes dist/*.js ES modules) and its dependencies.
        copyFileSync(join(ROOT, "package.json"), join(pkgDir, "package.json"));
        symlinkSync(join(ROOT, "node_modules"), join(pkgDir, "node_modules"), "junction");
        await buildDist(dist, { logLevel: "silent" });
    });

    after(() => {
        if (pkgDir) rmSync(pkgDir, { recursive: true, force: true });
    });

    it("ships all of dist/", () => {
        assert.ok((pkg.files ?? []).includes("dist/"), "package.json files must list dist/");
        assert.equal(pkg.bin?.["zalo-agent"], "dist/index.js");
    });

    it("builds the decode worker beside the CLI", () => {
        assert.ok(
            ENTRIES.some((e) => e.to === "decode-worker.js"),
            "scripts/build.mjs has no entry for decode-worker.js",
        );
        assert.ok(existsSync(join(dist, "decode-worker.js")), "dist/decode-worker.js was not built");
    });

    it("every file a built module loads by a path beside itself is built", () => {
        const built = readdirSync(dist).filter((f) => f.endsWith(".js"));
        assert.ok(built.includes("index.js"), `built only ${built.join(", ")}`);
        const wanted = [];
        for (const file of built) {
            for (const m of readFileSync(join(dist, file), "utf8").matchAll(RELATIVE_URL)) {
                wanted.push({ from: file, path: m[1] });
            }
        }
        // Guards the guard: the bundle does start its decode worker this way.
        assert.ok(
            wanted.some((w) => w.path === "./decode-worker.js"),
            "the bundle no longer names ./decode-worker.js: update this test",
        );
        const missing = wanted.filter((w) => !existsSync(join(dist, w.path))).map((w) => `${w.from} -> ${w.path}`);
        assert.deepEqual(missing, [], "these paths are loaded from dist/ but not built there");
        // The key worker is found by name, not by a URL (__ZALO_KEYSTORE_WORKER_NAME__).
        assert.ok(existsSync(join(dist, "keystore-worker.js")), "dist/keystore-worker.js was not built");
    });

    it("the installed decode worker starts and answers", async () => {
        // No decryption assets: the worker loads, cannot load its codecs, and answers the task with that error.
        // A worker file that is missing or does not load breaks the pool instead ("decode worker stopped").
        const logs = [];
        const pool = createDecodePool({
            size: 1,
            assets: { dir: join(pkgDir, "no-assets") },
            workerUrl: pathToFileURL(join(dist, "decode-worker.js")),
            log: (m) => logs.push(m),
        });
        try {
            const err = await pool.decode(new Uint8Array(0), { batchType: 1, keys: {} }, "M").then(
                () => null,
                (e) => e,
            );
            assert.ok(err, "a worker without assets cannot have decoded anything");
            assert.doesNotMatch(err.message, /decode worker stopped|Cannot find module/, err.message);
            assert.equal(pool.broken(), false, `the worker died: ${logs.join("; ")}`);
        } finally {
            await pool.close();
        }
    });
});
