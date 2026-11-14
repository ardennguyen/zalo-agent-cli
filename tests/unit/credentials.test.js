/**
 * src/core/credentials.js — per-account credential storage.
 *
 * NOTE: the sandbox import MUST stay first. It redirects USERPROFILE/HOME
 * before credentials.js computes CONFIG_DIR at module-evaluation time.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    CONFIG_DIR,
    CREDENTIALS_DIR,
    saveCredentials,
    loadCredentials,
    deleteCredentials,
    getAccountDir,
} from "../../src/core/credentials.js";
import { sessionExpiryFromMarker } from "../../src/core/session-notice.js";

/** A saved login without the device stamp saveCredentials adds (src/core/credentials.js `deviceSinceFor`). */
const unstamped = (creds) => {
    if (!creds) return creds;
    const rest = { ...creds };
    delete rest.deviceSince;
    return rest;
};

const OWN_ID = "1000000000000000001";
const CREDS = { imei: "test-imei-0001", cookie: { cookies: [] }, userAgent: "TestAgent/1.0", language: "vi" };

describe("credentials — sandboxing", () => {
    it("resolves CONFIG_DIR inside the test sandbox, not the real home", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        assert.equal(CREDENTIALS_DIR, join(SANDBOX_CONFIG_DIR, "credentials"));
    });
});

describe("saveCredentials / loadCredentials / deleteCredentials", () => {
    beforeEach(() => {
        rmSync(CREDENTIALS_DIR, { recursive: true, force: true });
    });

    it("creates the credentials directory on first save", () => {
        assert.equal(existsSync(CREDENTIALS_DIR), false);
        saveCredentials(OWN_ID, CREDS);
        assert.equal(existsSync(CREDENTIALS_DIR), true);
    });

    it("returns the written path and round-trips the payload", () => {
        const p = saveCredentials(OWN_ID, CREDS);
        assert.equal(p, join(CREDENTIALS_DIR, `cred_${OWN_ID}.json`));
        assert.deepEqual(unstamped(loadCredentials(OWN_ID)), CREDS);
    });

    it("writes the login sealed: the file carries no imei and no cookie (src/core/keystore/)", () => {
        saveCredentials(OWN_ID, CREDS);
        const bytes = readFileSync(join(CREDENTIALS_DIR, `cred_${OWN_ID}.json`));
        assert.ok(bytes.subarray(0, 7).equals(Buffer.from("ZACSEAL")));
        assert.ok(!bytes.includes(Buffer.from(CREDS.imei)));
        assert.deepEqual(unstamped(loadCredentials(OWN_ID)), CREDS);
    });

    it("overwrites an existing credential rather than appending", () => {
        saveCredentials(OWN_ID, CREDS);
        saveCredentials(OWN_ID, { ...CREDS, imei: "rotated" });
        assert.equal(loadCredentials(OWN_ID).imei, "rotated");
    });

    it("keeps accounts isolated — saving one does not disturb another", () => {
        saveCredentials(OWN_ID, CREDS);
        saveCredentials("2000000000000000002", { ...CREDS, imei: "second" });
        assert.equal(loadCredentials(OWN_ID).imei, "test-imei-0001");
        assert.equal(loadCredentials("2000000000000000002").imei, "second");
    });

    it("loadCredentials returns null for an unknown account", () => {
        assert.equal(loadCredentials("9999999999999999999"), null);
    });

    it("loadCredentials returns null (does not throw) on a corrupt file", () => {
        mkdirSync(CREDENTIALS_DIR, { recursive: true });
        writeFileSync(join(CREDENTIALS_DIR, "cred_corrupt.json"), "{ not json", "utf-8");
        assert.equal(loadCredentials("corrupt"), null);
    });

    it("deleteCredentials returns true when it removed a file, false when absent", () => {
        saveCredentials(OWN_ID, CREDS);
        assert.equal(deleteCredentials(OWN_ID), true);
        assert.equal(existsSync(join(CREDENTIALS_DIR, `cred_${OWN_ID}.json`)), false);
        assert.equal(deleteCredentials(OWN_ID), false);
    });

    it("loadCredentials after delete returns null", () => {
        saveCredentials(OWN_ID, CREDS);
        deleteCredentials(OWN_ID);
        assert.equal(loadCredentials(OWN_ID), null);
    });
});

describe("credential file permissions", () => {
    before(() => saveCredentials(OWN_ID, CREDS));

    it(
        "is 0600 — owner read/write only",
        { skip: process.platform === "win32" ? "POSIX mode bits are not meaningful on Windows" : false },
        () => {
            const mode = statSync(join(CREDENTIALS_DIR, `cred_${OWN_ID}.json`)).mode & 0o777;
            assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
        },
    );

    it("never contains a plaintext password field regardless of platform", () => {
        const text = readFileSync(join(CREDENTIALS_DIR, `cred_${OWN_ID}.json`), "utf-8");
        assert.doesNotMatch(text, /"password"/i);
    });
});

describe("saveCredentials records when the login ends (fleet status reads it before any daemon ran)", () => {
    const ID = "1000000000000000002";
    const marker = () => join(getAccountDir(ID), "session-notice.json");
    const jar = (creation) => ({
        cookies: [{ key: "zpw_sek", value: "x", domain: "chat.zalo.me", creation, maxAge: 90 * 86_400 }],
    });
    beforeEach(() => {
        rmSync(getAccountDir(ID), { recursive: true, force: true });
    });

    it("writes the session end of a saved login into the account folder's marker", () => {
        saveCredentials(ID, { ...CREDS, cookie: jar("2030-01-01T00:00:00.000Z") });
        const got = sessionExpiryFromMarker(getAccountDir(ID));
        assert.equal(got?.expiresAt, "2030-04-01T00:00:00.000Z");
    });

    it("a new login's end replaces the old one and resets the thresholds already sent", () => {
        mkdirSync(getAccountDir(ID), { recursive: true });
        writeFileSync(marker(), JSON.stringify({ expiresAt: "2029-01-01T00:00:00.000Z", threshold: 3 }));
        saveCredentials(ID, { ...CREDS, cookie: jar("2030-01-01T00:00:00.000Z") });
        assert.deepEqual(JSON.parse(readFileSync(marker(), "utf8")), {
            expiresAt: "2030-04-01T00:00:00.000Z",
            threshold: null,
        });
    });

    it("the same end leaves the marker (and the thresholds sent) alone", () => {
        mkdirSync(getAccountDir(ID), { recursive: true });
        writeFileSync(marker(), JSON.stringify({ expiresAt: "2030-04-01T00:00:00.000Z", threshold: 7 }));
        saveCredentials(ID, { ...CREDS, cookie: jar("2030-01-01T00:00:00.000Z") });
        assert.equal(JSON.parse(readFileSync(marker(), "utf8")).threshold, 7);
    });

    it("a jar without a session cookie writes no marker", () => {
        saveCredentials(ID, CREDS);
        assert.equal(existsSync(marker()), false);
    });
});
