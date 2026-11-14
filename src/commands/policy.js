/**
 * `policy`: the runtime policy (src/core/policy-store.js): what a running server takes without a restart.
 *
 * - `policy get [key] [--tenant <id>|--user <id>]`: the account's (or a tenant's, or a user's) policy and its rev; with
 *   a key, that value. A user (`users/<userId>.json`) also has its membership: `tenant` and `accounts`, set with
 *   `policy set tenant <tenantId> --user <id>` and `policy set accounts <id,id> --user <id>`.
 * - `policy set <key> <value> [--tenant <id>] [--if-match <rev>]`: change one key.
 * - `policy unset <key> [--tenant <id>] [--if-match <rev>]`: remove one key (the lower layers apply again).
 * - `policy token [--rotate]`: the admin API's own credential (src/core/admin-api.js).
 *
 * A change goes through the account's running daemon (its channel), which applies it at once; with no daemon the file
 * is written and the next start reads it. A tenant's file is shared: every daemon whose account it lists picks a
 * change up through its watcher.
 *
 * CLI-only: an agent never changes its own policy (tests/unit/mcp-cli-parity.test.js).
 */
import { getActive } from "../core/accounts.js";
import { adminTokenStatus, rotateAdminToken } from "../core/admin-api.js";
import { getAccountDir } from "../core/credentials.js";
import { callViaDaemon } from "../core/daemon-channel.js";
import { PolicyError, applyPolicy, effectivePolicy, getPolicy, ownerOf, tenantsOf } from "../core/policy-store.js";
import { nestPolicy, parseCliValue, policyGet } from "../core/policy-schema.js";
import { error, info, output, success, warning } from "../utils/output.js";

/** A user's membership fields: not policy keys, set on the user's document beside its policy. */
const MEMBER_KEYS = ["tenant", "accounts"];

/** The target a command acts on: `--tenant <id>` or `--user <id>`, else the active (or `--account`) account. */
function targetOf(opts) {
    if (opts.tenant && opts.user) {
        error("Name a tenant or a user, not both.");
        process.exit(1);
    }
    if (opts.tenant) return { kind: "tenant", id: String(opts.tenant).trim() };
    if (opts.user) return { kind: "user", id: String(opts.user).trim() };
    const account = getActive();
    if (!account) {
        error("No active account. Please login first, or name a tenant with --tenant.");
        process.exit(1);
    }
    return { kind: "account", id: String(account.ownId) };
}

/** Print a refusal and exit 1. */
function fail(e) {
    error(e?.message ?? String(e));
    if (e?.restartRequired?.length)
        info(
            `restartRequired: ${e.restartRequired.join(", ")} (set in mcp-config.json, storage.json or .env, then restart)`,
        );
    if (e?.code === "CONFLICT") info(`The policy is at rev ${e.rev}: read it again (policy get) and repeat.`);
    process.exit(1);
}

/** Apply one patch: through the daemon when one holds the account, else to the file. */
async function change(target, patch, opts, member = {}) {
    const params = { target, op: "patch", policy: patch, ifMatch: opts.ifMatch ?? null, ...member };
    // A user's file is shared by every daemon of its accounts, which pick a change up through their watchers.
    if (target.kind === "user") {
        try {
            return { ...applyPolicy({ ...params, actor: "cli" }), via: "file" };
        } catch (e) {
            fail(e);
        }
    }
    // The account's own daemon applies it live; a tenant change goes through the active account's daemon when one
    // runs (the others see it through their watchers).
    const account = target.kind === "account" ? target.id : getActive()?.ownId;
    if (account) {
        const r = await callViaDaemon(getAccountDir(account), "/policy", params);
        if (r) {
            if (!r.ok) fail(Object.assign(new PolicyError(r.error, r.code ?? "INVALID"), r));
            return { ...r, via: "daemon" };
        }
    }
    try {
        return { ...applyPolicy({ ...params, actor: "cli" }), via: "file" };
    } catch (e) {
        fail(e);
    }
}

/**
 * Register the `policy` group.
 *
 * @param {import("commander").Command} program
 * @returns {import("commander").Command}
 */
export function registerPolicyCommands(program) {
    const policy = program
        .command("policy")
        .description("The runtime policy a running server takes without a restart (per account or per tenant)");

    const get = policy
        .command("get [key]")
        .description(
            "Show the account's (or a tenant's) policy and its rev; with a key (e.g. media.linkAuth), its value",
        )
        .option("--tenant <id>", "A tenant's policy instead of the account's")
        .option("--user <id>", "A user's policy and membership instead of the account's")
        .option("--effective", "The account's policy with its tenants' merged in (what the resolvers read)")
        .action((key, opts) => {
            const jsonMode = program.opts().json;
            const target = targetOf(opts);
            let doc;
            try {
                doc = getPolicy(target);
            } catch (e) {
                fail(e);
            }
            const shown = opts.effective && target.kind === "account" ? effectivePolicy(target.id) : doc.policy;
            const member = target.kind === "user" ? { tenant: doc.tenant ?? null, accounts: doc.accounts ?? [] } : {};
            const result = {
                target: `${target.kind}:${target.id}`,
                rev: doc.rev,
                updatedAt: doc.updatedAt,
                updatedBy: doc.updatedBy,
                ...(target.kind === "account"
                    ? { tenants: tenantsOf(target.id).map((t) => t.id), owner: ownerOf(target.id)?.id ?? null }
                    : {}),
                ...member,
                ...(key
                    ? { key, value: (MEMBER_KEYS.includes(key) ? member[key] : policyGet(shown, key)) ?? null }
                    : { policy: shown }),
            };
            output(result, jsonMode, () => {
                info(`${result.target}, rev ${doc.rev}${doc.updatedBy ? ` (${doc.updatedBy}, ${doc.updatedAt})` : ""}`);
                if (result.tenants?.length) info(`tenants: ${result.tenants.join(", ")}`);
                if (result.owner) info(`owner: user ${result.owner}`);
                if (target.kind === "user" && !key)
                    info(`tenant: ${result.tenant ?? "-"}; accounts: ${result.accounts.join(", ") || "-"}`);
                console.log(JSON.stringify(key ? result.value : shown, null, 2));
            });
        });

    const set = policy
        .command("set <key> <value>")
        .description(
            "Set one policy key (e.g. media.linkAuth bearer, presence.mode always-on); live on a running daemon",
        )
        .option("--tenant <id>", "A tenant's policy instead of the account's")
        .option("--user <id>", "A user's policy, or its membership (keys tenant, accounts)")
        .option("--if-match <rev>", "Only if the policy is still at this rev")
        .action(async (key, value, opts) => {
            const jsonMode = program.opts().json;
            const target = targetOf(opts);
            const member = MEMBER_KEYS.includes(key);
            if (member && target.kind !== "user") {
                error(`${key} is a user's membership: name the user with --user <id>.`);
                process.exit(1);
            }
            const r = member
                ? await change(target, {}, opts, { [key]: key === "accounts" ? String(value).split(",") : value })
                : await change(target, nestPolicy({ [key]: parseCliValue(value) }), opts);
            output(r, jsonMode, () => {
                if (!r.changed.length) info(`${r.target} is already so (rev ${r.rev}).`);
                else success(`${r.target} rev ${r.rev}: ${r.changed.join(", ")}`);
                for (const n of r.notes ?? []) info(n);
                for (const d of r.demoted ?? [])
                    warning(`always-on cap (${d.scope}, ${d.cap}): account ${d.accountId} is now on-demand`);
                if (r.via === "file") info("No daemon runs for this account: the next start reads it.");
            });
        });

    const unset = policy
        .command("unset <key>")
        .description("Remove one policy key: the files, the environment and the defaults apply again")
        .option("--tenant <id>", "A tenant's policy instead of the account's")
        .option("--user <id>", "A user's policy, or its accounts list")
        .option("--if-match <rev>", "Only if the policy is still at this rev")
        .action(async (key, opts) => {
            const jsonMode = program.opts().json;
            const target = targetOf(opts);
            if (key === "tenant") {
                error("A user belongs to exactly one tenant: set another one (policy set tenant <id> --user <id>).");
                process.exit(1);
            }
            const r =
                key === "accounts" && target.kind === "user"
                    ? await change(target, {}, opts, { accounts: [] })
                    : await change(target, nestPolicy({ [key]: null }), opts);
            output(r, jsonMode, () => {
                if (!r.changed.length) info(`${key} is not set in ${r.target} (rev ${r.rev}).`);
                else success(`${r.target} rev ${r.rev}: removed ${r.changed.join(", ")}`);
                for (const n of r.notes ?? []) info(n);
            });
        });

    const token = policy
        .command("token")
        .description("The admin API's own credential: whether one is set; --rotate makes a new one (shown once)")
        .option("--rotate", "Make a new admin token; the old one stops working at once")
        .action((opts) => {
            const jsonMode = program.opts().json;
            if (!opts.rotate) {
                let st;
                try {
                    st = adminTokenStatus();
                } catch (e) {
                    fail(e);
                }
                output(st, jsonMode, () =>
                    st.set
                        ? info(`An admin token is set (since ${st.createdAt}).`)
                        : info("No admin token is set: policy token --rotate"),
                );
                return;
            }
            let r;
            try {
                r = rotateAdminToken();
            } catch (e) {
                fail(e);
            }
            output(r, jsonMode, () => {
                success("New admin token (shown once; only its hash is kept):");
                console.log(r.token);
                warning("Give it to the admin console only, never to an agent: it changes limits and policy.");
            });
        });

    for (const cmd of [get, set, unset, token]) cmd.zaloLocalOnly = true;
    return policy;
}
