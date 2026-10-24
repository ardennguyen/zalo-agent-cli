/**
 * The error-number tables (src/zalo/errors.js): what each server code means and
 * what a caller must do about it, instead of a regex over a message.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CLOSE_CODE,
    EXIT_CODE,
    RETRY_KEY,
    RETRY_KEY_NUMBER,
    SOCKET_ERROR,
    classifyServerError,
    errorCodeOf,
} from "../../src/zalo/errors.js";

describe("classifyServerError", () => {
    it("names every code the official clients act on, with what to do about it", () => {
        const expected = {
            70: "maintenance",
            71: "maintenance-notice",
            102: "session-invalid",
            112: "retry",
            210: "invalid-account",
            212: "invalid-account",
            600: "kicked",
            19000: "encryption-off",
            "-69": "stop-retry",
            1001: "up-to-date",
        };
        for (const [code, kind] of Object.entries(expected)) {
            const c = classifyServerError(Number(code));
            assert.equal(c.kind, kind, `code ${code}`);
            assert.equal(c.code, Number(code));
            assert.notEqual(c.name, "UNKNOWN");
        }
    });

    it("reads a numeric string the way a numeric code reads", () => {
        assert.deepEqual(classifyServerError("600"), classifyServerError(600));
        assert.equal(classifyServerError("-69").kind, "stop-retry");
    });

    it("calls a code it does not name unknown, keeping the number, and never guesses a state", () => {
        assert.deepEqual(classifyServerError(5), { code: 5, name: "UNKNOWN", kind: "unknown" });
        for (const none of [undefined, null, "", "  ", "abc", NaN, Infinity, {}]) {
            assert.deepEqual(classifyServerError(none), { code: null, name: "NONE", kind: "unknown" });
        }
    });
});

describe("errorCodeOf", () => {
    it("finds the code however the error carries it", () => {
        assert.equal(errorCodeOf({ code: 600 }), 600);
        assert.equal(errorCodeOf({ error_code: 70 }), 70);
        assert.equal(errorCodeOf({ errorCode: "-69" }), -69);
        assert.equal(errorCodeOf(Object.assign(new Error("x"), { code: 102 })), 102);
    });

    it("returns null for an error with no numeric code, not a guess from the message", () => {
        assert.equal(errorCodeOf(new Error("session 600 revoked")), null);
        assert.equal(errorCodeOf({ code: "ECONNRESET" }), null);
        assert.equal(errorCodeOf({ code: null }), null);
        assert.equal(errorCodeOf(null), null);
        assert.equal(errorCodeOf("600"), null);
    });
});

describe("the tables", () => {
    it("give every socket error code once, in the 5000s apart from the kickout", () => {
        const values = Object.values(SOCKET_ERROR);
        assert.equal(new Set(values).size, values.length, "a socket error code is listed twice");
        assert.equal(SOCKET_ERROR.KICKOUT, 600);
        for (const [name, v] of Object.entries(SOCKET_ERROR)) {
            if (name !== "KICKOUT") assert.ok(v >= 5000 && v < 5100, `${name} = ${v}`);
        }
    });

    it("keep the close codes the policy keys on at their standard values", () => {
        assert.equal(CLOSE_CODE.NORMAL, 1000);
        assert.equal(CLOSE_CODE.ABNORMAL, 1006);
        assert.equal(CLOSE_CODE.NOT_AUTHENTICATED, 3000);
        assert.equal(CLOSE_CODE.KICK_CONNECTION, 3003);
    });

    it("number every named retry key", () => {
        for (const name of [
            "internal",
            "interval_check",
            "cannot_reach_server",
            "no_network",
            "swap_endpoint",
            "system_resume",
        ]) {
            assert.equal(typeof RETRY_KEY_NUMBER[name], "number", name);
        }
        assert.equal(RETRY_KEY.CANNOT_REACH_SERVER, 4001);
        assert.equal(RETRY_KEY.SWAP_ENDPOINT, 4002);
    });

    it("give a kick and a revoked session exit codes a supervisor can tell apart from a crash", () => {
        assert.notEqual(EXIT_CODE.KICKED, EXIT_CODE.SESSION_REVOKED);
        for (const code of Object.values(EXIT_CODE))
            assert.ok(code > 2, `exit code ${code} collides with 1 (error) or 2 (usage)`);
    });
});
