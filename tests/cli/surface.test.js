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
 */

import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/cli.js";

// This suite fans out ~40 `node src/index.js … --help` subprocesses through
// Promise.all, and each one pays full CLI startup. On a machine already busy
// (a parallel lint/format pass, CI running other jobs) the slowest of that
// batch can exceed a tight budget and fail for reasons that say nothing about
// the command surface. 90s is generous on purpose — a genuine regression here
// shows up as a missing command, not as a slow one.
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
        "react",
        "delete",
        "undo",
        "forward",
        "history",
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
    ],
    conv: [
        "recent",
        "pinned",
        "archived",
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
    ],
    account: ["list", "login", "switch", "remove", "info", "export", "devices"],
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
    ],
    poll: ["create", "info", "vote", "unvote", "add-option", "lock", "share"],
    reminder: ["create", "list", "info", "responses", "edit", "remove"],
    "auto-reply": ["list", "create", "update", "delete"],
    "quick-msg": ["list", "add", "update", "remove"],
    label: ["list", "update"],
    catalog: [
        "list",
        "create",
        "rename",
        "delete",
        "products",
        "add-product",
        "update-product",
        "delete-product",
        "upload-photo",
    ],
    mcp: ["start"],
    oa: [
        "login",
        "refresh",
        "setup",
        "whoami",
        "msg",
        "follower",
        "tag",
        "upload",
        "conv",
        "menu",
        "article",
        "store",
        "listen",
        "init",
    ],
};

/** Nested OA subgroups: "oa msg" → its subcommands. */
const OA_SUBGROUPS = {
    "oa msg": ["text", "image", "file", "list", "status"],
    "oa follower": ["info", "list", "update"],
    "oa tag": ["list", "assign", "remove", "untag"],
    "oa upload": ["image", "file"],
    "oa conv": ["recent", "history"],
    "oa article": ["create", "list", "detail"],
    "oa store": ["product-create", "product-list", "product-info", "category-create", "category-list", "order-create"],
};

/** Commands registered directly on the program, not inside a group. */
const TOP_LEVEL = [
    "update",
    "login",
    "logout",
    "status",
    "whoami",
    "listen",
    "sync-mobile",
    "sync-media",
    "sync-boards",
    "sync-cloud",
    ...Object.keys(COMMAND_SURFACE),
];

/** Flags whose absence would silently change behavior. */
const FLAG_CONTRACT = {
    login: ["--proxy", "--name", "--qr-url", "--qr-port", "--credentials"],
    logout: ["--purge", "--delete-history", "--no-remote"],
    "sync-mobile": ["--transfer", "--force", "--days", "--from", "--legacy", "--wait", "--messages-only"],
    // The fetch/board/cloud passes are deliberately separate commands: only
    // the message restore needs a phone confirmation, so none of these
    // should ever be reachable only via sync-mobile.
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
    ],
    "sync-boards": ["--thread", "--limit", "--concurrency", "--no-reminders", "--no-boards"],
    "sync-cloud": ["--pages", "--page-size", "--resume"],
    "msg send": ["--type", "--mention", "--style", "--md", "--react"],
    "msg send-qr-transfer": ["--bank", "--amount", "--content", "--template", "--type"],
    "msg send-bank": ["--bank", "--name", "--type"],
    "msg undo": ["--cli-msg-id", "--type"],
    // The two deletes are different operations and must stay separately
    // addressable: `msg delete` is one-sided (onlyMe), `msg undo` recalls
    // for everyone. --cli-msg-id is required by both because Zalo's
    // deleteMessage/undo both key on it.
    "msg delete": ["--cli-msg-id", "--uid-from", "--everyone", "--type"],
    "msg history": ["--limit", "--scan", "--from-msg-id", "--timeout", "--no-cache", "--type"],
    "conv mute": ["--duration", "--type"],
    "conv recent": ["--limit", "--friends-only", "--groups-only"],
    "group list": ["--query"],
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
    ],
    "group note-create": ["--pin"],
    "group delete-invite": ["--block"],
    "account login": ["--proxy", "--name", "--qr-url"],
    "account export": ["--output"],
    "poll create": ["--multi", "--add-options", "--anonymous", "--hide-preview", "--expire"],
    "reminder create": ["--type", "--time", "--emoji", "--repeat"],
    "auto-reply create": ["--enable", "--no-enable", "--start", "--end", "--scope", "--uids"],
    listen: ["--filter", "--webhook", "--no-self", "--auto-accept", "--save"],
    "mcp start": ["--config", "--http", "--auth", "--host"],
    "catalog add-product": ["--photos"],
    "friend add": ["--msg"],
    "profile update": ["--name", "--dob", "--gender"],
};

describe("program surface", () => {
    let root;
    before(async () => {
        root = (await runCli(["--help"], opts)).stdout;
    });

    it("prints usage without a Zalo session", () => {
        assert.match(root, /Usage: zalo-agent/);
    });

    it("exposes --json and --version globally", () => {
        assert.match(root, /--json/);
        assert.match(root, /-V, --version/);
    });

    for (const cmd of TOP_LEVEL) {
        it(`registers top-level command: ${cmd}`, () => {
            assert.match(root, new RegExp(`^\\s+${cmd.replace(/[-]/g, "\\-")}\\b`, "m"));
        });
    }

    it("--version prints a semver string", async () => {
        const { stdout } = await runCli(["--version"], opts);
        assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
    });

    it("exits non-zero on an unknown command", async () => {
        const r = await runCli(["definitely-not-a-command"], opts);
        assert.notEqual(r.code, 0);
    });

    it("exits non-zero on an unknown option", async () => {
        const r = await runCli(["status", "--not-a-real-flag"], opts);
        assert.notEqual(r.code, 0);
    });
});

describe("command groups", () => {
    const helps = {};

    before(async () => {
        const groups = Object.keys(COMMAND_SURFACE);
        const results = await Promise.all(groups.map((g) => runCli([g, "--help"], opts)));
        groups.forEach((g, i) => (helps[g] = results[i].stdout));
    });

    for (const [group, subs] of Object.entries(COMMAND_SURFACE)) {
        describe(`${group} subcommands`, () => {
            for (const sub of subs) {
                it(`registers ${group} ${sub}`, () => {
                    // Anchor to line start so `list` doesn't match `alias-list`.
                    assert.match(helps[group], new RegExp(`^\\s+${sub.replace(/[-]/g, "\\-")}\\b`, "m"));
                });
            }

            it(`${group} --help exits 0`, () => {
                assert.ok(helps[group].length > 0);
            });
        });
    }
});

describe("oa nested subgroups", () => {
    const helps = {};

    before(async () => {
        const keys = Object.keys(OA_SUBGROUPS);
        const results = await Promise.all(keys.map((k) => runCli([...k.split(" "), "--help"], opts)));
        keys.forEach((k, i) => (helps[k] = results[i].stdout));
    });

    for (const [path, subs] of Object.entries(OA_SUBGROUPS)) {
        for (const sub of subs) {
            it(`registers ${path} ${sub}`, () => {
                assert.match(helps[path], new RegExp(`^\\s+${sub.replace(/[-]/g, "\\-")}\\b`, "m"));
            });
        }
    }
});

describe("flag contract", () => {
    const helps = {};

    before(async () => {
        const keys = Object.keys(FLAG_CONTRACT);
        const results = await Promise.all(keys.map((k) => runCli([...k.split(" "), "--help"], opts)));
        keys.forEach((k, i) => (helps[k] = results[i].stdout));
    });

    for (const [cmd, flags] of Object.entries(FLAG_CONTRACT)) {
        it(`${cmd} accepts ${flags.length} documented flag(s)`, () => {
            const missing = flags.filter((f) => !helps[cmd].includes(f));
            assert.deepEqual(missing, [], `${cmd} is missing: ${missing.join(", ")}`);
        });
    }
});

describe("disclaimer behavior", () => {
    it("warns about the unofficial API on a personal-account command", async () => {
        const { all } = await runCli(["status"], opts);
        assert.match(all, /unofficial Zalo APIs/);
    });

    it("suppresses the disclaimer for oa commands (official API)", async () => {
        const { all } = await runCli(["oa", "--help"], opts);
        assert.doesNotMatch(all, /unofficial Zalo APIs/);
    });

    it("suppresses the disclaimer in --json mode so stdout stays parseable", async () => {
        const { stdout } = await runCli(["--json", "status"], opts);
        assert.doesNotMatch(stdout, /unofficial Zalo APIs/);
        assert.doesNotThrow(() => JSON.parse(stdout.trim()));
    });
});

describe("clean-state behavior (no credentials present)", () => {
    it("account list reports no accounts", async () => {
        const { all } = await runCli(["account", "list"], opts);
        assert.match(all, /No accounts/i);
    });

    it("status reports loggedIn:false with a null active account", async () => {
        const { stdout } = await runCli(["--json", "status"], opts);
        const data = JSON.parse(stdout.trim());
        assert.equal(data.loggedIn, false);
        assert.equal(data.activeAccount, null);
    });

    it("a command needing a session fails with a pointer to `login`", async () => {
        const { all } = await runCli(["whoami"], opts);
        assert.match(all, /Not logged in\. Run: zalo-agent login/);
    });
});
