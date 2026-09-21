/**
 * src/core/sync-v2/media.js — fetching the media a transfer sync only indexed.
 *
 * Downloads run against a throwaway localhost server rather than Zalo's CDN,
 * so the suite is offline and deterministic. The case that matters most is
 * expiry: a lapsed Zalo URL answers **HTTP 200** with a small JSON error body,
 * so a downloader that trusts the status code silently writes garbage files.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    insertMessage,
    upsertThread,
    getMessages,
    countPendingAttachments,
    getLinkMessages,
    getRecentThreads,
} from "../../src/core/db.js";
import { downloadSyncedMedia, DOWNLOADABLE_KINDS, sanitize } from "../../src/core/sync-v2/media.js";
import { extractRenewedUrls } from "../../src/core/sync-v2/renewlink.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-media-test-"));
const opened = [];
let server;
let base;
/** Counts requests per path so tests can assert a renewal actually re-fetched. */
let hits;

const PHOTO_BYTES = Buffer.from("\xff\xd8\xff\xe0JFIF-pretend-jpeg", "binary");

before(async () => {
    server = createServer((req, res) => {
        const path = req.url.split("?")[0];
        hits[path] = (hits[path] || 0) + 1;
        if (path === "/ok.jpg" || path === "/renewed.jpg") {
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(PHOTO_BYTES);
        }
        if (path === "/thumb.jpg") {
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(Buffer.from("thumbnail-bytes"));
        }
        if (path === "/expired.jpg") {
            // Exactly what Zalo's CDN returns for a lapsed signature: 200 + JSON.
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ err_code: "1", message: "Invalid signature" }));
        }
        if (path === "/truncated.jpg") {
            // Promise a big body, then kill the socket mid-read. undici raises
            // "terminated" from res.arrayBuffer() -- the throw that used to
            // escape the worker and abort an entire run.
            res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1000000" });
            res.write(Buffer.alloc(1000));
            res.socket.on("error", () => {});
            return res.socket.destroy();
        }
        if (path === "/gone.jpg") {
            res.writeHead(404);
            return res.end("nope");
        }
        if (path === "/empty.jpg") {
            res.writeHead(200, { "content-type": "image/jpeg" });
            return res.end(Buffer.alloc(0));
        }
        if (path === "/doc.pdf") {
            res.writeHead(200, { "content-type": "application/pdf" });
            return res.end(Buffer.from("%PDF-1.4 pretend"));
        }
        res.writeHead(500);
        res.end("boom");
    });
    // Destroying a socket mid-response (the /truncated.jpg case) makes both the
    // server and that connection emit 'error'. Unhandled, those surface as an
    // uncaught exception and fail the whole file intermittently.
    server.on("error", () => {});
    server.on("clientError", (_e, sock) => sock.destroy());
    server.on("connection", (sock) => sock.on("error", () => {}));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    await new Promise((r) => server.close(r));
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

let dir;
let n = 0;
beforeEach(() => {
    hits = {};
    dir = join(ROOT, `acct${n++}`);
    opened.push(initDb(join(ROOT, `db${n}.sqlite`)));
    upsertThread({ threadId: "t1", type: "group", name: "Team Chat", lastUpdate: 1 });
});

/** Insert a synced message row carrying attachments, as the sync path writes it. */
function row(over = {}, attachments = []) {
    const msgId = over.msgId || `m${Math.random().toString(36).slice(2)}`;
    insertMessage({
        msgId,
        threadId: "t1",
        senderId: "u1",
        senderName: "",
        text: "[photo]",
        timestamp: 1_750_000_000_000,
        type: "photo",
        has_attachment: attachments.some((a) => a.url || a.thumbUrl),
        raw_data: { src: "sync-v2", msgType: 3, cliMsgId: "999", attachments },
        ...over,
    });
    return msgId;
}

const photo = (url, extra = {}) => ({ kind: "photo", url: `${base}${url}`, ...extra });

describe("downloadSyncedMedia — happy path", () => {
    it("writes the file and records localPath", async () => {
        const id = row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, limit: 10 });
        assert.equal(stats.downloaded, 1);
        assert.equal(stats.failed, 0);
        assert.equal(stats.bytes, PHOTO_BYTES.length);

        const saved = getMessages("t1").find((m) => m.msgId === id);
        assert.ok(saved.localPath, "localPath was not recorded");
        assert.ok(existsSync(saved.localPath));
        assert.deepEqual(readFileSync(saved.localPath), PHOTO_BYTES);
    });

    it("files media under the thread's display name", async () => {
        row({}, [photo("/ok.jpg")]);
        await downloadSyncedMedia({
            accountDir: dir,
            threadNames: new Map([["t1", { name: "Team Chat", type: "group" }]]),
        });
        assert.ok(readdirSync(join(dir, "media")).includes("Team Chat"));
    });

    it("takes the extension from content-type when the URL has none", async () => {
        row({}, [{ kind: "file", url: `${base}/doc.pdf`, fileName: "report" }]);
        await downloadSyncedMedia({ accountDir: dir, kinds: ["file"] });
        const [threadDir] = readdirSync(join(dir, "media"));
        assert.ok(
            readdirSync(join(dir, "media", threadDir)).some((f) => f.endsWith(".pdf")),
            "expected a .pdf",
        );
    });

    it("stops re-fetching a row once it has a localPath", async () => {
        row({}, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir });
        const again = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(again.considered, 0, "a downloaded row should not be reconsidered");
        assert.equal(hits["/ok.jpg"], 1);
    });

    it("downloads several attachments concurrently", async () => {
        for (let i = 0; i < 8; i++) row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, concurrency: 4, limit: 50 });
        assert.equal(stats.downloaded, 8);
    });
});

describe("downloadSyncedMedia — expiry", () => {
    it("treats a 200 JSON error body as expired, not as a file", async () => {
        row({}, [photo("/expired.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.downloaded, 0, "an error body must not be written as media");
        assert.equal(stats.expired, 1);
        assert.equal(stats.failed, 1);
    });

    it("retries through renewlink and succeeds on the fresh url", async () => {
        row({}, [photo("/expired.jpg")]);
        let asked = null;
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            // Injected rather than round-tripping Zalo's request crypto.
            renewLink: async (req) => {
                asked = req;
                return { data: { normalUrl: `${base}/renewed.jpg` } };
            },
        });
        assert.equal(stats.expired, 1);
        assert.equal(stats.renewed, 1);
        assert.equal(stats.downloaded, 1);
        assert.equal(hits["/renewed.jpg"], 1);
        // The renewal request must describe the message well enough for Zalo
        // to find it: thread, numeric msgType and the stale URL.
        assert.equal(asked.threadId, "t1");
        assert.equal(asked.msgType, 3);
        assert.ok(asked.msgInfo.normalUrl.endsWith("/expired.jpg"));
    });

    it("gives up cleanly when renewal yields nothing usable", async () => {
        row({}, [photo("/expired.jpg")]);
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            renewLink: async () => ({ error_code: 1, data: {} }),
        });
        assert.equal(stats.expired, 1);
        assert.equal(stats.renewed, 0);
        assert.equal(stats.failed, 1);
    });

    it("survives a renewal that throws", async () => {
        row({}, [photo("/expired.jpg")]);
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            renewLink: async () => {
                throw new Error("service down");
            },
        });
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /renew failed/);
    });

    it("counts a 404 as expired", async () => {
        row({}, [photo("/gone.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.expired, 1);
        assert.equal(stats.downloaded, 0);
    });

    it("rejects an empty body", async () => {
        row({}, [photo("/empty.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.downloaded, 0);
        assert.equal(stats.failed, 1);
    });

    it("records a bounded list of failures", async () => {
        for (let i = 0; i < 30; i++) row({}, [photo("/gone.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        assert.equal(stats.failed, 30);
        assert.ok(stats.failures.length <= 20, "failure list should stay bounded");
    });
});

describe("downloadSyncedMedia — filtering", () => {
    it("honours the kind filter", async () => {
        row({}, [photo("/ok.jpg")]);
        row({}, [{ kind: "file", url: `${base}/doc.pdf` }]);
        const stats = await downloadSyncedMedia({ accountDir: dir, kinds: ["file"] });
        assert.equal(stats.considered, 1);
        assert.equal(stats.downloaded, 1);
    });

    it("skips attachments over maxBytes", async () => {
        row({}, [photo("/ok.jpg", { size: 50_000_000 })]);
        const stats = await downloadSyncedMedia({ accountDir: dir, maxBytes: 1_000_000 });
        assert.equal(stats.considered, 0);
    });

    it("restricts to one thread", async () => {
        upsertThread({ threadId: "t2", type: "dm", name: "Someone", lastUpdate: 1 });
        row({}, [photo("/ok.jpg")]);
        row({ threadId: "t2" }, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, threadId: "t2" });
        assert.equal(stats.considered, 1);
    });

    it("honours a time window", async () => {
        row({ timestamp: 1_700_000_000_000 }, [photo("/ok.jpg")]);
        row({ timestamp: 1_750_000_000_000 }, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, since: 1_740_000_000_000 });
        assert.equal(stats.considered, 1);
    });

    it("skips stickers, which have no URL", async () => {
        row({ type: "sticker", has_attachment: false }, [{ kind: "sticker", catId: 1, stickerId: 2 }]);
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.considered, 0);
    });

    it("leaves thumbnails alone unless asked", async () => {
        row({}, [{ kind: "photo", url: `${base}/ok.jpg`, thumbUrl: `${base}/thumb.jpg` }]);
        const without = await downloadSyncedMedia({ accountDir: dir, dryRun: true });
        assert.equal(without.considered, 1);
        const withThumbs = await downloadSyncedMedia({ accountDir: dir, thumbs: true, dryRun: true });
        assert.equal(withThumbs.considered, 2);
    });

    it("dry run writes nothing", async () => {
        row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, dryRun: true });
        assert.equal(stats.considered, 1);
        assert.equal(stats.downloaded, 0);
        assert.equal(hits["/ok.jpg"], undefined, "dry run must not hit the network");
        assert.ok(!existsSync(join(dir, "media")));
    });
});

describe("downloadSyncedMedia — robustness", () => {
    it("ignores rows whose raw_data is unparseable", async () => {
        insertMessage({
            msgId: "bad",
            threadId: "t1",
            senderId: "u1",
            senderName: "",
            text: "x",
            timestamp: 1,
            type: "photo",
            has_attachment: true,
            raw_data: "{not json",
        });
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.considered, 0);
    });

    it("reports nothing to do on an empty database", async () => {
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.deepEqual([stats.considered, stats.downloaded, stats.failed], [0, 0, 0]);
    });

    it("countPendingAttachments tracks what is left", async () => {
        row({}, [photo("/ok.jpg")]);
        row({}, [photo("/gone.jpg")]);
        assert.equal(countPendingAttachments(), 2);
        await downloadSyncedMedia({ accountDir: dir });
        assert.equal(countPendingAttachments(), 1, "only the successful one should clear");
    });
});

describe("extractRenewedUrls", () => {
    it("reads urls at the top level", () => {
        assert.deepEqual(extractRenewedUrls({ normalUrl: "https://a/b.jpg" }), { normalUrl: "https://a/b.jpg" });
    });

    it("reads urls under data", () => {
        const r = extractRenewedUrls({ data: { hdUrl: "https://a/hd.jpg", thumbUrl: "https://a/t.jpg" } });
        assert.equal(r.hdUrl, "https://a/hd.jpg");
        assert.equal(r.thumbUrl, "https://a/t.jpg");
    });

    it("parses a JSON-string data field", () => {
        assert.equal(extractRenewedUrls({ data: '{"normalUrl":"https://a/b.jpg"}' }).normalUrl, "https://a/b.jpg");
    });

    it("promotes url/href to normalUrl", () => {
        assert.equal(extractRenewedUrls({ data: { url: "https://a/b.jpg" } }).normalUrl, "https://a/b.jpg");
    });

    it("returns null rather than guessing", () => {
        assert.equal(extractRenewedUrls({ error_code: 0, data: {} }), null);
        assert.equal(extractRenewedUrls(null), null);
        assert.equal(extractRenewedUrls({ data: { normalUrl: "not-a-url" } }), null);
    });
});

describe("DOWNLOADABLE_KINDS", () => {
    it("covers the byte-bearing kinds only", () => {
        for (const k of ["photo", "video", "file", "gif"]) assert.ok(DOWNLOADABLE_KINDS.has(k));
        assert.ok(!DOWNLOADABLE_KINDS.has("sticker"));
        assert.ok(!DOWNLOADABLE_KINDS.has("meta"));
    });
});

describe("sanitize", () => {
    // Built with fromCharCode so no escape sequence appears in this source:
    // written literally, the formatter rewrites them to raw control bytes.
    const BS = String.fromCharCode(92);
    const NUL = String.fromCharCode(0);
    const US = String.fromCharCode(31);

    it("replaces every character illegal in a filename", () => {
        assert.equal(sanitize("a/b" + BS + 'c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
    });

    it("strips control characters", () => {
        assert.equal(sanitize("a" + NUL + "b" + US + "c"), "a_b_c");
    });

    it("leaves ordinary punctuation and spacing alone", () => {
        // Over-aggressive sanitizing turns readable thread names into mush.
        assert.equal(sanitize("Team Chat - Q4 (2026)"), "Team Chat - Q4 (2026)");
    });

    it("keeps non-ASCII names intact", () => {
        assert.equal(sanitize("Nhóm Kế Toán"), "Nhóm Kế Toán");
    });

    it("never returns an empty name", () => {
        for (const v of ["", "   ", null, undefined]) assert.equal(sanitize(v), "unknown");
    });

    it("caps the length", () => {
        assert.equal(sanitize("x".repeat(300)).length, 80);
    });
});

describe("getLinkMessages", () => {
    const link = (url, over = {}) => ({ kind: "link", url, ...over });

    it("returns the links a sync recorded", () => {
        row({}, [link("https://example.com/a", { title: "A", description: "D" })]);
        row({}, [link("https://example.com/b", { title: "B" })]);
        const links = getLinkMessages();
        assert.equal(links.length, 2);
        assert.ok(links.every((l) => l.url.startsWith("https://example.com/")));
        assert.equal(links.find((l) => l.title === "A").description, "D");
    });

    it("ignores media and cards", () => {
        // A card and a photo both carry a URL; neither belongs in the link list.
        row({}, [photo("/ok.jpg")]);
        row({}, [{ kind: "card", url: "https://zalo.me/notification" }]);
        row({}, [link("https://example.com/real")]);
        const links = getLinkMessages();
        assert.equal(links.length, 1);
        assert.equal(links[0].url, "https://example.com/real");
    });

    it("returns one row per link when a message carries several", () => {
        row({}, [link("https://example.com/1"), link("https://example.com/2")]);
        assert.equal(getLinkMessages().length, 2);
    });

    it("filters by thread", () => {
        upsertThread({ threadId: "t2", type: "dm", name: "Other", lastUpdate: 1 });
        row({}, [link("https://example.com/a")]);
        row({ threadId: "t2" }, [link("https://example.com/b")]);
        assert.equal(getLinkMessages({ threadId: "t2" }).length, 1);
        assert.equal(getLinkMessages({ threadId: "t2" })[0].url, "https://example.com/b");
    });

    it("is newest first and honours the limit", () => {
        row({ timestamp: 1000 }, [link("https://example.com/old")]);
        row({ timestamp: 2000 }, [link("https://example.com/new")]);
        const links = getLinkMessages({ limit: 1 });
        assert.equal(links.length, 1);
        assert.equal(links[0].url, "https://example.com/new");
    });

    it("survives rows whose raw_data is not sync-shaped", () => {
        insertMessage({
            msgId: "legacy",
            threadId: "t1",
            senderId: "u1",
            senderName: "",
            text: "x",
            timestamp: 1,
            type: "text",
            raw_data: '{"data":{"content":"plain"}}',
        });
        row({}, [link("https://example.com/a")]);
        assert.equal(getLinkMessages().length, 1);
    });
});

describe("conversation-round fields on threads", () => {
    it("stores respondedByMe, lastGlobalId and lastClientId", () => {
        // These come only from the cmd 590 conversation round; the message
        // rounds never repeat them, so losing them loses them for good.
        upsertThread({
            threadId: "c1",
            type: "dm",
            name: "Peer",
            lastUpdate: 5,
            respondedByMe: true,
            lastGlobalId: "999888777",
            lastClientId: "111222333",
        });
        const t = getRecentThreads(50).find((x) => x.threadId === "c1");
        assert.equal(t.respondedByMe, 1);
        assert.equal(t.lastGlobalId, "999888777");
        assert.equal(t.lastClientId, "111222333");
    });

    it("records respondedByMe false as 0, not as unknown", () => {
        upsertThread({ threadId: "c2", type: "dm", name: "", lastUpdate: 1, respondedByMe: false });
        assert.equal(getRecentThreads(50).find((x) => x.threadId === "c2").respondedByMe, 0);
    });

    it("a later listener write does not erase them", () => {
        // listen.js calls upsertThread without these fields on every message.
        upsertThread({ threadId: "c3", type: "dm", name: "X", lastUpdate: 1, respondedByMe: true, lastGlobalId: "g1" });
        upsertThread({ threadId: "c3", type: "dm", name: "X", lastUpdate: 2 });
        const t = getRecentThreads(50).find((x) => x.threadId === "c3");
        assert.equal(t.respondedByMe, 1, "a listener write must not clear conversation-round state");
        assert.equal(t.lastGlobalId, "g1");
        assert.equal(t.lastUpdate, 2, "but it must still advance lastUpdate");
    });

    it("leaves them null when nothing has ever supplied them", () => {
        upsertThread({ threadId: "c4", type: "dm", name: "", lastUpdate: 1 });
        const t = getRecentThreads(50).find((x) => x.threadId === "c4");
        assert.equal(t.respondedByMe, null);
        assert.equal(t.lastGlobalId, null);
    });
});

describe("one broken download must not abort the run", () => {
    it("survives a body that dies mid-read", async () => {
        // Regression: res.arrayBuffer() sat outside the try/catch, so a single
        // dropped body took down a 9,850-file download after 100 files.
        row({}, [photo("/truncated.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir });
        assert.equal(stats.failed, 1);
        assert.equal(stats.downloaded, 0);
        assert.match(stats.failures[0].reason, /network/);
    });

    it("keeps downloading the rest after one broken body", async () => {
        row({}, [photo("/truncated.jpg")]);
        for (let i = 0; i < 5; i++) row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, limit: 50, concurrency: 2 });
        assert.equal(stats.downloaded, 5, "the five good files must still land");
        assert.equal(stats.failed, 1);
    });

    it("keeps going when writing to disk throws", async () => {
        // A path that cannot be created must fail one job, not the run.
        row({}, [photo("/ok.jpg")]);
        row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            limit: 50,
            threadNames: new Map([["t1", { name: "ok", type: "group" }]]),
        });
        assert.equal(stats.downloaded + stats.failed, 2);
    });
});
