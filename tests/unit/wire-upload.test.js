/**
 * Attachments on the wire (package UPL, design 4.1 and 3.3; spec-send 2 and 7): `sendMessage` with files and
 * `uploadAttachment` (src/zalo/api/upload.js) on one logged-in context, against the reviewed golden records
 * (tests/helpers/wire-diff/golden/upload.js) and by direct assertions. The cases that need time to pass (the wait for
 * a 601, a 601 that comes early, the replay, the concurrency bound, the chunk-size fallback) run with the session
 * clock frozen and moved by hand.
 *
 * The caption that goes out beside a file is sent through `s.api.sendMessage`, which is package MSG's text half. So
 * that this file tests the upload alone, the engine here runs with a stand-in text half that records the call and
 * draws the next clientId as MSG's does.
 *
 * Every id here is fake.
 */
import "../helpers/sandbox.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { readImageMetadata } from "../../src/zalo/client.js";
import { createApi } from "../../src/zalo/api.js";
import {
    CHUNK_TIMEOUT_MS,
    DEFAULT_CHUNK_SIZE,
    FINAL_REPLAY_GRACE_MS,
    GIF_CHUNK_SIZE,
    GIF_CHUNKS_IN_FLIGHT,
    REPLAY_SIZE_STEP,
    TICK_MS,
    replayDelayMs,
    uploadMethods,
    uploadSettings,
} from "../../src/zalo/api/upload.js";
import { startFakeSocket } from "../helpers/fake-zalo/socket.js";
import { controlBody } from "../helpers/fake-zalo/sync.js";
import { SEED, T0, TZ, expectGolden, freezeTime, loginOnce, openWire, seedRandom } from "../helpers/wire-diff/index.js";
import { normalizeError, normalizeRequest, normalizeResult } from "../helpers/wire-diff/normalize.js";
import { FILES, IMAGES } from "../fixtures/index.js";
import { installFakeZalo } from "./fake-zalo-session.js";

const USER = "1000000000000000001";
const GROUP = "2000000000000000002";
const TEXT_MSG_ID = "6100000001";
const ZALO_OPTIONS = { imageMetadataGetter: readImageMetadata };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait (real time) until `pred()` holds.
 *
 * @param {() => unknown} pred
 * @param {string} what
 * @param {number} [ms]
 */
async function until(pred, what, ms = 5000) {
    const end = performance.now() + ms;
    while (!pred()) {
        if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}

// ── canned server ────────────────────────────────────────────────────────

/** A small number from a file name, so every id the fake hands out follows from the file it is for. */
function nameNumber(name) {
    let h = 7;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 900000;
    return h;
}
const photoIdOf = (name) => String(4000000000 + nameNumber(name));
const fileIdOf = (name) => String(5000000000 + nameNumber(name));
const msgIdOf = (id) => `6${String(id).slice(1)}`;
const gifMsgIdOf = (name) => msgIdOf(3000000000 + nameNumber(name));
const fileUrlOf = (name) => `https://file-cdn.zalo.invalid/${encodeURIComponent(name)}`;
const photoUrlsOf = (name) => ({
    normalUrl: `https://photo.zalo.invalid/${encodeURIComponent(name)}/normal.jpg`,
    hdUrl: `https://photo.zalo.invalid/${encodeURIComponent(name)}/hd.jpg`,
    thumbUrl: `https://photo.zalo.invalid/${encodeURIComponent(name)}/thumb.jpg`,
});

/**
 * The fake's answers for the upload area. A chunk that is not the last answers `finished: 0` with id "-1" (live
 * uploads so far were all one chunk, so this shape is not verified).
 *
 * @param {{photoDuplicate?: boolean, photoWithoutUrls?: boolean}} [opts]
 */
function replies({ photoDuplicate = false, photoWithoutUrls = false } = {}) {
    return {
        "/photo_original/upload": (r) => {
            const p = r.params;
            if (p.chunkId < p.totalChunk) return { data: { chunkId: p.chunkId, finished: 0, photoId: "-1" } };
            const data = {
                finished: 1,
                photoId: photoIdOf(p.fileName),
                clientFileId: p.clientId,
                chunkId: p.chunkId,
                ...(photoWithoutUrls ? {} : photoUrlsOf(p.fileName)),
            };
            return photoDuplicate
                ? { inner: { error_code: 1, error_message: "Photo already uploaded", data } }
                : { data };
        },
        "/asyncfile/upload": (r) => {
            const p = r.params;
            if (p.chunkId < p.totalChunk) return { data: { chunkId: p.chunkId, finished: 0, fileId: "-1" } };
            return {
                data: { finished: 1, fileId: fileIdOf(p.fileName), clientFileId: p.clientId, chunkId: p.chunkId },
            };
        },
        "/photo_original/send": (r) => ({ data: { msgId: msgIdOf(r.params.photoId) } }),
        "/asyncfile/msg": (r) => ({ data: { msgId: msgIdOf(r.params.fileId) } }),
        "/upthumb": { data: { url: "https://thumb.zalo.invalid/gif-thumb.png" } },
        "/gif": (r) => ({ data: { msgId: gifMsgIdOf(r.params.fileName) } }),
    };
}

/** A `file_done` control as the 601 frame carries it. */
const fileDone = (id, url) => ({
    actionId: "1",
    controlId: "1",
    content: { act_type: "file_done", fileId: id, data: { url } },
});

/**
 * Play one 601 control the way a listener hands it to the registry.
 *
 * - "callback": the registry used as a plain map: call the entry under the id with `{fileUrl, fileId}`, delete it.
 * - "settle": our listener (src/zalo/listener/listener.js `#settle`): the registry's settle hook alone, with the
 *   whole control as `data`; the registry itself calls a function entry with `{fileUrl, fileId}`.
 *
 * @param {import("../../src/zalo/kernel/session.js").UploadRegistry} reg
 * @param {string} id
 * @param {{url: string|null, kind: string, control: object}} c
 * @param {"callback"|"settle"} listener
 */
function playControl(reg, id, { url, kind, control }, listener) {
    if (listener === "settle") {
        reg.settle(id, { url, kind, data: control });
        return;
    }
    const cb = reg.get(id);
    if (typeof cb === "function") {
        reg.delete(id);
        cb({ fileUrl: url, fileId: id });
    }
}

/**
 * A `during` hook that plays the listener's `file_done` for each file in turn, once its upload waits (see
 * {@link playControl} for the two ways).
 *
 * @param {import("../../src/zalo/kernel/session.js").UploadRegistry} reg
 * @param {string[]} names
 * @param {"callback"|"settle"} mode
 */
function playFileDone(reg, names, mode) {
    return async () => {
        for (const name of names) {
            const id = fileIdOf(name);
            await until(() => typeof reg.get(id) === "function", `the upload of ${name} to wait for its 601`);
            const url = fileUrlOf(name);
            playControl(reg, id, { url, kind: "file_done", control: fileDone(id, url) }, mode);
        }
    };
}

// ── the engine: the upload area plus a stand-in text half ────────────────

/** Calls the stand-in text half received, with how many requests had gone out before each. */
const captionCalls = [];
/** Calls the stand-in forward-video send received (`sendVideoFile` ends in it). */
const videoCalls = [];
const VIDEO_MSG_ID = "6100000002";
let currentFake = null;

const UPLOAD_AREA = { name: "upload", factories: [uploadMethods] };
const CAPTION_AREA = {
    name: "messages",
    factories: [
        (s) => ({
            sendText: async (message, threadId, type) => {
                captionCalls.push({ message, threadId, type, requestsBefore: currentFake?.requests.length ?? 0 });
                return { message: { msgId: TEXT_MSG_ID, cliMsgId: String(s.nextClientId()) }, attachment: [] };
            },
            sendVideo: async (options, threadId, type) => {
                videoCalls.push({ options, threadId, type });
                return { msgId: VIDEO_MSG_ID, cliMsgId: String(s.nextClientId()) };
            },
        }),
    ],
};

/** `createApi` with the upload area and the stand-in text half only. */
function uploadCreateApi(ctx, serviceMap, wsUrls, opts = {}) {
    return createApi(ctx, serviceMap, wsUrls, { ...opts, areas: [UPLOAD_AREA, CAPTION_AREA] });
}

/** Open a wire whose engine comes from {@link uploadCreateApi}. */
async function openUploadWire(fake = {}) {
    const wire = await openWire({ fake, zaloOptions: ZALO_OPTIONS, createApi: uploadCreateApi });
    currentFake = wire.fake;
    return wire;
}

/**
 * Install answers as the harness does: path-suffix routes, functions picking the answer per request.
 *
 * @param {object} fake
 * @param {Record<string, object|Function>} answers
 */
function installAnswers(fake, answers) {
    fake.clearRoutes();
    for (const [suffix, answer] of Object.entries(answers)) fake.routeAnswer(suffix, answer);
}

/**
 * One call under the harness's conditions (frozen clock at T0, seeded random, fixed zone, a freshly built engine),
 * for the cases that set raw routes or play controls the harness's `run` does not.
 *
 * @param {Awaited<ReturnType<typeof openUploadWire>>} wire
 * @param {string} name
 * @param {unknown[]} args
 * @param {{replies?: Record<string, object|Function>, raw?: (fake: object) => void,
 *   during?: (clock: ReturnType<typeof freezeTime>) => Promise<void>}} [fixture]
 * @returns {Promise<{requests: object[], result: unknown, error: object|null}>}
 */
async function runOwn(wire, name, args, fixture = {}) {
    const { fake, ctx } = wire;
    fake.clearRoutes();
    fixture.raw?.(fake);
    for (const [suffix, answer] of Object.entries(fixture.replies ?? {})) fake.routeAnswer(suffix, answer);
    const from = fake.requests.length;
    const zone = process.env.TZ;
    process.env.TZ = TZ;
    const clock = freezeTime(T0);
    const random = seedRandom(SEED);
    let result;
    let error = null;
    try {
        const api = await uploadCreateApi(ctx, ctx.loginInfo.zpw_service_map_v3, ctx.loginInfo.zpw_ws, {
            now: clock.now,
        });
        const call = Promise.resolve(api[name](...args));
        call.catch(() => {});
        if (fixture.during) await fixture.during(clock);
        try {
            result = await call;
        } catch (e) {
            error = normalizeError(e);
        }
    } finally {
        random.restore();
        clock.restore();
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
        fake.clearRoutes();
    }
    return {
        requests: fake.requests.slice(from).map((r) => normalizeRequest(r, fake)),
        result: error ? undefined : normalizeResult(result),
        error,
    };
}

/** A run record under a case name (golden entries are matched on it). */
const named = (rec, name) => ({ ...rec, name });

/**
 * The kind of upload-area request a normalized request is, by its path.
 *
 * @param {{path?: string}} req
 * @returns {"chunk"|"photo"|"file"|"upthumb"|"gif"|null}
 */
function requestKind(req) {
    const p = req?.path ?? "";
    if (/\/(photo_original|asyncfile)\/upload$/.test(p)) return "chunk";
    if (p.endsWith("/photo_original/send")) return "photo";
    if (p.endsWith("/asyncfile/msg")) return "file";
    if (p.endsWith("/upthumb")) return "upthumb";
    if (/\/(message|group)\/gif$/.test(p)) return "gif";
    return null;
}

/** The requests of one kind. */
const ofKind = (requests, kind) => requests.filter((r) => requestKind(r) === kind);

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Bytes that are the same on every run. */
const pattern = (size, seed = 3) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + seed) & 255));

const DIR = mkdtempSync(join(tmpdir(), "zalo-upl-"));
const made = {
    clip: join(DIR, "clip.mp4"),
    big: join(DIR, "big.bin"),
    wide: join(DIR, "wide.bin"),
    exe: join(DIR, "tool.exe"),
    // path.join writes backslashes on Windows: the base name must still be what goes on the wire.
    spaced: join(DIR, "sub dir", "report 1.txt"),
};
writeFileSync(made.clip, pattern(3000, 12));
// A GIF of two full chunks and a short third: the fixture's header (so its size reads 64x48) and filler after it.
made.bigGif = join(DIR, "big.gif");
writeFileSync(
    made.bigGif,
    Buffer.concat([
        readFileSync(IMAGES.gif.path),
        pattern(GIF_CHUNK_SIZE * 2 + 700 - readFileSync(IMAGES.gif.path).length, 4),
    ]),
);
writeFileSync(made.big, pattern(200000, 5));
writeFileSync(made.wide, pattern(64000 * 5 + 1000, 9));
writeFileSync(made.exe, pattern(100, 1));
mkdirSync(join(DIR, "sub dir"));
writeFileSync(made.spaced, pattern(500, 2));

after(() => rmSync(DIR, { recursive: true, force: true }));

// ── sends ────────────────────────────────────────────────────────────────

describe("wire: attachments", () => {
    let wire;
    let reg;
    before(async () => {
        wire = await openUploadWire();
        reg = wire.ctx.uploadCallbacks;
    });
    after(() => wire?.close());

    /** Run, and check the record against its golden entry under `name`. */
    async function compared(name, method, args, fixture) {
        captionCalls.length = 0;
        const rec = named(await wire.run(method, args, fixture), name);
        await expectGolden("upload", name, rec.own);
        return rec;
    }

    it("a single photo to a user: the caption rides as its desc, one clientId for the upload and the send", async () => {
        const rec = await compared(
            "sendMessage/image-dm",
            "sendMessage",
            [{ msg: "a caption", attachments: [IMAGES.png.path] }, USER, 0],
            { replies: replies() },
        );
        const [chunk, send] = rec.own.requests;
        assert.equal(requestKind(chunk), "chunk");
        assert.equal(chunk.params.clientId, T0);
        assert.equal(send.params.clientId, String(T0));
        assert.equal(send.params.desc, "a caption");
        assert.deepEqual(rec.own.result, {
            message: null,
            attachment: [{ msgId: msgIdOf(photoIdOf("image-64x48.png")), cliMsgId: String(T0) }],
        });
        assert.equal(captionCalls.length, 0, "a caption that rides on the photo is not sent separately");
    });

    it("a photo to a group: grid, oriUrl, and the display size of an EXIF-rotated photo", async () => {
        const rec = await compared(
            "sendMessage/image-group",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.jpgRotated.path] }, GROUP, 1],
            { replies: replies() },
        );
        const [chunk, send] = rec.own.requests;
        assert.equal(chunk.path, "/api/group/photo_original/upload");
        assert.equal(chunk.query.type, "11");
        assert.equal(send.params.grid, GROUP);
        assert.equal(send.params.oriUrl, photoUrlsOf("image-200x120-rot90.jpg").normalUrl);
        assert.equal(send.params.normalUrl, undefined);
        // Stored 200x120 with EXIF orientation 6: the photo shows 120 wide.
        assert.deepEqual([send.params.width, send.params.height], [120, 200]);
    });

    it("several photos (png, jpg, webp) form one layout, each with its own clientId", async () => {
        const rec = await compared(
            "sendMessage/multi-image",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.png.path, IMAGES.jpg.path, IMAGES.webp.path] }, GROUP, 1],
            { replies: replies() },
        );
        const sends = ofKind(rec.own.requests, "photo");
        assert.equal(sends.length, 3);
        assert.deepEqual(
            sends.map((r) => [
                r.params.clientId,
                r.params.idInGroup,
                r.params.totalItemInGroup,
                r.params.isGroupLayout,
            ]),
            [
                [String(T0), 0, 3, 1],
                [String(T0 + 1), 1, 3, 1],
                [String(T0 + 2), 2, 3, 1],
            ],
        );
        assert.equal(new Set(sends.map((r) => r.params.groupLayoutId)).size, 1, "one layout id for the send");
        assert.deepEqual(
            rec.own.result.attachment.map((a) => a.cliMsgId),
            sends.map((r) => r.params.clientId),
        );
    });

    it("a file to a user waits for file_done, settled by calling the registry entry", async () => {
        const rec = await compared(
            "sendMessage/file-dm",
            "sendMessage",
            [{ msg: "", attachments: [FILES.txt.path] }, USER, 0],
            { replies: replies(), during: playFileDone(reg, ["notes.txt"], "callback") },
        );
        const send = ofKind(rec.own.requests, "file")[0];
        assert.equal(send.params.fileUrl, fileUrlOf("notes.txt"));
        assert.equal(send.params.checksum, md5(readFileSync(FILES.txt.path)));
        assert.equal(send.params.extension, "txt");
        assert.equal(send.params.clientId, T0);
    });

    it("a file to a group, settled the way our listener does it: the settle hook", async () => {
        const rec = await compared(
            "sendMessage/file-group",
            "sendMessage",
            [{ msg: "", attachments: [FILES.csv.path] }, GROUP, 1],
            { replies: replies(), during: playFileDone(reg, ["data.csv"], "settle") },
        );
        const send = ofKind(rec.own.requests, "file")[0];
        assert.equal(send.params.fileUrl, fileUrlOf("data.csv"));
        assert.equal(send.params.imei, undefined, "the Web's group file send has no imei");
    });

    it("an mp4 goes as a file", async () => {
        const rec = await compared(
            "sendMessage/video-as-file",
            "sendMessage",
            [{ msg: "", attachments: [made.clip] }, USER, 0],
            { replies: replies(), during: playFileDone(reg, ["clip.mp4"], "callback") },
        );
        assert.equal(rec.own.requests[0].path, "/api/message/asyncfile/upload");
        assert.equal(ofKind(rec.own.requests, "file")[0].params.extension, "mp4");
    });

    it("a GIF: its thumbnail first, then the whole file as one chunk", async () => {
        const rec = await compared(
            "sendMessage/gif",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.gif.path] }, USER, 0],
            { replies: replies() },
        );
        const [thumb, gif] = rec.own.requests;
        const bytes = readFileSync(IMAGES.gif.path);
        assert.equal(thumb.path, "/api/message/upthumb");
        assert.deepEqual(thumb.parts, [
            { name: "fileContent", filename: "blob", type: "image/png", size: bytes.length, sha256: sha256(bytes) },
        ]);
        assert.equal(gif.path, "/api/message/gif");
        assert.equal(gif.query.type, "1");
        assert.deepEqual(
            gif.parts.map((p) => [p.name, p.filename, p.sha256]),
            [["chunkContent", "image-64x48.gif", sha256(bytes)]],
        );
        assert.equal(gif.params.thumb, "https://thumb.zalo.invalid/gif-thumb.png");
        assert.equal(gif.params.checksum, md5(bytes));
        assert.deepEqual(
            [gif.params.width, gif.params.height, gif.params.totalChunk, gif.params.chunkId],
            [64, 48, 1, 1],
        );
    });

    it("a GIF over one chunk goes in 512000-byte chunks, the last one after the others, as the Web sends it", async () => {
        const answers = {
            ...replies(),
            // A chunk taken while the upload goes on answers 220 (the Web reads 0, 1 and 220 as success); the last
            // one carries the message. Not seen live: every GIF sent so far was one chunk.
            "/gif": (r) =>
                r.params.chunkId < r.params.totalChunk
                    ? { inner: { error_code: 220, error_message: "chunk received", data: { isFinish: 0 } } }
                    : { data: { msgId: gifMsgIdOf(r.params.fileName), isFinish: 1 } },
        };
        const rec = await compared(
            "sendMessage/gif-chunks",
            "sendMessage",
            [{ msg: "", attachments: [made.bigGif] }, USER, 0],
            { replies: answers },
        );
        const chunks = ofKind(rec.own.requests, "gif");
        const bytes = readFileSync(made.bigGif);
        // Red if a big GIF went up whole again, or in another chunking than the Web's.
        assert.deepEqual(
            chunks.map((c) => [c.params.chunkId, c.params.totalChunk, c.parts[0].size]),
            [
                [1, 3, GIF_CHUNK_SIZE],
                [2, 3, GIF_CHUNK_SIZE],
                [3, 3, bytes.length - 2 * GIF_CHUNK_SIZE],
            ],
        );
        assert.equal(new Set(chunks.map((c) => c.params.clientId)).size, 1, "one clientId for every chunk");
        assert.ok(
            chunks.every((c) => c.params.checksum === md5(bytes)),
            "the checksum is the whole file's",
        );
        assert.equal(rec.own.result.attachment[0].msgId, gifMsgIdOf("big.gif"));
        assert.equal(rec.own.result.attachment[0].cliMsgId, String(chunks[0].params.clientId));
        assert.equal(GIF_CHUNKS_IN_FLIGHT, 6);
    });

    it("a local video goes up as a file, its thumbnail as a photo, then the forward-video send", async () => {
        videoCalls.length = 0;
        const rec = await compared(
            "sendVideoFile/local",
            "sendVideoFile",
            [
                {
                    file: made.clip,
                    thumbnailFile: IMAGES.png.path,
                    width: 640,
                    height: 360,
                    duration: 4000,
                    msg: "clip",
                },
                USER,
                0,
            ],
            { replies: replies(), during: playFileDone(reg, ["clip.mp4"], "settle") },
        );
        assert.deepEqual(rec.own.requests.map(requestKind), ["chunk", "chunk"], "two uploads, no file or photo send");
        assert.equal(videoCalls.length, 1);
        const [{ options, threadId, type }] = videoCalls;
        // Red if the message did not carry the uploaded video's own address and the thumbnail's HD one.
        assert.equal(options.videoUrl, fileUrlOf("clip.mp4"));
        assert.equal(options.thumbnailUrl, photoUrlsOf("image-64x48.png").hdUrl);
        assert.deepEqual(
            [options.width, options.height, options.duration, options.fileSize, options.msg],
            [640, 360, 4000, 3000, "clip"],
        );
        assert.deepEqual([threadId, type], [USER, 0]);
        assert.equal(rec.own.result.msgId, VIDEO_MSG_ID);
        assert.equal(rec.own.result.videoUrl, fileUrlOf("clip.mp4"));
    });

    it("a local video with a thumbnail URL uploads the video only", async () => {
        videoCalls.length = 0;
        const thumb = "https://photo.zalo.invalid/given/thumb.jpg";
        const rec = await runOwn(
            wire,
            "sendVideoFile",
            [{ file: made.clip, thumbnailUrl: thumb, width: 1, height: 1 }, GROUP, 1],
            {
                replies: replies(),
                during: playFileDone(reg, ["clip.mp4"], "callback"),
            },
        );
        assert.equal(rec.error, null);
        assert.equal(rec.requests.length, 1);
        assert.equal(rec.requests[0].params.grid, GROUP);
        assert.equal(videoCalls[0].options.thumbnailUrl, thumb);
        assert.equal(videoCalls[0].type, 1);
    });

    it("sendVideoFile refuses, before any request, what cannot be a video message", async () => {
        const cases = [
            [{ thumbnailUrl: "https://x.zalo.invalid/t.jpg", width: 1, height: 1 }, "Missing video file"],
            [{ file: made.clip, width: 1, height: 1 }, /needs a thumbnail/],
            [{ file: made.clip, thumbnailUrl: "https://x.zalo.invalid/t.jpg" }, /width and height/],
            [
                { file: IMAGES.png.path, thumbnailUrl: "https://x.zalo.invalid/t.jpg", width: 1, height: 1 },
                /not a video/,
            ],
            [{ file: made.clip, thumbnailFile: made.spaced, width: 1, height: 1 }, /not a jpg, png or webp/],
        ];
        for (const [options, message] of cases) {
            const rec = await runOwn(wire, "sendVideoFile", [options, USER, 0], { replies: replies() });
            assert.equal(rec.requests.length, 0, JSON.stringify(options));
            assert.match(rec.error.message, message instanceof RegExp ? message : new RegExp(`^${message}$`));
        }
    });

    it("a photo, a file and a GIF: attachment[i] carries the clientId its own send went out with", async () => {
        const rec = await compared(
            "sendMessage/mixed",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.png.path, FILES.pdf.path, IMAGES.gif.path] }, USER, 0],
            { replies: replies(), during: playFileDone(reg, ["document.pdf"], "callback") },
        );
        const sends = rec.own.requests.filter((r) => ["photo", "file", "gif"].includes(requestKind(r)));
        assert.deepEqual(sends.map(requestKind), ["photo", "file", "gif"], "files in the order given, GIFs last");
        const ids = sends.map((r) => String(r.params.clientId));
        assert.equal(new Set(ids).size, 3, "no two sends share a clientId");
        assert.deepEqual(
            rec.own.result.attachment.map((a) => a.cliMsgId),
            ids,
        );
        assert.deepEqual(
            rec.own.result.attachment.map((a) => a.msgId),
            [msgIdOf(photoIdOf("image-64x48.png")), msgIdOf(fileIdOf("document.pdf")), gifMsgIdOf("image-64x48.gif")],
        );
    });

    it("a caption beside a file goes first, through sendMessage, and the file takes the next clientId", async () => {
        captionCalls.length = 0;
        const raw = await wire.run("sendMessage", [{ msg: "see the file", attachments: [FILES.pdf.path] }, GROUP, 1], {
            replies: replies(),
            during: playFileDone(reg, ["document.pdf"], "settle"),
        });
        // The caption is handed to the text half, before any upload, without the attachments.
        assert.equal(captionCalls.length, 1);
        const [call] = captionCalls;
        assert.equal(call.message.msg, "see the file");
        assert.equal("attachments" in call.message, false);
        assert.deepEqual([call.threadId, call.type], [GROUP, 1]);
        // The first request came after the caption: the fake had the same count then as when the run began.
        assert.equal(call.requestsBefore, currentFake.requests.length - raw.own.requests.length);
        assert.deepEqual(raw.own.result.message, { msgId: TEXT_MSG_ID, cliMsgId: String(T0) });
        await expectGolden("upload", "sendMessage/caption-separate", raw.own);
    });

    it("an inner error_code 1 on a chunk is Zalo's 'already uploaded': the photo is sent", async () => {
        const rec = await compared(
            "sendMessage/duplicate",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.png.path] }, USER, 0],
            { replies: replies({ photoDuplicate: true }) },
        );
        assert.equal(ofKind(rec.own.requests, "photo")[0].params.rawUrl, photoUrlsOf("image-64x48.png").normalUrl);
    });

    it("uploadAttachment alone gives each file's upload result", async () => {
        const rec = await compared(
            "uploadAttachment/image-and-file",
            "uploadAttachment",
            [[IMAGES.png.path, FILES.txt.path], USER, 0],
            { replies: replies(), during: playFileDone(reg, ["notes.txt"], "callback") },
        );
        assert.deepEqual(
            rec.own.result.map((r) => r.fileType),
            ["image", "others"],
        );
        assert.equal(rec.own.result[1].fileUrl, fileUrlOf("notes.txt"));
        assert.equal(rec.own.result[1].checksum, md5(readFileSync(FILES.txt.path)));
        assert.equal(rec.own.requests.length, 2, "an upload alone sends nothing");
    });
});

// ── limits ───────────────────────────────────────────────────────────────

describe("wire: limits are refused before any request", () => {
    let wire;
    before(async () => {
        // 0.002 MB = 2097 bytes: the 4609-byte jpg is over it, the 587-byte png under it.
        wire = await openUploadWire({ settings: { features: { sharefile: { max_size_share_file_v3: 0.002 } } } });
    });
    after(() => wire?.close());

    const cases = [
        ["sendMessage/limit-count", Array(11).fill(IMAGES.png.path), "Exceed maximum file of 10"],
        ["sendMessage/limit-extension", [IMAGES.png.path, made.exe], 'File extension "exe" is not allowed'],
        [
            "sendMessage/limit-size",
            [IMAGES.jpgLarge.path],
            "File image-200x120.jpg size exceed maximum size of 0.002MB",
        ],
        ["sendMessage/limit-not-found", [join(DIR, "missing.pdf")], "File not found"],
    ];
    for (const [name, files, message] of cases) {
        it(`${name.split("/")[1]}: "${message}"`, async () => {
            const rec = named(
                await wire.run("sendMessage", [{ msg: "", attachments: files }, USER, 0], { replies: replies() }),
                name,
            );
            await expectGolden("upload", name, rec.own);
            assert.deepEqual(rec.own.error, { message, code: null });
            assert.equal(rec.own.requests.length, 0);
        });
    }

    it("a refused file stops the caption too (the caption is not sent first)", async () => {
        captionCalls.length = 0;
        const rec = named(
            await wire.run("sendMessage", [{ msg: "a caption", attachments: [made.exe] }, USER, 0], {
                replies: replies(),
            }),
            "sendMessage/limit-before-caption",
        );
        await expectGolden("upload", "sendMessage/limit-before-caption", rec.own);
        assert.equal(captionCalls.length, 0);
        assert.equal(rec.own.requests.length, 0);
    });
});

// ── chunks ───────────────────────────────────────────────────────────────

describe("wire: a file in several chunks", () => {
    let wire;
    let reg;
    before(async () => {
        wire = await openUploadWire({ settings: { features: { sharefile: { chunk_size_file: 64000 } } } });
        reg = wire.ctx.uploadCallbacks;
    });
    after(() => wire?.close());

    it("200000 bytes at 64000 a chunk: four chunks, each the file's own bytes", async () => {
        const rec = named(
            await wire.run("sendMessage", [{ msg: "", attachments: [made.big] }, USER, 0], {
                replies: replies(),
                during: playFileDone(reg, ["big.bin"], "callback"),
            }),
            "sendMessage/file-multi-chunk",
        );
        await expectGolden("upload", "sendMessage/file-multi-chunk", rec.own);
        const chunks = ofKind(rec.own.requests, "chunk");
        const bytes = readFileSync(made.big);
        assert.deepEqual(
            chunks.map((c) => [c.params.chunkId, c.params.totalChunk]),
            [
                [1, 4],
                [2, 4],
                [3, 4],
                [4, 4],
            ],
        );
        assert.deepEqual(
            chunks.map((c) => c.parts[0].sha256),
            [0, 1, 2, 3].map((i) => sha256(bytes.subarray(i * 64000, (i + 1) * 64000))),
        );
        assert.equal(ofKind(rec.own.requests, "file")[0].params.checksum, md5(bytes));
    });

    it("at most three chunks in flight; the last goes alone once the others answered, and its reply is the one used", async () => {
        let inFlight = 0;
        let most = 0;
        const answered = [];
        let lastArrivedAfter = null;
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [made.wide] }, USER, 0], {
            replies: replies(),
            raw: (fake) =>
                fake.rawRoute(
                    (r) => r.path.endsWith("/asyncfile/upload"),
                    async (r) => {
                        const { chunkId, totalChunk } = r.params;
                        if (chunkId === totalChunk) lastArrivedAfter = [...answered];
                        inFlight++;
                        most = Math.max(most, inFlight);
                        // Chunk 1 answers last of all, and claims another fileId: a sender that took the reply
                        // that came last, instead of the last chunk's, would send that id.
                        await sleep(chunkId === 1 ? 300 : 80 + chunkId * 10);
                        inFlight--;
                        answered.push(chunkId);
                        const data =
                            chunkId < totalChunk
                                ? { chunkId, finished: 0, fileId: chunkId === 1 ? "5999990001" : "-1" }
                                : {
                                      chunkId,
                                      finished: 1,
                                      fileId: fileIdOf("wide.bin"),
                                      clientFileId: r.params.clientId,
                                  };
                        return fake.answer({ data }, r);
                    },
                ),
            during: playFileDone(reg, ["wide.bin"], "settle"),
        });
        assert.equal(rec.error, null);
        // Red if the chunks went one by one (1) or all at once (5).
        assert.equal(most, 3);
        assert.deepEqual([...lastArrivedAfter].sort(), [1, 2, 3, 4, 5], "the last chunk waited for every other one");
        assert.equal(ofKind(rec.requests, "file")[0].params.fileId, fileIdOf("wide.bin"));
        assert.equal(ofKind(rec.requests, "chunk").length, 6);
    });
});

describe("wire: the chunk size", () => {
    it("is the server's chunk_size_file when it is a number of at least 64000, else 256000", () => {
        const of = (v) => uploadSettings({ settings: { features: { sharefile: { chunk_size_file: v } } } }).chunkSize;
        assert.equal(of(3145728), 3145728);
        assert.equal(of(64000), 64000);
        assert.equal(of(63999), DEFAULT_CHUNK_SIZE);
        assert.equal(of(1000), DEFAULT_CHUNK_SIZE);
        assert.equal(of("x"), DEFAULT_CHUNK_SIZE);
        assert.equal(of(undefined), DEFAULT_CHUNK_SIZE);
        assert.equal(DEFAULT_CHUNK_SIZE, 256000);
    });

    it("a server chunk size too small to use: the whole 4674-byte pdf goes as one chunk of 256000", async () => {
        const wire = await openUploadWire({ settings: { features: { sharefile: { chunk_size_file: 1000 } } } });
        try {
            const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.pdf.path] }, USER, 0], {
                replies: replies(),
                during: playFileDone(wire.ctx.uploadCallbacks, ["document.pdf"], "settle"),
            });
            await expectGolden("upload", "sendMessage/chunk-fallback", rec);
            const chunks = ofKind(rec.requests, "chunk");
            // Five chunks of 1000 bytes would be the server's size taken as it is.
            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].params.totalChunk, 1);
            assert.equal(chunks[0].parts[0].size, readFileSync(FILES.pdf.path).length);
        } finally {
            wire.close();
        }
    });
});

// ── the wait for the server's word ───────────────────────────────────────

describe("wire: waiting for the upload's URL (bounded, never forever)", () => {
    let wire;
    let reg;
    before(async () => {
        wire = await openUploadWire();
        reg = wire.ctx.uploadCallbacks;
    });
    after(() => wire?.close());

    const uploadsOf = () => currentFake.requests.filter((r) => r.path.endsWith("/asyncfile/upload"));

    it("a file_done that comes before the wait starts is kept for it, not lost", async () => {
        const id = fileIdOf("notes.txt");
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
            replies: replies(),
            raw: (fake) =>
                fake.rawRoute(
                    (r) => r.path.endsWith("/asyncfile/upload"),
                    (r) => {
                        // The listener settles while the chunk's reply is still on its way.
                        reg.settle(id, {
                            url: fileUrlOf("notes.txt"),
                            kind: "file_done",
                            data: fileDone(id, fileUrlOf("notes.txt")),
                        });
                        return fake.answer(
                            { data: { finished: 1, fileId: id, clientFileId: r.params.clientId, chunkId: 1 } },
                            r,
                        );
                    },
                ),
        });
        await expectGolden("upload", "sendMessage/early-file-done", rec);
        assert.equal(rec.error, null);
        assert.equal(ofKind(rec.requests, "chunk").length, 1, "no replay: the early settlement was used");
        assert.equal(ofKind(rec.requests, "file")[0].params.fileUrl, fileUrlOf("notes.txt"));
    });

    it("no file_done: the last chunk is sent again at 30 s and at 120 s, then the upload fails", async () => {
        let start = 0;
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
            replies: replies(),
            during: async (clock) => {
                start = uploadsOf().length;
                await until(() => uploadsOf().length === start + 1 && reg.has(fileIdOf("notes.txt")), "the wait");
                clock.advance(29999);
                await sleep(TICK_MS * 3);
                assert.equal(uploadsOf().length, start + 1, "nothing is replayed before 30 s");
                clock.advance(1);
                await until(() => uploadsOf().length === start + 2, "the replay at 30 s");
                clock.advance(89999);
                await sleep(TICK_MS * 3);
                assert.equal(uploadsOf().length, start + 2, "nothing more before 120 s");
                clock.advance(1);
                await until(() => uploadsOf().length === start + 3, "the replay at 120 s");
            },
        });
        await expectGolden("upload", "sendMessage/no-file-done", rec);
        assert.equal(rec.error?.code, "UPLOAD_TIMEOUT");
        const chunks = ofKind(rec.requests, "chunk");
        assert.equal(chunks.length, 3);
        // A replay is the same request again: same sealed params, same bytes.
        assert.equal(chunks[1].rawParams, chunks[0].rawParams);
        assert.equal(chunks[2].rawParams, chunks[0].rawParams);
        assert.deepEqual(chunks[1].parts, chunks[0].parts);
        assert.equal(ofKind(rec.requests, "file").length, 0, "nothing is sent without a URL");
        assert.equal(reg.has(fileIdOf("notes.txt")), false, "the wait left nothing behind");
    });

    it("a replayed last chunk whose reply carries the URL settles the upload", async () => {
        const id = fileIdOf("data.csv");
        let served = 0;
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.csv.path] }, USER, 0], {
            raw: (fake) =>
                fake.rawRoute(
                    (r) => r.path.endsWith("/asyncfile/upload"),
                    (r) => {
                        served++;
                        const data = { finished: 1, fileId: id, clientFileId: r.params.clientId, chunkId: 1 };
                        if (served > 1) data.url = fileUrlOf("data.csv");
                        return fake.answer({ data }, r);
                    },
                ),
            replies: replies(),
            during: async (clock) => {
                await until(() => served === 1 && reg.has(id), "the wait");
                clock.advance(30000);
                await until(() => served === 2, "the replay");
            },
        });
        await expectGolden("upload", "sendMessage/replay-gives-url", rec);
        assert.equal(rec.error, null);
        assert.equal(ofKind(rec.requests, "chunk").length, 2);
        assert.equal(ofKind(rec.requests, "file")[0].params.fileUrl, fileUrlOf("data.csv"));
    });

    it("the last replay never answers: the upload still fails, FINAL_REPLAY_GRACE_MS after the wait", async () => {
        const id = fileIdOf("notes.txt");
        let served = 0;
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
            raw: (fake) =>
                fake.rawRoute(
                    (r) => r.path.endsWith("/asyncfile/upload"),
                    (r) => {
                        served++;
                        if (served > 1) return fake.answer({ hang: true }, r); // every replay: no answer
                        return fake.answer(
                            { data: { finished: 1, fileId: id, clientFileId: r.params.clientId, chunkId: 1 } },
                            r,
                        );
                    },
                ),
            replies: replies(),
            during: async (clock) => {
                await until(() => served === 1 && reg.has(id), "the wait");
                clock.advance(30000);
                await until(() => served === 2, "the replay at 30 s");
                clock.advance(90000);
                await until(() => served === 3, "the replay at 120 s");
                clock.advance(FINAL_REPLAY_GRACE_MS - 1);
                await sleep(TICK_MS * 3);
                // Red if the wait gave up before the grace ran out (its entry goes when it ends).
                assert.equal(reg.has(id), true, "still waiting for the last replay");
                clock.advance(1);
                // Red (the test times out) if the wait stays on the hung replay.
                await until(() => !reg.has(id), "the upload to give up");
            },
        });
        assert.equal(rec.error?.code, "UPLOAD_TIMEOUT");
        assert.equal(ofKind(rec.requests, "chunk").length, 3);
        assert.equal(ofKind(rec.requests, "file").length, 0);
    });

    it("a chunk that never answers fails the send instead of holding it forever", { timeout: 15000 }, async () => {
        // The kernel's request timeout is AbortSignal.timeout(def.timeoutMs): record what each request asks for,
        // and make a chunk's 60 s a few real milliseconds. Red (the test times out, or the assertion on `asked`
        // fails) when the chunk endpoint has no timeout, as a multipart call otherwise has none.
        const realTimeout = AbortSignal.timeout;
        const asked = [];
        AbortSignal.timeout = (ms) => {
            asked.push(ms);
            return realTimeout.call(AbortSignal, ms === CHUNK_TIMEOUT_MS ? 30 : ms);
        };
        let rec;
        try {
            rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
                raw: (fake) =>
                    fake.rawRoute(
                        (r) => r.path.endsWith("/asyncfile/upload"),
                        (r) => fake.answer({ hang: true }, r),
                    ),
                replies: replies(),
            });
        } finally {
            AbortSignal.timeout = realTimeout;
        }
        assert.ok(asked.includes(CHUNK_TIMEOUT_MS), `the chunk asked for ${CHUNK_TIMEOUT_MS} ms (asked: ${asked})`);
        assert.notEqual(rec.error, null, "the send failed");
        assert.equal(ofKind(rec.requests, "chunk").length, 1);
        assert.equal(ofKind(rec.requests, "file").length, 0);
    });

    it("a photo whose chunk reply has no URLs waits for photo_success and fills them from it", async () => {
        const id = photoIdOf("image-64x48.jpg");
        const urls = {
            org: "https://photo.zalo.invalid/o.jpg",
            hd: "https://photo.zalo.invalid/h.jpg",
            thumb: "https://photo.zalo.invalid/t.jpg",
        };
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [IMAGES.jpg.path] }, USER, 0], {
            replies: replies({ photoWithoutUrls: true }),
            during: async () => {
                await until(() => reg.has(id), "the photo's wait");
                // The control's data arrives as a JSON string, as Zalo sends it.
                reg.settle(id, {
                    url: null,
                    kind: "photo_success",
                    data: {
                        content: { act_type: "photo_success", act: "photo", fileId: id, data: JSON.stringify(urls) },
                    },
                });
            },
        });
        await expectGolden("upload", "sendMessage/photo-success", rec);
        const send = ofKind(rec.requests, "photo")[0];
        assert.deepEqual(
            [send.params.rawUrl, send.params.hdUrl, send.params.thumbUrl, send.params.normalUrl],
            [urls.org, urls.hd, urls.thumb, urls.org],
        );
    });

    it("the name on the wire is the base name, whatever separators the path has", async () => {
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [made.spaced] }, USER, 0], {
            replies: replies(),
            during: playFileDone(reg, ["report 1.txt"], "settle"),
        });
        const [chunk] = ofKind(rec.requests, "chunk");
        assert.equal(chunk.params.fileName, "report 1.txt");
        assert.equal(chunk.parts[0].filename, "report 1.txt");
        assert.equal(ofKind(rec.requests, "file")[0].params.fileName, basename(made.spaced));
    });

    it("the replay delay grows with the size, in 30 MB steps, and the server's table replaces the Web's", () => {
        assert.equal(replayDelayMs(0), 30000);
        assert.equal(replayDelayMs(REPLAY_SIZE_STEP - 1), 30000);
        assert.equal(replayDelayMs(REPLAY_SIZE_STEP), 35000);
        assert.equal(replayDelayMs(5 * REPLAY_SIZE_STEP), 60000);
        assert.equal(replayDelayMs(100 * REPLAY_SIZE_STEP), 60000);
        const cfg = uploadSettings({
            settings: {
                features: {
                    retry_upload_file_configs: {
                        upload_file_timeout_replay_last_chunk: [5, 7],
                        upload_file_timeout_wait_ctrl_event: "9000",
                        enable_resend_lastchunk: false,
                    },
                },
            },
        });
        assert.deepEqual([cfg.replaySeconds, cfg.waitMs, cfg.replay], [[5, 7], 9000, false]);
        assert.equal(replayDelayMs(REPLAY_SIZE_STEP * 3, cfg.replaySeconds), 7000);
        const defaults = uploadSettings({});
        assert.deepEqual([defaults.waitMs, defaults.replay], [120000, true]);
    });
});

// ── the settlement, from either listener ─────────────────────────────────

describe("upload settlement: either listener reaches our wait (upload.js)", () => {
    let wire;
    let reg;
    before(async () => {
        wire = await openUploadWire();
        reg = wire.ctx.uploadCallbacks;
    });
    after(() => wire?.close());

    it("our listener on a file_done: the Map entry and the waiter take it, nothing is left behind", async () => {
        const id = fileIdOf("notes.txt");
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
            replies: replies(),
            during: playFileDone(reg, ["notes.txt"], "settle"),
        });
        assert.equal(rec.error, null);
        assert.equal(ofKind(rec.requests, "file")[0].params.fileUrl, fileUrlOf("notes.txt"));
        assert.equal(ofKind(rec.requests, "chunk").length, 1, "no replay");
        // Red if settle() parked the control in the early cache although the Map entry and the waiter took it.
        assert.equal(reg.early.has(id), false, "no stale early settlement");
        assert.equal(reg.has(id), false, "the wait's own entry is gone");
    });

    it("our listener on a photo_success: the one URL the Map entry gets is ignored, the control fills all three", async () => {
        const id = photoIdOf("image-64x48.jpg");
        const urls = {
            org: "https://photo.zalo.invalid/o.jpg",
            hd: "https://photo.zalo.invalid/h.jpg",
            thumb: "https://photo.zalo.invalid/t.jpg",
        };
        const control = {
            actionId: "1",
            controlId: "1",
            content: { act_type: "photo_success", act: "photo", fileId: id, data: JSON.stringify(urls) },
        };
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [IMAGES.jpg.path] }, USER, 0], {
            replies: replies({ photoWithoutUrls: true }),
            during: async () => {
                await until(() => typeof reg.get(id) === "function", "the photo's wait");
                // The registry hands the Map entry the photo's original URL as `fileUrl` (dispatch.js uploadUrl).
                playControl(reg, id, { url: urls.org, kind: "photo_success", control }, "settle");
            },
        });
        assert.equal(rec.error, null);
        const send = ofKind(rec.requests, "photo")[0];
        // Red if the Map entry's one URL ended the wait: the send would carry no thumbnail or HD URL.
        assert.deepEqual(
            [send.params.rawUrl, send.params.hdUrl, send.params.thumbUrl],
            [urls.org, urls.hd, urls.thumb],
        );
        assert.equal(reg.early.has(id), false, "no stale early settlement");
    });

    it("a {fileUrl} alone never settles a photo: it waits on for the control", async () => {
        const id = photoIdOf("image-64x48.jpg");
        const urls = {
            org: "https://photo.zalo.invalid/o.jpg",
            hd: "https://photo.zalo.invalid/h.jpg",
            thumb: "https://photo.zalo.invalid/t.jpg",
        };
        const control = {
            actionId: "1",
            controlId: "1",
            content: { act_type: "photo_success", act: "photo", fileId: id, data: JSON.stringify(urls) },
        };
        const sends = () => currentFake.requests.filter((r) => r.path.endsWith("/photo_original/send")).length;
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [IMAGES.jpg.path] }, USER, 0], {
            replies: replies({ photoWithoutUrls: true }),
            during: async () => {
                const before = sends();
                await until(() => typeof reg.get(id) === "function", "the photo's wait");
                // A listener that only calls the Map entry, with one URL, and settles nothing else.
                playControl(reg, id, { url: urls.org, kind: "photo_success", control }, "callback");
                await sleep(TICK_MS * 3);
                // Red if the entry took the one URL for a photo: the photo would have been sent already.
                assert.equal(sends(), before, "still waiting");
                reg.settle(id, { url: urls.org, kind: "photo_success", data: control });
            },
        });
        assert.equal(rec.error, null);
        const send = ofKind(rec.requests, "photo")[0];
        assert.deepEqual(
            [send.params.rawUrl, send.params.hdUrl, send.params.thumbUrl],
            [urls.org, urls.hd, urls.thumb],
        );
    });

    it("an entry someone else registered under the id is left in place, and the settle hook still reaches us", async () => {
        const id = fileIdOf("notes.txt");
        let theirs = null;
        const other = (d) => (theirs = d);
        const rec = await runOwn(wire, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
            replies: replies(),
            raw: (fake) =>
                fake.rawRoute(
                    (r) => r.path.endsWith("/asyncfile/upload"),
                    (r) => {
                        reg.set(id, other);
                        return fake.answer(
                            { data: { finished: 1, fileId: id, clientFileId: r.params.clientId, chunkId: 1 } },
                            r,
                        );
                    },
                ),
            during: async () => {
                await until(() => reg.events.listenerCount(id) > 0, "the wait");
                // Red if the wait replaced the other entry with its own: it would no longer be ours to call.
                assert.equal(reg.get(id), other);
                playControl(
                    reg,
                    id,
                    { url: fileUrlOf("notes.txt"), kind: "file_done", control: fileDone(id, fileUrlOf("notes.txt")) },
                    "settle",
                );
            },
        });
        assert.equal(rec.error, null);
        assert.deepEqual(theirs, { fileUrl: fileUrlOf("notes.txt"), fileId: id });
        assert.equal(ofKind(rec.requests, "file")[0].params.fileUrl, fileUrlOf("notes.txt"));
    });
});

describe("upload settlement: our listener over a real socket", () => {
    /** Log in, build `api` with our listener on a fake socket, and wait for the socket's key. */
    async function withOurListener(build, body) {
        const sock = await startFakeSocket();
        const fake = installFakeZalo({ wsUrls: [sock.url] });
        let api;
        try {
            const { ctx, serviceMap } = await loginOnce(ZALO_OPTIONS);
            api = await build(ctx, serviceMap, [sock.url]);
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            await until(() => api.listener.cipherKey, "the socket's key");
            installAnswers(fake, replies());
            await body({ api, ctx, sock, fake });
        } finally {
            if (api) {
                api.listener.on("error", () => {});
                api.listener.stop();
            }
            fake.uninstall();
            await sock.close();
        }
    }

    const push601 = (sock, id, name) =>
        sock.pushEncrypted({
            cmd: 601,
            sub: 0,
            version: 1,
            encrypt: 2,
            body: controlBody([fileDone(id, fileUrlOf(name))]),
        });

    it("our upload, settled by our listener from a real 601 frame: nothing is left in the early cache", async () => {
        await withOurListener(
            (ctx, map, urls) => uploadCreateApi(ctx, map, urls),
            async ({ api, ctx, sock, fake }) => {
                const id = fileIdOf("notes.txt");
                const sending = api.sendMessage({ msg: "", attachments: [FILES.txt.path] }, USER, 0);
                await until(() => ctx.uploadCallbacks.events.listenerCount(id) > 0, "the upload to wait");
                push601(sock, id, "notes.txt");
                const result = await sending;
                const send = fake.requests.find((r) => r.path.endsWith("/asyncfile/msg"));
                assert.equal(send.params.fileUrl, fileUrlOf("notes.txt"));
                assert.equal(result.attachment[0].msgId, msgIdOf(id));
                // Red if settle() parked the control although the upload's entry and waiter took it.
                assert.equal(ctx.uploadCallbacks.early.has(id), false);
                assert.equal(ctx.uploadCallbacks.has(id), false);
            },
        );
    });

    it("a plain function entry, settled by our listener: it gets {fileUrl, fileId}, nothing is left behind", async () => {
        await withOurListener(
            (ctx, map, urls) => uploadCreateApi(ctx, map, urls),
            async ({ ctx, sock }) => {
                const id = fileIdOf("notes.txt");
                // A caller that registers only a function under the id, and waits for nothing else.
                const got = new Promise((resolve) => ctx.uploadCallbacks.set(id, resolve));
                assert.equal(ctx.uploadCallbacks.events.listenerCount(id), 0, "no waiter, only the entry");
                push601(sock, id, "notes.txt");
                // Red if the registry handed the entry the control instead of {fileUrl, fileId}.
                assert.deepEqual(await got, { fileUrl: fileUrlOf("notes.txt"), fileId: id });
                // Red if settle() also parked the control: the entry took it.
                assert.equal(ctx.uploadCallbacks.early.has(id), false);
                assert.equal(ctx.uploadCallbacks.has(id), false);
            },
        );
    });
});
