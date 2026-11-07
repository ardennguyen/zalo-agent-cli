/**
 * Business features of the account: saved bank accounts, the zBusiness catalog (catalogs, products, product photos),
 * quick messages, and auto-reply rules (agent/docs/zca-replace/spec-sweep.md 1.2, "Bank accounts", "Catalog",
 * "Quick messages and auto-reply"; spec-people.md 17 for `getListBankAccount`).
 *
 * Every call is one session request on the ordinary envelope (kernel/endpoint.js), shaped the way Zalo Web 26.11.10
 * shapes it (`1.c72c0957b455ab70b73c.js`, the API module). Where the Web differs from what the engine sent before,
 * the Web wins:
 *
 * - `getListBank`: a GET with the common query only, no `params` (getListBank).
 * - `getListBankAccount`: page and limit clamped as the Web clamps them, `page >= 0`, `limit >= 1`
 *   (getListBankCard).
 * - auto-reply create, update and delete: a POST whose sealed `params` ride in the query, with no body
 *   (createAutoReply, updateAutoReply, deleteAutoReply).
 *
 * `uploadProductPhoto` keeps the one-chunk upload the engine has always sent: Web's quick-message path (featureId
 * 1, `toid` = the account's own "my documents" thread). The Web has no method body for it beside the path (its
 * catalog editor uploads with featureId 2 and no `toid`), so its definition is `verified: false` until a live run.
 * Every id stays a string. Nothing here writes to stdout or logs.
 */
import { readFile } from "node:fs/promises";
import { ZaloApiError } from "../errors.js";
import { sealParams } from "../kernel/http.js";

/** The currency the catalog's products are priced in (Zalo Web's default, Vietnamese dong). */
export const CATALOG_CURRENCY = "₫";

/** Recurrence of an auto-reply rule: every day (Zalo Web's `DefaultRecurrence`). */
export const DAILY = Object.freeze(["RRULE:FREQ=DAILY;"]);

/** Most photos a product may carry. */
const MAX_PRODUCT_PHOTOS = 5;

/**
 * A bank account holder's name the way Zalo stores it: upper-case ASCII letters and digits, diacritics removed,
 * `đ` read as `d`, every other run of characters one space. A name shorter than 5 characters after that is not sent
 * (undefined), as before.
 *
 * @param {string|undefined|null} name
 * @returns {string|undefined}
 */
export function bankHolderName(name) {
    if (!name) return undefined;
    const ascii = String(name).normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toUpperCase();
    const out = ascii
        .split(/[^A-Z0-9]+/)
        .filter(Boolean)
        .join(" ");
    return out.length >= 5 ? out : undefined;
}

// ---------------------------------------------------------------- bank accounts (zimsg)

/** `GET {zimsg}/api/transfer/conf`, no params (getListBank, 15309). */
export const BANK_DIRECTORY = Object.freeze({
    host: "zimsg",
    path: "/api/transfer/conf",
    cmd: 15309,
    method: "get",
    body: () => null,
    reply: "session",
});

/** `GET {zimsg}/api/transfer/list` (getListBankCard, 15298). */
export const BANK_ACCOUNTS = Object.freeze({
    host: "zimsg",
    path: "/api/transfer/list",
    cmd: 15298,
    method: "get",
    body: (a) => ({ page: a.page > 0 ? a.page : 0, limit: a.limit > 1 ? a.limit : 1 }),
    reply: "session",
});

/** `POST {zimsg}/api/transfer/create` (createBankAccount, 15306). */
export const BANK_CREATE = Object.freeze({
    host: "zimsg",
    path: "/api/transfer/create",
    cmd: 15306,
    method: "post",
    body: (a, ctx) => ({
        bin: a.binBank,
        bank_number: a.numAccBank,
        holder_name: bankHolderName(a.nameAccBank),
        language: ctx.language,
    }),
    reply: "session",
});

/** `POST {zimsg}/api/transfer/update` (updateBankAccount, 15307). */
export const BANK_UPDATE = Object.freeze({
    host: "zimsg",
    path: "/api/transfer/update",
    cmd: 15307,
    method: "post",
    body: (a, ctx) => ({
        account_id: a.accountId,
        bin: a.binBank,
        bank_number: a.numAccBank,
        holder_name: bankHolderName(a.nameAccBank),
        language: ctx.language,
    }),
    reply: "session",
});

/** `POST {zimsg}/api/transfer/delete` (deleteBankAccount, 15308). */
export const BANK_DELETE = Object.freeze({
    host: "zimsg",
    path: "/api/transfer/delete",
    cmd: 15308,
    method: "post",
    body: (a, ctx) => ({ account_id: a.accountId, is_default: a.isDefault, language: ctx.language }),
    reply: "session",
});

// ---------------------------------------------------------------- catalog (zBusiness)

/**
 * A catalog call: `POST {catalog}/api/prodcatalog/<path>` with the body as given.
 *
 * @param {string} path - after `/api/prodcatalog`
 * @param {number} cmd - Web's command id
 * @param {(a: object, ctx: object) => object} body
 * @returns {object} an endpoint definition
 */
const catalogCall = (path, cmd, body) =>
    Object.freeze({ host: "catalog", path: `/api/prodcatalog${path}`, cmd, method: "post", body, reply: "session" });

/** getAllCatalog, 12038. */
export const CATALOG_LIST = catalogCall("/catalog/list", 12038, (a) => ({
    version_list_catalog: 0,
    limit: a.limit,
    last_product_id: a.lastProductId,
    page: a.page,
}));

/** createCatalog, 12073. */
export const CATALOG_CREATE = catalogCall("/catalog/create", 12073, (a) => ({
    catalog_name: a.catalogName,
    catalog_photo: "",
}));

/** updateCatalog, 12078. */
export const CATALOG_UPDATE = catalogCall("/catalog/update", 12078, (a) => ({
    catalog_id: a.catalogId,
    catalog_name: a.catalogName,
    catalog_photo: "",
}));

/** deleteCatalog, 12079. */
export const CATALOG_DELETE = catalogCall("/catalog/delete", 12079, (a) => ({ catalog_id: a.catalogId }));

/** getAllProductById, 12039. */
export const PRODUCT_LIST = catalogCall("/product/list", 12039, (a) => ({
    catalog_id: a.catalogId,
    limit: a.limit,
    version_catalog: a.versionCatalog,
    last_product_id: a.lastProductId,
    page: a.page,
}));

/**
 * getProductInfo, 12057: one product by its id, `{product_id}` only. Not verified: the Web's catalog editor and its
 * product card call it, and no live answer has been seen (a zBusiness catalog with a product is needed).
 */
export const PRODUCT_VIEW = Object.freeze({
    ...catalogCall("/product/view", 12057, (a) => ({ product_id: a.productId })),
    verified: false,
});

/** The product fields create and update share, after `product_id` on an update. */
const productFields = (a) => ({
    product_name: a.productName,
    price: a.price,
    description: a.description,
    product_photos: a.photos,
    catalog_id: a.catalogId,
    currency_unit: CATALOG_CURRENCY,
    create_time: a.createTime,
});

/** createProduct, 12040. */
export const PRODUCT_CREATE = catalogCall("/product/create", 12040, (a) => productFields(a));

/** updateProduct, 12041. */
export const PRODUCT_UPDATE = catalogCall("/product/update", 12041, (a) => ({
    product_id: a.productId,
    ...productFields(a),
}));

/** deleteMultiProduct, 12127. */
export const PRODUCT_DELETE = catalogCall("/product/mdelete", 12127, (a) => ({
    product_ids: a.productIds,
    catalog_id: a.catalogId,
}));

/** registerCatalog, 12031. */
export const CATALOG_REGISTER = catalogCall("/catalog/register", 12031, (a) => ({ enable: a.enable ? 1 : 0 }));

/**
 * `POST {file}/api/product/upload/photo`: one chunk, multipart, sealed params in the query (12036). Not verified: the
 * Web's command table names the path (@2511568) but no Web method shows the fields, which are the quick-message
 * upload's (spec-sweep 1.3).
 */
export const PRODUCT_PHOTO = Object.freeze({
    host: "file",
    path: "/api/product/upload/photo",
    cmd: 12036,
    method: "multipart",
    verified: false,
    body: (a, ctx) => ({
        totalChunk: 1,
        fileName: `Base64_Img_Picker_${a.at}.jpg`,
        clientId: a.clientId,
        totalSize: a.size,
        imei: ctx.imei,
        chunkId: 1,
        toid: ctx.loginInfo?.send2me_id,
        featureId: 1,
    }),
    file: (a) => ({
        field: "chunkContent",
        filename: "undefined",
        type: "application/octet-stream",
        bytes: a.bytes,
    }),
    reply: "session",
});

// ---------------------------------------------------------------- quick messages

/** `GET {quick_message}/api/quickmessage/list` (fetchQuickReplyList, 12025). */
export const QUICK_LIST = Object.freeze({
    host: "quick_message",
    path: "/api/quickmessage/list",
    cmd: 12025,
    method: "get",
    body: (_a, ctx) => ({ version: 0, lang: 0, imei: ctx.imei }),
    reply: "session",
});

/** `GET {quick_message}/api/quickmessage/create` (createQuickReplyItem, 12029). */
export const QUICK_CREATE = Object.freeze({
    host: "quick_message",
    path: "/api/quickmessage/create",
    cmd: 12029,
    method: "get",
    body: (a, ctx) => ({
        keyword: a.keyword,
        message: { title: a.title, params: "" },
        media: a.media,
        type: a.media ? 1 : 0,
        imei: ctx.imei,
    }),
    reply: "session",
});

/** `GET {quick_message}/api/quickmessage/update` (updateQuickReplyItem, 12026). */
export const QUICK_UPDATE = Object.freeze({
    host: "quick_message",
    path: "/api/quickmessage/update",
    cmd: 12026,
    method: "get",
    body: (a) => ({
        itemId: a.itemId,
        keyword: a.keyword,
        message: { title: a.title, params: "" },
        media: a.media,
        type: a.media ? 1 : 0,
    }),
    reply: "session",
});

/** `GET {quick_message}/api/quickmessage/delete` (deleteQuickReplyItem, 12032). */
export const QUICK_DELETE = Object.freeze({
    host: "quick_message",
    path: "/api/quickmessage/delete",
    cmd: 12032,
    method: "get",
    body: (a) => ({ itemIds: a.itemIds }),
    reply: "session",
});

// ---------------------------------------------------------------- auto-reply

/** `GET {auto_reply}/api/autoreply/list` (getAutoReplyList, 12048). */
export const AUTO_REPLY_LIST = Object.freeze({
    host: "auto_reply",
    path: "/api/autoreply/list",
    cmd: 12048,
    method: "get",
    body: (_a, ctx) => ({ version: 0, cliLang: ctx.language }),
    reply: "session",
});

/**
 * An auto-reply write: `POST {auto_reply}/api/autoreply/<path>` with the sealed params in the query and no body,
 * as Zalo Web posts it.
 *
 * @param {string} path - after `/api/autoreply`
 * @param {number} cmd - Web's command id
 * @param {(a: object, ctx: object) => object} params - the object sealed into `params`
 * @returns {object} an endpoint definition
 */
const autoReplyWrite = (path, cmd, params) =>
    Object.freeze({
        host: "auto_reply",
        path: `/api/autoreply${path}`,
        cmd,
        method: "post",
        body: () => null,
        query: (a, ctx) => ({ params: sealParams(ctx, params(a, ctx)) }),
        reply: "session",
    });

/** The rule fields create and update share, after `id` on an update. */
const ruleFields = (a) => ({
    enable: a.isEnable,
    content: a.content,
    startTime: a.startTime,
    endTime: a.endTime,
    recurrence: [...DAILY],
    scope: a.scope,
    uids: a.uids,
});

/** createAutoReply, 12049. */
export const AUTO_REPLY_CREATE = autoReplyWrite("/create", 12049, (a, ctx) => ({
    cliLang: ctx.language,
    ...ruleFields(a),
}));

/** updateAutoReply, 12050. */
export const AUTO_REPLY_UPDATE = autoReplyWrite("/update", 12050, (a, ctx) => ({
    cliLang: ctx.language,
    id: a.id,
    ...ruleFields(a),
}));

/** deleteAutoReply, 12051. */
export const AUTO_REPLY_DELETE = autoReplyWrite("/delete", 12051, (a, ctx) => ({ cliLang: ctx.language, id: a.id }));

/**
 * The user ids an auto-reply rule names: only a rule scoped to chosen people (scope 2 or 3) carries them. None given
 * is an empty list, as the Web's createAutoReply/updateAutoReply default it, never a list holding a null.
 *
 * @param {number} scope
 * @param {string|string[]|undefined} uids
 * @returns {string[]}
 */
export function ruleUids(scope, uids) {
    if (scope !== 2 && scope !== 3) return [];
    return [].concat(uids ?? []).filter((u) => u !== undefined && u !== null && u !== "");
}

/**
 * A product photo's bytes and size: a file path (read here, measured by the session's `imageMetadataGetter`) or an
 * attachment `{data, metadata: {totalSize}}`.
 *
 * @param {object} ctx
 * @param {string|{data: Uint8Array, metadata?: {totalSize?: number}}} file
 * @returns {Promise<{bytes: Uint8Array, size: number}>}
 * @throws {ZaloApiError} when a path is given and the session cannot measure images, or measuring fails
 */
async function photoOf(ctx, file) {
    if (typeof file === "string") {
        const measure = ctx.options?.imageMetadataGetter;
        if (typeof measure !== "function") {
            throw new ZaloApiError("Cannot read the image's size: the session has no imageMetadataGetter");
        }
        const got = await measure(file);
        if (!got) throw new ZaloApiError("Failed to get image metadata");
        return { bytes: await readFile(file), size: got.size || 0 };
    }
    return { bytes: file?.data, size: file?.metadata?.totalSize || 0 };
}

/**
 * The business calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function businessMethods(s) {
    /** Upload one photo for the catalog or a quick message; Zalo answers its ids and URLs. */
    const uploadProductPhoto = async (payload) => {
        const photo = await photoOf(s.ctx, payload?.file);
        return s.call(PRODUCT_PHOTO, { ...photo, at: s.now(), clientId: s.nextClientId() });
    };

    /** A quick message's media block for one uploaded photo. */
    const quickMedia = async (file) => {
        const up = await uploadProductPhoto({ file });
        return {
            items: [
                {
                    type: 0,
                    photoId: up.photoId,
                    title: "",
                    width: "",
                    height: "",
                    previewThumb: up.thumbUrl,
                    rawUrl: up.normalUrl || up.hdUrl,
                    thumbUrl: up.thumbUrl,
                    normalUrl: up.normalUrl || up.hdUrl,
                    hdUrl: up.hdUrl || up.normalUrl,
                },
            ],
        };
    };

    /** A product's photo URLs: the ones given, then one per uploaded file; at most 5, counted before any upload. */
    const productPhotos = async (payload) => {
        const photos = [...(payload.product_photos ?? [])];
        const files = payload.files ?? [];
        if (photos.length + files.length > MAX_PRODUCT_PHOTOS) {
            throw new ZaloApiError(`Maximum ${MAX_PRODUCT_PHOTOS} media files are allowed`);
        }
        for (const file of files) {
            const up = await uploadProductPhoto({ file });
            photos.push(up.normalUrl || up.hdUrl);
        }
        return photos;
    };

    return {
        // ------------------------------------------------ bank accounts

        /**
         * The banks Zalo knows (BIN, names, search keywords).
         *
         * @returns {Promise<object>}
         */
        getListBank: () => s.call(BANK_DIRECTORY, {}),

        /**
         * One page of the account's saved bank accounts: `{myBanks, total, hasMore}`.
         *
         * @param {number} [page] - from 0
         * @param {number} [limit] - accounts per page (20)
         * @returns {Promise<object>}
         */
        getListBankAccount: (page = 0, limit = 20) => s.call(BANK_ACCOUNTS, { page, limit }),

        /**
         * Save a bank account.
         *
         * @param {{binBank: number, numAccBank: string, nameAccBank: string}} payload - the bank's BIN, the account
         *   number, the holder's name
         * @returns {Promise<object>}
         */
        createBankAccount: (payload) => s.call(BANK_CREATE, payload),

        /**
         * Change a saved bank account.
         *
         * @param {{accountId: number, binBank: number, numAccBank: string, nameAccBank: string}} payload
         * @returns {Promise<object>}
         */
        updateBankAccount: (payload) => s.call(BANK_UPDATE, payload),

        /**
         * Delete a saved bank account.
         *
         * @param {{accountId: number, isDefault: boolean}} payload - the account and whether it is the default one
         * @returns {Promise<object>}
         */
        deleteBankAccount: (payload) => s.call(BANK_DELETE, payload),

        // ------------------------------------------------ catalog

        /**
         * One page of the account's catalogs.
         *
         * @param {{limit?: number, lastProductId?: number, page?: number}} [payload]
         * @returns {Promise<object>}
         */
        getCatalogList: (payload) =>
            s.call(CATALOG_LIST, {
                limit: payload?.limit ?? 20,
                lastProductId: payload?.lastProductId ?? -1,
                page: payload?.page ?? 0,
            }),

        /**
         * Create a catalog.
         *
         * @param {string} catalogName
         * @returns {Promise<object>}
         */
        createCatalog: (catalogName) => s.call(CATALOG_CREATE, { catalogName }),

        /**
         * Rename a catalog.
         *
         * @param {{catalogId: string, catalogName: string}} payload
         * @returns {Promise<object>}
         */
        updateCatalog: (payload) => s.call(CATALOG_UPDATE, payload),

        /**
         * Delete a catalog.
         *
         * @param {string} catalogId
         * @returns {Promise<object>}
         */
        deleteCatalog: (catalogId) => s.call(CATALOG_DELETE, { catalogId }),

        /**
         * One page of a catalog's products.
         *
         * @param {{catalogId: string, limit?: number, versionCatalog?: number, lastProductId?: number,
         *   page?: number}} payload
         * @returns {Promise<object>}
         */
        getProductCatalogList: (payload) =>
            s.call(PRODUCT_LIST, {
                catalogId: payload.catalogId,
                limit: payload.limit ?? 100,
                versionCatalog: payload.versionCatalog ?? 0,
                lastProductId: payload.lastProductId ?? -1,
                page: payload.page ?? 0,
            }),

        /**
         * One product, by its id (unverified: no live answer seen).
         *
         * @param {string} productId
         * @returns {Promise<object>} Zalo's answer: the product
         * @throws {ZaloApiError} before any request, for a missing id
         */
        getProductInfo: (productId) => {
            if (productId === undefined || productId === null || String(productId) === "") {
                throw new ZaloApiError("Missing productId");
            }
            return s.call(PRODUCT_VIEW, { productId: String(productId) });
        },

        /**
         * Add a product to a catalog.
         *
         * @param {{catalogId: string, productName: string, price: string, description: string,
         *   product_photos?: string[], files?: Array<string|object>}} payload - photo URLs, or files to upload first
         * @returns {Promise<object>}
         */
        createProductCatalog: async (payload) =>
            s.call(PRODUCT_CREATE, { ...payload, photos: await productPhotos(payload), createTime: s.now() }),

        /**
         * Change a product.
         *
         * @param {{catalogId: string, productId: string, productName: string, price: string, description: string,
         *   createTime: number, product_photos?: string[], files?: Array<string|object>}} payload
         * @returns {Promise<object>}
         */
        updateProductCatalog: async (payload) =>
            s.call(PRODUCT_UPDATE, { ...payload, photos: await productPhotos(payload) }),

        /**
         * Delete products from a catalog.
         *
         * @param {{catalogId: string, productIds: string|string[]}} payload
         * @returns {Promise<object>}
         */
        deleteProductCatalog: (payload) =>
            s.call(PRODUCT_DELETE, { catalogId: payload.catalogId, productIds: [].concat(payload.productIds) }),

        /**
         * Upload one product photo; the answer has its `photoId` and URLs.
         *
         * @param {{file: string|{data: Uint8Array, metadata?: object}}} payload - an image file path, or an attachment
         * @returns {Promise<object>}
         */
        uploadProductPhoto,

        /**
         * Turn the catalog feature on or off for the account.
         *
         * @param {boolean} enable
         * @returns {Promise<object>}
         */
        registerCatalog: (enable) => s.call(CATALOG_REGISTER, { enable }),

        // ------------------------------------------------ quick messages

        /**
         * The account's quick messages.
         *
         * @returns {Promise<object>}
         */
        getQuickMessageList: () => s.call(QUICK_LIST, {}),

        /**
         * Add a quick message.
         *
         * @param {{keyword: string, title: string, media?: string|object}} addPayload - the shortcut, the text, and
         *   an optional photo (uploaded first)
         * @returns {Promise<object>}
         */
        addQuickMessage: async (addPayload) =>
            s.call(QUICK_CREATE, {
                keyword: addPayload.keyword,
                title: addPayload.title,
                media: addPayload.media ? await quickMedia(addPayload.media) : undefined,
            }),

        /**
         * Change a quick message.
         *
         * @param {{keyword: string, title: string, media?: string|object}} updatePayload
         * @param {number} itemId - the quick message's id
         * @returns {Promise<object>}
         */
        updateQuickMessage: async (updatePayload, itemId) =>
            s.call(QUICK_UPDATE, {
                itemId,
                keyword: updatePayload.keyword,
                title: updatePayload.title,
                media: updatePayload.media ? await quickMedia(updatePayload.media) : undefined,
            }),

        /**
         * Delete quick messages.
         *
         * @param {number|number[]} itemIds - one id or several
         * @returns {Promise<object>}
         */
        removeQuickMessage: (itemIds) => s.call(QUICK_DELETE, { itemIds: [].concat(itemIds) }),

        // ------------------------------------------------ auto-reply

        /**
         * The account's auto-reply rules.
         *
         * @returns {Promise<object>}
         */
        getAutoReplyList: () => s.call(AUTO_REPLY_LIST, {}),

        /**
         * Create an auto-reply rule.
         *
         * @param {{content: string, isEnable: boolean, startTime: number, endTime: number, scope: number,
         *   uids?: string|string[]}} payload - the reply, whether it is on, its window (ms), who it answers
         * @returns {Promise<object>}
         */
        createAutoReply: (payload) =>
            s.call(AUTO_REPLY_CREATE, { ...payload, uids: ruleUids(payload.scope, payload.uids) }),

        /**
         * Change an auto-reply rule.
         *
         * @param {{id: number, content: string, isEnable: boolean, startTime: number, endTime: number,
         *   scope: number, uids?: string|string[]}} payload
         * @returns {Promise<object>}
         */
        updateAutoReply: (payload) =>
            s.call(AUTO_REPLY_UPDATE, { ...payload, uids: ruleUids(payload.scope, payload.uids) }),

        /**
         * Delete an auto-reply rule.
         *
         * @param {number} id - the rule's id
         * @returns {Promise<object>}
         */
        deleteAutoReply: (id) => s.call(AUTO_REPLY_DELETE, { id }),
    };
}
