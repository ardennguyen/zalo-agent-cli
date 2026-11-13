/**
 * Catalog commands — manage Zalo Shop catalogs and products.
 */

import { resolve } from "path";
import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { allCatalogs, allProducts } from "../core/list-all.js";
import { parseIntOption } from "../utils/parse-options.js";
import { parseOnOff } from "../utils/cli-args.js";
import { guardSubcommand } from "../core/confirm-guard.js";

export function registerCatalogCommands(program) {
    const catalog = program.command("catalog").description("Manage Zalo Shop catalogs and products");

    catalog
        .command("list")
        .description("List all catalogs")
        .option(
            "-l, --limit <n>",
            "Items per page (with -l or -p one page is read, 20 a page by default)",
            parseIntOption,
        )
        .option("-p, --page <n>", "Read only this page, from 0 (default: every page)", parseIntOption)
        .action(async (opts) => {
            try {
                let result;
                if (opts.limit === undefined && opts.page === undefined) {
                    // No page asked: every catalog, page by page (src/core/list-all.js).
                    const { paging, ...all } = await allCatalogs(getApi());
                    result = all;
                    if (paging.note) warning(paging.note);
                } else {
                    result = await getApi().getCatalogList({ limit: opts.limit ?? 20, page: opts.page ?? 0 });
                }
                output(result, program.opts().json);
            } catch (e) {
                error(`Get catalogs failed: ${e.message}`);
            }
        });

    catalog
        .command("create <name>")
        .description("Create a new catalog")
        .action(async (name) => {
            try {
                const result = await getApi().createCatalog(name);
                output(result, program.opts().json, () => success(`Catalog "${name}" created`));
            } catch (e) {
                error(`Create catalog failed: ${e.message}`);
            }
        });

    catalog
        .command("rename <catalogId> <name>")
        .description("Rename a catalog")
        .action(async (catalogId, name) => {
            try {
                const result = await getApi().updateCatalog({ catalogId, catalogName: name });
                output(result, program.opts().json, () => success(`Catalog renamed to "${name}"`));
            } catch (e) {
                error(`Rename catalog failed: ${e.message}`);
            }
        });

    catalog
        .command("delete <catalogId>")
        .description("Delete a catalog")
        .action(async (catalogId) => {
            try {
                const result = await getApi().deleteCatalog(catalogId);
                output(result, program.opts().json, () => success(`Catalog ${catalogId} deleted`));
            } catch (e) {
                error(`Delete catalog failed: ${e.message}`);
            }
        });

    catalog
        .command("products <catalogId>")
        .description("List products in a catalog")
        .option(
            "-l, --limit <n>",
            "Items per page (with -l or -p one page is read, 100 a page by default)",
            parseIntOption,
        )
        .option("-p, --page <n>", "Read only this page, from 0 (default: every page)", parseIntOption)
        .action(async (catalogId, opts) => {
            try {
                let result;
                if (opts.limit === undefined && opts.page === undefined) {
                    // No page asked: every product, page by page (src/core/list-all.js).
                    const { paging, ...all } = await allProducts(getApi(), catalogId);
                    result = all;
                    if (paging.note) warning(paging.note);
                } else {
                    result = await getApi().getProductCatalogList({
                        catalogId,
                        limit: opts.limit ?? 100,
                        page: opts.page ?? 0,
                    });
                }
                output(result, program.opts().json);
            } catch (e) {
                error(`Get products failed: ${e.message}`);
            }
        });

    catalog
        .command("product <productId>")
        .description("Show one product by its id (unverified: no live answer seen yet)")
        .action(async (productId) => {
            try {
                const result = await getApi().getProductInfo(productId);
                output(result, program.opts().json);
            } catch (e) {
                error(`Get product failed: ${e.message}`);
            }
        });

    catalog
        .command("add-product <catalogId> <name> <price> <description>")
        .description("Add a product to a catalog")
        .option("--photos <urls...>", "Product photo URLs (up to 5)")
        .action(async (catalogId, name, price, description, opts) => {
            try {
                const payload = { catalogId, productName: name, price, description };
                if (opts.photos) payload.product_photos = opts.photos;
                const result = await getApi().createProductCatalog(payload);
                output(result, program.opts().json, () => success(`Product "${name}" added to catalog`));
            } catch (e) {
                error(`Add product failed: ${e.message}`);
            }
        });

    catalog
        .command("update-product <catalogId> <productId> <name> <price> <description>")
        .description("Update a product in a catalog")
        .option("--photos <urls...>", "Product photo URLs (up to 5)")
        .action(async (catalogId, productId, name, price, description, opts) => {
            try {
                const payload = {
                    catalogId,
                    productId,
                    productName: name,
                    price,
                    description,
                    createTime: Date.now(),
                };
                if (opts.photos) payload.product_photos = opts.photos;
                const result = await getApi().updateProductCatalog(payload);
                output(result, program.opts().json, () => success(`Product ${productId} updated`));
            } catch (e) {
                error(`Update product failed: ${e.message}`);
            }
        });

    catalog
        .command("delete-product <catalogId> <productIds...>")
        .description("Delete product(s) from a catalog")
        .action(async (catalogId, productIds) => {
            try {
                const result = await getApi().deleteProductCatalog({ catalogId, productIds });
                output(result, program.opts().json, () => success(`Deleted ${productIds.length} product(s)`));
            } catch (e) {
                error(`Delete product failed: ${e.message}`);
            }
        });

    catalog
        .command("upload-photo <filePath>")
        .description("Upload a product photo (returns URL for use with add-product --photos)")
        .action(async (filePath) => {
            try {
                const absPath = resolve(filePath);
                const result = await getApi().uploadProductPhoto({ file: absPath });
                output(result, program.opts().json, () => {
                    info("Photo uploaded. Use the URL with: catalog add-product --photos <url>");
                });
            } catch (e) {
                error(`Upload photo failed: ${e.message}`);
            }
        });

    catalog
        .command("register <on|off>")
        .description("Turn the Zalo Shop catalog feature on or off for this account")
        .action(async (state) => {
            try {
                const enable = parseOnOff(state, "catalog");
                const result = await getApi().registerCatalog(enable);
                output(result, program.opts().json, () => success(`Catalog ${enable ? "enabled" : "disabled"}`));
            } catch (e) {
                error(e.message);
            }
        });
    // Asked about first, as Zalo does: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    guardSubcommand(catalog, "delete", "catalog.delete", { target: (catalogId) => ({ catalogId }) });
    guardSubcommand(catalog, "delete-product", "catalog.deleteProduct", {
        target: (catalogId, productIds) => ({ catalogId, productIds }),
    });
}
