/**
 * How AI apps sign in to one account's MCP server over OAuth, chosen per account and applied live (no restart):
 *
 * - `off`: the OAuth routes answer 404 like a bearer-only server; API keys and the static bearer still work, and the
 *   grants already given are kept but refused while it stays off.
 * - `automatic`: dynamic client registration (RFC 7591 `/register`) is on and advertised; every connection is still
 *   approved with the approver password on the one-time page.
 * - `specific`: only the configured clients and the clients made through the access API are known; `/register` answers
 *   404 and is not advertised.
 *
 * The choice is saved in the account folder (`oauth-settings.json`, 0600, replaced atomically) by the access API
 * (src/core/access-api.js); the daemon's OAuth server (./mcp-oauth.js) reads it again whenever the file changed. With
 * no saved choice the mode follows the configuration: `automatic` when dynamic registration is on, else `specific` when
 * a client is configured, else `off`.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { envForAccount } from "./mcp-config.js";

/** The modes an account's OAuth can be in. */
export const OAUTH_MODES = Object.freeze(["off", "automatic", "specific"]);
/** The saved choice, in the account folder. */
export const OAUTH_SETTINGS_FILE = "oauth-settings.json";
/** The signing secret of an account whose server has no --auth token or configured client secret, in its folder. */
export const OAUTH_SIGNING_KEY_FILE = "oauth-signing-key.json";

/**
 * The mode the configuration implies when the account has no saved choice.
 * @param {{dynamic: boolean, configuredClients: number}} args
 * @returns {"off"|"automatic"|"specific"}
 */
export function defaultOAuthMode({ dynamic, configuredClients }) {
    if (dynamic) return "automatic";
    return configuredClients > 0 ? "specific" : "off";
}

/**
 * Whether the configuration turns dynamic registration on for one account (`ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION[_<ownId>]`,
 * then `oauth.allowDynamicRegistration`), read the way `mcp start` reads it: 1/true/yes/on.
 * @param {{config?: object, accountId: string, env?: Record<string, string|undefined>}} args
 * @returns {boolean}
 */
export function configDynamicRegistration({ config = {}, accountId, env = process.env }) {
    const raw =
        envForAccount("ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION", accountId, env) ?? config?.oauth?.allowDynamicRegistration;
    if (typeof raw === "boolean") return raw;
    return ["1", "true", "yes", "on"].includes(
        String(raw ?? "")
            .trim()
            .toLowerCase(),
    );
}

/**
 * The saved choice of an account, or null when there is none (or it cannot be read).
 * @param {string|null} dir - the account folder
 * @returns {{mode: "off"|"automatic"|"specific", updatedAt: string|null}|null}
 */
export function readOAuthSettings(dir) {
    if (!dir) return null;
    try {
        const parsed = JSON.parse(readFileSync(join(dir, OAUTH_SETTINGS_FILE), "utf8"));
        if (parsed?.v === 1 && OAUTH_MODES.includes(parsed.mode)) {
            return { mode: parsed.mode, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
        }
    } catch {
        /* none, or not readable: the configuration decides */
    }
    return null;
}

/**
 * Save an account's choice (atomic, 0600).
 * @param {string} dir - the account folder
 * @param {"off"|"automatic"|"specific"} mode
 * @returns {{mode: string, updatedAt: string}}
 */
export function writeOAuthSettings(dir, mode) {
    if (!OAUTH_MODES.includes(mode)) throw new Error(`not an OAuth mode: ${mode}`);
    const out = { mode, updatedAt: new Date().toISOString() };
    writeFileAtomic(join(dir, OAUTH_SETTINGS_FILE), JSON.stringify({ v: 1, ...out }), { mode: 0o600 });
    return out;
}

/**
 * A reader of an account's saved choice for a running server: the file is parsed again only when it changed on disk
 * (its mtime, size or inode), so calling it on every request costs one stat.
 * @param {string|null} dir - the account folder (none: never a saved choice)
 * @returns {() => ({mode: string, updatedAt: string|null}|null)}
 */
export function createOAuthSettingsReader(dir) {
    if (!dir) return () => null;
    const file = join(dir, OAUTH_SETTINGS_FILE);
    let mark;
    let value = null;
    return () => {
        let m = null;
        try {
            const st = statSync(file);
            m = `${st.mtimeMs}:${st.size}:${st.ino}`;
        } catch {
            m = null;
        }
        if (m !== mark) {
            mark = m;
            value = m ? readOAuthSettings(dir) : null;
        }
        return value;
    };
}

/**
 * The account's own OAuth signing secret, made (random, 0600) the first time it is needed: what signs access tokens on
 * a server that has no `--auth` token and no configured client secret, so that turning OAuth on from the console needs
 * no restart and no new environment.
 * @param {string} dir - the account folder
 * @returns {string}
 */
export function accountSigningSecret(dir) {
    const file = join(dir, OAUTH_SIGNING_KEY_FILE);
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed?.key === "string" && parsed.key.length >= 32) return parsed.key;
    } catch {
        /* not made yet */
    }
    const key = randomBytes(32).toString("base64url");
    writeFileAtomic(file, JSON.stringify({ v: 1, key, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return key;
}
