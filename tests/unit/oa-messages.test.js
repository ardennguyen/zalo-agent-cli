/**
 * src/core/oa/messages.js and `oa msg|upload|conv|quota`: every request asserted against Zalo's OA docs.
 *
 * Pages: "Gửi tin Tư vấn dạng văn bản / đính kèm ảnh / đính kèm file / theo mẫu yêu cầu thông tin người dùng /
 * trích dẫn / kèm Sticker", "Gửi tin nhắn … đến người dùng ẩn danh", "Thả biểu tượng cảm xúc vào tin nhắn",
 * "Kiểm tra hạn mức gửi tin tới User cụ thể", "Kiểm tra hạn mức tin nhắn OA", "Lấy thông tin Tin nhắn gần nhất /
 * trong một hội thoại", "Upload hình ảnh / file / ảnh GIF". globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { OAError, saveOACreds } from "../../src/core/oa/transport.js";
import {
    CS_REACT_ICONS,
    getAllOAConversation,
    getAllOARecentChat,
    getConversation,
    getOAMessageQuota,
    getRecentChat,
    getUserMessageQuota,
    oaUploadedId,
    reactCsMessage,
    sendAnonymousMessage,
    sendCsGif,
    sendCsRequestInfo,
    sendCsSticker,
    sendFile,
    sendImage,
    sendText,
    uploadFile,
    uploadGif,
    uploadImage,
} from "../../src/core/oa/messages.js";
import * as barrel from "../../src/core/oa-client.js";
import { registerMessagesCommands } from "../../src/commands/oa/messages.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const FILES = join(SANDBOX_HOME, "oa-message-files");
const CS = "https://openapi.zalo.me/v3.0/oa/message/cs";
const V2_MESSAGE = "https://openapi.zalo.me/v2.0/oa/message";
const QUOTA = "https://openapi.zalo.me/v3.0/oa/quota/message";
const USER = "1000000000000000001";
const MB = 1024 * 1024;

/** Replace fetch; `reply(url, init, n)` returns `{ status?, json? }`. Every call is recorded. */
function mockFetch(reply = () => ({})) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        const body = JSON.stringify(r.json ?? { error: 0, message: "Success", data: {} });
        return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

/** The one POST a send made: method, URL, headers and the parsed JSON body. */
function onePost(calls, url) {
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(c.url, url);
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers.access_token, "tok-1");
    assert.equal(c.init.headers["Content-Type"], "application/json");
    return JSON.parse(c.init.body);
}

function file(name, bytes) {
    mkdirSync(FILES, { recursive: true });
    const p = join(FILES, name);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
}

const rejectsInvalid = (fn, re) =>
    assert.rejects(fn, (e) => e instanceof OAError && e.code === "invalid_argument" && re.test(e.message));

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-1" });
});
afterEach(() => m?.restore());

describe("consultation (CS) messages: POST v3.0/oa/message/cs", () => {
    it("text: { recipient: { user_id }, message: { text } }", async () => {
        m = mockFetch();
        await sendText(USER, "hello, world!");
        assert.deepEqual(onePost(m.calls, CS), { recipient: { user_id: USER }, message: { text: "hello, world!" } });
    });

    it("text with --quote adds message.quote_message_id", async () => {
        m = mockFetch();
        await sendText(USER, "the address is …", "default", { quoteMessageId: "48687128d04c9410cd5f" });
        assert.deepEqual(onePost(m.calls, CS).message, {
            text: "the address is …",
            quote_message_id: "48687128d04c9410cd5f",
        });
    });

    it("text is 2000 characters at most (an emoji is one), checked before anything is sent", async () => {
        m = mockFetch();
        await sendText(USER, "😀".repeat(2000));
        assert.equal(m.calls.length, 1);
        await rejectsInvalid(() => sendText(USER, "a".repeat(2001)), /2001 characters; Zalo's limit is 2000/);
        await rejectsInvalid(() => sendText(USER, ""), /empty/);
        assert.equal(m.calls.length, 1);
    });

    it("image by url with a caption: media template, one image element, caption in message.text", async () => {
        m = mockFetch();
        await sendImage(USER, { url: "https://example.com/a.jpg", caption: "Caption" });
        assert.deepEqual(onePost(m.calls, CS), {
            recipient: { user_id: USER },
            message: {
                text: "Caption",
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "media",
                        elements: [{ media_type: "image", url: "https://example.com/a.jpg" }],
                    },
                },
            },
        });
    });

    it("image by attachment_id has no text when there is no caption; the older option names still work", async () => {
        m = mockFetch();
        await sendImage(USER, { imageId: "att-1" });
        assert.deepEqual(onePost(m.calls, CS).message, {
            attachment: {
                type: "template",
                payload: { template_type: "media", elements: [{ media_type: "image", attachment_id: "att-1" }] },
            },
        });
    });

    it("image takes exactly one of url / attachment_id, and a caption ≤ 2000", async () => {
        m = mockFetch();
        await rejectsInvalid(() => sendImage(USER, { url: "https://x/a.jpg", attachmentId: "a" }), /not both/);
        await rejectsInvalid(() => sendImage(USER, {}), /URL or an attachment id/);
        await rejectsInvalid(() => sendImage(USER, { url: "https://x/a.jpg", caption: "c".repeat(2001) }), /caption/i);
        assert.equal(m.calls.length, 0);
    });

    it("gif: media_type gif with the required width and height as integers", async () => {
        m = mockFetch();
        await sendCsGif(USER, { attachmentId: "gif-1", width: "320", height: "240", caption: "Hi" });
        assert.deepEqual(onePost(m.calls, CS).message, {
            text: "Hi",
            attachment: {
                type: "template",
                payload: {
                    template_type: "media",
                    elements: [{ media_type: "gif", attachment_id: "gif-1", width: 320, height: 240 }],
                },
            },
        });
        await rejectsInvalid(() => sendCsGif(USER, { attachmentId: "gif-1" }), /width and height/);
        await rejectsInvalid(() => sendCsGif(USER, { attachmentId: "g", width: 0, height: 2 }), /width and height/);
        assert.equal(m.calls.length, 1);
    });

    it("file: attachment { type: file, payload: { token } }", async () => {
        m = mockFetch();
        await sendFile(USER, "file-token-1");
        assert.deepEqual(onePost(m.calls, CS), {
            recipient: { user_id: USER },
            message: { attachment: { type: "file", payload: { token: "file-token-1" } } },
        });
    });

    it("sticker: media template with media_type sticker and the sticker id as attachment_id", async () => {
        m = mockFetch();
        await sendCsSticker(USER, "bfe458bf64fa8da4d4eb");
        assert.deepEqual(onePost(m.calls, CS).message, {
            attachment: {
                type: "template",
                payload: {
                    template_type: "media",
                    elements: [{ media_type: "sticker", attachment_id: "bfe458bf64fa8da4d4eb" }],
                },
            },
        });
    });

    it("request-info: request_user_info template, title ≤ 100, subtitle ≤ 500, image_url", async () => {
        m = mockFetch();
        await sendCsRequestInfo(USER, { title: "T", subtitle: "S", imageUrl: "https://example.com/i.png" });
        assert.deepEqual(onePost(m.calls, CS).message, {
            attachment: {
                type: "template",
                payload: {
                    template_type: "request_user_info",
                    elements: [{ title: "T", subtitle: "S", image_url: "https://example.com/i.png" }],
                },
            },
        });
        const ok = { title: "t".repeat(100), subtitle: "s".repeat(500), imageUrl: "https://x/i.png" };
        await sendCsRequestInfo(USER, ok);
        await rejectsInvalid(() => sendCsRequestInfo(USER, { ...ok, title: "t".repeat(101) }), /title is 101/);
        await rejectsInvalid(() => sendCsRequestInfo(USER, { ...ok, subtitle: "s".repeat(501) }), /subtitle is 501/);
        await rejectsInvalid(() => sendCsRequestInfo(USER, { ...ok, imageUrl: "" }), /image URL/);
        assert.equal(m.calls.length, 2);
    });

    it("reads the reply's message_id and quota as Zalo sends them", async () => {
        const data = { quota: { quota_type: "reply" }, message_id: "m-1", user_id: USER, sent_time: "1" };
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data } }));
        const r = await sendText(USER, "x");
        assert.equal(r.data.message_id, "m-1");
        assert.equal(r.data.quota.quota_type, "reply");
    });
});

describe("reactions: POST v2.0/oa/message with sender_action", () => {
    it("sends { recipient: { user_id }, sender_action: { react_icon, react_message_id } }", async () => {
        m = mockFetch();
        await reactCsMessage(USER, "789f573aecf8a9a4f0eb", "/-strong");
        assert.deepEqual(onePost(m.calls, V2_MESSAGE), {
            recipient: { user_id: USER },
            sender_action: { react_icon: "/-strong", react_message_id: "789f573aecf8a9a4f0eb" },
        });
    });

    it("accepts every documented icon and the like / heart / remove names; rejects anything else unsent", async () => {
        m = mockFetch();
        for (const icon of CS_REACT_ICONS) await reactCsMessage(USER, "m", icon);
        await reactCsMessage(USER, "m", "LIKE");
        await reactCsMessage(USER, "m", "remove");
        const icons = m.calls.map((c) => JSON.parse(c.init.body).sender_action.react_icon);
        assert.deepEqual(icons, [...CS_REACT_ICONS, "/-strong", "/-remove"]);
        await rejectsInvalid(() => reactCsMessage(USER, "m", ":-*"), /Unknown reaction/);
        assert.equal(m.calls.length, CS_REACT_ICONS.length + 2);
    });
});

describe("anonymous users: POST v2.0/oa/message with recipient { anonymous_id, conversation_id }", () => {
    const to = { anonymousId: "1ffedc467f179649cf06", conversationId: "fa8f3f8701c2e89cb1d3" };
    const recipient = { anonymous_id: to.anonymousId, conversation_id: to.conversationId };

    it("text", async () => {
        m = mockFetch();
        await sendAnonymousMessage(to, { text: "hello, world!" });
        assert.deepEqual(onePost(m.calls, V2_MESSAGE), { recipient, message: { text: "hello, world!" } });
    });

    it("image by attachment_id or url, file by token, sticker by id", async () => {
        m = mockFetch();
        await sendAnonymousMessage(to, { attachmentId: "51586aa2e5a40cfa55b5" });
        await sendAnonymousMessage(to, { imageUrl: "https://example.com/a.png" });
        await sendAnonymousMessage(to, { fileToken: "tok-file" });
        await sendAnonymousMessage(to, { stickerId: "bfe458bf64fa8da4d4eb" });
        const bodies = m.calls.map((c) => JSON.parse(c.init.body));
        for (const b of bodies) assert.deepEqual(b.recipient, recipient);
        const media = (el) => ({
            attachment: { type: "template", payload: { template_type: "media", elements: [el] } },
        });
        assert.deepEqual(bodies[0].message, media({ media_type: "image", attachment_id: "51586aa2e5a40cfa55b5" }));
        assert.deepEqual(bodies[1].message, media({ media_type: "image", url: "https://example.com/a.png" }));
        assert.deepEqual(bodies[2].message, { attachment: { type: "file", payload: { token: "tok-file" } } });
        assert.deepEqual(bodies[3].message, media({ media_type: "sticker", attachment_id: "bfe458bf64fa8da4d4eb" }));
        assert.ok(m.calls.every((c) => c.url === V2_MESSAGE));
    });

    it("needs both ids and exactly one kind of content; text ≤ 2000", async () => {
        m = mockFetch();
        await rejectsInvalid(() => sendAnonymousMessage({ anonymousId: "a" }, { text: "x" }), /conversation id/);
        await rejectsInvalid(() => sendAnonymousMessage(to, {}), /exactly one/);
        await rejectsInvalid(() => sendAnonymousMessage(to, { text: "x", stickerId: "s" }), /exactly one/);
        await rejectsInvalid(() => sendAnonymousMessage(to, { text: "x".repeat(2001) }), /2000/);
        assert.equal(m.calls.length, 0);
    });
});

describe("quotas: POST v3.0/oa/quota/message", () => {
    it("per user: body { user_id }; the reply's last_interaction and promotion pass through", async () => {
        const data = { last_interaction: "1690184100000", promotion: { daily_remain: 0, daily_total: 1 } };
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data } }));
        const r = await getUserMessageQuota(USER);
        assert.deepEqual(onePost(m.calls, QUOTA), { user_id: USER });
        assert.equal(r.data.last_interaction, "1690184100000");
    });

    it("OA quota: quota_owner OA by default; product_type and quota_type only when given", async () => {
        m = mockFetch();
        await getOAMessageQuota();
        await getOAMessageQuota({ owner: "app", productType: "cs", quotaType: "sub_quota" });
        assert.deepEqual(JSON.parse(m.calls[0].init.body), { quota_owner: "OA" });
        assert.deepEqual(JSON.parse(m.calls[1].init.body), {
            quota_owner: "APP",
            product_type: "cs",
            quota_type: "sub_quota",
        });
        assert.ok(m.calls.every((c) => c.url === QUOTA && c.init.method === "POST"));
    });

    it("rejects values the docs do not list, unsent", async () => {
        m = mockFetch();
        await rejectsInvalid(() => getOAMessageQuota({ owner: "USER" }), /quota_owner/);
        await rejectsInvalid(() => getOAMessageQuota({ productType: "promotion" }), /product_type/);
        await rejectsInvalid(() => getOAMessageQuota({ quotaType: "free" }), /quota_type/);
        assert.equal(m.calls.length, 0);
    });
});

describe("uploads: POST v2.0/oa/upload/{image,file,gif}, multipart field `file`", () => {
    const cases = [
        ["image", uploadImage, "photo.png", "image/png", { attachment_id: "att-1" }],
        ["file", uploadFile, "report.pdf", "application/pdf", { token: "tok-f" }],
        ["gif", uploadGif, "anim.gif", "image/gif", { attachment_id: "gif-1" }],
    ];
    for (const [kind, fn, name, type, data] of cases) {
        it(`${kind}: v2.0 path, the file's base name and MIME type; the reply's id is read`, async () => {
            m = mockFetch(() => ({ json: { error: 0, message: "Success", data } }));
            const r = await fn(file(name, 100));
            const [c] = m.calls;
            assert.equal(c.url, `https://openapi.zalo.me/v2.0/oa/upload/${kind}`);
            assert.equal(c.init.method, "POST");
            assert.equal(c.init.headers.access_token, "tok-1");
            const part = c.init.body.get("file");
            assert.equal(part.name, name);
            assert.equal(part.type, type);
            assert.equal(part.size, 100);
            assert.equal(oaUploadedId(r), data.attachment_id ?? data.token);
        });
    }

    it("the documented size and type limits are checked before anything is sent", async () => {
        m = mockFetch();
        await assert.rejects(
            () => uploadImage(file("big.jpg", MB + 1)),
            (e) => e.code === "upload_too_large",
        );
        await assert.rejects(
            () => uploadImage(file("pic.gif", 10)),
            (e) => e.code === "upload_type",
        );
        await assert.rejects(
            () => uploadFile(file("notes.txt", 10)),
            (e) => e.code === "upload_type",
        );
        await assert.rejects(
            () => uploadFile(file("big.docx", 5 * MB + 1)),
            (e) => e.code === "upload_too_large",
        );
        await assert.rejects(
            () => uploadGif(file("big.gif", 5 * MB + 1)),
            (e) => e.code === "upload_too_large",
        );
        assert.equal(m.calls.length, 0);
        await uploadImage(file("ok.jpg", MB));
        await uploadFile(file("ok.csv", 5 * MB));
        assert.equal(m.calls.length, 2);
    });

    it("the GIF doc's table names the id `token`: oaUploadedId reads either", () => {
        assert.equal(oaUploadedId({ data: { token: "t" } }), "t");
        assert.equal(oaUploadedId({ data: {} }), undefined);
    });
});

describe("conversation reads: GET v2.0 with ?data=<JSON>, ≤ 10 per request", () => {
    it('recent: GET listrecentchat?data={"offset":0,"count":10}', async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: [] } }));
        await getRecentChat();
        await getRecentChat(20, 5);
        const [a, b] = m.calls.map((c) => new URL(c.url));
        assert.equal(`${a.origin}${a.pathname}`, "https://openapi.zalo.me/v2.0/oa/listrecentchat");
        assert.equal(a.searchParams.get("data"), '{"offset":0,"count":10}');
        assert.equal(b.searchParams.get("data"), '{"offset":20,"count":5}');
        assert.equal(m.calls[0].init.method, "GET");
        assert.equal(m.calls[0].init.body, undefined);
    });

    it("history: user_id is a bare JSON number (the docs' long), exact past 2^53", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: [] } }));
        await getConversation(USER, 10, 10);
        const u = new URL(m.calls[0].url);
        assert.equal(`${u.origin}${u.pathname}`, "https://openapi.zalo.me/v2.0/oa/conversation");
        assert.equal(u.searchParams.get("data"), `{"user_id":${USER},"offset":10,"count":10}`);
        assert.equal(u.searchParams.get("access_token"), null);
    });

    it("count must be 1–10 and offset ≥ 0; a non-numeric user id is refused; nothing is sent", async () => {
        m = mockFetch();
        await rejectsInvalid(() => getRecentChat(0, 11), /count must be 1–10/);
        await rejectsInvalid(() => getRecentChat(0, 0), /count/);
        await rejectsInvalid(() => getRecentChat(-1, 5), /offset/);
        await rejectsInvalid(() => getConversation(USER, 0, 50), /count/);
        await rejectsInvalid(() => getConversation('1,"x":1', 0, 5), /digits/);
        assert.equal(m.calls.length, 0);
    });

    it("--all walks offsets in steps of 10 until a short page", async () => {
        const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ message_id: `m${from + i}`, src: 1 }));
        m = mockFetch((url) => {
            const { offset } = JSON.parse(new URL(url).searchParams.get("data"));
            return { json: { error: 0, message: "Success", data: offset < 20 ? rows(offset, 10) : rows(offset, 3) } };
        });
        const r = await getAllOAConversation(USER);
        const offsets = m.calls.map((c) => JSON.parse(new URL(c.url).searchParams.get("data")).offset);
        assert.deepEqual(offsets, [0, 10, 20]);
        assert.equal(r.data.length, 23);
        assert.equal(r.data[22].message_id, "m22");
    });

    it("--all stops at --max, and on a page that repeats the previous one", async () => {
        const page = Array.from({ length: 10 }, (_, i) => ({ message_id: `same${i}` }));
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: page } }));
        const r = await getAllOARecentChat();
        assert.equal(m.calls.length, 2);
        assert.equal(r.data.length, 10);
        m.restore();
        let n = 0;
        m = mockFetch(() => ({
            json: { error: 0, message: "Success", data: Array.from({ length: 10 }, () => ({ message_id: `x${n++}` })) },
        }));
        const capped = await getAllOARecentChat({ max: 15 });
        assert.equal(capped.data.length, 15);
        assert.equal(m.calls.length, 2);
    });
});

describe("the oa-client barrel", () => {
    it("re-exports every function this module exports (no name lost to an `export *` clash)", async () => {
        const mod = await import("../../src/core/oa/messages.js");
        for (const name of Object.keys(mod)) assert.equal(barrel[name], mod[name], name);
    });
});

describe("the commands", () => {
    /** Run `oa …` in-process with --json; returns the parsed reply (or the error) and the exit code. */
    async function run(args) {
        const program = new Command().exitOverride().option("--json");
        program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
        registerMessagesCommands(program.command("oa"));
        const out = [];
        const log = console.log;
        console.log = (s) => out.push(String(s));
        process.env.ZALO_JSON_MODE = "1";
        _resetErrorLatch();
        try {
            await program.parseAsync(["node", "zalo-agent", "--json", "oa", ...args]);
        } catch (e) {
            out.push(JSON.stringify({ commander: e.code }));
        } finally {
            console.log = log;
            delete process.env.ZALO_JSON_MODE;
        }
        const code = process.exitCode ?? 0;
        process.exitCode = 0;
        return { reply: out.length ? JSON.parse(out.join("\n")) : null, code };
    }

    const sent = { error: 0, message: "Success", data: { message_id: "m-1", user_id: USER } };

    it("msg image --file uploads (v2.0) and then sends the attachment_id with the caption", async () => {
        m = mockFetch((url) =>
            url.includes("/upload/")
                ? { json: { error: 0, message: "Success", data: { attachment_id: "att-9" } } }
                : { json: sent },
        );
        const { reply, code } = await run(["msg", "image", USER, "--file", file("p.jpg", 50), "--caption", "Hi"]);
        assert.equal(code, 0);
        assert.equal(reply.data.message_id, "m-1");
        assert.equal(m.calls[0].url, "https://openapi.zalo.me/v2.0/oa/upload/image");
        assert.deepEqual(JSON.parse(m.calls[1].init.body).message, {
            text: "Hi",
            attachment: {
                type: "template",
                payload: { template_type: "media", elements: [{ media_type: "image", attachment_id: "att-9" }] },
            },
        });
    });

    it("msg image with two sources, or none, fails with exit 1 before any request", async () => {
        m = mockFetch();
        const both = await run(["msg", "image", USER, "--url", "https://x/a.jpg", "--attachment-id", "a"]);
        assert.equal(both.code, 1);
        assert.match(both.reply.error, /exactly one of --url, --attachment-id, --file/);
        const none = await run(["msg", "image", USER]);
        assert.equal(none.code, 1);
        assert.equal(m.calls.length, 0);
    });

    it("msg file --file uploads (v2.0/oa/upload/file) and sends the returned token", async () => {
        m = mockFetch((url) =>
            url.includes("/upload/")
                ? { json: { error: 0, message: "Success", data: { token: "ft-1" } } }
                : { json: sent },
        );
        const { code } = await run(["msg", "file", USER, "--file", file("r.docx", 50)]);
        assert.equal(code, 0);
        assert.equal(m.calls[0].url, "https://openapi.zalo.me/v2.0/oa/upload/file");
        assert.deepEqual(JSON.parse(m.calls[1].init.body).message, {
            attachment: { type: "file", payload: { token: "ft-1" } },
        });
    });

    it("msg gif needs --width and --height (commander refuses before any request)", async () => {
        m = mockFetch();
        const r = await run(["msg", "gif", USER, "--attachment-id", "g"]);
        assert.equal(r.reply.commander, "commander.missingMandatoryOptionValue");
        assert.equal(m.calls.length, 0);
    });

    it("msg text --quote, msg react like, msg anonymous --sticker each send the documented body", async () => {
        m = mockFetch(() => ({ json: sent }));
        assert.equal((await run(["msg", "text", USER, "hi", "--quote", "q-1"])).code, 0);
        assert.equal((await run(["msg", "react", USER, "m-1", "like"])).code, 0);
        assert.equal(
            (await run(["msg", "anonymous", "anon-1", "--conversation", "conv-1", "--sticker", "s-1"])).code,
            0,
        );
        const bodies = m.calls.map((c) => JSON.parse(c.init.body));
        assert.deepEqual(bodies[0].message, { text: "hi", quote_message_id: "q-1" });
        assert.deepEqual(bodies[1].sender_action, { react_icon: "/-strong", react_message_id: "m-1" });
        assert.deepEqual(bodies[2].recipient, { anonymous_id: "anon-1", conversation_id: "conv-1" });
        assert.equal(bodies[2].message.attachment.payload.elements[0].media_type, "sticker");
        assert.deepEqual(
            m.calls.map((c) => c.url),
            [CS, V2_MESSAGE, V2_MESSAGE],
        );
    });

    it("msg anonymous --image <url> sends the url; --image <path> uploads first", async () => {
        m = mockFetch((url) =>
            url.includes("/upload/")
                ? { json: { error: 0, message: "Success", data: { attachment_id: "att-a" } } }
                : { json: sent },
        );
        await run(["msg", "anonymous", "a", "--conversation", "c", "--image", "https://example.com/x.png"]);
        await run(["msg", "anonymous", "a", "--conversation", "c", "--image", file("y.png", 10)]);
        const els = m.calls
            .filter((c) => c.url === V2_MESSAGE)
            .map((c) => JSON.parse(c.init.body).message.attachment.payload.elements[0]);
        assert.deepEqual(els, [
            { media_type: "image", url: "https://example.com/x.png" },
            { media_type: "image", attachment_id: "att-a" },
        ]);
    });

    it("conv history --count 11 is refused; conv recent --all walks pages; quota sends its filters", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: [] } }));
        const bad = await run(["conv", "history", USER, "--count", "11"]);
        assert.equal(bad.code, 1);
        assert.equal(m.calls.length, 0);
        const all = await run(["conv", "recent", "--all"]);
        assert.equal(all.code, 0);
        assert.deepEqual(all.reply.data, []);
        await run(["quota", "--product", "transaction", "--type", "purchase_quota"]);
        assert.deepEqual(JSON.parse(m.calls.at(-1).init.body), {
            quota_owner: "OA",
            product_type: "transaction",
            quota_type: "purchase_quota",
        });
        await run(["msg", "user-quota", USER]);
        assert.deepEqual(JSON.parse(m.calls.at(-1).init.body), { user_id: USER });
    });

    it("upload gif posts to v2.0/oa/upload/gif", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { attachment_id: "g-1" } } }));
        const { reply, code } = await run(["upload", "gif", file("a.gif", 10)]);
        assert.equal(code, 0);
        assert.equal(reply.data.attachment_id, "g-1");
        assert.equal(m.calls[0].url, "https://openapi.zalo.me/v2.0/oa/upload/gif");
    });
});
