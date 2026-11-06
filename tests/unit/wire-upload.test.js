/**
 * Attachments on the wire (package UPL, design 4.1; spec-send 2 and 7): `sendMessage` with files and
 * `uploadAttachment`, ours (src/zalo/api/upload.js) against zca-js's on one logged-in context, then against the
 * reviewed golden records (tests/helpers/wire-diff/golden/upload.js).
 *
 * Every difference between the two sides is a row of tests/helpers/wire-diff/allow/upload.js, and each row must
 * really be there. The cases zca-js cannot take part in (it waits forever for a 601, it loses a 601 that comes
 * early, it has no replay, no concurrency bound, no chunk-size fallback) run on our side only, with the session
 * clock frozen and moved by hand, and are checked against their golden record and by direct assertions.
 *
 * The caption that goes out beside a file is sent through `s.api.sendMessage`, which is package MSG's text half. So
 * that this file tests the upload alone, our side runs with a stand-in text half that records the call and draws the
 * next clientId as MSG's does; zca-js's caption request is checked on its own and then left out of the comparison.
 *
 * Accept-Language: the global row D3 expects our engine to send a different Accept-Language from zca-js's, but the
 * kernel (K1, src/zalo/kernel/http.js) sends the same constant today, so D3 would report "declared but absent" on
 * every request. It is left out here; the header is then compared strictly (any difference fails). Reported to the
 * orchestrator as a WP0/K1 mismatch.
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
import { readImageMetadata } from "../../src/core/zalo-client.js";
import { createApi } from "../../src/zalo/api.js";
import {
    DEFAULT_CHUNK_SIZE,
    OWN_READY,
    REPLAY_SIZE_STEP,
    TICK_MS,
    replayDelayMs,
    uploadMethods,
    uploadSettings,
} from "../../src/zalo/api/upload.js";
import { createUploadRegistry } from "../../src/zalo/kernel/session.js";
import { startFakeSocket } from "../helpers/fake-zalo/socket.js";
import { controlBody } from "../helpers/fake-zalo/sync.js";
import {
    ALLOW,
    SEED,
    T0,
    TZ,
    assertSameWire,
    expectGolden,
    freezeTime,
    loginOnce,
    openPair,
    seedRandom,
} from "../helpers/wire-diff/index.js";
import { requestKind } from "../helpers/wire-diff/allow/upload.js";
import { normalizeError, normalizeRequest, normalizeResult } from "../helpers/wire-diff/normalize.js";
import { FILES, IMAGES } from "../fixtures/index.js";
import { installFakeZalo } from "./fake-zalo-session.js";

/** The rows this file compares with: the upload area's, minus D3 (see the top of the file). */
const ROWS = ALLOW.upload.filter((r) => r.id !== "D3");

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
 * The fake's answers for the upload area. A chunk that is not the last answers `finished: 0` with id "-1" (what
 * zca-js's chunk handler expects of one; live uploads so far were all one chunk, so this shape is not verified).
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
        // zca-js's caption, a text message.
        "/sms": { data: { msgId: TEXT_MSG_ID } },
        "/sendmsg": { data: { msgId: TEXT_MSG_ID } },
    };
}

/** A `file_done` control as the 601 frame carries it. */
const fileDone = (id, url) => ({
    actionId: "1",
    controlId: "1",
    content: { act_type: "file_done", fileId: id, data: { url } },
});

/**
 * A `during` hook that plays the listener for each file in turn, once its upload waits: "zca" calls the entry
 * under the file's id with `{fileUrl, fileId}` and deletes it, as zca-js's listener does; "own" calls the settle
 * hook with the whole control, as our listener does (design 1.4).
 *
 * @param {import("../../src/zalo/kernel/session.js").UploadRegistry} reg
 * @param {string[]} names
 * @param {"zca"|"own"} listener
 */
function playFileDone(reg, names, listener) {
    return async () => {
        for (const name of names) {
            const id = fileIdOf(name);
            await until(() => typeof reg.get(id) === "function", `the upload of ${name} to wait for its 601`);
            const url = fileUrlOf(name);
            if (listener === "zca") {
                reg.get(id)({ fileUrl: url, fileId: id });
                reg.delete(id);
            } else {
                reg.settle(id, { url, kind: "file_done", data: fileDone(id, url) });
            }
        }
    };
}

// ── our side: the upload area plus a stand-in text half ─────────────────

/** Calls the stand-in text half received, with how many requests had gone out before each. */
const captionCalls = [];
let currentFake = null;

const UPLOAD_AREA = { name: "upload", factories: [uploadMethods], ready: OWN_READY };
const CAPTION_AREA = {
    name: "messages",
    factories: [
        (s) => ({
            sendText: async (message, threadId, type) => {
                captionCalls.push({ message, threadId, type, requestsBefore: currentFake?.requests.length ?? 0 });
                return { message: { msgId: TEXT_MSG_ID, cliMsgId: String(s.nextClientId()) }, attachment: [] };
            },
        }),
    ],
    ready: new Set(["sendText"]),
};

/** `createApi` for a pair: zca-js as it is; ours with the upload area and the stand-in text half only. */
function pairCreateApi(ctx, serviceMap, wsUrls, opts = {}) {
    if (opts.engine === "own")
        return createApi(ctx, serviceMap, wsUrls, { ...opts, areas: [UPLOAD_AREA, CAPTION_AREA] });
    return createApi(ctx, serviceMap, wsUrls, opts);
}

/** Open a pair whose engines come from {@link pairCreateApi}. */
async function openUploadPair(fake = {}) {
    const pair = await openPair({ fake, zaloOptions: ZALO_OPTIONS, createApi: pairCreateApi });
    currentFake = pair.fake;
    return pair;
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
 * One call on our side only, under the harness's conditions (frozen clock at T0, seeded random, fixed zone, a
 * freshly built engine), for the cases zca-js cannot take part in.
 *
 * @param {Awaited<ReturnType<typeof openUploadPair>>} pair
 * @param {string} name
 * @param {unknown[]} args
 * @param {{replies?: Record<string, object|Function>, raw?: (fake: object) => void,
 *   during?: (clock: ReturnType<typeof freezeTime>) => Promise<void>}} [fixture]
 * @returns {Promise<{requests: object[], result: unknown, error: object|null}>}
 */
async function runOwn(pair, name, args, fixture = {}) {
    const { fake, ctx } = pair;
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
        const api = await pairCreateApi(ctx, ctx.loginInfo.zpw_service_map_v3, ctx.loginInfo.zpw_ws, {
            engine: "own",
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

/** A run record under a case name (allow rows and golden entries are matched on it). */
const named = (rec, name) => ({ ...rec, name });

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
writeFileSync(made.big, pattern(200000, 5));
writeFileSync(made.wide, pattern(64000 * 5 + 1000, 9));
writeFileSync(made.exe, pattern(100, 1));
mkdirSync(join(DIR, "sub dir"));
writeFileSync(made.spaced, pattern(500, 2));

after(() => rmSync(DIR, { recursive: true, force: true }));

// ── zca-js against ours ──────────────────────────────────────────────────

describe("wire: attachments, zca-js against ours", () => {
    let pair;
    let reg;
    before(async () => {
        pair = await openUploadPair();
        reg = pair.ctx.uploadCallbacks;
    });
    after(() => pair?.close());

    /** Run, compare under `name`, and check our side against its golden record. */
    async function compared(name, method, args, fixture) {
        captionCalls.length = 0;
        const rec = named(await pair.run(method, args, fixture), name);
        assertSameWire(rec, ROWS);
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

    it("a file to a user waits for file_done, settled the way zca-js's listener does it", async () => {
        const rec = await compared(
            "sendMessage/file-dm",
            "sendMessage",
            [{ msg: "", attachments: [FILES.txt.path] }, USER, 0],
            { replies: replies(), during: playFileDone(reg, ["notes.txt"], "zca") },
        );
        const send = ofKind(rec.own.requests, "file")[0];
        assert.equal(send.params.fileUrl, fileUrlOf("notes.txt"));
        assert.equal(send.params.checksum, md5(readFileSync(FILES.txt.path)));
        assert.equal(send.params.extension, "txt");
        assert.equal(send.params.clientId, T0);
    });

    it("a file to a group, settled through our listener's hook (the whole control as data)", async () => {
        const rec = await compared(
            "sendMessage/file-group",
            "sendMessage",
            [{ msg: "", attachments: [FILES.csv.path] }, GROUP, 1],
            { replies: replies(), during: playFileDone(reg, ["data.csv"], "own") },
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
            { replies: replies(), during: playFileDone(reg, ["clip.mp4"], "zca") },
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

    it("a photo, a file and a GIF: attachment[i] carries the clientId its own send went out with", async () => {
        const rec = await compared(
            "sendMessage/mixed",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.png.path, FILES.pdf.path, IMAGES.gif.path] }, USER, 0],
            { replies: replies(), during: playFileDone(reg, ["document.pdf"], "zca") },
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
        const raw = await pair.run("sendMessage", [{ msg: "see the file", attachments: [FILES.pdf.path] }, GROUP, 1], {
            replies: replies(),
            during: playFileDone(reg, ["document.pdf"], "own"),
        });
        // zca-js's caption is a text request, first; it is MSG's to compare, so it leaves the comparison here.
        const isCaption = (r) => requestKind(r) === null;
        assert.equal(raw.zca.requests.filter(isCaption).length, 1);
        assert.ok(isCaption(raw.zca.requests[0]), "zca-js sent the caption before the file");
        assert.equal(raw.zca.requests[0].params.message, "see the file");
        // Ours handed it to the text half, before any upload, without the attachments.
        assert.equal(captionCalls.length, 1);
        const [call] = captionCalls;
        assert.equal(call.message.msg, "see the file");
        assert.equal("attachments" in call.message, false);
        assert.deepEqual([call.threadId, call.type], [GROUP, 1]);
        // Our side's first request came after the caption: the fake had the same count then as when our side began.
        assert.equal(call.requestsBefore, currentFake.requests.length - raw.own.requests.length);
        assert.deepEqual(raw.own.result.message, { msgId: TEXT_MSG_ID, cliMsgId: String(T0) });

        const rec = named(
            { ...raw, zca: { ...raw.zca, requests: raw.zca.requests.filter((r) => !isCaption(r)) } },
            "sendMessage/caption-separate",
        );
        assert.deepEqual(rec.zca.result.message, rec.own.result.message, "the same caption reply on both sides");
        assertSameWire(rec, ROWS);
        await expectGolden("upload", "sendMessage/caption-separate", rec.own);
    });

    it("an inner error_code 1 on a chunk is Zalo's 'already uploaded': the photo is sent", async () => {
        const rec = await compared(
            "sendMessage/duplicate",
            "sendMessage",
            [{ msg: "", attachments: [IMAGES.png.path] }, USER, 0],
            { replies: replies({ photoDuplicate: true }) },
        );
        assert.equal(rec.zca.error.code, 1, "zca-js threw on it");
        assert.equal(ofKind(rec.own.requests, "photo")[0].params.rawUrl, photoUrlsOf("image-64x48.png").normalUrl);
    });

    it("uploadAttachment alone gives zca-js's result shape", async () => {
        const rec = await compared(
            "uploadAttachment/image-and-file",
            "uploadAttachment",
            [[IMAGES.png.path, FILES.txt.path], USER, 0],
            { replies: replies(), during: playFileDone(reg, ["notes.txt"], "zca") },
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
    let pair;
    before(async () => {
        // 0.002 MB = 2097 bytes: the 4609-byte jpg is over it, the 587-byte png under it.
        pair = await openUploadPair({ settings: { features: { sharefile: { max_size_share_file_v3: 0.002 } } } });
    });
    after(() => pair?.close());

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
                await pair.run("sendMessage", [{ msg: "", attachments: files }, USER, 0], { replies: replies() }),
                name,
            );
            assertSameWire(rec, ROWS);
            await expectGolden("upload", name, rec.own);
            assert.deepEqual(rec.own.error, { message, code: null });
            assert.equal(rec.own.requests.length, 0);
        });
    }

    it("a refused file stops the caption too (zca-js sent the caption, then refused)", async () => {
        captionCalls.length = 0;
        const rec = named(
            await pair.run("sendMessage", [{ msg: "a caption", attachments: [made.exe] }, USER, 0], {
                replies: replies(),
            }),
            "sendMessage/limit-before-caption",
        );
        assertSameWire(rec, ROWS);
        await expectGolden("upload", "sendMessage/limit-before-caption", rec.own);
        assert.equal(captionCalls.length, 0);
        assert.equal(rec.own.requests.length, 0);
    });
});

// ── chunks ───────────────────────────────────────────────────────────────

describe("wire: a file in several chunks", () => {
    let pair;
    let reg;
    before(async () => {
        pair = await openUploadPair({ settings: { features: { sharefile: { chunk_size_file: 64000 } } } });
        reg = pair.ctx.uploadCallbacks;
    });
    after(() => pair?.close());

    it("200000 bytes at 64000 a chunk: four chunks, each the file's own bytes", async () => {
        const rec = named(
            await pair.run("sendMessage", [{ msg: "", attachments: [made.big] }, USER, 0], {
                replies: replies(),
                during: playFileDone(reg, ["big.bin"], "zca"),
            }),
            "sendMessage/file-multi-chunk",
        );
        assertSameWire(rec, ROWS);
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
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [made.wide] }, USER, 0], {
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
            during: playFileDone(reg, ["wide.bin"], "own"),
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
        const pair = await openUploadPair({ settings: { features: { sharefile: { chunk_size_file: 1000 } } } });
        try {
            const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [FILES.pdf.path] }, USER, 0], {
                replies: replies(),
                during: playFileDone(pair.ctx.uploadCallbacks, ["document.pdf"], "own"),
            });
            await expectGolden("upload", "sendMessage/chunk-fallback", rec);
            const chunks = ofKind(rec.requests, "chunk");
            // zca-js would have sent five chunks of 1000 bytes.
            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].params.totalChunk, 1);
            assert.equal(chunks[0].parts[0].size, readFileSync(FILES.pdf.path).length);
        } finally {
            pair.close();
        }
    });
});

// ── the wait for the server's word ───────────────────────────────────────

describe("wire: waiting for the upload's URL (our side; zca-js waits forever)", () => {
    let pair;
    let reg;
    before(async () => {
        pair = await openUploadPair();
        reg = pair.ctx.uploadCallbacks;
    });
    after(() => pair?.close());

    const uploadsOf = () => currentFake.requests.filter((r) => r.path.endsWith("/asyncfile/upload"));

    it("a file_done that comes before the wait starts is kept for it (zca-js loses it)", async () => {
        const id = fileIdOf("notes.txt");
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
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
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [FILES.txt.path] }, USER, 0], {
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
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [FILES.csv.path] }, USER, 0], {
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

    it("a photo whose chunk reply has no URLs waits for photo_success and fills them from it", async () => {
        const id = photoIdOf("image-64x48.jpg");
        const urls = {
            org: "https://photo.zalo.invalid/o.jpg",
            hd: "https://photo.zalo.invalid/h.jpg",
            thumb: "https://photo.zalo.invalid/t.jpg",
        };
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [IMAGES.jpg.path] }, USER, 0], {
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
        const rec = await runOwn(pair, "sendMessage", [{ msg: "", attachments: [made.spaced] }, USER, 0], {
            replies: replies(),
            during: playFileDone(reg, ["report 1.txt"], "own"),
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

// ── the settle hook, with either listener ────────────────────────────────

describe("upload settlement: ctx.uploadCallbacks.settle(fileId, {url, kind, data})", () => {
    it("takes only url, kind and data (a zca-js-shaped {fileUrl} would lose the URL)", () => {
        const reg = createUploadRegistry();
        assert.throws(() => reg.settle("1", { fileUrl: "https://f.invalid/x" }), TypeError);
        assert.throws(() => reg.settle("1", "https://f.invalid/x"), TypeError);
        assert.equal(reg.settle("1", { url: "https://f.invalid/x", kind: "file_done", data: null }), false);
    });

    it("a waiter gets the whole control from our listener's hook, and its entry is gone afterwards", async () => {
        const reg = createUploadRegistry();
        const waiting = reg.waitFor("7");
        assert.equal(typeof reg.get("7"), "function", "the waiter stands in the Map, where zca-js's listener looks");
        const control = fileDone("7", "https://f.invalid/7");
        assert.equal(reg.settle("7", { url: "https://f.invalid/7", kind: "file_done", data: control }), true);
        assert.deepEqual(await waiting, { fileId: "7", url: "https://f.invalid/7", kind: "file_done", data: control });
        assert.equal(reg.has("7"), false);
    });

    it("a waiter is reached by zca-js's listener, which only calls the entry it finds and deletes it", async () => {
        const reg = createUploadRegistry();
        const waiting = reg.waitFor("8");
        // What zca-js's listener does for a file_done.
        const cb = reg.get("8");
        cb({ fileUrl: "https://f.invalid/8", fileId: "8" });
        reg.delete("8");
        const s = await waiting;
        assert.equal(s.url, "https://f.invalid/8");
        assert.equal(s.kind, "file_done");
    });

    it("zca-js's own upload, waiting the zca-js way, is called with {fileUrl, fileId} by our hook", () => {
        const reg = createUploadRegistry();
        let got = null;
        reg.set("9", (d) => (got = d));
        assert.equal(
            reg.settle("9", { url: "https://f.invalid/9", kind: "file_done", data: fileDone("9", "x") }),
            true,
        );
        assert.deepEqual(got, { fileUrl: "https://f.invalid/9", fileId: "9" });
        assert.equal(reg.has("9"), false);
    });

    it("our upload is settled by zca-js's listener over a real socket, from a real 601 frame", async () => {
        const sock = await startFakeSocket();
        const fake = installFakeZalo({ wsUrls: [sock.url] });
        let zca;
        try {
            const { ctx, serviceMap } = await loginOnce(ZALO_OPTIONS);
            zca = await createApi(ctx, serviceMap, [sock.url], { engine: "zca" });
            const own = await pairCreateApi(ctx, serviceMap, [sock.url], { engine: "own" });
            const connected = once(zca.listener, "connected");
            zca.listener.start();
            await connected;
            await until(() => zca.listener.cipherKey, "the socket's key");
            installAnswers(fake, replies());

            const id = fileIdOf("notes.txt");
            const sending = own.sendMessage({ msg: "", attachments: [FILES.txt.path] }, USER, 0);
            await until(() => ctx.uploadCallbacks.has(id), "the upload to wait");
            sock.pushEncrypted({
                cmd: 601,
                sub: 0,
                version: 1,
                encrypt: 2,
                body: controlBody([fileDone(id, fileUrlOf("notes.txt"))]),
            });
            const result = await sending;

            const send = fake.requests.find((r) => r.path.endsWith("/asyncfile/msg"));
            assert.equal(send.params.fileUrl, fileUrlOf("notes.txt"));
            assert.equal(result.attachment[0].msgId, msgIdOf(id));
        } finally {
            if (zca) {
                zca.listener.on("error", () => {});
                zca.listener.stop();
            }
            fake.uninstall();
            await sock.close();
        }
    });
});
