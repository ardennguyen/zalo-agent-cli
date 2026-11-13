/**
 * The one confirmation guard for destructive actions, shared by the CLI and the MCP server.
 *
 * Which actions are guarded follows Zalo Web's own confirm dialogs: leaving or breaking up a group, removing a
 * member or a friend, recalling or deleting a message, removing a reminder, closing a poll, and the like. Each
 * guarded action is one entry in GUARDS, and the sentence that says what it would do is built there once, so
 * `group leave` on the command line and `zalo_group leave` over MCP refuse, preview and ask in the same words.
 *
 * - CLI: a guarded command acts only with `-y, --yes`; `--dry-run` reports what would happen and sends nothing
 *   (exit 0); without either nothing is sent and the command exits 2 (CONFIRM_EXIT_CODE), so a script can tell
 *   "not confirmed" from "failed" (1). There is no global off switch.
 * - MCP: a guarded action takes `confirm: true` to act and `dryRun: true` to preview. What `confirm` means
 *   depends on the deployment's confirm mode (resolveConfirmMode): `agent` (the caller's confirm: true is
 *   enough), `human` (the server asks the person through MCP form elicitation, or else on a one-time approve page,
 *   src/core/secure-page.js, whose `ticket` the repeated call carries; the caller cannot answer for them), or `off`
 *   (no question). `zalo_write` runs raw endpoints and is guarded even when the mode is `off`. Where the approve page's
 *   link goes and what it asks besides a click are the deployment's `approval.deliver` and `approval.secret`
 *   (src/core/approval.js).
 */
import { error, info } from "../utils/output.js";
import { askOnSecurePage, getSecurePage } from "./secure-page.js";
import { approverFor } from "./approval.js";
import { resolveApproval } from "./deploy-policy.js";
import { policyFor } from "./policy-layer.js";

/** What an unconfirmed guarded CLI command exits with: distinct from a failure (1). */
export const CONFIRM_EXIT_CODE = 2;

/** The deployment-wide MCP confirm modes. */
export const CONFIRM_MODES = Object.freeze(["agent", "human", "off"]);

/** Up to five ids, then a count: the sentence stays readable for a long list. */
function ids(list) {
    const all = (Array.isArray(list) ? list : [list]).filter((v) => v !== undefined && v !== null).map(String);
    if (all.length <= 5) return all.join(", ");
    return `${all.slice(0, 5).join(", ")} and ${all.length - 5} more`;
}

/** "1 member" / "3 members", for the sentences below. */
const count = (list, one) => {
    const n = Array.isArray(list) ? list.length : 1;
    return `${n} ${one}${n === 1 ? "" : "s"}`;
};

/**
 * Every guarded action. `cli` and `mcp` name the command and the tool action that run it (null where one
 * surface has none); `what(target)` finishes the sentence "this would …"; `irreversible` (or a function of the
 * target) says whether the action can be taken back.
 */
export const GUARDS = Object.freeze({
    "group.leave": {
        cli: "group leave",
        mcp: "zalo_group leave",
        irreversible: true,
        what: (t) =>
            `leave group ${t.groupId}${t.silent ? " silently (the owner still sees it)" : ""}` +
            (t.newOwner
                ? `, handing ownership to ${t.newOwner} first`
                : t.randomOwner
                  ? ", letting Zalo give ownership to a random member"
                  : ""),
    },
    "group.removeMember": {
        cli: "group remove-member",
        mcp: "zalo_group remove_member",
        irreversible: true,
        what: (t) => `remove ${count(t.userIds, "member")} (${ids(t.userIds)}) from group ${t.groupId}`,
    },
    "group.removeAdmin": {
        cli: "group remove-admin",
        mcp: "zalo_group remove_admin",
        irreversible: false,
        what: (t) => `take admin rights away from ${ids(t.userIds)} in group ${t.groupId}`,
    },
    "group.transferOwner": {
        cli: "group transfer-owner",
        mcp: "zalo_group transfer_owner",
        irreversible: true,
        what: (t) => `make ${t.userId} the owner of group ${t.groupId}; this account stops being its owner`,
    },
    "group.disperse": {
        cli: "group disperse",
        mcp: "zalo_group disperse",
        irreversible: true,
        what: (t) =>
            `disband group ${t.groupId} for every member` +
            (Number.isFinite(t.others) ? ` (${t.others} other member(s) lose it too)` : ""),
    },
    "group.disableLink": {
        cli: "group disable-link",
        mcp: "zalo_group disable_link",
        irreversible: true,
        what: (t) => `turn off group ${t.groupId}'s invite link; the current link stops working for good`,
    },
    "group.settings": {
        cli: "group settings",
        mcp: "zalo_group settings",
        irreversible: false,
        what: (t) =>
            t.approvalOff
                ? `turn off membership approval in group ${t.groupId}, so anyone with the link joins without approval`
                : `change the settings of group ${t.groupId}`,
    },
    "group.blockMember": {
        cli: "group block-member",
        mcp: "zalo_group block_member",
        irreversible: false,
        what: (t) => `block ${ids(t.userIds)} from group ${t.groupId}; they cannot rejoin until unblocked`,
    },
    "friend.remove": {
        cli: "friend remove",
        mcp: "zalo_friend remove",
        irreversible: true,
        what: (t) => `unfriend ${t.userId}; becoming friends again takes a new friend request`,
    },
    "friend.block": {
        cli: "friend block",
        mcp: "zalo_friend block",
        irreversible: false,
        what: (t) => `block ${t.userId}: they can no longer message or call this account`,
    },
    "friend.reject": {
        cli: "friend reject",
        mcp: "zalo_friend reject",
        irreversible: true,
        what: (t) => `reject the friend request from ${t.userId}`,
    },
    "friend.undoRequest": {
        cli: "friend undo-request",
        mcp: "zalo_friend undo",
        irreversible: false,
        what: (t) => `cancel the friend request this account sent to ${t.userId}`,
    },
    "msg.undo": {
        cli: "msg undo",
        mcp: "zalo_undo",
        irreversible: true,
        what: (t) => `recall message ${t.msgId} for everyone in conversation ${t.threadId}`,
    },
    "msg.delete": {
        cli: "msg delete",
        mcp: "zalo_delete_message",
        irreversible: true,
        what: (t) =>
            t.everyone
                ? `delete message ${t.msgId} for everyone in group ${t.threadId}`
                : `delete message ${t.msgId} in conversation ${t.threadId} from this account's view`,
    },
    "conv.delete": {
        cli: "conv delete",
        mcp: "zalo_conversation delete",
        irreversible: true,
        what: (t) => `delete the history of conversation ${t.threadId} on Zalo, for this account`,
    },
    "conv.hiddenPinReset": {
        cli: "conv hidden-pin-reset",
        mcp: "zalo_conversation hidden_pin_reset",
        irreversible: true,
        what: () =>
            "remove the PIN that protects this account's hidden conversations and, as Zalo Web does, delete every " +
            "hidden conversation's history for this account",
    },
    "conv.unhide": {
        cli: "conv unhide",
        mcp: "zalo_conversation unhide",
        irreversible: false,
        what: (t) => `unhide ${count(t.threadIds, "conversation")} (${ids(t.threadIds)}): they show without the PIN`,
    },
    "conv.forget": {
        cli: "conv forget",
        mcp: "zalo_conversation forget",
        irreversible: true,
        what: (t) =>
            `delete this machine's copy of ${t.orphans ? "every orphaned conversation" : `conversation ${t.threadId}`} ` +
            "(messages, board items, reminders and downloaded media); Zalo is not contacted",
    },
    "poll.lock": {
        cli: "poll lock",
        mcp: "zalo_poll lock",
        irreversible: true,
        what: (t) => `close poll ${t.pollId}; nobody can vote on it any more`,
    },
    "reminder.remove": {
        cli: "reminder remove",
        mcp: "zalo_reminder remove",
        irreversible: true,
        what: (t) => `remove reminder ${t.reminderId} from conversation ${t.threadId}`,
    },
    "label.update": {
        cli: "label update",
        mcp: "zalo_label update",
        irreversible: (t) => Boolean(t.removedLabels?.length),
        what: (t) =>
            t.removedLabels?.length
                ? `remove ${count(t.removedLabels, "label")} (${ids(t.removedLabels)}) and their conversation ` +
                  "assignments, and save the rest of the label list"
                : "replace the label list (no label is removed)",
    },
    "catalog.delete": {
        cli: "catalog delete",
        mcp: "zalo_catalog delete",
        irreversible: true,
        what: (t) => `delete catalog ${t.catalogId} and every product in it`,
    },
    "catalog.deleteProduct": {
        cli: "catalog delete-product",
        mcp: "zalo_catalog delete_product",
        irreversible: true,
        what: (t) => `delete ${count(t.productIds, "product")} (${ids(t.productIds)}) from catalog ${t.catalogId}`,
    },
    "cloud.delete": {
        cli: "cloud apply",
        mcp: "zalo_cloud apply",
        irreversible: true,
        what: (t) =>
            `delete the chat message behind each of ${t.items ?? 0} zCloud item(s) (${t.size ?? "0 B"}) in ` +
            `${t.conversations ?? 0} conversation(s), for this account on every device, so the cloud drops them`,
    },
    "bank.remove": {
        cli: "bank remove",
        mcp: "zalo_bank remove",
        irreversible: true,
        what: (t) => `remove saved bank account ${t.bankAccountId} from this Zalo account`,
    },
    "autoReply.delete": {
        cli: "auto-reply delete",
        mcp: "zalo_auto_reply delete",
        irreversible: true,
        what: (t) => `delete auto-reply ${t.autoReplyId}`,
    },
    "quickMsg.remove": {
        cli: "quick-msg remove",
        mcp: "zalo_quick_message remove",
        irreversible: true,
        what: (t) => `remove ${count(t.quickMessageIds, "quick message")} (${ids(t.quickMessageIds)})`,
    },
    "profile.deleteAvatar": {
        cli: "profile delete-avatar",
        mcp: "zalo_profile delete_avatar",
        irreversible: true,
        what: (t) => `delete ${count(t.photoIds, "photo")} (${ids(t.photoIds)}) from this account's avatar history`,
    },
    logout: {
        cli: "logout",
        mcp: null,
        irreversible: true,
        what: (t) => {
            const who = t.account ? `account ${t.account}` : "the active account";
            const remote =
                t.remote === false ? "" : t.keepSession ? "end its session at Zalo and " : "sign it out at Zalo and ";
            const local = t.purge
                ? "delete its saved credentials and all its local data (chat cache, media, sync keys)"
                : t.deleteHistory
                  ? "delete its saved credentials and its local chat history"
                  : "delete its saved credentials";
            return `log out ${who}: ${remote}${local}; the next command needs a new QR login`;
        },
    },
    "account.remove": {
        cli: "account remove",
        mcp: null,
        irreversible: true,
        what: (t) =>
            `remove account ${t.ownerId} from this machine: end its session if it is the active one, and delete ` +
            "its credentials and all its local data (chat cache, media, sync keys)",
    },
    "account.export": {
        cli: "account export",
        mcp: null,
        irreversible: false,
        what: (t) =>
            `write the saved login of account ${t.ownerId ?? "(active)"} in plaintext to ${t.output ?? "a file"}: ` +
            "anyone who reads that file can use the account",
    },
    "db.exportPlaintext": {
        cli: "db export --plaintext",
        mcp: null,
        irreversible: false,
        what: (t) =>
            `write the message database of account ${t.ownerId ?? "(active)"} decrypted to ${t.output ?? "a file"}: ` +
            "anyone who reads that file reads every cached message in it" +
            (t.includeHidden
                ? ", hidden chats included (after the PIN)"
                : "; hidden chats are left out unless --include-hidden and the PIN"),
    },
    "db.purge": {
        cli: "db purge",
        mcp: null,
        irreversible: true,
        what: (t) =>
            `delete what the quota and retention rules of account ${t.ownerId ?? "(active)"} make due: the oldest ` +
            "downloaded media, then the oldest messages (with their search entries), and dead webhook deliveries past " +
            "retention.outboxDead; purged messages are never restored by a later sync or history fetch",
    },
    "fleet.purge": {
        cli: "fleet purge",
        mcp: null,
        irreversible: true,
        what: (t) =>
            `run the quota and retention purge for ${t.accounts ?? "every account on this machine"}: here under ` +
            "daemon.lock for an account with no daemon, through its daemon for one whose purge timer is behind; " +
            "the oldest downloaded media, then the oldest messages, where a rule makes them due, and dead webhook " +
            "deliveries past retention.outboxDead; purged messages are never restored by a later sync",
    },
    "webhook.purge": {
        cli: "mcp webhook purge",
        mcp: null,
        irreversible: true,
        what: (t) =>
            `delete ${t.seq !== undefined ? `dead-lettered webhook event #${t.seq}` : "every dead-lettered webhook event"} ` +
            `of account ${t.account ?? "the active account"} for good`,
    },
    "presence.resume": {
        cli: "presence resume",
        mcp: "zalo_profile presence_resume",
        irreversible: false,
        what: (t) =>
            `take account ${t.ownerId ?? "(active)"} back from the other session of this login: its daemon opens the ` +
            "socket again, which ends that other session's socket if it is still open",
    },
    "write.run": {
        cli: "write run",
        mcp: "zalo_write",
        irreversible: (t) => t.risk === "destructive",
        what: (t) =>
            `send the "${t.name}" write to Zalo (${t.risk ?? "unknown risk"}` +
            `${t.verified === false ? ", not yet seen working" : ""})`,
    },
});

/**
 * The parts every reply about one guarded action shares.
 *
 * @param {string} key - a GUARDS key
 * @param {object} target - the ids the action would act on
 * @param {"cli"|"mcp"} surface - which name to report the action by
 * @returns {{action: string, wouldDo: string, target: object, irreversible: boolean}}
 */
export function describeGuarded(key, target = {}, surface = "cli") {
    const guard = GUARDS[key];
    if (!guard) throw new Error(`unknown guarded action "${key}"`);
    const irreversible = typeof guard.irreversible === "function" ? guard.irreversible(target) : guard.irreversible;
    return { action: guard[surface] ?? guard.cli, wouldDo: guard.what(target), target, irreversible };
}

/** "remove X — this cannot be undone": the sentence a person reads. */
function sentence(d) {
    return `${d.wouldDo}${d.irreversible ? " — this cannot be undone" : ""}`;
}

/**
 * The machine-readable refusal of an unconfirmed guarded action (CLI `--json` stdout, and the MCP error reply).
 * `error` comes first, so a caller testing `.error` sees the refusal like any other failure.
 *
 * @param {string} key
 * @param {object} target
 * @param {"cli"|"mcp"} surface
 * @returns {object}
 */
export function confirmationRefusal(key, target, surface = "cli") {
    const d = describeGuarded(key, target, surface);
    return {
        error: `Not done: confirmation needed: ${d.wouldDo}`,
        confirmationRequired: true,
        action: d.action,
        wouldDo: d.wouldDo,
        target: d.target,
        irreversible: d.irreversible,
        retryWith: surface === "mcp" ? { confirm: true } : "--yes",
    };
}

/**
 * The one line a person reads when a guarded action was not confirmed.
 *
 * @param {string} key
 * @param {object} target
 * @param {"cli"|"mcp"} surface
 * @returns {string}
 */
export function refusalLine(key, target, surface = "cli") {
    const d = describeGuarded(key, target, surface);
    const retry =
        surface === "mcp"
            ? "Repeat the call with confirm: true, or dryRun: true to preview."
            : "Re-run with --yes, or --dry-run to preview.";
    return `Not done: this would ${sentence(d)}. ${retry}`;
}

/**
 * What a dry run of a guarded action reports: what would happen, and that nothing was sent.
 *
 * @param {string} key
 * @param {object} target
 * @param {"cli"|"mcp"} surface
 * @returns {object}
 */
export function dryRunReport(key, target, surface = "cli") {
    const d = describeGuarded(key, target, surface);
    return { dryRun: true, sent: false, ...d };
}

/**
 * The labels a label update would remove: those in the current list whose id the new list leaves out. A label
 * update sends the whole list, so dropping one from it deletes the label (and its conversation assignments);
 * only that case is guarded.
 *
 * @param {Array<{id?: unknown, text?: unknown}>|null|undefined} current - `labelData` as getLabels returns it
 * @param {Array<{id?: unknown}>|null|undefined} next - the `labelData` about to be sent
 * @returns {string[]} each removed label as "<id> (<text>)"
 */
export function removedLabels(current, next) {
    const kept = new Set((Array.isArray(next) ? next : []).map((l) => String(l?.id)));
    return (Array.isArray(current) ? current : [])
        .filter((l) => l && l.id !== undefined && !kept.has(String(l.id)))
        .map((l) => (l.text ? `${l.id} (${l.text})` : String(l.id)));
}

// --- CLI ---

/**
 * Settle a guarded CLI command before it acts: true to go ahead; otherwise this prints the dry run (exit 0)
 * or the refusal (exit CONFIRM_EXIT_CODE) and ends the process, having sent nothing.
 *
 * @param {string} key - a GUARDS key
 * @param {object} target - the ids the command would act on
 * @param {{yes?: boolean, dryRun?: boolean}} opts - the command's own options
 * @param {object} [how]
 * @param {boolean} [how.json] - `--json`: one JSON value on stdout
 * @param {boolean} [how.applies=true] - false when this invocation is not the guarded case (it goes ahead)
 * @param {boolean} [how.ownDryRun=false] - the command implements `--dry-run` itself: let it through
 * @returns {true}
 */
export function gateCli(key, target, opts = {}, { json = false, applies = true, ownDryRun = false } = {}) {
    if (opts.dryRun) {
        if (ownDryRun) return true;
        const report = dryRunReport(key, target, "cli");
        if (json) console.log(JSON.stringify(report, null, 2));
        else info(`Dry run: this would ${sentence(report)}. Nothing was sent.`);
        process.exit(0);
    }
    if (opts.yes || !applies) return true;
    refuseCli(key, target, { json });
    return true; // not reached: refuseCli exits
}

/**
 * Print the refusal of an unconfirmed guarded command and exit CONFIRM_EXIT_CODE. For a command that checks
 * its own arguments first (`write run`) and so cannot be settled by gateCli before its action.
 *
 * @param {string} key
 * @param {object} target
 * @param {{json?: boolean}} [how]
 */
export function refuseCli(key, target, { json = false } = {}) {
    if (json) console.log(JSON.stringify(confirmationRefusal(key, target, "cli"), null, 2));
    else error(refusalLine(key, target, "cli"));
    process.exit(CONFIRM_EXIT_CODE);
}

/**
 * Make a CLI command a guarded one: add `-y, --yes` and `--dry-run` and record how to settle it, which the
 * preAction hook (src/index.js) does through enforceCliGuard before any login or request.
 *
 * @param {import("commander").Command} command
 * @param {string} key - a GUARDS key
 * @param {object} spec
 * @param {(...argsThenOpts: any[]) => object} spec.target - the target, from the command's arguments and options
 * @param {(target: object, opts: object) => boolean} [spec.when] - only this case is guarded (default: always)
 * @param {boolean} [spec.ownDryRun] - the command already has `--dry-run` and implements it
 * @param {boolean} [spec.deferred] - the action settles it itself with gateCli (it needs a read first)
 * @returns {import("commander").Command} the command, for chaining
 */
export function guardCommand(command, key, spec) {
    if (!GUARDS[key]) throw new Error(`unknown guarded action "${key}"`);
    command.option("-y, --yes", "Do it: without this nothing is sent (exit 2)");
    if (!spec.ownDryRun) command.option("--dry-run", "Say what would happen, and send nothing");
    command.zaloGuard = { key, ...spec };
    return command;
}

/**
 * guardCommand for a subcommand named after it was registered, so a command file can list its guarded
 * commands in one place.
 *
 * @param {import("commander").Command} parent - e.g. the `group` command
 * @param {string} name - the subcommand's name, e.g. "leave"
 * @param {string} key - a GUARDS key
 * @param {object} spec - as for guardCommand
 * @returns {import("commander").Command} the subcommand
 */
export function guardSubcommand(parent, name, key, spec) {
    const command = parent.commands.find((c) => c.name() === name);
    if (!command) throw new Error(`no "${parent.name()} ${name}" command to guard`);
    return guardCommand(command, key, spec);
}

/**
 * The preAction half of guardCommand: settle a guarded command from its parsed arguments, before the session
 * is touched. A command that is not guarded, or settles itself (`deferred`), goes ahead untouched.
 *
 * @param {import("commander").Command} command - the command about to run
 * @param {{json?: boolean}} [how]
 */
export function enforceCliGuard(command, { json = false } = {}) {
    const guard = command?.zaloGuard;
    if (!guard || guard.deferred) return;
    const opts = command.opts();
    const target = guard.target(...(command.processedArgs ?? []), opts);
    const applies = guard.when ? guard.when(target, opts) : true;
    gateCli(guard.key, target, opts, { json, applies, ownDryRun: guard.ownDryRun });
}

// --- MCP ---

const ON = ["1", "true", "on", "yes"];
const OFF = ["0", "false", "off", "no"];
const warned = new Set();

/**
 * The deployment's MCP confirm mode, and where it came from.
 *
 * Highest first: the live policy (`confirmMode` in the account's or its tenant's policy), `ZALO_MCP_CONFIRM_MODE_<ownId>`, `ZALO_MCP_CONFIRM_MODE`, `confirmMode` in mcp-config.json, then the deprecated aliases
 * `ZALO_MCP_GROUP_CONFIRM` (`0`/`false`/`off`/`no` mean `off`, `1`/`true`/`on`/`yes` mean `agent`) and
 * `groupConfirm: false` (means `off`). The environment wins over the file, as for every other setting, and an
 * explicit confirm mode wins over either alias. A value that is not a mode is reported once and skipped; with
 * nothing set the mode is `agent`.
 *
 * @param {object} [sources]
 * @param {{confirmMode?: unknown, groupConfirm?: unknown}|null} [sources.config] - the loaded MCP config
 * @param {NodeJS.ProcessEnv} [sources.env] - environment, process.env by default
 * @param {string} [sources.accountId] - the account served, for the per-account variable
 * @returns {{mode: "agent"|"human"|"off", source: string}}
 */
export function resolveConfirmMode({ config, env = process.env, accountId, policy } = {}) {
    const scoped = accountId ? `ZALO_MCP_CONFIRM_MODE_${accountId}` : null;
    const norm = (v) =>
        String(v ?? "")
            .trim()
            .toLowerCase();
    // The live policy (src/core/policy-store.js) is above the environment.
    const live = policy === undefined ? policyFor(accountId) : policy;
    for (const [value, source] of [
        [live?.confirmMode, "policy:confirmMode"],
        ...(scoped ? [[env?.[scoped], scoped]] : []),
        [env?.ZALO_MCP_CONFIRM_MODE, "ZALO_MCP_CONFIRM_MODE"],
        [config?.confirmMode, "confirmMode"],
    ]) {
        const mode = norm(value);
        if (!mode) continue;
        if (CONFIRM_MODES.includes(mode)) return { mode, source };
        if (!warned.has(`${source}=${mode}`)) {
            warned.add(`${source}=${mode}`);
            console.error(`[confirm] ${source} "${value}" is not agent, human or off; ignoring it`);
        }
    }
    const alias = norm(env?.ZALO_MCP_GROUP_CONFIRM);
    if (OFF.includes(alias)) return { mode: "off", source: "ZALO_MCP_GROUP_CONFIRM" };
    if (ON.includes(alias)) return { mode: "agent", source: "ZALO_MCP_GROUP_CONFIRM" };
    if (config?.groupConfirm === false) return { mode: "off", source: "groupConfirm" };
    return { mode: "agent", source: "default" };
}

/** An MCP error reply: the JSON fields first, then the line a person reads. */
function mcpError(payload, line) {
    return {
        content: [
            { type: "text", text: JSON.stringify(payload) },
            { type: "text", text: line },
        ],
        isError: true,
    };
}

/**
 * How `human` mode asks over the HTTP transport. That transport is stateless: every POST gets a fresh server
 * (src/mcp/mcp-http-transport.js), so the server answering a tool call never saw the client's `initialize` and cannot
 * ask it anything, and an answer would arrive as a new POST that a fresh server cannot match to the waiting call. So
 * the question goes to the one-time approve page (src/core/secure-page.js) instead: the reply carries its link, the
 * person approves there, and the agent repeats the call with `ticket`.
 */
export const STATELESS_HUMAN_NOTE =
    "this call came over the stateless HTTP transport, so the question is a one-time approve page instead of an " +
    "MCP elicitation";

/** How long the server waits for a person to answer an elicitation. */
export const ELICIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Settle a guarded MCP action: null to go ahead, otherwise the reply to return instead (a dry-run report, or
 * an error that says why nothing was done). Call it after the arguments are checked and the ids resolved, and
 * before anything is sent.
 *
 * @param {string} key - a GUARDS key
 * @param {object} target - the ids the action would act on
 * @param {object} call
 * @param {boolean} [call.confirm] - the caller's `confirm`
 * @param {boolean} [call.dryRun] - the caller's `dryRun`
 * @param {object} [call.config] - the MCP config, for resolveConfirmMode
 * @param {NodeJS.ProcessEnv} [call.env]
 * @param {string} [call.accountId] - the account served, for `ZALO_MCP_CONFIRM_MODE_<ownId>`
 * @param {object} [call.server] - the McpServer, whose `.server` asks the person in `human` mode
 * @param {object} [call.extra] - the tool call's request context, so the question rides on its request
 * @param {boolean} [call.applies=true] - false when this call is not the guarded case (it goes ahead)
 * @param {boolean} [call.always=false] - guarded even when the mode is `off` (zalo_write)
 * @param {boolean} [call.stateless=false] - the call came over the stateless HTTP transport, where no question can
 *   be answered in the call: the approve page is used (see STATELESS_HUMAN_NOTE)
 * @param {string} [call.ticket] - the caller's `ticket` from an approve page (human mode)
 * @param {import("./secure-page.js").SecurePage} [call.securePage] - the process's page (getSecurePage())
 * @param {string|null} [call.accountDir] - the account folder, for the approver password (approval.secret)
 * @param {() => import("./hidden-chats.js").HiddenChats} [call.hidden] - the hidden set, for approval.secret "pin"
 * @returns {Promise<object|null>}
 */
export async function gateMcp(
    key,
    target,
    {
        confirm,
        dryRun,
        config,
        env = process.env,
        accountId,
        server,
        extra,
        applies = true,
        always = false,
        stateless = false,
        ticket,
        securePage,
        accountDir = null,
        hidden = null,
    } = {},
) {
    if (dryRun === true) {
        const report = dryRunReport(key, target, "mcp");
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
    }
    if (!applies) return null;
    let { mode } = resolveConfirmMode({ config, env, accountId });
    if (mode === "off" && always) mode = "agent";
    if (mode === "off") return null;
    if (mode === "agent") {
        if (confirm === true) return null;
        return mcpError(confirmationRefusal(key, target, "mcp"), refusalLine(key, target, "mcp"));
    }

    // human: only the person's own answer counts; the caller's confirm does not stand in for it.
    const d = describeGuarded(key, target, "mcp");
    const page = securePage ?? getSecurePage();
    const expect = { accountId: accountId ?? "", action: key, target };
    if (ticket !== undefined && ticket !== null && ticket !== "") {
        const used = page.store.consume(String(ticket), expect);
        if (used.ok) return null;
        const why = `Not done: ${used.message} Nothing was sent: ${d.wouldDo}.`;
        return mcpError({ error: why, ticketRefused: used.reason, confirmMode: "human", ...d }, why);
    }
    const asker = stateless ? null : server?.server;
    const elicitation = asker?.getClientCapabilities?.()?.elicitation;
    if (!elicitation?.form) {
        // No form question possible here (stateless HTTP, or a client without form elicitation): the approve page.
        const approval = resolveApproval({ config, env, accountId });
        let asked;
        try {
            asked = await askOnSecurePage({
                page,
                server,
                extra,
                stateless,
                needs: "confirmationRequired",
                spec: {
                    accountId: expect.accountId,
                    action: key,
                    target,
                    kind: "confirm",
                    title: "Approve a Zalo action",
                    description: `${d.action} would ${sentence(d)}.`,
                },
                retryWith: {},
                deliver: approval.deliver,
                approver: (throughAgent) => approverFor({ mode: approval.secret, throughAgent, accountDir, hidden }),
                about: { action: d.action, wouldDo: d.wouldDo, target },
            });
        } catch (e) {
            const why = `Not done: the approve page could not be opened (${e.message}), so nothing was sent: ${d.wouldDo}.`;
            return mcpError({ error: why, confirmMode: "human", ...d }, why);
        }
        if (asked.token) {
            const used = page.store.consume(asked.token, expect);
            if (used.ok) return null;
            const why = `Not done: ${used.message} Nothing was sent: ${d.wouldDo}.`;
            return mcpError({ error: why, declined: true, confirmMode: "human", ...d }, why);
        }
        if (asked.error) {
            const why = `Not done: ${asked.error} Nothing was sent: ${d.wouldDo}.`;
            return mcpError({ error: why, confirmMode: "human", ...d }, why);
        }
        if (asked.declined) {
            const why =
                `Not done: the user did not complete the approve page (${asked.declined}), so nothing was sent: ` +
                `${d.wouldDo}. Do not repeat the call unless the user asks for it again.`;
            return mcpError({ error: why, declined: true, confirmMode: "human", ...d }, why);
        }
        const payload = {
            ...asked.reply,
            confirmMode: "human",
            ...(stateless && { statelessTransport: true }),
            ...d,
        };
        const asks =
            `Not done yet: confirmMode "human" asks the account owner before it would ${sentence(d)}` +
            `${stateless ? `; ${STATELESS_HUMAN_NOTE}` : ""}.`;
        const line = payload.secureUrl
            ? `${asks} Give them this one-time link to approve: ${payload.secureUrl} (expires ` +
              `${payload.ticketExpiresAt}), then repeat the call with ticket.`
            : `${asks} The approve page went to the deployment's approval channel (webhook); once the owner ` +
              `approves (before ${payload.ticketExpiresAt}), repeat the call with ticket.`;
        return mcpError(payload, line);
    }
    let answer;
    try {
        answer = await asker.elicitInput(
            {
                mode: "form",
                message: `Zalo: ${d.action} would ${sentence(d)}. Go ahead?`,
                requestedSchema: {
                    type: "object",
                    properties: {
                        confirm: {
                            type: "boolean",
                            title: "Yes, do it",
                            description: `Do it: ${d.wouldDo}`,
                            default: false,
                        },
                    },
                    required: ["confirm"],
                },
            },
            {
                timeout: ELICIT_TIMEOUT_MS,
                ...(extra?.requestId !== undefined && { relatedRequestId: extra.requestId }),
            },
        );
    } catch (e) {
        const why = `Not done: asking you to confirm failed (${e.message}), so nothing was sent: ${d.wouldDo}.`;
        return mcpError({ error: why, confirmMode: "human", ...d }, why);
    }
    if (answer?.action === "accept" && answer.content?.confirm === true) return null;
    const why =
        `Not done: the user did not confirm (${answer?.action === "accept" ? "answered no" : (answer?.action ?? "no answer")}), ` +
        `so nothing was sent: ${d.wouldDo}. Do not repeat the call unless the user asks for it again.`;
    return mcpError({ error: why, declined: true, confirmMode: "human", ...d }, why);
}
