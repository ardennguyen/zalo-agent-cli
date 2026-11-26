/**
 * A QR-added account on a fleet host with an accounts mount (`fleet serve --accounts-dir`, src/core/fleet-account-data.js):
 * its data folder ends up in `<accounts dir>/<ownId>`, the config dir's `accounts/<ownId>` is a link to it, and its env
 * file names the mount (ZALO_DATA_DIR), so the daemon, the timers and the host's backups all see the same folder. Without
 * a mount (or with data in both places) nothing moves and nothing is lost.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { accountsDirOf, placeAccountData } from "../../src/core/fleet-account-data.js";
import { finishQrAdd } from "../../src/core/fleet-serve.js";
import { wipeAccountDir } from "../../src/core/accounts.js";
import { applyPolicy } from "../../src/core/policy-store.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const driver = { start: async () => ({ ok: true }), restart: async () => ({ ok: true }) };
let n = 0;
/** A fresh host: its config dir's accounts folder, its accounts mount (made unless `mount: false`) and env dir. */
function host({ mount = true } = {}) {
    const base = join(CONFIG_DIR, `fleet-host-${++n}`);
    const dataDir = join(base, "home-accounts");
    const accountsDir = join(base, "mount");
    mkdirSync(dataDir, { recursive: true });
    if (mount) mkdirSync(accountsDir, { recursive: true });
    return { dataDir, accountsDir, envDir: join(base, "etc-accounts") };
}
/** What the login child left in the config dir for an account. */
function loginWrote(dataDir, ownId) {
    mkdirSync(join(dataDir, ownId, "sync"), { recursive: true });
    writeFileSync(join(dataDir, ownId, "session.json"), "{}");
    writeFileSync(join(dataDir, ownId, "sync", "key.pem"), "k".repeat(300));
}
const isLink = (p) => lstatSync(p).isSymbolicLink();

describe("a QR-added account on a host with an accounts mount", () => {
    it("ends up in <mount>/<ownId>: the config dir links to it, the env file names the mount", async () => {
        const h = host();
        const ownId = "1000000000000000971";
        applyPolicy({ target: { kind: "user", id: "crmMnt" }, op: "put", policy: {}, tenant: "tMnt", actor: "t" });
        loginWrote(h.dataDir, ownId);
        const r = await finishQrAdd({
            ownId,
            userId: "crmMnt",
            presence: null,
            start: false,
            wasRunning: false,
            envDir: h.envDir,
            driver,
            accountsDir: h.accountsDir,
            dataDir: h.dataDir,
        });
        assert.equal(r.data, "accounts-dir");
        const own = join(h.accountsDir, ownId);
        assert.equal(readFileSync(join(own, "sync", "key.pem"), "utf8").length, 300, "the login's files moved over");
        assert.ok(isLink(join(h.dataDir, ownId)));
        assert.equal(realpathSync(join(h.dataDir, ownId)), realpathSync(own));
        // What the controller, the timers and `za` read through the config dir is the folder on the mount.
        assert.ok(existsSync(join(h.dataDir, ownId, "session.json")));
        const env = parseEnv(readFileSync(join(h.envDir, `${ownId}.env`), "utf8"));
        assert.equal(env.ZALO_DATA_DIR, h.accountsDir);
        assert.equal(join(env.ZALO_DATA_DIR, ownId), own, "the daemon opens the same folder itself");
    });

    it("a login that wrote nothing yet still gets its folder and link", () => {
        const h = host();
        const r = placeAccountData({ ownId: "1000000000000000972", accountsDir: h.accountsDir, dataDir: h.dataDir });
        assert.equal(r.placed, true);
        assert.ok(lstatSync(join(h.accountsDir, "1000000000000000972")).isDirectory());
        assert.ok(isLink(join(h.dataDir, "1000000000000000972")));
    });

    it("is idempotent: a second pass leaves the link and the data as they are", () => {
        const h = host();
        const ownId = "1000000000000000973";
        loginWrote(h.dataDir, ownId);
        assert.equal(placeAccountData({ ownId, accountsDir: h.accountsDir, dataDir: h.dataDir }).moved, "renamed");
        const again = placeAccountData({ ownId, accountsDir: h.accountsDir, dataDir: h.dataDir });
        assert.deepEqual(again, { placed: true, dataDir: h.accountsDir });
        assert.equal(readlinkSync(join(h.dataDir, ownId)), join(h.accountsDir, ownId));
        assert.ok(existsSync(join(h.accountsDir, ownId, "session.json")));
    });

    it("never overwrites: data in both places stays where it is", () => {
        const h = host();
        const ownId = "1000000000000000974";
        loginWrote(h.dataDir, ownId);
        mkdirSync(join(h.accountsDir, ownId));
        writeFileSync(join(h.accountsDir, ownId, "zalo.db"), "older");
        const r = placeAccountData({ ownId, accountsDir: h.accountsDir, dataDir: h.dataDir });
        assert.deepEqual(r, { placed: false, reason: "BOTH_HAVE_DATA" });
        assert.ok(!isLink(join(h.dataDir, ownId)));
        assert.ok(existsSync(join(h.dataDir, ownId, "session.json")));
        assert.equal(readFileSync(join(h.accountsDir, ownId, "zalo.db"), "utf8"), "older");
    });

    it("without the mount nothing moves (the account stays in the config dir) and the env file names no data dir", async () => {
        const h = host({ mount: false });
        const ownId = "1000000000000000975";
        applyPolicy({ target: { kind: "user", id: "crmMnt2" }, op: "put", policy: {}, tenant: "tMnt2", actor: "t" });
        loginWrote(h.dataDir, ownId);
        const lines = [];
        const r = await finishQrAdd({
            ownId,
            userId: "crmMnt2",
            presence: null,
            start: false,
            wasRunning: false,
            envDir: h.envDir,
            driver,
            accountsDir: h.accountsDir,
            dataDir: h.dataDir,
            log: (l) => lines.push(l),
        });
        assert.equal(r.data, "config-dir (ACCOUNTS_DIR_MISSING)");
        assert.ok(!existsSync(h.accountsDir), "a missing mount is never made (it would be the container's own disk)");
        assert.ok(!isLink(join(h.dataDir, ownId)));
        assert.ok(existsSync(join(h.dataDir, ownId, "session.json")));
        assert.equal(parseEnv(readFileSync(join(h.envDir, `${ownId}.env`), "utf8")).ZALO_DATA_DIR, undefined);
        assert.match(lines.join("\n"), /ACCOUNTS_DIR_MISSING/);
    });

    it("a login again of an account this host already runs moves nothing (its env file exists)", async () => {
        const h = host();
        const ownId = "1000000000000000976";
        applyPolicy({ target: { kind: "user", id: "crmMnt3" }, op: "put", policy: {}, tenant: "tMnt3", actor: "t" });
        loginWrote(h.dataDir, ownId);
        mkdirSync(h.envDir, { recursive: true });
        writeFileSync(join(h.envDir, `${ownId}.env`), "ZALO_MCP_HTTP_PORT=3900\n");
        const r = await finishQrAdd({
            ownId,
            userId: "crmMnt3",
            presence: null,
            start: false,
            wasRunning: false,
            envDir: h.envDir,
            driver,
            accountsDir: h.accountsDir,
            dataDir: h.dataDir,
        });
        assert.equal(r.envWritten, false);
        assert.equal(r.data, undefined);
        assert.ok(!isLink(join(h.dataDir, ownId)));
        assert.ok(!existsSync(join(h.accountsDir, ownId)));
    });

    it("`--accounts-dir` wins over ZALO_FLEET_ACCOUNTS_DIR; neither means no mount", () => {
        assert.equal(accountsDirOf(null, {}), null);
        assert.equal(accountsDirOf(undefined, { ZALO_FLEET_ACCOUNTS_DIR: "/srv/a" }), join("/srv/a"));
        assert.equal(accountsDirOf("/srv/b", { ZALO_FLEET_ACCOUNTS_DIR: "/srv/a" }), join("/srv/b"));
    });

    it("removing the account wipes the folder on the mount, not only the link", () => {
        const ownId = "1000000000000000977";
        const mount = join(CONFIG_DIR, "wipe-mount");
        mkdirSync(mount, { recursive: true });
        mkdirSync(dirname(getAccountDir(ownId)), { recursive: true });
        const r = placeAccountData({ ownId, accountsDir: mount, dataDir: dirname(getAccountDir(ownId)) });
        assert.equal(r.placed, true);
        writeFileSync(join(mount, ownId, "zalo.db"), "rows");
        assert.deepEqual(wipeAccountDir(ownId), { wiped: true });
        assert.ok(!existsSync(join(mount, ownId)), "the data is gone");
        assert.throws(() => lstatSync(getAccountDir(ownId)), /ENOENT/);
    });
});
