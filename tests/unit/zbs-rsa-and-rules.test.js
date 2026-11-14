/**
 * src/core/zbs/rsa.js (RSA/ECB/OAEPWITHSHA-256ANDMGF1PADDING, Base64, per Zalo's ZBS "API Gửi tin với hệ mã hóa
 * RSA") and src/core/zbs/template-check.js (the create/edit template rules of Zalo's ZBS docs), offline.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { encryptTemplateData, maxPlaintextBytes, parsePublicKey, rsaEncrypt } from "../../src/core/zbs/rsa.js";
import { BIN_CODES, checkTemplate } from "../../src/core/zbs/template-check.js";
import { imageSize } from "../../src/core/zbs/image.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const PEM = publicKey.export({ type: "spki", format: "pem" });

/** RFC 8017 OAEP decode with a chosen MGF1 digest (what a Java SunJCE decrypt does with MGF1-SHA1). */
function oaepDecrypt(b64, mgf1Hash) {
    const em = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(b64, "base64"));
    const hLen = 32;
    const mgf1 = (seed, len) => {
        const out = [];
        for (let i = 0; Buffer.concat(out).length < len; i++) {
            const c = Buffer.alloc(4);
            c.writeUInt32BE(i);
            out.push(createHash(mgf1Hash).update(seed).update(c).digest());
        }
        return Buffer.concat(out).subarray(0, len);
    };
    assert.equal(em[0], 0);
    const maskedSeed = em.subarray(1, 1 + hLen);
    const maskedDb = em.subarray(1 + hLen);
    const seed = Buffer.from(maskedSeed.map((b, i) => b ^ mgf1(maskedDb, hLen)[i]));
    const db = Buffer.from(maskedDb.map((b, i) => b ^ mgf1(seed, maskedDb.length)[i]));
    assert.deepEqual(db.subarray(0, hLen), createHash("sha256").update(Buffer.alloc(0)).digest());
    const one = db.indexOf(1, hLen);
    return db.subarray(one + 1).toString("utf8");
}

describe("RSA encryption for the RSA send", () => {
    it("reads the docs' Base64 SPKI key and PEM; refuses anything else", () => {
        assert.equal(parsePublicKey(B64).asymmetricKeyType, "rsa");
        assert.equal(parsePublicKey(PEM).asymmetricKeyType, "rsa");
        assert.equal(parsePublicKey(`${B64.slice(0, 40)}\n${B64.slice(40)}`).asymmetricKeyType, "rsa");
        assert.throws(() => parsePublicKey("e6fa968f027"), /Not an RSA public key/);
        const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" });
        assert.throws(() => parsePublicKey(ec), /not RSA/);
    });

    it("OAEP SHA-256 with MGF1-SHA-256 decrypts with node's own OAEP-SHA-256", () => {
        const c = rsaEncrypt("84901234567", parsePublicKey(B64), { mgf1Hash: "sha256" });
        const plain = privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(c, "base64"));
        assert.equal(plain.toString(), "84901234567");
        assert.equal(oaepDecrypt(c, "sha256"), "84901234567");
    });

    it("default MGF1-SHA-1 (Java's default for that cipher name) round-trips through an RFC 8017 decoder", () => {
        const c = rsaEncrypt("Sample text, có dấu", parsePublicKey(B64));
        assert.equal(oaepDecrypt(c, "sha1"), "Sample text, có dấu");
        assert.equal(Buffer.from(c, "base64").length, 256);
        // a fresh seed each time
        assert.notEqual(rsaEncrypt("x", parsePublicKey(B64)), rsaEncrypt("x", parsePublicKey(B64)));
    });

    it("refuses a value longer than one block, and an unknown MGF1 digest", () => {
        const key = parsePublicKey(B64);
        assert.equal(maxPlaintextBytes(key), 256 - 66);
        assert.ok(rsaEncrypt("a".repeat(190), key));
        assert.throws(() => rsaEncrypt("a".repeat(191), key), /too long/);
        assert.throws(() => rsaEncrypt("a", key, { mgf1Hash: "md5" }), /MGF1/);
    });

    it("encrypts every template_data value, keeping the keys", () => {
        const out = encryptTemplateData({ a: "x", b: 5 }, parsePublicKey(B64), { mgf1Hash: "sha256" });
        assert.deepEqual(Object.keys(out), ["a", "b"]);
        const dec = (s) => privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(s, "base64")).toString();
        assert.equal(dec(out.a), "x");
        assert.equal(dec(out.b), "5");
    });
});

// ─── Template rules ──────────────────────────────────────────────────

const img = (id = "m1") => ({ type: "IMAGE", media_id: id });
const logo = () => ({ LOGO: { light: img(), dark: img("m2") } });
const button = (type = 1, title = "View order") => ({ type, title, content: "https://example.com/" });
const ratingItems = () =>
    [1, 2, 3, 4, 5].map((rate) => ({ rate, title: `Level ${rate}`, thanks: "Thank you", description: "Desc" }));

function base(type, tag, header, body, footer, params = []) {
    return {
        template_name: "A template name",
        template_type: type,
        tag,
        layout: { header: { components: header }, body: { components: body }, footer: { components: footer } },
        params,
        tracking_id: "t1",
    };
}

const custom = () =>
    base(
        1,
        "2",
        [logo()],
        [{ TITLE: { value: "Hello <name>" } }, { PARAGRAPH: { value: "Your order is on its way." } }],
        [{ BUTTONS: { items: [button()] } }],
        [{ name: "name", type: "1", sample_value: "Customer A" }],
    );

describe("template rules (create / edit)", () => {
    it("a valid template of each type passes", () => {
        assert.deepEqual(checkTemplate(custom()), []);
        const otp = base(
            2,
            1,
            [logo()],
            [{ OTP: { value: "<otp>" } }, { PARAGRAPH: { value: "Never share this code with anyone." } }],
            [],
            [{ name: "otp", type: 12, sample_value: "123456" }],
        );
        assert.deepEqual(checkTemplate(otp), []);
        const pay = base(
            3,
            3,
            [logo()],
            [
                { TITLE: { value: "Payment request" } },
                { PAYMENT: { bank_code: "970416", account_name: "SHOP", bank_account: "0123456789", amount: "<amt>" } },
            ],
            [{ BUTTONS: { items: [button(11, "Pay now!")] } }],
            [{ name: "amt", type: 14, sample_value: "100000" }],
        );
        assert.deepEqual(checkTemplate(pay), []);
        const voucher = base(
            4,
            3,
            [{ IMAGES: { items: [img()] } }],
            [
                { TITLE: { value: "A gift for you" } },
                {
                    VOUCHER: {
                        name: "70K off",
                        condition: "Orders over 200K",
                        voucher_code: "ABC123",
                        end_date: "<end>",
                    },
                },
            ],
            [{ BUTTONS: { items: [button(12, "View details")] } }],
            [{ name: "end", type: 11, sample_value: "19/01/2027" }],
        );
        assert.deepEqual(checkTemplate(voucher), []);
        const rating = base(
            5,
            2,
            [logo()],
            [{ TITLE: { value: "Rate our service" } }, { RATING: { option: "five_stars", items: ratingItems() } }],
            [],
        );
        assert.deepEqual(checkTemplate(rating), []);
    });

    it("body fields: name 10-60, type 1-5, tag allowed for the type, note 1-400, tracking_id", () => {
        const t = custom();
        assert.match(checkTemplate({ ...t, template_name: "short" }).join(), /10-60/);
        assert.match(checkTemplate({ ...t, template_name: "x".repeat(61) }).join(), /10-60/);
        assert.match(checkTemplate({ ...t, template_type: 6 }).join(), /template_type must be 1-5/);
        assert.match(checkTemplate({ ...t, template_type: 2, tag: 2 }).join(), /takes tag 1, not 2/);
        assert.match(checkTemplate({ ...t, note: "" }).join(), /note must be 1-400/);
        assert.match(checkTemplate({ ...t, tracking_id: "" }).join(), /tracking_id is required/);
        assert.match(checkTemplate(t, { edit: true }).join(), /template_id is required/);
        assert.deepEqual(checkTemplate("x"), ["the template must be a JSON object"]);
    });

    it("params: declared for every <placeholder>, type 1-15, sample_value within the type's length", () => {
        const t = custom();
        assert.match(checkTemplate({ ...t, params: [] }).join(), /<name> is used in the layout but not declared/);
        assert.match(checkTemplate({ ...t, params: [{ name: "name", type: "18", sample_value: "a" }] }).join(), /1-15/);
        assert.match(
            checkTemplate({ ...t, params: [{ name: "name", type: "1", sample_value: "x".repeat(31) }] }).join(),
            /longer than 30/,
        );
        assert.match(
            checkTemplate({
                ...t,
                params: [
                    { name: "name", type: "1", sample_value: "a" },
                    { name: "name", type: "1", sample_value: "a" },
                ],
            }).join(),
            /declared twice/,
        );
    });

    it("layout per type: header one of LOGO/IMAGES, TITLE once, PARAGRAPH <= 4, wrong components refused", () => {
        const t = custom();
        t.layout.header.components = [logo(), { IMAGES: { items: [img()] } }];
        assert.match(checkTemplate(t).join(), /exactly one of LOGO or IMAGES/);
        const t2 = custom();
        t2.layout.body.components.push(...Array(4).fill({ PARAGRAPH: { value: "More text here." } }));
        assert.match(checkTemplate(t2).join(), /0-4 PARAGRAPH \(it has 5\)/);
        const t3 = custom();
        t3.layout.body.components.push({ OTP: { value: "1234" } });
        assert.match(checkTemplate(t3).join(), /cannot hold OTP/);
        const t4 = custom();
        t4.layout.body.components.shift();
        assert.match(checkTemplate(t4).join(), /1 TITLE \(it has 0\)/);
        const t5 = custom();
        t5.layout.header.components = [{ IMAGES: { items: [img()] } }];
        t5.layout.footer.components = [];
        assert.match(checkTemplate(t5).join(), /IMAGES needs at least 1 button/);
        const pay = custom();
        pay.template_type = 3;
        pay.tag = 1;
        assert.match(checkTemplate(pay).join(), /1 PAYMENT \(it has 0\)/);
    });

    it("components: TITLE 9-65 with <= 4 params, TABLE 2-8 rows, buttons, images, logo", () => {
        const at = (comp) => {
            const t = custom();
            t.layout.body.components = [{ TITLE: { value: "Hello <name>" } }, comp];
            return checkTemplate(t).join("\n");
        };
        const t = custom();
        t.layout.body.components[0] = { TITLE: { value: "<a><b><c><d><e>" } };
        t.params = ["a", "b", "c", "d", "e"].map((name) => ({ name, type: 5, sample_value: "x" }));
        assert.match(checkTemplate(t).join(), /at most 4 params/);
        assert.match(at({ TABLE: { rows: [{ title: "Code", value: "ABC" }] } }), /2-8 rows/);
        assert.match(
            at({
                TABLE: {
                    rows: [
                        { title: "Co", value: "ABC" },
                        { title: "Code", value: "AB", row_type: 9 },
                    ],
                },
            }),
            /title must be 3-36[\s\S]*value must be 3-90[\s\S]*row_type must be 0-5/,
        );
        const b = custom();
        b.layout.footer.components = [{ BUTTONS: { items: [button(6), button(1, "Go"), button(1), button(1)] } }];
        const msg = checkTemplate(b).join("\n");
        assert.match(msg, /type 6 is no longer accepted/);
        assert.match(msg, /title must be 5-30/);
        assert.match(msg, /takes 0-3 buttons \(it has 4\)/);
        const l = custom();
        l.layout.header.components = [{ LOGO: { light: { type: "VIDEO", media_id: "x" }, dark: {} } }];
        assert.match(checkTemplate(l).join(), /light\.type must be "IMAGE"[\s\S]*dark\.media_id is required/);
        const i = custom();
        i.layout.header.components = [{ IMAGES: { items: [img(), img(), img(), img()] } }];
        assert.match(checkTemplate(i).join(), /1-3 images/);
    });

    it("PAYMENT: BIN code from the list, fixed amount 2,000-500,000,000, account text without params", () => {
        const pay = (payment) =>
            base(
                3,
                1,
                [logo()],
                [{ TITLE: { value: "Payment request" } }, { PAYMENT: payment }],
                [{ BUTTONS: { items: [button(11, "Pay now!")] } }],
            );
        assert.equal(BIN_CODES["970436"], "Vietcombank");
        const ok = { bank_code: "970436", account_name: "SHOP", account_number: "0123456789", amount: "1000000" };
        assert.deepEqual(checkTemplate(pay(ok)), []);
        assert.match(checkTemplate(pay({ ...ok, bank_code: "123456" })).join(), /BIN code/);
        assert.match(checkTemplate(pay({ ...ok, amount: "1000" })).join(), /2,000-500,000,000/);
        assert.match(checkTemplate(pay({ ...ok, amount: "600,000,000" })).join(), /2,000-500,000,000/);
        assert.match(checkTemplate(pay({ ...ok, account_name: "<n>" })).join(), /account_name must be fixed text/);
    });

    it("VOUCHER and RATING limits", () => {
        const v = base(
            4,
            1,
            [logo()],
            [
                { TITLE: { value: "A gift for you" } },
                { VOUCHER: { name: "x".repeat(31), condition: "c", voucher_code: "x".repeat(26) } },
            ],
            [{ BUTTONS: { items: [button(12, "View details")] } }],
        );
        const vm = checkTemplate(v).join("\n");
        assert.match(vm, /name must be 1-30/);
        assert.match(vm, /voucher_code must be 1-25/);
        assert.match(vm, /end_date is required/);
        const r = (rating) =>
            checkTemplate(
                base(5, 2, [logo()], [{ TITLE: { value: "Rate our service" } }, { RATING: rating }], []),
            ).join("\n");
        assert.match(r({ option: "ten_stars", items: ratingItems() }), /option must be/);
        assert.match(r({ option: "five_stars", items: ratingItems().slice(0, 4) }), /5 items/);
        assert.match(r({ option: "three_emotions", items: ratingItems() }), /rate must be 1-3/);
        const items = ratingItems();
        items[0].answers = ["a", "b", "c", "d", "e", "f"];
        items[1].description = "";
        assert.match(r({ option: "five_stars", items }), /answers must hold 1-5[\s\S]*description must be 1-200/);
        assert.match(
            r({ rating_type: "nps", option: "five_stars", items: ratingItems() }),
            /rating_type must be "csat"/,
        );
    });
});

describe("image header reader", () => {
    it("reads PNG IHDR and JPEG SOF sizes; null for other bytes", () => {
        const png = Buffer.alloc(24);
        png.writeUInt32BE(0x89504e47, 0);
        png.write("IHDR", 12, "latin1");
        png.writeUInt32BE(400, 16);
        png.writeUInt32BE(96, 20);
        assert.deepEqual(imageSize(png), { format: "png", width: 400, height: 96 });
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0, 0, 0]);
        assert.deepEqual(imageSize(jpg), { format: "jpeg", width: 1280, height: 720 });
        assert.equal(imageSize(Buffer.from("GIF89a")), null);
    });
});
