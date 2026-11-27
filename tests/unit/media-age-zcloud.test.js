/**
 * The clock rule and the zCloud source of the media downloader (src/core/sync-v2/media.js, ./media-age.js):
 *
 * - a file past the CDN's keeping window gets no request: it is sorted locally as kept in zCloud or as gone, and a
 *   gone row is skipped by later runs at no cost;
 * - with the opt-in zCloud source and the account's cloud key, a file the zCloud index lists is fetched from zCloud,
 *   decrypted, sealed and recorded exactly as a CDN download is;
 * - the cloud key is never logged, stored or returned; zalo_view_media names the command instead of taking one.
 *
 * A throwaway HTTP server stands in for both the CDN and zCloud's blob store; the key pair is generated per run.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    countGoneAttachments,
    countPendingAttachments,
    getMessages,
    initDb,
    insertMessage,
    markMediaGone,
    upsertCloudItem,
    upsertThread,
} from "../../src/core/db.js";
import { OLD_NO_ANSWER_RETRY_WAITS, downloadSyncedMedia } from "../../src/core/sync-v2/media.js";
import {
    BIG_FILE_BYTES,
    BIG_FILE_KEEP_MS,
    CDN_KEEP_MS,
    cdnKeepMs,
    pastCdnWindow,
} from "../../src/core/sync-v2/media-age.js";
import { scopeOfDir } from "../../src/core/keystore/keyring.js";
import { readMediaFile } from "../../src/core/keystore/media-seal.js";
import { importCloudPrivateKey } from "../../src/zalo/zcloud-e2ee.js";
import { openCloudSource } from "../../src/commands/sync.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

assertSandboxed(CONFIG_DIR);

const DAY = 86_400_000;
const NOW = Date.now();
const ROOT = mkdtempSync(join(tmpdir(), "zalo-media-age-"));
const PLAIN = Buffer.from("\xff\xd8\xff\xe0JFIF-the-photo-from-zcloud", "binary");

/** The test's cloud key pair, and another account's (a key that does not open). */
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_B64 = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
/** The account's cloud key, as a run holds it. */
const key = () => importCloudPrivateKey(KEY_B64);
const OTHER_B64 = other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

/** Encrypt a file the way a zCloud blob is: AES-256-GCM, its key, IV and tag packed and RSA-OAEP-SHA256 wrapped. */
function encryptBlob(plain, publicKey) {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(plain), c.final()]);
    const packed = Buffer.concat([key, iv, c.getAuthTag()]);
    const wrapped = publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        packed,
    );
    return { enc, wrapped: wrapped.toString("base64") };
}

/** The block-by-block version: AES-256-CTR per 4096-byte block, each from the same IV; the packed key has no tag. */
function encryptBlocks(plain, publicKey) {
    const key = randomBytes(32);
    const iv = Buffer.concat([randomBytes(12), Buffer.alloc(4)]);
    const parts = [];
    for (let at = 0; at < plain.length; at += 4096) {
        const c = createCipheriv("aes-256-ctr", key, iv);
        parts.push(c.update(plain.subarray(at, at + 4096)), c.final());
    }
    const wrapped = publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.concat([key, iv]),
    );
    return { enc: Buffer.concat(parts), wrapped: wrapped.toString("base64") };
}

let server;
let base;
let hits;
/** Per request URL (path and query), the `connection` header of each request that reached the server. */
let asked;
/** noiseId -> encrypted blob served at /cloud/<noiseId>. */
const blobs = new Map();

before(async () => {
    server = createServer((req, res) => {
        // One connection per request. A kept-alive socket left idle between two tests is closed by this server's
        // keep-alive timer (5 s) while the client, slowed by a loaded machine, may already be writing its next request
        // to it: that request dies as "other side closed" / ECONNRESET before it reaches this handler, and the test
        // reads a network failure where it asserts a 404, a zCloud fetch or a hit.
        res.setHeader("connection", "close");
        const path = req.url.split("?")[0];
        hits[path] = (hits[path] || 0) + 1;
        (asked[req.url] ??= []).push(req.headers.connection ?? null);
        const nth = asked[req.url].length;
        if (path.startsWith("/cdn/ok")) {
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(Buffer.from("cdn-bytes"));
        }
        if (path.startsWith("/cdn/bad-gateway")) {
            res.writeHead(502);
            return res.end("");
        }
        // No answer on the first request for a link, then a real one: the file, or a 404.
        if (path.startsWith("/cdn/flaky")) {
            if (nth === 1) return req.socket.destroy();
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(Buffer.from("cdn-bytes"));
        }
        if (path.startsWith("/cdn/drop-then-gone")) {
            if (nth === 1) return req.socket.destroy();
            res.writeHead(404);
            return res.end("gone");
        }
        if (path.startsWith("/cdn/drop")) {
            return req.socket.destroy();
        }
        if (path.startsWith("/cdn/gone")) {
            res.writeHead(404);
            return res.end("gone");
        }
        if (path.startsWith("/cloud/")) {
            const blob = blobs.get(path.slice("/cloud/".length));
            if (!blob) {
                res.writeHead(404);
                return res.end("");
            }
            res.writeHead(200, { "content-type": "application/octet-stream" });
            return res.end(blob);
        }
        res.writeHead(500);
        res.end("");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((r) => server.close(r));
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* an open database handle on Windows is not worth failing the run over */
    }
});

let dir;
let n = 0;
beforeEach(() => {
    hits = {};
    asked = {};
    blobs.clear();
    dir = join(ROOT, `acct${n++}`);
    initDb(join(ROOT, `db${n}.sqlite`));
    upsertThread({ threadId: "t1", type: "group", name: "Team", lastUpdate: 1 });
});

/** A message with one photo, sent `daysAgo` days ago; its client id makes its zCloud key. */
function row({ msgId, daysAgo, threadId = "t1", path = "/cdn/ok.jpg", size } = {}) {
    const id = msgId || `m${Math.random().toString(36).slice(2)}`;
    insertMessage({
        msgId: id,
        threadId,
        senderId: "u1",
        senderName: "",
        text: "[photo]",
        timestamp: NOW - daysAgo * DAY,
        type: "photo",
        has_attachment: true,
        raw_data: {
            src: "sync-v2",
            cliMsgId: `c-${id}`,
            attachments: [{ kind: "photo", url: `${base}${path}?m=${id}`, ...(size ? { size } : {}) }],
        },
    });
    return id;
}

/** List a message in the local zCloud index, its blob encrypted for `publicKey` and served at /cloud/<noiseId>. */
function inCloud(msgId, { threadId = "t1", publicKey = pair.publicKey, algoVersion, serve = true } = {}) {
    const noiseId = `n-${msgId}`;
    const { enc, wrapped } = algoVersion === "2" ? encryptBlocks(PLAIN, publicKey) : encryptBlob(PLAIN, publicKey);
    if (serve) blobs.set(noiseId, enc);
    upsertCloudItem({
        noiseId,
        threadId,
        msgId,
        zKey: `c-${msgId}_${threadId}_u1`,
        encryptKey: wrapped,
        algoVersion: algoVersion ?? null,
        timestamp: NOW - 20 * DAY,
        raw_data: JSON.stringify({ encryptInfo: { encryptKey: wrapped, ...(algoVersion ? { algoVersion } : {}) } }),
    });
    return noiseId;
}

/** The zCloud source with a blob fetch against the stand-in server (the account's real one needs a session). */
const cloudWith = (privateKey) => ({
    privateKey,
    fetchBlob: async (item, { signal } = {}) => {
        const res = await fetch(`${base}/cloud/${item.noiseId}`, { signal });
        if (!res.ok)
            throw Object.assign(new Error(`zCloud download failed with HTTP ${res.status}`), { code: res.status });
        const encrypted = Boolean(item.encryptInfo?.encryptKey) && !item.cloudConversation;
        return {
            bytes: Buffer.from(await res.arrayBuffer()),
            encrypted,
            wrappedKey: encrypted ? item.encryptInfo.encryptKey : null,
            algoVersion: encrypted ? (item.encryptInfo.algoVersion ?? null) : null,
            contentType: null,
        };
    },
});

const run = (extra = {}) => downloadSyncedMedia({ accountDir: dir, limit: 50, backoffBaseMs: 0, now: NOW, ...extra });
const cdnHits = () =>
    Object.entries(hits)
        .filter(([p]) => p.startsWith("/cdn/"))
        .reduce((a, [, v]) => a + v, 0);

describe("the CDN's keeping window (media-age.js)", () => {
    it("is 14 days, and 7 for a file over 100 MB", () => {
        assert.equal(CDN_KEEP_MS, 14 * DAY);
        assert.equal(BIG_FILE_KEEP_MS, 7 * DAY);
        assert.equal(BIG_FILE_BYTES, 100 * 1024 * 1024);
        assert.equal(cdnKeepMs({ size: BIG_FILE_BYTES }), CDN_KEEP_MS, "exactly 100 MB is not over it");
        assert.equal(cdnKeepMs({ size: BIG_FILE_BYTES + 1 }), BIG_FILE_KEEP_MS);
    });

    it("13 days is inside, 15 days is past", () => {
        assert.equal(pastCdnWindow({ timestamp: NOW - 13 * DAY, threadId: "t1" }, {}, { now: NOW }), false);
        assert.equal(pastCdnWindow({ timestamp: NOW - 15 * DAY, threadId: "t1" }, {}, { now: NOW }), true);
    });

    it("a big file is past after 7 days, a 100 MB one is not", () => {
        const at8 = { timestamp: NOW - 8 * DAY, threadId: "t1" };
        assert.equal(pastCdnWindow(at8, { size: BIG_FILE_BYTES + 1 }, { now: NOW }), true);
        assert.equal(pastCdnWindow(at8, { size: BIG_FILE_BYTES }, { now: NOW }), false);
        assert.equal(pastCdnWindow({ timestamp: NOW - 6 * DAY }, { size: BIG_FILE_BYTES + 1 }, { now: NOW }), false);
    });

    it("My Cloud is never past it", () => {
        assert.equal(
            pastCdnWindow({ timestamp: NOW - 400 * DAY, threadId: "own1" }, {}, { now: NOW, ownId: "own1" }),
            false,
        );
    });
});

describe("a file past the window: no file is written off by the clock", () => {
    it("asks the CDN for an old file zCloud does not list, and saves it when the CDN still has it", async () => {
        const id = row({ daysAgo: 20 });
        const stats = await run();
        assert.equal(stats.downloaded, 1, "past the window is not proof of gone");
        assert.equal(hits["/cdn/ok.jpg"], 1);
        assert.ok(getMessages("t1").find((m) => m.msgId === id).localPath);
        assert.equal(stats.oldGone, 0);
    });

    it("sorts it as gone only when the CDN answers 404, and never asks that link again", async () => {
        row({ daysAgo: 20, path: "/cdn/gone.jpg" });
        const first = await run();
        assert.equal(hits["/cdn/gone.jpg"], 1);
        assert.equal(first.oldGone, 1);
        assert.equal(countGoneAttachments(), 1);
        const second = await run();
        assert.equal(hits["/cdn/gone.jpg"], 1, "the dead link is not asked again");
        assert.equal(second.dead, 1);
        const retried = await run({ retryDead: true });
        assert.equal(hits["/cdn/gone.jpg"], 2, "--retry-dead asks again");
        assert.equal(retried.downloaded, 0);
    });

    it("an old link its server no longer serves (5xx) is gone, not throttling: the run goes on", async () => {
        for (let i = 0; i < 12; i++) row({ daysAgo: 800, path: "/cdn/bad-gateway.jpg" });
        const fresh = row({ daysAgo: 1 });
        const first = await run({ concurrency: 1 });
        assert.equal(first.abortedEarly, false, "a queue of dead old links must not stop the run");
        assert.equal(first.oldGone, 12);
        assert.equal(first.reasons["old-unavailable"], 12);
        assert.equal(first.throttled, 0);
        assert.ok(getMessages("t1").find((m) => m.msgId === fresh).localPath, "the file after them was fetched");
        const before = hits["/cdn/bad-gateway.jpg"];
        await run({ concurrency: 1, retryDead: false });
        assert.equal(hits["/cdn/bad-gateway.jpg"], before, "remembered: not asked again");
    });
});

describe("an old file zCloud does not list, and no answer at all (reset, refused, timeout)", () => {
    const tries = 1 + OLD_NO_ANSWER_RETRY_WAITS.length;

    it("is asked again on a connection of its own, and saved when the retry is answered", async () => {
        const id = row({ daysAgo: 20, path: "/cdn/flaky.jpg" });
        const stats = await run();
        assert.equal(stats.downloaded, 1, "one dropped connection does not write the file off");
        assert.equal(hits["/cdn/flaky.jpg"], 2);
        assert.deepEqual(Object.values(asked)[0].slice(1), ["close"], "the retry asks for a connection of its own");
        assert.ok(getMessages("t1").find((m) => m.msgId === id).localPath);
        assert.equal(stats.oldGone, 0);
        assert.equal(countGoneAttachments(), 0);
    });

    it("no answer after the retries: left pending, not gone, and the next run asks again", async () => {
        const id = row({ daysAgo: 800, path: "/cdn/drop.jpg" });
        const first = await run();
        assert.equal(hits["/cdn/drop.jpg"], tries, "the first request and each retry");
        assert.equal(first.downloaded, 0);
        assert.equal(first.oldGone, 0, "no answer is not gone");
        assert.equal(first.oldNoAnswer, 1);
        assert.equal(first.reasons["old-no-answer"], 1);
        assert.equal(first.reasons["old-unavailable"], undefined);
        assert.equal(countGoneAttachments(), 0);
        assert.equal(countPendingAttachments(), 1, "still pending");
        assert.equal(getMessages("t1").find((m) => m.msgId === id).localPath, null);
        const second = await run();
        assert.equal(hits["/cdn/drop.jpg"], 2 * tries, "not remembered as dead: asked again");
        assert.equal(second.dead, 0);
    });

    it("a row an earlier run marked gone is pending again", async () => {
        const id = row({ daysAgo: 800, path: "/cdn/drop.jpg" });
        markMediaGone(id, NOW);
        assert.equal(countGoneAttachments(), 1);
        await run();
        assert.equal(countGoneAttachments(), 0);
        assert.equal(countPendingAttachments(), 1);
    });

    it("a 404 to the retry is a real answer: gone, and never asked again", async () => {
        row({ daysAgo: 20, path: "/cdn/drop-then-gone.jpg" });
        const first = await run();
        assert.equal(hits["/cdn/drop-then-gone.jpg"], 2);
        assert.equal(first.oldGone, 1);
        assert.equal(countGoneAttachments(), 1);
        const second = await run();
        assert.equal(hits["/cdn/drop-then-gone.jpg"], 2, "the dead link is not asked again");
        assert.equal(second.dead, 1);
    });

    it("a stop during the wait leaves the row pending, not gone", async () => {
        row({ daysAgo: 20, path: "/cdn/drop.jpg" });
        const stop = new AbortController();
        const stats = await run({
            backoffBaseMs: 60_000,
            signal: stop.signal,
            onProgress: () => {},
            fetchImpl: async (url, init) => {
                setTimeout(() => stop.abort(), 10);
                return fetch(url, init);
            },
        });
        assert.equal(stats.interrupted, true);
        assert.equal(stats.oldGone, 0);
        assert.equal(countGoneAttachments(), 0);
        assert.equal(countPendingAttachments(), 1);
    });
});

describe("a file past the window: the rest of the clock rule", () => {
    it("gives a row sorted gone by the old clock rule its one request", async () => {
        const id = row({ daysAgo: 20 });
        markMediaGone(id, NOW);
        const stats = await run();
        assert.equal(stats.downloaded, 1);
        assert.equal(countGoneAttachments(), 0, "a saved file is no longer gone");
    });

    it("an old file kept in zCloud, with no key: the CDN is still asked, and a 404 says it is in zCloud", async () => {
        const id = row({ daysAgo: 20, path: "/cdn/gone.jpg" });
        inCloud(id);
        const stats = await run({ cloud: null });
        assert.equal(hits["/cdn/gone.jpg"], 1);
        assert.equal(stats.oldInCloud, 1);
        assert.equal(countPendingAttachments(), 1, "left for a run with the cloud key");
    });

    it("an old file kept in zCloud, with the key: zCloud first, and the CDN is not asked", async () => {
        const id = row({ daysAgo: 20 });
        inCloud(id);
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(stats.fromCloud, 1);
        assert.equal(cdnHits(), 0);
    });

    it("zCloud fails for an old file: the CDN is the fallback", async () => {
        const id = row({ daysAgo: 20 });
        inCloud(id, { serve: false });
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(stats.downloaded, 1);
        assert.equal(stats.fromCloud, 0);
        assert.equal(hits["/cdn/ok.jpg"], 1);
    });

    it("asks the CDN for a file inside the window, and for My Cloud at any age", async () => {
        row({ daysAgo: 13 });
        row({ daysAgo: 400, threadId: "own1" });
        const stats = await run({ ownId: "own1" });
        assert.equal(stats.downloaded, 2);
        assert.equal(cdnHits(), 2);
        assert.equal(stats.oldGone + stats.oldInCloud, 0);
    });
});

describe("the zCloud source", () => {
    it("fetches an old file from zCloud, decrypts it, seals it and records it like a CDN download", async () => {
        const id = row({ daysAgo: 30 });
        const noiseId = inCloud(id);
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(cdnHits(), 0, "the CDN is still not asked");
        assert.equal(hits[`/cloud/${noiseId}`], 1);
        assert.equal(stats.downloaded, 1);
        assert.equal(stats.fromCloud, 1);
        const saved = getMessages("t1").find((m) => m.msgId === id);
        assert.ok(saved.localPath, "localPath recorded");
        assert.ok(saved.localPath.startsWith(join(dir, "media", "t1")), "the normal layout: media/<threadId>/");
        assert.deepEqual(readMediaFile(saved.localPath, scopeOfDir(dir), { msgId: id }), PLAIN);
        assert.equal(readFileSync(saved.localPath).includes(PLAIN.subarray(4)), false, "sealed on disk");
    });

    it("tries zCloud for a fresh file whose CDN link failed", async () => {
        const id = row({ daysAgo: 2, path: "/cdn/gone.jpg" });
        inCloud(id);
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(hits["/cdn/gone.jpg"], 1);
        assert.equal(stats.fromCloud, 1);
        assert.equal(stats.downloaded, 1);
    });

    it("looks again at a row an earlier run sorted as gone, once the index lists it", async () => {
        const id = row({ daysAgo: 30, path: "/cdn/gone.jpg" });
        await run();
        assert.equal(countGoneAttachments(), 1);
        inCloud(id);
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(stats.fromCloud, 1);
        assert.equal(countGoneAttachments(), 0);
    });

    it("names each failure (no key, not found, does not decrypt) and opens a block-encrypted item", async () => {
        // Gone from the CDN too, so nothing rescues a zCloud failure.
        const gone = { daysAgo: 30, path: "/cdn/gone.jpg" };
        const noKey = row(gone);
        inCloud(noKey);
        const notFound = row(gone);
        inCloud(notFound, { serve: false });
        const wrong = row(gone);
        inCloud(wrong, { publicKey: other.publicKey });
        const block = row(gone);
        inCloud(block, { algoVersion: "2" });

        const withoutKey = await run({ cloud: cloudWith(null), msgIds: [noKey] });
        assert.deepEqual(withoutKey.reasons, { "cloud-no-key": 1 });

        const s = await run({ cloud: cloudWith(key()), msgIds: [notFound, wrong, block] });
        assert.deepEqual(s.reasons, { "cloud-not-found": 1, "cloud-decrypt": 1 });
        assert.equal(s.cloudFailed, 2);
        assert.equal(s.failed, 2);
        assert.equal(s.fromCloud, 1, "the block-encrypted item was fetched and opened");
        assert.equal(countPendingAttachments(), 3, "the failed ones stay pending");
    });

    it("with no source given, uses the account's stored cloud key on its own (null turns it off)", async () => {
        const id = row({ daysAgo: 30, path: "/cdn/gone.jpg" });
        inCloud(id);
        const stored = {
            loadStoredKey: () => ({ privateKeyPkcs8Base64: KEY_B64 }),
            cloudFetchBlob: cloudWith(null).fetchBlob,
        };
        const off = await run({ cloud: null, ...stored });
        assert.equal(off.fromCloud, 0, "an explicit null means no zCloud source");
        const auto = await run(stored);
        assert.equal(auto.fromCloud, 1, "omitted: the stored key opens it");
    });

    it("stops when there is no room left, leaving the rest pending", async () => {
        const first = row({ daysAgo: 30 });
        inCloud(first);
        const second = row({ daysAgo: 30 });
        inCloud(second);
        let checks = 0;
        const room = (added) => {
            checks++;
            return added > 0
                ? {
                      ok: false,
                      reason: "disk",
                      message: "the disk has 1 MB free and 2147 MB is kept free (quota.minFree)",
                  }
                : { ok: true, reason: null, message: null };
        };
        const stats = await run({ cloud: cloudWith(key()), concurrency: 1, room });
        assert.equal(stats.fromCloud, 1, "the first file fits, then the room runs out");
        assert.equal(stats.outOfRoom.reason, "disk");
        assert.ok(checks >= 2);
        assert.equal(countPendingAttachments(), 1, "the one not fetched stays pending");
    });

    it("keeps the key out of the result and off the disk", async () => {
        const id = row({ daysAgo: 30 });
        inCloud(id);
        const stats = await run({ cloud: cloudWith(key()) });
        assert.equal(stats.fromCloud, 1);
        const needle = KEY_B64.slice(40, 120);
        assert.equal(JSON.stringify(stats).includes(needle), false);
        const files = [];
        const walk = (d) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) walk(p);
                else files.push(p);
            }
        };
        walk(dir);
        for (const f of files) {
            if (statSync(f).size > 0) assert.equal(readFileSync(f).includes(needle), false, `${f} holds the key`);
        }
    });
});

describe("openCloudSource: the plan gate and the run-time key", () => {
    /** Run with console output captured. */
    async function quietly(fn) {
        const lines = [];
        const log = console.log;
        const err = console.error;
        console.log = (...a) => lines.push(a.join(" "));
        console.error = (...a) => lines.push(a.join(" "));
        try {
            return { result: await fn(), lines };
        } finally {
            console.log = log;
            console.error = err;
            // error() marks the process failed, as the command would exit 1; the test asserts the result instead.
            process.exitCode = 0;
        }
    }

    it("takes the key from standard input on a zCloud plan, and never prints it", async () => {
        const { result, lines } = await quietly(() =>
            openCloudSource(null, { keyStdin: true }, "own1", {
                usage: async () => ({ plan: 0 }),
                readStdin: async () => `${KEY_B64}\n`,
            }),
        );
        assert.deepEqual(Object.keys(result), ["privateKey"]);
        assert.equal(result.privateKey.asymmetricKeyType, "rsa");
        assert.equal(lines.join("\n").includes(KEY_B64.slice(40, 120)), false, "the key is not printed");
    });

    it("works in the grace period (100) and refuses a free plan (-1, 69) before asking for a key", async () => {
        let asked = 0;
        const ask = async () => {
            asked++;
            return KEY_B64;
        };
        const open = (plan) =>
            quietly(() =>
                openCloudSource(null, { keyStdin: true }, "own1", { usage: async () => ({ plan }), readStdin: ask }),
            );
        assert.ok((await open(100)).result);
        assert.equal((await open(-1)).result, null);
        assert.equal((await open(69)).result, null);
        assert.equal(asked, 1, "a free plan is refused before the key is read");
    });

    it("refuses a key that is not one, without echoing it", async () => {
        const { result, lines } = await quietly(() =>
            openCloudSource(null, { keyStdin: true }, "own1", {
                usage: async () => ({ plan: 0 }),
                readStdin: async () => "not-a-key-SECRETVALUE",
            }),
        );
        assert.equal(result, null);
        assert.equal(lines.join("\n").includes("SECRETVALUE"), false);
    });

    it("needs a key source when standard input is not a terminal", async () => {
        const { result } = await quietly(() =>
            openCloudSource(null, {}, "own1", { usage: async () => ({ plan: 0 }), isTTY: false }),
        );
        assert.equal(result, null);
    });

    it("uses a cloud key stored by `cloud key setup` when no run-time key is given", async () => {
        const { result } = await quietly(() =>
            openCloudSource(null, {}, "own1", {
                usage: async () => ({ plan: 0 }),
                isTTY: false,
                loadStoredKey: () => ({ privateKeyPkcs8Base64: KEY_B64 }),
            }),
        );
        assert.deepEqual(Object.keys(result), ["privateKey"]);
        assert.equal(result.privateKey.asymmetricKeyType, "rsa");
    });

    it("another account's key opens nothing: the download reports cloud-decrypt", async () => {
        const id = row({ daysAgo: 30, path: "/cdn/gone.jpg" });
        inCloud(id);
        const stats = await run({ cloud: cloudWith(importCloudPrivateKey(OTHER_B64)) });
        assert.deepEqual(stats.reasons, { "cloud-decrypt": 1 });
    });
});

describe("zalo_view_media never takes a key", () => {
    it("names the command for a file past the window that is kept in zCloud", async () => {
        const ID = "100000000000000979";
        const accountDir = join(CONFIG_DIR, "accounts", ID);
        initDb(join(ROOT, `view${n}.sqlite`));
        upsertThread({ threadId: "t1", type: "group", name: "Team", lastUpdate: 1 });
        const id = row({ msgId: "m-view-old", daysAgo: 40, path: "/cdn/gone.jpg" });
        inCloud(id);
        const tools = new Map();
        const server = { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
        registerTools(
            server,
            { getOwnId: () => ID },
            { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], getThreadType: () => "group" },
            { isWatched: () => true },
            {},
            { ready: true, get: () => null, search: () => [] },
            accountDir,
        );
        // The tool takes no key at all.
        const shape = tools.get("zalo_view_media").meta.inputSchema;
        const fields = Object.keys(shape.shape ?? shape);
        assert.equal(
            fields.some((f) => /key/i.test(f)),
            false,
        );

        const res = await tools.get("zalo_view_media").handler({ msgId: id, open: false });
        assert.equal(res.isError, true);
        const text = res.content[0].text;
        assert.match(text, /kept in zCloud/);
        assert.match(text, new RegExp(`zalo-agent cloud key setup --account ${ID} --confirm`));
        assert.equal(hits["/cdn/gone.jpg"], 1, "the CDN was asked first, and had nothing");
    });
});
