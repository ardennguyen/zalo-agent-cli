/**
 * The body of a decode worker (./decode-worker.js): answers `{id, blob, ctx, cls}` with the decoded batch, using the
 * codecs `loadCodecs()` gives. Kept apart from the worker's entry so a test can start the same body with stand-in
 * codecs from an entry of its own.
 *
 * Message in: `{id, blob, ctx, cls}` (see ./decode.js `decodeBatch`). Message out: `{id, ok: true, out}` or
 * `{id, ok: false, error}`.
 */
import { parentPort } from "node:worker_threads";
import { decodeBatch } from "./decode.js";

/**
 * Serve decode tasks on this worker thread.
 *
 * @param {() => Promise<{zproto: object, M: object, C: object}>} loadCodecs
 */
export function runDecodeWorker(loadCodecs) {
    const codecsReady = Promise.resolve().then(loadCodecs);
    // A worker whose codecs cannot load answers every task with the error; the pool then decodes on the main thread.
    codecsReady.catch(() => {});
    parentPort.on("message", async ({ id, blob, ctx, cls }) => {
        try {
            const codecs = await codecsReady;
            const out = decodeBatch(blob, ctx, codecs, cls);
            parentPort.postMessage({ id, ok: true, out });
        } catch (e) {
            parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
        }
    });
}
