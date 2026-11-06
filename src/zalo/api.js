/**
 * The session object the engine uses: every Zalo call by name, the listener, the context.
 *
 * `createApi(ctx, serviceMap, wsUrls)` builds a session handle `s` (design 1.2), hands it to every area module's
 * factory (`src/zalo/api/<area>.js`, each exporting one `<name>Methods(s)` factory and an `OWN_READY` set), and
 * returns one plain object with ordinary own properties: `zpwServiceMap`, `listener`, `getContext()`, `getOwnId()`,
 * every method of the area factories, and the composed `sendMessage(message, threadId, type)`.
 *
 * ## The transition switch (build week only; removed at the cut-over, design 2 and 5)
 *
 * While the area modules land one by one, each method is answered by our code or by zca-js on the same context:
 *
 *   ZALO_ENGINE=zca   every method and the listener from zca-js
 *   ZALO_ENGINE=own   every method from our code; a method we do not have yet throws "<name> is not in the own
 *                     engine yet" (what the inventory run looks for)
 *   otherwise         ZALO_ENGINE_ZCA=a,b forces those to zca-js, ZALO_ENGINE_OWN=c,d to ours; every other name is
 *                     ours when some area lists it in `OWN_READY`, zca-js's otherwise
 *
 * `opts.engine` ("own" or "zca") overrides `ZALO_ENGINE` for one call (the differential harness builds one of each
 * on one context). The listener is the name `listener` in the same lists. The composed `sendMessage` goes by the
 * name of the half it needs, `sendText` or `sendAttachments` (or `sendMessage` named in a list, for both).
 *
 * zca-js is imported only when something resolves to it (and, under ZALO_ENGINE=own, to learn which names it has, so
 * the ones we lack can throw by name). Its methods run on the same `ctx`.
 */
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createClientIds } from "./kernel/session.js";
import { callEndpoint, hostOf } from "./kernel/endpoint.js";
import { OWN_READY as SESSION_READY, sessionMethods } from "./api/session.js";

/**
 * @typedef {object} Session
 * @property {object} ctx - the live context (the same object for the session's life)
 * @property {(key: string|string[]) => string} host - a service-map base URL, no trailing slash; throws
 *   `CallUsageError` naming the key when the map lacks it
 * @property {(def: object, args?: object) => Promise<any>} call - run an endpoint definition (kernel/endpoint.js)
 * @property {() => number} now - the clock
 * @property {() => number} nextClientId - monotonic client ids: `max(now, last + 1)`
 * @property {import("./kernel/session.js").UploadRegistry} uploads - `ctx.uploadCallbacks`
 * @property {object} api - the composed session object
 */

/** The area modules under ./api/, in the order their factories run. A missing file is a package not landed yet. */
export const AREA_MODULES = Object.freeze([
    "messages",
    "upload",
    "actions",
    "conversations",
    "groups",
    "people",
    "profile",
    "business",
    "boards",
]);

const LISTENER_MODULE = "./listener/listener.js";

/** Names that are not switched: they are the session itself. */
const RESERVED = new Set(["zpwServiceMap", "listener", "getContext", "getOwnId", "sendMessage"]);

const ENGINES = new Set(["own", "zca"]);

/** A comma list from the environment, as a set. */
const listOf = (v) =>
    new Set(
        String(v ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

/**
 * The whole-session engine the environment (or the caller) asks for, if any.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string|undefined} [engine] - the caller's override
 * @returns {"own"|"zca"|null}
 * @throws {Error} for a value that is neither
 */
function modeOf(env, engine) {
    const mode = engine ?? env.ZALO_ENGINE;
    if (mode === undefined || mode === null || mode === "") return null;
    if (!ENGINES.has(mode)) throw new Error(`ZALO_ENGINE must be "own" or "zca", not "${mode}"`);
    return mode;
}

/**
 * Which engine answers a name.
 *
 * @param {string} name - a method name, or "listener"
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env] - `process.env` by default
 * @param {Set<string>} [opts.ready] - every area's `OWN_READY`, merged
 * @param {"own"|"zca"} [opts.engine] - overrides `ZALO_ENGINE`
 * @returns {"own"|"zca"}
 */
export function engineFor(name, { env = process.env, ready = new Set(), engine } = {}) {
    const mode = modeOf(env, engine);
    if (mode) return mode;
    if (listOf(env.ZALO_ENGINE_ZCA).has(name)) return "zca";
    if (listOf(env.ZALO_ENGINE_OWN).has(name)) return "own";
    return ready.has(name) ? "own" : "zca";
}

/** Import a module of ours that may not exist yet; null when the file is absent. */
async function importIfPresent(spec) {
    const file = fileURLToPath(new URL(spec, import.meta.url));
    try {
        return await import(spec);
    } catch (e) {
        if (e?.code === "ERR_MODULE_NOT_FOUND" && String(e.message).includes(file)) return null;
        throw e;
    }
}

let areasLoaded = null;

/**
 * The area modules present in this tree, each as `{name, factories, ready}`.
 *
 * @returns {Promise<Array<{name: string, factories: Function[], ready: Set<string>}>>}
 * @throws {Error} for an area module that exports no `<name>Methods` factory
 */
export function loadAreas() {
    areasLoaded ??= (async () => {
        const out = [];
        for (const name of AREA_MODULES) {
            const mod = await importIfPresent(`./api/${name}.js`);
            if (!mod) continue;
            const factories = Object.entries(mod)
                .filter(([k, v]) => typeof v === "function" && /Methods$/.test(k))
                .map(([, v]) => v);
            if (!factories.length) throw new Error(`src/zalo/api/${name}.js exports no <name>Methods factory`);
            out.push({ name, factories, ready: mod.OWN_READY instanceof Set ? mod.OWN_READY : new Set() });
        }
        return out;
    })();
    return areasLoaded;
}

/** A method we do not have yet. */
function notOwnYet(name) {
    return async () => {
        throw new Error(`${name} is not in the own engine yet`);
    };
}

/** The listener of a session whose own listener has not landed yet: refuses to start, by name. */
function notOwnListener() {
    const listener = new EventEmitter();
    const refuse = () => {
        throw new Error("listener is not in the own engine yet");
    };
    listener.start = refuse;
    listener.stop = () => {};
    listener.sendWs = refuse;
    listener.ws = null;
    return listener;
}

/**
 * Build the session object.
 *
 * @param {object} ctx - a logged-in context (kernel/session.js)
 * @param {Record<string, string[]>} serviceMap - the login's `zpw_service_map_v3`
 * @param {string[]} wsUrls - the login's `zpw_ws`
 * @param {object} [opts]
 * @param {"own"|"zca"} [opts.engine] - every method from one engine (overrides `ZALO_ENGINE`)
 * @param {Record<string, string|undefined>} [opts.env] - `process.env` by default
 * @param {() => number} [opts.now] - the clock
 * @param {Array<{name: string, factories: Function[], ready: Set<string>}>} [opts.areas] - the area modules (tests);
 *   the ones in ./api/ otherwise
 * @param {{createListener: Function, OWN_READY?: Set<string>}|null} [opts.listenerModule] - ours (tests); the one
 *   in ./listener/ otherwise
 * @returns {Promise<object>}
 */
export async function createApi(ctx, serviceMap, wsUrls, opts = {}) {
    const env = opts.env ?? process.env;
    const now = opts.now ?? Date.now;
    const mode = modeOf(env, opts.engine);
    const areas = opts.areas ?? (await loadAreas());
    const listenerModule =
        opts.listenerModule !== undefined ? opts.listenerModule : await importIfPresent(LISTENER_MODULE);

    const api = {};
    /** @type {Session} */
    const s = {
        ctx,
        host: (key) => hostOf(api.zpwServiceMap ?? serviceMap, key),
        call: (def, args) => callEndpoint(s, def, args),
        now,
        nextClientId: createClientIds(now),
        uploads: ctx.uploadCallbacks,
        api,
    };

    const own = {};
    const ready = new Set(SESSION_READY);
    const allAreas = [{ name: "session", factories: [sessionMethods], ready: SESSION_READY }, ...areas];
    for (const area of allAreas) {
        for (const factory of area.factories) {
            for (const [name, fn] of Object.entries(factory(s))) {
                if (Object.hasOwn(own, name)) throw new Error(`${name} is defined by two area modules`);
                own[name] = fn;
            }
        }
        for (const name of area.ready) ready.add(name);
    }
    for (const name of listenerModule?.OWN_READY ?? []) ready.add(name);
    const choose = (name) => engineFor(name, { env, ready, engine: opts.engine });

    // zca-js, on this same context, when anything resolves to it.
    let zca = null;
    if (mode !== "own") {
        const { API } = await import("zca-js");
        zca = new API(ctx, serviceMap, wsUrls);
    } else {
        try {
            const { API } = await import("zca-js");
            zca = new API(ctx, serviceMap, wsUrls);
        } catch {
            zca = null; // only its names were wanted
        }
    }
    const zcaNames = zca
        ? Object.keys(zca).filter((k) => typeof zca[k] === "function" && !RESERVED.has(k) && !k.startsWith("_"))
        : [];

    api.zpwServiceMap = serviceMap;
    api.getContext = () => ctx;
    api.getOwnId = () => String(ctx.uid);
    for (const name of new Set([...Object.keys(own), ...zcaNames])) {
        if (RESERVED.has(name)) continue;
        const engine = mode === "own" ? "own" : choose(name);
        if (engine === "own") api[name] = own[name] ?? notOwnYet(name);
        else if (zca && typeof zca[name] === "function") api[name] = zca[name];
        else if (mode === "zca") api[name] = notInZca(name);
        else api[name] = own[name];
    }

    const lists = { zca: listOf(env.ZALO_ENGINE_ZCA), own: listOf(env.ZALO_ENGINE_OWN) };
    api.sendMessage = (message, threadId, type) => {
        const attachments = message && typeof message === "object" ? message.attachments : undefined;
        const half = (Array.isArray(attachments) ? attachments.length : attachments ? 1 : 0)
            ? "sendAttachments"
            : "sendText";
        let engine = mode;
        if (!engine && lists.zca.has("sendMessage")) engine = "zca";
        if (!engine && lists.own.has("sendMessage")) engine = "own";
        engine ??= choose(half);
        if (engine === "zca" && zca) return zca.sendMessage(message, threadId, type);
        if (typeof own[half] !== "function") return notOwnYet(half)();
        return own[half](message, threadId, type);
    };

    if (choose("listener") === "own") {
        api.listener =
            typeof listenerModule?.createListener === "function"
                ? listenerModule.createListener(ctx, wsUrls)
                : notOwnListener();
    } else {
        api.listener = zca.listener;
    }
    return api;
}

/** A name forced to zca-js that zca-js does not have. */
function notInZca(name) {
    return async () => {
        throw new Error(`${name} is not in zca-js`);
    };
}
