/**
 * The kick marker (src/core/kick-marker.js): what `fleet status` reads to say an account was kicked, not stopped.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { clearKickMarker, kickFile, readKickMarker, writeKickMarker } from "../../src/core/kick-marker.js";

describe("kick marker", () => {
    let dir;
    before(() => {
        assertSandboxed(CONFIG_DIR);
        dir = mkdtempSync(join(tmpdir(), "zalo-kick-"));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("round-trips a kick and forgets it", () => {
        const file = kickFile(dir);
        assert.equal(readKickMarker(file), null);
        assert.equal(writeKickMarker(file, { via: "error-600", reason: { kickoutSrc: 2 }, at: 5 }), true);
        assert.deepEqual(readKickMarker(file), { at: 5, via: "error-600", reason: { kickoutSrc: 2 } });
        clearKickMarker(file);
        assert.equal(readKickMarker(file), null);
        clearKickMarker(file); // twice is fine
    });

    it("reads a damaged marker as none", () => {
        const file = join(dir, "bad.json");
        writeFileSync(file, "{not json");
        assert.equal(readKickMarker(file), null);
        writeFileSync(file, JSON.stringify({ at: 1 }));
        assert.equal(readKickMarker(file), null);
    });

    it("never throws when it cannot write", () => {
        const blocker = join(dir, "a-file");
        writeFileSync(blocker, "x");
        assert.equal(writeKickMarker(join(blocker, "k.json"), { via: "x" }), false);
    });
});
