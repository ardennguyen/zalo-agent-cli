/**
 * Configurable storage paths — verifies that config, credentials, per-account
 * database/runtime state, downloaded media, and OA credentials can each live on
 * separate directories/mounts via CLI flags or environment variables.
 */

import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import {
    CONFIG_DIR,
    CREDENTIALS_DIR,
    DATA_DIR,
    MEDIA_DIR,
    configureStoragePaths,
    getAccountDir,
    getAccountDbPath,
    saveCredentials,
    loadCredentials,
} from "../../src/core/credentials.js";
import { addAccount, listAccounts, wipeAccountDir } from "../../src/core/accounts.js";
import { saveOACreds, loadOACreds, getOADataDir } from "../../src/core/oa-client.js";
import { initDb, insertMessage, getMessageById } from "../../src/core/db.js";
import { downloadSyncedMedia } from "../../src/core/sync-v2/media.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { runJson } from "../helpers/cli.js";

const TEST_UID = "user-test-1001";
const TEST_THREAD = "thread-test-2002";

let openDb = null;

function closeOpenDb() {
    if (openDb) {
        try {
            openDb.close();
        } catch {}
        openDb = null;
    }
}

function resetDefaultPaths() {
    delete process.env.ZALO_ENV_FILE;
    delete process.env.ZALO_CONFIG_DIR;
    delete process.env.ZALO_CREDENTIALS_DIR;
    delete process.env.ZALO_DATA_DIR;
    delete process.env.ZALO_DB_DIR;
    delete process.env.ZALO_MEDIA_DIR;
    delete process.env.ZALO_OA_DIR;
    configureStoragePaths({
        loadEnv: false,
        configDir: SANDBOX_CONFIG_DIR,
        credentialsDir: join(SANDBOX_CONFIG_DIR, "credentials"),
        dataDir: join(SANDBOX_CONFIG_DIR, "accounts"),
        mediaDir: null,
    });
    delete process.env.ZALO_CONFIG_DIR;
    delete process.env.ZALO_CREDENTIALS_DIR;
    delete process.env.ZALO_DATA_DIR;
}

describe("separated storage paths (unit + CLI)", () => {
    const customRoot = join(SANDBOX_HOME, "mounts");
    const customConfig = join(customRoot, "etc-zalo");
    const customCreds = join(customRoot, "secret-creds");
    const customData = join(customRoot, "db-volume");
    const customMedia = join(customRoot, "media-nas");
    const customOa = join(customRoot, "oa-secret");

    beforeEach(() => {
        closeOpenDb();
        resetDefaultPaths();
        assertSandboxed(CONFIG_DIR);
        rmSync(customRoot, { recursive: true, force: true });
    });

    afterEach(() => {
        closeOpenDb();
        resetDefaultPaths();
        rmSync(customRoot, { recursive: true, force: true });
    });

    it("separates config, credentials, database/account dir, media, and OA dir into independent roots", () => {
        configureStoragePaths({
            configDir: customConfig,
            credentialsDir: customCreds,
            dataDir: customData,
            mediaDir: customMedia,
            oaDir: customOa,
        });

        assert.equal(CONFIG_DIR, customConfig);
        assert.equal(CREDENTIALS_DIR, customCreds);
        assert.equal(DATA_DIR, customData);
        assert.equal(MEDIA_DIR, customMedia);
        assert.equal(getOADataDir(), customOa);
        assert.equal(getAccountDir(TEST_UID), join(customData, TEST_UID));
        assert.equal(getAccountDbPath(TEST_UID), join(customData, TEST_UID, "zalo.db"));
        assert.equal(new SyncV2({}, TEST_UID).accountDir, join(customData, TEST_UID));

        // 1. Credentials go to customCreds, not customConfig
        const credFile = saveCredentials(TEST_UID, { imei: "imei-1", cookie: [], userAgent: "ua" });
        assert.equal(credFile, join(customCreds, `cred_${TEST_UID}.json`));
        assert.equal(existsSync(credFile), true);
        assert.equal(existsSync(join(customConfig, "credentials")), false);
        assert.deepEqual(loadCredentials(TEST_UID), { imei: "imei-1", cookie: [], userAgent: "ua" });

        // 2. Account registry goes to customConfig/accounts.json
        addAccount(TEST_UID, "Prod Bot", null);
        assert.equal(existsSync(join(customConfig, "accounts.json")), true);
        assert.equal(listAccounts().length, 1);

        // 3. Per-account database goes to customData/<ownId>/zalo.db
        openDb = initDb(getAccountDbPath(TEST_UID));
        assert.equal(existsSync(join(customData, TEST_UID, "zalo.db")), true);
        assert.equal(existsSync(join(customConfig, "accounts")), false);
        closeOpenDb();

        // 4. wipeAccountDir removes customData/<ownId>
        const wiped = wipeAccountDir(TEST_UID);
        assert.equal(wiped.wiped, true);
        assert.equal(existsSync(join(customData, TEST_UID)), false);

        // 5. OA credentials go to customOa/oa-credentials.json
        saveOACreds({ accessToken: "oa-tok-1" }, "default");
        assert.equal(existsSync(join(customOa, "oa-credentials.json")), true);
        assert.equal(loadOACreds("default")?.accessToken, "oa-tok-1");
    });

    it("redirects media downloads to ZALO_MEDIA_DIR / --media-dir while database lives on DATA_DIR", async () => {
        configureStoragePaths({
            configDir: customConfig,
            credentialsDir: customCreds,
            dataDir: customData,
            mediaDir: customMedia,
        });

        const server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "image/png" });
            res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const port = server.address().port;

        try {
            openDb = initDb(getAccountDbPath(TEST_UID));
            insertMessage({
                msgId: "msg-media-1",
                threadId: TEST_THREAD,
                senderId: TEST_UID,
                senderName: "Tester",
                text: "[photo]",
                timestamp: 1700000000000,
                type: "photo",
                has_attachment: 1,
                raw_data: JSON.stringify({
                    attachments: [{ kind: "photo", url: `http://127.0.0.1:${port}/img.png` }],
                }),
            });

            const stats = await downloadSyncedMedia({
                api: null,
                accountDir: getAccountDir(TEST_UID),
                threadId: TEST_THREAD,
                threadNames: new Map([[TEST_THREAD, { name: "Media Thread", type: "dm" }]]),
            });

            assert.equal(stats.downloaded, 1);
            const row = getMessageById("msg-media-1");
            assert.ok(row?.localPath, "expected localPath to be recorded in database");
            assert.ok(
                row.localPath.startsWith(join(customMedia, TEST_THREAD)),
                `expected media under ${customMedia}, got ${row.localPath}`,
            );
            assert.equal(existsSync(row.localPath), true);
            assert.equal(existsSync(join(customMedia, "_conversations.json")), true);
            assert.deepEqual(JSON.parse(readFileSync(join(customMedia, "_conversations.json"), "utf8"))[TEST_THREAD], {
                name: "Media Thread",
                type: "dm",
            });
            assert.equal(existsSync(join(customData, TEST_UID, "media")), false);
        } finally {
            closeOpenDb();
            await new Promise((r) => server.close(r));
        }
    });

    it("CLI honors --config-dir, --credentials-dir, and ZALO_*_DIR environment variables", async () => {
        configureStoragePaths({
            configDir: customConfig,
            credentialsDir: customCreds,
            dataDir: customData,
        });
        saveCredentials(TEST_UID, { imei: "imei-cli", cookie: [], userAgent: "ua" });
        addAccount(TEST_UID, "CLI Custom Path Account", null);
        mkdirSync(customData, { recursive: true });
        resetDefaultPaths();

        // 1. Via CLI flags
        const byFlag = await runJson(
            [
                "--config-dir",
                customConfig,
                "--credentials-dir",
                customCreds,
                "--data-dir",
                customData,
                "account",
                "list",
            ],
            { home: SANDBOX_HOME },
        );
        assert.equal(byFlag.ok, true);
        assert.equal(byFlag.data.length, 1);
        assert.equal(byFlag.data[0].ownId, TEST_UID);
        assert.equal(byFlag.data[0].name, "CLI Custom Path Account");

        // 2. Via environment variables
        const byEnv = await runJson(["account", "info"], {
            home: SANDBOX_HOME,
            env: {
                ZALO_CONFIG_DIR: customConfig,
                ZALO_CREDENTIALS_DIR: customCreds,
                ZALO_DATA_DIR: customData,
            },
        });
        assert.equal(byEnv.ok, true);
        assert.equal(byEnv.data.ownId, TEST_UID);

        // 3. Via --env-file <path>
        const envFile = join(customRoot, "prod.env");
        writeFileSync(
            envFile,
            `ZALO_CONFIG_DIR=${customConfig}\nZALO_CREDENTIALS_DIR=${customCreds}\nZALO_DATA_DIR=${customData}\n`,
            "utf8",
        );
        const byEnvFile = await runJson(["--env-file", envFile, "account", "info"], {
            home: SANDBOX_HOME,
        });
        assert.equal(byEnvFile.ok, true);
        assert.equal(byEnvFile.data.ownId, TEST_UID);
    });
});
