/**
 * An account's webhook signing secret set through the admin API (rotate, clear), kept sealed under the boot key in
 * `<accountDir>/webhook-secret.json`. It must be reused to sign, so it is sealed rather than hashed; it is returned
 * once, by {@link rotateWebhookSecret}, and never again.
 *
 * Where a running daemon's secret comes from, first found: the `--webhook-secret` flag, this file, then
 * `ZALO_WEBHOOK_SECRET[_<ownId>]`, then `webhookSecret` in mcp-config.json. The daemon asks at every POST
 * ({@link createWebhookSecretSource}), so a rotation signs the next delivery without a restart.
 */
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSealedJson, scopeOfDir, writeSealedJson } from "./keystore/index.js";

/** The file in the account folder. */
export const WEBHOOK_SECRET_FILE = "webhook-secret.json";
const SPEC = Object.freeze({ kind: "webhook-secret", use: "boot" });

/** @param {string} accountDir @returns {string} */
export function webhookSecretFile(accountDir) {
    return join(accountDir, WEBHOOK_SECRET_FILE);
}

/**
 * Make a new signing secret for the account (the old one stops signing at the next delivery).
 *
 * @param {string} accountDir
 * @param {{now?: number}} [opts]
 * @returns {{secret: string, rotatedAt: string}}
 */
export function rotateWebhookSecret(accountDir, { now = Date.now() } = {}) {
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    const rotatedAt = new Date(now).toISOString();
    writeSealedJson(webhookSecretFile(accountDir), scopeOfDir(accountDir), SPEC, { secret, rotatedAt });
    return { secret, rotatedAt };
}

/**
 * Remove the admin-set secret: the flag, the environment or the config sign again (or nothing).
 *
 * @param {string} accountDir
 * @returns {boolean} whether there was one
 */
export function clearWebhookSecret(accountDir) {
    const file = webhookSecretFile(accountDir);
    const had = existsSync(file);
    rmSync(file, { force: true });
    return had;
}

/**
 * The admin-set secret, or null.
 *
 * @param {string} accountDir
 * @returns {{secret: string, rotatedAt: string|null}|null}
 */
export function readWebhookSecret(accountDir) {
    const file = webhookSecretFile(accountDir);
    if (!existsSync(file)) return null;
    const doc = readSealedJson(file, scopeOfDir(accountDir), SPEC);
    return typeof doc?.secret === "string" && doc.secret
        ? { secret: doc.secret, rotatedAt: doc.rotatedAt ?? null }
        : null;
}

/**
 * Whether an admin-set secret exists, and since when. Never the secret.
 *
 * @param {string} accountDir
 * @returns {{set: boolean, rotatedAt: string|null}}
 */
export function webhookSecretStatus(accountDir) {
    try {
        const r = readWebhookSecret(accountDir);
        return { set: Boolean(r), rotatedAt: r?.rotatedAt ?? null };
    } catch {
        return { set: existsSync(webhookSecretFile(accountDir)), rotatedAt: null };
    }
}

/**
 * The secret a daemon signs with now: the flag, else the admin-set one (re-read when its file changes), else the
 * fallback (environment, then config).
 *
 * @param {object} args
 * @param {string|null} args.accountDir
 * @param {string|null} [args.flag] - `--webhook-secret`
 * @param {string|null} [args.fallback] - the environment's or the config's secret
 * @returns {() => string|null}
 */
export function createWebhookSecretSource({ accountDir, flag = null, fallback = null }) {
    let seen = null;
    let sealed = null;
    return () => {
        if (flag) return flag;
        if (accountDir) {
            let mark = null;
            try {
                const st = statSync(webhookSecretFile(accountDir));
                mark = `${st.mtimeMs}:${st.size}`;
            } catch {
                mark = null;
            }
            if (mark !== seen) {
                seen = mark;
                try {
                    sealed = mark ? (readWebhookSecret(accountDir)?.secret ?? null) : null;
                } catch (e) {
                    console.error(`[webhook] the admin-set webhook secret cannot be read (${e.message}); not used`);
                    sealed = null;
                }
            }
        }
        return sealed ?? fallback ?? null;
    };
}
