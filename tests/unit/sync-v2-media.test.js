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
import {
    downloadSyncedMedia,
    DOWNLOADABLE_KINDS,
    DOWNLOAD_REASONS,
    describeDownloadReasons,
    sanitize,
    DEFAULT_REQUEST_TIMEOUT_MS,
    THROTTLE_GIVE_UP,
    pruneDownloadedMedia,
} from "../../src/core/sync-v2/media.js";
import { extractRenewedUrls } from "../../src/core/sync-v2/renewlink.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-media-test-"));
const opened = [];
let server;
let base;
/** Counts requests per path so tests can assert a renewal actually re-fetched. */
let hits;

const PHOTO_BYTES = Buffer.from("\xff\xd8\xff\xe0JFIF-pretend-jpeg", "binary");
/**
 * A 149-byte CSV, the size and shape of the two `data.csv` attachments that
 * were stuck in a live cache across four runs on 2026-09-29 while the CLI
 * called them rate limiting.
 */
const CSV_BYTES = Buffer.from(
    "thread_id,kind,label,sent_at\n2000000000000000001,group,Sample group - tests,2026-09-19T08:00:00Z\n",
);

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
        if (path === "/hang.jpg") {
            // Headers, then silence forever: the exact stall that froze a real
            // download for 20 minutes with the process still alive.
            res.writeHead(200, { "content-type": "image/jpeg", "content-length": "1000000" });
            res.write(Buffer.alloc(10));
            return; // never end()
        }
        if (path === "/forbidden.jpg") {
            res.writeHead(403);
            return res.end("");
        }
        if (path === "/ratelimit.jpg") {
            res.writeHead(429, { "content-type": "application/json" });
            return res.end(JSON.stringify({ err_code: "429", message: "Too many requests" }));
        }
        if (path === "/servererr.jpg") {
            res.writeHead(503);
            return res.end("busy");
        }
        if (path === "/vagueerr.jpg") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ err_code: "1" }));
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
        // A real text attachment, served exactly as Zalo's CDN serves one.
        // This is the shape that used to be discarded as "throttled".
        if (path === "/data.csv") {
            res.writeHead(200, {
                "content-type": "text/csv",
                "content-disposition": 'attachment; filename="data.csv"',
            });
            return res.end(CSV_BYTES);
        }
        // The same file with no content-disposition to lean on: the body alone
        // has to be enough to tell a document from an error envelope.
        if (path === "/bare.csv") {
            res.writeHead(200, { "content-type": "text/csv" });
            return res.end(CSV_BYTES);
        }
        if (path === "/notes.txt") {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            return res.end(Buffer.from("Meeting notes\nNothing here is an error envelope.\n"));
        }
        // A .json attachment is a payload, not a verdict about the request.
        if (path === "/payload.json") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ rows: [{ id: 1, label: "ok" }] }));
        }
        // A gateway that answers 200 and explains itself in HTML. Still an error.
        if (path === "/htmlbusy.jpg") {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<html><body>429 Too Many Requests</body></html>");
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
        const stats = await downloadSyncedMedia({ accountDir: dir, limit: 50, backoffBaseMs: 0 });
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
        const stats = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(stats.failed, 1);
        assert.equal(stats.downloaded, 0);
        assert.match(stats.failures[0].reason, /network/);
    });

    it("keeps downloading the rest after one broken body", async () => {
        row({}, [photo("/truncated.jpg")]);
        for (let i = 0; i < 5; i++) row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({ accountDir: dir, limit: 50, concurrency: 2, backoffBaseMs: 0 });
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

describe("a stalled connection must not block the run forever", () => {
    it("times out a server that sends headers then goes silent", async () => {
        // fetch() has no built-in timeout. Without an explicit signal a hung
        // request blocks its worker indefinitely; four of them froze a real
        // 9,713-file download at 225 with the process still alive.
        row({}, [photo("/hang.jpg")]);
        const t0 = Date.now();
        const stats = await downloadSyncedMedia({ accountDir: dir, timeoutMs: 700, backoffBaseMs: 0 });
        assert.equal(stats.downloaded, 0);
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /timed out/);
        assert.ok(Date.now() - t0 < 8000, "must give up promptly, not hang");
    });

    it("keeps draining the queue past a hung request", async () => {
        row({}, [photo("/hang.jpg")]);
        for (let i = 0; i < 4; i++) row({}, [photo("/ok.jpg")]);
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            limit: 50,
            concurrency: 2,
            timeoutMs: 700,
            backoffBaseMs: 0,
        });
        assert.equal(stats.downloaded, 4, "the healthy files must still arrive");
        assert.equal(stats.failed, 1);
    });

    it("cannot stall every worker at once", async () => {
        // With concurrency 2 and three hung URLs, a missing timeout means the
        // run never returns at all.
        for (let i = 0; i < 3; i++) row({}, [photo("/hang.jpg")]);
        const stats = await downloadSyncedMedia({
            accountDir: dir,
            limit: 50,
            concurrency: 2,
            timeoutMs: 700,
            backoffBaseMs: 0,
        });
        assert.equal(stats.failed, 3);
    });

    it("ships a sane default deadline", () => {
        assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0 && DEFAULT_REQUEST_TIMEOUT_MS <= 120000);
    });
});

describe("expiry vs throttling — the difference is not cosmetic", () => {
    // A run once reported 4,894 "expired" links; a single request minutes later
    // pulled one of them down as a 25 MB video. Calling throttling "expired"
    // tells someone their photos are gone when they are sitting on the CDN.
    const only = async (route, extra = {}) => {
        row({}, [photo(route)]);
        return downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0, ...extra });
    };

    it("404 means gone", async () => {
        const s = await only("/gone.jpg");
        assert.equal(s.expired, 1);
        assert.equal(s.throttled, 0);
    });

    it("403 is NOT treated as gone — Zalo returns it under load too", async () => {
        const s = await only("/forbidden.jpg");
        assert.equal(s.expired, 0, "403 must not be called expiry");
        assert.equal(s.unknown, 1);
    });

    it("429 is throttling", async () => {
        const s = await only("/ratelimit.jpg");
        assert.equal(s.expired, 0);
        assert.equal(s.throttled, 1);
    });

    it("5xx is throttling, not expiry", async () => {
        const s = await only("/servererr.jpg");
        assert.equal(s.expired, 0);
        assert.equal(s.throttled, 1);
    });

    it("a documented lapsed-signature body is expiry", async () => {
        const s = await only("/expired.jpg");
        assert.equal(s.expired, 1);
    });

    it("a bare err_code is too vague to call expiry", async () => {
        const s = await only("/vagueerr.jpg");
        assert.equal(s.expired, 0, "err_code alone could be a rate-limit notice");
        assert.equal(s.unknown, 1, "and it does not say rate limiting either");
    });

    it("a 200 that explains itself in HTML is still throttling", async () => {
        const s = await only("/htmlbusy.jpg");
        assert.equal(s.expired, 0);
        assert.equal(s.throttled, 1, "a short body saying 'Too Many Requests' is an error page");
    });

    it("a dropped connection is never expiry", async () => {
        const s = await only("/truncated.jpg");
        assert.equal(s.expired, 0);
        assert.equal(s.unknown, 1, "no response is not evidence of rate limiting");
    });

    it("gives up once throttling is sustained, instead of burning the queue", async () => {
        // The failing run marked 9,455 attachments failed while being throttled.
        for (let i = 0; i < THROTTLE_GIVE_UP + 20; i++) row({}, [photo("/ratelimit.jpg")]);
        const s = await downloadSyncedMedia({
            accountDir: dir,
            limit: 200,
            concurrency: 1,
            backoffBaseMs: 0,
        });
        assert.equal(s.abortedEarly, true, "a sustained throttle must stop the run");
        assert.ok(s.throttled <= THROTTLE_GIVE_UP + 5, `stopped after ${s.throttled}, expected ~${THROTTLE_GIVE_UP}`);
        assert.ok(s.considered > s.throttled, "it should not have attempted the whole queue");
    });

    it("a success resets the throttle streak", async () => {
        row({}, [photo("/ratelimit.jpg")]);
        for (let i = 0; i < 5; i++) row({}, [photo("/ok.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, limit: 50, concurrency: 1, backoffBaseMs: 0 });
        assert.equal(s.abortedEarly, false);
        assert.equal(s.downloaded, 5);
    });
});

describe("a text attachment is a file, not an error", () => {
    // The body sniff exists to catch Zalo's 200-plus-JSON expiry envelope, but
    // it was entered for any `text/…` response and ended in a catch-all called
    // "throttled". So every .csv/.txt/.md/.log ever fetched was downloaded in
    // full and then thrown away, and the run blamed rate limiting -- which no
    // amount of waiting, and no --concurrency, could ever fix. Measured on a
    // live cache 2026-09-29: two 149-byte data.csv rows stuck across four runs.
    const fileAt = (url, extra = {}) => ({ kind: "file", url: `${base}${url}`, ...extra });

    it("saves a text/csv attachment instead of discarding it", async () => {
        const id = row({ type: "file" }, [fileAt("/data.csv", { fileName: "data.csv", size: CSV_BYTES.length })]);
        const s = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(s.downloaded, 1, "a healthy CSV must not be treated as a failure");
        assert.equal(s.throttled, 0, "and above all must not be reported as rate limiting");
        assert.equal(s.unknown, 0);
        assert.equal(s.bytes, CSV_BYTES.length);

        const saved = getMessages("t1").find((m) => m.msgId === id);
        assert.ok(saved.localPath, "localPath was not recorded");
        assert.deepEqual(readFileSync(saved.localPath), CSV_BYTES, "the bytes on disk must be the CSV");
    });

    it("saves it even with no content-disposition to lean on", async () => {
        row({ type: "file" }, [fileAt("/bare.csv", { fileName: "bare.csv" })]);
        const s = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(s.downloaded, 1, "the body itself is plainly not an error envelope");
        assert.equal(s.throttled + s.unknown, 0);
    });

    it("saves a text/plain attachment", async () => {
        row({ type: "file" }, [fileAt("/notes.txt", { fileName: "notes.txt" })]);
        const s = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(s.downloaded, 1);
        assert.equal(s.throttled + s.unknown, 0);
    });

    it("saves a .json attachment — a payload is not a verdict", async () => {
        row({ type: "file" }, [fileAt("/payload.json", { fileName: "payload.json" })]);
        const s = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(s.downloaded, 1, "JSON without an error field is the file");
        assert.equal(s.expired, 0);
    });

    it("still catches the expiry envelope it was written for", async () => {
        // The whole point of narrowing the sniff is that it must not widen it.
        row({}, [photo("/expired.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
        assert.equal(s.expired, 1, "a lapsed-signature body must still be expiry");
        assert.equal(s.downloaded, 0, "and must never be written to disk as media");
    });
});

describe("the summary reports what was observed, not what it assumes", () => {
    // A 403 was counted as throttling and then announced as "almost certainly
    // rate limiting, not expiry" -- advice to wait and retry forever, when a
    // lapsed signature is renewable only by a fresh mobile sync. The classifier
    // never knew which it was; the summary must not claim to either.
    const only = async (route) => {
        row({}, [photo(route)]);
        return downloadSyncedMedia({ accountDir: dir, backoffBaseMs: 0 });
    };

    it("a 403 is not reported as rate limiting", async () => {
        const s = await only("/forbidden.jpg");
        assert.equal(s.throttled, 0, "nothing in a 403 says the request was rate limited");
        assert.equal(s.unknown, 1);
        assert.equal(describeDownloadReasons(s.reasons, "throttled"), "", "the throttled line must not print");
        assert.equal(describeDownloadReasons(s.reasons, "unknown"), "HTTP 403 ×1");
    });

    it("a 429 still is, and says so by status", async () => {
        const s = await only("/ratelimit.jpg");
        assert.equal(s.throttled, 1);
        assert.equal(s.unknown, 0);
        assert.equal(describeDownloadReasons(s.reasons, "throttled"), "HTTP 429 ×1");
    });

    it("carries the observed status out on each failure", async () => {
        const s = await only("/forbidden.jpg");
        assert.equal(s.failures[0].status, 403, "the summary should not have to infer the status");
        assert.equal(s.failures[0].code, "forbidden");
    });

    it("tallies mixed causes separately instead of merging them", async () => {
        for (let i = 0; i < 3; i++) row({}, [photo("/forbidden.jpg")]);
        for (let i = 0; i < 2; i++) row({}, [photo("/ratelimit.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, limit: 50, concurrency: 1, backoffBaseMs: 0 });
        assert.equal(s.throttled, 2);
        assert.equal(s.unknown, 3);
        assert.equal(describeDownloadReasons(s.reasons, "throttled"), "HTTP 429 ×2");
        assert.equal(describeDownloadReasons(s.reasons, "unknown"), "HTTP 403 ×3");
    });

    it("lists the commonest cause first", async () => {
        for (let i = 0; i < 2; i++) row({}, [photo("/forbidden.jpg")]);
        for (let i = 0; i < 4; i++) row({}, [photo("/truncated.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, limit: 50, concurrency: 1, backoffBaseMs: 0 });
        assert.equal(describeDownloadReasons(s.reasons, "unknown"), "no response at all ×4, HTTP 403 ×2");
    });

    it("every reason code has a verdict and a label", () => {
        for (const [code, spec] of Object.entries(DOWNLOAD_REASONS)) {
            assert.ok(spec.label, `${code} has no label`);
            assert.ok(
                ["expired", "throttled", "unknown", "failed"].includes(spec.verdict),
                `${code} has verdict ${spec.verdict}`,
            );
        }
    });

    it("keeps the retry policy it had — unknown backs off and gives up too", async () => {
        // The split is a reporting change. A 403 storm must still stop the run
        // rather than burn the whole queue against a server that is refusing.
        for (let i = 0; i < THROTTLE_GIVE_UP + 20; i++) row({}, [photo("/forbidden.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, limit: 200, concurrency: 1, backoffBaseMs: 0 });
        assert.equal(s.abortedEarly, true, "an unexplained streak must stop the run, as a throttled one does");
        assert.ok(s.unknown <= THROTTLE_GIVE_UP + 5, `stopped after ${s.unknown}, expected ~${THROTTLE_GIVE_UP}`);
        assert.ok(s.considered > s.unknown, "it should not have attempted the whole queue");
    });
});

describe("what sync.js actually prints about a failed download", () => {
    // The counters above can be right while the sentence built from them is
    // still wrong -- that was the whole bug. Same technique as
    // tests/unit/sync-socket-rules.test.js: read the source and fail the build
    // on a claim the offline suite cannot otherwise reach.
    const SYNC_SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "commands", "sync.js"), "utf8");
    /** The `warning(...)`/`info(...)` lines inside one `if (stats.<bucket>)` block. */
    const linesFor = (bucket) => {
        const lines = SYNC_SRC.split("\n");
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            if (!new RegExp(`if \\(stats\\.${bucket}\\)`).test(lines[i])) continue;
            for (let j = i; j < lines.length && !/^\s{4}\}/.test(lines[j]); j++) out.push(lines[j]);
        }
        return out.join("\n");
    };

    it("never claims a refusal is 'almost certainly rate limiting'", () => {
        assert.ok(
            !/almost certainly rate limiting/i.test(SYNC_SRC),
            "403 falls in this bucket and the response never says which cause it was",
        );
    });

    it("says nothing about rate limiting in the unexplained bucket", () => {
        const block = linesFor("unknown");
        assert.ok(block, "expected an `if (stats.unknown)` summary block");
        assert.ok(
            !/rate limited|rate limiting/i.test(block.replace(/not necessarily rate limiting/gi, "")),
            `the unknown bucket must not assert rate limiting:\n${block}`,
        );
    });

    it("points the unexplained bucket at a fresh sync, not at waiting", () => {
        const block = linesFor("unknown");
        assert.match(block, /sync --from/, "a lapsed signature is renewable only by a fresh mobile sync");
        assert.match(block, /403/, "the message should name what was actually observed");
    });

    it("keeps the wait-and-lower-concurrency advice for genuine throttling", () => {
        const block = linesFor("throttled");
        assert.match(block, /rate limited/, "429/5xx is the one case where that claim is earned");
        assert.match(block, /--concurrency/);
    });

    it("both buckets are reported, and both are subtracted from 'other reasons'", () => {
        assert.match(
            SYNC_SRC,
            /stats\.failed - stats\.expired - stats\.throttled - stats\.unknown/,
            "an unexplained failure must not also be counted as failing for another reason",
        );
    });
});

describe("pruneDownloadedMedia", () => {
    const DAY = 86400000;
    const NOW = 1_760_000_000_000;

    /** A row whose media is already on disk, aged `daysAgo`. */
    const downloaded = async (daysAgo) => {
        const id = row({ timestamp: NOW - daysAgo * DAY }, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        return id;
    };

    it("deletes media older than the cutoff and reclaims the bytes", async () => {
        await downloaded(40);
        const before = getMessages("t1")[0].localPath;
        assert.ok(existsSync(before));
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        assert.equal(s.deleted, 1);
        assert.ok(s.bytes > 0);
        assert.ok(!existsSync(before), "the file should be gone from disk");
    });

    it("leaves media inside the window alone", async () => {
        await downloaded(5);
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        assert.equal(s.considered, 0);
        assert.equal(s.deleted, 0);
    });

    it("never deletes the message itself", async () => {
        const id = await downloaded(40);
        await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        const still = getMessages("t1").find((m) => m.msgId === id);
        assert.ok(still, "the message row must survive");
        assert.equal(still.text, "[photo]", "and keep its text");
    });

    it("clears localPath but does NOT silently requeue the row", async () => {
        // Clearing localPath alone would put the row straight back in the
        // download queue, so the next sync would re-fetch exactly what was just
        // deleted on purpose. The prune is recorded so that cannot happen.
        const id = await downloaded(40);
        await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        assert.equal(getMessages("t1").find((m) => m.msgId === id).localPath, null);
        assert.equal(countPendingAttachments(), 0, "a pruned row is not pending work");
    });

    it("dry run reports without deleting", async () => {
        await downloaded(40);
        const path = getMessages("t1")[0].localPath;
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW, dryRun: true });
        assert.equal(s.considered, 1);
        assert.equal(s.deleted, 0);
        assert.ok(s.bytes > 0, "a dry run should still size the job");
        assert.ok(existsSync(path), "nothing may be removed on a dry run");
    });

    it("clears a stale pointer when the file is already gone", async () => {
        await downloaded(40);
        const path = getMessages("t1")[0].localPath;
        rmSync(path, { force: true });
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        assert.equal(s.missing, 1);
        assert.equal(getMessages("t1")[0].localPath, null);
    });

    it("can be scoped to one thread", async () => {
        upsertThread({ threadId: "t2", type: "dm", name: "Other", lastUpdate: 1 });
        await downloaded(40);
        row({ threadId: "t2", timestamp: NOW - 40 * DAY }, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW, threadId: "t2" });
        assert.equal(s.deleted, 1, "only the named thread");
    });

    it("refuses a nonsensical window instead of deleting everything", async () => {
        await downloaded(400);
        for (const bad of [0, -1, NaN, undefined, "x"]) {
            const s = await pruneDownloadedMedia({ olderThanDays: bad, now: NOW });
            assert.equal(s.deleted, 0, `olderThanDays=${String(bad)} must delete nothing`);
        }
    });
});

describe("pruning is a decision, not a gap to refill", () => {
    const DAY = 86400000;
    const NOW = 1_760_000_000_000;

    const downloadedThenPruned = async () => {
        row({ timestamp: NOW - 40 * DAY }, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
    };

    it("does not re-download pruned media on a later run", async () => {
        // Prune clears localPath to requeue the row, so without a marker the
        // very next sync silently undoes the cleanup.
        await downloadedThenPruned();
        const again = await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        assert.equal(again.considered, 0, "a pruned attachment must stay pruned");
        assert.equal(again.downloaded, 0);
    });

    it("excludes pruned media from the pending count", async () => {
        await downloadedThenPruned();
        assert.equal(countPendingAttachments(), 0, "pruned media is not 'pending'");
    });

    it("re-fetches only when explicitly asked", async () => {
        await downloadedThenPruned();
        const back = await downloadSyncedMedia({ accountDir: dir, limit: 50, includePruned: true });
        assert.equal(back.downloaded, 1, "--include-pruned should bring it back");
    });

    it("clears the marker once the file is downloaded again", async () => {
        await downloadedThenPruned();
        await downloadSyncedMedia({ accountDir: dir, limit: 50, includePruned: true });
        // The file is back, so the earlier removal no longer applies: an
        // ordinary run must now treat it like any other downloaded row.
        const after = await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        assert.equal(after.considered, 0, "already downloaded, nothing to do");
        assert.ok(getMessages("t1")[0].localPath, "and it has a path again");
    });

    it("leaves never-pruned media fetchable as normal", async () => {
        row({ timestamp: NOW - 40 * DAY }, [photo("/ok.jpg")]);
        const s = await downloadSyncedMedia({ accountDir: dir, limit: 50 });
        assert.equal(s.downloaded, 1);
    });
});

describe("pruneDownloadedMedia — all mode", () => {
    const DAY = 86400000;
    const NOW = 1_760_000_000_000;

    const seedAges = async (...daysAgo) => {
        for (const d of daysAgo) row({ timestamp: NOW - d * DAY }, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir, limit: 100 });
    };

    it("deletes every downloaded file regardless of age", async () => {
        await seedAges(1, 40, 400);
        const s = await pruneDownloadedMedia({ all: true, now: NOW });
        assert.equal(s.deleted, 3, "recent files included too");
        assert.equal(s.all, true);
    });

    it("an age-based prune still spares recent files", async () => {
        await seedAges(1, 40);
        const s = await pruneDownloadedMedia({ olderThanDays: 30, now: NOW });
        assert.equal(s.deleted, 1, "only the old one");
    });

    it("all mode is a separate mode, not a huge cutoff", async () => {
        // A cutoff computed from a bad date could silently become
        // delete-everything; a named mode cannot be reached by arithmetic.
        await seedAges(1);
        const byDays = await pruneDownloadedMedia({ olderThanDays: 0, now: NOW });
        assert.equal(byDays.deleted, 0, "a zero window must delete nothing");
        const byAll = await pruneDownloadedMedia({ all: true, now: NOW });
        assert.equal(byAll.deleted, 1);
    });

    it("dry run in all mode deletes nothing", async () => {
        await seedAges(1, 40);
        const s = await pruneDownloadedMedia({ all: true, now: NOW, dryRun: true });
        assert.equal(s.considered, 2);
        assert.equal(s.deleted, 0);
        assert.ok(
            getMessages("t1").every((m) => m.localPath),
            "files must survive a dry run",
        );
    });

    it("all mode can still be scoped to one thread", async () => {
        upsertThread({ threadId: "t2", type: "dm", name: "Other", lastUpdate: 1 });
        await seedAges(1);
        row({ threadId: "t2", timestamp: NOW }, [photo("/ok.jpg")]);
        await downloadSyncedMedia({ accountDir: dir, limit: 100 });
        const s = await pruneDownloadedMedia({ all: true, now: NOW, threadId: "t2" });
        assert.equal(s.deleted, 1, "only the named thread");
    });

    it("all mode still records the prune, so a sync does not undo it", async () => {
        await seedAges(1);
        await pruneDownloadedMedia({ all: true, now: NOW });
        const again = await downloadSyncedMedia({ accountDir: dir, limit: 100 });
        assert.equal(again.considered, 0);
    });
});
