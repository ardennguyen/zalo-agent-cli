/**
 * src/core/zbs/api.js and src/commands/zbs.js: every ZBS Template Message request, asserted against Zalo's ZBS docs
 * (docs.zaloplatforms.com/docs/ZBS): base URL, method, headers, query and body, the phone-number and hashing rules,
 * tracking_id rules, journey headers, and the limits checked before anything is sent. globalThis.fetch is mocked;
 * nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { saveOACreds, OAError } from "../../src/core/oa/transport.js";
import {
    buildPhoneSend,
    checkJourneyToken,
    createJourneyToken,
    createRsaKey,
    createTemplate,
    editTemplate,
    getAllRatings,
    getMessageStatus,
    getQuality,
    getQuickReplies,
    getQuota,
    getRatings,
    getRsaKey,
    getTemplate,
    getTemplateSample,
    listAllTemplates,
    listTemplates,
    sendByPhone,
    sendByUid,
    sendJourney,
    toMillis,
    trackingId,
    uploadImage,
} from "../../src/core/zbs/api.js";
import { hashPhone, normalizePhone } from "../../src/core/zbs/phone.js";
import { registerZbsCommands, readJsonArg } from "../../src/commands/zbs.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

delete process.env.ZALO_OA_DIR;
const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const FILES = join(SANDBOX_HOME, "zbs-files");
const ZBS = "https://business.openapi.zalo.me";
const USER = "1000000000000000001";
const PHONE = "84901234567";

/** Replace fetch: `reply(url, init, n)` returns `{ status?, json?, text?, type? }`; every call is recorded. */
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

const bodyOf = (c) => JSON.parse(c.init.body);
const queryOf = (c) => Object.fromEntries(new URL(c.url).searchParams);
const pathOf = (c) => {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}`;
};

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-1", refreshToken: "ref-1", appId: "123", secretKey: "sek" });
    saveOACreds({ accessToken: "tok-2" }, "shop2");
});
afterEach(() => m?.restore());

describe("phone numbers (country-code form, per the send pages)", () => {
    it("normalizes 0…, +84…, 84… and separators to 84xxxxxxxxx", () => {
        assert.equal(normalizePhone("0901234567"), PHONE);
        assert.equal(normalizePhone("+84901234567"), PHONE);
        assert.equal(normalizePhone("84901234567"), PHONE);
        assert.equal(normalizePhone("090 123-4567"), PHONE);
        assert.equal(normalizePhone("(090) 123.4567"), PHONE);
        // the spreadsheet form without its leading 0 (the docs' -108 row)
        assert.equal(normalizePhone("901234567"), PHONE);
    });

    it("rejects what cannot be a number before sending", () => {
        for (const bad of ["", "abc", "09012", "8490123456", "849012345678", "0901234567x"]) {
            assert.throws(
                () => normalizePhone(bad),
                (e) => e instanceof OAError && e.code === "invalid_input",
                bad,
            );
        }
    });

    it("hash_phone is the SHA-256 hex of the normalized number; a digest passes through", () => {
        const want = createHash("sha256").update(PHONE).digest("hex");
        assert.equal(hashPhone("0901234567"), want);
        assert.equal(hashPhone("+84 901 234 567"), want);
        assert.equal(hashPhone(want.toUpperCase()), want);
    });
});

describe("tracking_id", () => {
    it("keeps a valid one, generates one (letters and digits, <= 48) when absent", () => {
        assert.equal(trackingId("order_42-a"), "order_42-a");
        const g = trackingId();
        assert.match(g, /^[A-Za-z0-9]{1,48}$/);
        assert.notEqual(trackingId(), g);
    });
    it("rejects more than 48 characters and special characters", () => {
        assert.throws(() => trackingId("x".repeat(49)), /48/);
        assert.throws(() => trackingId("a b"), /letters/);
        assert.throws(() => trackingId("a#b"), /letters/);
        assert.equal(trackingId("x".repeat(48)).length, 48);
    });
});

describe('template API ("Quản lý template")', () => {
    it("list: GET /template/all with offset, limit, status, filterPreset and the access_token header", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: [{ templateId: 1 }], metadata: { total: 1 } } }));
        await listTemplates({ offset: 5, limit: 50, status: "reject", mine: true });
        await listTemplates();
        const [a, b] = m.calls;
        assert.equal(a.init.method, "GET");
        assert.equal(pathOf(a), `${ZBS}/template/all`);
        assert.deepEqual(queryOf(a), { offset: "5", limit: "50", status: "3", filterPreset: "1" });
        assert.equal(a.init.headers.access_token, "tok-1");
        assert.equal(a.init.body, undefined);
        assert.deepEqual(queryOf(b), { offset: "0", limit: "100" });
    });

    it("list: limit over 100, bad status or offset are refused before any request", async () => {
        m = mockFetch();
        await assert.rejects(listTemplates({ limit: 101 }), /1-100/);
        await assert.rejects(listTemplates({ limit: 0 }), /1-100/);
        await assert.rejects(listTemplates({ status: "live" }), /status/);
        await assert.rejects(listTemplates({ status: 5 }), /status/);
        await assert.rejects(listTemplates({ offset: -1 }), /offset/);
        assert.equal(m.calls.length, 0);
    });

    it("list --all walks 100 at a time until metadata.total", async () => {
        const page = (n, start) => Array.from({ length: n }, (_, i) => ({ templateId: start + i }));
        m = mockFetch((url) => {
            const off = Number(new URL(url).searchParams.get("offset"));
            const n = off === 200 ? 30 : 100;
            return { json: { error: 0, data: page(n, off), metadata: { total: 230 } } };
        });
        const r = await listAllTemplates({ status: 1 });
        assert.equal(r.data.length, 230);
        assert.deepEqual(
            m.calls.map((c) => queryOf(c).offset),
            ["0", "100", "200"],
        );
        assert.ok(m.calls.every((c) => queryOf(c).limit === "100" && queryOf(c).status === "1"));
        assert.equal(r.metadata.total, 230);
    });

    it("detail: GET /template/info/v2?template_id=; sample: GET /template/sample-data?template_id=", async () => {
        m = mockFetch();
        await getTemplate("12345");
        await getTemplateSample(" 12345 ");
        assert.equal(pathOf(m.calls[0]), `${ZBS}/template/info/v2`);
        assert.deepEqual(queryOf(m.calls[0]), { template_id: "12345" });
        assert.equal(pathOf(m.calls[1]), `${ZBS}/template/sample-data`);
        assert.deepEqual(queryOf(m.calls[1]), { template_id: "12345" });
        await assert.rejects(getTemplate(""), /template_id/);
    });

    it("rating: /rating/get with template_id, from_time, to_time (ms), offset, limit", async () => {
        m = mockFetch();
        await getRatings("203972", { from: 1616673095659, to: "1616673271320", offset: 0, limit: 1 });
        const [c] = m.calls;
        assert.equal(c.init.method, "GET");
        assert.equal(pathOf(c), `${ZBS}/rating/get`);
        assert.deepEqual(queryOf(c), {
            template_id: "203972",
            from_time: "1616673095659",
            to_time: "1616673271320",
            offset: "0",
            limit: "1",
        });
    });

    it("rating: dates are read as ms; from after to is refused", async () => {
        m = mockFetch();
        assert.equal(toMillis("2026-11-01T00:00:00Z", "from"), Date.UTC(2026, 10, 1));
        await assert.rejects(getRatings("1", { from: 20, to: 10 }), /after/);
        await assert.rejects(getRatings("1", { to: 10 }), /from is required/);
        await assert.rejects(getRatings("1", { from: "soon", to: 10 }), /not a time/);
        assert.equal(m.calls.length, 0);
    });

    it("rating --all walks pages until data.total", async () => {
        m = mockFetch((url) => {
            const off = Number(new URL(url).searchParams.get("offset"));
            const n = off === 0 ? 2 : 1;
            return { json: { error: 0, data: { total: 3, data: Array.from({ length: n }, () => ({ rate: 5 })) } } };
        });
        const r = await getAllRatings("1", { from: 1, to: 2, pageSize: 2 });
        assert.equal(r.data.data.length, 3);
        assert.deepEqual(
            m.calls.map((c) => queryOf(c).offset),
            ["0", "2"],
        );
    });

    it("quick-reply: /response/get with template_id, from_time, to_time, limit (no offset)", async () => {
        m = mockFetch();
        await getQuickReplies("203972", { from: 1, to: 2, limit: 10 });
        const [c] = m.calls;
        assert.equal(pathOf(c), `${ZBS}/response/get`);
        assert.deepEqual(queryOf(c), { template_id: "203972", from_time: "1", to_time: "2", limit: "10" });
    });

    const goodTemplate = () => ({
        template_name: "Order confirmation",
        template_type: 1,
        tag: "1",
        layout: {
            header: {
                components: [
                    { LOGO: { light: { type: "IMAGE", media_id: "m1" }, dark: { type: "IMAGE", media_id: "m2" } } },
                ],
            },
            body: {
                components: [
                    { TITLE: { value: "Order confirmed" } },
                    { PARAGRAPH: { value: "Thank you <name>, your order is confirmed." } },
                ],
            },
            footer: {
                components: [
                    { BUTTONS: { items: [{ type: 1, title: "View order", content: "https://example.com/" }] } },
                ],
            },
        },
        params: [{ type: "1", name: "name", sample_value: "Customer A" }],
        note: "review note",
    });

    it("create: POST /template/create with the JSON body as given, plus a generated tracking_id", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { template_id: "31239", status: "PENDING_REVIEW" } } }));
        const t = goodTemplate();
        await createTemplate(t);
        const [c] = m.calls;
        assert.equal(c.init.method, "POST");
        assert.equal(c.url, `${ZBS}/template/create`);
        assert.equal(c.init.headers["Content-Type"], "application/json");
        assert.equal(c.init.headers.access_token, "tok-1");
        const body = bodyOf(c);
        const { tracking_id, ...rest } = body;
        assert.deepEqual(rest, t);
        assert.match(tracking_id, /^[A-Za-z0-9]+$/);
    });

    it("create: --tracking-id wins; the template is checked first and a bad one is never sent", async () => {
        m = mockFetch();
        await createTemplate({ ...goodTemplate(), tracking_id: "mine" }, { trackingId: "override" });
        assert.equal(bodyOf(m.calls[0]).tracking_id, "override");
        await createTemplate({ ...goodTemplate(), tracking_id: "mine" });
        assert.equal(bodyOf(m.calls[1]).tracking_id, "mine");
        await assert.rejects(
            createTemplate({ ...goodTemplate(), template_name: "short" }),
            (e) => e.code === "invalid_input" && /template_name must be 10-60/.test(e.message),
        );
        assert.equal(m.calls.length, 2);
        // check: false sends it anyway
        await createTemplate({ ...goodTemplate(), template_name: "short" }, { check: false });
        assert.equal(m.calls.length, 3);
    });

    it("update: POST /template/edit with template_id from the argument", async () => {
        m = mockFetch();
        await editTemplate("234567", { ...goodTemplate(), template_id: "999" }, { trackingId: "t1" });
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/template/edit`);
        assert.equal(c.init.method, "POST");
        const body = bodyOf(c);
        assert.equal(body.template_id, "234567");
        assert.equal(body.tracking_id, "t1");
        assert.equal(body.template_name, "Order confirmation");
    });

    it("upload-image: POST /upload/image multipart `file`; jpg/png <= 500 KB checked first", async () => {
        mkdirSync(FILES, { recursive: true });
        const ok = join(FILES, "pic.png");
        writeFileSync(ok, pngBytes(1600, 900));
        const big = join(FILES, "big.jpg");
        writeFileSync(big, Buffer.alloc(500 * 1024 + 1));
        const gif = join(FILES, "a.gif");
        writeFileSync(gif, "GIF89a");
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { media_id: "abc" } } }));
        const r = await uploadImage(ok, { kind: "image" });
        assert.equal(r.data.media_id, "abc");
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/upload/image`);
        assert.equal(c.init.method, "POST");
        assert.ok(c.init.body instanceof globalThis.FormData);
        const part = c.init.body.get("file");
        assert.equal(part.name, "pic.png");
        assert.equal(part.type, "image/png");
        assert.equal(c.init.headers.access_token, "tok-1");
        await assert.rejects(uploadImage(big), (e) => e.code === "upload_too_large");
        await assert.rejects(uploadImage(gif), (e) => e.code === "upload_type");
        assert.equal(m.calls.length, 1);
    });

    it("upload-image --kind: logo must be a 400x96 PNG, image 16:9", async () => {
        mkdirSync(FILES, { recursive: true });
        const logo = join(FILES, "logo.png");
        writeFileSync(logo, pngBytes(400, 96));
        const wrongLogo = join(FILES, "logo2.png");
        writeFileSync(wrongLogo, pngBytes(400, 100));
        const square = join(FILES, "sq.jpg");
        writeFileSync(square, jpegBytes(500, 500));
        const wide = join(FILES, "wide.jpg");
        writeFileSync(wide, jpegBytes(1280, 720));
        m = mockFetch(() => ({ json: { error: 0, data: { media_id: "x" } } }));
        await uploadImage(logo, { kind: "logo" });
        await uploadImage(wide, { kind: "image" });
        await assert.rejects(uploadImage(wrongLogo, { kind: "logo" }), /400x96/);
        await assert.rejects(uploadImage(wide, { kind: "logo" }), /PNG/);
        await assert.rejects(uploadImage(square, { kind: "image" }), /16:9/);
        assert.equal(m.calls.length, 2);
    });
});

describe('send by phone ("API Gửi tin" and its modes)', () => {
    const data = { customer: "Customer A", amount: "100" };

    it("plain: POST /message/template { phone (84…), template_id, template_data, tracking_id }", async () => {
        m = mockFetch(() => ({
            json: {
                error: 0,
                message: "Success",
                data: {
                    msg_id: "a4d0",
                    sent_time: "1626926349402",
                    sending_mode: "1",
                    quota: { dailyQuota: "500", remainingQuota: "499" },
                },
            },
        }));
        const r = await sendByPhone({ phone: "0901234567", templateId: "7895", data, trackingId: "track1" });
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/message/template`);
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers.access_token, "tok-1");
        assert.equal(c.init.headers["Content-Type"], "application/json");
        assert.deepEqual(bodyOf(c), { phone: PHONE, template_id: "7895", template_data: data, tracking_id: "track1" });
        assert.equal(r.data.msg_id, "a4d0");
        assert.equal(r.tracking_id, "track1");
    });

    it('plain: sending_mode "3" (over quota) is sent as a string; other values are refused', async () => {
        m = mockFetch();
        await sendByPhone({ phone: PHONE, templateId: "1", data, trackingId: "t", sendingMode: 3 });
        assert.equal(bodyOf(m.calls[0]).sending_mode, "3");
        assert.throws(() => buildPhoneSend({ phone: PHONE, templateId: "1", data, sendingMode: "2" }), /sending_mode/);
        assert.throws(
            () => buildPhoneSend({ phone: PHONE, templateId: "1", data, sendingMode: "3", mode: "hash" }),
            /plain send/,
        );
    });

    it("hash: POST /message/template/hashphone { hash_phone: sha256(84…), … }", async () => {
        m = mockFetch();
        await sendByPhone({ phone: "0901234567", templateId: "7895", data, trackingId: "t", mode: "hash" });
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/message/template/hashphone`);
        assert.deepEqual(bodyOf(c), {
            hash_phone: createHash("sha256").update(PHONE).digest("hex"),
            template_id: "7895",
            template_data: data,
            tracking_id: "t",
        });
    });

    it('dev: POST /message/template with mode "development"', async () => {
        m = mockFetch();
        await sendByPhone({ phone: PHONE, templateId: "7895", data, trackingId: "t", mode: "dev" });
        assert.equal(m.calls[0].url, `${ZBS}/message/template`);
        assert.deepEqual(bodyOf(m.calls[0]), {
            mode: "development",
            phone: PHONE,
            template_id: "7895",
            template_data: data,
            tracking_id: "t",
        });
    });

    it("rsa: POST /rsa/message/template; phone and every value encrypted with the given key", async () => {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const b64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
        m = mockFetch();
        await sendByPhone({
            phone: "0901234567",
            templateId: "1234567",
            data: { param_1: "Sample text" },
            trackingId: "t",
            mode: "rsa",
            publicKey: b64,
            mgf1Hash: "sha256",
        });
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/rsa/message/template`);
        const body = bodyOf(c);
        assert.deepEqual(Object.keys(body).sort(), ["rsa_phone", "template_data", "template_id", "tracking_id"]);
        const dec = (s) => privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(s, "base64")).toString();
        assert.equal(dec(body.rsa_phone), PHONE);
        assert.equal(dec(body.template_data.param_1), "Sample text");
        assert.equal(body.template_id, "1234567");
    });

    it("rsa without a key fetches it from GET /rsa/key/get first", async () => {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const b64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
        m = mockFetch((url) =>
            url.endsWith("/rsa/key/get")
                ? { json: { error: 0, data: { public_key: b64 } } }
                : { json: { error: 0, data: {} } },
        );
        await sendByPhone({ phone: PHONE, templateId: "1", data: { a: "b" }, trackingId: "t", mode: "rsa" });
        assert.equal(m.calls[0].url, `${ZBS}/rsa/key/get`);
        assert.equal(m.calls[0].init.method, "GET");
        assert.equal(m.calls[1].url, `${ZBS}/rsa/message/template`);
    });

    it("rsa --encrypted sends the ciphertexts as given", async () => {
        m = mockFetch();
        await sendByPhone({
            phone: "Y2lwaGVy",
            templateId: "1",
            data: { param_1: "Y2lwaGVyMg==" },
            trackingId: "t",
            mode: "rsa",
            encrypted: true,
        });
        assert.deepEqual(bodyOf(m.calls[0]), {
            rsa_phone: "Y2lwaGVy",
            template_id: "1",
            template_data: { param_1: "Y2lwaGVyMg==" },
            tracking_id: "t",
        });
    });

    it("template_data must be an object; a bad phone is refused before any request", async () => {
        m = mockFetch();
        await assert.rejects(sendByPhone({ phone: PHONE, templateId: "1", data: [] }), /template_data/);
        await assert.rejects(sendByPhone({ phone: "12", templateId: "1", data: {} }), /phone/i);
        await assert.rejects(
            sendByPhone({ phone: PHONE, templateId: "1", data: {}, trackingId: "a b" }),
            /tracking_id/,
        );
        assert.equal(m.calls.length, 0);
    });

    it("a ZBS error carries the ZBS table's meaning", async () => {
        m = mockFetch(() => ({ json: { error: -108, message: "Phone number invalid" } }));
        await assert.rejects(
            sendByPhone({ phone: PHONE, templateId: "1", data: {} }),
            (e) => e.code === -108 && /invalid phone number/.test(e.message),
        );
    });

    it("rsa-key create / get: GET /rsa/key/gen and /rsa/key/get", async () => {
        m = mockFetch();
        await createRsaKey();
        await getRsaKey("shop2");
        assert.equal(m.calls[0].url, `${ZBS}/rsa/key/gen`);
        assert.equal(m.calls[1].url, `${ZBS}/rsa/key/get`);
        assert.equal(m.calls[1].init.headers.access_token, "tok-2");
        assert.ok(m.calls.every((c) => c.init.method === "GET"));
    });
});

describe('journey ("API Gửi tin Journey")', () => {
    it("token: POST /journey/get-token { phone, token_type }; type omitted when not given", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", token: "jt", journey_id: "9" } }));
        const r = await createJourneyToken("0901234567", { type: "token_coach_bus_30" });
        await createJourneyToken(PHONE);
        assert.equal(m.calls[0].url, `${ZBS}/journey/get-token`);
        assert.equal(m.calls[0].init.method, "POST");
        assert.deepEqual(bodyOf(m.calls[0]), { phone: PHONE, token_type: "token_coach_bus_30" });
        assert.deepEqual(bodyOf(m.calls[1]), { phone: PHONE });
        assert.equal(r.token, "jt");
        await assert.rejects(createJourneyToken(PHONE, { type: "token_logistics_14" }), /token_type/);
    });

    it("check: GET /journey/check-token with access_token and journey_token headers", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { tokenType: "token_logistics_7" } } }));
        await checkJourneyToken("jt-1");
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/journey/check-token`);
        assert.equal(c.init.method, "GET");
        assert.equal(c.init.headers.access_token, "tok-1");
        assert.equal(c.init.headers.journey_token, "jt-1");
        assert.equal(c.init.body, undefined);
    });

    it("send: POST /message/template with the journey_token header and { phone, template_id, template_data }", async () => {
        m = mockFetch();
        await sendJourney({ phone: "0901234567", templateId: "217489", data: {}, journeyToken: "jt-1", oaId: "shop2" });
        const [c] = m.calls;
        assert.equal(c.url, `${ZBS}/message/template`);
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers.journey_token, "jt-1");
        assert.equal(c.init.headers.access_token, "tok-2");
        assert.deepEqual(bodyOf(c), { phone: PHONE, template_id: "217489", template_data: {} });
    });

    it("a journey error is explained from the ZBS table", async () => {
        m = mockFetch(() => ({ json: { error: -150, message: "Journey token has expired" } }));
        await assert.rejects(
            checkJourneyToken("jt"),
            (e) => e instanceof OAError && e.code === -150 && /journey token expired/.test(e.message),
        );
        await assert.rejects(checkJourneyToken(""), /journey token is required/);
    });

    it("a stale access token (-124) is refreshed once and the journey call retried once", async () => {
        let n = 0;
        m = mockFetch((url) => {
            if (url.startsWith("https://oauth.zaloapp.com")) {
                return { json: { access_token: "tok-new", refresh_token: "ref-new", expires_in: "90000" } };
            }
            n++;
            return n === 1
                ? { json: { error: -124, message: "Access token invalid" } }
                : { json: { error: 0, data: {} } };
        });
        await checkJourneyToken("jt");
        const zbsCalls = m.calls.filter((c) => c.url.startsWith(ZBS));
        assert.equal(zbsCalls.length, 2);
        assert.equal(zbsCalls[0].init.headers.access_token, "tok-1");
        assert.equal(zbsCalls[1].init.headers.access_token, "tok-new");
        assert.equal(zbsCalls[1].init.headers.journey_token, "jt");
    });
});

describe('send by UID ("API gửi tin qua UID")', () => {
    it("POST https://openapi.zalo.me/v3.0/oa/message/template { user_id, template_id, template_data }", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { message_id: "63ec", user_id: USER } } }));
        await sendByUid({ userId: USER, templateId: "433555", data: { ky: "1" } });
        const [c] = m.calls;
        assert.equal(c.url, "https://openapi.zalo.me/v3.0/oa/message/template");
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers.access_token, "tok-1");
        assert.deepEqual(bodyOf(c), { user_id: USER, template_id: "433555", template_data: { ky: "1" } });
    });

    it('-249 reads as the OA table\'s "template does not support sending by UID"', async () => {
        m = mockFetch(() => ({ json: { error: -249, message: "Template does not support send via UID" } }));
        await assert.rejects(sendByUid({ userId: USER, templateId: "1", data: {} }), /does not support sending by UID/);
        await assert.rejects(sendByUid({ userId: "abc", templateId: "1", data: {} }), /user_id/);
    });
});

describe('status, quota, quality ("Truy xuất thông tin gửi tin qua SĐT")', () => {
    it("status: GET /message/status?message_id= (phone only when given, normalized)", async () => {
        m = mockFetch();
        await getMessageStatus("msg1");
        await getMessageStatus("msg1", { phone: "0901234567" });
        assert.equal(pathOf(m.calls[0]), `${ZBS}/message/status`);
        assert.deepEqual(queryOf(m.calls[0]), { message_id: "msg1" });
        assert.deepEqual(queryOf(m.calls[1]), { message_id: "msg1", phone: PHONE });
    });
    it("quota: GET /message/quota; quality: GET /quality", async () => {
        m = mockFetch();
        await getQuota();
        await getQuality("shop2");
        assert.equal(m.calls[0].url, `${ZBS}/message/quota`);
        assert.equal(m.calls[1].url, `${ZBS}/quality`);
        assert.equal(m.calls[1].init.headers.access_token, "tok-2");
        assert.ok(m.calls.every((c) => c.init.method === "GET" && c.init.body === undefined));
    });
});

// ─── The commands ────────────────────────────────────────────────────

/** Run `zbs …` through the real command definitions; returns stdout lines and the exit code. */
async function runZbs(argv, { jsonMode = true } = {}) {
    const program = new Command();
    program.exitOverride();
    program.option("--json");
    registerZbsCommands(program);
    const out = [];
    const realLog = console.log;
    const realErr = console.error;
    const before = process.env.ZALO_JSON_MODE;
    if (jsonMode) process.env.ZALO_JSON_MODE = "1";
    else delete process.env.ZALO_JSON_MODE;
    _resetErrorLatch();
    process.exitCode = 0;
    console.log = (...a) => out.push(a.join(" "));
    console.error = () => {};
    try {
        await program.parseAsync([...(jsonMode ? ["--json"] : []), "zbs", ...argv], { from: "user" });
    } finally {
        console.log = realLog;
        console.error = realErr;
        if (before === undefined) delete process.env.ZALO_JSON_MODE;
        else process.env.ZALO_JSON_MODE = before;
    }
    const code = process.exitCode;
    process.exitCode = 0;
    return { stdout: out.join("\n"), code };
}

describe("zbs commands", () => {
    it("registers every documented subcommand", () => {
        const program = new Command();
        const zbs = registerZbsCommands(program);
        const names = (c) => c.commands.map((x) => x.name()).sort();
        assert.deepEqual(names(zbs), [
            "journey",
            "quality",
            "quota",
            "rsa-key",
            "send",
            "status",
            "template",
            "uid",
            "upload-image",
        ]);
        const sub = (n) => names(zbs.commands.find((x) => x.name() === n));
        assert.deepEqual(sub("template"), ["create", "detail", "list", "quick-reply", "rating", "sample", "update"]);
        assert.deepEqual(sub("journey"), ["check", "send", "token"]);
        assert.deepEqual(sub("rsa-key"), ["create", "get"]);
    });

    it("send --json prints Zalo's reply plus tracking_id, nothing else on stdout", async () => {
        m = mockFetch(() => ({ json: { error: 0, message: "Success", data: { msg_id: "a4d0" } } }));
        const { stdout, code } = await runZbs([
            "send",
            "0901234567",
            "7895",
            '{"customer":"A"}',
            "--tracking-id",
            "t1",
        ]);
        assert.equal(code, 0);
        const r = JSON.parse(stdout);
        assert.equal(r.data.msg_id, "a4d0");
        assert.equal(r.tracking_id, "t1");
        assert.deepEqual(bodyOf(m.calls[0]), {
            phone: PHONE,
            template_id: "7895",
            template_data: { customer: "A" },
            tracking_id: "t1",
        });
    });

    it("send reads template_data from a file and picks the OA with --oa-id", async () => {
        mkdirSync(FILES, { recursive: true });
        const f = join(FILES, "data.json");
        writeFileSync(f, '﻿{"amount":"100"}');
        m = mockFetch();
        const { code } = await runZbs(["send", PHONE, "7895", f, "--hash-phone", "--oa-id", "shop2"]);
        assert.equal(code, 0);
        assert.equal(m.calls[0].url, `${ZBS}/message/template/hashphone`);
        assert.equal(m.calls[0].init.headers.access_token, "tok-2");
        assert.deepEqual(bodyOf(m.calls[0]).template_data, { amount: "100" });
    });

    it("send refuses two modes at once, and a failure exits 1 with {error} JSON", async () => {
        m = mockFetch();
        const { stdout, code } = await runZbs(["send", PHONE, "1", "{}", "--dev", "--rsa"]);
        assert.equal(code, 1);
        assert.match(JSON.parse(stdout).error, /Pick one/);
        assert.equal(m.calls.length, 0);
    });

    it("a Zalo error exits 1 with the explained message", async () => {
        m = mockFetch(() => ({ json: { error: -144, message: "Daily quota exceeded" } }));
        const { stdout, code } = await runZbs(["send", PHONE, "1", "{}"]);
        assert.equal(code, 1);
        assert.match(JSON.parse(stdout).error, /-144.*daily quota/);
    });

    it("template list --status --mine --limit maps to the documented query", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: [], metadata: { total: 0 } } }));
        const { code } = await runZbs(["template", "list", "--status", "pending", "--mine", "--limit", "20"]);
        assert.equal(code, 0);
        assert.deepEqual(queryOf(m.calls[0]), { offset: "0", limit: "20", status: "2", filterPreset: "1" });
    });

    it("template create checks the JSON and sends nothing when it breaks a rule", async () => {
        m = mockFetch();
        const bad = JSON.stringify({ template_name: "x", template_type: 9, tag: 1, layout: {} });
        const { stdout, code } = await runZbs(["template", "create", bad]);
        assert.equal(code, 1);
        assert.match(JSON.parse(stdout).error, /template_name must be 10-60/);
        assert.equal(m.calls.length, 0);
    });

    it("template update sends template_id from the argument; --no-check skips the local rules", async () => {
        m = mockFetch();
        const { code } = await runZbs([
            "template",
            "update",
            "777",
            '{"template_name":"x"}',
            "--no-check",
            "--tracking-id",
            "t",
        ]);
        assert.equal(code, 0);
        assert.deepEqual(bodyOf(m.calls[0]), { template_name: "x", template_id: "777", tracking_id: "t" });
    });

    it("template rating --from date --to ms", async () => {
        m = mockFetch(() => ({ json: { error: 0, data: { total: 0, data: [] } } }));
        await runZbs(["template", "rating", "1", "--from", "2026-11-01T00:00:00Z", "--to", "1800000000000"]);
        assert.deepEqual(queryOf(m.calls[0]), {
            template_id: "1",
            from_time: String(Date.UTC(2026, 10, 1)),
            to_time: "1800000000000",
            offset: "0",
            limit: "100",
        });
    });

    it("journey send needs --token and sends it as the journey_token header", async () => {
        m = mockFetch();
        const { code } = await runZbs(["journey", "send", PHONE, "217489", "{}", "--token", "jt"]);
        assert.equal(code, 0);
        assert.equal(m.calls[0].init.headers.journey_token, "jt");
    });

    it("uid, status, quota, quality, rsa-key and journey check run their endpoint", async () => {
        m = mockFetch();
        await runZbs(["uid", USER, "433555", '{"ky":"1"}']);
        await runZbs(["status", "msg1"]);
        await runZbs(["quota"]);
        await runZbs(["quality"]);
        await runZbs(["rsa-key", "get"]);
        await runZbs(["rsa-key", "create"]);
        await runZbs(["journey", "token", "0901234567", "--type", "token_logistics_30"]);
        await runZbs(["journey", "check", "jt"]);
        await runZbs(["template", "detail", "5"]);
        await runZbs(["template", "sample", "5"]);
        await runZbs(["template", "quick-reply", "5", "--from", "1", "--to", "2"]);
        assert.deepEqual(m.calls.map(pathOf), [
            "https://openapi.zalo.me/v3.0/oa/message/template",
            `${ZBS}/message/status`,
            `${ZBS}/message/quota`,
            `${ZBS}/quality`,
            `${ZBS}/rsa/key/get`,
            `${ZBS}/rsa/key/gen`,
            `${ZBS}/journey/get-token`,
            `${ZBS}/journey/check-token`,
            `${ZBS}/template/info/v2`,
            `${ZBS}/template/sample-data`,
            `${ZBS}/response/get`,
        ]);
    });

    it("human output of send names the message id and quota", async () => {
        m = mockFetch(() => ({
            json: { error: 0, data: { msg_id: "a4d0", quota: { dailyQuota: "500", remainingQuota: "499" } } },
        }));
        const { stdout, code } = await runZbs(["send", PHONE, "1", "{}", "--tracking-id", "t9"], { jsonMode: false });
        assert.equal(code, 0);
        assert.match(stdout, /msg_id a4d0/);
        assert.match(stdout, /tracking_id: t9/);
        assert.match(stdout, /499 of 500 left/);
    });

    it("readJsonArg: inline JSON, a file, and clear errors", () => {
        assert.deepEqual(readJsonArg('{"a":1}'), { a: 1 });
        assert.throws(() => readJsonArg("{a:1}", "template_data"), /template_data \(inline\) is not valid JSON/);
        assert.throws(() => readJsonArg("no-such-file.json", "template"), /no such file/);
    });
});

// ─── Image bytes for the upload checks ──────────────────────────────

function pngBytes(w, h) {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
}

function jpegBytes(w, h) {
    // SOI, an APP0 segment, then SOF0 with height and width
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const sof = Buffer.alloc(19);
    sof[0] = 0xff;
    sof[1] = 0xc0;
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(h, 5);
    sof.writeUInt16BE(w, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}
