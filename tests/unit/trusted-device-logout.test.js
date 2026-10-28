/**
 * Decision D19 (2026-10-28): the CLI is a trusted companion device once it has logged in with the official QR flow.
 * What each way of leaving an account does with that identity, and what it tells the person.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir, saveCredentials } from "../../src/core/credentials.js";
import { deleteLocalHistory, describeTrustedDevice, finishLocalLogout } from "../../src/core/logout.js";
import { wipeAccountDir } from "../../src/core/accounts.js";
import { TRUST_FILE } from "../../src/zalo/trust-store.js";

const OWN = "1000000000000000071";
const dir = () => getAccountDir(OWN);
const trustFile = () => join(dir(), TRUST_FILE);

describe("the trusted-device identity at logout, purge and removal", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    beforeEach(() => {
        rmSync(dir(), { recursive: true, force: true });
        mkdirSync(join(dir(), "media"), { recursive: true });
        writeFileSync(trustFile(), "{}");
        writeFileSync(join(dir(), "zalo.db"), "");
        saveCredentials(OWN, { imei: "i", cookie: [], userAgent: "ua" });
    });

    it("a logout keeps the identity, with or without the chat history, so the next login links as the same entry", () => {
        finishLocalLogout(OWN, { deleteHistory: false });
        assert.ok(existsSync(trustFile()));
        saveCredentials(OWN, { imei: "i", cookie: [], userAgent: "ua" });
        finishLocalLogout(OWN, { deleteHistory: true });
        assert.ok(existsSync(trustFile()), "--delete-history removes the chat cache, not the device identity");
        assert.equal(existsSync(join(dir(), "zalo.db")), false);
        assert.equal(existsSync(join(dir(), "media")), false);
    });

    it("a purge or a removal deletes it with the account's folder", () => {
        assert.equal(wipeAccountDir(OWN).wiped, true);
        assert.equal(existsSync(trustFile()), false);
    });

    it("deleting the local history alone leaves it", () => {
        deleteLocalHistory(OWN);
        assert.ok(existsSync(trustFile()));
    });

    it("tells the person what happened to it, and what is left on the phone", () => {
        assert.match(describeTrustedDevice(OWN, "kept"), /stays a linked companion device.*same entry/s);
        const gone = describeTrustedDevice(OWN, "deleted");
        assert.match(gone, /still lists it as a linked device until you remove it on your phone/);
        assert.match(gone, /account devices/);
    });

    it("says nothing for an account that never had one", () => {
        rmSync(trustFile());
        assert.equal(describeTrustedDevice(OWN, "kept"), null);
        assert.equal(describeTrustedDevice("1000000000000000072", "deleted"), null);
    });
});
