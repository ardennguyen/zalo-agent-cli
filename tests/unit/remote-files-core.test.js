/**
 * Files a caller hands the server (src/core/url-fetch.js, upload-store.js, file-inputs.js, deploy-policy.js
 * resolveUploads): the address guard on a fetched URL, the size and time caps, the upload store's quota, expiry and
 * one-time upload links, and how each kind of file item turns into a path, including the refusal a remote caller gets
 * for a path.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { UrlFetchError, fetchUrlToFile, isPublicAddress } from "../../src/core/url-fetch.js";
import { FILE_ID_SHAPE, UploadError, UploadStore } from "../../src/core/upload-store.js";
import { FileInputError, materializeFiles } from "../../src/core/file-inputs.js";
import { UPLOAD_DEFAULTS, resolveUploads } from "../../src/core/deploy-policy.js";
import {
    knownAccountFileLimit,
    readAccountFileLimit,
    resetKnownFileLimits,
    zaloFileLimit,
} from "../../src/core/zalo-file-limit.js";
import { RESTART_KEYS, POLICY_KEYS } from "../../src/core/policy-schema.js";
import { describeUploads } from "../../src/core/storage-quota.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const MB = 1024 * 1024;
let n = 0;
const freshDir = (name) => {
    const dir = join(CONFIG_DIR, "rf-core", `${name}-${n++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
};
/** The upload policy with test-sized caps; a url may reach this machine (the test server). */
const policy = (over = {}) => ({
    ...resolveUploads({ config: {}, policy: null }),
    allowPrivateUrls: true,
    ...over,
});

/** A local HTTP server whose routes are a map of path -> handler. */
let server;
let base;
const routes = {};
before(async () => {
    server = http.createServer((req, res) => {
        // One connection per request (see media-age-zcloud.test.js): a kept-alive socket closed by
        // the keep-alive timer while a slowed client reuses it fails the request ("other side closed").
        res.setHeader("connection", "close");
        const h = routes[req.url.split("?")[0]];
        if (!h) return res.writeHead(404).end("nope");
        h(req, res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

routes["/photo.png"] = (req, res) => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("PNGBYTES"));
routes["/noname"] = (req, res) => res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from("JPEG"));
routes["/big"] = (req, res) =>
    res
        .writeHead(200, { "content-type": "application/zip", "content-length": String(3 * MB) })
        .end(Buffer.alloc(3 * MB));
routes["/chunked-big"] = (req, res) => {
    res.writeHead(200, { "content-type": "application/zip" });
    for (let i = 0; i < 4; i++) res.write(Buffer.alloc(MB));
    res.end();
};
routes["/page"] = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>login</html>");
routes["/slow"] = (req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.write("x");
    setTimeout(() => res.end("y"), 2000).unref();
};
routes["/to-private"] = (req, res) => res.writeHead(302, { location: "http://10.0.0.1/secret" }).end();
routes["/to-ftp"] = (req, res) => res.writeHead(302, { location: "ftp://example.com/x" }).end();
routes["/loop"] = (req, res) => res.writeHead(302, { location: "/loop" }).end();
routes["/named"] = (req, res) =>
    res
        .writeHead(200, {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="report.pdf"',
        })
        .end("%PDF");

describe("isPublicAddress: what a fetched URL may reach", () => {
    it("refuses private, loopback, link-local, CGNAT, multicast, reserved and wrapped forms", () => {
        for (const ip of [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fd12::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "64:ff9b::a9fe:a9fe",
            "2002:a9fe:a9fe::",
            "not-an-ip",
        ]) {
            assert.equal(isPublicAddress(ip), false, ip);
        }
    });
    it("lets public addresses through", () => {
        for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
            assert.equal(isPublicAddress(ip), true, ip);
        }
    });
});

describe("fetchUrlToFile", () => {
    const opts = (over = {}) => ({ dir: freshDir("fetch"), maxBytes: 2 * MB, timeoutMs: 5000, ...over });

    it("refuses this machine's own address unless private URLs are allowed", async () => {
        await assert.rejects(fetchUrlToFile(`${base}/photo.png`, opts()), (e) => e.code === "BLOCKED_ADDRESS");
        const got = await fetchUrlToFile(`${base}/photo.png`, opts({ allowPrivate: true }));
        assert.equal(readFileSync(got.path, "utf8"), "PNGBYTES");
        assert.equal(got.name, "photo.png");
        assert.equal(got.mimeType, "image/png");
    });

    it("refuses a name that resolves to a private address, checked on the address it connects to", async () => {
        const lookup = (host, o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
        await assert.rejects(
            fetchUrlToFile("http://files.example.test/x.png", opts({ lookup })),
            (e) => e instanceof UrlFetchError && e.code === "BLOCKED_ADDRESS" && /10\.0\.0\.5/.test(e.message),
        );
        // A name with one public and one private answer is refused too (no address picking).
        const mixed = (host, o, cb) =>
            cb(null, [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ]);
        await assert.rejects(fetchUrlToFile("http://mixed.example.test/x", opts({ lookup: mixed })), {
            code: "BLOCKED_ADDRESS",
        });
    });

    it("refuses other schemes and URLs with credentials", async () => {
        await assert.rejects(fetchUrlToFile("file:///etc/passwd", opts()), { code: "BAD_URL" });
        await assert.rejects(fetchUrlToFile("http://u:p@example.com/x", opts()), { code: "BAD_URL" });
        await assert.rejects(fetchUrlToFile(`${base}/to-ftp`, opts({ allowPrivate: true })), { code: "BAD_URL" });
    });

    it("checks every redirect: one to a private address is refused", async () => {
        // The first hop is this machine (allowed for the test); the redirect goes to 10.0.0.1, which is not.
        const allowLoopbackOnly = (ip) => ip === "127.0.0.1";
        await assert.rejects(fetchUrlToFile(`${base}/to-private`, opts({ allowPrivate: allowLoopbackOnly })), {
            code: "BLOCKED_ADDRESS",
        });
        await assert.rejects(fetchUrlToFile(`${base}/loop`, opts({ allowPrivate: true })), /redirects/);
    });

    it("caps the size by Content-Length and while streaming, and removes a partial file", async () => {
        const dir = freshDir("cap");
        await assert.rejects(fetchUrlToFile(`${base}/big`, opts({ dir, allowPrivate: true })), { code: "TOO_LARGE" });
        await assert.rejects(fetchUrlToFile(`${base}/chunked-big`, opts({ dir, allowPrivate: true })), {
            code: "TOO_LARGE",
        });
        assert.deepEqual(readdirSync(dir), []);
    });

    it("gives up after the time limit", async () => {
        await assert.rejects(fetchUrlToFile(`${base}/slow`, opts({ allowPrivate: true, timeoutMs: 300 })), {
            code: "TIMEOUT",
        });
    });

    it("refuses a web page, an HTTP error, and names a file by Content-Disposition or its type", async () => {
        await assert.rejects(fetchUrlToFile(`${base}/page`, opts({ allowPrivate: true })), { code: "WEB_PAGE" });
        await assert.rejects(fetchUrlToFile(`${base}/missing`, opts({ allowPrivate: true })), { code: "HTTP_STATUS" });
        assert.equal((await fetchUrlToFile(`${base}/named`, opts({ allowPrivate: true }))).name, "report.pdf");
        assert.equal((await fetchUrlToFile(`${base}/noname`, opts({ allowPrivate: true }))).name, "noname.jpg");
    });
});

describe("UploadStore", () => {
    const spec = (over = {}) => ({ name: "a.txt", maxBytes: 100, quotaBytes: 250, ttlMs: 60_000, ...over });

    it("stores a buffer or a stream under an unguessable fileId, and lists, reads and deletes it", async () => {
        const store = new UploadStore(freshDir("store"));
        const a = await store.save(Buffer.from("hello"), spec({ mimeType: "text/plain" }));
        const b = await store.save(Readable.from([Buffer.from("wor"), Buffer.from("ld")]), spec({ name: "../b.txt" }));
        assert.match(a.fileId, FILE_ID_SHAPE);
        assert.notEqual(a.fileId, b.fileId);
        assert.equal(b.name, "b.txt", "a path in the name is dropped");
        assert.equal(readFileSync(store.get(b.fileId).path, "utf8"), "world");
        assert.equal(store.list().length, 2);
        assert.deepEqual(store.usage(), { bytes: 10, files: 2 });
        assert.equal(store.delete(a.fileId), true);
        assert.equal(store.get(a.fileId), null);
        assert.equal(store.delete(a.fileId), false);
    });

    it("refuses a file over its size cap, over the quota, or empty", async () => {
        const store = new UploadStore(freshDir("caps"));
        await assert.rejects(
            store.save(Buffer.alloc(101), spec()),
            (e) => e instanceof UploadError && e.code === "TOO_LARGE",
        );
        await assert.rejects(store.save(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), spec()), {
            code: "TOO_LARGE",
        });
        await store.save(Buffer.alloc(100), spec());
        await store.save(Buffer.alloc(100), spec());
        await assert.rejects(store.save(Buffer.alloc(60), spec()), { code: "QUOTA" });
        await assert.rejects(store.save(Buffer.alloc(10), spec({ declaredSize: 60 })), { code: "QUOTA" });
        await assert.rejects(store.save(Buffer.alloc(0), spec()), { code: "EMPTY" });
        assert.deepEqual(store.usage(), { bytes: 200, files: 2 }, "a refused upload leaves nothing behind");
    });

    it("expires files after their TTL and sweeps them", async () => {
        let t = 1_000_000;
        const store = new UploadStore(freshDir("ttl"), { now: () => t });
        const f = await store.save(Buffer.from("x"), spec({ ttlMs: 1000 }));
        assert.ok(store.get(f.fileId));
        t += 1001;
        assert.equal(store.get(f.fileId), null);
        assert.equal(store.usage().files, 0, "an expired file is removed when it is asked for");
        const g = await store.save(Buffer.from("y"), spec({ ttlMs: 1000 }));
        t += 5000;
        assert.equal(store.sweep(), 1);
        assert.equal(existsSync(join(store.dir, g.fileId)), false);
    });

    it("hands out upload links that work once, until they expire", async () => {
        let t = 5_000_000;
        const store = new UploadStore(freshDir("links"), { now: () => t });
        const l = store.beginUpload({ maxBytes: 100, ttlMs: 60_000, linkTtlMs: 1000 });
        assert.match(l.fileId, FILE_ID_SHAPE);
        assert.ok(store.pending(l.fileId));
        assert.ok(store.takeUploadLink(l.token).link);
        assert.match(store.takeUploadLink(l.token).gone, /already used/);
        store.releaseUploadLink(l.token);
        assert.ok(store.takeUploadLink(l.token).link, "a failed upload gives the link back");
        const late = store.beginUpload({ maxBytes: 100, ttlMs: 60_000, linkTtlMs: 1000 });
        t += 1001;
        assert.match(store.takeUploadLink(late.token).gone, /expired/);
        assert.deepEqual(store.takeUploadLink("x".repeat(32)), { unknown: true });
    });
});

describe("materializeFiles", () => {
    const store = () => new UploadStore(freshDir("mat"));

    it("refuses a path from a remote caller, saying what to send instead", async () => {
        const local = join(freshDir("paths"), "a.jpg");
        writeFileSync(local, "x");
        await assert.rejects(
            materializeFiles(["/home/someone/Downloads/photo.jpg"], { store: store(), policy: policy(), remote: true }),
            (e) =>
                e instanceof FileInputError &&
                e.code === "REMOTE_PATH" &&
                /"data"/.test(e.message) &&
                /"url"/.test(e.message) &&
                /"fileId"/.test(e.message) &&
                /upload_begin/.test(e.message) &&
                !/File not found/.test(e.message),
        );
        // A path that exists on this machine is not read for a remote caller either (no reading the server's disk).
        await assert.rejects(materializeFiles([local], { store: store(), policy: policy(), remote: true }), {
            code: "REMOTE_PATH",
        });
        // The same path is fine for a caller on this machine.
        const ok = await materializeFiles([local], { store: store(), policy: policy(), remote: false });
        assert.equal(ok.files[0].path, local);
        assert.equal(ok.files[0].from, "path");
    });

    it("reads a path under localPathRoots for any caller, but not a way out of it", async () => {
        const root = freshDir("root");
        const inside = join(root, "in.png");
        writeFileSync(inside, "x");
        const outside = join(freshDir("outside"), "secret.txt");
        writeFileSync(outside, "s");
        const p = policy({ localPathRoots: [root] });
        const got = await materializeFiles([inside], { store: store(), policy: p, remote: true });
        assert.equal(got.files[0].path, inside);
        await assert.rejects(
            materializeFiles([join(root, "..", outside.split(/[\\/]/).slice(-2).join("/"))], {
                store: store(),
                policy: p,
                remote: true,
            }),
            { code: "REMOTE_PATH" },
        );
        let linked = null;
        try {
            linked = join(root, "link.txt");
            symlinkSync(outside, linked);
        } catch {
            linked = null; // no symlinks here (Windows without the right): the .. case above covers it
        }
        if (linked) {
            await assert.rejects(materializeFiles([linked], { store: store(), policy: p, remote: true }), {
                code: "REMOTE_PATH",
            });
        }
    });

    it("localPaths none refuses every path; any reads them for remote callers", async () => {
        const local = join(freshDir("modes"), "a.txt");
        writeFileSync(local, "x");
        await assert.rejects(
            materializeFiles([local], { store: store(), policy: policy({ localPaths: "none" }), remote: false }),
            { code: "LOCAL_PATHS_OFF" },
        );
        const any = await materializeFiles([local], {
            store: store(),
            policy: policy({ localPaths: "any" }),
            remote: true,
        });
        assert.equal(any.files[0].path, local);
    });

    it("decodes data items (base64 or a data: URL) into named files, removed by cleanup", async () => {
        const s = store();
        const { files, cleanup } = await materializeFiles(
            [
                { data: Buffer.from("one").toString("base64"), name: "a.txt" },
                { data: `data:image/png;base64,${Buffer.from("two").toString("base64")}`, name: "pic" },
                { data: Buffer.from("three").toString("base64"), name: "a.txt" },
            ],
            { store: s, policy: policy(), remote: true },
        );
        assert.deepEqual(
            files.map((f) => [f.name, readFileSync(f.path, "utf8"), f.from]),
            [
                ["a.txt", "one", "data"],
                ["pic.png", "two", "data"],
                ["a.txt", "three", "data"],
            ],
        );
        assert.equal(files[1].mimeType, "image/png");
        cleanup();
        assert.equal(
            files.some((f) => existsSync(f.path)),
            false,
        );
    });

    it("caps the inline bytes of all data items of a call together, and refuses bad base64", async () => {
        const p = policy({ inlineMaxBytes: 10 });
        const six = Buffer.alloc(6).toString("base64");
        await assert.rejects(
            materializeFiles(
                [
                    { data: six, name: "a" },
                    { data: six, name: "b" },
                ],
                { store: store(), policy: p, remote: true },
            ),
            (e) => e.code === "TOO_LARGE" && /upload_begin/.test(e.message),
        );
        await assert.rejects(
            materializeFiles([{ data: "@@@", name: "a" }], { store: store(), policy: p, remote: true }),
            {
                code: "BAD_DATA",
            },
        );
    });

    it("uses a stored fileId in place, and says when one is unknown, expired or still waiting", async () => {
        const s = store();
        const f = await s.save(Buffer.from("stored"), { name: "s.pdf", maxBytes: MB, quotaBytes: MB, ttlMs: 60_000 });
        const got = await materializeFiles([{ fileId: f.fileId }], { store: s, policy: policy(), remote: true });
        assert.equal(readFileSync(got.files[0].path, "utf8"), "stored");
        got.cleanup();
        assert.ok(existsSync(got.files[0].path), "cleanup never removes a stored file");
        await assert.rejects(
            materializeFiles([{ fileId: `f_${"a".repeat(24)}` }], { store: s, policy: policy(), remote: true }),
            (e) => e.code === "UNKNOWN_FILE_ID" && /upload the file again/.test(e.message),
        );
        const l = s.beginUpload({ maxBytes: MB, ttlMs: 60_000, linkTtlMs: 60_000 });
        await assert.rejects(
            materializeFiles([{ fileId: l.fileId }], { store: s, policy: policy(), remote: true }),
            /not used yet/,
        );
    });

    it("downloads a url item, and refuses one to a private address under the default policy", async () => {
        const got = await materializeFiles([{ url: `${base}/photo.png`, name: "renamed.png" }], {
            store: store(),
            policy: policy(),
            remote: true,
        });
        assert.equal(got.files[0].name, "renamed.png");
        assert.equal(readFileSync(got.files[0].path, "utf8"), "PNGBYTES");
        await assert.rejects(
            materializeFiles([{ url: `${base}/photo.png` }], {
                store: store(),
                policy: policy({ allowPrivateUrls: false }),
                remote: true,
            }),
            (e) => e.code === "URL" && /private or reserved/.test(e.message),
        );
    });

    it("a URL given as a path string is refused with the {url} form to use", async () => {
        await assert.rejects(
            materializeFiles(["https://example.com/a.png"], { store: store(), policy: policy(), remote: true }),
            /\{"url": "https:\/\/example\.com\/a\.png"\}/,
        );
    });
});

describe("the account's Zalo file limit (src/core/zalo-file-limit.js)", () => {
    const GIB = 1024 * MB;
    const features = (v3, zmax) => ({
        ...(v3 === undefined ? {} : { sharefile: { max_size_share_file_v3: v3 } }),
        ...(zmax === undefined ? {} : { multi_site_upload: { zcloud_upload_file_max_size: zmax } }),
    });

    it("is the share-file limit, bounded by the zCloud upload limit, for every plan; the plan names the tier", () => {
        const free = zaloFileLimit(features(1024, 10 * GIB), { plan: -1 });
        assert.equal(free.bytes, GIB);
        assert.equal(free.tier, "free");
        assert.equal(free.planAllowsBytes, GIB);
        const paid = zaloFileLimit(features(1024, 10 * GIB), { plan: 0 });
        assert.equal(paid.bytes, GIB, "this engine's chat upload carries at most the share-file limit");
        assert.equal(paid.tier, "zcloud");
        assert.equal(paid.planAllowsBytes, 10 * GIB, "what a paid plan allows through Zalo's cloud upload");
        assert.equal(zaloFileLimit(features(1024, 10 * GIB), { plan: 100 }).tier, "grace");
        assert.equal(zaloFileLimit(features(1024, 10 * GIB), { plan: 69 }).planAllowsBytes, GIB);
        assert.equal(zaloFileLimit(features(1024, 10 * GIB)).tier, "unknown");
        // A zCloud upload limit below the share-file limit bounds it.
        assert.equal(zaloFileLimit(features(1024, 300 * MB)).bytes, 300 * MB);
    });

    it("falls back as Zalo does: 25 MB without a share-file limit, 1 GiB without a zCloud one", () => {
        assert.equal(zaloFileLimit(features(undefined, 10 * GIB)).bytes, 25 * MB);
        assert.equal(zaloFileLimit(features(4096, undefined)).bytes, GIB);
        assert.equal(zaloFileLimit({}).fromSettings, false);
    });

    it("a daemon's reading is kept in the account folder for a CLI without a session", () => {
        resetKnownFileLimits();
        const dir = freshDir("limit");
        const api = { getContext: () => ({ settings: { features: features(300, 10 * GIB) } }) };
        assert.equal(readAccountFileLimit(api, dir).bytes, 300 * MB);
        resetKnownFileLimits();
        assert.equal(knownAccountFileLimit(dir).bytes, 300 * MB);
        assert.equal(knownAccountFileLimit(freshDir("never")), null);
    });

    it("resolveUploads: the limit is the default and the ceiling; a lower setting wins, a higher one does not", () => {
        const at = (config) => resolveUploads({ config, policy: null, zaloLimitBytes: 300 * MB });
        assert.equal(at({}).maxBytes, 300 * MB);
        assert.equal(at({}).sources.maxBytes, "zalo");
        assert.equal(at({}).quotaBytes, 600 * MB);
        assert.equal(at({ uploads: { maxBytes: "50MB" } }).maxBytes, 50 * MB);
        assert.equal(at({ uploads: { maxBytes: "50MB" } }).sources.maxBytes, "set");
        assert.equal(at({ uploads: { maxBytes: "2GB", urlMaxBytes: "2GB" } }).maxBytes, 300 * MB);
        assert.equal(at({ uploads: { urlMaxBytes: "2GB" } }).urlMaxBytes, 300 * MB);
        assert.equal(
            resolveUploads({ config: {}, policy: { uploads: { maxBytes: "5GB" } }, zaloLimitBytes: 300 * MB }).maxBytes,
            300 * MB,
            "a policy cannot raise it either",
        );
        assert.equal(at({ uploads: { quota: "5GB" } }).quotaBytes, 5 * 1024 * MB);
    });

    it("a url over the account's limit is refused while it downloads", async () => {
        const p = { ...resolveUploads({ config: {}, policy: null, zaloLimitBytes: 2 * MB }), allowPrivateUrls: true };
        await assert.rejects(
            materializeFiles([{ url: `${base}/chunked-big` }], {
                store: new UploadStore(freshDir("u")),
                policy: p,
                remote: true,
            }),
            (e) => e.code === "URL" && /over the 2097152-byte limit/.test(e.message),
        );
    });

    it("an upload stream over the limit stops when it crosses it, never held whole in memory", async () => {
        const store = new UploadStore(freshDir("stream"));
        let produced = 0;
        const source = new Readable({
            read() {
                if (produced >= 64 * MB) return this.push(null);
                produced += MB;
                this.push(Buffer.alloc(MB));
            },
        });
        await assert.rejects(
            store.save(source, { name: "big.bin", maxBytes: 3 * MB, quotaBytes: 100 * MB, ttlMs: 60_000 }),
            { code: "TOO_LARGE" },
        );
        assert.ok(produced < 16 * MB, `read ${produced} bytes before stopping`);
        assert.equal(store.usage().files, 0);
    });
});

describe("resolveUploads and the policy keys", () => {
    it("defaults, mcp-config.json, the account's block and the live policy, in that order", () => {
        const d = resolveUploads({ config: {}, policy: null });
        assert.equal(d.inlineMaxBytes, UPLOAD_DEFAULTS.inlineMaxBytes);
        // No session read yet: one file may be 1 GiB until the account's Zalo limit is known; the store holds two.
        assert.equal(d.maxBytes, 1024 * MB);
        assert.equal(d.sources.maxBytes, "zalo-unknown");
        assert.equal(d.quotaBytes, 2 * 1024 * MB);
        assert.equal(d.recordWaitMs, 10 * 60_000);
        assert.equal(d.ttlMs, 24 * 3_600_000);
        assert.equal(d.localPaths, "loopback");
        assert.equal(d.allowPrivateUrls, false);
        const config = {
            uploads: { quota: "50MB", ttl: "2h", localPaths: "any", localPathRoots: ["/srv/handoff"] },
            accounts: { 1001: { uploads: { quota: "70MB" } } },
        };
        const r = resolveUploads({
            config,
            accountId: "1001",
            policy: { uploads: { quota: "90MB", localPaths: "none" } },
        });
        assert.equal(r.quotaBytes, 90 * MB, "the live policy wins");
        assert.equal(r.ttlMs, 2 * 3_600_000);
        assert.equal(r.localPaths, "any", "localPaths is read from the file only");
        assert.deepEqual(r.localPathRoots, ["/srv/handoff"]);
        assert.equal(resolveUploads({ config, accountId: "1001", policy: null }).quotaBytes, 70 * MB);
        assert.equal(
            resolveUploads({ config: { uploads: { inlineMaxBytes: "64MB" } }, policy: null }).inlineMaxBytes,
            UPLOAD_DEFAULTS.inlineMaxBytes,
            "over the 32 MB ceiling: the default",
        );
    });

    it("the policy takes the caps but never what the server reads from its own disk", () => {
        for (const k of ["uploads.inlineMaxBytes", "uploads.quota", "uploads.ttl", "uploads.maxBytes"]) {
            assert.ok(POLICY_KEYS[k], k);
        }
        assert.equal(POLICY_KEYS["uploads.inlineMaxBytes"].check("64MB").error !== undefined, true);
        for (const k of ["uploads.localPaths", "uploads.localPathRoots", "uploads.allowPrivateUrls"]) {
            assert.ok(RESTART_KEYS.includes(k), k);
        }
    });

    it("describeUploads reports the store against its quota, with a warn and a full level", async () => {
        const dir = freshDir("acct");
        const s = new UploadStore(join(dir, "uploads"));
        const config = { uploads: { quota: 100 } };
        assert.equal(describeUploads(dir, "1001", config).level, "ok");
        await s.save(Buffer.alloc(85), { name: "a", maxBytes: 100, quotaBytes: 100, ttlMs: 60_000 });
        const warn = describeUploads(dir, "1001", config);
        assert.equal(warn.level, "warn");
        assert.equal(warn.bytes, 85);
        assert.equal(warn.percent, 85);
        await s.save(Buffer.alloc(15), { name: "b", maxBytes: 100, quotaBytes: 100, ttlMs: 60_000 });
        assert.equal(describeUploads(dir, "1001", config).level, "full");
    });
});
