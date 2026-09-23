/**
 * Input-validation logic paths that resolve *before* any network call.
 *
 * Each of these guards sits ahead of `getApi()` in its action handler, so
 * they are fully testable offline against a throwaway HOME. Together they
 * are the CLI's whole "reject bad input early" surface.
 *
 * Two behaviors are pinned down here as characterization tests — marked
 * inline — because they are surprising and a change to either should be a
 * deliberate decision rather than an accident:
 *   · API/validation failures exit 0, not 1.
 *   · `--json` mode still prints the human `✗` line on failure.
 */

import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli, errorLineOf } from "../helpers/cli.js";

const opts = { home: SANDBOX_HOME, timeout: 30_000 };
const TID = "1234567890123456789";

describe("bank resolution guards", () => {
    it("msg send-bank rejects an unknown bank name", async () => {
        const { all } = await runCli(["msg", "send-bank", TID, "12345", "-b", "notabank"], opts);
        assert.match(all, /Unknown bank: 'notabank'/);
    });

    it("msg send-bank rejects a BIN that is not in the table", async () => {
        const { all } = await runCli(["msg", "send-bank", TID, "12345", "-b", "123456"], opts);
        assert.match(all, /Unknown bank: '123456'/);
    });

    it("msg send-qr-transfer rejects an unknown bank before generating anything", async () => {
        const { all } = await runCli(["msg", "send-qr-transfer", TID, "12345", "-b", "nope"], opts);
        assert.match(all, /Unknown bank: 'nope'/);
    });

    it("a valid bank gets past resolution and only then hits the missing session", async () => {
        const { all } = await runCli(["msg", "send-bank", TID, "12345", "-b", "ocb"], opts);
        assert.doesNotMatch(all, /Unknown bank/);
        assert.match(all, /Bank: OCB \(BIN 970448\)/);
        assert.match(all, /Not logged in/);
    });

    it("--bank is mandatory for send-bank (commander exits non-zero)", async () => {
        const r = await runCli(["msg", "send-bank", TID, "12345"], opts);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /required option .*--bank/i);
    });

    it("--bank is mandatory for send-qr-transfer", async () => {
        const r = await runCli(["msg", "send-qr-transfer", TID, "12345"], opts);
        assert.notEqual(r.code, 0);
    });
});

describe("VietQR content-length guard", () => {
    it("rejects transfer content longer than 50 characters", async () => {
        const long = "x".repeat(51);
        const { all } = await runCli(["msg", "send-qr-transfer", TID, "12345", "-b", "ocb", "-m", long], opts);
        assert.match(all, /Content too long \(51 chars\)\. VietQR max is 50\./);
    });

    it("accepts content of exactly 50 characters", async () => {
        const exact = "x".repeat(50);
        const { all } = await runCli(["msg", "send-qr-transfer", TID, "12345", "-b", "ocb", "-m", exact], opts);
        assert.doesNotMatch(all, /Content too long/);
    });

    it("reports the actual length so the user knows how much to trim", async () => {
        const { all } = await runCli(["msg", "send-qr-transfer", TID, "1", "-b", "ocb", "-m", "y".repeat(73)], opts);
        assert.match(all, /73 chars/);
    });
});

describe("msg undo requires a cliMsgId", () => {
    it("refuses without --cli-msg-id when the cache cannot supply one, and says where to get one", async () => {
        // The sandboxed cache is empty, so the lookup `msg undo` now shares
        // with `msg delete` finds nothing and the guard still fires.
        const { all } = await runCli(["msg", "undo", "9999", TID], opts);
        assert.match(all, /cliMsgId is required to recall a message/);
        assert.match(all, /not in the local cache/);
        assert.match(all, /listen --json/);
        // `send --json` is no longer offered: zca-js never returns the
        // clientId it stamped, so the value send printed was a second
        // Date.now() that matched only by luck.
        assert.doesNotMatch(all, /send --json/);
    });

    it("gets past the guard when --cli-msg-id is supplied", async () => {
        const { all } = await runCli(["msg", "undo", "9999", TID, "-c", "1700000000000"], opts);
        assert.doesNotMatch(all, /cliMsgId is required/);
        assert.match(all, /Not logged in/);
    });
});

describe("conv auto-delete TTL guard", () => {
    for (const bad of ["3d", "forever", "0", "", "1D"]) {
        it(`rejects TTL ${JSON.stringify(bad)} and lists the valid values`, async () => {
            const { all } = await runCli(["conv", "auto-delete", TID, bad], opts);
            assert.match(all, /Invalid TTL/);
            assert.match(all, /Valid: off, 1d, 7d, 14d/);
        });
    }

    for (const good of ["off", "1d", "7d", "14d"]) {
        it(`accepts TTL ${good} and proceeds to the API call`, async () => {
            const { all } = await runCli(["conv", "auto-delete", TID, good], opts);
            assert.doesNotMatch(all, /Invalid TTL/);
        });
    }
});

describe("commander-level argument requirements", () => {
    const missingArgs = [
        ["msg", "send", TID],
        ["msg", "react", "1", TID],
        ["group", "create", "name-only"],
        ["group", "rename", "gid"],
        ["friend", "alias", "uid"],
        ["conv", "auto-delete", TID],
        ["catalog", "add-product", "cid", "name", "100"],
        ["reminder", "create", TID],
    ];

    for (const args of missingArgs) {
        it(`\`${args.join(" ")}\` exits non-zero on a missing argument`, async () => {
            const r = await runCli(args, opts);
            assert.notEqual(r.code, 0, `expected a parse error, got: ${r.all.slice(0, 200)}`);
        });
    }

    it("msg send-video requires --thumb", async () => {
        const r = await runCli(["msg", "send-video", TID, "https://example.com/v.mp4"], opts);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /--thumb/);
    });
});

describe("no-active-account guards", () => {
    it("conv recent exits 1 with a friendly login pointer", async () => {
        const r = await runCli(["conv", "recent"], opts);
        assert.equal(r.code, 1);
        assert.match(r.all, /No active account\. Please login first\./);
        assert.doesNotMatch(r.all, /at Command\./, "must not leak a stack trace");
    });

    // REGRESSION GUARD — this used to print a raw Node stack trace.
    //
    // `msg history` called `const api = getApi()` ABOVE its
    // `getActive()` / "No active account" guard, on a line outside any
    // try/catch. With no session the guard was unreachable: getApi() threw,
    // the rejection went unhandled, and the user saw a stack trace. Fixed by
    // moving the guard first and wrapping getApi() — matching `conv recent`.
    it("msg history exits 1 with a friendly login pointer, not a stack trace", async () => {
        const r = await runCli(["msg", "history", TID], opts);
        assert.equal(r.code, 1);
        assert.match(r.all, /No active account\. Please login first\./);
        assert.doesNotMatch(r.all, /at getApi|at Command\./, "must not leak a stack trace");
    });

    it("commands that only need the API report 'Not logged in'", async () => {
        for (const args of [["whoami"], ["friend", "list"], ["group", "list"], ["conv", "pinned"]]) {
            const { all } = await runCli(args, opts);
            assert.match(all, /Not logged in\. Run: zalo-agent login/, `\`${args.join(" ")}\` should say so`);
        }
    });
});

describe("logout on a clean machine", () => {
    it("succeeds and explains that credentials were kept", async () => {
        const { all } = await runCli(["logout"], opts);
        assert.match(all, /Logged out \(credentials kept/);
    });

    it("--purge with nothing to purge still reports success rather than throwing", async () => {
        const r = await runCli(["logout", "--purge"], opts);
        assert.equal(r.code, 0);
        assert.doesNotMatch(r.all, /Error|stack/i);
    });
});

// ---------------------------------------------------------------------------
// The --json stdout contract.
//
// REGRESSION GUARD. `--json` used to be unusable with `jq` on any failure:
// error() wrote `  ✗ <msg>` to stdout regardless of mode, and commands that
// call success() after output() (msg send --react) appended a human line
// AFTER the JSON. Both are fixed; stdout now carries exactly one JSON value
// and human chatter goes to stderr.
// ---------------------------------------------------------------------------

describe("--json stdout contract", () => {
    it("a failure is emitted as JSON on stdout, not a ✗ line", async () => {
        const r = await runCli(["--json", "msg", "send-bank", TID, "1", "-b", "notabank"], opts);
        const parsed = JSON.parse(r.stdout.trim()); // must not throw
        assert.equal(parsed.error, "Unknown bank: 'notabank'");
        assert.equal(errorLineOf(r.stdout), null, "no ✗ line should reach stdout");
    });

    it("a success is a single parseable JSON value with nothing appended", async () => {
        const r = await runCli(["--json", "status"], opts);
        assert.doesNotThrow(() => JSON.parse(r.stdout.trim()));
    });

    it("every human marker is kept off stdout in --json mode", async () => {
        for (const args of [
            ["--json", "status"],
            ["--json", "msg", "send-bank", TID, "1", "-b", "notabank"],
            ["--json", "whoami"],
            ["--json", "logout"],
        ]) {
            const r = await runCli(args, opts);
            assert.doesNotMatch(r.stdout, /[✓✗●⚠]/, `\`${args.join(" ")}\` leaked a human marker to stdout`);
            assert.doesNotMatch(r.stdout, /unofficial Zalo APIs/, `\`${args.join(" ")}\` leaked the disclaimer`);
        }
    });

    it("stdout stays parseable across a range of failing commands", async () => {
        for (const args of [
            ["--json", "msg", "send-qr-transfer", TID, "1", "-b", "nope"],
            ["--json", "conv", "auto-delete", TID, "3d"],
            ["--json", "msg", "undo", "9999", TID],
            ["--json", "whoami"],
        ]) {
            const r = await runCli(args, opts);
            const parsed = JSON.parse(r.stdout.trim()); // must not throw
            assert.equal(typeof parsed.error, "string", `\`${args.join(" ")}\` should carry an .error string`);
        }
    });

    it("human mode is unchanged — still a ✗ line, still no JSON", async () => {
        const r = await runCli(["msg", "send-bank", TID, "1", "-b", "notabank"], opts);
        assert.equal(errorLineOf(r.stdout), "Unknown bank: 'notabank'");
        assert.throws(() => JSON.parse(r.stdout.trim()));
    });

    // Still open — see agent/work/transfer-sync-v2/NOTES.md § Known issues #2. Exit codes are a
    // separate contract from output shape, and changing them would break
    // scripts that check `$?` today. A --json consumer detects failure via
    // the `.error` key instead.
    it("CHARACTERIZATION: a validation failure still exits 0", async () => {
        const r = await runCli(["msg", "send-bank", TID, "1", "-b", "notabank"], opts);
        assert.equal(r.code, 0, "exit codes remain issue #2; use .error in --json mode");
    });
});

describe("sync-mobile — offline surface", () => {
    // The default path now backfills over the WebSocket and never touches the
    // phone; only --legacy does, and that is opt-in twice over (see
    // tests/e2e/tier3-mutate-restore.test.js). Everything that does NOT need a
    // session is checked here instead, for free.

    it("registers --force with a descriptive help entry", async () => {
        const { stdout } = await runCli(["sync-mobile", "--help"], opts);
        assert.match(stdout, /-F, --force/);
        assert.match(stdout, /already synced/i, "--force should explain the shortcut it skips");
    });

    it("rejects an unknown flag rather than silently ignoring it", async () => {
        const r = await runCli(["sync-mobile", "--not-a-flag"], opts);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /unknown option/i);
    });

    it("registers --days and documents that the default is full history", async () => {
        const { stdout } = await runCli(["sync-mobile", "--help"], opts);
        assert.match(stdout, /-d, --days/);
        assert.match(stdout, /full history/i, "--days must state the default window it narrows");
    });

    it("refuses --days without --transfer instead of accepting and ignoring it", async () => {
        // The window is a field of the cmd 590 query only the transfer path
        // sends, so on any other path the flag would be a silent no-op.
        const r = await runCli(["sync-mobile", "--days", "7"], opts);
        assert.equal(r.code, 1);
        assert.match(r.all, /--days only applies/i);
        assert.match(r.all, /--transfer --days 7/, "should hand back the corrected command");
    });

    it("rejects a --days value that is not a whole number of days >= 1", async () => {
        for (const bad of ["0", "-3", "1.5", "week"]) {
            const r = await runCli(["sync-mobile", "--transfer", "--days", bad], opts);
            assert.notEqual(r.code, 0, `--days ${bad} must not be accepted`);
            assert.match(r.all, /whole number/i, `--days ${bad} should fail on the value, not later`);
        }
    });

    it("exits 1 with a login pointer when there is no account — before any network contact", async () => {
        const r = await runCli(["sync-mobile"], opts);
        assert.equal(r.code, 1);
        assert.match(r.all, /No active account\. Please login first\./);
        assert.doesNotMatch(r.all, /Waiting for sync data|pullMobileMsg/, "must not reach any sync path");
    });

    it("offers the retired phone transfer only behind --legacy, and says it pings the phone", async () => {
        const { stdout } = await runCli(["sync-mobile", "--help"], opts);
        assert.match(stdout, /-L, --legacy/);
        assert.match(stdout, /mobile app/i, "--legacy must warn that it reaches the user's phone");
    });

    it("no longer advertises the retry loop that used to spam the phone", async () => {
        const { stdout } = await runCli(["sync-mobile", "--help"], opts);
        assert.doesNotMatch(stdout, /--interval/, "the repeating poll is gone, so its flag must be too");
    });

    it("--legacy is a boolean flag, not one that swallows the next argument", async () => {
        // `sync-mobile --legacy --force` must parse as two flags. If --legacy
        // ever gained a <value> the second flag would be eaten silently.
        const r = await runCli(["sync-mobile", "--legacy", "--force"], opts);
        assert.equal(r.code, 1);
        assert.match(r.all, /No active account/, "both flags parsed; it stopped at the account guard");
    });
});
