/**
 * zalo_send_message's further kinds of content, as `msg sticker`, `send-voice`, `send-video`, `send-bank` and
 * `send-qr-transfer` send them; zalo_sync's stages beyond `messages` and `reactions`; and the HTTP transport telling
 * the guard it is stateless.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { createSyncJobs } from "../../src/mcp/sync-jobs.js";
import { createStageLock } from "../../src/core/daemon-channel.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** A session whose every method call is recorded and answered from `answers`. */
function fakeApi(answers = {}) {
    const calls = [];
    const api = new Proxy(
        { getOwnId: () => "100", getContext: () => ({ loginInfo: {} }) },
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop !== "string" || prop === "then") return undefined;
                return async (...args) => {
                    calls.push({ method: prop, args });
                    const a = answers[prop];
                    return typeof a === "function" ? a(...args) : (a ?? { msgId: "m1", cliMsgId: "c1" });
                };
            },
        },
    );
    return { api, calls };
}

/** The real tools; `call` parses the input with the tool's schema first, as the MCP SDK does. */
function tools(api, syncJobs) {
    const map = new Map();
    registerTools(
        { registerTool: (name, meta, handler) => map.set(name, { meta, handler }) },
        api,
        { read: () => ({ messages: [], cursor: 0 }), getStats: () => [], readCursor: () => 0, markRead: () => 0 },
        { isWatched: () => true },
        {},
        { ready: true, get: () => null, search: () => [] },
        undefined,
        undefined,
        syncJobs,
    );
    const schema = (name) => map.get(name).meta.inputSchema;
    const call = async (name, args) => {
        const res = await map.get(name).handler(schema(name).parse(args), {});
        return {
            isError: res.isError === true,
            text: res.content[0].text,
            body: res.isError ? null : JSON.parse(res.content[0].text),
        };
    };
    return { call, schema };
}

const send = (fa, args) => tools(fa.api).call("zalo_send_message", { threadId: "777", threadType: "dm", ...args });

describe("zalo_send_message: the other kinds of content", () => {
    it("sticker: sends the first sticker Zalo finds for the keyword", async () => {
        const fa = fakeApi({ searchSticker: [{ sticker_id: 5, cate_id: 2, type: 7 }] });
        const r = await send(fa, { sticker: "mèo" });
        assert.equal(r.body.kind, "sticker");
        assert.equal(r.body.stickerId, "5");
        assert.deepEqual(fa.calls.at(-1), { method: "sendSticker", args: [{ id: 5, cateId: 2, type: 7 }, "777", 0] });
        assert.equal(r.body.msgId, "m1");
    });

    it("sticker: none found is an error, and nothing is sent", async () => {
        const fa = fakeApi({ searchSticker: [] });
        const r = await send(fa, { sticker: "zzz" });
        assert.equal(r.isError, true);
        assert.equal(
            fa.calls.some((c) => c.method === "sendSticker"),
            false,
        );
    });

    it("voiceUrl and video go out through sendVoice and sendVideo, the video with its caption", async () => {
        const fa = fakeApi();
        await send(fa, { voiceUrl: "https://cdn.test.invalid/a.m4a" });
        await send(fa, {
            video: { source: "https://cdn.test.invalid/v.mp4", thumbnail: "https://cdn.test.invalid/t.jpg" },
            text: "xem nè",
        });
        assert.deepEqual(fa.calls[0], {
            method: "sendVoice",
            args: [{ voiceUrl: "https://cdn.test.invalid/a.m4a", ttl: 0 }, "777", 0],
        });
        assert.equal(fa.calls[1].method, "sendVideo");
        assert.equal(fa.calls[1].args[0].msg, "xem nè");
        assert.equal(fa.calls[1].args[0].width, 1280);
    });

    it("video: a local file is uploaded and sent with sendVideoFile, as `msg send-video <file>` does", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-send-video-"));
        const file = join(dir, "clip.mp4");
        const thumb = join(dir, "thumb.jpg");
        writeFileSync(file, "v");
        writeFileSync(thumb, "t");
        try {
            const fa = fakeApi();
            const r = await send(fa, { video: { source: file, thumbnail: thumb }, text: "clip" });
            assert.equal(r.isError, false, r.text);
            assert.equal(fa.calls[0].method, "sendVideoFile");
            assert.equal(fa.calls[0].args[0].file, file);
            assert.equal(fa.calls[0].args[0].thumbnailFile, thumb);
            assert.equal(fa.calls[0].args[0].msg, "clip");
            const missing = await send(fakeApi(), { video: { source: join(dir, "nope.mp4"), thumbnail: thumb } });
            assert.match(missing.text, /File not found/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("bankCard: the bank's BIN, the number and the holder", async () => {
        const fa = fakeApi();
        const r = await send(fa, { bankCard: { bank: "vcb", accountNumber: "0123456789", holderName: "A" } });
        assert.equal(r.body.kind, "bank_card");
        assert.deepEqual(fa.calls[0], {
            method: "sendBankCard",
            args: [{ binBank: 970436, numAccBank: "0123456789", nameAccBank: "A" }, "777", 0],
        });
    });

    it("qrTransfer: generates the image, sends it with the CLI's caption, and removes the temp file", async () => {
        const fetched = [];
        globalThis.fetch = async (url) => {
            fetched.push(String(url));
            return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        };
        const fa = fakeApi();
        const r = await send(fa, { qrTransfer: { bank: "vcb", accountNumber: "0123456789", amount: 50000 } });
        assert.equal(r.isError, false, r.text);
        assert.equal(r.body.kind, "qr_transfer");
        assert.match(fetched[0], /acc=0123456789/);
        const [content] = fa.calls[0].args;
        assert.match(content.msg, /^QR chuyển khoản Vietcombank - 0123456789 - /);
        assert.equal(existsSync(content.attachments[0]), false, "the temp image is gone");
    });

    it("an unknown bank is refused before anything is sent", async () => {
        const fa = fakeApi();
        const r = await send(fa, { bankCard: { bank: "nobank", accountNumber: "1" } });
        assert.equal(r.isError, true);
        assert.match(r.text, /Unknown bank/);
        assert.deepEqual(fa.calls, []);
    });

    it("refuses two kinds at once, text with a sticker, and an input it does not take", () => {
        const s = tools(fakeApi().api).schema("zalo_send_message");
        const base = { threadId: "777" };
        assert.equal(s.safeParse({ ...base, sticker: "a", voiceUrl: "https://a.test.invalid/x" }).success, false);
        assert.equal(s.safeParse({ ...base, sticker: "a", text: "hi" }).success, false);
        assert.equal(s.safeParse({ ...base, bankCard: { bank: "vcb", accountNumber: "1" }, text: "x" }).success, false);
        assert.equal(s.safeParse({ ...base, text: "hi", messageId: "1" }).success, false);
        assert.equal(s.safeParse({ ...base, video: { source: "https://a.test.invalid/v" } }).success, false);
        assert.equal(s.safeParse({ ...base, text: "hi" }).success, true);
    });
});

describe("zalo_sync: the stages beyond messages and reactions", () => {
    it("takes cloud, media and boards, each with only its own options", () => {
        const s = tools(fakeApi().api).schema("zalo_sync");
        const ok = (v) => s.safeParse({ requestId: "r1", ...v }).success;
        assert.equal(ok({ stage: "media", kinds: ["photo"], limit: 5, days: 3, threadId: "777" }), true);
        assert.equal(ok({ stage: "boards", threadId: "777", limit: 20 }), true);
        assert.equal(ok({ stage: "cloud", full: true }), true);
        assert.equal(ok({ stage: "boards", full: true }), false);
        assert.equal(ok({ stage: "cloud", days: 1 }), false);
        assert.equal(ok({ stage: "media", from: "2026-10-01" }), false);
        assert.equal(ok({ stage: "messages", kinds: ["photo"] }), false);
        assert.equal(ok({ stage: "media", kinds: ["hologram"] }), false);
    });

    it("starts a media job on the tracker, without a phone tap", async () => {
        const ran = [];
        const lock = createStageLock();
        const jobs = createSyncJobs({
            runners: {
                media: async (params) => {
                    ran.push(params);
                    return { downloaded: 0 };
                },
            },
            lock,
        });
        const r = await tools(fakeApi().api, jobs).call("zalo_sync", { requestId: "m-1", stage: "media", limit: 2 });
        assert.equal(r.isError, false, r.text);
        assert.equal(r.body.stage, "media");
        assert.equal(r.body.phoneConfirmationRequired, false);
        await new Promise((res) => setImmediate(res));
        assert.deepEqual(ran, [{ limit: 2 }]);
    });
});

describe("the HTTP transport", () => {
    it("marks each per-request server stateless, so confirmMode human refuses there instead of hanging", async () => {
        const seen = [];
        const http = createHTTPServer((server) => seen.push(server), {}, 0, null, "127.0.0.1");
        await new Promise((r) => http.once("listening", r));
        try {
            await fetch(`http://127.0.0.1:${http.address().port}/mcp`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "t", version: "0" },
                    },
                }),
            }).then((res) => res.text());
        } finally {
            http.close();
        }
        assert.equal(seen.length, 1);
        assert.equal(seen[0].statelessHttp, true);
    });
});
