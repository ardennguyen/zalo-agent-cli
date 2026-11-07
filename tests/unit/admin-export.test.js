/**
 * "Export my data" through the admin API (src/core/data-export.js, src/core/admin-api.js) on a real MCP HTTP server
 * (port 0) with the real secure page and media links:
 * - the admin credential starts a job; the agent's bearer token never does;
 * - encryption is chosen per export: `plaintext` needs `confirm: true`; `password` opens only with that password;
 * - hidden chats are absent without a grant or the PIN, present and marked (`export_hidden_threads`) with one; the PIN
 *   hash never reaches the file;
 * - a grant comes from the secure page (purpose hidden-export), is single-use, bound to the export and expires two
 *   minutes after the PIN was entered;
 * - a PIN or password in the URL, or over plain http off this machine, is refused; the lockout is the one the hidden
 *   chats share (and it is on disk);
 * - the download link follows the media link rules (bearer or capability, ranges, no-store, attachment), and the file
 *   is deleted after a whole download, on expiry, on DELETE and on revocation.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, initDb, insertMessage } from "../../src/core/db.js";
import { Database } from "../../src/core/sqlite.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { createAdminApi, resolveAdminCredentials } from "../../src/core/admin-api.js";
import { GRANT_TTL_MS, createExportApi, exportDir, secureTransport } from "../../src/core/data-export.js";
import { decryptExportFile } from "../../src/core/export-crypt.js";
import { MediaLinks } from "../../src/core/media-deliver.js";
import { SecurePage, TicketStore } from "../../src/core/secure-page.js";

const OWN = "1000000000000000811";
const HIDDEN = "1000000000000000812";
const VISIBLE = "1000000000000000813";
const PIN = "5173";
const PASSWORD = "a long export password";
const SECRET = "words-only-in-the-hidden-chat";
const AGENT_TOKEN = "agent-token-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-fedcba9876543210";
const md5 = (s) => createHash("md5").update(s).digest("hex");
const KDF = { N: 1024, r: 8, p: 1 };
const work = join(SANDBOX_HOME, "admin-export");
const servers = [];
const clock = { offset: 0 };
const now = () => Date.now() + clock.offset;
let n = 0;

/** A real server for OWN: admin API with the export routes, the secure page, media links. */
async function start({ linkAuth = "capability", ttlMs = 60_000 } = {}) {
    const hidden = new HiddenChats({ accountId: OWN, stateDir: getAccountDir(OWN) });
    hidden.setFromServer({ pin: md5(PIN), threads: [{ thread_id: HIDDEN, is_group: 0 }] });
    const links = new MediaLinks().configure({ linkAuth, ttlMs, log: () => {} });
    const page = new SecurePage({ store: new TicketStore({ now }), accountId: OWN });
    const exportApi = createExportApi({
        ownId: OWN,
        accountDir: getAccountDir(OWN),
        dbFile: getAccountDbPath(OWN),
        hidden,
        securePage: page,
        links,
        kdf: KDF,
        now,
        log: () => {},
    });
    const admin = createAdminApi({
        ownId: OWN,
        hashes: resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: ADMIN_TOKEN } }).hashes,
        exportApi,
        log: () => {},
    });
    const deps = { admin, securePage: page, mediaLinks: links, buffer: { getStats: () => [] } };
    const server = createHTTPServer(() => {}, deps, 0, AGENT_TOKEN, "127.0.0.1");
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    page.configure({ localBaseUrl: base });
    links.configure({ localBaseUrl: base, bearerAvailable: true });
    return { base, exportApi, links, hidden, page };
}

async function call(base, path, { method = "GET", token = ADMIN_TOKEN, body, headers = {} } = {}) {
    const res = await fetch(`${base}/zalo/admin${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Start an export and wait for it; returns the job as GET shows it. */
async function exportNow(srv, body) {
    const r = await call(srv.base, `/export/${OWN}`, { method: "POST", body });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await srv.exportApi.idle();
    return (await call(srv.base, `/export/${OWN}/${r.body.jobId}`)).body;
}

/** Download a ready job's link to a file. */
async function download(job, headers = {}) {
    const res = await fetch(job.download.url, { headers });
    const file = join(work, `${n++}-download`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (res.status === 200 || res.status === 206) writeFileSync(file, bytes);
    return { res, file, bytes };
}

/** What a plain SQLite export holds of the two threads. */
function contents(file) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return {
            hidden: db.prepare("SELECT count(*) AS n FROM messages WHERE threadId = ?").get(HIDDEN).n,
            visible: db.prepare("SELECT count(*) AS n FROM messages WHERE threadId = ?").get(VISIBLE).n,
            marked: db
                .prepare("SELECT threadId, hidden FROM export_hidden_threads")
                .all()
                .map((r) => ({ ...r })),
            hiddenChats: db.prepare("SELECT value FROM export_info WHERE key = 'hiddenChats'").get().value,
        };
    } finally {
        db.close();
    }
}

const files = () => {
    try {
        return readdirSync(exportDir(getAccountDir(OWN)));
    } catch {
        return [];
    }
};

before(() => {
    assertSandboxed(CONFIG_DIR);
    mkdirSync(work, { recursive: true });
    initDb(getAccountDbPath(OWN));
    for (const [threadId, text] of [
        [HIDDEN, SECRET],
        [VISIBLE, "an ordinary message"],
    ]) {
        for (let i = 0; i < 3; i++) {
            insertMessage({ msgId: `${threadId}-${i}`, threadId, senderId: "1", text, timestamp: i, type: "text" });
        }
    }
    closeDb();
});
beforeEach(() => {
    clock.offset = 0;
    rmSync(join(getAccountDir(OWN), "hidden-pin-lockout.json"), { force: true });
});
after(() => servers.forEach((s) => s.close()));

describe("admin export: credential and what the request must say", () => {
    it("the agent's bearer token and no token are refused; another account is not this server's", async () => {
        const srv = await start();
        const body = { encryption: "password", password: PASSWORD };
        assert.equal((await call(srv.base, `/export/${OWN}`, { method: "POST", body, token: null })).status, 401);
        const agent = await call(srv.base, `/export/${OWN}`, { method: "POST", body, token: AGENT_TOKEN });
        assert.equal(agent.status, 401);
        assert.match(agent.body.error, /agent credential/);
        assert.equal((await call(srv.base, `/export/1000000000000000899`, { method: "POST", body })).status, 404);
        assert.equal(srv.exportApi.jobs.size, 0, "no job was started");
    });

    it("needs an encryption choice; plaintext needs confirm: true, the CLI's --yes", async () => {
        const srv = await start();
        const none = await call(srv.base, `/export/${OWN}`, { method: "POST", body: {} });
        assert.equal(none.status, 400);
        assert.equal(none.body.code, "ENCRYPTION_REQUIRED");
        const unconfirmed = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "plaintext" },
        });
        assert.equal(unconfirmed.status, 409);
        assert.equal(unconfirmed.body.confirmationRequired, true);
        assert.match(unconfirmed.body.wouldDo, /decrypted/);
        const short = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: "short" },
        });
        assert.equal(short.status, 400);
        assert.equal(srv.exportApi.jobs.size, 0);
    });

    it("a PIN, password or grant in the URL is refused, and nothing starts", async () => {
        const srv = await start();
        for (const q of [`?pin=${PIN}`, `?password=x`, `?grant=y`]) {
            const r = await call(srv.base, `/export/${OWN}${q}`, {
                method: "POST",
                body: { encryption: "password", password: PASSWORD },
            });
            assert.equal(r.status, 400, q);
            assert.equal(r.body.code, "SECRET_IN_URL");
        }
        assert.equal(srv.exportApi.jobs.size, 0);
    });

    it("a PIN or password over plain http off this machine is refused (a proxy saying http, a remote peer)", async () => {
        const srv = await start();
        const r = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, pin: PIN },
            headers: { "X-Forwarded-Proto": "http" },
        });
        assert.equal(r.status, 403);
        assert.equal(r.body.code, "INSECURE_TRANSPORT");
        assert.equal(srv.hidden.lockoutStatus().failures, 0, "the PIN was not even checked");
        const req = (remoteAddress, headers = {}, encrypted = false) => ({
            socket: { remoteAddress, encrypted },
            headers,
        });
        assert.equal(secureTransport(req("203.0.113.9")), false);
        assert.equal(secureTransport(req("203.0.113.9", {}, true)), true);
        assert.equal(secureTransport(req("127.0.0.1")), true);
        assert.equal(secureTransport(req("127.0.0.1", { "x-forwarded-proto": "https" })), true);
        assert.equal(secureTransport(req("203.0.113.9", { "x-forwarded-proto": "https" })), false, "not a proxy");
        assert.equal(secureTransport(req("10.0.0.2", { "x-forwarded-proto": "https" }), ["10.0.0.2"]), true);
    });
});

describe("admin export: the file", () => {
    it("plaintext with confirm: hidden chats absent, nothing marked; downloaded once, then the file is gone", async () => {
        const srv = await start();
        const job = await exportNow(srv, { encryption: "plaintext", confirm: true });
        assert.equal(job.state, "ready");
        assert.equal(job.hiddenChats, "excluded");
        const { res, file, bytes } = await download(job);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
        assert.match(res.headers.get("content-disposition"), /^attachment; filename="zalo-export-.*\.db"/);
        assert.equal(bytes.includes(Buffer.from(SECRET)), false, "no byte of the hidden chat");
        assert.deepEqual(contents(file), { hidden: 0, visible: 3, marked: [], hiddenChats: "excluded" });
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(files(), [], "deleted after the whole file was served");
        assert.equal((await fetch(job.download.url)).status, 410);
        assert.equal((await call(srv.base, `/export/${OWN}/${job.jobId}`)).body.state, "downloaded");
    });

    it("password: opens only with that password; with the PIN in the body the hidden chat is in it, marked", async () => {
        const srv = await start();
        const job = await exportNow(srv, { encryption: "password", password: PASSWORD, includeHidden: true, pin: PIN });
        assert.equal(job.hiddenChats, "included");
        assert.equal(job.hiddenThreads, 1);
        const { file, bytes } = await download(job);
        assert.equal(bytes.includes(Buffer.from(SECRET)), false, "encrypted");
        await assert.rejects(decryptExportFile(file, join(work, `${n++}-wrong.db`), "another password!"));
        const plain = join(work, `${n++}-plain.db`);
        await decryptExportFile(file, plain, PASSWORD);
        assert.deepEqual(contents(plain), {
            hidden: 3,
            visible: 3,
            marked: [{ threadId: HIDDEN, hidden: 1 }],
            hiddenChats: "included",
        });
        const text = readFileSync(plain);
        assert.equal(text.includes(Buffer.from(md5(PIN))), false, "never the PIN hash");
        assert.equal(text.includes(Buffer.from(PIN)), false, "never the PIN");
    });

    it("a wrong PIN starts nothing and counts toward the lockout the hidden chats share, kept on disk", async () => {
        const srv = await start();
        for (let i = 0; i < 6; i++) {
            const r = await call(srv.base, `/export/${OWN}`, {
                method: "POST",
                body: { encryption: "password", password: PASSWORD, includeHidden: true, pin: "0000" },
            });
            assert.equal(r.status, 403, `try ${i + 1}`);
        }
        const locked = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, pin: PIN },
        });
        assert.equal(locked.status, 429, "even the right PIN waits");
        assert.ok(Number(locked.headers.get("retry-after")) > 0);
        assert.equal(srv.exportApi.jobs.size, 0);
        // The same lockout, from the file: another reader of the account (the secure page, `conv hidden`) sees it.
        const other = new HiddenChats({ accountId: OWN, stateDir: getAccountDir(OWN) });
        assert.equal(other.lockoutStatus().failures, 6);
        assert.ok(other.lockoutStatus().retryAfterMs > 0);
    });
});

describe("admin export: the hidden-access grant from the secure page", () => {
    /** Ask for a grant and have the owner type `pin` on the page. */
    async function grantFor(srv, pin = PIN) {
        const g = await call(srv.base, `/export/${OWN}/hidden-access`, { method: "POST" });
        assert.equal(g.status, 201);
        assert.notEqual(g.body.grant, new URL(g.body.secureUrl).pathname.split("/").pop(), "a separate claim");
        const form = await fetch(g.body.secureUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ pin, decision: "approve" }),
        });
        return { ...g.body, pageStatus: form.status };
    }

    it("pending is refused; after the PIN on the page it works once, for this export only", async () => {
        const srv = await start();
        const g = await call(srv.base, `/export/${OWN}/hidden-access`, { method: "POST" });
        const early = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, grant: g.body.grant },
        });
        assert.equal(early.status, 403);
        assert.equal(early.body.reason, "pending");

        const granted = await grantFor(srv);
        assert.equal(granted.pageStatus, 200);
        const job = await exportNow(srv, {
            encryption: "password",
            password: PASSWORD,
            includeHidden: true,
            grant: granted.grant,
        });
        assert.equal(job.hiddenChats, "included");
        const again = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, grant: granted.grant },
        });
        assert.equal(again.status, 403, "single use");
        assert.equal(again.body.reason, "used");
    });

    it("expires two minutes after the PIN; a ticket for another action is no grant", async () => {
        const srv = await start();
        const granted = await grantFor(srv);
        clock.offset = GRANT_TTL_MS + 1000;
        const late = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, grant: granted.grant },
        });
        assert.equal(late.status, 403);
        assert.match(late.body.error, /expired/);
        clock.offset = 0;
        const other = srv.page.store.issue({
            accountId: OWN,
            action: "conv.unhide",
            target: { ownId: OWN, action: "export", includeHidden: true },
            kind: "pin",
            title: "t",
            description: "d",
        });
        srv.page.store.settle(srv.page.store.lookup(other.token).ticket, "approved", {
            outcome: { grantExpiresAt: now() + 60_000 },
        });
        const wrong = await call(srv.base, `/export/${OWN}`, {
            method: "POST",
            body: { encryption: "password", password: PASSWORD, includeHidden: true, grant: other.claim },
        });
        assert.equal(wrong.status, 403);
        assert.equal(wrong.body.reason, "action");
    });

    it("a wrong PIN on the page asks again and counts toward the same lockout", async () => {
        const srv = await start();
        const r = await grantFor(srv, "0000");
        assert.equal(r.pageStatus, 400);
        assert.equal(srv.hidden.lockoutStatus().failures, 1);
    });
});

describe("admin export: the download link", () => {
    it("bearer links need the server's bearer; ranges are served; the file goes once every byte was", async () => {
        const srv = await start({ linkAuth: "bearer" });
        const job = await exportNow(srv, { encryption: "password", password: PASSWORD });
        assert.equal(job.download.auth, "bearer");
        assert.equal((await download(job)).res.status, 401);
        const auth = { Authorization: `Bearer ${AGENT_TOKEN}` };
        const first = await download(job, { ...auth, Range: "bytes=0-99" });
        assert.equal(first.res.status, 206);
        assert.equal(first.bytes.length, 100);
        assert.equal(files().length, 1, "half a file is not a download");
        const rest = await download(job, { ...auth, Range: "bytes=100-" });
        assert.equal(rest.res.status, 206);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(files(), []);
    });

    it("expiry deletes the file and ends the link", async () => {
        const srv = await start({ ttlMs: 300 });
        const job = await exportNow(srv, { encryption: "password", password: PASSWORD });
        assert.equal(files().length, 1);
        await new Promise((r) => setTimeout(r, 600));
        assert.deepEqual(files(), []);
        assert.equal((await fetch(job.download.url)).status, 410);
        assert.equal((await call(srv.base, `/export/${OWN}/${job.jobId}`)).body.state, "expired");
    });

    it("DELETE and a revocation (logout, rekey, a link-policy change) delete the file", async () => {
        const srv = await start();
        const a = await exportNow(srv, { encryption: "password", password: PASSWORD });
        const del = await call(srv.base, `/export/${OWN}/${a.jobId}`, { method: "DELETE" });
        assert.equal(del.body.state, "revoked");
        assert.equal(existsSync(join(exportDir(getAccountDir(OWN)), `${a.jobId}.zaexport`)), false);
        const b = await exportNow(srv, { encryption: "password", password: PASSWORD });
        assert.equal(files().length, 1);
        srv.links.revokeAll("the session ended");
        assert.deepEqual(files(), []);
        assert.equal((await fetch(b.download.url)).status, 410);
        assert.equal((await call(srv.base, `/export/${OWN}/${b.jobId}`)).body.endedBecause, "the session ended");
    });
});
