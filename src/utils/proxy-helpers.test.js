import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskProxy } from "./proxy-helpers.js";

describe("maskProxy", () => {
    it("masks password in http URL", () => {
        assert.equal(maskProxy("http://user:secret@host:8080"), "http://user:***@host:8080");
    });

    it("masks password in socks5 URL", () => {
        assert.equal(maskProxy("socks5://admin:p4ss@1.2.3.4:1080"), "socks5://admin:***@1.2.3.4:1080");
    });

    it("masks long password", () => {
        assert.equal(
            maskProxy("http://3AccFfq:pkLbHLRjhqids_session-Ntekoom2@geo.iproyal.com:12321"),
            "http://3AccFfq:***@geo.iproyal.com:12321",
        );
    });

    it("returns URL unchanged when no password", () => {
        assert.equal(maskProxy("http://host:8080"), "http://host:8080");
    });

    it('returns "none" for null', () => {
        assert.equal(maskProxy(null), "none");
    });

    it('returns "none" for empty string', () => {
        assert.equal(maskProxy(""), "none");
    });

    it('returns "none" for undefined', () => {
        assert.equal(maskProxy(undefined), "none");
    });
});
