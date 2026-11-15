/**
 * When a login fetches the zCloud key (src/core/cloud-key-setup.js): only for an account that has something the key
 * opens. Offline.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloudKeyWanted } from "../../src/core/cloud-key-setup.js";

describe("cloud key setup — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(SANDBOX_CONFIG_DIR));
});

describe("cloudKeyWanted", () => {
    it("wants the key on a zCloud plan or in its grace period", () => {
        assert.equal(cloudKeyWanted({ planCode: 0, usageBytes: 0 }), true);
        assert.equal(cloudKeyWanted({ planCode: 100, usageBytes: 0 }), true);
    });

    it("wants it after the plan lapsed while files are still kept, and not on a free account that never used zCloud", () => {
        assert.equal(cloudKeyWanted({ planCode: 69, usageBytes: 1024 }), true);
        assert.equal(cloudKeyWanted({ planCode: -1, usageBytes: 0 }), false);
        assert.equal(cloudKeyWanted({ planCode: -1, usageBytes: null }), false);
    });

    it("treats an unreadable answer as no", () => {
        assert.equal(cloudKeyWanted(null), false);
        assert.equal(cloudKeyWanted({}), false);
    });
});
