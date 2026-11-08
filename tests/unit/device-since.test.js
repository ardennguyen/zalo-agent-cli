/**
 * When this client's device id (imei) came into use for an account (src/core/device-since.js), and the stamp every
 * credential save carries (src/core/credentials.js `deviceSinceFor`). Zalo keeps the offline queue per device, so this
 * time is the floor below which a queue drain never counts as coverage.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
    CONFIG_DIR,
    CREDENTIALS_DIR,
    deviceSinceFor,
    loadCredentials,
    readSavedDevice,
    saveCredentials,
} from "../../src/core/credentials.js";
import { sealFile } from "../../src/core/keystore/index.js";
import {
    describeLoginDevice,
    deviceSinceOf,
    firstLoginDeviceOf,
    loginDeviceChange,
} from "../../src/core/device-since.js";

const OWN = "1000000000000000777";
const T = Date.UTC(2026, 10, 8, 9, 0, 0);
const CREDS = { imei: "device-a", cookie: { cookies: [] }, userAgent: "TestAgent/1.0", language: "vi" };

describe("deviceSinceFor: the stamp a save carries", () => {
    it("keeps the saved stamp while the imei stays the same", () => {
        const prev = { state: "ok", imei: "device-a", deviceSince: T - 5_000, mtime: T - 1_000 };
        assert.equal(deviceSinceFor(prev, { imei: "device-a" }, T), T - 5_000);
    });

    it("a login saved before stamps existed: its file's last write, never earlier than the imei's first use", () => {
        const prev = { state: "ok", imei: "device-a", deviceSince: null, mtime: T - 7_000 };
        assert.equal(deviceSinceFor(prev, { imei: "device-a" }, T), T - 7_000);
    });

    it("a changed imei, a missing one, or an unreadable saved login is a new device: now", () => {
        const prev = { state: "ok", imei: "device-a", deviceSince: T - 5_000, mtime: T - 1_000 };
        assert.equal(deviceSinceFor(prev, { imei: "device-b" }, T), T);
        assert.equal(deviceSinceFor(prev, {}, T), T);
        assert.equal(deviceSinceFor({ state: "unreadable" }, { imei: "device-a", deviceSince: T - 9 }, T), T);
        assert.equal(deviceSinceFor({ state: "none" }, { imei: "device-a" }, T), T);
    });

    it("nothing saved and the credentials carry their own stamp (an exported login): that stamp, never a future one", () => {
        assert.equal(deviceSinceFor({ state: "none" }, { imei: "device-a", deviceSince: T - 9_000 }, T), T - 9_000);
        assert.equal(deviceSinceFor({ state: "none" }, { imei: "device-a", deviceSince: T + 9_000 }, T), T);
    });
});

describe("saveCredentials stamps deviceSince", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    beforeEach(() => rmSync(CREDENTIALS_DIR, { recursive: true, force: true }));

    it("on the first save, keeps it across cookie re-saves, and moves it when the imei changes", () => {
        saveCredentials(OWN, CREDS, { now: T });
        assert.equal(loadCredentials(OWN).deviceSince, T);
        // A cookie re-save (src/core/zalo-client.js persistCookies) spreads the loaded creds: the stamp stays.
        saveCredentials(OWN, { ...loadCredentials(OWN), cookie: { cookies: [{ key: "x" }] } }, { now: T + 60_000 });
        assert.equal(loadCredentials(OWN).deviceSince, T);
        // Even without the field: the same imei keeps the saved stamp.
        saveCredentials(OWN, CREDS, { now: T + 120_000 });
        assert.equal(loadCredentials(OWN).deviceSince, T);
        saveCredentials(OWN, { ...CREDS, imei: "device-b" }, { now: T + 180_000 });
        assert.equal(loadCredentials(OWN).deviceSince, T + 180_000);
    });

    it("a login saved before stamps existed gets its file time on the next save", () => {
        const file = join(CREDENTIALS_DIR, `cred_${OWN}.json`);
        saveCredentials(OWN, CREDS, { now: T }); // creates the directory
        sealFile(file, OWN, { kind: "credentials", use: "boot" }, JSON.stringify(CREDS));
        const old = new Date(T - 3_600_000);
        utimesSync(file, old, old);
        assert.equal(readSavedDevice(OWN).deviceSince, null);
        saveCredentials(OWN, CREDS, { now: T });
        assert.equal(loadCredentials(OWN).deviceSince, T - 3_600_000);
    });

    it("readSavedDevice says none, unreadable or ok, and never throws", () => {
        assert.deepEqual(readSavedDevice(OWN), { state: "none" });
        saveCredentials(OWN, CREDS, { now: T });
        const ok = readSavedDevice(OWN);
        assert.equal(ok.state, "ok");
        assert.equal(ok.imei, "device-a");
        assert.equal(ok.deviceSince, T);
        sealFile(join(CREDENTIALS_DIR, `cred_${OWN}.json`), OWN, { kind: "credentials", use: "boot" }, "not json");
        assert.deepEqual(readSavedDevice(OWN), { state: "unreadable" });
    });
});

describe("deviceSinceOf: the coverage floor", () => {
    const apiWith = (value) => ({ getContext: () => ({ settings: { common: { first_time_login_device: value } } }) });
    const saved = (o) => () => ({ state: "ok", imei: "device-a", ...o });

    it("reads the stamp, then the file time of an unstamped login", () => {
        assert.deepEqual(deviceSinceOf(OWN, null, { now: T, read: saved({ deviceSince: T - 10 }) }), {
            ts: T - 10,
            source: "credentials",
        });
        assert.deepEqual(deviceSinceOf(OWN, null, { now: T, read: saved({ deviceSince: null, mtime: T - 20 }) }), {
            ts: T - 20,
            source: "credentials-file",
        });
    });

    it("takes the server's first_time_login_device when it is later (seconds or ms)", () => {
        const read = saved({ deviceSince: T - 60_000 });
        assert.deepEqual(deviceSinceOf(OWN, apiWith((T - 1_000) / 1000), { now: T, read }), {
            ts: T - 1_000,
            source: "server",
        });
        assert.deepEqual(deviceSinceOf(OWN, apiWith(T - 2_000), { now: T, read }), { ts: T - 2_000, source: "server" });
        // An earlier server value claims less than the stamp would: the stamp stays.
        assert.equal(deviceSinceOf(OWN, apiWith(T - 120_000), { now: T, read }).source, "credentials");
    });

    it("ignores an implausible server value", () => {
        assert.equal(firstLoginDeviceOf(apiWith("x"), T), null);
        assert.equal(firstLoginDeviceOf(apiWith(5), T), null);
        assert.equal(firstLoginDeviceOf(apiWith(T + 10 * 86_400_000), T), null);
        assert.equal(firstLoginDeviceOf({ getContext: () => ({}) }, T), null);
        assert.equal(firstLoginDeviceOf(null, T), null);
    });

    it("knowing neither is now: nothing is claimed", () => {
        assert.deepEqual(deviceSinceOf(OWN, null, { now: T, read: () => ({ state: "unreadable" }) }), {
            ts: T,
            source: "unknown",
        });
    });
});

describe("loginDeviceChange / describeLoginDevice: what the login output says", () => {
    it("the same imei is the same device; anything else a new one, with its reason", () => {
        assert.deepEqual(loginDeviceChange({ state: "ok", imei: "a" }, "a"), {
            newDevice: false,
            reason: "same-device",
        });
        assert.equal(loginDeviceChange({ state: "none" }, "a").reason, "first-login");
        assert.equal(loginDeviceChange({ state: "unreadable" }, "a").reason, "unreadable");
        assert.equal(loginDeviceChange({ state: "ok", imei: null }, "a").reason, "no-device-id");
        assert.equal(loginDeviceChange({ state: "ok", imei: "a" }, "b").reason, "device-changed");
    });

    it("a new device names the login time and the restore command", () => {
        const line = describeLoginDevice({ newDevice: true, reason: "device-changed" }, T);
        assert.match(line, /new device id/);
        assert.ok(line.includes(new Date(T).toISOString()));
        assert.match(line, /zalo-agent sync/);
        assert.match(describeLoginDevice({ newDevice: false, reason: "same-device" }, T), /same device id/);
    });
});
