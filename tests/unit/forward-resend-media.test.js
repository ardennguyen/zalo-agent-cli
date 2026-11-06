/**
 * A forwarded voice or video is re-sent by its hosted URL (`sendVoice` / `sendVideo`), and the engine asks the host
 * for the file's size with a HEAD unless it is given one. A cached message often knows it already: its params, or
 * the copy the media downloader saved. `msg forward` and `zalo_forward_message` hand that size over (FX 10), so a
 * forward of a cached voice makes no HEAD; they also hand over the m4a URL Zalo Web forwards (`params.m4a`), a bound
 * on a HEAD that is still needed, and keep the 1280x720 fallback for a video whose params have no geometry.
 *
 * The CLI cases run the real command against an offline session (./support/offline-cli.js), which logs every
 * request, the HEAD included; the MCP case runs the tool against a recording api. Every id is fake.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { insertMessage, initDb, upsertThread } from "../../src/core/db.js";
import { FORWARD_VIDEO_FALLBACK, videoResendOptions, voiceResendOptions } from "../../src/core/forward.js";
import { HEAD_TIMEOUT_MS } from "../../src/zalo/api/messages.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { seedAccount, seedThread, runOffline, requestsTo } from "./support/offline-cli.js";

const PEER = "300000000000000081";
const SOURCE = "300000000000000082";
const SENDER = "500000000000000081";
const VOICE_SIZED = "7100000000081";
const VOICE_LOCAL = "7100000000082";
const VOICE_BARE = "7100000000083";
const VIDEO_NO_GEOMETRY = "7100000000084";

/** Hosts the offline session answers and logs: a HEAD to one of them shows up in the request log. */
const VOICE_URL = "https://file.offline.invalid/voice/a.aac";
const M4A_URL = "https://file.offline.invalid/voice/a.m4a";
const VIDEO_URL = "https://file.offline.invalid/video/v.mp4";
const THUMB_URL = "https://file.offline.invalid/video/v.jpg";

const DIR = mkdtempSync(join(SANDBOX_HOME, "forward-resend-"));
const LOCAL_VOICE = join(DIR, "voice.aac");
writeFileSync(LOCAL_VOICE, Buffer.alloc(4321, 1));

const J = JSON.stringify;

/**
 * One cached media message, as the listener stores it.
 *
 * @param {string} msgId
 * @param {string} type - the classifier's vocabulary ("voice", "video")
 * @param {object} content - the message's `content`
 * @param {string|null} [localPath]
 */
function seedMedia(msgId, type, content, localPath = null) {
    insertMessage({
        msgId,
        threadId: SOURCE,
        senderId: SENDER,
        senderName: "",
        text: "",
        timestamp: 1700000000800,
        type,
        raw_data: J({
            msgType: type === "voice" ? "chat.voice" : "chat.video.msg",
            cliMsgId: "1700000000081",
            content,
        }),
        has_attachment: 1,
        localPath,
    });
}

const HEADS = (requests) => requests.filter((q) => q.method === "HEAD");

describe("the re-send options read the cache", () => {
    it("voice: m4a and size from params; the downloaded copy's size when params have none; a bound always", () => {
        assert.deepEqual(voiceResendOptions({ href: VOICE_URL, params: J({ m4a: M4A_URL, fileSize: 1200 }) }), {
            voiceUrl: VOICE_URL,
            m4aUrl: M4A_URL,
            fileSize: 1200,
            timeoutMs: HEAD_TIMEOUT_MS,
        });
        // What a real voice note's params hold (m4a, duration, waveform): the size comes from the local copy.
        assert.equal(voiceResendOptions({ href: VOICE_URL, params: J({ m4a: M4A_URL }) }, LOCAL_VOICE).fileSize, 4321);
        // Nothing knows the size: the engine asks the host, bounded.
        const bare = voiceResendOptions({ href: VOICE_URL, params: "{not json" }, join(DIR, "missing.aac"));
        assert.deepEqual(bare, { voiceUrl: VOICE_URL, timeoutMs: HEAD_TIMEOUT_MS });
    });

    it("video: geometry from params, else 1280x720; size from params or video_file_size", () => {
        const sized = videoResendOptions({
            href: VIDEO_URL,
            thumb: THUMB_URL,
            params: { duration: 4000, video_width: 640, video_height: 360, video_file_size: 9000 },
        });
        assert.deepEqual(sized, {
            videoUrl: VIDEO_URL,
            thumbnailUrl: THUMB_URL,
            duration: 4000,
            width: 640,
            height: 360,
            fileSize: 9000,
            timeoutMs: HEAD_TIMEOUT_MS,
        });
        const bare = videoResendOptions({ href: VIDEO_URL });
        assert.deepEqual([bare.width, bare.height], [1280, 720]);
        assert.deepEqual(FORWARD_VIDEO_FALLBACK, { width: 1280, height: 720 });
        assert.equal("fileSize" in bare, false);
    });
});

describe("msg forward of a cached voice or video", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        seedAccount();
        seedThread(PEER, "dm");
        seedThread(SOURCE, "dm");
        seedMedia(VOICE_SIZED, "voice", { href: VOICE_URL, params: J({ m4a: M4A_URL, fileSize: 1200 }) });
        seedMedia(VOICE_LOCAL, "voice", { href: VOICE_URL, params: J({ m4a: M4A_URL, duration: 3000 }) }, LOCAL_VOICE);
        seedMedia(VOICE_BARE, "voice", { href: VOICE_URL, params: J({ duration: 3000 }) });
        seedMedia(VIDEO_NO_GEOMETRY, "video", {
            href: VIDEO_URL,
            thumb: THUMB_URL,
            params: J({ duration: 4000, fileSize: 9000 }),
        });
    });

    for (const [name, msgId, fileSize] of [
        ["its params' size", VOICE_SIZED, 1200],
        ["its downloaded copy's size", VOICE_LOCAL, 4321],
    ]) {
        it(`a voice whose size the cache knows (${name}) makes no HEAD, and sends the m4a URL`, async () => {
            const r = await runOffline(["msg", "forward", msgId, PEER, "-t", "0"]);
            // Red when the forward hands sendVoice only the URL (the old call): the engine then HEADs the CDN.
            assert.deepEqual(HEADS(r.requests), [], r.all);
            const sends = requestsTo(r.requests, "/api/message/forward");
            assert.equal(sends.length, 1, r.all);
            assert.deepEqual(JSON.parse(sends[0].params.msgInfo), { voiceUrl: VOICE_URL, m4aUrl: M4A_URL, fileSize });
        });
    }

    it("a voice whose size nothing knows still asks the host (so the cases above can see a HEAD)", async () => {
        const r = await runOffline(["msg", "forward", VOICE_BARE, PEER, "-t", "0"]);
        assert.equal(HEADS(r.requests).length, 1, r.all);
        assert.equal(HEADS(r.requests)[0].url, VOICE_URL);
    });

    it("a video with no geometry goes out as 1280x720, with its cached size and no HEAD", async () => {
        const r = await runOffline(["msg", "forward", VIDEO_NO_GEOMETRY, PEER, "-t", "0"]);
        assert.deepEqual(HEADS(r.requests), [], r.all);
        const sends = requestsTo(r.requests, "/api/message/forward");
        assert.equal(sends.length, 1, r.all);
        const info = JSON.parse(sends[0].params.msgInfo);
        assert.deepEqual([info.width, info.height, info.fileSize, info.duration], [1280, 720, 9000, 4000]);
    });
});

describe("zalo_forward_message of a cached voice", () => {
    it("hands sendVoice the m4a URL, the known size and the bound", async () => {
        initDb(join(DIR, "mcp.sqlite"));
        upsertThread({ threadId: PEER, type: "dm", name: "Peer", lastUpdate: 1700000000000 });
        seedMedia(VOICE_LOCAL, "voice", { href: VOICE_URL, params: J({ m4a: M4A_URL, duration: 3000 }) }, LOCAL_VOICE);
        const calls = [];
        const api = {
            getOwnId: () => "100000000000000081",
            getContext: () => ({ loginInfo: {} }),
            sendVoice: async (options, threadId, type) => {
                calls.push({ options, threadId, type });
                return { msgId: "7100000000900", cliMsgId: "1700000000900" };
            },
        };
        const tools = new Map();
        const server = { registerTool: (name, _meta, handler) => tools.set(name, handler) };
        const buffer = { read: () => ({ messages: [] }), getStats: () => [], getThreadType: () => "dm" };
        registerTools(server, api, buffer, {}, { limits: {} }, { ready: true, get: () => null, search: () => [] });
        const r = await tools.get("zalo_forward_message")({ msgId: VOICE_LOCAL, threadId: PEER, threadType: "dm" });
        assert.equal(r.isError, undefined, r.content[0].text);
        // Red when the tool passes only {voiceUrl}: the engine would HEAD the CDN for a size the cache has.
        assert.deepEqual(calls, [
            {
                options: { voiceUrl: VOICE_URL, m4aUrl: M4A_URL, fileSize: 4321, timeoutMs: HEAD_TIMEOUT_MS },
                threadId: PEER,
                type: 0,
            },
        ]);
    });
});
