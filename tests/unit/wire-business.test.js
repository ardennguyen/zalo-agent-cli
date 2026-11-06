/**
 * The business area on the wire (design 3.1 and 3.3, package PRF): saved bank accounts, the zBusiness catalog and its
 * product photo upload, quick messages and auto-reply rules, src/zalo/api/business.js on one logged-in fake.
 *
 * Each case has two parts: (1) our record against its reviewed golden record; (2) the error answers, each checked
 * against a literal `{message, code}`. The Web behavior is also asserted outright.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { FAKE, T0, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { businessMethods, PRODUCT_PHOTO, bankHolderName, ruleUids } from "../../src/zalo/api/business.js";

const AREA = "business";
const CATALOG = "3000000000000000001";
const PRODUCT = "4000000000000000001";
const PRODUCT2 = "4000000000000000002";
const USER = "1000000000000000002";
/** The fake login's "my documents" thread (tests/unit/fake-zalo-session.js `send2me_id`). */
const SEND2ME = "1000000000000000001";
const PHOTO_URL = "https://photo.zalo.invalid/p/normal.jpg";

const IMAGE_BYTES = Buffer.from("fake-jpeg-bytes-for-a-product-photo-0123456789");
const IMAGE_PATH = join(SANDBOX_HOME, "product.jpg");

/** What Zalo answers an uploaded product photo with. */
const UPLOADED = Object.freeze({
    photoId: "5000000000000000001",
    thumbUrl: "https://photo.zalo.invalid/p/thumb.jpg",
    normalUrl: PHOTO_URL,
    hdUrl: "https://photo.zalo.invalid/p/hd.jpg",
});

/** The answers every method is run against for the error part, and what each must throw. */
const ERROR_ANSWERS = [
    {
        label: "an outer error",
        error: { outer: { error_code: 102, error_message: "outer failure" } },
        expected: { message: "outer failure", code: 102 },
    },
    {
        label: "an inner error",
        error: { inner: { error_code: 114, error_message: "invalid params" } },
        expected: { message: "invalid params", code: 114 },
    },
    { label: "HTTP 500", error: { status: 500 }, expected: { message: "HTTP 500", code: null } },
    {
        label: "an undecryptable data",
        error: { undecryptable: true },
        expected: { message: "Failed to parse response data", code: null },
    },
];

describe("wire: business (src/zalo/api/business.js)", () => {
    let wire;
    before(async () => {
        assertSandboxed(CONFIG_DIR);
        writeFileSync(IMAGE_PATH, IMAGE_BYTES);
        wire = await openWire({
            zaloOptions: { imageMetadataGetter: async () => ({ width: 300, height: 200, size: IMAGE_BYTES.length }) },
        });
        // zca-js writes an empty Cookie header for an empty jar and fetch writes none: give every host a cookie.
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => wire?.close());

    /**
     * Run one case and check it against its golden record.
     *
     * @param {string} name - the case (golden entry and `case` of its rows)
     * @param {string} method
     * @param {unknown[]|Function} args - a function gets a fresh array per side (a method may change its payload)
     * @param {object} fixture
     */
    async function check(name, method, args, fixture) {
        const rec = await wire.run(method, args, fixture);
        await expectGolden(AREA, name, rec.own);
        return rec;
    }

    /** `check` for a case that must succeed. */
    async function ok(name, method, args, fixture) {
        const rec = await check(name, method, args, fixture);
        assert.equal(rec.own.error, null, `${name}: our side threw ${JSON.stringify(rec.own.error)}`);
        return rec;
    }

    describe("bank accounts", () => {
        it("getListBank: GET {zimsg}/api/transfer/conf with no params", async () => {
            const rec = await ok("bank-directory", "getListBank", [], { reply: { banks: [{ bin: 970400 }] } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, "zimsg");
            assert.equal(req.path, "/api/transfer/conf");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.deepEqual(rec.own.result, { banks: [{ bin: 970400 }] });
        });

        it("getListBankAccount: GET {page, limit}, the reply as it is", async () => {
            const reply = { hasMore: true, total: 3, myBanks: [{ account_id: 42, default: false }] };
            const rec = await ok("bank-accounts", "getListBankAccount", [1, 5], { reply });
            assert.equal(rec.own.requests[0].path, "/api/transfer/list");
            assert.deepEqual(rec.own.requests[0].params, { page: 1, limit: 5 });
            assert.deepEqual(rec.own.result, reply);
        });

        it("getListBankAccount: defaults page 0, limit 20; the last page", async () => {
            const reply = { hasMore: false, total: 0, myBanks: [] };
            const rec = await ok("bank-accounts-default", "getListBankAccount", [], { reply });
            assert.deepEqual(rec.own.requests[0].params, { page: 0, limit: 20 });
            assert.deepEqual(rec.own.result, reply);
        });

        it("getListBankAccount: a page below 0 and a limit below 1 are clamped as the Web clamps them", async () => {
            const rec = await ok("bank-accounts-clamp", "getListBankAccount", [-1, 0], { reply: { myBanks: [] } });
            assert.deepEqual(rec.own.requests[0].params, { page: 0, limit: 1 });
        });

        it("createBankAccount: POST {bin, bank_number, holder_name (upper-case ASCII), language}", async () => {
            const payload = { binBank: 970448, numAccBank: "123456789", nameAccBank: "Nguyễn Văn Đức-Test" };
            const rec = await ok("bank-create", "createBankAccount", [payload], { reply: { account_id: 42 } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/transfer/create");
            assert.deepEqual(req.params, {
                bin: 970448,
                bank_number: "123456789",
                holder_name: "NGUYEN VAN DUC TEST",
                language: "vi",
            });
        });

        it("createBankAccount: a holder name under 5 characters is not sent", async () => {
            const payload = { binBank: 970448, numAccBank: "1", nameAccBank: "Ab" };
            const rec = await ok("bank-create-short-name", "createBankAccount", [payload], { reply: {} });
            assert.equal("holder_name" in rec.own.requests[0].params, false);
        });

        it("updateBankAccount: POST with the account id first", async () => {
            const payload = { accountId: 42, binBank: 970436, numAccBank: "987654321", nameAccBank: "New Holder" };
            const rec = await ok("bank-update", "updateBankAccount", [payload], { reply: {} });
            assert.equal(rec.own.requests[0].path, "/api/transfer/update");
            assert.deepEqual(rec.own.requests[0].paramsOrder, [
                "account_id",
                "bin",
                "bank_number",
                "holder_name",
                "language",
            ]);
            assert.equal(rec.own.requests[0].params.account_id, 42);
        });

        it("deleteBankAccount: POST {account_id, is_default, language}", async () => {
            const rec = await ok("bank-delete", "deleteBankAccount", [{ accountId: 42, isDefault: true }], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].method, "POST");
            assert.deepEqual(rec.own.requests[0].params, { account_id: 42, is_default: true, language: "vi" });
        });
    });

    describe("catalog", () => {
        it("getCatalogList: POST {version_list_catalog 0, limit, last_product_id -1, page}", async () => {
            const rec = await ok("catalog-list", "getCatalogList", [{ limit: 10, page: 1 }], { reply: { items: [] } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.service, "catalog");
            assert.equal(req.path, "/api/prodcatalog/catalog/list");
            assert.deepEqual(req.params, { version_list_catalog: 0, limit: 10, last_product_id: -1, page: 1 });
        });

        it("getCatalogList: no payload, the defaults", async () => {
            const rec = await ok("catalog-list-default", "getCatalogList", [], { reply: { items: [] } });
            assert.deepEqual(rec.own.requests[0].params, {
                version_list_catalog: 0,
                limit: 20,
                last_product_id: -1,
                page: 0,
            });
        });

        it("createCatalog / updateCatalog / deleteCatalog", async () => {
            let rec = await ok("catalog-create", "createCatalog", ["Shop"], { reply: { id: CATALOG } });
            assert.deepEqual(rec.own.requests[0].params, { catalog_name: "Shop", catalog_photo: "" });
            rec = await ok("catalog-update", "updateCatalog", [{ catalogId: CATALOG, catalogName: "Renamed" }], {
                reply: {},
            });
            assert.deepEqual(rec.own.requests[0].params, {
                catalog_id: CATALOG,
                catalog_name: "Renamed",
                catalog_photo: "",
            });
            rec = await ok("catalog-delete", "deleteCatalog", [CATALOG], { reply: {} });
            assert.equal(rec.own.requests[0].path, "/api/prodcatalog/catalog/delete");
            assert.deepEqual(rec.own.requests[0].params, { catalog_id: CATALOG });
        });

        it("getProductCatalogList: POST with the defaults filled", async () => {
            const rec = await ok("product-list", "getProductCatalogList", [{ catalogId: CATALOG, page: 2 }], {
                reply: { items: [] },
            });
            assert.deepEqual(rec.own.requests[0].params, {
                catalog_id: CATALOG,
                limit: 100,
                version_catalog: 0,
                last_product_id: -1,
                page: 2,
            });
        });

        it("createProductCatalog: the photo URLs, the dong, and the session clock as create_time", async () => {
            const payload = () => [
                {
                    catalogId: CATALOG,
                    productName: "Tea",
                    price: "25000",
                    description: "green",
                    product_photos: [PHOTO_URL],
                },
            ];
            const rec = await ok("product-create", "createProductCatalog", payload, { reply: { id: PRODUCT } });
            assert.deepEqual(rec.own.requests[0].params, {
                product_name: "Tea",
                price: "25000",
                description: "green",
                product_photos: [PHOTO_URL],
                catalog_id: CATALOG,
                currency_unit: "₫",
                create_time: T0,
            });
        });

        it("createProductCatalog: no photos is an empty list", async () => {
            const payload = () => [{ catalogId: CATALOG, productName: "Tea", price: "1", description: "" }];
            const rec = await ok("product-create-no-photos", "createProductCatalog", payload, { reply: {} });
            assert.deepEqual(rec.own.requests[0].params.product_photos, []);
        });

        it("createProductCatalog: more than 5 photos is refused before any request", async () => {
            const photos = Array.from({ length: 6 }, (_, i) => `https://photo.zalo.invalid/p/${i}.jpg`);
            const payload = () => [
                { catalogId: CATALOG, productName: "Tea", price: "1", description: "", product_photos: [...photos] },
            ];
            const rec = await check("product-too-many-photos", "createProductCatalog", payload, { reply: {} });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Maximum 5 media files are allowed", code: null });
        });

        it("createProductCatalog: files that would pass 5 photos are refused before any upload", async () => {
            // Red if the files are uploaded first and counted after: 6 uploads, then the refusal.
            for (const [urls, files] of [
                [0, 6],
                [3, 3],
            ]) {
                const rec = await wire.run(
                    "createProductCatalog",
                    () => [
                        {
                            catalogId: CATALOG,
                            productName: "Tea",
                            price: "1",
                            description: "",
                            product_photos: Array.from({ length: urls }, (_, i) => `${PHOTO_URL}?${i}`),
                            files: Array.from({ length: files }, () => IMAGE_PATH),
                        },
                    ],
                    { reply: UPLOADED },
                );
                assert.deepEqual(rec.own.requests, [], `${urls} URLs + ${files} files: nothing sent`);
                assert.deepEqual(rec.own.error, { message: "Maximum 5 media files are allowed", code: null });
            }
        });

        it("updateProductCatalog: product_id first, the caller's create_time kept", async () => {
            const payload = () => [
                {
                    catalogId: CATALOG,
                    productId: PRODUCT,
                    productName: "Tea",
                    price: "26000",
                    description: "green",
                    createTime: T0 - 1000,
                    product_photos: [PHOTO_URL],
                },
            ];
            const rec = await ok("product-update", "updateProductCatalog", payload, { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/prodcatalog/product/update");
            assert.equal(req.paramsOrder[0], "product_id");
            assert.equal(req.params.create_time, T0 - 1000);
        });

        it("deleteProductCatalog: POST {product_ids, catalog_id}; one id becomes a list", async () => {
            let rec = await ok(
                "product-delete",
                "deleteProductCatalog",
                () => [{ catalogId: CATALOG, productIds: [PRODUCT, PRODUCT2] }],
                { reply: {} },
            );
            assert.equal(rec.own.requests[0].path, "/api/prodcatalog/product/mdelete");
            assert.deepEqual(rec.own.requests[0].params, { product_ids: [PRODUCT, PRODUCT2], catalog_id: CATALOG });
            rec = await ok(
                "product-delete-one",
                "deleteProductCatalog",
                () => [{ catalogId: CATALOG, productIds: PRODUCT }],
                {
                    reply: {},
                },
            );
            assert.deepEqual(rec.own.requests[0].params.product_ids, [PRODUCT]);
        });

        it("uploadProductPhoto: one multipart chunk to {file}/api/product/upload/photo", async () => {
            const rec = await ok("product-photo", "uploadProductPhoto", [{ file: IMAGE_PATH }], { reply: UPLOADED });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.service, "file");
            assert.equal(req.path, "/api/product/upload/photo");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            // Red if the chunk's fields moved, the clock were not the session's, or toid lost the "my documents" thread.
            assert.deepEqual(req.params, {
                totalChunk: 1,
                fileName: `Base64_Img_Picker_${T0}.jpg`,
                clientId: T0,
                totalSize: IMAGE_BYTES.length,
                imei: FAKE.imei,
                chunkId: 1,
                toid: SEND2ME,
                featureId: 1,
            });
            assert.deepEqual(
                { name: req.parts[0].name, filename: req.parts[0].filename, type: req.parts[0].type },
                { name: "chunkContent", filename: "undefined", type: "application/octet-stream" },
            );
            assert.equal(req.parts[0].size, IMAGE_BYTES.length);
            assert.deepEqual(rec.own.result, UPLOADED);
        });

        it("uploadProductPhoto is marked not verified until a live run (no Web method shows its fields)", () => {
            assert.equal(PRODUCT_PHOTO.verified, false);
        });

        it("registerCatalog: enable 1 / 0", async () => {
            let rec = await ok("catalog-register-on", "registerCatalog", [true], { reply: "" });
            assert.equal(rec.own.requests[0].path, "/api/prodcatalog/catalog/register");
            assert.deepEqual(rec.own.requests[0].params, { enable: 1 });
            rec = await ok("catalog-register-off", "registerCatalog", [false], { reply: "" });
            assert.deepEqual(rec.own.requests[0].params, { enable: 0 });
        });
    });

    describe("quick messages", () => {
        it("getQuickMessageList: GET {version 0, lang 0, imei}", async () => {
            const rec = await ok("quick-list", "getQuickMessageList", [], { reply: { items: [] } });
            assert.equal(rec.own.requests[0].service, "quick_message");
            assert.deepEqual(rec.own.requests[0].params, { version: 0, lang: 0, imei: FAKE.imei });
        });

        it("addQuickMessage: GET {keyword, message {title, params ''}, type 0, imei}", async () => {
            const rec = await ok("quick-add", "addQuickMessage", [{ keyword: "hi", title: "Hello there" }], {
                reply: { item: { id: 7 } },
            });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/quickmessage/create");
            assert.deepEqual(req.params, {
                keyword: "hi",
                message: { title: "Hello there", params: "" },
                type: 0,
                imei: FAKE.imei,
            });
        });

        it("addQuickMessage with a photo: uploads it, then sends it as media in the Web's key order", async () => {
            const rec = await ok(
                "quick-add-media",
                "addQuickMessage",
                [{ keyword: "pic", title: "A photo", media: IMAGE_PATH }],
                {
                    replies: {
                        "/api/product/upload/photo": { data: UPLOADED },
                        "/api/quickmessage/create": { data: {} },
                    },
                },
            );
            assert.deepEqual(
                rec.own.requests.map((r) => r.path),
                ["/api/product/upload/photo", "/api/quickmessage/create"],
            );
            const params = rec.own.requests[1].params;
            assert.deepEqual(rec.own.requests[1].paramsOrder, ["keyword", "message", "media", "type", "imei"]);
            assert.equal(params.type, 1);
            assert.deepEqual(params.media.items[0], {
                type: 0,
                photoId: UPLOADED.photoId,
                title: "",
                width: "",
                height: "",
                previewThumb: UPLOADED.thumbUrl,
                rawUrl: UPLOADED.normalUrl,
                thumbUrl: UPLOADED.thumbUrl,
                normalUrl: UPLOADED.normalUrl,
                hdUrl: UPLOADED.hdUrl,
            });
        });

        it("updateQuickMessage: GET {itemId, keyword, message, type}, no imei", async () => {
            const rec = await ok("quick-update", "updateQuickMessage", [{ keyword: "hi", title: "Hi again" }, 7], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].path, "/api/quickmessage/update");
            assert.deepEqual(rec.own.requests[0].params, {
                itemId: 7,
                keyword: "hi",
                message: { title: "Hi again", params: "" },
                type: 0,
            });
        });

        it("updateQuickMessage with a photo: uploads it, then sends media before type, in the Web's order", async () => {
            const rec = await ok(
                "quick-update-media",
                "updateQuickMessage",
                [{ keyword: "pic", title: "A photo", media: IMAGE_PATH }, 7],
                {
                    replies: {
                        "/api/product/upload/photo": { data: UPLOADED },
                        "/api/quickmessage/update": { data: {} },
                    },
                },
            );
            assert.deepEqual(
                rec.own.requests.map((r) => r.path),
                ["/api/product/upload/photo", "/api/quickmessage/update"],
            );
            const update = rec.own.requests[1];
            // Red if media moves after type (zca-js's order): Web updateQuickReplyItem writes media first.
            assert.deepEqual(update.paramsOrder, ["itemId", "keyword", "message", "media", "type"]);
            assert.equal(update.params.type, 1);
            assert.equal(update.params.media.items[0].photoId, UPLOADED.photoId);
            assert.equal(update.params.media.items[0].normalUrl, UPLOADED.normalUrl);
        });

        it("removeQuickMessage: GET {itemIds}; one id becomes a list", async () => {
            let rec = await ok("quick-remove", "removeQuickMessage", [[7, 8]], { reply: {} });
            // GET, as Web's deleteQuickReplyItem (@11694122) sends it (spec-sweep 1.3 read it as post).
            assert.equal(rec.own.requests[0].method, "GET");
            assert.deepEqual(rec.own.requests[0].params, { itemIds: [7, 8] });
            rec = await ok("quick-remove-one", "removeQuickMessage", [7], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params, { itemIds: [7] });
        });
    });

    describe("auto-reply", () => {
        const WINDOW = { startTime: T0, endTime: T0 + 86_400_000 };

        it("getAutoReplyList: GET {version 0, cliLang}", async () => {
            const rec = await ok("auto-reply-list", "getAutoReplyList", [], { reply: { item: [] } });
            assert.equal(rec.own.requests[0].service, "auto_reply");
            assert.deepEqual(rec.own.requests[0].params, { version: 0, cliLang: "vi" });
        });

        it("createAutoReply: POST with the params in the query and no body; daily; no uids for scope 0", async () => {
            const payload = { content: "away", isEnable: true, ...WINDOW, scope: 0, uids: [USER] };
            const rec = await ok("auto-reply-create", "createAutoReply", [payload], { reply: { item: { id: 9 } } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/autoreply/create");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.equal(req.form, null);
            assert.equal(req.body, null);
            assert.deepEqual(req.params, {
                cliLang: "vi",
                enable: true,
                content: "away",
                startTime: T0,
                endTime: T0 + 86_400_000,
                recurrence: ["RRULE:FREQ=DAILY;"],
                scope: 0,
                uids: [],
            });
        });

        it("createAutoReply: scope 2 keeps the chosen uids", async () => {
            const payload = { content: "away", isEnable: false, ...WINDOW, scope: 2, uids: USER };
            const rec = await ok("auto-reply-create-chosen", "createAutoReply", [payload], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params.uids, [USER]);
        });

        it("createAutoReply: scope 2 with no uids sends an empty list, never [null] (zca-js sent [null])", async () => {
            const payload = { content: "away", isEnable: true, ...WINDOW, scope: 2 };
            const rec = await wire.run("createAutoReply", [payload], { reply: {} });
            assert.equal(rec.own.error, null);
            assert.deepEqual(rec.own.requests[0].params.uids, []);
            assert.deepEqual(ruleUids(3, null), []);
            assert.deepEqual(ruleUids(2, [USER, null]), [USER]);
            assert.deepEqual(ruleUids(0, [USER]), []);
        });

        it("updateAutoReply: the id after cliLang, params in the query", async () => {
            const payload = { id: 9, content: "back soon", isEnable: true, ...WINDOW, scope: 3, uids: [USER] };
            const rec = await ok("auto-reply-update", "updateAutoReply", [payload], { reply: {} });
            assert.deepEqual(rec.own.requests[0].paramsOrder.slice(0, 2), ["cliLang", "id"]);
            assert.deepEqual(rec.own.requests[0].params.uids, [USER]);
        });

        it("deleteAutoReply: {cliLang, id} in the query", async () => {
            const rec = await ok("auto-reply-delete", "deleteAutoReply", [9], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params, { cliLang: "vi", id: 9 });
            assert.deepEqual(rec.own.requests[0].queryOrder, ["zpw_ver", "zpw_type", "params"]);
        });
    });

    it("createProductCatalog uploads the files it is given first (zca-js never did: it uploaded only for an empty list)", async () => {
        const fake = wire.fake;
        fake.clearRoutes();
        fake.routeAnswer("/api/product/upload/photo", { data: UPLOADED });
        fake.routeAnswer("/api/prodcatalog/product/create", { data: { id: PRODUCT } });
        const from = fake.requests.length;
        try {
            await wire.own.createProductCatalog({
                catalogId: CATALOG,
                productName: "Tea",
                price: "1",
                description: "",
                files: [IMAGE_PATH],
            });
        } finally {
            fake.clearRoutes();
        }
        const sent = fake.requests.slice(from);
        assert.deepEqual(
            sent.map((r) => r.path),
            ["/api/product/upload/photo", "/api/prodcatalog/product/create"],
        );
        assert.deepEqual(sent[1].params.product_photos, [PHOTO_URL]);
    });

    it("bankHolderName: upper-case ASCII, diacritics and đ folded, other runs one space, under 5 left out", () => {
        assert.equal(bankHolderName("  trần thị  đào "), "TRAN THI DAO");
        assert.equal(bankHolderName("Lê_Văn.An"), "LE VAN AN");
        assert.equal(bankHolderName("An"), undefined);
        assert.equal(bankHolderName(""), undefined);
        assert.equal(bankHolderName(undefined), undefined);
    });

    describe("error answers", () => {
        const CALLS = [
            ["getListBank", []],
            ["getListBankAccount", [0, 20]],
            ["createBankAccount", [{ binBank: 970448, numAccBank: "1", nameAccBank: "Test Holder" }]],
            ["updateBankAccount", [{ accountId: 42, binBank: 970448, numAccBank: "1", nameAccBank: "Test Holder" }]],
            ["deleteBankAccount", [{ accountId: 42, isDefault: false }]],
            ["getCatalogList", [{}]],
            ["createCatalog", ["Shop"]],
            ["updateCatalog", [{ catalogId: CATALOG, catalogName: "R" }]],
            ["deleteCatalog", [CATALOG]],
            ["getProductCatalogList", [{ catalogId: CATALOG }]],
            ["createProductCatalog", [{ catalogId: CATALOG, productName: "T", price: "1", description: "" }]],
            [
                "updateProductCatalog",
                [
                    {
                        catalogId: CATALOG,
                        productId: PRODUCT,
                        productName: "T",
                        price: "1",
                        description: "",
                        createTime: T0,
                    },
                ],
            ],
            ["deleteProductCatalog", [{ catalogId: CATALOG, productIds: [PRODUCT] }]],
            ["uploadProductPhoto", [{ file: IMAGE_PATH }]],
            ["registerCatalog", [true]],
            ["getQuickMessageList", []],
            ["addQuickMessage", [{ keyword: "k", title: "t" }]],
            ["updateQuickMessage", [{ keyword: "k", title: "t" }, 7]],
            ["removeQuickMessage", [[7]]],
            ["getAutoReplyList", []],
            ["createAutoReply", [{ content: "c", isEnable: true, startTime: T0, endTime: T0, scope: 0 }]],
            ["updateAutoReply", [{ id: 9, content: "c", isEnable: true, startTime: T0, endTime: T0, scope: 0 }]],
            ["deleteAutoReply", [9]],
        ];
        for (const [method, args] of CALLS) {
            it(`${method}: same code, same text where zca-js has it`, async () => {
                for (const answer of ERROR_ANSWERS) {
                    // A fresh copy per side: zca-js writes into some payloads.
                    const rec = await wire.run(method, () => structuredClone(args), { error: answer.error });
                    assert.deepEqual(rec.own.error, answer.expected, `${method}, ${answer.label}`);
                }
            });
        }
    });

    it("the area defines exactly the methods this file covers", () => {
        // Red if a method was added to the area without a case here, or one covered here was removed.
        assert.deepEqual(
            Object.keys(businessMethods({})).sort(),
            [
                "addQuickMessage",
                "createAutoReply",
                "createBankAccount",
                "createCatalog",
                "createProductCatalog",
                "deleteAutoReply",
                "deleteBankAccount",
                "deleteCatalog",
                "deleteProductCatalog",
                "getAutoReplyList",
                "getCatalogList",
                "getListBank",
                "getListBankAccount",
                "getProductCatalogList",
                "getQuickMessageList",
                "registerCatalog",
                "removeQuickMessage",
                "updateAutoReply",
                "updateBankAccount",
                "updateCatalog",
                "updateProductCatalog",
                "updateQuickMessage",
                "uploadProductPhoto",
            ].sort(),
        );
    });
});
