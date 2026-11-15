/**
 * The note added when Zalo refuses a user id it does not know (src/core/user-id-hint.js). Offline.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { INVALID_PARAM_CODE, withUserIdHint } from "../../src/core/user-id-hint.js";

before(() => assertSandboxed(SANDBOX_CONFIG_DIR));

const refused = (code = INVALID_PARAM_CODE, message = "Tham số không hợp lệ") =>
    Object.assign(new Error(message), { code });

describe("withUserIdHint", () => {
    it("says how to find the right id when a user conversation is refused as an invalid parameter", () => {
        const text = withUserIdHint(refused(), "1000000000000000001", 0);
        assert.match(text, /^Tham số không hợp lệ\. If 1000000000000000001 is not an id this account knows/);
        assert.match(text, /friend list/);
        // The text alone is enough: a reply from the daemon carries no code.
        assert.match(withUserIdHint(new Error("Send video failed: Tham số không hợp lệ"), "1", 0), /friend list/);
    });

    it("leaves groups and other errors as they are", () => {
        assert.equal(withUserIdHint(refused(), "2000000000000000001", 1), "Tham số không hợp lệ");
        assert.equal(withUserIdHint(refused(-201, "Session expired"), "1", 0), "Session expired");
    });
});
