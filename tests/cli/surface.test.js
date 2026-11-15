/**
 * CLI surface contract — every command group, every subcommand, and the
 * flags that change behavior rather than just formatting.
 *
 * COMMAND_SURFACE below is the machine-checkable twin of
 * skill/references/command-reference.md. When a subcommand is added,
 * renamed or removed, this suite fails until the manifest is updated —
 * which is the cue to update the docs listed in AGENTS.md §10 too.
 *
 * Runs entirely offline against a throwaway HOME, so no Zalo session is
 * needed and the real ~/.zalo-agent-cli/ is never read.
 *
 * One test per group, nested path and rule, each checking every line of its
 * manifest and naming every missing command or flag at once.
 */

import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/cli.js";
import { checkCli, runCliFast } from "../helpers/cli-fast.js";

// The `--help` runs go through the in-process CLI worker (tests/helpers/cli-fast.js): one module load for the
// whole suite instead of ~60 child processes. A result that fails a check is confirmed in a real child before the
// test fails, and `--version` is always a real child. The timeout is generous for that real-child path on a busy
// machine: a genuine regression here shows up as a missing command, not as a slow one.
const opts = { home: SANDBOX_HOME, timeout: 90_000 };

/** group → subcommands it must register. */
const COMMAND_SURFACE = {
    msg: [
        "send",
        "send-image",
        "send-file",
        "send-card",
        "send-bank",
        "send-qr-transfer",
        "sticker",
        "send-voice",
        "send-link",
        "send-video",
        "sticker-list",
        "sticker-detail",
        "sticker-category",
        "typing",
        "report",
        "link-preview",
        "scan-url",
        "react",
        "delete",
        "undo",
        "forward",
        "pin",
        "unpin",
        "history",
        "search",
        "media",
    ],
    friend: [
        "list",
        "online",
        "search",
        "find",
        "info",
        "add",
        "accept",
        "remove",
        "block",
        "unblock",
        "last-online",
        "find-username",
        "alias",
        "alias-list",
        "alias-remove",
        "reject",
        "undo-request",
        "sent-requests",
        "request-status",
        "close",
        "recommendations",
        "find-phones",
        "qr",
        "common-groups",
        "biz",
        "block-feed",
    ],
    group: [
        "list",
        "create",
        "info",
        "history",
        "members",
        "add-member",
        "remove-member",
        "rename",
        "avatar",
        "add-admin",
        "remove-admin",
        "transfer-owner",
        "block-member",
        "unblock-member",
        "upgrade-community",
        "leave",
        "join",
        "members-info",
        "settings",
        "pending",
        "approve",
        "reject-member",
        "enable-link",
        "disable-link",
        "link-info",
        "blocked",
        "note-create",
        "note-edit",
        "invite-boxes",
        "join-invite",
        "delete-invite",
        "invite-to",
        "disperse",
        "link-preview",
        "invite-info",
    ],
    conv: [
        "forget",
        "recent",
        "pinned",
        "pin",
        "unpin",
        "archived",
        "archive",
        "unarchive",
        "mute",
        "unmute",
        "read",
        "unread",
        "hidden",
        "hide",
        "unhide",
        "hidden-pin",
        "hidden-pin-reset",
        "auto-delete-status",
        "auto-delete",
        "delete",
        "muted",
    ],
    account: ["list", "login", "switch", "remove", "info", "export", "devices", "security"],
    profile: [
        "me",
        "avatar",
        "bio",
        "update",
        "settings",
        "avatars",
        "full-avatar",
        "avatar-url",
        "delete-avatar",
        "reuse-avatar",
        "set",
        "active",
        "lang",
        "lost-focus",
    ],
    poll: ["create", "info", "vote", "unvote", "add-option", "lock", "share"],
    reminder: ["create", "list", "info", "responses", "edit", "remove"],
    "auto-reply": ["list", "create", "update", "delete"],
    "quick-msg": ["list", "add", "update", "remove"],
    label: ["list", "update"],
    cloud: ["ls", "plan", "apply", "get", "key"],
    bank: ["list", "accounts", "add", "update", "remove"],
    catalog: [
        "list",
        "create",
        "rename",
        "delete",
        "products",
        "product",
        "add-product",
        "update-product",
        "delete-product",
        "upload-photo",
        "register",
    ],
    mcp: ["start", "wait", "mark-read", "webhook", "approver"],
    fleet: ["ports", "status", "start", "stop", "restart", "generate", "serve"],
    presence: ["status", "wake", "park"],
    session: ["renew"],
    oa: [
        "login",
        "refresh",
        "setup",
        "whoami",
        "msg",
        "upload",
        "conv",
        "quota",
        "follower",
        "userfield",
        "tag",
        "form",
        "purchase",
        "article",
        "group",
        "call",
        "listen",
        "init",
    ],
    // ZBS Template Message (official API).
    zbs: ["template", "upload-image", "send", "rsa-key", "journey", "uid", "status", "quota", "quality"],
    social: ["setup", "login", "refresh", "me", "status", "logout"],
};

/** Nested OA and ZBS subgroups: "oa msg" → its subcommands. */
const OA_SUBGROUPS = {
    "oa msg": ["text", "image", "gif", "file", "sticker", "request-info", "react", "anonymous", "user-quota"],
    "oa upload": ["image", "file", "gif"],
    "oa conv": ["recent", "history"],
    "oa follower": ["info", "list", "update", "delete-info", "custom-info", "custom-update"],
    "oa userfield": ["list", "create", "update", "delete"],
    "oa tag": ["list", "assign", "untag", "remove"],
    "oa form": ["get"],
    "oa purchase": ["create-order", "confirm-order"],
    "oa article": ["create", "verify", "update", "remove", "list", "detail", "video-upload", "video-status"],
    "oa group": [
        "create",
        "info",
        "update",
        "avatar",
        "update-asset",
        "invite",
        "pending",
        "accept",
        "reject",
        "members",
        "add-admins",
        "remove-admins",
        "remove-members",
        "delete",
        "list",
        "recent",
        "history",
        "send",
        "quota",
    ],
    "oa call": ["consent-request", "consent-check", "outbound", "inbound", "mcc-info"],
    "zbs template": ["list", "detail", "sample", "create", "update", "rating", "quick-reply"],
    "zbs rsa-key": ["create", "get"],
    "zbs journey": ["token", "check", "send"],
};

/** Nested subgroups of `mcp`: "mcp webhook" → its subcommands. */
const MCP_SUBGROUPS = {
    "mcp webhook": ["status", "list", "retry", "purge"],
};

/** Nested subgroups of `account`: the at-rest protection of the account's files (docs/security.md). */
const ACCOUNT_SUBGROUPS = {
    "account security": ["status", "migrate", "rekey", "provider"],
};

/** Nested subgroup of `cloud`: the cloud key and the device that fetches it from the phone. */
const CLOUD_SUBGROUPS = {
    "cloud key": ["status", "forget", "devices", "setup"],
};

/** Commands registered directly on the program, not inside a group. */
const TOP_LEVEL = [
    "update",
    "login",
    "logout",
    "status",
    "whoami",
    "listen",
    "sync",
    "sync-mobile",
    "sync-media",
    "sync-reactions",
    "sync-boards",
    "sync-cloud",
    ...Object.keys(COMMAND_SURFACE),
];

/** Flags whose absence would silently change behavior. */
const FLAG_CONTRACT = {
    login: [
        "--proxy",
        "--name",
        "--qr-url",
        "--qr-port",
        "--public-url",
        "--credentials",
        "--sync",
        "--no-sync",
        "--sync-days",
        "--verbose",
    ],
    logout: ["--purge", "--delete-history", "--no-remote"],
    "sync-mobile": [
        "--transfer",
        "--socket",
        "--force",
        "--days",
        "--from",
        "--wait",
        "--messages-only",
        "--shard-size",
    ],
    // The fetch/board/cloud passes are deliberately separate commands: only
    // the message restore needs a phone confirmation, so none of these
    // should ever be reachable only via sync-mobile.
    // The DESTRUCTIVE flags were the uncovered ones: --prune deletes
    // downloaded media, --prune-orphans deletes it for conversations the
    // account no longer has. --dry-run was listed; the operations it exists
    // to preview were not.
    "sync-media": [
        "--thread",
        "--kind",
        "--limit",
        "--days",
        "--concurrency",
        "--max-size",
        "--timeout",
        "--thumbs",
        "--dry-run",
        "--prune",
        "--all",
        "--prune-orphans",
        "--all-history",
        "--include-pruned",
    ],
    // `conv forget` deletes this machine's local copy of a conversation and
    // had no entry at all.
    "conv forget": ["--orphans", "--dry-run"],
    sync: [
        "--force",
        "--days",
        "--from",
        "--wait",
        "--no-messages",
        "--no-reactions",
        "--no-conv-state",
        "--no-boards",
        "--no-cloud",
        "--no-media",
        "--no-removals",
        "--plan",
        "--shard-size",
    ],
    "sync-reactions": ["--wait", "--pages", "--no-removals"],
    "sync-boards": ["--thread", "--limit", "--concurrency", "--no-reminders", "--no-boards"],
    "sync-cloud": ["--pages", "--page-size", "--resume"],
    "msg send": ["--type", "--mention", "--quote", "--style", "--md", "--react", "--urgency"],
    "msg react": ["--cli-msg-id", "--type"],
    "msg pin": ["--type"],
    "msg unpin": ["--type"],
    "msg send-qr-transfer": ["--bank", "--amount", "--content", "--template", "--type"],
    "msg send-bank": ["--bank", "--name", "--type"],
    "msg undo": ["--cli-msg-id", "--type"],
    // The two deletes are different operations and must stay separately
    // addressable: `msg delete` is one-sided (onlyMe), `msg undo` recalls
    // for everyone. --cli-msg-id is required by both because Zalo's
    // deleteMessage/undo both key on it.
    "msg delete": ["--cli-msg-id", "--uid-from", "--everyone", "--type"],
    "msg history": ["--limit", "--scan", "--from-msg-id", "--timeout", "--no-cache", "--type"],
    "msg search": [
        "--thread",
        "--from",
        "--since",
        "--until",
        "--last",
        "--type",
        "--limit",
        "--cursor",
        "--context",
        "--exact",
    ],
    "conv mute": ["--duration", "--type"],
    "msg typing": ["--type"],
    "msg report": ["--reason", "--content", "--type"],
    "friend block-feed": ["--unblock"],
    "bank list": ["--query"],
    "bank accounts": ["--page", "--limit"],
    "bank add": ["--bank", "--name"],
    "bank update": ["--bank", "--name"],
    "conv recent": ["--limit", "--friends-only", "--groups-only"],
    // --type picks the payload: seenv2 and the conversation ids differ for a
    // group ("g<id>", type 1) and a DM ("u<id>", type 0).
    "conv read": ["--type"],
    "conv pin": ["--type"],
    "conv unpin": ["--type"],
    "conv archive": ["--type"],
    "conv unarchive": ["--type"],
    "group list": ["--query"],
    "group link-preview": ["--member-page"],
    "group invite-info": ["--member-page", "--member-count"],
    "group leave": ["--silent"],
    "group settings": [
        "--block-name",
        "--no-block-name",
        "--sign-admin",
        "--no-sign-admin",
        "--msg-history",
        "--join-appr",
        "--lock-post",
        "--lock-poll",
        "--lock-msg",
        "--lock-view-member",
        "--topic-only",
        "--no-topic-only",
    ],
    "group note-create": ["--pin"],
    "group delete-invite": ["--block"],
    "account login": ["--proxy", "--name", "--qr-url", "--public-url"],
    "account export": ["--output"],
    "account security status": ["--all"],
    "account security migrate": ["--all"],
    "account security provider": ["--scope", "--backend", "--key", "--with-key", "--passphrase-file"],
    "poll create": ["--multi", "--add-options", "--anonymous", "--hide-preview", "--expire"],
    "reminder create": ["--type", "--time", "--emoji", "--repeat"],
    "reminder list": ["--type", "--count", "--page"],
    "auto-reply create": ["--enable", "--no-enable", "--start", "--end", "--scope", "--uids"],
    // --no-delivered-receipts is the opt-out for the automatic deliveredv2
    // acks both listeners send, and --no-self-heal the opt-out for the
    // offline-queue catch-up both run on reconnect; each must exist on both
    // or they diverge.
    listen: [
        "--account",
        "--events",
        "message,friend,group,reaction,read",
        "--filter",
        "--webhook",
        "--webhook-secret",
        "--no-self",
        "--auto-accept",
        "--save",
        "--no-delivered-receipts",
        "--no-self-heal",
        "--daemon",
        "--stop",
        "--status",
    ],
    "mcp start": [
        "--account",
        "--config",
        "--http",
        "--auth",
        "--host",
        "--cert",
        "--key",
        "--client-id",
        "--client-secret",
        "--public-url",
        "--issuer-url",
        "--webhook",
        "--webhook-secret",
        "--no-delivered-receipts",
        "--no-self-heal",
        "--daemon",
        "--stop",
        "--status",
    ],
    "mcp wait": ["--account", "--since", "--thread", "--timeout", "--consumer"],
    "mcp mark-read": ["--account", "--consumer"],
    "mcp approver": ["--account", "--stdin"],
    "catalog add-product": ["--photos"],
    "cloud apply": ["--yes", "--dry-run", "--conv", "--type", "--older-than", "--larger-than", "--limit"],
    "cloud get": ["--out", "--key-stdin", "--key-prompt", "--raw"],
    "cloud key setup": ["--confirm", "--slot", "--wait", "--dry-run"],
    "cloud key forget": ["--device", "--key"],
    "msg send-video": ["--thumb", "--width", "--height", "--duration", "--upload-timeout"],
    "friend add": ["--msg"],
    "profile update": ["--name", "--dob", "--gender"],
};

/** Whether `help` lists `name` as a command: anchored to a line start, so `list` doesn't match `alias-list`. */
const lists = (help, name) => new RegExp(`^\\s+${name.replace(/[-]/g, "\\-")}\\b`, "m").test(help);

/**
 * Whether `help` registers `flag` in the option COLUMN.
 *
 * This used to be `helps[cmd].includes(flag)` — an unanchored substring
 * search over the entire help text, descriptions included. Commander
 * prose mentions other flags constantly: `sync-mobile`'s description
 * names --socket, `--from`'s description says "Overrides
 * --days". So deleting the real `-t, --transfer` registration left this
 * contract green, which is the exact regression it exists to catch. A
 * listed `--prune` was also satisfied by `--prune-orphans`.
 */
const registered = (help, flag) => new RegExp(`^\\s+(?:-\\w, )?${flag.replace(/-/g, "\\-")}\\b`, "m").test(help);

/**
 * `<path> --help` must exit 0 and list every name in `names` (as `has` reads it). Every name is checked and the
 * failure lists all that are missing at once. The help runs in the in-process CLI worker; a failing result is
 * confirmed in a real child process before it fails the test (tests/helpers/cli-fast.js).
 */
async function assertHelpLists(path, names, has, what) {
    await checkCli([...path, "--help"], opts, (r) => {
        assert.equal(r.code, 0, `${path.join(" ")} --help exited ${r.code}\n${r.all}`);
        const missing = names.filter((n) => !has(r.stdout, n));
        assert.deepEqual(missing, [], `${path.join(" ") || "the program"} is missing ${what}: ${missing.join(", ")}`);
    });
}

describe("program surface", () => {
    it("prints usage and every global flag without a Zalo session", async () => {
        const GLOBAL = ["--json", "--version", "--account", "--env-file", "--config-dir", "--credentials-dir"];
        GLOBAL.push("--data-dir", "--media-dir", "--oa-dir");
        await checkCli(["--help"], opts, (r) => {
            assert.equal(r.code, 0);
            assert.match(r.stdout, /Usage: zalo-agent/);
            assert.match(r.stdout, /-V, --version/);
            assert.match(r.stdout, /--account <id>/);
            assert.match(r.stdout, /--env-file <path>/);
            const missing = GLOBAL.filter((f) => !registered(r.stdout, f));
            assert.deepEqual(missing, [], `global flags missing: ${missing.join(", ")}`);
        });
    });

    it(`registers all ${TOP_LEVEL.length} top-level commands`, async () => {
        await assertHelpLists([], TOP_LEVEL, lists, "top-level command(s)");
    });

    it("--version prints a semver string, a pre-release suffix allowed (a real process)", async () => {
        // The one real spawn of this suite: the binary itself starts and answers.
        const { code, stdout } = await runCli(["--version"], opts);
        assert.equal(code, 0);
        assert.match(stdout.trim(), /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    });

    it("exits non-zero on an unknown command and on an unknown option", async () => {
        for (const argv of [["definitely-not-a-command"], ["status", "--not-a-real-flag"]]) {
            await checkCli(argv, opts, (r) => assert.notEqual(r.code, 0, `${argv.join(" ")} exited 0`));
        }
    });
});

describe("command groups", () => {
    for (const [group, subs] of Object.entries(COMMAND_SURFACE)) {
        it(`${group} --help exits 0 and registers all ${subs.length} subcommands`, async () => {
            await assertHelpLists([group], subs, lists, "subcommand(s)");
        });
    }
});

describe("nested subgroups", () => {
    const NESTED = { ...OA_SUBGROUPS, ...MCP_SUBGROUPS, ...ACCOUNT_SUBGROUPS, ...CLOUD_SUBGROUPS };
    for (const [path, subs] of Object.entries(NESTED)) {
        it(`${path} --help exits 0 and registers all ${subs.length} subcommands`, async () => {
            await assertHelpLists(path.split(" "), subs, lists, "subcommand(s)");
        });
    }
});

describe("flag contract", () => {
    it(`all ${Object.keys(FLAG_CONTRACT).length} commands register every documented flag`, async () => {
        const failures = [];
        for (const [cmd, flags] of Object.entries(FLAG_CONTRACT)) {
            try {
                await assertHelpLists(cmd.split(" "), flags, registered, "flag(s)");
            } catch (e) {
                failures.push(e.message.split("\n")[0]);
            }
        }
        assert.deepEqual(
            failures,
            [],
            `${failures.length} command(s) break the flag contract:\n${failures.join("\n")}`,
        );
    });

    // Guard the guard: prove the matcher can actually fail. A contract that
    // cannot distinguish a registered flag from a mentioned one is worth
    // nothing, and that is precisely the state this suite was in.
    it("the matchers reject a flag only MENTIONED in prose and a command only contained in another", async () => {
        const help = (await runCliFast(["sync-mobile", "--help"], opts)).stdout;
        assert.ok(registered(help, "--transfer"), "--transfer is really registered on sync-mobile");
        assert.ok(!registered(help, "--definitely-not-a-flag"), "an absent flag must not match");
        // --days appears inside --from's description text; make sure the
        // matcher is keying on the option column, not that mention.
        assert.ok(/Overrides --days|--days/.test(help), "precondition: sync-mobile help mentions --days in prose");
        // The subcommand matcher keys on the line start: `list` is not satisfied by `alias-list`.
        assert.ok(!lists("  alias-list   List aliases", "list"));
        assert.ok(lists("  list   List friends", "list"));
    });
});

describe("disclaimer behavior", () => {
    it("warns about the unofficial API on a personal-account command", async () => {
        await checkCli(["status"], opts, ({ all }) => assert.match(all, /unofficial Zalo APIs/));
    });

    it("suppresses the disclaimer for oa commands (official API)", async () => {
        await checkCli(["oa", "--help"], opts, ({ all, code }) => {
            assert.equal(code, 0);
            assert.doesNotMatch(all, /unofficial Zalo APIs/);
        });
    });

    it("social, an official API: no disclaimer and no personal-account login (it runs with no session)", async () => {
        // Red if `social` is treated as a personal command: the disclaimer prints and the auto-login fails first.
        await checkCli(["social", "status", "--profile", "surface-test"], opts, ({ all }) => {
            assert.doesNotMatch(all, /unofficial Zalo APIs/);
            assert.match(all, /No user login for profile "surface-test"/);
        });
    });

    it("suppresses the disclaimer in --json mode so stdout stays parseable", async () => {
        await checkCli(["--json", "status"], opts, ({ stdout }) => {
            assert.doesNotMatch(stdout, /unofficial Zalo APIs/);
            assert.equal(typeof JSON.parse(stdout.trim()), "object");
        });
    });
});

describe("clean-state behavior (no credentials present)", () => {
    it("account list reports no accounts", async () => {
        await checkCli(["account", "list"], opts, ({ all }) => assert.match(all, /No accounts/i));
    });

    it("status reports loggedIn:false with a null active account", async () => {
        await checkCli(["--json", "status"], opts, ({ stdout }) => {
            const data = JSON.parse(stdout.trim());
            assert.equal(data.loggedIn, false);
            assert.equal(data.activeAccount, null);
        });
    });

    it("a command needing a session fails with a pointer to `login`", async () => {
        await checkCli(["whoami"], opts, ({ all, code }) => {
            assert.match(all, /Not logged in\. Run: zalo-agent login/);
            // It used to print the ✗ and exit 0, so a script checking the exit code
            // read "no profile" as success (seen live 2026-09-30 after a logout).
            assert.equal(code, 1, "no profile is a failure");
        });
    });
});
