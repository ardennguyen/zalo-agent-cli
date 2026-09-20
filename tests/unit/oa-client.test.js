/**
 * src/core/oa-client.js — Official Account credential storage, OAuth URL
 * construction, and the message-type validation that guards path
 * construction.
 *
 * Note the separate storage root: OA lives in ~/.zalo-agent/ (no `-cli`
 * suffix), deliberately apart from the unofficial-API credentials in
 * ~/.zalo-agent-cli/. Conflating the two is an explicit project hazard, so
 * the split is asserted here rather than assumed.
 *
 * Nothing in this file makes a network call. Anything that would (sendText,
 * uploadImage, …) is covered by the OA section of the manual checklist,
 * because it needs a real OA app id and secret.
 */

import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { saveOACreds, saveOAToken, loadOACreds, loadOAToken, getOAuthUrl, sendText } from "../../src/core/oa-client.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const OA_FILE = join(OA_DIR, "oa-credentials.json");

describe("OA storage is separate from personal-account storage", () => {
    it("personal credentials live in ~/.zalo-agent-cli", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    it("OA credentials live in ~/.zalo-agent — a different directory", () => {
        saveOAToken("tok", "default");
        assert.equal(existsSync(OA_FILE), true);
        assert.notEqual(OA_DIR, SANDBOX_CONFIG_DIR);
        assert.equal(existsSync(join(SANDBOX_CONFIG_DIR, "oa-credentials.json")), false);
    });
});

describe("saveOACreds / loadOACreds", () => {
    beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));

    it("returns null before anything is saved", () => {
        assert.equal(loadOACreds(), null);
        assert.equal(loadOAToken(), null);
    });

    it("creates the data directory on first save", () => {
        saveOACreds({ accessToken: "a" });
        assert.equal(existsSync(OA_DIR), true);
    });

    it("round-trips a credential and stamps updatedAt", () => {
        saveOACreds({ accessToken: "a", refreshToken: "r", appId: "123" });
        const c = loadOACreds();
        assert.equal(c.accessToken, "a");
        assert.equal(c.refreshToken, "r");
        assert.equal(c.appId, "123");
        assert.match(c.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("merges into an existing record instead of replacing it", () => {
        saveOACreds({ accessToken: "a", refreshToken: "r", appId: "123" });
        saveOACreds({ accessToken: "a2" });
        const c = loadOACreds();
        assert.equal(c.accessToken, "a2", "the new value wins");
        assert.equal(c.refreshToken, "r", "untouched fields survive a token refresh");
        assert.equal(c.appId, "123");
    });

    it("keeps multiple OAs in separate namespaces", () => {
        saveOACreds({ accessToken: "shop1-token" }, "shop1");
        saveOACreds({ accessToken: "shop2-token" }, "shop2");
        assert.equal(loadOAToken("shop1"), "shop1-token");
        assert.equal(loadOAToken("shop2"), "shop2-token");
        assert.equal(loadOACreds("default"), null, "an unrelated oaId must not leak another OA's token");
    });

    it("saveOAToken is a thin alias that preserves sibling fields", () => {
        saveOACreds({ appId: "123", refreshToken: "r" }, "shop1");
        saveOAToken("fresh", "shop1");
        const c = loadOACreds("shop1");
        assert.equal(c.accessToken, "fresh");
        assert.equal(c.refreshToken, "r");
    });

    it("loadOAToken returns null when the record exists but has no token", () => {
        saveOACreds({ appId: "123" }, "shop1");
        assert.equal(loadOAToken("shop1"), null);
    });

    it(
        "writes oa-credentials.json with 0600 permissions",
        { skip: process.platform === "win32" ? "POSIX mode bits are not meaningful on Windows" : false },
        () => {
            saveOACreds({ accessToken: "a" });
            assert.equal(statSync(OA_FILE).mode & 0o777, 0o600);
        },
    );

    it("stores the secret key nowhere unless explicitly saved", () => {
        saveOACreds({ accessToken: "a", appId: "123" });
        assert.doesNotMatch(readFileSync(OA_FILE, "utf-8"), /secret/i);
    });
});

describe("getOAuthUrl", () => {
    it("targets the v4 OA permission endpoint", () => {
        assert.match(getOAuthUrl("123"), /^https:\/\/oauth\.zaloapp\.com\/v4\/oa\/permission\?/);
    });

    it("includes app_id and the default redirect_uri", () => {
        const u = new URL(getOAuthUrl("123"));
        assert.equal(u.searchParams.get("app_id"), "123");
        assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:3456/callback");
    });

    it("honors a custom redirect_uri", () => {
        const u = new URL(getOAuthUrl("123", "https://example.com/cb"));
        assert.equal(u.searchParams.get("redirect_uri"), "https://example.com/cb");
    });

    it("percent-encodes the redirect so query params survive", () => {
        const url = getOAuthUrl("123", "https://example.com/cb?x=1&y=2");
        assert.match(url, /redirect_uri=https%3A%2F%2Fexample\.com%2Fcb%3Fx%3D1%26y%3D2/);
        assert.equal(new URL(url).searchParams.get("redirect_uri"), "https://example.com/cb?x=1&y=2");
    });

    it("never embeds a secret key", () => {
        assert.doesNotMatch(getOAuthUrl("123"), /secret/i);
    });
});

describe("message-type validation (path-injection guard)", () => {
    beforeEach(() => {
        rmSync(OA_DIR, { recursive: true, force: true });
        saveOACreds({ accessToken: "fake-token-never-used" });
    });

    it("rejects an unknown message type before any network call", async () => {
        await assert.rejects(() => sendText("uid", "hi", "bogus"), /Invalid message type "bogus"/);
    });

    it("rejects a path-traversal attempt in messageType", async () => {
        await assert.rejects(() => sendText("uid", "hi", "../../admin"), /Invalid message type/);
    });

    it("names the three valid types in the error so the fix is obvious", async () => {
        await assert.rejects(() => sendText("uid", "hi", "nope"), /cs, transaction, promotion/);
    });
});

describe("unconfigured OA", () => {
    beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));

    it("sendText tells the user which command configures it", async () => {
        await assert.rejects(() => sendText("uid", "hi"), /OA not configured\. Run: zalo-agent oa login/);
    });
});
