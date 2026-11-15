/**
 * The secure pages' look and languages (src/core/secure-page-view.js, src/utils/page-kit.js), over real HTTP on
 * 127.0.0.1, and the QR login page sharing the same kit.
 *
 * What would turn each test red:
 * - a page, form or status, missing one language, or a text whose Vietnamese side is missing or untranslated;
 * - a page without the language switch or its script, or a script or style without this response's nonce, or a CSP
 *   that falls back to 'unsafe-inline';
 * - `?lang=vi` not opening the page in Vietnamese, or the form's answer losing it;
 * - an app's name, an account's name or a server sentence written into the page as markup;
 * - the OAuth page not saying which app, which account, and where the answer goes (host only);
 * - a failed PIN or password check with no Vietnamese sentence;
 * - the QR page and the secure pages drifting apart (their own copies of the style or the language script).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort } from "../helpers/free-port.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SecurePage } from "../../src/core/secure-page.js";
import { SECURE_TEXT, failureVi } from "../../src/core/secure-page-view.js";
import { KIT_STYLE, LANGUAGE_SCRIPT, LANG_STORAGE_KEY, bi, esc, requestedLang } from "../../src/utils/page-kit.js";
import { startQrServer } from "../../src/utils/qr-http-server.js";
import { qrPng } from "../../src/zalo/qr-image.js";

const ACCOUNT = "1000000000000000001";
const TYPED = "7391";
const HOSTILE = `</script><img src=x onerror=alert(1)> "quoted" & 'single'`;

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const spec = (over = {}) => ({
    accountId: ACCOUNT,
    action: "conv.unhide",
    target: { threadIds: ["1000000000000000002"] },
    kind: "pin",
    title: "Zalo hidden chats",
    description: "Type the PIN.",
    onSubmit: ({ pin }) => (pin === TYPED ? { status: "approved" } : { status: "retry", message: "Wrong PIN." }),
    ...over,
});

const oauthSpec = (over = {}) =>
    spec({
        action: "oauth.authorize",
        target: { clientId: "connector" },
        kind: "confirm",
        secretKind: "password",
        title: "Connect an app to this Zalo account",
        description: "An app asks to use this account.",
        formActionOrigins: ["https://app.example.com"],
        view: {
            type: "oauth",
            clientName: "Test Connector",
            clientId: "connector",
            accountName: "Shop Demo",
            accountId: ACCOUNT,
            returnHost: "app.example.com",
        },
        onSubmit: ({ secret }) =>
            secret === "right-password-not-real"
                ? { status: "approved", redirect: "https://app.example.com/cb?code=x" }
                : {
                      status: "retry",
                      message: "Wrong approver password (1 failed).",
                      failure: { secret: "password", reason: "wrong", failures: 1, retryAfterMs: 0 },
                  },
        ...over,
    });

/** Every text the page shows in English has its Vietnamese twin, and the switch and its script are there. */
function assertBilingual(html, nonce, what) {
    const en = html.match(/class="l-en"/g)?.length ?? 0;
    const vi = html.match(/class="l-vi"/g)?.length ?? 0;
    assert.ok(en > 0, `${what}: no English`);
    assert.equal(vi, en, `${what}: every English text has a Vietnamese one`);
    assert.match(html, /<button type="button" data-lang="en">English<\/button>/, what);
    assert.match(html, /<button type="button" data-lang="vi">Tiếng Việt<\/button>/, what);
    assert.ok(html.includes(`<script nonce="${nonce}">`), `${what}: the language script, by nonce`);
    assert.ok(html.includes(LANGUAGE_SCRIPT), `${what}: the shared language script`);
    assert.ok(html.includes(`<style nonce="${nonce}">${KIT_STYLE}`), `${what}: the shared style, by nonce`);
    assert.match(html, /data-title-en="[^"]+" data-title-vi="[^"]+"/, `${what}: a title in each language`);
}

const nonceOf = (res) => /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

describe("the secure pages speak English and Vietnamese, with one look", () => {
    let page;
    before(async () => {
        page = new SecurePage({ accountId: ACCOUNT });
        await page.ensureServed();
    });
    after(() => page.close());

    const post = (url, fields) =>
        fetch(url, {
            method: "POST",
            body: new URLSearchParams(fields).toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
        });

    it("the text table: the same keys in both languages, every one translated", () => {
        assert.deepEqual(Object.keys(SECURE_TEXT.vi).sort(), Object.keys(SECURE_TEXT.en).sort());
        for (const key of Object.keys(SECURE_TEXT.en)) {
            assert.ok(SECURE_TEXT.vi[key].length > 0, key);
            assert.notEqual(SECURE_TEXT.vi[key], SECURE_TEXT.en[key], `${key} is translated`);
        }
    });

    it("every form and status page carries both languages, the switch and its script, by nonce, no 'unsafe-inline'", async () => {
        const pages = [];
        const pin = await page.open(spec());
        pages.push(["pin form", await fetch(pin.url)]);
        pages.push(["pin retry", await post(pin.url, { pin: "0000", decision: "approve" })]);
        pages.push(["pin unlocked", await post(pin.url, { pin: TYPED, decision: "approve" })]);
        pages.push(["already answered", await fetch(pin.url)]);
        page.store.consume(pin.token, { accountId: ACCOUNT, action: "conv.unhide", target: spec().target });
        pages.push(["used", await fetch(pin.url)]);
        const confirm = await page.open(spec({ kind: "confirm", onSubmit: undefined }));
        pages.push(["approve form", await fetch(confirm.url)]);
        pages.push(["choose", await post(confirm.url, { decision: "maybe" })]);
        pages.push(["approved", await post(confirm.url, { decision: "approve" })]);
        const declined = await page.open(spec({ kind: "confirm", onSubmit: undefined }));
        pages.push(["declined", await post(declined.url, { decision: "decline" })]);
        const change = await page.open(spec({ kind: "pin-change", hasPin: true }));
        pages.push(["pin-change form", await fetch(change.url)]);
        const oauth = await page.open(oauthSpec());
        pages.push(["oauth form", await fetch(oauth.url)]);
        pages.push(["oauth wrong password", await post(oauth.url, { decision: "approve", secret: "nope" })]);
        const failing = await page.open(
            spec({
                onSubmit: () => {
                    throw new Error("boom");
                },
            }),
        );
        pages.push(["failed", await post(failing.url, { pin: TYPED, decision: "approve" })]);
        const expiring = await page.open(spec());
        page.store.tickets.get(expiring.token).expiresAt = Date.now() - 1;
        pages.push(["expired", await fetch(expiring.url)]);
        const base = pin.url.replace(/[^/]+$/, "");
        pages.push(["unknown", await fetch(`${base}AAAAAAAAAAAAAAAAAAAAAA`)]);
        const other = await page.open(spec({ accountId: "1000000000000000009" }));
        pages.push(["wrong account", await fetch(other.url)]);
        pages.push(["method", await fetch(pin.url, { method: "PUT" })]);
        pages.push(["nothing here", await fetch(`${page.localBaseUrl}/elsewhere`)]);

        for (const [what, res] of pages) {
            const csp = res.headers.get("content-security-policy");
            assert.doesNotMatch(csp, /unsafe-inline/, what);
            assert.match(csp, /^default-src 'none';/, what);
            const nonce = nonceOf(res);
            assert.ok(nonce, `${what}: a nonce`);
            assert.ok(csp.includes(`style-src 'nonce-${nonce}'`), `${what}: the style by the same nonce`);
            const html = await res.text();
            assertBilingual(html, nonce, what);
            assert.doesNotMatch(html, /\son[a-z]+=/i, `${what}: no inline handler`);
        }
        // Two answers, two nonces.
        const a = nonceOf(await fetch(change.url));
        const b = nonceOf(await fetch(change.url));
        assert.notEqual(a, b, "a nonce is per response");
    });

    it("the language: English by default, `?lang=vi` opens it in Vietnamese and the form's answer keeps it", async () => {
        const t = await page.open(spec());
        assert.match(await (await fetch(t.url)).text(), /<html lang="en">/);
        assert.match(await (await fetch(`${t.url}?lang=xx`)).text(), /<html lang="en">/, "an unknown language");
        const vi = await (await fetch(`${t.url}?lang=vi`)).text();
        assert.match(vi, /<html lang="vi">/);
        assert.match(vi, /<title>Nhập mã PIN trò chuyện ẩn<\/title>/);
        assert.match(vi, new RegExp(`<form method="post" action="${t.token}\\?lang=vi"`));
        const wrong = await post(`${t.url}?lang=vi`, { pin: "0000", decision: "approve" });
        assert.equal(wrong.status, 400);
        assert.match(await wrong.text(), /<html lang="vi">/);
        assert.equal(page.store.lookup(t.token).ticket.status, "pending", "the query changes nothing but the language");
        const right = await post(`${t.url}?lang=vi`, { pin: TYPED, decision: "approve" });
        assert.equal(right.status, 200);
        assert.equal(page.store.lookup(t.token).ticket.status, "approved");
        assert.match(await right.text(), /<html lang="vi">/);
        // The script, for a link that names none: the query, then the saved choice, then the browser's language.
        assert.ok(LANGUAGE_SCRIPT.includes(`const KEY=${JSON.stringify(LANG_STORAGE_KEY)}`));
        assert.equal(LANG_STORAGE_KEY, "zalo-agent-lang");
        assert.match(LANGUAGE_SCRIPT, /apply\(\[asked,saved\(\),browser\]\.find\(ok\)\)/);
        assert.match(LANGUAGE_SCRIPT, /new URLSearchParams\(location\.search\)\.get\('lang'\)/);
        assert.match(LANGUAGE_SCRIPT, /navigator\.language/);
        assert.match(LANGUAGE_SCRIPT, /startsWith\('vi'\)\?'vi':'en'/);
        assert.equal(requestedLang("/zalo/secure/x?lang=vi"), "vi");
        assert.equal(requestedLang("/zalo/secure/x?a=1&lang=en"), "en");
        assert.equal(requestedLang("/zalo/secure/x?lang=fr"), null);
        assert.equal(requestedLang("/zalo/secure/x"), null);
    });

    it("the OAuth page: which app, which account, where it returns (host only), what it can do", async () => {
        const t = await page.open(oauthSpec());
        const res = await fetch(t.url);
        const html = await res.text();
        assert.match(res.headers.get("content-security-policy"), /form-action 'self' https:\/\/app\.example\.com;/);
        assert.match(html, /Allow access to your Zalo account\?/);
        assert.match(html, /Cho phép truy cập tài khoản Zalo\?/);
        assert.match(html, /Test Connector<small>connector<\/small>/);
        assert.match(html, new RegExp(`Shop Demo<small>${ACCOUNT}</small>`));
        assert.match(html, /<span class="host">app\.example\.com<\/span>/);
        assert.match(html, /MCP tools/);
        assert.match(html, /công cụ MCP/);
        assert.match(html, /name="secret" type="password"/);
        assert.match(html, />Approve</);
        assert.match(html, />Đồng ý</);
        assert.match(html, />Decline</);
        assert.match(html, />Từ chối</);
        assert.match(html, /This link works once and expires at \d\d:\d\d UTC/);
        assert.match(html, /chỉ dùng được một lần/);
        const wrong = await post(t.url, { decision: "approve", secret: "nope" });
        const wrongHtml = await wrong.text();
        assert.match(wrongHtml, /Wrong approver password \(1 failed\)\./);
        assert.match(wrongHtml, /Sai mật khẩu người duyệt \(sai 1 lần\)\./);
        assert.doesNotMatch(wrongHtml, /nope/, "the typed secret is never written back");
        const right = await post(t.url, { decision: "approve", secret: "right-password-not-real" });
        assert.equal(right.status, 303, "approving still redirects to the app");
        assert.equal(right.headers.get("location"), "https://app.example.com/cb?code=x");
    });

    it("dynamic text stays text: an app's name, an account's name and the server's sentence are escaped", async () => {
        const o = await page.open(
            oauthSpec({
                view: {
                    type: "oauth",
                    clientName: HOSTILE,
                    clientId: "connector",
                    accountName: HOSTILE,
                    accountId: ACCOUNT,
                    returnHost: "app.example.com",
                },
            }),
        );
        const c = await page.open(spec({ kind: "confirm", onSubmit: undefined, description: HOSTILE }));
        const p = await page.open(spec({ description: HOSTILE }));
        for (const t of [o, c, p]) {
            const html = await (await fetch(t.url)).text();
            assert.ok(!html.includes("<img src=x"), "no element from a name");
            assert.equal(html.split("</script>").length - 1, 1, "no script closed early");
            assert.ok(html.includes(esc(HOSTILE)), "shown, escaped");
        }
        assert.equal(
            bi("<b>", "<i>"),
            '<span class="l-en" lang="en">&lt;b&gt;</span><span class="l-vi" lang="vi">&lt;i&gt;</span>',
        );
    });

    it("the approve page labels the server's English sentence and names the account", async () => {
        const t = await page.open(
            spec({
                kind: "confirm",
                onSubmit: undefined,
                description: "Sending would send one message.",
                view: { accountName: "Shop Demo", accountId: ACCOUNT },
            }),
        );
        const html = await (await fetch(t.url)).text();
        assert.match(html, /Approve this action\?/);
        assert.match(html, /Duyệt thao tác này\?/);
        assert.match(html, /<span class="quote" lang="en">Sending would send one message\.<\/span>/);
        assert.match(html, /Described by the server\./);
        assert.match(html, /Mô tả do máy chủ tạo, bằng tiếng Anh\./);
        assert.match(html, new RegExp(`Shop Demo<small>${ACCOUNT}</small>`));
    });

    it("a view's own heading, lead and success text replace the defaults", async () => {
        const t = await page.open(
            spec({
                view: {
                    heading: { en: "Heading EN", vi: "Tiêu đề VI" },
                    lead: { en: "Lead EN", vi: "Dẫn VI" },
                    done: { en: "Done EN", vi: "Xong VI" },
                },
            }),
        );
        const html = await (await fetch(t.url)).text();
        assert.match(html, /Heading EN/);
        assert.match(html, /Tiêu đề VI/);
        assert.match(html, /Lead EN/);
        assert.match(html, /Dẫn VI/);
        const ok = await (await post(t.url, { pin: TYPED, decision: "approve" })).text();
        assert.match(ok, /Done EN/);
        assert.match(ok, /Xong VI/);
    });
});

describe("failed checks in Vietnamese", () => {
    it("PIN, approver password, the current and the new PIN", () => {
        assert.equal(
            failureVi({ secret: "pin", reason: "wrong", failures: 1, retryAfterMs: 0 }),
            "Sai mã PIN (sai 1 lần).",
        );
        assert.equal(
            failureVi({ secret: "pin", reason: "wrong", failures: 7, retryAfterMs: 30_000 }),
            "Sai mã PIN (sai 7 lần liên tiếp). Hãy đợi 30 giây trước khi thử lại.",
        );
        assert.equal(
            failureVi({ secret: "pin", reason: "locked", retryAfterMs: 59_001 }),
            "Nhập sai mã PIN quá nhiều lần: hãy thử lại sau 60 giây.",
        );
        assert.equal(
            failureVi({ secret: "password", reason: "locked", retryAfterMs: 5000 }),
            "Nhập sai mật khẩu quá nhiều lần: hãy thử lại sau 5 giây.",
        );
        assert.match(
            failureVi({ secret: "current-pin", reason: "wrong", failures: 2 }),
            /^Mã PIN hiện tại: Sai mã PIN/,
        );
        assert.equal(failureVi({ secret: "new-pin", reason: "differ" }), "Hai mã PIN mới không khớp nhau.");
        assert.equal(failureVi({ secret: "new-pin", reason: "shape" }), "Mã PIN mới gồm 4 chữ số.");
        assert.equal(failureVi(null), null);
        assert.equal(failureVi({ secret: "other" }), null);
    });
});

describe("the QR login page shares the kit", () => {
    let dir;
    let server;
    let base;
    before(async () => {
        process.env.ZALO_JSON_MODE = "1";
        dir = mkdtempSync(join(tmpdir(), "page-kit-"));
        const file = join(dir, "qr.png");
        writeFileSync(file, qrPng("a-sample-text-for-the-kit"));
        const port = await freePort();
        const original = console.log;
        console.log = () => {};
        try {
            server = startQrServer(file, port, [port]);
            await new Promise((r) => setTimeout(r, 100));
        } finally {
            console.log = original;
        }
        base = `http://127.0.0.1:${port}`;
    });
    after(() => {
        server?.close();
        delete process.env.ZALO_JSON_MODE;
        rmSync(dir, { recursive: true, force: true });
    });

    it("the same style, header, switch and language script, by the response's nonce", async () => {
        const res = await fetch(`${base}/qr`);
        const nonce = nonceOf(res);
        const html = await res.text();
        assert.doesNotMatch(res.headers.get("content-security-policy"), /unsafe-inline/);
        assert.ok(html.includes(`<style nonce="${nonce}">${KIT_STYLE}`), "the shared style");
        assert.ok(html.includes(LANGUAGE_SCRIPT), "the shared language script");
        assert.equal(html.split("</script>").length - 1, 1, "one script element");
        assert.match(html, /<div class="brand"><svg/);
        assert.match(html, /data-lang="vi">Tiếng Việt</);
        // The page's own script hears the switch instead of keeping a language of its own.
        assert.match(html, /document\.addEventListener\('zalo-lang'/);
        assert.equal(html.split("localStorage.setItem").length - 1, 1, "one place saves the choice");
    });
});
