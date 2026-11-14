/**
 * `account devices`: which companion entry is this CLI, and a list a person can read (no raw JSON, no identity
 * material).
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeDevices, summarizeCompanion } from "../../src/core/account-devices.js";

const DEVICES = {
    masterId: "aa11",
    lastUpdateTs: 1_790_000_000_000,
    companions: [
        {
            id: 4,
            linkId: "9000000000000000001",
            platform: 2,
            status: 1,
            expireTs: 0,
            encIdentity: "SECRET-A",
            encAccSign: "SECRET-B",
        },
        {
            id: 10,
            linkId: "9000000000000000002",
            platform: 1,
            status: 1,
            expireTs: 1_800_000_000_000,
            encIdentity: "SECRET-C",
        },
    ],
};

describe("summarizeCompanion", () => {
    it("marks the entry whose id is the saved companion id, whatever its type", () => {
        assert.equal(summarizeCompanion(DEVICES.companions[0], { companionId: 4 }).thisClient, true);
        assert.equal(summarizeCompanion(DEVICES.companions[0], { companionId: "4" }).thisClient, true);
        assert.equal(summarizeCompanion(DEVICES.companions[1], { companionId: 4 }).thisClient, false);
        assert.equal(summarizeCompanion(DEVICES.companions[0], {}).thisClient, false);
        assert.equal(summarizeCompanion(DEVICES.companions[0], { companionId: null }).thisClient, false);
    });

    it("reads a zero expiry as no expiry and keeps no identity material", () => {
        const s = summarizeCompanion(DEVICES.companions[0], {});
        assert.equal(s.expires, null);
        assert.equal(summarizeCompanion(DEVICES.companions[1], {}).expires, 1_800_000_000_000);
        assert.deepEqual(Object.keys(s).sort(), ["expires", "id", "platform", "platformName", "status", "thisClient"]);
    });
});

describe("describeDevices", () => {
    it("lists each companion on one line, says which is this CLI, and prints no identity material", () => {
        const text = describeDevices(DEVICES, { companionId: 10 }).join("\n");
        assert.match(text, /Primary device \(the phone\): aa11/);
        assert.match(text, /Linked companion devices \(2\)/);
        assert.match(text, /#4, platform 2, active, no expiry\n/);
        assert.match(text, /#10, platform 1, active, expires .*<- this CLI/);
        assert.doesNotMatch(text, /SECRET|9000000000000000001/);
    });

    it("says when the saved identity is not in the list, and when no device data came back", () => {
        const gone = describeDevices({ ...DEVICES, companions: [DEVICES.companions[0]] }, { companionId: 10 }).join(
            "\n",
        );
        assert.match(gone, /saved companion identity is not in the list/);
        assert.deepEqual(describeDevices(null), ["No device data returned."]);
        assert.match(describeDevices({ masterId: "x", companions: [] }).join("\n"), /No companion devices/);
    });
});
