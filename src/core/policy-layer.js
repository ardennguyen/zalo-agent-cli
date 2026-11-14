/**
 * The top layer of every runtime setting: the live policy (./policy-store.js), as the resolvers read it.
 *
 * Settings are layered built-in defaults < files (mcp-config.json, storage.json) < environment < policy. The resolvers
 * (src/core/deploy-policy.js, confirm-guard.js, mcp-config.js, storage-quota.js) ask this module for one account's
 * policy on every call, so a change applied by the admin API, `policy set` or a file drop counts on the next tool
 * call, with no restart.
 *
 * This module has no imports on purpose: the resolvers load it, and the store (which needs the key layer) registers
 * itself here when it is loaded (src/index.js loads it for every command). A process that never loads the store, as a
 * unit test of a resolver, sees no policy.
 */

let provider = null;

/**
 * Install the function that returns one account's effective policy (nested, the tenant's under the account's own).
 *
 * @param {((ownId: string) => object|null)|null} fn
 */
export function setPolicyProvider(fn) {
    provider = typeof fn === "function" ? fn : null;
}

/**
 * One account's effective policy, or null when there is none (or no store is loaded).
 *
 * @param {string|null|undefined} ownId
 * @returns {object|null}
 */
export function policyFor(ownId) {
    const id = ownId === undefined || ownId === null ? "" : String(ownId).trim();
    if (!id || !provider) return null;
    try {
        return provider(id) || null;
    } catch {
        return null;
    }
}

/**
 * One key of one account's policy (dotted, e.g. `media.linkAuth`), or undefined.
 *
 * @param {string|null|undefined} ownId
 * @param {string} key
 * @returns {unknown}
 */
export function policyValue(ownId, key) {
    let node = policyFor(ownId);
    for (const p of key.split(".")) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
        node = node[p];
    }
    return node === null ? undefined : node;
}
