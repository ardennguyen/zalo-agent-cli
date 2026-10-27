/**
 * The official QR login (src/zalo/qr-login.js, plan item L15) against the offline fake id.zalo.me.
 *
 * Asserted on the wire: the calls and their forms in the verified order (the one known difference, the
 * trusted-device `bundle` this client cannot produce, is pinned), the headers of a page load versus a script
 * call, the events zca-js-shaped consumers rely on, decline, retry, expiry and abort, the session the redirect
 * chain ends in, and the switch that selects it (`ZALO_QR_FLOW`).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LoginQRCallbackEventType, ZaloApiLoginQRAborted, ZaloApiLoginQRDeclined } from "zca-js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { clearSession, loginWithQR } from "../../src/core/zalo-client.js";
import { QR_FLOW_INVALID, resolveQrFlow } from "../../src/zalo/profile.js";
import { buildOf, qrLogin } from "../../src/zalo/qr-login.js";
import { diffSequence } from "../helpers/replay/replay.js";
import { WEB_QR_LOGIN, WEB_QR_LOGIN_FORBIDDEN } from "../helpers/replay/shapes.js";
import { FAKE, installFakeZalo, serveQrLogin } from "./fake-zalo-session.js";

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const BASE = { userAgent: CHROME_UA, apiType: 30, apiVersion: 694 };

describe("the QR login", () => {
    let fake;
    let qr;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
    });

    beforeEach(() => {
        fake = installFakeZalo();
    });

    afterEach(() => {
        clearSession();
        fake.uninstall();
        delete process.env.ZALO_QR_FLOW;
    });

    const events = () => {
        const seen = [];
        return { seen, onEvent: (e) => seen.push(e) };
    };

    it("makes the verified calls in order, and differs from the official shape only by the bundle", async () => {
        qr = serveQrLogin(fake);
        await qrLogin({ ...BASE });
        assert.deepEqual(diffSequence(fake.requests, WEB_QR_LOGIN, { forbidden: WEB_QR_LOGIN_FORBIDDEN }), [
            'waiting-confirm: form key "bundle" is missing',
        ]);
        assert.equal(qr.generated, 1);
    });

    it("never calls verify-client, and keeps continue on chat.zalo.me throughout", async () => {
        serveQrLogin(fake);
        await qrLogin({ ...BASE });
        assert.ok(!fake.requests.some((r) => r.path.endsWith("/verify-client")));
        for (const r of fake.requests.filter((q) => q.method === "POST")) {
            assert.equal(r.form.continue, "https://chat.zalo.me/", r.path);
            assert.equal(r.form.v, "2606161423", `${r.path} carries the page's build number`);
        }
    });

    it("asks for a QR the way a page without its key helper does: cliGenQR 0, and the code on both long polls", async () => {
        serveQrLogin(fake);
        await qrLogin({ ...BASE });
        const form = (suffix) => fake.requests.find((r) => r.path.endsWith(suffix)).form;
        // 1 means "the client draws the QR itself": a server-made image is then not valid for the phone (seen live)
        assert.equal(form("/qr/generate").cliGenQR, "0");
        assert.equal(form("/qr/waiting-scan").code, "qr-code-1");
        assert.equal(form("/qr/waiting-confirm").code, "qr-code-1");
        assert.equal(form("/qr/waiting-confirm").bundle, undefined, "the trusted-device bundle is not produced");
    });

    it("asks a long poll again while the answer is 'not yet'", async () => {
        serveQrLogin(fake, { scan: [8, 8, 8, 0] });
        await qrLogin({ ...BASE });
        assert.equal(fake.requests.filter((r) => r.path.endsWith("/waiting-scan")).length, 4);
    });

    it("sends script calls as a script of the id page and page loads as a browser navigating", async () => {
        serveQrLogin(fake);
        await qrLogin({ ...BASE });
        const by = (method, path) => fake.requests.find((r) => r.method === method && r.path === path);
        const post = by("POST", "/account/authen/qr/generate").headers;
        assert.equal(post.origin, "https://id.zalo.me", "one Origin, not zca-js's default joined to ours");
        assert.equal(post.accept, "application/json, text/plain, */*");
        assert.equal(post.referer, "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F");
        assert.equal(post["sec-fetch-site"], "same-origin");
        assert.equal(post["sec-fetch-mode"], "cors");
        assert.equal(post["content-type"], "application/x-www-form-urlencoded");
        const page = by("GET", "/account").headers;
        assert.equal(page["sec-fetch-mode"], "navigate");
        assert.equal(page["sec-fetch-dest"], "document");
        assert.equal(page["upgrade-insecure-requests"], "1");
        assert.equal(page.referer, "https://chat.zalo.me/");
        assert.ok(page.accept.startsWith("text/html,application/xhtml+xml"), "a page load asks for a page, once");
        assert.ok(!page.accept.includes("application/json"));
        assert.equal(page["user-agent"], CHROME_UA);
        assert.match(page["sec-ch-ua"], /"Google Chrome";v="155"/);
    });

    it("follows the session through checksession, syncsession and pushsession, and keeps the cookie it sets", async () => {
        serveQrLogin(fake);
        const result = await qrLogin({ ...BASE });
        const chain = fake.requests.filter((r) =>
            ["/account/checksession", "/jr/syncsession", "/jr/pushsession"].includes(r.path),
        );
        assert.deepEqual(
            chain.map((r) => r.path),
            ["/account/checksession", "/jr/syncsession", "/jr/pushsession"],
        );
        assert.equal(chain[1].query.token, "fake-t1");
        assert.equal(chain[2].query.token, "fake-t2");
        assert.ok(
            result.cookies.some((c) => (c.key ?? c.name) === "zpw_sek" && c.value === "fake-sek-from-pushsession"),
            "the session cookie of the last hop is in the jar",
        );
        assert.equal(result.userAgent, CHROME_UA);
        assert.match(result.imei, /^[0-9a-f-]{36}-[0-9a-f]{32}$/);
        assert.equal(result.language, "vi");
    });

    it("emits the events zca-js-shaped consumers use, with the image without its data-URL prefix", async () => {
        serveQrLogin(fake);
        const { seen, onEvent } = events();
        await qrLogin({ ...BASE, onEvent });
        assert.deepEqual(
            seen.map((e) => e.type),
            [
                LoginQRCallbackEventType.QRCodeGenerated,
                LoginQRCallbackEventType.QRCodeScanned,
                LoginQRCallbackEventType.GotLoginInfo,
            ],
        );
        assert.equal(seen[0].data.image, "iVBORw0KGgo=");
        assert.equal(seen[0].data.code, "qr-code-1");
        assert.equal(typeof seen[0].actions.saveToFile, "function");
        assert.equal(typeof seen[0].actions.retry, "function");
        assert.equal(typeof seen[0].actions.abort, "function");
        assert.equal(seen[1].data.display_name, "Fake Person");
        assert.equal(seen[2].data.userAgent, CHROME_UA);
    });

    it("a decline is announced and then rejects the login", async () => {
        serveQrLogin(fake, { confirm: [-13] });
        const { seen, onEvent } = events();
        await assert.rejects(qrLogin({ ...BASE, onEvent }), (e) => e instanceof ZaloApiLoginQRDeclined);
        assert.ok(seen.some((e) => e.type === LoginQRCallbackEventType.QRCodeDeclined));
        assert.ok(
            !fake.requests.some((r) => r.path === "/account/checksession"),
            "no session is fetched after a decline",
        );
    });

    it("any other confirm error is an error, not a session", async () => {
        serveQrLogin(fake, { confirm: [-99] });
        await assert.rejects(qrLogin({ ...BASE }), /An error has occurred/);
        assert.ok(!fake.requests.some((r) => r.path === "/account/checksession"));
    });

    it("a missing build number is reported before any QR is asked for", async () => {
        fake.rawRoute(
            (r) => r.host === "id.zalo.me" && r.path === "/account",
            () => new Response("<html>no script</html>", { status: 200 }),
        );
        await assert.rejects(qrLogin({ ...BASE }), /Cannot get API login version/);
        assert.ok(!fake.requests.some((r) => r.path.endsWith("/generate")));
    });

    it("retry() starts a new login with a new QR, and the abandoned one is not heard from again", async () => {
        const state = serveQrLogin(fake);
        const { seen } = events();
        let retried = false;
        const result = await qrLogin({
            ...BASE,
            onEvent: (e) => {
                seen.push(e);
                if (e.type === LoginQRCallbackEventType.QRCodeGenerated && !retried) {
                    retried = true;
                    e.actions.retry();
                }
            },
        });
        assert.equal(state.generated, 2, "two QR codes were made");
        assert.equal(seen.filter((e) => e.type === LoginQRCallbackEventType.QRCodeGenerated).length, 2);
        assert.equal(seen.filter((e) => e.type === LoginQRCallbackEventType.QRCodeScanned).length, 1);
        assert.ok(result.cookies.length > 0);
        assert.ok(
            fake.requests.filter((r) => r.path.endsWith("/waiting-confirm")).every((r) => r.form.code === "qr-code-2"),
            "only the second QR was ever polled",
        );
    });

    it("tells the caller when a QR expires, and goes on when the caller retries", async () => {
        serveQrLogin(fake, { scan: ["hang", 0] });
        const { seen } = events();
        const result = await qrLogin({
            ...BASE,
            lifetimeMs: 40,
            onEvent: (e) => {
                seen.push(e);
                if (e.type === LoginQRCallbackEventType.QRCodeExpired) e.actions.retry();
            },
        });
        assert.deepEqual(
            seen.map((e) => e.type).filter((t) => t !== LoginQRCallbackEventType.GotLoginInfo),
            [
                LoginQRCallbackEventType.QRCodeGenerated,
                LoginQRCallbackEventType.QRCodeExpired,
                LoginQRCallbackEventType.QRCodeGenerated,
                LoginQRCallbackEventType.QRCodeScanned,
            ],
        );
        assert.ok(result.cookies.length > 0);
    });

    it("abort() rejects the login", async () => {
        serveQrLogin(fake, { scan: ["hang"] });
        await assert.rejects(
            qrLogin({
                ...BASE,
                onEvent: (e) => {
                    if (e.type === LoginQRCallbackEventType.QRCodeGenerated) e.actions.abort();
                },
            }),
            (e) => e instanceof ZaloApiLoginQRAborted,
        );
    });

    it("saveToFile() writes the QR image to the path it is given", async () => {
        const { mkdirSync, mkdtempSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        mkdirSync(CONFIG_DIR, { recursive: true });
        const dir = mkdtempSync(join(CONFIG_DIR, "qr-"));
        const file = join(dir, "q.png");
        serveQrLogin(fake);
        await qrLogin({
            ...BASE,
            onEvent: (e) => {
                if (e.type === LoginQRCallbackEventType.QRCodeGenerated) e.actions.saveToFile(file);
            },
        });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(readFileSync(file).toString("base64"), "iVBORw0KGgo=");
    });

    describe("the build number", () => {
        it("is read out of the page's script name", () => {
            assert.equal(buildOf('<script src="https://stc-zlogin.zdn.vn/main-2606161423.js"></script>'), "2606161423");
            assert.equal(buildOf("<html></html>"), null);
            assert.equal(buildOf(undefined), null);
        });
    });

    describe("the switch", () => {
        it("ZALO_QR_FLOW defaults to the legacy flow (the official one is opt in), and takes only legacy or official", () => {
            assert.equal(resolveQrFlow({}), "legacy");
            assert.equal(resolveQrFlow({ ZALO_QR_FLOW: "  " }), "legacy");
            assert.equal(resolveQrFlow({ ZALO_QR_FLOW: "official" }), "official");
            assert.equal(resolveQrFlow({ ZALO_QR_FLOW: " Legacy " }), "legacy");
            assert.equal(resolveQrFlow({ ZALO_QR_FLOW: "legacy" }), "legacy");
            assert.throws(
                () => resolveQrFlow({ ZALO_QR_FLOW: "new" }),
                (e) => e.code === QR_FLOW_INVALID && /ZALO_QR_FLOW/.test(e.message) && /"new"/.test(e.message),
            );
        });

        it("loginWithQR with ZALO_QR_FLOW=official runs this flow, then our own login, and returns a session", async () => {
            process.env.ZALO_QR_FLOW = "official";
            serveQrLogin(fake);
            const { api, ownId } = await loginWithQR(null, () => {});
            assert.equal(ownId, FAKE.ownId);
            assert.equal(typeof api.sendMessage, "function");
            const order = fake.requests.filter((r) => r.path.startsWith("/api/login/")).map((r) => r.path);
            assert.deepEqual(order, [
                "/api/login/getServerInfo",
                "/api/login/getLoginInfo",
                "/api/login/getServerInfo",
            ]);
            assert.ok(!fake.requests.some((r) => r.path.endsWith("/verify-client")));
            const login = fake.requests.find((r) => r.path === "/api/login/getLoginInfo");
            assert.ok(
                login.headers.cookie.includes("zpw_sek=fake-sek-from-pushsession"),
                "the QR session's cookie logs in",
            );
        });

        it("a bad ZALO_QR_FLOW fails before any request", async () => {
            process.env.ZALO_QR_FLOW = "bogus";
            await assert.rejects(
                loginWithQR(null, () => {}),
                (e) => e.code === QR_FLOW_INVALID,
            );
            assert.equal(fake.requests.length, 0);
        });
    });
});
