/**
 * A decode worker entry with the fake phone's stand-in codecs (./phone.js `fakeCodecs`): the engine's own worker body
 * (src/zalo/transfer-sync/decode-worker-core.js), which a test cannot hand functions to. `workerData.decryptDelayMs`
 * makes every message decrypt take that long; `workerData.failToLoad` makes the codecs fail to load.
 */
import { workerData } from "node:worker_threads";
import { runDecodeWorker } from "../../../src/zalo/transfer-sync/decode-worker-core.js";
import { fakeCodecs } from "./phone.js";

runDecodeWorker(async () => {
    if (workerData?.failToLoad) throw new Error("no codecs here");
    return fakeCodecs({ decryptDelayMs: Number(workerData?.decryptDelayMs) || 0 });
});
