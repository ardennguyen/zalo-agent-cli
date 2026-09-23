/**
 * Static guards on how src/commands/sync.js may touch the socket.
 *
 * zca-js's stop() resets the listener synchronously, and the socket's onclose
 * resets it AGAIN later, after stop() has returned. So a stage that stops the
 * listener and a later one that restarts it race: the late reset nulls the new
 * socket and every send after it is a silent no-op. `zalo-agent sync` avoids
 * that by opening one socket window for all socket stages -- a rule that only
 * holds while nothing else in the file starts a listener of its own.
 *
 * The file had three hand-copied connect handshakes before this. Same
 * technique as tests/unit/zca-api-surface.test.js: read the source, fail the
 * build on a pattern the offline suite cannot otherwise reach.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "sync.js"), "utf8");

/** Name of the function each line sits in, by nearest preceding declaration. */
function enclosingFunction(lineIdx, lines) {
    for (let i = lineIdx; i >= 0; i--) {
        const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (m) return m[1];
    }
    return "(module)";
}

describe("sync.js socket rules", () => {
    const lines = SRC.split("\n");

    it("starts a listener in exactly one place: connectListener", () => {
        const sites = lines
            .map((l, i) => (/listener\.start\(/.test(l) ? enclosingFunction(i, lines) : null))
            .filter(Boolean);
        assert.deepEqual(sites, ["connectListener"], `listener.start() found in: ${sites.join(", ")}`);
    });

    it("the unified run never calls a run* command body, which would end the process", () => {
        const start = lines.findIndex((l) => /^async function runUnifiedSync\b/.test(l));
        assert.ok(start >= 0, "runUnifiedSync must exist");
        let end = lines.findIndex((l, i) => i > start && /^(?:async\s+)?function\s+\w+/.test(l));
        if (end < 0) end = lines.length;
        const body = lines.slice(start + 1, end).join("\n");
        const calls = [...body.matchAll(/\b(run[A-Z]\w*)\s*\(/g)].map((m) => m[1]).filter((n) => n !== "runs");
        assert.deepEqual(calls, [], `runUnifiedSync calls: ${calls.join(", ")}`);
    });

    it("the unified run stops the socket once, through closeListener", () => {
        const start = lines.findIndex((l) => /^async function runUnifiedSync\b/.test(l));
        let end = lines.findIndex((l, i) => i > start && /^(?:async\s+)?function\s+\w+/.test(l));
        if (end < 0) end = lines.length;
        const body = lines.slice(start + 1, end).join("\n");
        assert.equal((body.match(/listener\.stop\(/g) || []).length, 0, "stop via closeListener only");
        assert.equal((body.match(/closeListener\(/g) || []).length, 1);
    });
});
