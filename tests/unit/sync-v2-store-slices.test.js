/**
 * Storing a decoded chunk hands the event loop back by time, not only by row count (src/core/sync-v2/index.js
 * `writeInSlices`). A chunk can carry tens of thousands of rows; 500 rows a transaction was the only bound, and on a
 * slow disk one slice held the loop for seconds, long enough for Zalo's acks to be declared missing.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { STORE_SLICE, STORE_SLICE_MS, writeInSlices } from "../../src/core/sync-v2/index.js";

before(() => assertSandboxed(CONFIG_DIR));

/** A clock that moves only when a row is written, `msPerRow` per row. */
function slowRows(msPerRow) {
    let t = 0;
    const slices = [];
    let pauses = 0;
    return {
        slices,
        pauses: () => pauses,
        now: () => t,
        pause: async () => void pauses++,
        write: (from, end, deadline) => {
            let at = from;
            for (; at < end; at++) {
                if (at > from && t >= deadline) break;
                t += msPerRow;
            }
            slices.push(at - from);
            return at;
        },
    };
}

describe("writeInSlices", () => {
    it("cuts a slice once it has held the loop for its time, and hands the loop back between slices", async () => {
        // 10 ms a row: a 50 ms budget is 5 rows a slice, far below the 500-row cap.
        const rows = slowRows(10);
        const r = await writeInSlices(23, { ...rows, sliceRows: 500, sliceMs: 50 });
        assert.equal(r.written, 23);
        assert.deepEqual(rows.slices, [5, 5, 5, 5, 3]);
        assert.equal(rows.pauses(), 4, "the loop is handed back between every two slices");
    });

    it("still caps a fast slice at its row count", async () => {
        const rows = slowRows(0);
        await writeInSlices(1200, { ...rows, sliceRows: 500, sliceMs: 50 });
        assert.deepEqual(rows.slices, [500, 500, 200]);
    });

    it("always writes at least one row a slice, however slow a row is", async () => {
        const rows = slowRows(1000);
        const r = await writeInSlices(3, { ...rows, sliceMs: 50 });
        assert.equal(r.written, 3);
        assert.deepEqual(rows.slices, [1, 1, 1]);
    });

    it("stops before the next slice when the run is cancelled, keeping what was written", async () => {
        const rows = slowRows(10);
        let calls = 0;
        const r = await writeInSlices(100, { ...rows, sliceMs: 50, aborted: () => ++calls > 2 });
        assert.equal(r.written, 10);
    });

    it("defaults: 500 rows or 50 ms a slice", () => {
        assert.equal(STORE_SLICE, 500);
        assert.equal(STORE_SLICE_MS, 50);
    });
});
