/**
 * The current session's zca-js API, whichever object that is when it is used.
 *
 * `mcp start` logs in again after a dropped connection, and every login
 * replaces the API object (src/core/zalo-client.js `setSession`). What was
 * handed the object once, at start-up -- the MCP tools and the notifier --
 * kept calling the replaced one after the first re-login: its listener
 * stopped, its context the old login's. So `zalo_get_history`'s socket scan
 * ran on a dead listener, and every send, reaction and recall went through
 * a session the daemon had already given up. The daemon's other consumers
 * (receipts, self-heal, the daemon channel) always took `getApi` itself for
 * this reason.
 *
 * This stands in for the API object and forwards every read to `getApi()` at
 * the moment of use, so a caller written against a plain API object gets the
 * live one without knowing a re-login happened.
 */

/**
 * @param {() => object} getApi - returns the current API, or throws while there is none
 * @param {object} [opts]
 * @param {string} [opts.unavailable] - the error to raise while there is no session
 * @returns {object} an object whose properties are always the current API's
 */
export function liveApi(getApi, { unavailable } = {}) {
    const current = () => {
        try {
            return getApi();
        } catch (e) {
            throw unavailable ? new Error(unavailable) : e;
        }
    };
    return new Proxy(Object.create(null), {
        get(_, prop) {
            // Not a promise: `await liveApi(...)` must not try to call a `then`.
            if (prop === "then") return undefined;
            const api = current();
            const value = api[prop];
            // Bound to the API it came from, so `this` is right even if the
            // session is replaced before the call returns.
            return typeof value === "function" ? value.bind(api) : value;
        },
        has(_, prop) {
            return prop in current();
        },
    });
}
