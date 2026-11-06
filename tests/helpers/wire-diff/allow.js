/**
 * The declared differences between zca-js and our engine, per area: `ALLOW.<area>` is what a
 * `wire-<area>.test.js` passes to `assertSameWire` (tests/helpers/wire-diff/compare.js has the row rules).
 *
 * Each area's own rows live in `./allow/<area>.js`, owned by that area's package, so the packages never edit one
 * shared file. Every `ALLOW.<area>` starts with the global rows below; a row for one method shadows a global row
 * on the same field.
 *
 * The global rows are the kernel's transport differences (agent/docs/zca-replace/spec-kernel.md D1-D4) plus the
 * `nretry=0` zca-js puts into the query of its sends and the Web does not. Each applies only where its `when` holds, and
 * there it must be present.
 */
import { isDeepStrictEqual } from "node:util";
import actions from "./allow/actions.js";
import boards from "./allow/boards.js";
import business from "./allow/business.js";
import conversations from "./allow/conversations.js";
import groups from "./allow/groups.js";
import kernel from "./allow/kernel.js";
import listener from "./allow/listener.js";
import models from "./allow/models.js";
import people from "./allow/people.js";
import profile from "./allow/profile.js";
import upload from "./allow/upload.js";
import messages from "./allow/messages.js";

/** zca-js's fixed Accept-Language. */
export const ZCA_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** zca-js's hand-set Accept-Encoding. */
export const ZCA_ACCEPT_ENCODING = "gzip, deflate, br, zstd";

/**
 * The Web's query for the names zca-js sent: `zpw_ver`, `zpw_type` first, then the endpoint's own names in their
 * zca-js order, without the `nretry` the Web does not send.
 *
 * @param {string[]} order - zca-js's query names, in its order
 * @returns {string[]}
 */
export function webQueryOrder(order) {
    return ["zpw_ver", "zpw_type", ...order.filter((k) => k !== "zpw_ver" && k !== "zpw_type" && k !== "nretry")];
}

/**
 * True when zca-js's query differs from the Web's for the same call (D1, and the `nretry` it adds): it carries
 * the version pair, and {@link webQueryOrder} would change it.
 *
 * @param {string[]} order
 * @returns {boolean}
 */
export function differsFromWebOrder(order) {
    return Array.isArray(order) && order.includes("zpw_ver") && !isDeepStrictEqual(order, webQueryOrder(order));
}

/** Rows every area inherits. */
export const GLOBAL = Object.freeze([
    {
        id: "D1",
        method: "*",
        field: "queryOrder",
        when: ({ zca }) => differsFromWebOrder(zca?.queryOrder),
        zca: () => true,
        own: (v, { zca }) => isDeepStrictEqual(v, webQueryOrder(zca.queryOrder)),
        why: "D1: the Web puts zpw_ver and zpw_type before the endpoint's params, and sends no nretry (spec-kernel D1)",
    },
    {
        id: "D2",
        method: "*",
        field: "headers.content-type",
        when: ({ zca }) =>
            zca?.method === "GET" && /^application\/x-www-form-urlencoded/i.test(zca.headers["content-type"] ?? ""),
        zca: (v) => /^application\/x-www-form-urlencoded/i.test(v ?? ""),
        own: undefined,
        why: "D2: the Web sends a content type only with a body; zca-js sets the form type on every request, GET included",
    },
    {
        id: "D3",
        method: "*",
        field: "headers.accept-language",
        when: ({ zca }) => zca?.headers?.["accept-language"] === ZCA_ACCEPT_LANGUAGE,
        zca: ZCA_ACCEPT_LANGUAGE,
        own: (v) => typeof v === "string" && v.length > 0 && v !== ZCA_ACCEPT_LANGUAGE,
        why: "D3: the browser's own Accept-Language from src/zalo/profile.js, not zca-js's fixed en-US",
    },
    {
        id: "D4",
        method: "*",
        field: "headers.accept-encoding",
        when: ({ zca }) => zca?.headers?.["accept-encoding"] === ZCA_ACCEPT_ENCODING,
        zca: ZCA_ACCEPT_ENCODING,
        own: undefined,
        why: "D4: fetch picks Accept-Encoding itself; a hand-set zstd is a decode risk on Node 22 (spec-kernel 7.6)",
    },
    {
        id: "nretry",
        method: "*",
        field: "query.nretry",
        when: ({ zca }) => zca?.query?.nretry !== undefined,
        zca: (v) => v !== undefined,
        own: undefined,
        why: "no nretry: the Web's senders put only the common params in the query (spec-send 0, spec-actions 10)",
    },
]);

/** The rows of each area, global rows first. */
export const ALLOW = Object.freeze(
    Object.fromEntries(
        Object.entries({
            kernel,
            messages,
            upload,
            actions,
            conversations,
            groups,
            people,
            profile,
            business,
            boards,
            listener,
            models,
        }).map(([area, rows]) => [area, Object.freeze([...GLOBAL, ...rows])]),
    ),
);
