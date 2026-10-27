/**
 * The official QR login (src/zalo/qr-login.js, plan item L15) against the offline fake id.zalo.me.
 *
 * Asserted on the wire: the calls and their forms in the verified order (an account without a trusted device
 * confirms with no `bundle`; one with a trusted device matches the captured Web login in full: the second QR, the
 * poll on its code, the proof as `bundle`), the headers of a page load versus a script call, the events
 * zca-js-shaped consumers rely on, decline, retry, expiry and abort, the session the redirect chain ends in, the
 * device identity kept after a login, and the switch that selects it (`ZALO_QR_FLOW`).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LoginQRCallbackEventType, Zalo, ZaloApiLoginQRAborted, ZaloApiLoginQRDeclined } from "zca-js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { clearSession, loginWithQR } from "../../src/core/zalo-client.js";
import { QR_FLOW_INVALID, resolveQrFlow } from "../../src/zalo/profile.js";
import { buildOf, loadTrustFromPage, qrLogin, scriptUrlOf, wantsSecondQr } from "../../src/zalo/qr-login.js";
import { diffSequence } from "../helpers/replay/replay.js";
import { WEB_QR_LOGIN, WEB_QR_LOGIN_FORBIDDEN } from "../helpers/replay/shapes.js";
import { FAKE, SECOND_QR_ASKED, SECOND_QR_SCANNED, installFakeZalo, serveQrLogin } from "./fake-zalo-session.js";

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const BASE = { userAgent: CHROME_UA, apiType: 30, apiVersion: 694 };

/** A zca-js request context, as the login makes one. */
const requestContext = () => {
    const require = createRequire(import.meta.url);
    const { createContext } = require(join(dirname(require.resolve("zca-js")), "context.cjs"));
    const ctx = createContext(30, 694);
    ctx.options.checkUpdate = false;
    ctx.userAgent = CHROME_UA;
    ctx.cookie = new Zalo().parseCookies([]);
    return ctx;
};

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

    /** A stand-in for the page's trusted-device module that records how it was called. */
    const bytes = (...values) => new Uint8Array(values);
    const fakeTrust = () => {
        const calls = [];
        const api = {
            generateIdentity: () => {
                calls.push(["generateIdentity"]);
                return { publicKey: bytes(1, 2, 3), privateKey: bytes(4, 5, 6) };
            },
            generateLinkingSecret: () => {
                calls.push(["generateLinkingSecret"]);
                return bytes(7, 8);
            },
            generateLinkingQr: (p) => {
                calls.push(["generateLinkingQr", p]);
                return "LINKING-QR-TEXT";
            },
            getRelinkId: (p) => {
                calls.push(["getRelinkId", p]);
                return bytes(99);
            },
            createLinkingProof: (p) => {
                calls.push(["createLinkingProof", p]);
                return {
                    linkId: "77",
                    masterId: "fake-master-id",
                    companionId: 5,
                    linkingTimestamp: 1700000000000,
                    primaryPublicIdentityKey: bytes(9),
                    linkingMetadata: bytes(10, 11),
                    accountSignature: bytes(12),
                    deviceSignature: bytes(13),
                };
            },
        };
        return { calls, load: async () => api };
    };
    const fakeStore = (saved = null) => {
        const log = { saved: [], cleared: [], loaded: [] };
        return {
            log,
            load: (uid, masterId) => {
                log.loaded.push([uid, masterId]);
                return saved;
            },
            save: (record) => {
                log.saved.push(record);
                return true;
            },
            clear: (uid) => {
                log.cleared.push(uid);
                return true;
            },
        };
    };
    const calledWith = (trust, name) => trust.calls.find(([n]) => n === name)?.[1];
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

    it("asks for a QR the way the page does (cliGenQR 1), and the code on both long polls", async () => {
        serveQrLogin(fake);
        await qrLogin({ ...BASE });
        const form = (suffix) => fake.requests.find((r) => r.path.endsWith(suffix)).form;
        assert.equal(form("/qr/generate").cliGenQR, "1", "the client can make a QR itself, as the page says it can");
        assert.equal(form("/qr/waiting-scan").code, "qr-code-1");
        assert.equal(form("/qr/waiting-confirm").code, "qr-code-1");
        assert.equal(form("/qr/waiting-confirm").bundle, undefined, "an account with no trusted device has no proof");
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
        assert.equal(seen[0].data.layer, 1);
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

        it("and the script is named by its URL", () => {
            assert.equal(
                scriptUrlOf('<script src="https://stc-zlogin.zdn.vn/main-2606161423.js"></script>'),
                "https://stc-zlogin.zdn.vn/main-2606161423.js",
            );
            assert.equal(scriptUrlOf("<html></html>"), null);
        });
    });

    describe("an account with a trusted device", () => {
        const login = async (extra = {}, serve = {}) => {
            serveQrLogin(fake, { second: true, ...serve });
            const trust = fakeTrust();
            const store = fakeStore();
            const { seen, onEvent } = events();
            const result = await qrLogin({ ...BASE, onEvent, loadTrust: trust.load, trustStore: store, ...extra });
            return { trust, store, seen, result };
        };

        it("makes the calls of the captured Web login, whole: second QR, poll on its code, proof as bundle", async () => {
            await login();
            assert.deepEqual(diffSequence(fake.requests, WEB_QR_LOGIN, { forbidden: WEB_QR_LOGIN_FORBIDDEN }), []);
        });

        it("polls the first code until the second is asked for, then the second code, and confirms on it", async () => {
            await login();
            const codes = (suffix) => fake.requests.filter((r) => r.path.endsWith(suffix)).map((r) => r.form.code);
            assert.deepEqual(codes("/waiting-scan"), ["qr-code-1", "qr-code-1", "qr-code-2"]);
            assert.deepEqual(codes("/waiting-confirm"), ["qr-code-2"]);
            assert.equal(fake.requests.filter((r) => r.path.endsWith("/qr/generate")).length, 1);
        });

        it("makes the second QR from the token it was given, as a Web device, and shows it as layer 2", async () => {
            const { trust, seen } = await login();
            const qr = calledWith(trust, "generateLinkingQr");
            assert.equal(qr.qrToken, SECOND_QR_ASKED.token);
            assert.equal(qr.platform, 1, "a Web client");
            assert.ok(Math.abs(qr.timestamp - Date.now()) < 5000, "stamped with the time it was made");
            assert.deepEqual([...qr.publicKey], [1, 2, 3]);
            assert.deepEqual([...qr.secret], [7, 8]);
            assert.equal(qr.relinkId, undefined);
            const generated = seen.filter((e) => e.type === LoginQRCallbackEventType.QRCodeGenerated);
            assert.deepEqual(
                generated.map((e) => e.data.layer),
                [1, 2],
            );
            assert.equal(generated[1].data.code, SECOND_QR_ASKED.code);
            const png = Buffer.from(generated[1].data.image, "base64");
            assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
            assert.ok(png.length > 100, "with a drawn code in it");
        });

        it("announces the scan with the name the second poll answered, and nothing for the first", async () => {
            const { seen } = await login();
            const scanned = seen.filter((e) => e.type === LoginQRCallbackEventType.QRCodeScanned);
            assert.equal(scanned.length, 1);
            assert.equal(scanned[0].data.display_name, SECOND_QR_SCANNED.display_name);
        });

        it("makes the proof from the link data the phone answered, and sends it as the bundle the Web sends", async () => {
            const { trust } = await login();
            const proof = calledWith(trust, "createLinkingProof");
            assert.equal(Buffer.from(proof.primaryLinkingData).toString(), "fake-link-data");
            assert.equal(Buffer.from(proof.linkingHmac).toString(), "fake-link-hmac");
            assert.deepEqual([...proof.privateKey], [4, 5, 6]);
            const confirm = fake.requests.find((r) => r.path.endsWith("/waiting-confirm"));
            assert.deepEqual(Object.keys(confirm.form), ["continue", "code", "bundle", "v"], "in the Web's order");
            const bundle = JSON.parse(Buffer.from(confirm.form.bundle, "base64").toString());
            assert.deepEqual(Object.keys(bundle), ["encLinkMetaData", "encAccSign", "encDeviceSign", "encCompPubKey"]);
            const decoded = (key) => [...Buffer.from(bundle[key], "base64")];
            assert.deepEqual(decoded("encLinkMetaData"), [10, 11]);
            assert.deepEqual(decoded("encAccSign"), [12]);
            assert.deepEqual(decoded("encDeviceSign"), [13]);
            assert.deepEqual(decoded("encCompPubKey"), [1, 2, 3], "the public key of this device");
        });

        it("keeps the identity after the login, once, with what a later login needs", async () => {
            const { store, result } = await login();
            assert.equal(store.log.saved.length, 1);
            const [kept] = store.log.saved;
            assert.equal(kept.uid, SECOND_QR_ASKED.chatUid);
            assert.equal(kept.masterId, "fake-master-id");
            assert.equal(kept.companionId, 5);
            assert.equal(kept.linkId, "77");
            assert.equal(kept.linkingTimestamp, 1700000000000);
            assert.deepEqual([...kept.privateKey], [4, 5, 6]);
            assert.deepEqual([...kept.linkingSecret], [7, 8]);
            assert.deepEqual([...kept.primaryPublicIdentityKey], [9]);
            assert.equal(kept.devices.masterId, "fake-master-id", "the device list the server answered");
            assert.deepEqual(result.trusted, {
                uid: SECOND_QR_ASKED.chatUid,
                masterId: "fake-master-id",
                companionId: 5,
            });
            assert.ok(!JSON.stringify(result).includes("privateKey"), "the secret does not travel in the result");
        });

        it("keeps nothing when the phone declines, and fetches no session", async () => {
            serveQrLogin(fake, { second: true, confirm: [-13] });
            const store = fakeStore();
            await assert.rejects(
                qrLogin({ ...BASE, loadTrust: fakeTrust().load, trustStore: store }),
                (e) => e instanceof ZaloApiLoginQRDeclined,
            );
            assert.deepEqual(store.log.saved, []);
            assert.ok(!fake.requests.some((r) => r.path === "/account/checksession"));
        });

        it("links again as the same device when an identity was saved: relink id, no secret in the QR", async () => {
            serveQrLogin(fake, { second: true });
            const trust = fakeTrust();
            const saved = {
                uid: SECOND_QR_ASKED.chatUid,
                masterId: "fake-master-id",
                publicKey: bytes(21, 22),
                privateKey: bytes(23),
                linkingSecret: bytes(24, 25),
                primaryPublicIdentityKey: bytes(26),
                linkingTimestamp: 1600000000000,
            };
            const store = fakeStore(saved);
            await qrLogin({ ...BASE, loadTrust: trust.load, trustStore: store });
            assert.deepEqual(store.log.loaded, [[SECOND_QR_ASKED.chatUid, "fake-master-id"]]);
            assert.ok(!trust.calls.some(([n]) => n === "generateIdentity"), "no new identity");
            const relink = calledWith(trust, "getRelinkId");
            assert.deepEqual([...relink.primaryKey], [26]);
            assert.deepEqual([...relink.publicKey], [21, 22]);
            assert.deepEqual([...relink.secret], [24, 25]);
            assert.equal(relink.linkingTimestamp, 1600000000000);
            const qr = calledWith(trust, "generateLinkingQr");
            assert.deepEqual([...qr.relinkId], [99]);
            assert.equal(qr.secret, undefined, "a relink does not carry the secret");
            assert.deepEqual([...calledWith(trust, "createLinkingProof").secret], [24, 25]);
        });

        it("forgets a saved identity the phone refuses (-21), and says to log in again", async () => {
            serveQrLogin(fake, { second: true });
            // the second poll answers -21
            fake.clearRoutes?.();
            serveQrLogin(fake, { second: { scan: [-21] } });
            const store = fakeStore({
                uid: SECOND_QR_ASKED.chatUid,
                masterId: "fake-master-id",
                publicKey: bytes(1),
                privateKey: bytes(2),
                linkingSecret: bytes(3),
                primaryPublicIdentityKey: bytes(4),
                linkingTimestamp: 5,
            });
            await assert.rejects(qrLogin({ ...BASE, loadTrust: fakeTrust().load, trustStore: store }), /was cleared/);
            assert.deepEqual(store.log.cleared, [SECOND_QR_ASKED.chatUid]);
            assert.deepEqual(store.log.saved, []);
        });

        it("a second-poll answer with no link data is an error, not a login", async () => {
            serveQrLogin(fake, {
                second: { scanned: { ...SECOND_QR_SCANNED, link_data: undefined } },
            });
            await assert.rejects(
                qrLogin({ ...BASE, loadTrust: fakeTrust().load, trustStore: fakeStore() }),
                /carried no link data/,
            );
            assert.ok(!fake.requests.some((r) => r.path.endsWith("/waiting-confirm")));
        });

        it("a module that cannot be loaded ends the login with its reason, before any confirm", async () => {
            serveQrLogin(fake, { second: true });
            await assert.rejects(
                qrLogin({
                    ...BASE,
                    loadTrust: async () => {
                        throw new Error("module refused");
                    },
                }),
                /module refused/,
            );
            assert.ok(!fake.requests.some((r) => r.path.endsWith("/waiting-confirm")));
        });

        it("a second QR that is never scanned expires like the first, and the caller can retry", async () => {
            serveQrLogin(fake, { second: { scan: ["hang"] } });
            const { seen } = events();
            await assert.rejects(
                qrLogin({
                    ...BASE,
                    loadTrust: fakeTrust().load,
                    trustStore: fakeStore(),
                    lifetimeMs: 60,
                    onEvent: (e) => {
                        seen.push(e);
                        if (e.type === LoginQRCallbackEventType.QRCodeExpired) e.actions.abort();
                    },
                }),
                (e) => e instanceof ZaloApiLoginQRAborted,
            );
            const kinds = seen.map((e) => `${e.type}${e.data?.layer ?? ""}`);
            assert.ok(kinds.includes(`${LoginQRCallbackEventType.QRCodeGenerated}2`), "the second QR was shown");
            assert.ok(kinds.includes(String(LoginQRCallbackEventType.QRCodeExpired)), "and expired");
        });

        it("tells a scan that wants a second QR from one that does not", () => {
            assert.equal(wantsSecondQr(SECOND_QR_ASKED), true);
            for (const broken of [
                { ...SECOND_QR_ASKED, status: 5 },
                { ...SECOND_QR_ASKED, new_qr_supported: false },
                { ...SECOND_QR_ASKED, token: "" },
                { ...SECOND_QR_ASKED, code: undefined },
                SECOND_QR_SCANNED,
                { display_name: "Fake Person" },
                null,
                undefined,
            ]) {
                assert.equal(wantsSecondQr(broken), false, JSON.stringify(broken));
            }
        });

        it("an account with no trusted device never loads the module", async () => {
            serveQrLogin(fake);
            let loaded = false;
            await qrLogin({
                ...BASE,
                loadTrust: async () => {
                    loaded = true;
                },
            });
            assert.equal(loaded, false);
        });
    });

    describe("the page's trusted-device module", () => {
        const WASM_URL = "https://stc-zlogin.zdn.vn/wasm/libzproto_wasm_bg.0123456789abcdef.wasm";
        const SCRIPT_URL = "https://stc-zlogin.zdn.vn/main-2606161423.js";

        it("is found by the wasm URL the page script names, fetched as the page fetches it", async () => {
            fake.rawRoute(
                (r) => r.host === "stc-zlogin.zdn.vn" && r.path.endsWith(".js"),
                () => new Response(`var a=["x","${WASM_URL}","y"];`, { status: 200 }),
            );
            fake.rawRoute(
                (r) => r.host === "stc-zlogin.zdn.vn" && r.path.endsWith(".wasm"),
                () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
            );
            // the bytes are not a module: that is the loader's error, after both files were fetched
            await assert.rejects(loadTrustFromPage(requestContext(), SCRIPT_URL));
            const script = fake.requests.find((r) => r.path === "/main-2606161423.js");
            const wasm = fake.requests.find((r) => r.path.endsWith(".wasm"));
            assert.equal(script.headers["sec-fetch-dest"], "script");
            assert.equal(`https://${wasm.host}${wasm.path}`, WASM_URL);
            assert.equal(wasm.headers.referer, "https://id.zalo.me/");
        });

        it("a page that names no module is reported as a changed page", async () => {
            fake.rawRoute(
                (r) => r.host === "stc-zlogin.zdn.vn",
                () => new Response("var nothing=1;", { status: 200 }),
            );
            await assert.rejects(loadTrustFromPage(requestContext(), SCRIPT_URL), /names no trusted-device module/);
        });
    });

    describe("the switch", () => {
        it("ZALO_QR_FLOW defaults to the official flow (legacy is opt in), and takes only legacy or official", () => {
            assert.equal(resolveQrFlow({}), "official");
            assert.equal(resolveQrFlow({ ZALO_QR_FLOW: "  " }), "official");
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
