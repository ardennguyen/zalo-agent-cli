import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, saveCredentials, deleteCredentials, loadCredentials } from "../../src/core/credentials.js";
import { getActive, setActive } from "../../src/core/accounts.js";
import { parseAccountId, selectDaemonAccount, loginDaemonAccount } from "../../src/core/daemon-account.js";

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify([
            { ownId: "101", name: "Example One", proxy: "http://127.0.0.1:1101", active: true },
            { ownId: "202", name: "Example Two", proxy: "http://127.0.0.1:1202", active: false },
        ]),
    );
    saveCredentials("101", { exampleUid: "101" });
    saveCredentials("202", { exampleUid: "202" });
});

function fakeLogin(overrides = {}) {
    const calls = [];
    const state = { uid: "unrelated-session" };
    const deps = {
        read: (id) => {
            calls.push({ read: id });
            return loadCredentials(id);
        },
        reset: () => {
            calls.push({ reset: true });
            state.uid = null;
        },
        login: async (credentials, proxy) => {
            calls.push({ credentials: credentials.exampleUid, proxy });
            state.uid = credentials.exampleUid;
            return { ownId: credentials.exampleUid, api: {} };
        },
        ...overrides,
    };
    return { deps, calls, state };
}

describe("exact daemon account selection", () => {
    it("keeps large IDs as exact strings beyond Number.MAX_SAFE_INTEGER", () => {
        const id = "1234567890123456789";
        assert.equal(parseAccountId(id), id);
    });

    it("rejects names, malformed values, empty values and numeric coercion", () => {
        for (const value of ["", "Example One", "01", "-1", "1.0", "1e3", " 101 ", "../101", 101, null]) {
            assert.throws(() => parseAccountId(value), /full numeric account ID/);
        }
    });

    it("selects the exact inactive ID without changing the global active account", () => {
        const account = selectDaemonAccount("202");
        assert.equal(account.ownId, "202");
        assert.equal(getActive().ownId, "101");
    });

    it("does not accept a numeric prefix or fall back to the active account", () => {
        assert.throws(() => selectDaemonAccount("10"), /not registered/);
        assert.throws(() => selectDaemonAccount("999"), /not registered/);
        assert.equal(getActive().ownId, "101");
    });

    it("freezes the implicit active-account snapshot across a registry switch", () => {
        const account = selectDaemonAccount();
        setActive("202");
        assert.equal(account.ownId, "101");
        assert.equal(account.proxy, "http://127.0.0.1:1101");
        assert.equal(Object.isFrozen(account), true);
        assert.throws(() => {
            account.ownId = "202";
        }, TypeError);
    });

    it("an explicit selection never consults the active account", () => {
        const account = selectDaemonAccount("101", {
            active: () => assert.fail("must not read active selection"),
            lookup: (id) => ({ ownId: id, proxy: null }),
        });
        assert.equal(account.ownId, "101");
    });

    it("rejects an account lookup that returns a different identity", () => {
        assert.throws(() => selectDaemonAccount("101", { lookup: () => ({ ownId: "202" }) }), /different ID/);
    });

    it("requires either an explicit registered account or an active account", () => {
        writeFileSync(join(CONFIG_DIR, "accounts.json"), "[]");
        assert.throws(() => selectDaemonAccount(), /No active account/);
        assert.throws(() => selectDaemonAccount("101"), /not registered/);
    });
});

describe("pinned startup and reconnect authentication", () => {
    it("startup and repeated reconnects use the pinned credentials/proxy after account switch", async () => {
        const account = selectDaemonAccount("101");
        const { deps, calls, state } = fakeLogin();
        await loginDaemonAccount(account, deps);
        setActive("202");
        await loginDaemonAccount(account, deps);
        await loginDaemonAccount(account, deps);
        assert.deepEqual(
            calls.filter((c) => c.read),
            [{ read: "101" }, { read: "101" }, { read: "101" }],
        );
        assert.deepEqual(
            calls.filter((c) => c.credentials),
            Array.from({ length: 3 }, () => ({ credentials: "101", proxy: "http://127.0.0.1:1101" })),
        );
        assert.equal(state.uid, "101");
        assert.equal(getActive().ownId, "202");
    });

    it("the default active-at-startup account is also pinned on reconnect", async () => {
        const account = selectDaemonAccount();
        setActive("202");
        const { deps, state } = fakeLogin();
        await loginDaemonAccount(account, deps);
        assert.equal(state.uid, "101");
    });

    it("uses the selected inactive account's proxy, not the active account's proxy", async () => {
        const { deps, calls } = fakeLogin();
        await loginDaemonAccount(selectDaemonAccount("202"), deps);
        assert.deepEqual(
            calls.find((c) => c.credentials),
            { credentials: "202", proxy: "http://127.0.0.1:1202" },
        );
        assert.equal(getActive().ownId, "101");
    });

    it("missing pinned credentials fail without logging in to another account", async () => {
        const account = selectDaemonAccount("101");
        deleteCredentials("101");
        setActive("202");
        const { deps, calls, state } = fakeLogin({ login: async () => assert.fail("must not authenticate") });
        await assert.rejects(loginDaemonAccount(account, deps), /No saved credentials/);
        assert.deepEqual(
            calls.filter((c) => c.read),
            [{ read: "101" }],
        );
        assert.equal(state.uid, null);
    });

    it("a login failure clears the session and never falls back to active credentials", async () => {
        const { deps, calls, state } = fakeLogin({
            login: async () => {
                throw new Error("expired session");
            },
        });
        await assert.rejects(loginDaemonAccount(selectDaemonAccount("101"), deps), /expired session/);
        assert.equal(calls.filter((c) => c.reset).length, 2);
        assert.equal(state.uid, null);
        assert.deepEqual(
            calls.filter((c) => c.read),
            [{ read: "101" }],
        );
    });

    it("rejects mismatched or missing authenticated UIDs before any listener can attach", async () => {
        for (const ownId of ["202", null]) {
            const { deps, calls, state } = fakeLogin({ login: async () => ({ ownId }) });
            await assert.rejects(loginDaemonAccount(selectDaemonAccount("101"), deps), /does not match the pinned ID/);
            assert.equal(calls.filter((c) => c.reset).length, 2);
            assert.equal(state.uid, null);
        }
    });
});
