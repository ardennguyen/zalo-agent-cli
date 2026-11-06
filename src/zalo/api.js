/**
 * The session object the engine uses: every Zalo call by name, the listener, the context.
 *
 * `createApi(ctx, serviceMap, wsUrls)` builds a session handle `s` (design 1.2), hands it to every area module's
 * factory (`src/zalo/api/<area>.js`, each exporting one `<name>Methods(s)` factory), and returns one plain object
 * with ordinary own properties: `zpwServiceMap`, `listener`, `getContext()`, `getOwnId()`, every method of the area
 * factories, and the composed `sendMessage(message, threadId, type)`.
 */
import { createClientIds } from "./kernel/session.js";
import { callEndpoint, hostOf } from "./kernel/endpoint.js";
import { sessionMethods } from "./api/session.js";
import { messageMethods } from "./api/messages.js";
import { uploadMethods } from "./api/upload.js";
import { actionMethods } from "./api/actions.js";
import { conversationMethods } from "./api/conversations.js";
import { groupMethods } from "./api/groups.js";
import { peopleMethods } from "./api/people.js";
import { profileMethods } from "./api/profile.js";
import { businessMethods } from "./api/business.js";
import { boardMethods } from "./api/boards.js";
import { createListener } from "./listener/listener.js";

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

/** The area modules under ./api/, in the order their factories run. */
export const AREAS = Object.freeze([
    { name: "messages", factories: [messageMethods] },
    { name: "upload", factories: [uploadMethods] },
    { name: "actions", factories: [actionMethods] },
    { name: "conversations", factories: [conversationMethods] },
    { name: "groups", factories: [groupMethods] },
    { name: "people", factories: [peopleMethods] },
    { name: "profile", factories: [profileMethods] },
    { name: "business", factories: [businessMethods] },
    { name: "boards", factories: [boardMethods] },
]);

/** Names the session object defines itself; no area may define them. */
const RESERVED = new Set(["zpwServiceMap", "listener", "getContext", "getOwnId", "sendMessage"]);

/**
 * Build the session object.
 *
 * @param {object} ctx - a logged-in context (kernel/session.js)
 * @param {Record<string, string[]>} serviceMap - the login's `zpw_service_map_v3`
 * @param {string[]} wsUrls - the login's `zpw_ws`
 * @param {object} [opts]
 * @param {() => number} [opts.now] - the clock
 * @param {Array<{name: string, factories: Function[]}>} [opts.areas] - the area modules (tests); {@link AREAS}
 *   otherwise
 * @param {(ctx: object, wsUrls: string[]) => object} [opts.createListener] - the listener's builder (tests); ours
 *   (./listener/listener.js) otherwise
 * @returns {object}
 * @throws {Error} when two area modules define one name, or an area defines a reserved one
 */
export function createApi(ctx, serviceMap, wsUrls, opts = {}) {
    const now = opts.now ?? Date.now;
    const areas = opts.areas ?? AREAS;
    const buildListener = opts.createListener ?? createListener;

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

    api.zpwServiceMap = serviceMap;
    api.getContext = () => ctx;
    api.getOwnId = () => String(ctx.uid);
    const defined = new Set();
    for (const area of [{ name: "session", factories: [sessionMethods] }, ...areas]) {
        for (const factory of area.factories) {
            for (const [name, fn] of Object.entries(factory(s))) {
                if (RESERVED.has(name)) throw new Error(`${name} is the session's own; area ${area.name} redefines it`);
                if (defined.has(name)) throw new Error(`${name} is defined by two area modules`);
                defined.add(name);
                api[name] = fn;
            }
        }
    }

    /**
     * Send a message: with attachments it goes up as files (the text, if any, as their caption), any other as text.
     *
     * @param {string|{msg?: string, attachments?: string|string[], quote?: object, mentions?: object[],
     *   styles?: object[], urgency?: number, ttl?: number}} message - text, or text with its options
     * @param {string} threadId - the user or group id
     * @param {0|1} [type] - 0 user (default), 1 group
     * @returns {Promise<{message: object|null, attachment: object[]}>}
     */
    api.sendMessage = (message, threadId, type) => {
        const attachments = message && typeof message === "object" ? message.attachments : undefined;
        const count = Array.isArray(attachments) ? attachments.length : attachments ? 1 : 0;
        return count ? api.sendAttachments(message, threadId, type) : api.sendText(message, threadId, type);
    };

    api.listener = buildListener(ctx, wsUrls);
    return api;
}
