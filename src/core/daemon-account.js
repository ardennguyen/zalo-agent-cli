import { InvalidArgumentError } from "commander";
import { getActive, getAccount } from "./accounts.js";
import { loadCredentials } from "./credentials.js";
import { loginWithCredentials, clearSession } from "./zalo-client.js";

/** Validate a full numeric account ID without number coercion, names, or prefix matching. */
export function parseAccountId(value) {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        throw new InvalidArgumentError("--account requires a full numeric account ID, not a name or partial ID");
    }
    return value;
}

/**
 * Snapshot one daemon's account at startup without changing the shared registry.
 * Even an implicit active-account selection stays pinned for this process.
 * @param {string} [id] - exact registered account ID, never a display name
 * @param {object} [deps] - offline-test collaborators
 * @returns {Readonly<object>} frozen account identity and proxy configuration
 */
export function selectDaemonAccount(id, { active = getActive, lookup = getAccount } = {}) {
    const selected = id === undefined ? active() : lookup(parseAccountId(id));
    if (!selected) {
        throw new Error(
            id === undefined
                ? "No active account. Please login first. You can also pass --account <ID>."
                : "Account ID is not registered. Use `zalo-agent account list` to find the full ID.",
        );
    }
    const ownId = parseAccountId(selected.ownId);
    if (id !== undefined && ownId !== id) throw new Error("Account lookup returned a different ID; refusing to start");
    return Object.freeze({ ...selected, ownId });
}

/**
 * Authenticate only the daemon's pinned account, including after a disconnect.
 * Never consult the active registry or retain a session for a different user.
 * The caller must hold this account's daemon lock before invoking this function.
 * @param {object} account - selectDaemonAccount() snapshot
 * @param {object} [deps] - offline-test collaborators
 * @returns {Promise<object>} authenticated API/ownId result
 */
export async function loginDaemonAccount(
    account,
    { read = loadCredentials, login = loginWithCredentials, reset = clearSession } = {},
) {
    const id = parseAccountId(account.ownId);
    reset();
    const credentials = read(id);
    if (!credentials) throw new Error("No saved credentials for the pinned account. Log in to that account first.");
    try {
        const session = await login(credentials, account.proxy || null);
        if (String(session?.ownId || "") !== id) {
            throw new Error("Authenticated account does not match the pinned ID; refusing to attach its listener");
        }
        return session;
    } catch (e) {
        reset();
        throw e;
    }
}
