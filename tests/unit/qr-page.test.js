/**
 * The page the QR is shown on (src/utils/qr-http-server.js): what it serves, what its status says about the login,
 * and that a name the phone scanned as can never become markup.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { PAGE_TEXT, noteQrLayer, noteQrScanned, startQrServer } from "../../src/utils/qr-http-server.js";
import { qrPng } from "../../src/zalo/qr-image.js";

const freePort = () =>
    new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });

describe("the QR page", () => {
    let dir;
    let file;
    let server;
    let base;
    let realFetch;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        dir = mkdtempSync(join(CONFIG_DIR, "qrpage-"));
        file = join(dir, "qr.png");
        // the server looks up its public IP on start: not in an offline test
        realFetch = globalThis.fetch;
        globalThis.fetch = (url, ...rest) =>
            String(url).includes("ipify") ? Promise.reject(new Error("offline")) : realFetch(url, ...rest);
        process.env.ZALO_JSON_MODE = "1";
        const log = console.log;
        console.log = () => {};
        const port = await freePort();
        server = startQrServer(file, port, [port], false);
        await new Promise((r) => setTimeout(r, 100));
        console.log = log;
        base = `http://127.0.0.1:${port}`;
    });

    after(() => {
        server.close();
        globalThis.fetch = realFetch;
        delete process.env.ZALO_JSON_MODE;
        rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => noteQrLayer(1));

    it("asks the browser to look again until there is a QR, and says so plainly", async () => {
        const html = await (await fetch(`${base}/qr`)).text();
        assert.match(html, /http-equiv="refresh"/);
        assert.match(html, /Preparing the code/);
    });

    it("shows the QR it is given, from the same URL the page later swaps new ones in from", async () => {
        writeFileSync(file, qrPng("a-sample-text-for-the-page"));
        const html = await (await fetch(`${base}/qr`)).text();
        const src = /<img id="qr" src="([^"]+)"/.exec(html)?.[1];
        assert.match(src, /^\/qr\.png\?v=\d+/);
        const image = await fetch(`${base}${src}`);
        assert.equal(image.headers.get("content-type"), "image/png");
        assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);
    });

    it("is a plain page: no mascot, no external script, style or font, and no way to put markup in it", async () => {
        const html = await (await fetch(`${base}/qr`)).text();
        assert.ok(!/mascot/i.test(html));
        assert.ok(
            !/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i.test(html),
            "nothing is fetched from elsewhere",
        );
        assert.ok(!html.includes("innerHTML"), "text from the phone is set as text");
        assert.match(html, /<html lang="en">/);
        assert.match(html, /name="viewport"/);
    });

    it("says which QR is shown and who scanned it, through /status", async () => {
        const status = async () => (await fetch(`${base}/status`)).json();
        assert.deepEqual(
            { layer: (await status()).layer, scanned: (await status()).scanned },
            { layer: 1, scanned: null },
        );
        noteQrLayer(2);
        assert.equal((await status()).layer, 2);
        noteQrScanned("Fake Person");
        assert.equal((await status()).scanned, "Fake Person");
        noteQrScanned("");
        assert.equal((await status()).scanned, "", "scanned, name not given");
        noteQrLayer(1);
        assert.equal((await status()).scanned, null, "a new first QR starts over");
        assert.equal((await status()).loggedIn, false);
    });

    it("passes a hostile name through /status as data only", async () => {
        noteQrScanned("<img src=x onerror=alert(1)>");
        const body = await (await fetch(`${base}/status`)).text();
        assert.equal(JSON.parse(body).scanned, "<img src=x onerror=alert(1)>");
        assert.equal((await fetch(`${base}/status`)).headers.get("content-type"), "application/json");
    });

    it("speaks English and Vietnamese: the same sentences in both, both sent, and a way to switch", async () => {
        assert.deepEqual(
            Object.keys(PAGE_TEXT.vi).sort(),
            Object.keys(PAGE_TEXT.en).sort(),
            "nothing left untranslated",
        );
        for (const key of Object.keys(PAGE_TEXT.en)) {
            assert.ok(PAGE_TEXT.vi[key].length > 0, key);
            assert.notEqual(PAGE_TEXT.vi[key], PAGE_TEXT.en[key], `${key} is translated`);
        }
        const html = await (await fetch(`${base}/qr`)).text();
        // the table is embedded as JSON, so Vietnamese sits in the page as escapes or as text: both must decode alike
        const line = html.split("\n").find((l) => l.startsWith("const TEXT="));
        const embedded = JSON.parse(line.slice("const TEXT=".length, -1));
        assert.deepEqual(embedded, PAGE_TEXT);
        assert.match(html, /data-lang="en"/);
        assert.match(html, /data-lang="vi"/);
        assert.match(html, /<html lang="en">/, "English until the browser or the visitor says otherwise");
        assert.match(html, /navigator\.language/, "the browser's language decides first");
    });

    it("serves the page at /qr with or without a query, which is how the language is asked for", async () => {
        for (const path of ["/", "/qr", "/qr?lang=vi", "/?lang=en"]) {
            const res = await fetch(`${base}${path}`);
            assert.equal(res.status, 200, path);
            assert.match(await res.text(), /<html lang="en">/, path);
        }
        assert.equal((await fetch(`${base}/status?x=1`)).status, 200);
    });

    it("answers 404 for anything else", async () => {
        assert.equal((await fetch(`${base}/etc/passwd`)).status, 404);
    });
});
