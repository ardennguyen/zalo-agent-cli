/**
 * A forwarded voice or video is re-sent by its hosted URL (`sendVoice` / `sendVideo`). A voice goes out as Zalo Web
 * forwards one: its URL and the m4a URL from `params.m4a`, no size and no HEAD to the file's host. A video still
 * needs a size, which the engine asks the host for with a HEAD unless it is given one; a cached message often knows
 * it already (its params, or the copy the media downloader saved), so `msg forward` and `zalo_forward_message` hand
 * that size over (FX 10) with a bound on a HEAD that is still needed, and keep the 1280x720 fallback for a video whose
 * params have no geometry.
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
import { FORWARD_VIDEO_FALLBACK, videoResendOptions, voiceResendOptions } from "../../src/zalo/custom/forward.js";
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
    it("voice: the URL and the m4a from params, nothing else (Web sends no size)", () => {
        assert.deepEqual(voiceResendOptions({ href: VOICE_URL, params: J({ m4a: M4A_URL, fileSize: 1200 }) }), {
            voiceUrl: VOICE_URL,
            m4aUrl: M4A_URL,
        });
        assert.deepEqual(voiceResendOptions({ href: VOICE_URL, params: "{not json" }), { voiceUrl: VOICE_URL });
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

    for (const [name, msgId, m4aUrl] of [
        ["one whose params give a size", VOICE_SIZED, M4A_URL],
        ["one with a downloaded copy", VOICE_LOCAL, M4A_URL],
        ["one nothing knows the size of, and no m4a", VOICE_BARE, VOICE_URL],
    ]) {
        it(`a voice (${name}) makes no HEAD and sends no size, as Web does`, async () => {
            const r = await runOffline(["msg", "forward", msgId, PEER, "-t", "0"]);
            // Red when sendVoice asks the host for the size again: the bare voice would show a HEAD.
            assert.deepEqual(HEADS(r.requests), [], r.all);
            const sends = requestsTo(r.requests, "/api/message/forward");
            assert.equal(sends.length, 1, r.all);
            assert.deepEqual(JSON.parse(sends[0].params.msgInfo), { voiceUrl: VOICE_URL, m4aUrl });
        });
    }

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
    it("hands sendVoice the URL and the m4a URL only", async () => {
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
        // Red when the tool drops the m4a URL (Web forwards params.m4a) or passes size/timeout plumbing again.
        assert.deepEqual(calls, [
            {
                options: { voiceUrl: VOICE_URL, m4aUrl: M4A_URL },
                threadId: PEER,
                type: 0,
            },
        ]);
    });
});
