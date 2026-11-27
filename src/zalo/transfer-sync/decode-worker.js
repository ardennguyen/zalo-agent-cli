/**
 * A decode worker: decrypts, decompresses and protobuf-decodes transfer-sync batches off the main thread, so a
 * session of tens of thousands of messages never holds the event loop (and the socket's pings) while it decodes.
 *
 * Started by ./decode-pool.js with `workerData.assets`, the cached decryption assets (./assets.js `ensureAssets`),
 * which it loads with `loadCodecs`. The work itself is ./decode-worker-core.js. Storing stays on the main thread: the
 * database has one writer.
 */
import { workerData } from "node:worker_threads";
import { loadCodecs } from "./assets.js";
import { runDecodeWorker } from "./decode-worker-core.js";

runDecodeWorker(() => loadCodecs(workerData.assets));
