/**
 * transfer-sync-v2 crypto/codec assets.
 *
 * Zalo Web decrypts sync batches with a wasm-bindgen module (`libzproto`) and
 * decodes them with google-protobuf ("jspb") message classes, both shipped in
 * its public web bundle. Rather than vendor Zalo's proprietary binary into this
 * package, we fetch those pieces from Zalo's own CDN on first use and cache the
 * extracted modules locally (they are ~350 KB total and change only when Zalo
 * ships a new web build). Everything runs in-process in Node — no browser.
 *
 * Pipeline these assets serve (see src/core/sync-v2/index.js):
 *   msgUrl bytes -> [u32 LE len][payload] chunk -> zproto decrypt
 *     (metadata: it.j(chunk, ikPub, ikPriv, ekPriv) -> sessionRecord + plaintext;
 *      message:  it.i(chunk, sessionRecord) -> plaintext)
 *   -> Zstd (node:zlib) -> protobuf SyncChunk.
 */
import fs from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const APP_ORIGIN = "https://chat.zalo.me";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36";

/** Extract one webpack module body `"<id>":function(A,e,t){...}` (or `<id>:function…`) by brace matching. */
function extractModule(src, id) {
    let start = src.indexOf(`"${id}":function(`);
    let sliceFrom = start;
    if (start < 0) {
        start = src.indexOf(`${id}:function(`);
        sliceFrom = start;
    }
    if (start < 0) throw new Error(`webpack module ${id} not found (Zalo web build changed?)`);
    const braceStart = src.indexOf("{", src.indexOf("function(", start));
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return src.slice(sliceFrom, i + 1);
        }
    }
    throw new Error(`webpack module ${id} not brace-balanced`);
}

async function fetchText(url) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return r.text();
}
async function fetchBytes(url) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

/**
 * Ensure the extracted assets exist under `cacheDir`, fetching from the CDN
 * once and caching by the web build's worker hash. Returns absolute paths.
 *
 * @param {string} cacheDir
 * @param {(m: string) => void} [log]
 * @returns {Promise<{dir: string, wasm: string, glue: string, pbMsg: string, pbConv: string}>}
 */
export async function ensureAssets(cacheDir, log = () => {}) {
    // Discover the sync-v2 worker filename from the app shell.
    const html = await fetchText(`${APP_ORIGIN}/`);
    const wm = /__SRC_SYNC_V2_WORKER__\s*=\s*'([^']+)'/.exec(html) || /(sync-v2-worker\.[0-9a-f]+\.js)/.exec(html);
    if (!wm) throw new Error("could not locate sync-v2 worker in Zalo web shell");
    const workerFile = wm[1];
    const hash = (/\.([0-9a-f]{6,})\.js$/.exec(workerFile) || [, "unknown"])[1];
    const dir = resolve(cacheDir, hash);
    const paths = {
        dir,
        wasm: resolve(dir, "libzproto_bg.wasm"),
        glue: resolve(dir, "vox7.glue.js"),
        pbMsg: resolve(dir, "pb.message.js"),
        pbConv: resolve(dir, "pb.conversation.js"),
    };
    if (
        fs.existsSync(paths.wasm) &&
        fs.existsSync(paths.glue) &&
        fs.existsSync(paths.pbMsg) &&
        fs.existsSync(paths.pbConv)
    )
        return paths;

    log(`fetching transfer-sync-v2 assets (build ${hash}) from ${APP_ORIGIN}…`);
    fs.mkdirSync(dir, { recursive: true });
    const worker = await fetchText(`${APP_ORIGIN}/${workerFile}`);
    // The libzproto glue module id used by Zalo web is "Vox7"; message/conversation protobufs are "1y5R"/"Ho1Y".
    fs.writeFileSync(paths.glue, extractModule(worker, "Vox7"));
    fs.writeFileSync(paths.pbMsg, extractModule(worker, "1y5R"));
    fs.writeFileSync(paths.pbConv, extractModule(worker, "Ho1Y"));
    const wasmRef = /libs\/libzproto_wasm_bg\.[0-9a-f]+\.wasm/.exec(worker);
    if (!wasmRef) throw new Error("could not locate libzproto wasm filename in worker");
    fs.writeFileSync(paths.wasm, await fetchBytes(`${APP_ORIGIN}/${wasmRef[0]}`));
    log(`cached sync-v2 assets in ${dir}`);
    return paths;
}

function stripModulePrefix(src, id) {
    src = src.trim();
    if (src.startsWith(`"${id}":`)) return src.slice(`"${id}":`.length);
    if (src.startsWith(`${id}:`)) return src.slice(`${id}:`.length);
    return src;
}

/** Minimal webpack __webpack_require__ shim covering what these modules use. */
function makeRequire(extra) {
    const t = (id) => {
        if (id === "yLpj") return globalThis; // webpack global helper
        if (id === "3UD+") return (m) => m; // wasm default-path helper (unused; we pass bytes)
        if (id === "hRO2") return require("google-protobuf"); // jspb + goog runtime
        if (id === "N3ek") return {}; // base proto namespace
        if (extra && extra[id]) return extra[id];
        throw new Error(`sync-v2 asset required an unmocked webpack module: ${id}`);
    };
    t.d = (e, name, getter) => {
        if (!Object.prototype.hasOwnProperty.call(e, name))
            Object.defineProperty(e, name, { enumerable: true, get: getter });
    };
    t.r = () => {};
    t.n = (m) => () => m;
    t.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    return t;
}

function runModule(srcFile, id) {
    const src = stripModulePrefix(fs.readFileSync(srcFile, "utf8"), id);
    const factory = (0, eval)("(" + src + ")");
    const mod = { exports: {} };
    factory(mod, mod.exports, makeRequire());
    return mod.exports;
}

/**
 * Load the crypto (WASM) + protobuf codecs from cached assets.
 *
 * @param {{wasm: string, glue: string, pbMsg: string, pbConv: string}} paths
 * @returns {Promise<{zproto: object, M: object, C: object}>}
 */
export async function loadCodecs(paths) {
    // ---- libzproto WASM via the Vox7 wasm-bindgen glue ----
    const it = runModule(paths.glue, "Vox7");
    await it.b(fs.readFileSync(paths.wasm)); // e.b = init(module_or_path); accepts raw bytes
    const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
    const zproto = {
        generateKeyPair() {
            const a = it.e();
            const out = { publicKey: Buffer.from(a.publicKey.slice()), privateKey: Buffer.from(a.privateKey.slice()) };
            a.free();
            return out;
        },
        decryptMetadata(metaChunk, ikPub, ikPriv, ekPriv) {
            const r = it.j(u8(metaChunk), u8(ikPub), u8(ikPriv), u8(ekPriv));
            const out = {
                plaintext: Buffer.from(r.plaintext.slice()),
                sessionRecord: Buffer.from(r.sessionRecord.slice()),
            };
            r.free();
            return out;
        },
        decryptMessage(msgChunk, sessionRecord) {
            const r = it.i(u8(msgChunk), u8(sessionRecord));
            const out = { plaintext: Buffer.from(r.plaintext.slice()) };
            r.free();
            return out;
        },
    };

    // ---- protobuf (jspb) codecs; they register on a global `proto` namespace ----
    if (!globalThis.proto) globalThis.proto = {};
    runModule(paths.pbMsg, "1y5R");
    runModule(paths.pbConv, "Ho1Y");
    const M = globalThis.proto?.Sync2?.Message;
    const C = globalThis.proto?.Sync2?.Conversation;
    if (!M?.SyncChunk || !C?.SyncChunk) throw new Error("sync-v2 protobuf codecs failed to load");
    return { zproto, M, C };
}
