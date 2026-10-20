/**
 * Secrets that arrive as command-line flags: masking them for logs, and
 * resolving the webhook signing secret from its three sources.
 */

/** Flags whose value is a secret and must never be written to a log. */
export const SECRET_FLAGS = Object.freeze(["--auth", "--client-secret", "--webhook-secret"]);

/**
 * A copy of an argument list with every secret flag's value replaced by `***`.
 *
 * Handles both `--auth value` and `--auth=value`. The launcher for `-d` writes
 * its argument list into `daemon.log` ("starting daemon: ..."), and a bearer
 * token or signing secret has no business in a log that gets shipped or
 * attached to an issue.
 *
 * @param {string[]} args
 * @returns {string[]} a new array; the input is not modified
 */
export function maskSecretArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        const eq = a.indexOf("=");
        if (eq > 0 && SECRET_FLAGS.includes(a.slice(0, eq))) {
            out.push(`${a.slice(0, eq)}=***`);
        } else if (SECRET_FLAGS.includes(a) && i + 1 < args.length) {
            out.push(a, "***");
            i++;
        } else {
            out.push(a);
        }
    }
    return out;
}

/**
 * The webhook signing secret: the `--webhook-secret` flag, else the
 * `ZALO_WEBHOOK_SECRET[_<ownId>]` environment variable, else the MCP config's
 * `webhookSecret`. Null when none is set, which means unsigned webhooks.
 *
 * A flag that is present but empty throws instead of falling through: an
 * unset shell variable (`--webhook-secret "$SECRET"`) is how an empty value
 * arrives, and falling back to "no secret" would silently send unsigned
 * webhooks to a receiver that believes it is verifying signatures.
 *
 * @param {object} sources
 * @param {string|undefined} [sources.flag] - the parsed `--webhook-secret` value
 * @param {string|null|undefined} [sources.env] - the environment variable's value
 * @param {string|null|undefined} [sources.config] - `webhookSecret` from mcp-config.json
 * @returns {string|null}
 * @throws {Error} when the flag is given empty
 */
export function resolveWebhookSecret({ flag, env, config } = {}) {
    if (flag !== undefined) {
        const s = String(flag).trim();
        if (!s) {
            throw new Error(
                "--webhook-secret was given an empty secret. Refusing to start: webhooks would go out unsigned " +
                    "while the receiver expects signatures.",
            );
        }
        return s;
    }
    for (const v of [env, config]) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
}
