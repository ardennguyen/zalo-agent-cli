/**
 * src/core/oa/content.js and `oa article` (src/commands/oa/content.js): the Article API as Zalo's OA docs "Nội dung"
 * give it.
 *
 * Every request is asserted against the docs: method, URL (all on `v2.0/article/*`), the `access_token` header, the
 * JSON body or query, and how the reply is read — create/update answer a token that `article/verify` resolves to an
 * id (polled through -214 "Bài viết đang được xử lý", bounded), the documented field limits refuse before anything
 * is sent, and the video upload is mp4/avi ≤ 50 MB. globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { OAError, saveOACreds } from "../../src/core/oa/transport.js";
import {
    ARTICLE_LIMITS,
    createArticle,
    getAllArticles,
    getArticleDetail,
    getArticleList,
    getArticleVideoStatus,
    removeArticle,
    updateArticle,
    uploadArticleVideo,
    validateArticle,
    verifyArticle,
    waitForArticle,
    waitForArticleVideo,
} from "../../src/core/oa/content.js";
import * as barrel from "../../src/core/oa-client.js";
import { registerContentCommands } from "../../src/commands/oa/content.js";
import { CONFIRM_EXIT_CODE, enforceCliGuard } from "../../src/core/confirm-guard.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const FILES = join(SANDBOX_HOME, "oa-article-files");
const V2 = "https://openapi.zalo.me/v2.0";
const ARTICLE_ID = "a000000000000000001";
const TOKEN = "proc-token-1";

/** Replace fetch: `reply(url, init, n)` returns `{ status?, json?, text?, type? }` (default `{error:0}` JSON). */
function mockFetch(reply = () => ({})) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        const body = r.text ?? JSON.stringify(r.json ?? { error: 0, message: "Success", data: {} });
        return new Response(body, {
            status: r.status ?? 200,
            headers: { "content-type": r.type ?? "application/json" },
        });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

/** The docs' sample article ("Nội dung dạng Bài viết"). */
function normalArticle(over = {}) {
    return {
        type: "normal",
        title: "News",
        author: "News",
        cover: { cover_type: "photo", photo_url: "https://example.com/c.jpg", status: "show" },
        description: "This is news",
        body: [
            { type: "text", content: "This is news" },
            { type: "image", url: "https://example.com/p.jpg", caption: "optional" },
            { type: "video", video_id: "v1", thumb: "https://example.com/t.jpg" },
            { type: "product", id: "p1" },
        ],
        status: "show",
        comment: "show",
        ...over,
    };
}

/** The docs' sample video post ("Nội dung dạng Video"). */
function videoPost(over = {}) {
    return {
        type: "video",
        title: "News",
        description: "This is news",
        video_id: "7f8c46bf7bfa94cbeb",
        avatar: "https://example.com/a.jpg",
        status: "show",
        comment: "show",
        ...over,
    };
}

const noSleep = async () => {};

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-1" });
});
afterEach(() => m?.restore());

function assertJsonPost(call, url, body) {
    assert.equal(call.url, url);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.access_token, "tok-1");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(call.init.body), body);
    assert.doesNotMatch(call.url, /access_token|tok-1/);
}

describe("create / update / verify / remove (POST v2.0/article/*, JSON body)", () => {
    it("create posts the article as given to v2.0/article/create and returns data.token", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { token: TOKEN } } }));
        const r = await createArticle(normalArticle());
        assertJsonPost(m.calls[0], `${V2}/article/create`, normalArticle());
        assert.equal(r.data.token, TOKEN);
    });

    it("create takes the video post body (type video, video_id, avatar)", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { token: TOKEN } } }));
        await createArticle(videoPost());
        assertJsonPost(m.calls[0], `${V2}/article/create`, videoPost());
    });

    it("update posts the body plus id to v2.0/article/update", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { token: TOKEN } } }));
        await updateArticle({ id: ARTICLE_ID, ...videoPost() });
        assertJsonPost(m.calls[0], `${V2}/article/update`, { id: ARTICLE_ID, ...videoPost() });
    });

    it("update without an id is refused before sending", async () => {
        m = mockFetch();
        await assert.rejects(
            updateArticle(normalArticle()),
            (e) => e.code === "invalid_article" && /id/.test(e.message),
        );
        assert.equal(m.calls.length, 0);
    });

    it("verify posts {token} to v2.0/article/verify and returns data.id", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { id: ARTICLE_ID } } }));
        const r = await verifyArticle(TOKEN);
        assertJsonPost(m.calls[0], `${V2}/article/verify`, { token: TOKEN });
        assert.equal(r.data.id, ARTICLE_ID);
    });

    it("remove posts {id} to v2.0/article/remove", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success" } }));
        await removeArticle(ARTICLE_ID);
        assertJsonPost(m.calls[0], `${V2}/article/remove`, { id: ARTICLE_ID });
    });

    it("a Zalo error (-223 article quota) surfaces as OAError with the docs' meaning", async () => {
        m = mockFetch(() => ({ json: { error: -223, message: "Your OA has reach the limit quota create article" } }));
        await assert.rejects(createArticle(normalArticle()), (e) => e instanceof OAError && e.code === -223);
    });
});

describe("the documented limits are checked before sending", () => {
    const cases = [
        ["title over 150 characters", normalArticle({ title: "x".repeat(151) }), /title is 151 characters.*150/],
        ["author over 50 characters", normalArticle({ author: "x".repeat(51) }), /author is 51.*50/],
        ["description over 300", videoPost({ description: "x".repeat(301) }), /description is 301.*300/],
        ["no type", { ...normalArticle(), type: undefined }, /type must be "normal".*"video"/],
        ["status not show/hide", normalArticle({ status: "public" }), /status must be "show" or "hide"/],
        ["comment not show/hide", videoPost({ comment: "off" }), /comment must be "show" or "hide"/],
        ["no author on an article", normalArticle({ author: "" }), /author is required/],
        ["no cover", normalArticle({ cover: undefined }), /cover is required/],
        [
            "a photo cover without photo_url",
            normalArticle({ cover: { cover_type: "photo", status: "show" } }),
            /photo_url/,
        ],
        [
            "a video cover with a bad cover_view",
            normalArticle({ cover: { cover_type: "video", video_id: "v", cover_view: "wide", status: "show" } }),
            /cover_view must be one of horizontal, vertical, square/,
        ],
        ["cover status missing", normalArticle({ cover: { cover_type: "photo", photo_url: "u" } }), /cover.status/],
        ["empty body", normalArticle({ body: [] }), /body is required/],
        ["unknown paragraph type", normalArticle({ body: [{ type: "html" }] }), /body\[0\]\.type/],
        ["text paragraph without content", normalArticle({ body: [{ type: "text" }] }), /body\[0\]\.content/],
        ["video paragraph with neither url nor video_id", normalArticle({ body: [{ type: "video" }] }), /video_id/],
        ["related_medias not an array", normalArticle({ related_medias: "a,b" }), /related_medias/],
        ["video post without video_id", videoPost({ video_id: undefined }), /video_id is required/],
        ["video post without avatar", videoPost({ avatar: undefined }), /avatar is required/],
    ];
    for (const [name, body, re] of cases) {
        it(`refuses ${name}`, async () => {
            m = mockFetch();
            await assert.rejects(createArticle(body), (e) => e.code === "invalid_article" && re.test(e.message));
            assert.equal(m.calls.length, 0);
        });
    }

    it("counts characters, not UTF-16 units or bytes: 150 Vietnamese or emoji characters pass", () => {
        assert.doesNotThrow(() => validateArticle(normalArticle({ title: "ệ".repeat(150) })));
        assert.doesNotThrow(() => validateArticle(normalArticle({ title: "😀".repeat(150) })));
        assert.equal(ARTICLE_LIMITS.title, 150);
    });

    it("lists every problem at once", () => {
        assert.throws(
            () => validateArticle(normalArticle({ title: "x".repeat(151), status: "x" })),
            (e) => /title/.test(e.message) && /status/.test(e.message),
        );
    });
});

describe("waitForArticle (verify until the token resolves)", () => {
    it("polls through -214 'still processing' and returns the id", async () => {
        m = mockFetch((_, __, n) =>
            n < 3
                ? { json: { error: -214, message: "Article is being processed" } }
                : { json: { error: 0, data: { id: ARTICLE_ID } } },
        );
        const slept = [];
        const r = await waitForArticle(TOKEN, { intervalMs: 10, sleep: async (ms) => slept.push(ms) });
        assert.equal(r.id, ARTICLE_ID);
        assert.equal(r.attempts, 3);
        assert.deepEqual(slept, [10, 10]);
        for (const c of m.calls) assertJsonPost(c, `${V2}/article/verify`, { token: TOKEN });
    });

    it("a success without data.id is still pending", async () => {
        m = mockFetch((_, __, n) => ({ json: { error: 0, data: n === 1 ? {} : { id: ARTICLE_ID } } }));
        const r = await waitForArticle(TOKEN, { sleep: noSleep });
        assert.equal(r.id, ARTICLE_ID);
        assert.equal(m.calls.length, 2);
    });

    it("any other error stops at once", async () => {
        m = mockFetch(() => ({ json: { error: -201, message: "invalid param" } }));
        await assert.rejects(waitForArticle(TOKEN, { sleep: noSleep }), (e) => e.code === -201);
        assert.equal(m.calls.length, 1);
    });

    it("gives up at the timeout with article_pending, naming the verify command and keeping the token", async () => {
        m = mockFetch(() => ({ json: { error: -214, message: "Article is being processed" } }));
        let t = 0;
        await assert.rejects(
            waitForArticle(TOKEN, {
                timeoutMs: 5000,
                intervalMs: 1000,
                now: () => t,
                sleep: async (ms) => {
                    t += ms;
                },
            }),
            (e) =>
                e.code === "article_pending" &&
                e.data.token === TOKEN &&
                e.message.includes(`oa article verify ${TOKEN}`) &&
                /5 s/.test(e.message),
        );
        assert.equal(m.calls.length, 6); // t = 0..5000: bounded, no endless loop
    });
});

describe("list / detail (GET v2.0/article/getslice, getdetail)", () => {
    it("list sends offset, limit and type as query parameters and the token as a header", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { medias: [{ id: ARTICLE_ID }], total: 1 } } }));
        const r = await getArticleList({ offset: 5, limit: 3, type: "video" });
        const u = new URL(m.calls[0].url);
        assert.equal(`${u.origin}${u.pathname}`, `${V2}/article/getslice`);
        assert.deepEqual(Object.fromEntries(u.searchParams), { offset: "5", limit: "3", type: "video" });
        assert.equal(m.calls[0].init.method, "GET");
        assert.equal(m.calls[0].init.headers.access_token, "tok-1");
        assert.equal(r.data.medias[0].id, ARTICLE_ID);
    });

    it("list defaults to offset 0, limit 10, type normal", async () => {
        m = mockFetch();
        await getArticleList();
        assert.deepEqual(Object.fromEntries(new URL(m.calls[0].url).searchParams), {
            offset: "0",
            limit: "10",
            type: "normal",
        });
    });

    it("list refuses a type other than normal/video, and bad paging, before sending", async () => {
        m = mockFetch();
        await assert.rejects(getArticleList({ type: "photo" }), /normal" or "video/);
        await assert.rejects(getArticleList({ limit: 0 }), /limit/);
        await assert.rejects(getArticleList({ offset: -1 }), /offset/);
        assert.equal(m.calls.length, 0);
    });

    it("getAllArticles walks pages until total", async () => {
        const all = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}` }));
        m = mockFetch((url) => {
            const q = new URL(url).searchParams;
            const off = Number(q.get("offset"));
            const lim = Number(q.get("limit"));
            return { json: { error: 0, data: { medias: all.slice(off, off + lim), total: 5 } } };
        });
        const r = await getAllArticles({ pageSize: 2, type: "video" });
        assert.deepEqual(
            r.medias.map((a) => a.id),
            all.map((a) => a.id),
        );
        assert.equal(r.total, 5);
        assert.deepEqual(
            m.calls.map((c) => new URL(c.url).searchParams.get("offset")),
            ["0", "2", "4"],
        );
        assert.ok(m.calls.every((c) => new URL(c.url).searchParams.get("type") === "video"));
    });

    it("getAllArticles stops on an empty page even when total says more", async () => {
        m = mockFetch((_, __, n) => ({ json: { error: 0, data: { medias: n === 1 ? [{ id: "a" }] : [], total: 9 } } }));
        const r = await getAllArticles({ pageSize: 1 });
        assert.equal(r.medias.length, 1);
        assert.equal(m.calls.length, 2);
    });

    it("detail sends id as a query parameter", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { id: ARTICLE_ID, type: "normal", title: "Title" } } }));
        const r = await getArticleDetail(ARTICLE_ID);
        const u = new URL(m.calls[0].url);
        assert.equal(`${u.origin}${u.pathname}`, `${V2}/article/getdetail`);
        assert.equal(u.searchParams.get("id"), ARTICLE_ID);
        assert.equal(m.calls[0].init.method, "GET");
        assert.equal(r.data.title, "Title");
    });
});

describe("video upload (v2.0/article/upload_video/*)", () => {
    beforeEach(() => mkdirSync(FILES, { recursive: true }));

    it("uploads mp4 as multipart part `file` with its base name and MIME type", async () => {
        const file = join(FILES, "clip.mp4");
        writeFileSync(file, Buffer.alloc(16, 1));
        m = mockFetch(() => ({ json: { error: 0, data: { token: TOKEN } } }));
        const r = await uploadArticleVideo(file);
        const c = m.calls[0];
        assert.equal(c.url, `${V2}/article/upload_video/preparevideo`);
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers.access_token, "tok-1");
        const part = c.init.body.get("file");
        assert.equal(part.name, "clip.mp4");
        assert.equal(part.type, "video/mp4");
        assert.equal(part.size, 16);
        assert.equal(r.data.token, TOKEN);
    });

    it("refuses a type other than mp4/avi, and a file over 50 MB, before sending", async () => {
        const mov = join(FILES, "clip.mov");
        writeFileSync(mov, "x");
        const big = join(FILES, "big.avi");
        writeFileSync(big, Buffer.alloc(0));
        const { truncateSync } = await import("node:fs");
        truncateSync(big, 50 * 1024 * 1024 + 1);
        m = mockFetch();
        await assert.rejects(uploadArticleVideo(mov), (e) => e.code === "upload_type" && /mp4, avi/.test(e.message));
        await assert.rejects(uploadArticleVideo(big), (e) => e.code === "upload_too_large");
        assert.equal(m.calls.length, 0);
    });

    it("video-status GETs upload_video/verify with the token as a header, not a query parameter", async () => {
        const data = { video_id: "f9377bde4e9ba7c5fe8", status: 1, convert_percent: 100 };
        m = mockFetch(() => ({ json: { error: 0, data } }));
        const r = await getArticleVideoStatus(TOKEN);
        const u = new URL(m.calls[0].url);
        assert.equal(m.calls[0].url, `${V2}/article/upload_video/verify`);
        assert.equal(u.searchParams.has("token"), false);
        assert.equal(m.calls[0].init.headers.token, TOKEN);
        assert.equal(m.calls[0].init.method, "GET");
        assert.equal(m.calls[0].init.headers.access_token, "tok-1");
        assert.deepEqual(r.data, data);
    });

    it("waitForArticleVideo polls while status 3 and returns the final answer", async () => {
        m = mockFetch((_, __, n) => ({ json: { error: 0, data: { status: n < 3 ? 3 : 1, video_id: "v1" } } }));
        const r = await waitForArticleVideo(TOKEN, { sleep: noSleep });
        assert.equal(r.data.status, 1);
        assert.equal(m.calls.length, 3);
    });

    it("waitForArticleVideo gives up at the timeout with video_pending", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { status: 3, convert_percent: 40 } } }));
        let t = 0;
        await assert.rejects(
            waitForArticleVideo(TOKEN, {
                timeoutMs: 3000,
                intervalMs: 1000,
                now: () => t,
                sleep: async (ms) => {
                    t += ms;
                },
            }),
            (e) => e.code === "video_pending" && /40%/.test(e.message) && e.message.includes("video-status"),
        );
        assert.equal(m.calls.length, 4);
    });
});

describe("the barrel re-exports the content functions", () => {
    it("src/core/oa-client.js exposes them", () => {
        for (const name of [
            "createArticle",
            "verifyArticle",
            "waitForArticle",
            "removeArticle",
            "uploadArticleVideo",
        ]) {
            assert.equal(typeof barrel[name], "function", name);
        }
    });
});

// ─── CLI ─────────────────────────────────────────────────────────────

/** Run `oa article …` in-process with --json; process.exit throws, console.log is captured. */
async function runCli(args) {
    const program = new Command();
    program.option("--json").exitOverride();
    program.hook("preAction", (_, cmd) => enforceCliGuard(cmd, { json: true }));
    const oa = program.command("oa");
    registerContentCommands(oa);
    oa.commands.forEach((c) => c.exitOverride());
    const out = [];
    const realExit = process.exit;
    const realLog = console.log;
    const realErr = console.error;
    const savedCode = process.exitCode;
    const savedMode = process.env.ZALO_JSON_MODE;
    process.env.ZALO_JSON_MODE = "1";
    _resetErrorLatch();
    let code = null;
    process.exit = (c) => {
        code = c ?? 0;
        throw new Error("__exit__");
    };
    console.log = (...a) => out.push(a.join(" "));
    console.error = () => {};
    try {
        await program.parseAsync(["--json", "oa", "article", ...args], { from: "user" });
    } catch (e) {
        if (e.message !== "__exit__") throw e;
    } finally {
        process.exit = realExit;
        console.log = realLog;
        console.error = realErr;
        if (code === null && process.exitCode) code = process.exitCode;
        process.exitCode = savedCode;
        if (savedMode === undefined) delete process.env.ZALO_JSON_MODE;
        else process.env.ZALO_JSON_MODE = savedMode;
    }
    const text = out.join("\n");
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* not JSON */
    }
    return { code: code ?? 0, text, json };
}

describe("oa article (CLI)", () => {
    it("create waits for verify and prints the article id", async () => {
        m = mockFetch((url, _, n) => {
            if (url.endsWith("/article/create")) return { json: { error: 0, data: { token: TOKEN } } };
            return n < 3
                ? { json: { error: -214, message: "processing" } }
                : { json: { error: 0, data: { id: ARTICLE_ID } } };
        });
        const r = await runCli(["create", JSON.stringify(videoPost()), "--interval", "0.001"]);
        assert.equal(r.code, 0, r.text);
        assert.equal(r.json.id, ARTICLE_ID);
        assert.equal(r.json.token, TOKEN);
        assert.equal(m.calls[0].url, `${V2}/article/create`);
        assert.deepEqual(
            m.calls.slice(1).map((c) => c.url),
            [`${V2}/article/verify`, `${V2}/article/verify`],
        );
    });

    it("create --no-wait returns Zalo's token without calling verify", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { token: TOKEN } } }));
        const r = await runCli(["create", JSON.stringify(normalArticle()), "--no-wait"]);
        assert.equal(r.code, 0, r.text);
        assert.equal(r.json.data.token, TOKEN);
        assert.equal(m.calls.length, 1);
    });

    it("create reads @file JSON", async () => {
        mkdirSync(FILES, { recursive: true });
        const f = join(FILES, "article.json");
        writeFileSync(f, JSON.stringify(normalArticle()));
        m = mockFetch(() => ({ json: { error: 0, data: { token: TOKEN } } }));
        const r = await runCli(["create", `@${f}`, "--no-wait"]);
        assert.equal(r.code, 0, r.text);
        assert.deepEqual(JSON.parse(m.calls[0].init.body), normalArticle());
    });

    it("create with a too-long title exits 1 and sends nothing", async () => {
        m = mockFetch();
        const r = await runCli(["create", JSON.stringify(videoPost({ title: "x".repeat(151) }))]);
        assert.equal(r.code, 1);
        assert.match(r.json.error, /title is 151 characters/);
        assert.equal(m.calls.length, 0);
    });

    it("update puts the article id into the body and waits", async () => {
        m = mockFetch((url) =>
            url.endsWith("/update")
                ? { json: { error: 0, data: { token: TOKEN } } }
                : { json: { error: 0, data: { id: ARTICLE_ID } } },
        );
        const r = await runCli(["update", ARTICLE_ID, JSON.stringify(videoPost())]);
        assert.equal(r.code, 0, r.text);
        assertJsonPost(m.calls[0], `${V2}/article/update`, { id: ARTICLE_ID, ...videoPost() });
        assert.equal(r.json.id, ARTICLE_ID);
    });

    it("update refuses a JSON id that differs from the argument", async () => {
        m = mockFetch();
        const r = await runCli(["update", ARTICLE_ID, JSON.stringify(videoPost({ id: "other" }))]);
        assert.equal(r.code, 1);
        assert.equal(m.calls.length, 0);
    });

    it("remove without --yes is refused (exit 2) and sends nothing; --dry-run sends nothing", async () => {
        m = mockFetch();
        const r = await runCli(["remove", ARTICLE_ID]);
        assert.equal(r.code, CONFIRM_EXIT_CODE);
        assert.match(r.text, new RegExp(`delete article ${ARTICLE_ID}`));
        const d = await runCli(["remove", ARTICLE_ID, "--dry-run"]);
        assert.equal(d.code, 0);
        assert.equal(m.calls.length, 0);
    });

    it("remove --yes posts {id} to v2.0/article/remove", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success" } }));
        const r = await runCli(["remove", ARTICLE_ID, "--yes"]);
        assert.equal(r.code, 0, r.text);
        assertJsonPost(m.calls[0], `${V2}/article/remove`, { id: ARTICLE_ID });
    });

    it("list --type video --all walks every page", async () => {
        m = mockFetch((url) => {
            const off = Number(new URL(url).searchParams.get("offset"));
            return {
                json: { error: 0, data: { medias: off < 4 ? [{ id: `a${off}` }, { id: `b${off}` }] : [], total: 4 } },
            };
        });
        const r = await runCli(["list", "--type", "video", "--all", "--limit", "2"]);
        assert.equal(r.code, 0, r.text);
        assert.equal(r.json.medias.length, 4);
        assert.equal(r.json.total, 4);
        assert.equal(m.calls.length, 2);
    });

    it("list --type photo exits 1 without sending", async () => {
        m = mockFetch();
        const r = await runCli(["list", "--type", "photo"]);
        assert.equal(r.code, 1);
        assert.equal(m.calls.length, 0);
    });

    it("verify and detail pass Zalo's answer through", async () => {
        m = mockFetch((url) => ({
            json: { error: 0, data: url.includes("verify") ? { id: ARTICLE_ID } : { id: ARTICLE_ID, title: "T" } },
        }));
        assert.equal((await runCli(["verify", TOKEN])).json.data.id, ARTICLE_ID);
        assert.equal((await runCli(["detail", ARTICLE_ID])).json.data.title, "T");
    });

    it("video-upload --wait reports a failed conversion as a failure", async () => {
        mkdirSync(FILES, { recursive: true });
        const file = join(FILES, "clip.avi");
        writeFileSync(file, "x");
        m = mockFetch((url) =>
            url.endsWith("preparevideo")
                ? { json: { error: 0, data: { token: TOKEN } } }
                : { json: { error: 0, data: { status: 4, status_message: "convert failed" } } },
        );
        const r = await runCli(["video-upload", file, "--wait"]);
        assert.equal(r.code, 1);
        assert.match(r.json.error, /failed/);
    });

    it("video-status prints Zalo's status", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { status: 1, video_id: "v1" } } }));
        const r = await runCli(["video-status", TOKEN]);
        assert.equal(r.code, 0);
        assert.equal(r.json.data.video_id, "v1");
    });
});
