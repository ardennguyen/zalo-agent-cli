/**
 * The account's business tools as MCP actions: auto-replies (`zalo_auto_reply`), quick messages
 * (`zalo_quick_message`), the Zalo Shop catalog (`zalo_catalog`) and saved bank accounts (`zalo_bank`). Each action
 * makes the call its CLI command makes (`auto-reply`, `quick-msg`, `catalog`, `bank`).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { activeWindow, AUTO_REPLY_SCOPES } from "../core/auto-reply.js";
import { findBankAccount, filterBanks } from "../core/bank-accounts.js";
import { setQuickMessageStatus } from "../core/profile-settings.js";
import { resolveBankBin, BIN_TO_DISPLAY } from "../utils/bank-helpers.js";
import { confirmInput, dryRunInput, ticketInput } from "./action-tool.js";
import { allBankAccounts, allCatalogs, allProducts } from "../core/list-all.js";

/** A bank name or BIN as the BIN Zalo wants, or the refusal (as `bank add` words it). */
function bankBin(input) {
    const bin = resolveBankBin(String(input));
    return bin ? { bin } : { error: `Unknown bank: '${input}'. zalo_bank 'banks' lists the banks Zalo supports.` };
}

/** One saved bank account, without Zalo's snake_case. */
function savedAccount(b) {
    return {
        bankAccountId: String(b.account_id),
        bank: BIN_TO_DISPLAY[b.bin] || String(b.bin ?? ""),
        bin: b.bin ?? null,
        accountNumber: b.bank_number ?? null,
        holderName: b.holder_name ?? null,
        isDefault: Boolean(b.default),
    };
}

/** The auto-reply payload `auto-reply create` / `update` send. */
function autoReplyPayload(a) {
    return {
        content: a.content,
        isEnable: a.enabled ?? true,
        ...activeWindow({ start: a.startTime, end: a.endTime }),
        scope: AUTO_REPLY_SCOPES[a.scope ?? "all"],
        ...(a.userIds && { uids: a.userIds }),
    };
}

// --- zalo_auto_reply ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const AUTO_REPLY_ACTIONS = {
    list: {
        async run(_a, { api }) {
            return { data: (await api.getAutoReplyList()) ?? null };
        },
    },
    create: {
        needs: ["content"],
        async run(a, { api }) {
            const res = await api.createAutoReply(autoReplyPayload(a));
            return { success: true, data: res ?? null };
        },
    },
    update: {
        needs: ["autoReplyId", "content"],
        async run(a, { api }) {
            const res = await api.updateAutoReply({ id: Number(a.autoReplyId), ...autoReplyPayload(a) });
            return { success: true, autoReplyId: a.autoReplyId, data: res ?? null };
        },
    },
    delete: {
        needs: ["autoReplyId"],
        guard: (a) => ({ key: "autoReply.delete", target: { autoReplyId: a.autoReplyId } }),
        async run(a, { api }) {
            await api.deleteAutoReply(Number(a.autoReplyId));
            return { success: true, autoReplyId: a.autoReplyId };
        },
    },
};

/** zalo_auto_reply's metadata. */
export const AUTO_REPLY_META = {
    title: "Manage Zalo Auto-Replies",
    description:
        "List, create, update or delete this account's auto-reply rules (the `auto-reply` commands): Zalo answers " +
        "incoming messages with `content` while a rule is enabled and inside its window. Actions: 'list', " +
        "'create' (`content`, optional `enabled`, `startTime`, `endTime`, `scope`, `userIds`), 'update' (the " +
        "same, for `autoReplyId`) and 'delete' (asked about first: `confirm`, `dryRun`). A rule with no window " +
        "starts now and runs for a year.",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(AUTO_REPLY_ACTIONS)).describe("Auto-reply operation to perform"),
            autoReplyId: z
                .string()
                .min(1)
                .optional()
                .describe("The rule's id, from 'list' (required for 'update' and 'delete')"),
            content: z
                .string()
                .min(1)
                .max(2000)
                .optional()
                .describe("The reply text (required for 'create' and 'update')"),
            enabled: z.boolean().optional().describe("Whether the rule is on (default true)"),
            startTime: z.number().int().min(0).optional().describe("When the rule starts, epoch ms (default now)"),
            endTime: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("When the rule ends, epoch ms (default a year after the start)"),
            scope: z
                .enum(Object.keys(AUTO_REPLY_SCOPES))
                .optional()
                .describe("Who it answers: all (default), friends or strangers"),
            userIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("Only these users, instead of a whole scope"),
            confirm: confirmInput("'delete'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'delete'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

// --- zalo_quick_message ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const QUICK_MESSAGE_ACTIONS = {
    list: {
        async run(_a, { api }) {
            return { data: (await api.getQuickMessageList()) ?? null };
        },
    },
    add: {
        needs: ["keyword", "title"],
        async run(a, { api }) {
            const res = await api.addQuickMessage({ keyword: a.keyword, title: a.title });
            return { success: true, keyword: a.keyword, data: res ?? null };
        },
    },
    update: {
        needs: ["quickMessageId", "keyword", "title"],
        async run(a, { api }) {
            await api.updateQuickMessage({ keyword: a.keyword, title: a.title }, Number(a.quickMessageId));
            return { success: true, quickMessageId: a.quickMessageId, keyword: a.keyword };
        },
    },
    remove: {
        needs: ["quickMessageIds"],
        guard: (a) => ({ key: "quickMsg.remove", target: { quickMessageIds: a.quickMessageIds } }),
        async run(a, { api }) {
            await api.removeQuickMessage(a.quickMessageIds.map(Number));
            return { success: true, quickMessageIds: a.quickMessageIds };
        },
    },
    // The same reply as `quick-msg enable|disable` (src/core/profile-settings.js).
    enable: {
        async run(_a, { api }) {
            return setQuickMessageStatus(api, true);
        },
    },
    disable: {
        async run(_a, { api }) {
            return setQuickMessageStatus(api, false);
        },
    },
};

/** zalo_quick_message's metadata. */
export const QUICK_MESSAGE_META = {
    title: "Manage Zalo Quick Messages",
    description:
        "List, add, update or remove this account's quick messages (the `quick-msg` commands): saved texts the " +
        "apps insert when the owner types `/keyword`. Actions: 'list', 'add' (`keyword`, `title`: the text), " +
        "'update' (the same, for `quickMessageId`), 'remove' (`quickMessageIds`; asked about first: " +
        "`confirm`, `dryRun`), and 'enable' / 'disable' (turn the quick-message feature on or off for " +
        "the account, as Zalo Web's switch does; unverified live).",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(QUICK_MESSAGE_ACTIONS)).describe("Quick-message operation to perform"),
            quickMessageId: z.string().min(1).optional().describe("The quick message's id, from 'list' (for 'update')"),
            quickMessageIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("Quick message ids, from 'list' (for 'remove')"),
            keyword: z
                .string()
                .min(1)
                .max(50)
                .optional()
                .describe("The shortcut typed after / (for 'add' and 'update')"),
            title: z.string().min(1).max(2000).optional().describe("The saved text itself (for 'add' and 'update')"),
            confirm: confirmInput("'remove'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'remove'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

// --- zalo_catalog ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const CATALOG_ACTIONS = {
    list: {
        async run(a, { api }) {
            if (a.limit !== undefined || a.page !== undefined) {
                return { data: (await api.getCatalogList({ limit: a.limit ?? 20, page: a.page ?? 0 })) ?? null };
            }
            // No page asked: every catalog, page by page (src/core/list-all.js).
            const { paging, ...data } = await allCatalogs(api);
            return { data: Object.keys(data).length ? data : null, ...(paging.note && { note: paging.note }) };
        },
    },
    create: {
        needs: ["name"],
        async run(a, { api }) {
            return { success: true, name: a.name, data: (await api.createCatalog(a.name)) ?? null };
        },
    },
    rename: {
        needs: ["catalogId", "name"],
        async run(a, { api }) {
            await api.updateCatalog({ catalogId: a.catalogId, catalogName: a.name });
            return { success: true, catalogId: a.catalogId, name: a.name };
        },
    },
    delete: {
        needs: ["catalogId"],
        guard: (a) => ({ key: "catalog.delete", target: { catalogId: a.catalogId } }),
        async run(a, { api }) {
            await api.deleteCatalog(a.catalogId);
            return { success: true, catalogId: a.catalogId };
        },
    },
    products: {
        needs: ["catalogId"],
        async run(a, { api }) {
            if (a.limit === undefined && a.page === undefined) {
                // No page asked: every product, page by page (src/core/list-all.js).
                const { paging, ...data } = await allProducts(api, a.catalogId);
                return {
                    catalogId: a.catalogId,
                    data: Object.keys(data).length ? data : null,
                    ...(paging.note && { note: paging.note }),
                };
            }
            const res = await api.getProductCatalogList({
                catalogId: a.catalogId,
                limit: a.limit ?? 100,
                page: a.page ?? 0,
            });
            return { catalogId: a.catalogId, data: res ?? null };
        },
    },
    product: {
        needs: ["productId"],
        async run(a, { api }) {
            return { productId: a.productId, data: (await api.getProductInfo(a.productId)) ?? null };
        },
    },
    add_product: {
        needs: ["catalogId", "name", "price", "description"],
        async run(a, { api }) {
            const payload = { catalogId: a.catalogId, productName: a.name, price: a.price, description: a.description };
            if (a.photoUrls) payload.product_photos = a.photoUrls;
            return { success: true, catalogId: a.catalogId, data: (await api.createProductCatalog(payload)) ?? null };
        },
    },
    update_product: {
        needs: ["catalogId", "productId", "name", "price", "description"],
        async run(a, { api }) {
            const payload = {
                catalogId: a.catalogId,
                productId: a.productId,
                productName: a.name,
                price: a.price,
                description: a.description,
                createTime: Date.now(),
            };
            if (a.photoUrls) payload.product_photos = a.photoUrls;
            await api.updateProductCatalog(payload);
            return { success: true, catalogId: a.catalogId, productId: a.productId };
        },
    },
    delete_product: {
        needs: ["catalogId", "productIds"],
        guard: (a) => ({ key: "catalog.deleteProduct", target: { catalogId: a.catalogId, productIds: a.productIds } }),
        async run(a, { api }) {
            await api.deleteProductCatalog({ catalogId: a.catalogId, productIds: a.productIds });
            return { success: true, catalogId: a.catalogId, productIds: a.productIds };
        },
    },
    upload_photo: {
        needs: ["filePath"],
        check: (a) =>
            existsSync(resolve(String(a.filePath).trim()))
                ? undefined
                : `File not found on the machine this server runs on: ${resolve(String(a.filePath).trim())}`,
        async run(a, { api }) {
            const res = await api.uploadProductPhoto({ file: resolve(String(a.filePath).trim()) });
            return { success: true, data: res ?? null };
        },
    },
    register: {
        needs: ["enabled"],
        async run(a, { api }) {
            await api.registerCatalog(a.enabled);
            return { success: true, enabled: a.enabled };
        },
    },
};

/** zalo_catalog's metadata. */
export const CATALOG_META = {
    title: "Manage the Zalo Shop Catalog",
    description:
        "Manage this account's Zalo Shop catalogs and their products (the `catalog` commands). Actions: 'list', " +
        "'create' (`name`), 'rename' (`catalogId`, `name`), 'delete' (a catalog and every product in it), " +
        "'products' (a catalog's products), 'product' (one product by `productId`), 'add_product' / 'update_product' (`name`, `price`, `description`, " +
        "optional `photoUrls` from 'upload_photo'), 'delete_product' (`productIds`), 'upload_photo' (a local " +
        "image, `filePath`; returns its URL) and 'register' (turn the catalog feature on or off). 'delete' and " +
        "'delete_product' are asked about first: `confirm`, `dryRun`.",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(CATALOG_ACTIONS)).describe("Catalog operation to perform"),
            catalogId: z.string().min(1).optional().describe("The catalog's id, from 'list'"),
            productId: z
                .string()
                .min(1)
                .optional()
                .describe("The product's id, from 'products' (for 'product' and 'update_product')"),
            productIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("Product ids, from 'products' (for 'delete_product')"),
            name: z.string().min(1).max(200).optional().describe("A catalog's or a product's name"),
            price: z.string().min(1).max(30).optional().describe("A product's price, as Zalo shows it (e.g. '150000')"),
            description: z.string().max(5000).optional().describe("A product's description"),
            photoUrls: z
                .array(z.string().url())
                .min(1)
                .max(5)
                .optional()
                .describe("Up to five product photo URLs (from 'upload_photo')"),
            filePath: z
                .string()
                .min(1)
                .optional()
                .describe("Only for 'upload_photo': a local image path on the machine this server runs on"),
            enabled: z.boolean().optional().describe("Only for 'register': true turns the catalog on, false off"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(200)
                .optional()
                .describe(
                    "Page size for 'list' (20) and 'products' (100); one page is read when limit or page is given",
                ),
            page: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Read only this page of 'list' and 'products', from 0 (omit limit and page for all)"),
            confirm: confirmInput("'delete' and 'delete_product'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'delete' and 'delete_product'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

// --- zalo_bank ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const BANK_ACTIONS = {
    banks: {
        async run(a, { api }) {
            const banks = filterBanks((await api.getListBank())?.banks, a.query).map((b) => ({
                bin: b.bin ?? null,
                shortName: b.short_name ?? null,
                name: b.name ?? null,
            }));
            return { count: banks.length, banks };
        },
    },
    accounts: {
        async run(a, { api }) {
            // No page asked: every saved account, page by page (src/core/list-all.js).
            const res =
                a.page === undefined && a.limit === undefined
                    ? await allBankAccounts(api)
                    : await api.getListBankAccount(a.page ?? 0, a.limit ?? 20);
            const accounts = (res?.myBanks ?? []).map(savedAccount);
            return {
                count: accounts.length,
                total: res?.total ?? accounts.length,
                hasMore: Boolean(res?.hasMore),
                accounts,
                ...(res?.paging?.note && { note: res.paging.note }),
            };
        },
    },
    add: {
        needs: ["bank", "accountNumber", "holderName"],
        check: (a) => bankBin(a.bank).error,
        async run(a, { api }) {
            const { bin } = bankBin(a.bank);
            await api.createBankAccount({ binBank: bin, numAccBank: a.accountNumber, nameAccBank: a.holderName });
            return { success: true, bank: BIN_TO_DISPLAY[bin] || String(bin), accountNumber: a.accountNumber };
        },
    },
    update: {
        needs: ["bankAccountId", "bank", "accountNumber", "holderName"],
        check: (a) => bankBin(a.bank).error,
        async run(a, { api }) {
            await api.updateBankAccount({
                accountId: Number(a.bankAccountId),
                binBank: bankBin(a.bank).bin,
                numAccBank: a.accountNumber,
                nameAccBank: a.holderName,
            });
            return { success: true, bankAccountId: a.bankAccountId };
        },
    },
    remove: {
        needs: ["bankAccountId"],
        guard: (a) => ({ key: "bank.remove", target: { bankAccountId: a.bankAccountId } }),
        async run(a, { api }) {
            // Zalo wants to know whether it is the default account, and only the list knows (as `bank remove`).
            const found = await findBankAccount(api, Number(a.bankAccountId));
            if (!found) throw new Error(`No saved bank account with id ${a.bankAccountId}; 'accounts' lists them.`);
            await api.deleteBankAccount({ accountId: Number(a.bankAccountId), isDefault: Boolean(found.default) });
            return { success: true, bankAccountId: a.bankAccountId };
        },
    },
};

/** zalo_bank's metadata. */
export const BANK_META = {
    title: "Manage Saved Zalo Bank Accounts",
    description:
        "The banks Zalo supports and the bank accounts saved on this Zalo account (the `bank` commands). Actions: " +
        "'banks' (the supported banks with their BIN, optionally filtered by `query`), 'accounts' (the saved " +
        "accounts), 'add' (`bank`, `accountNumber`, `holderName`), 'update' (the same, for `bankAccountId`) and " +
        "'remove' (asked about first: `confirm`, `dryRun`). To send a bank card or a VietQR transfer image to a " +
        "conversation, use zalo_send_message (`bankCard`, `qrTransfer`).",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(BANK_ACTIONS)).describe("Bank operation to perform"),
            query: z.string().min(1).optional().describe("Only for 'banks': part of a bank's name, short name or BIN"),
            bankAccountId: z
                .string()
                .min(1)
                .optional()
                .describe("A saved account's id, from 'accounts' (for 'update' and 'remove')"),
            bank: z.string().min(1).optional().describe("The bank: a short name such as vcb, ocb or bidv, or its BIN"),
            accountNumber: z.string().min(1).max(40).optional().describe("The bank account number"),
            holderName: z.string().min(1).max(100).optional().describe("The account holder's name"),
            page: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Only for 'accounts': read only this page, from 0 (omit page and limit for every account)"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Only for 'accounts': page size (one page is read when page or limit is given; 20 a page)"),
            confirm: confirmInput("'remove'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'remove'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
