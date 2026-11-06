/**
 * Where the harness gets `createApi(ctx, serviceMap, wsUrls, {engine})` from.
 *
 * Once package K1 has landed it is `src/zalo/api.js` (design.md 1.3): `{engine: "zca"}` builds zca-js's `API` on
 * the given ctx and `{engine: "own"}` our session object. Until then a stand-in plays the zca side only, so the
 * harness can test itself with zca-js on both sides; asking it for the own engine fails with a message that says
 * why.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The engine's `createApi` module, once K1 has written it. */
export const API_MODULE = join(import.meta.dirname, "..", "..", "..", "src", "zalo", "api.js");

/**
 * zca-js's `API` on a ctx, as `createApi(..., {engine: "zca"})` builds it. The own engine does not exist yet.
 *
 * @param {object} ctx
 * @param {Record<string, string[]>} serviceMap
 * @param {string[]} wsUrls
 * @param {{engine?: "zca"|"own"}} [opts]
 * @returns {Promise<object>}
 */
export async function standInCreateApi(ctx, serviceMap, wsUrls, { engine = "zca" } = {}) {
    if (engine !== "zca") {
        throw new Error(
            `wire-diff: the ${engine} engine is not available yet: src/zalo/api.js (package K1) has not landed; ` +
                "until it does the harness runs zca-js on both sides",
        );
    }
    const { API } = await import("zca-js");
    return new API(ctx, serviceMap, wsUrls);
}

/**
 * The `createApi` to use: the engine's own when `src/zalo/api.js` exists (an import error in it is thrown, not
 * hidden), the zca-only stand-in otherwise.
 *
 * @returns {Promise<{createApi: Function, standIn: boolean}>}
 */
export async function resolveCreateApi() {
    if (!existsSync(API_MODULE)) return { createApi: standInCreateApi, standIn: true };
    const mod = await import(pathToFileURL(API_MODULE).href);
    if (typeof mod.createApi !== "function") throw new Error("wire-diff: src/zalo/api.js exports no createApi");
    return { createApi: mod.createApi, standIn: false };
}
