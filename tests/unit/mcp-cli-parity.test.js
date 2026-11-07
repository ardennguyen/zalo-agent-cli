/**
 * Every personal CLI command has an MCP action, or is on the CLI-only list below with its reason.
 *
 * The owner's rule for 3.0: an agent on the MCP server can do whatever the personal CLI can. This walks the commander
 * tree the way tests/unit/docs-contract.test.js does (every `register*` that src/index.js calls, plus the inline
 * commands) and the tools `registerTools` registers, and fails when:
 * - a personal command is neither mapped to an MCP tool (and action) nor listed as CLI-only;
 * - a mapping names a tool that does not exist, or an action (an `action`, a zalo_read/zalo_write `name`, a zalo_sync
 *   `stage`) that tool does not take;
 * - a mapped or CLI-only command no longer exists, so the lists cannot rot.
 * Official Account commands (`oa …`) are out of scope: they are a separate, official API.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { tool } from "./support/mcp-send-harness.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** Personal command -> [MCP tool, its action (or read/write name, or sync stage) when the tool has several]. */
const MCP_FOR = {
    whoami: ["zalo_lookup_user"],
    "msg search": ["zalo_search_messages"],
    "msg send": ["zalo_send_message"],
    "msg send-image": ["zalo_send_message"],
    "msg send-file": ["zalo_send_message"],
    "msg send-card": ["zalo_send_message"],
    "msg send-bank": ["zalo_send_message"],
    "msg send-qr-transfer": ["zalo_send_message"],
    "msg sticker": ["zalo_send_message"],
    "msg send-voice": ["zalo_send_message"],
    "msg send-link": ["zalo_send_message"],
    "msg send-video": ["zalo_send_message"],
    "msg sticker-list": ["zalo_sticker", "search"],
    "msg sticker-detail": ["zalo_sticker", "detail"],
    "msg sticker-category": ["zalo_read", "sticker-category"],
    "msg react": ["zalo_react"],
    "msg delete": ["zalo_delete_message"],
    "msg undo": ["zalo_undo"],
    "msg forward": ["zalo_forward_message"],
    "msg pin": ["zalo_note", "pin_message"],
    "msg unpin": ["zalo_note", "unpin_message"],
    "msg history": ["zalo_get_history"],
    "msg media": ["zalo_view_media"],
    "msg typing": ["zalo_conversation", "typing"],
    "msg seen": ["zalo_conversation", "seen"],
    "msg report": ["zalo_conversation", "report"],
    "msg link-preview": ["zalo_link", "preview"],
    "msg scan-url": ["zalo_link", "scan"],
    "friend list": ["zalo_friend", "list"],
    "friend online": ["zalo_friend", "online"],
    "friend search": ["zalo_search_threads"],
    "friend find": ["zalo_lookup_user"],
    "friend info": ["zalo_lookup_user"],
    "friend add": ["zalo_friend", "send"],
    "friend accept": ["zalo_friend", "accept"],
    "friend remove": ["zalo_friend", "remove"],
    "friend block": ["zalo_friend", "block"],
    "friend unblock": ["zalo_friend", "unblock"],
    "friend last-online": ["zalo_friend", "last_online"],
    "friend find-username": ["zalo_lookup_user"],
    "friend alias": ["zalo_friend", "alias"],
    "friend alias-list": ["zalo_friend", "alias_list"],
    "friend alias-remove": ["zalo_friend", "alias"],
    "friend reject": ["zalo_friend", "reject"],
    "friend undo-request": ["zalo_friend", "undo"],
    "friend sent-requests": ["zalo_friend", "sent_requests"],
    "friend request-status": ["zalo_friend", "status"],
    "friend close": ["zalo_friend", "close"],
    "friend recommendations": ["zalo_friend", "received_requests"],
    "friend find-phones": ["zalo_friend", "find_phones"],
    "friend qr": ["zalo_friend", "qr"],
    "friend common-groups": ["zalo_friend", "common_groups"],
    "friend biz": ["zalo_friend", "biz"],
    "friend block-feed": ["zalo_friend", "block_feed"],
    "group list": ["zalo_list_threads"],
    "group create": ["zalo_group", "create"],
    "group info": ["zalo_group", "info"],
    "group history": ["zalo_get_history"],
    "group members": ["zalo_get_group_members"],
    "group add-member": ["zalo_group", "add_members"],
    "group remove-member": ["zalo_group", "remove_member"],
    "group rename": ["zalo_group", "rename"],
    "group leave": ["zalo_group", "leave"],
    "group note-create": ["zalo_note", "create"],
    "group note-edit": ["zalo_note", "edit"],
    "conv recent": ["zalo_list_conversations"],
    "account status": ["zalo_read", "account-status"],
    "account devices": ["zalo_profile", "devices"],
    "profile me": ["zalo_lookup_user"],
    "poll create": ["zalo_poll", "create"],
    "poll info": ["zalo_poll", "info"],
    "poll vote": ["zalo_poll", "vote"],
    "poll unvote": ["zalo_poll", "unvote"],
    "poll add-option": ["zalo_poll", "add_options"],
    "poll lock": ["zalo_poll", "lock"],
    "poll share": ["zalo_poll", "share"],
    "reminder create": ["zalo_reminder", "create"],
    "reminder list": ["zalo_reminder", "list"],
    "reminder info": ["zalo_reminder", "info"],
    "reminder responses": ["zalo_reminder", "responses"],
    "reminder edit": ["zalo_reminder", "edit"],
    "reminder remove": ["zalo_reminder", "remove"],
    "label list": ["zalo_label", "list"],
    "label update": ["zalo_label", "update"],
    "read list": ["zalo_read"],
    "read run": ["zalo_read"],
    "write list": ["zalo_write"],
    "write run": ["zalo_write"],
    "bank list": ["zalo_bank", "banks"],
    "mcp wait": ["zalo_wait_for_message"],
    "mcp mark-read": ["zalo_mark_read"],
    sync: ["zalo_sync", "messages"],
    "sync-mobile": ["zalo_sync", "messages"],
    "sync-reactions": ["zalo_sync", "reactions"],
    "sync-media": ["zalo_sync", "media"],
    "sync-boards": ["zalo_sync", "boards"],
    "sync-cloud": ["zalo_sync", "cloud"],
    "cloud ls": ["zalo_cloud", "summary"],
    "cloud plan": ["zalo_cloud", "plan"],
    "cloud apply": ["zalo_cloud", "apply"],
};

/**
 * Whole groups whose subcommands map one to one onto a tool's actions, the CLI name with `_` for `-`: listed by group
 * so a new subcommand there needs its action (or an entry above) and nothing else.
 */
const BY_NAME = {
    group: "zalo_group",
    conv: "zalo_conversation",
    profile: "zalo_profile",
    "auto-reply": "zalo_auto_reply",
    "quick-msg": "zalo_quick_message",
    catalog: "zalo_catalog",
    bank: "zalo_bank",
};

/** Personal commands that stay CLI-only, and why. Mirrored in skill/references/mcp-guide.md. */
const CLI_ONLY = {
    login: "logging in is a QR scan by the owner; the MCP server serves an account already logged in",
    logout: "ends the session the MCP server itself runs on",
    status: "local login state; zalo_lookup_user `self` reads the account",
    "account list": "the accounts on this machine: the server serves one",
    "account login": "a QR login, as `login`",
    "account switch": "the server serves one account; switching is a restart",
    "account remove": "deletes the account's credentials and data on this machine",
    "account info": "local account registry",
    "account export": "exports credentials: never handed to an agent",
    "account security status":
        "how this machine protects the account's files at rest: an operator's question, not an agent's; it names local paths and the key provider",
    "account security migrate": "seals this machine's files at rest: an operator's step, run once after an upgrade",
    "account security rekey": "replaces the keys protecting this machine's files: an operator's step, never an agent's",
    "account security provider": "moves the account's keys to another key store on this machine: an operator's step",
    "db query":
        "raw SQL over the cache (hidden chats only with the PIN): an operator's or a bot's tool on the machine; agents read through zalo_get_history / zalo_search_messages",
    "db backup": "writes a copy of the encrypted database to a path on this machine: an operator's step",
    "db export": "writes the database to a path on this machine, decrypted with --plaintext: never handed to an agent",
    "db verify":
        "a full integrity scan of the cache: an operator's check; the actions an agent takes already check the row they act on",
    "policy get": "reads the runtime policy an operator or console sets: an agent never sees or changes its own limits",
    "policy set":
        "changes the runtime policy (limits, confirm mode, links): never an agent's, so it cannot raise its own",
    "policy unset": "changes the runtime policy: never an agent's, so it cannot lift its own limits",
    "policy token": "makes the admin API's own credential: an operator's step, never handed to an agent",
    "db usage":
        "this machine's storage report for an operator; an agent sees the same numbers in zalo_profile status (storage)",
    "db purge":
        "deletes cached data for good under the quota and retention rules: an operator's step, never an agent's",
    "profile lost-focus": "a client-presence signal, meaningless for a server",
    listen: "the MCP server is itself the listener (zalo_get_messages, zalo_wait_for_message)",
    "mcp start": "starts the MCP server",
    "mcp webhook status": "operates the webhook outbox of the daemon, from the machine",
    "mcp webhook list": "operates the webhook outbox of the daemon, from the machine",
    "mcp webhook retry": "operates the webhook outbox of the daemon, from the machine",
    "mcp webhook purge": "operates the webhook outbox of the daemon, from the machine",
    "mcp approver": "sets the human approver's password: an agent must never hold or change it",
    "fleet ports": "manages several daemons on the machine",
    "fleet status": "manages several daemons on the machine",
    "fleet start": "manages several daemons on the machine",
    "fleet stop": "manages several daemons on the machine",
    "fleet restart": "manages several daemons on the machine",
    "fleet generate": "writes service files on the machine",
    update: "updates the installed package",
    "cloud get":
        "needs the account's cloud key (a secret derived from the owner's PIN), which must never pass through an agent or a tool input",
};

let leaves;
before(async () => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    const src = readFileSync(resolve(ROOT, "src/index.js"), "utf8");
    const imports = [...src.matchAll(/import \{ (register\w+) \} from "(\.\/commands\/[\w-]+\.js)";/g)];
    const calls = new Set([...src.matchAll(/^(register\w+)\(program\);/gm)].map((m) => m[1]));
    const program = new Command();
    for (const [, name, file] of imports) {
        if (!calls.has(name)) continue;
        (await import(pathToFileURL(resolve(ROOT, "src", file)).href))[name](program);
    }
    leaves = [...src.matchAll(/^\s*\.command\("([\w-]+)"\)/gm)].map((m) => m[1]);
    const walk = (cmd, path) => {
        for (const c of cmd.commands) {
            const p = [...path, c.name()];
            if (c.commands.length) walk(c, p);
            else leaves.push(p.join(" "));
        }
    };
    walk(program, []);
    leaves = leaves.filter((l) => l !== "oa" && !l.startsWith("oa "));
});

const { tools } = tool();

/** The input that picks a tool's action: `action`, zalo_read/zalo_write's `name`, or zalo_sync's `stage`. */
function selector(name) {
    const props = z.toJSONSchema(tools.get(name).meta.inputSchema, { io: "input", unrepresentable: "any" }).properties;
    for (const key of ["action", "name", "stage"]) if (props?.[key]?.enum) return { key, values: props[key].enum };
    return null;
}

/** The MCP target of a personal command, from the explicit map or its group's one-to-one tool. */
function targetOf(leaf) {
    if (CLI_ONLY[leaf]) return null;
    if (MCP_FOR[leaf]) return MCP_FOR[leaf];
    const [group, sub] = leaf.split(" ");
    if (sub && BY_NAME[group]) return [BY_NAME[group], sub.replace(/-/g, "_")];
    return null;
}

describe("every personal CLI command has an MCP action, or a reason it has none", () => {
    it("walks a plausible tree", () => {
        assert.ok(leaves.length > 180, `only ${leaves.length} personal commands`);
    });

    it("maps or excludes every personal command", () => {
        const unmapped = leaves.filter((l) => !targetOf(l) && !CLI_ONLY[l]);
        assert.deepEqual(unmapped, [], "add an MCP action for it, or a CLI_ONLY entry with the reason");
    });

    it("maps each one to a tool that exists, and an action that tool takes", () => {
        const bad = [];
        for (const leaf of leaves) {
            const t = targetOf(leaf);
            if (!t) continue;
            const [name, action] = t;
            if (!tools.has(name)) {
                bad.push(`${leaf} -> ${name} (no such tool)`);
                continue;
            }
            if (action === undefined) continue;
            const sel = selector(name);
            if (!sel || !sel.values.includes(action)) bad.push(`${leaf} -> ${name} ${action} (no such action)`);
        }
        assert.deepEqual(bad, []);
    });

    it("lists only commands that exist, and never one both ways", () => {
        const known = new Set(leaves);
        const stale = [...Object.keys(MCP_FOR), ...Object.keys(CLI_ONLY)].filter((l) => !known.has(l));
        assert.deepEqual(stale, [], "a renamed or removed command is still listed here");
        assert.deepEqual(
            Object.keys(CLI_ONLY).filter((l) => MCP_FOR[l]),
            [],
            "a CLI-only command must not also have an MCP mapping",
        );
    });
});
