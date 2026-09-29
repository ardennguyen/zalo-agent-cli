/**
 * zCloud sign-in for `sync-cloud`, checked against what Zalo Web sends.
 *
 * `sync-cloud` failed with "Invalid CloudViewerKey" — the client's own
 * INVALID_VIEWERKEY (-205) — because it skipped the handshake Zalo Web does
 * before touching zCloud. The web client's zCloud module (`tP1L`, bundle
 * 1.e0ef5e98f8f9d8970e2c.js @13433045, captured 2026-09-29) shows the whole of it:
 *
 *   key      GET  https://wpa.chat.zalo.me/api/getCloudViewerKey?zpw_ver&zpw_type   (no params,
 *                 session-encrypted response {viewer_key, enk})
 *   header   cloud-viewer-key: <viewer_key>   on every zCloud call
 *   params   encodeURIComponent(base64(iv16 ‖ AES-CBC(JSON, base64decode(enk))))   (module 98yS)
 *   verify   GET  zcld /cloudmedia/queue/pc/verify      {lastNoiseId, loadType, listNoiseIds, tracking_source}
 *   urls     GET  zcld /cloudmedia/downloadurls/pc/v1   {list_noise_ids}, 100 ids per call
 *   quota    GET  zcld /cloudmedia/info/pc/v2/usage, /cloudmedia/info/pc/v1/cloud-settings
 *   replies  error_code 0 or -904 accepted; `data` decrypted with enk, first 16 bytes = IV
 *
 * Every request below runs through zca-js's real `request()` into a stub fetch
 * (`ctx.options.polyfill`, zca-js's own HTTP seam). The stub decrypts `params`
 * with the web client's `98yS.decryptAES` re-run in crypto-js — not with the
 * module under test — so these assertions are about the bytes on the wire.
 *
 * Keys, ids and viewer keys are throwaway constants (AGENTS.md §12). No socket,
 * no session, no network.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getCloudItems, getCloudItemByMsgId } from "../../src/core/db.js";
import * as zcloud from "../../src/core/sync-v2/zcloud.js";

const require = createRequire(import.meta.url);
const zcaRequire = createRequire(require.resolve("zca-js"));
const CryptoJS = zcaRequire("crypto-js");
const { encodeAES } = zcaRequire("./utils.cjs");

// ── throwaway material ──────────────────────────────────────────────────────
const SESSION_KEY = Buffer.alloc(16, 0x11).toString("base64");
const ENK = Buffer.alloc(32, 0x5a).toString("base64");
const ENK_FRESH = Buffer.alloc(32, 0x6b).toString("base64");
const VK_LOGIN = "test-viewer-key.login";
const VK_FRESH = "test-viewer-key.fresh";
const VK_STALE = "test-viewer-key.stale";
const OWN = "1000000000000000001";
const PEER = "1000000000000000002";
const GROUP = "2000000000000000001";

const ZCLD = "https://zcld.chat.zalo.me";
const AUTH = "https://wpa.chat.zalo.me";
const P = {
    key: "/api/getCloudViewerKey",
    verify: "/cloudmedia/queue/pc/verify",
    urls: "/cloudmedia/downloadurls/pc/v1",
    usage: "/cloudmedia/info/pc/v2/usage",
    settings: "/cloudmedia/info/pc/v1/cloud-settings",
};

// ── the web client's cipher (98yS @2868035), as the oracle ──────────────────
const bytes = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));

function webEncryptAES(t, n) {
    const e = CryptoJS.enc.Base64.parse(n);
    const a = CryptoJS.lib.WordArray.random(16);
    const s = CryptoJS.AES.encrypt(t, e, { iv: a, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).ciphertext;
    return a.concat(s).toString(CryptoJS.enc.Base64);
}

function webDecryptAES(t, n) {
    const e = bytes(n);
    const a = bytes(t);
    return CryptoJS.AES.decrypt(
        { ciphertext: CryptoJS.lib.WordArray.create(a.slice(16, a.length)), salt: "" },
        CryptoJS.lib.WordArray.create(e),
        { iv: CryptoJS.lib.WordArray.create(a.slice(0, 16)), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    ).toString(CryptoJS.enc.Utf8);
}

/** A recorded request's `params`, decrypted the way zCloud's server would. */
function plain(call, enk = ENK) {
    assert.equal(typeof call?.params, "string", "zCloud params travel in the query string");
    return JSON.parse(webDecryptAES(call.params, enk));
}

// ── fake transport ──────────────────────────────────────────────────────────
function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

/** An auth-domain reply: the ordinary session envelope. */
const sessionOk = (data) =>
    response({
        error_code: 0,
        error_message: "Successful.",
        data: encodeAES(SESSION_KEY, JSON.stringify({ error_code: 0, error_message: "", data })),
    });

/** A zCloud reply: `data` is the payload itself, encrypted with enk. */
const cloudOk = (payload, enk = ENK) =>
    response({ error_code: 0, error_message: "Successful.", data: webEncryptAES(JSON.stringify(payload), enk) });

const cloudErr = (code, message) => response({ error_code: code, error_message: message });

/**
 * A logged-in-looking api whose every HTTP request lands in `calls`.
 *
 * @param {object} [opts]
 * @param {object} [opts.loginInfo] - what zca-js keeps as ctx.loginInfo
 * @param {Record<string, (call: object) => object>} [opts.routes] - pathname -> reply
 */
function harness({ loginInfo = { zcloud: { viewer_key: VK_LOGIN, enk: ENK } }, routes = {} } = {}) {
    const calls = [];
    const ctx = {
        secretKey: SESSION_KEY,
        imei: "test-imei-0000",
        userAgent: "zalo-agent-cli-offline-test",
        language: "vi",
        uid: OWN,
        API_VERSION: 691,
        API_TYPE: 30,
        loginInfo,
        options: {
            logging: false,
            agent: undefined,
            async polyfill(url, init = {}) {
                const u = new URL(url);
                const call = {
                    origin: u.origin,
                    path: u.pathname,
                    method: init.method || "GET",
                    headers: { ...(init.headers || {}) },
                    body: init.body,
                    query: Object.fromEntries(u.searchParams),
                    params: u.searchParams.get("params"),
                };
                calls.push(call);
                const route = routes[u.pathname];
                return route
                    ? route(call)
                    : response({ error_code: -9999, error_message: `no stub for ${u.pathname}` });
            },
        },
    };
    const api = { zpwServiceMap: { zcloud: [ZCLD] }, getContext: () => ctx, getOwnId: () => OWN };
    return { api, calls, to: (path) => calls.filter((c) => c.path === path) };
}

const MSG_INFO = {
    cliMsgId: 1790000000001,
    glbMsgId: "glb-x",
    msgType: "chat.photo",
    srcId: PEER,
    destId: OWN,
    destType: 3,
    ts: 1_790_000_000_000,
    isE2EE: 0,
};

/** A verify-queue entry shaped like the live cmd 620 capture, action add. */
const addItem = (noiseId, over = {}) => ({
    noiseId,
    action: 1,
    actionType: 1,
    msgInfo: { ...MSG_INFO, glbMsgId: `glb-${noiseId}` },
    mediaInfo: { mediaSize: 2048 },
    encryptInfo: { encryptKey: "opaque-e2ee-wrapped-key==" },
    ts: 1_790_000_000_100,
    ...over,
});

const page = (mediaItems, lastNoiseId = "", hasMore = 0) => ({ mediaItems, lastNoiseId, hasMore });

// ── db per test ─────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "zalo-zcloud-signin-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

describe("zcloud sign-in — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("zCloud requests go out the way Zalo Web sends them", () => {
    it("verify is a GET to zcld carrying the cloud-viewer-key header, not a session-encrypted POST", async () => {
        const h = harness({ routes: { [P.verify]: () => cloudOk(page([])) } });
        await zcloud.syncCloudIndex({ api: h.api, maxPages: 1 });
        const verifies = h.to(P.verify);
        assert.equal(verifies.length, 1, "one verify request");
        const [v] = verifies;
        assert.equal(v.origin, ZCLD);
        assert.equal(v.method, "GET");
        assert.equal(v.body, undefined, "a GET carries no body");
        assert.equal(v.headers["cloud-viewer-key"], VK_LOGIN);
        assert.equal(v.query.zpw_ver, "691");
        assert.equal(v.query.zpw_type, "30");
    });

    it("verify params are enk-encrypted {lastNoiseId, loadType, listNoiseIds, tracking_source}", async () => {
        const h = harness({ routes: { [P.verify]: () => cloudOk(page([])) } });
        await zcloud.syncCloudIndex({ api: h.api, lastNoiseId: "resume-cursor", maxPages: 1 });
        assert.deepEqual(plain(h.to(P.verify)[0]), {
            lastNoiseId: "resume-cursor",
            loadType: 1,
            listNoiseIds: [],
            tracking_source: 0,
        });
    });

    it("download URLs are a GET for {list_noise_ids}; ids the server gives no URL for come back unresolved", async () => {
        const h = harness({
            routes: { [P.urls]: () => cloudOk({ download_urls: { "nz-a": "https://cdn.invalid/a" } }) },
        });
        const r = await zcloud.fetchCloudDownloadUrl(h.api, ["nz-a", "nz-b"]).catch((e) => e);
        const [c] = h.to(P.urls);
        assert.equal(c?.origin, ZCLD);
        assert.equal(c.method, "GET");
        assert.equal(c.headers["cloud-viewer-key"], VK_LOGIN);
        assert.deepEqual(plain(c), { list_noise_ids: ["nz-a", "nz-b"] });
        assert.ok(!(r instanceof Error), `the reply must decode: ${r?.message}`);
        assert.deepEqual(r.urls, { "nz-a": "https://cdn.invalid/a" });
        assert.deepEqual(r.unresolved, ["nz-b"]);
    });

    it("download URLs are requested 100 noise ids at a time, as the web client batches them", async () => {
        const h = harness({
            routes: {
                [P.urls]: (c) => {
                    const ids = plain(c).list_noise_ids;
                    return cloudOk({
                        download_urls: Object.fromEntries(ids.map((id) => [id, `https://cdn.invalid/${id}`])),
                    });
                },
            },
        });
        const ids = Array.from({ length: 250 }, (_, i) => `nz-${i}`);
        const r = await zcloud.fetchCloudDownloadUrl(h.api, ids);
        assert.deepEqual(
            h.to(P.urls).map((c) => plain(c).list_noise_ids.length),
            [100, 100, 50],
        );
        assert.equal(Object.keys(r.urls).length, 250);
    });

    it("quota: usage and cloud-settings are header-authenticated GETs, summarized with the per-file limit", async () => {
        const h = harness({
            routes: {
                [P.usage]: () =>
                    cloudOk({
                        plan: 0,
                        quota: 107374182400,
                        usage: 1073741824,
                        service_usage: { cloud_media: 1073741000, message_backup: 624, my_cloud: 200 },
                    }),
                [P.settings]: () =>
                    cloudOk({
                        cloud_media_file_size_limit: 2147483640,
                        my_cloud_file_size_limit: 2147483640,
                        enable_offload: 1,
                        enable_community: 0,
                        opt_in: 7,
                    }),
            },
        });
        const q = await zcloud.getCloudQuota(h.api);
        for (const path of [P.usage, P.settings]) {
            const [c] = h.to(path);
            assert.equal(c?.origin, ZCLD, path);
            assert.equal(c.method, "GET", path);
            assert.equal(c.headers["cloud-viewer-key"], VK_LOGIN, path);
            assert.equal(c.params, null, `${path} takes no params`);
        }
        assert.equal(q.plan, "zcloud");
        assert.equal(q.quotaBytes, 107374182400);
        assert.equal(q.usageBytes, 1073741824);
        assert.equal(q.freeBytes, 107374182400 - 1073741824);
        assert.equal(q.overQuota, false);
        assert.equal(q.perFileLimitBytes, 2147483640);
        assert.deepEqual(q.optIn, { media: true, mycloud: true, backup: true });
    });

    it("flags over-quota as usage > quota and decodes the plan and opt-in bits", () => {
        const q = zcloud.summarizeCloudQuota(
            { plan: 100, quota: 10, usage: 11 },
            { cloud_media_file_size_limit: 5, opt_in: 1 },
        );
        assert.equal(q.plan, "grace_period");
        assert.equal(q.overQuota, true);
        assert.equal(q.freeBytes, 0);
        assert.deepEqual(q.optIn, { media: true, mycloud: false, backup: false });

        const full = zcloud.summarizeCloudQuota({ plan: -1, quota: 10, usage: 10 }, { opt_in: 2 });
        assert.equal(full.plan, "free");
        assert.equal(full.overQuota, false, "exactly at quota is not over it: the client's rule is usage > quota");
        assert.deepEqual(full.optIn, { media: false, mycloud: true, backup: false });
    });
});

describe("the viewer key", () => {
    it("comes from the login info's zcloud field when it carries both halves, with no extra request", async () => {
        const h = harness({ routes: { [P.verify]: () => cloudOk(page([])) } });
        const stats = await zcloud.syncCloudIndex({ api: h.api, maxPages: 1 });
        assert.equal(h.to(P.key).length, 0, "no getCloudViewerKey call when login info carries the key");
        assert.equal(plain(h.to(P.verify)[0], ENK).loadType, 1, "params decrypt with the login-info enk");
        assert.equal(stats.failed, 0);
    });

    it("is fetched with a plain GET to wpa.chat.zalo.me/api/getCloudViewerKey when login info has none", async () => {
        const h = harness({
            loginInfo: {},
            routes: {
                [P.key]: () => sessionOk({ viewer_key: VK_FRESH, enk: ENK_FRESH }),
                [P.verify]: () => cloudOk(page([]), ENK_FRESH),
            },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api, maxPages: 1 });
        const keys = h.to(P.key);
        assert.equal(keys.length, 1, "exactly one getCloudViewerKey request");
        assert.equal(keys[0].origin, AUTH);
        assert.equal(keys[0].method, "GET");
        assert.equal(keys[0].params, null, "getCloudViewerKey takes no params");
        assert.equal(keys[0].query.zpw_type, "30");
        const [v] = h.to(P.verify);
        assert.equal(v?.headers["cloud-viewer-key"], VK_FRESH);
        assert.equal(plain(v, ENK_FRESH).loadType, 1);
        assert.equal(stats.failed, 0);
    });

    it("getCloudViewerKey() asks the auth domain, not zcld, and returns the pair", async () => {
        const h = harness({
            loginInfo: {},
            routes: { [P.key]: () => sessionOk({ viewer_key: VK_FRESH, enk: ENK_FRESH }) },
        });
        const key = await zcloud.getCloudViewerKey(h.api);
        assert.deepEqual(
            h.calls.map((c) => `${c.method} ${c.origin}${c.path}`),
            [`GET ${AUTH}${P.key}`],
        );
        assert.equal(key.viewerKey, VK_FRESH);
        assert.equal(key.enk, ENK_FRESH);
    });

    it("accepts the key payload as a JSON string, as the web client does", async () => {
        const h = harness({
            loginInfo: {},
            routes: { [P.key]: () => sessionOk(JSON.stringify({ viewer_key: VK_FRESH, enk: ENK_FRESH })) },
        });
        const key = await zcloud.getCloudViewerKey(h.api);
        assert.equal(key.viewerKey, VK_FRESH);
        assert.equal(key.enk, ENK_FRESH);
    });

    it("on -205 with the login-info key, refreshes it once through getCloudViewerKey and retries", async () => {
        const h = harness({
            loginInfo: { zcloud: { viewer_key: VK_STALE, enk: ENK } },
            routes: {
                [P.key]: () => sessionOk({ viewer_key: VK_FRESH, enk: ENK_FRESH }),
                [P.verify]: (c) =>
                    c.headers["cloud-viewer-key"] === VK_FRESH
                        ? cloudOk(page([addItem("nz-1")]), ENK_FRESH)
                        : cloudErr(-205, "Invalid CloudViewerKey"),
            },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api });
        assert.deepEqual(
            h.calls.map((c) => c.path),
            [P.verify, P.key, P.verify],
        );
        assert.equal(h.to(P.verify)[1].headers["cloud-viewer-key"], VK_FRESH);
        assert.equal(stats.failed, 0);
        assert.equal(stats.items, 1);
    });

    it("does not loop when a freshly fetched key is rejected as well", async () => {
        const h = harness({
            loginInfo: {},
            routes: {
                [P.key]: () => sessionOk({ viewer_key: VK_FRESH, enk: ENK_FRESH }),
                [P.verify]: () => cloudErr(-205, "Invalid CloudViewerKey"),
            },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api });
        assert.equal(h.to(P.key).length, 1, "one key fetch");
        assert.equal(h.to(P.verify).length, 1, "no retry with the same fresh key");
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /-205/);
    });

    it("stops before calling zCloud when the account has no viewer key", async () => {
        const h = harness({
            loginInfo: {},
            routes: { [P.key]: () => sessionOk({ viewer_key: "", enk: "" }), [P.verify]: () => cloudOk(page([])) },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api });
        assert.equal(h.to(P.verify).length, 0, "no zCloud request without a key");
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /viewer key/i);
    });
});

describe("zCloud responses and paging", () => {
    it("decrypts verify replies with enk and pages on lastNoiseId while hasMore is set", async () => {
        let calls = 0;
        const h = harness({
            routes: {
                [P.verify]: () =>
                    ++calls === 1
                        ? cloudOk(page([addItem("nz-1")], "cur-1", 1))
                        : cloudOk(page([addItem("nz-2")], "cur-2", 0)),
            },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api });
        assert.deepEqual(
            h.to(P.verify).map((c) => plain(c).lastNoiseId),
            ["", "cur-1"],
        );
        assert.equal(stats.items, 2);
        assert.equal(stats.complete, true);
        assert.equal(stats.lastNoiseId, "cur-2");
        assert.equal(getCloudItems().length, 2);
    });

    it("accepts error_code -904 as success, as the client's reply handler does", async () => {
        const h = harness({
            routes: {
                [P.verify]: () =>
                    response({
                        error_code: -904,
                        error_message: "",
                        data: webEncryptAES(JSON.stringify(page([addItem("nz-904")])), ENK),
                    }),
            },
        });
        const stats = await zcloud.syncCloudIndex({ api: h.api });
        assert.equal(stats.failed, 0, stats.failures[0]?.reason);
        assert.equal(getCloudItemByMsgId("glb-nz-904")?.noiseId, "nz-904");
    });

    it("keeps paging past a page shorter than --page-size while the server says hasMore", async () => {
        // The verify request carries no page size, so the server's page length says
        // nothing about whether more follows; only hasMore does. The envelope key is
        // incidental here (`items` and `mediaItems` are both read).
        let calls = 0;
        const stats = await zcloud.syncCloudIndex({
            pageSize: 300,
            verify: async () =>
                ++calls === 1
                    ? { items: [addItem("a"), addItem("b"), addItem("c")], lastNoiseId: "c1", hasMore: 1 }
                    : { items: [addItem("d")], lastNoiseId: "c2", hasMore: 0 },
        });
        assert.equal(calls, 2, "hasMore on a 3-item page must fetch the next page");
        assert.equal(stats.items, 4);
        assert.equal(stats.complete, true);
    });

    it("does not claim a walk stopped by --pages is complete", async () => {
        let calls = 0;
        const stats = await zcloud.syncCloudIndex({
            maxPages: 2,
            verify: async () => {
                calls++;
                return page([addItem(`p${calls}`)], `c${calls}`, 1);
            },
        });
        assert.equal(calls, 2);
        assert.equal(stats.complete, false);
        assert.equal(stats.lastNoiseId, "c2");
    });
});

describe("zCloud is a partial source", () => {
    it("records only entries the queue marks as added; remove, del_thread and reset entries are not cloud items", async () => {
        // A recall arrives as action 2 (remove) with msgType chat.undo (live cmd 620
        // capture); its noiseId names the queue entry, not a media item. The web
        // client applies these as deletions (tP1L verifyFromId: onAdd/onDel/onDelThread).
        const undo = addItem("nz-undo", {
            action: 2,
            msgInfo: { ...MSG_INFO, glbMsgId: "glb-undo", msgType: "chat.undo" },
        });
        const stats = await zcloud.syncCloudIndex({
            verify: async () => ({
                items: [addItem("nz-add"), undo, addItem("nz-del", { action: 3 }), addItem("nz-reset", { action: 5 })],
            }),
        });
        assert.deepEqual(
            getCloudItems().map((r) => r.noiseId),
            ["nz-add"],
        );
        assert.equal(getCloudItemByMsgId("glb-undo"), null);
        assert.equal(stats.items, 1);
    });

    it("reads the real item shape: glbMsgId, msgInfo.ts, mediaInfo.mediaSize and the web's conversation id", () => {
        const group = zcloud.normalizeCloudItem(
            addItem("g", { msgInfo: { ...MSG_INFO, glbMsgId: "glb-g", srcId: PEER, destId: GROUP, destType: 6 } }),
            OWN,
        );
        const incoming = zcloud.normalizeCloudItem(
            addItem("in", { msgInfo: { ...MSG_INFO, glbMsgId: "glb-in", srcId: PEER, destId: OWN, destType: 3 } }),
            OWN,
        );
        const outgoing = zcloud.normalizeCloudItem(
            addItem("out", { msgInfo: { ...MSG_INFO, glbMsgId: "glb-out", srcId: OWN, destId: PEER, destType: 3 } }),
            OWN,
        );
        assert.equal(group.threadId, GROUP, "a group item belongs to destId");
        assert.equal(incoming.threadId, PEER, "an incoming DM belongs to the sender");
        assert.equal(outgoing.threadId, PEER, "an outgoing DM belongs to the recipient");
        assert.equal(incoming.msgId, "glb-in");
        assert.equal(incoming.timestamp, 1_790_000_000_000);
        assert.equal(incoming.mediaSize, 2048);
    });

    it("resolves a DM's conversation with the logged-in account's id during a walk", async () => {
        const h = harness({ routes: { [P.verify]: () => cloudOk(page([addItem("nz-in")])) } });
        await zcloud.syncCloudIndex({ api: h.api });
        assert.equal(getCloudItemByMsgId("glb-nz-in")?.threadId, PEER);
    });

    it("treats a lookup miss as inconclusive, never as proof that the item does not exist", async () => {
        const miss = zcloud.lookupCloudBackup("glb-never-seen");
        assert.equal(miss.found, false);
        assert.equal(miss.conclusive, false);
        await zcloud.syncCloudIndex({ verify: async () => page([addItem("nz-hit")]) });
        const hit = zcloud.lookupCloudBackup("glb-nz-hit");
        assert.equal(hit.found, true);
        assert.equal(hit.item.noiseId, "nz-hit");
    });
});
