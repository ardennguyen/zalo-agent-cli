/**
 * A small pool of decode workers (./decode-worker.js), two by default.
 *
 * Each task is one downloaded batch; it goes to the worker with the fewest tasks in hand. A worker that dies, or
 * whose codecs cannot load, fails its tasks: the caller then decodes on the main thread (./decode.js), so a broken
 * worker slows a restore down instead of losing anything.
 */
import { Worker } from "node:worker_threads";

/** Decode workers a restore starts unless told otherwise. */
export const DEFAULT_DECODE_WORKERS = 2;

/**
 * @param {object} opts
 * @param {number} [opts.size=2] - workers
 * @param {object} [opts.assets] - the cached decryption assets (./assets.js `ensureAssets`)
 * @param {URL|string} [opts.workerUrl] - the worker's entry: ./decode-worker.js unless a test brings its own (one that
 *   runs ./decode-worker-core.js with stand-in codecs)
 * @param {object} [opts.workerData] - more for the worker, beside `assets` (tests only)
 * @param {(m: string) => void} [opts.log]
 * @returns {{decode: (blob: Uint8Array, ctx: object, cls: "M"|"C") => Promise<{sessionRecord: Uint8Array|null,
 *   objs: object[]}>, broken: () => boolean, close: () => Promise<void>}}
 */
export function createDecodePool({
    size = DEFAULT_DECODE_WORKERS,
    assets,
    workerUrl = new URL("./decode-worker.js", import.meta.url),
    workerData = {},
    log = () => {},
} = {}) {
    const workers = [];
    let nextId = 0;
    let broken = false;
    let closed = false;

    const fail = (w, why) => {
        if (!broken) log(`decode worker stopped (${why}); decoding on the main thread`);
        broken = true;
        for (const { reject } of w.pending.values()) reject(new Error(`decode worker stopped: ${why}`));
        w.pending.clear();
    };

    const start = () => {
        const worker = new Worker(workerUrl, { workerData: { ...workerData, assets } });
        const w = { worker, pending: new Map() };
        worker.on("message", ({ id, ok, out, error }) => {
            const p = w.pending.get(id);
            if (!p) return;
            w.pending.delete(id);
            if (!w.pending.size) worker.unref();
            if (ok) p.resolve(out);
            else p.reject(new Error(error));
        });
        worker.on("error", (e) => fail(w, e?.message || String(e)));
        worker.on("exit", (code) => {
            if (!closed) fail(w, `exit ${code}`);
        });
        // An idle worker never keeps the process alive; one with a task in hand does.
        worker.unref();
        return w;
    };

    return {
        decode(blob, ctx, cls) {
            if (broken || closed) return Promise.reject(new Error("decode pool unavailable"));
            if (workers.length < Math.max(1, size)) workers.push(start());
            const w = workers.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                if (!w.pending.size) w.worker.ref();
                w.pending.set(id, { resolve, reject });
                try {
                    w.worker.postMessage({ id, blob, ctx, cls });
                } catch (e) {
                    w.pending.delete(id);
                    reject(e);
                }
            });
        },
        broken: () => broken,
        async close() {
            closed = true;
            await Promise.allSettled(workers.map((w) => w.worker.terminate()));
            for (const w of workers) {
                for (const { reject } of w.pending.values()) reject(new Error("decode pool closed"));
                w.pending.clear();
            }
            workers.length = 0;
        },
    };
}
