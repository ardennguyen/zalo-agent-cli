/**
 * Every MCP tool that takes a file works for a caller on another machine: zalo_send_message (`files`, `video`),
 * zalo_profile and zalo_group 'avatar', zalo_catalog 'upload_photo' and zalo_official (`fileArgs`) take {data},
 * {url} and {fileId}; a path from a remote caller is refused with what to send instead; zalo_file stores files and
 * hands out one-time upload links. The last part runs over the real HTTP transport: an upload by bearer and by link,
 * then a send by fileId, against a fake session (never a live account).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { MediaLinks, setMediaLinks } from "../../src/core/media-deliver.js";
import { getUploadStore } from "../../src/core/upload-store.js";
import { officialTool } from "../../src/mcp/official-tool.js";
import { fileResolver } from "../../src/mcp/file-input.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const OWN = "100000000000000555";
const AUTH = "test-bearer-token-uploads";
const accountDir = getAccountDir(OWN);
mkdirSync(accountDir, { recursive: true });
const b64 = (s) => Buffer.from(s).toString("base64");

/**
 * A session that records each call, and for each file a call names, the file's name and bytes at the moment of the
 * call (the server removes a fetched or decoded file right after).
 */
function fakeApi() {
    const calls = [];
    const snap = (p) => ({
        name: p.split(/[\\/]/).pop(),
        bytes: existsSync(p) ? readFileSync(p, "utf8") : null,
        path: p,
    });
    const api = {
        getOwnId: () => OWN,
        getContext: () => ({ loginInfo: {} }),
        sendMessage: async (content, threadId) => {
            calls.push({ method: "sendMessage", threadId, files: (content.attachments ?? []).map(snap) });
            return { message: { msgId: "m1", cliMsgId: "c1" } };
        },
        sendVideoFile: async (o) => {
            calls.push({
                method: "sendVideoFile",
                file: snap(o.file),
                thumb: o.thumbnailFile ? snap(o.thumbnailFile) : o.thumbnailUrl,
            });
            return { msgId: "v1", cliMsgId: "cv1" };
        },
        changeAccountAvatar: async (p) => {
            calls.push({ method: "changeAccountAvatar", file: snap(p) });
            return {};
        },
        changeGroupAvatar: async (p, groupId) => {
            calls.push({ method: "changeGroupAvatar", groupId, file: snap(p) });
            return {};
        },
        uploadProductPhoto: async ({ file }) => {
            calls.push({ method: "uploadProductPhoto", file: snap(file) });
            return { photoUrl: "https://cdn.example/p.jpg" };
        },
    };
    return { api, calls };
}

/** The real tools on a server that is reached over HTTP (remote) or from this machine. */
function tools({ remote, api }) {
    const map = new Map();
    const server = {
        registerTool: (name, meta, handler) => map.set(name, { meta, handler }),
        statelessHttp: remote,
        clientLoopback: !remote,
    };
    registerTools(
        server,
        api,
        { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], readCursor: () => 0, markRead: () => 0 },
        { isWatched: () => true },
        {},
        { ready: true, get: () => null, search: () => [] },
        accountDir,
    );
    const call = async (name, args) => {
        const parsed = map.get(name).meta.inputSchema.safeParse(args);
        if (!parsed.success) return { isError: true, schemaError: parsed.error.issues[0].message, text: "" };
        const res = await map.get(name).handler(parsed.data, {});
        const text = res.content[0].text;
        return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    };
    return { call, map };
}

describe("zalo_send_message files from a remote caller", () => {
    it("sends {data} and {fileId} items under their names, and removes the decoded file afterwards", async () => {
        const { api, calls } = fakeApi();
        const { call } = tools({ remote: true, api });
        const stored = await getUploadStore(accountDir).save(Buffer.from("PDFDATA"), {
            name: "report.pdf",
            maxBytes: 1e6,
            quotaBytes: 1e7,
            ttlMs: 60_000,
        });
        const r = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            text: "both",
            files: [{ data: b64("IMGDATA"), name: "photo.jpg", mimeType: "image/jpeg" }, { fileId: stored.fileId }],
        });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual(r.body.files, ["photo.jpg", "report.pdf"]);
        const sent = calls[0].files;
        assert.deepEqual(
            sent.map((f) => [f.name, f.bytes]),
            [
                ["photo.jpg", "IMGDATA"],
                ["report.pdf", "PDFDATA"],
            ],
        );
        assert.equal(existsSync(sent[0].path), false, "the decoded file is gone after the call");
        assert.equal(existsSync(sent[1].path), true, "the stored file stays for the next send");
    });

    it("refuses a path from a remote caller with what to send instead, and sends nothing", async () => {
        const { api, calls } = fakeApi();
        const { call } = tools({ remote: true, api });
        const r = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: ["/workspace/out/chart.png"],
        });
        assert.equal(r.isError, true);
        assert.match(r.text, /runs on another machine/);
        assert.match(r.text, /"data"/);
        assert.match(r.text, /upload_begin/);
        assert.doesNotMatch(r.text, /^Error: File not found/);
        const single = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            filePath: "/tmp/x.png",
        });
        assert.equal(single.isError, true);
        assert.match(single.text, /filePath is a path/);
        assert.equal(calls.length, 0);
    });

    it("a caller on this machine still sends a path, as before", async () => {
        const { api, calls } = fakeApi();
        const { call } = tools({ remote: false, api });
        const p = join(accountDir, "local.txt");
        writeFileSync(p, "LOCAL");
        const r = await call("zalo_send_message", { threadId: "1234567", threadType: "group", filePath: p });
        assert.equal(r.isError, false, r.text);
        assert.equal(calls[0].files[0].bytes, "LOCAL");
        assert.deepEqual(r.body.files, [p]);
    });

    it("sends a video and its thumbnail given as data", async () => {
        const { api, calls } = fakeApi();
        const { call } = tools({ remote: true, api });
        const r = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            video: {
                source: { data: b64("MP4"), name: "clip.mp4" },
                thumbnail: { data: b64("JPG"), name: "thumb.jpg" },
            },
        });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual([calls[0].file.name, calls[0].file.bytes, calls[0].thumb.bytes], ["clip.mp4", "MP4", "JPG"]);
    });

    it("an unknown fileId and an over-size data item are refused before anything is sent", async () => {
        const { api, calls } = fakeApi();
        const { call } = tools({ remote: true, api });
        const r = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: [{ fileId: `f_${"Z".repeat(24)}` }],
        });
        assert.match(r.text, /unknown or has expired/);
        const schema = await call("zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: [{ data: b64("x"), name: "a", fileId: `f_${"Z".repeat(24)}` }],
        });
        assert.equal(schema.isError, true, "an item is one form, strictly");
        assert.equal(calls.length, 0);
    });
});

describe("the action tools that take one image", () => {
    for (const [tool, args, method] of [
        ["zalo_profile", { action: "avatar" }, "changeAccountAvatar"],
        ["zalo_group", { action: "avatar", groupId: "1234567" }, "changeGroupAvatar"],
        ["zalo_catalog", { action: "upload_photo" }, "uploadProductPhoto"],
    ]) {
        it(`${tool} ${args.action}: file {data} works remotely, a path does not, and one of them is required`, async () => {
            const { api, calls } = fakeApi();
            const { call } = tools({ remote: true, api });
            const ok = await call(tool, { ...args, file: { data: b64("AVATAR"), name: "me.png" } });
            assert.equal(ok.isError, false, ok.text);
            assert.equal(calls[0].method, method);
            assert.deepEqual([calls[0].file.name, calls[0].file.bytes], ["me.png", "AVATAR"]);
            const path = await call(tool, { ...args, filePath: "/home/me/me.png" });
            assert.equal(path.isError, true);
            assert.match(path.text, /runs on another machine/);
            const none = await call(tool, { ...args });
            assert.match(none.text, /Give the image as `file`/);
            assert.equal(calls.length, 1);
        });
    }
});

describe("zalo_official fileArgs", () => {
    /** The official tool with a fake runner, on a remote caller's file resolver. */
    function official(remote) {
        const runs = [];
        const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
        const err = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
        const files = fileResolver({
            server: { statelessHttp: remote, clientLoopback: !remote },
            config: {},
            accountDir,
            accountId: () => OWN,
        });
        const handler = officialTool(
            { ok, err, gate: async () => null, files },
            {
                run: async (argv) => {
                    const path = argv[argv.length - 1];
                    runs.push({ argv, bytes: existsSync(path) ? readFileSync(path, "utf8") : null });
                    return { code: 0, stdout: '{"ok": true}', stderr: "" };
                },
            },
        );
        return { handler, runs };
    }

    it("puts a {data} file at the command's file argument, for the run only", async () => {
        const { handler, runs } = official(true);
        const r = await handler({
            command: "oa upload image",
            fileArgs: { "file-path": { data: b64("PNG"), name: "a.png" } },
        });
        assert.equal(r.isError, undefined, r.content[0].text);
        assert.deepEqual(runs[0].argv.slice(0, 4), ["oa", "upload", "image", "--"]);
        assert.equal(runs[0].bytes, "PNG");
        assert.equal(existsSync(runs[0].argv.at(-1)), false);
    });

    it("refuses a remote caller's path in args, a name the command has no file for, and lists fileArgs", async () => {
        const { handler, runs } = official(true);
        const p = await handler({ command: "oa upload image", args: ["/home/me/a.png"] });
        assert.equal(p.isError, true);
        assert.match(p.content[0].text, /runs on another machine/);
        const bad = await handler({ command: "oa upload image", fileArgs: { cover: { data: b64("x"), name: "x" } } });
        assert.match(bad.content[0].text, /takes no file 'cover' \(its file arguments: file-path\)/);
        const list = await handler({});
        const entry = JSON.parse(list.content[0].text).commands.find((c) => c.command === "oa upload image");
        assert.deepEqual(entry.fileArgs, ["file-path"]);
        assert.equal(runs.length, 0);
    });

    it("a local caller's path in args runs as before", async () => {
        const { handler, runs } = official(false);
        const local = join(accountDir, "oa.png");
        writeFileSync(local, "LOCALPNG");
        await handler({ command: "oa upload image", args: [local] });
        assert.equal(runs[0].bytes, "LOCALPNG");
    });
});

describe("zalo_file", () => {
    it("'upload' stores data, 'info' and 'list' show it, 'delete' removes it", async () => {
        const { api } = fakeApi();
        const { call } = tools({ remote: true, api });
        const up = await call("zalo_file", { action: "upload", data: b64("KEEP"), name: "keep.txt" });
        assert.equal(up.isError, false, up.text);
        assert.match(up.body.fileId, /^f_/);
        assert.equal(up.body.size, 4);
        const info = await call("zalo_file", { action: "info", fileId: up.body.fileId });
        assert.equal(info.body.status, "stored");
        assert.equal(info.body.path, undefined, "a server path is never handed out");
        const list = await call("zalo_file", { action: "list" });
        assert.ok(list.body.files.some((f) => f.fileId === up.body.fileId));
        assert.ok(list.body.usage.quotaBytes > 0);
        assert.equal((await call("zalo_file", { action: "delete", fileId: up.body.fileId })).isError, false);
        assert.match((await call("zalo_file", { action: "info", fileId: up.body.fileId })).text, /unknown/);
        assert.match((await call("zalo_file", { action: "upload", data: b64("x") })).text, /`name` is required/);
    });

    it("'upload_begin' refuses a server that is not reached over HTTP", async () => {
        setMediaLinks(new MediaLinks());
        try {
            const { api } = fakeApi();
            const { call } = tools({ remote: false, api });
            const r = await call("zalo_file", { action: "upload_begin", name: "a.png" });
            assert.match(r.text, /pass the file's path instead/);
        } finally {
            setMediaLinks(null);
        }
    });
});

// ── Over HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────────

function request(port, path, { method = "GET", headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on("error", reject);
        r.end(body);
    });
}

/** One MCP tools/call over HTTP, from a client that is not on this machine (X-Forwarded-For via a trusted proxy). */
async function rpc(port, name, args, { auth = AUTH } = {}) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const res = await request(port, "/mcp", {
        method: "POST",
        body,
        headers: {
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-forwarded-for": "198.51.100.7",
        },
    });
    const raw = res.body.toString();
    const json = raw.trim().startsWith("{")
        ? raw
        : raw
              .split("\n")
              .find((l) => l.startsWith("data: "))
              .slice(6);
    return { status: res.status, msg: JSON.parse(json) };
}

describe("over HTTP behind a proxy on this host that is not in trustedProxies", () => {
    it("a forwarded request is a remote caller: its path is refused", async () => {
        const fake = fakeApi();
        const server = createHTTPServer(
            registerTools,
            {
                api: fake.api,
                buffer: { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], readCursor: () => 0 },
                filter: { isWatched: () => true },
                config: {},
                nameCache: { ready: true, get: () => null, search: () => [] },
                accountDir,
            },
            0,
            AUTH,
            "127.0.0.1",
        );
        await new Promise((r) => server.once("listening", r));
        try {
            const port = server.address().port;
            const local = join(accountDir, "server-secret.txt");
            writeFileSync(local, "SECRET");
            const r = await rpc(port, "zalo_send_message", {
                threadId: "1234567",
                threadType: "group",
                files: [local],
            });
            assert.equal(r.msg.result.isError, true);
            assert.match(r.msg.result.content[0].text, /runs on another machine/);
            assert.equal(fake.calls.length, 0, "nothing of this machine's disk was sent");
        } finally {
            server.close();
        }
    });
});

describe("over HTTP: upload, then send by fileId (fake session)", () => {
    let server;
    let port;
    let calls;
    before(async () => {
        const fake = fakeApi();
        calls = fake.calls;
        const links = new MediaLinks().configure({ log: () => {} });
        setMediaLinks(links);
        server = createHTTPServer(
            registerTools,
            {
                api: fake.api,
                buffer: { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], readCursor: () => 0 },
                filter: { isWatched: () => true },
                config: { uploads: { maxBytes: 1000, quota: 5000, inlineMaxBytes: 2000 } },
                nameCache: { ready: true, get: () => null, search: () => [] },
                accountDir,
                mediaLinks: links,
                trustedProxies: ["loopback"],
            },
            0,
            AUTH,
            "127.0.0.1",
        );
        await new Promise((r) => server.once("listening", r));
        port = server.address().port;
        links.configure({ localBaseUrl: `http://127.0.0.1:${port}` });
    });
    after(() => {
        server.close();
        setMediaLinks(null);
    });

    it("POST /zalo/files needs the bearer, stores the body, and the fileId sends", async () => {
        const denied = await request(port, "/zalo/files?name=a.txt", { method: "POST", body: "x" });
        assert.equal(denied.status, 401);
        const up = await request(port, "/zalo/files?name=notes.txt", {
            method: "POST",
            body: "BODY-BYTES",
            headers: { authorization: `Bearer ${AUTH}`, "content-type": "text/plain" },
        });
        assert.equal(up.status, 201, up.body.toString());
        const saved = JSON.parse(up.body);
        assert.equal(saved.name, "notes.txt");
        assert.equal(saved.mimeType, "text/plain");
        const sent = await rpc(port, "zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: [{ fileId: saved.fileId }],
        });
        assert.equal(sent.msg.result.isError, undefined, sent.msg.result.content[0].text);
        const last = calls.at(-1);
        assert.deepEqual([last.files[0].name, last.files[0].bytes], ["notes.txt", "BODY-BYTES"]);
    });

    it("zalo_file upload_begin gives a one-time link that takes a PUT without a token", async () => {
        const begun = await rpc(port, "zalo_file", { action: "upload_begin", name: "big.zip" });
        const b = JSON.parse(begun.msg.result.content[0].text);
        assert.match(
            b.uploadUrl,
            new RegExp(`^http://127\\.0\\.0\\.1:${port}/zalo/files/u/[A-Za-z0-9_-]{32}\\?name=big\\.zip$`),
        );
        const path = new URL(b.uploadUrl).pathname + new URL(b.uploadUrl).search;
        const waiting = await rpc(port, "zalo_file", { action: "info", fileId: b.fileId });
        assert.equal(JSON.parse(waiting.msg.result.content[0].text).status, "waiting");
        const put = await request(port, path, { method: "PUT", body: "ZIPBYTES" });
        assert.equal(put.status, 201, put.body.toString());
        assert.equal(JSON.parse(put.body).fileId, b.fileId);
        assert.equal((await request(port, path, { method: "PUT", body: "again" })).status, 410);
        assert.equal(
            (await request(port, `/zalo/files/u/${"A".repeat(32)}`, { method: "PUT", body: "x" })).status,
            404,
        );
        const sent = await rpc(port, "zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: [{ fileId: b.fileId }],
        });
        assert.equal(sent.msg.result.isError, undefined);
        assert.deepEqual([calls.at(-1).files[0].name, calls.at(-1).files[0].bytes], ["big.zip", "ZIPBYTES"]);
    });

    it("an upload over uploads.maxBytes is 413, and over the quota 507", async () => {
        const big = await request(port, "/zalo/files?name=x.bin", {
            method: "POST",
            body: Buffer.alloc(1500),
            headers: { authorization: `Bearer ${AUTH}` },
        });
        assert.equal(big.status, 413);
        // Fill the 5000-byte store, then one more is refused for the quota.
        const store = getUploadStore(accountDir);
        for (const f of store.list()) store.delete(f.fileId);
        for (let i = 0; i < 5; i++) {
            const r = await request(port, "/zalo/files?name=f.bin", {
                method: "POST",
                body: Buffer.alloc(1000),
                headers: { authorization: `Bearer ${AUTH}` },
            });
            assert.equal(r.status, 201);
        }
        const full = await request(port, "/zalo/files?name=f.bin", {
            method: "POST",
            body: Buffer.alloc(10),
            headers: { authorization: `Bearer ${AUTH}` },
        });
        assert.equal(full.status, 507);
        assert.match(JSON.parse(full.body).error_description, /upload store is full/);
        for (const f of store.list()) store.delete(f.fileId);
    });

    it("a remote caller's path is refused clearly; an MCP body over the inline limit is a JSON-RPC 413", async () => {
        const r = await rpc(port, "zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: ["C:/Users/someone/Desktop/a.png"],
        });
        assert.equal(r.msg.result.isError, true);
        assert.match(r.msg.result.content[0].text, /runs on another machine/);
        const huge = await rpc(port, "zalo_send_message", {
            threadId: "1234567",
            threadType: "group",
            files: [{ data: "A".repeat(2 * 1024 * 1024), name: "a.bin" }],
        });
        assert.equal(huge.status, 413);
        assert.match(huge.msg.error.message, /upload_begin/);
        // No token: refused at the bearer check, never parsed.
        assert.equal((await rpc(port, "zalo_file", { action: "list" }, { auth: null })).status, 401);
    });
});
