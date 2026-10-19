/**
 * Static and behavioral guards ensuring the legacy mobile sync path
 * (pollSync / runLegacySync / pullMobileMsg / getCrossDB / deleteSnapshotMobileMsg)
 * remains completely retired and is never reintroduced.
 *
 * Background:
 * The old phone-transfer path nudged the mobile app via `pullMobileMsg`, polled
 * `getCrossDB`, and acked with `deleteSnapshotMobileMsg`. In modern Zalo Web, those
 * endpoints are completely unused (0 call sites) and always return empty.
 * Full-history restore runs exclusively over WebSocket binary frames via
 * transfer-sync-v2 (cmd 590/591, src/core/sync-v2/).
 *
 * This suite guards that:
 *  1. `SyncManager` does not expose `pollSync` or generate legacy RSA keys.
 *  2. `src/commands/sync.js` does not have `runLegacySync` or `--legacy`.
 *  3. `src/core/sync.js` and `src/commands/listen.js` have zero calls to the retired endpoints.
 *  4. Gap reporting in `listen.js` remains intact and reports downtime unconditionally.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SyncManager } from "../../src/core/sync.js";

const SRC_DIR = join(import.meta.dirname, "..", "..", "src");
const SYNC_CORE = readFileSync(join(SRC_DIR, "core", "sync.js"), "utf8");
const SYNC_CMD = readFileSync(join(SRC_DIR, "commands", "sync.js"), "utf8");

/**
 * Source with comments removed. The "does listen.js call this?" guards below
 * must answer about code, not prose.
 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const LISTEN_SRC = readFileSync(join(SRC_DIR, "commands", "listen.js"), "utf8");
const LISTEN_CODE = stripComments(LISTEN_SRC);

describe("legacy mobile sync path is fully retired", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    it("SyncManager no longer exposes pollSync", () => {
        assert.equal(typeof SyncManager.prototype.pollSync, "undefined", "pollSync must be removed from SyncManager");
    });

    it("SyncManager does not generate legacy rsa_keys.json or require sync session dir", () => {
        const sm = new SyncManager({}, "dummy_account");
        assert.equal(typeof sm.keys, "undefined", "SyncManager must not generate RSA keys");
        assert.equal(typeof sm.syncSessionDir, "undefined", "SyncManager must not maintain a syncSessionDir");
    });

    it("src/commands/sync.js no longer defines runLegacySync or option -L, --legacy", () => {
        assert.ok(!/async\s+function\s+runLegacySync/.test(SYNC_CMD), "runLegacySync must not exist in sync.js");
        assert.ok(!/--legacy/.test(SYNC_CMD), "--legacy option must not exist in sync.js");
    });

    it("src/core/sync.js does not call retired endpoints", () => {
        const coreCode = stripComments(SYNC_CORE);
        assert.ok(
            !/pullMobileMsg|getCrossDB|deleteSnapshotMobileMsg/.test(coreCode),
            "sync.js must not call retired endpoints",
        );
    });
});

describe("listen.js gap reporting guards", () => {
    it("listen.js never calls the retired path again", () => {
        assert.ok(!/pollSync\s*\(/.test(LISTEN_CODE), "listen.js must not call pollSync");
        assert.ok(!/pullMobileMsg|getCrossDB/.test(LISTEN_CODE), "listen.js must not call the retired endpoints");
    });

    it("listen.js tells the owner the command that does work", () => {
        assert.ok(/describeGap\s*\(/.test(LISTEN_CODE), "gap reporting goes through describeGap()");
        assert.ok(
            !/Attempting mobile-sync backfill/.test(LISTEN_SRC),
            "the daemon must not claim an attempt it does not make",
        );
        assert.ok(
            !/will be retried on next launch or/.test(LISTEN_SRC),
            "that retry promise pointed at a path that can never succeed",
        );
    });

    it("startup reports any downtime, with no threshold of its own", () => {
        const begin = LISTEN_CODE.indexOf("getLastConnectedAt");
        const end = LISTEN_CODE.indexOf("heartbeatTimer", begin);
        assert.ok(begin !== -1 && end > begin, "startup block not found — this guard has drifted from the source");
        const startup = LISTEN_CODE.slice(begin, end);
        assert.ok(
            !/lastConnectedAt\s*[<>]|[<>]\s*lastConnectedAt/.test(startup),
            "no comparison on lastConnectedAt — the floor lives in recordGap()",
        );
        assert.ok(
            !/30\s*\*\s*1000|30000/.test(startup),
            "a re-added 30s gate would silently drop fast-restart gaps again",
        );
        assert.ok(
            /reportGap\s*\(\s*lastConnectedAt\s*,\s*["']startup-gap["']\s*\)/.test(startup),
            "startup must run the gap report unconditionally",
        );
        assert.ok(/markConnected\s*\(\s*\)/.test(startup), "the no-gap branch must still stamp connected");
    });
});
