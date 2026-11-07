/**
 * The --json output contract, for EVERY personal CLI command.
 *
 * Offline tests could not run a command's action at all before this suite: every command logs in first, and a
 * test has no account. Live e2e tiers reach about a third of the commands. So `profile set --json` printed `""`
 * (Zalo's empty reply, passed straight through) and nothing noticed.
 *
 * This suite walks the Commander tree (the same way scripts/count-surface.mjs counts it), builds a minimal valid
 * argv for each personal leaf -- OA is excluded, it has its own token -- and runs it with `--json` against a fake
 * session (tests/helpers/fake-api.js, loaded through the guarded seam in src/core/test-fake-session.js). Then it
 * runs the whole walk again in each "empty reply" mode, where every Zalo method answers "", null, {} or
 * undefined, the way Zalo answers many writes.
 *
 * The contract, per command and mode:
 *   1. stdout is exactly ONE JSON value, and it is an object or an array -- never "", null, a bare string,
 *      number or boolean, never nothing;
 *   2. no human decoration (✓ ● ⚠ ✗) on stdout: it belongs on stderr in --json mode;
 *   3. success exits 0 with no top-level "error" key; a failure prints {"error": ...} with "error" as the FIRST
 *      key and exits non-zero (1, or 2 for a confirmation refusal);
 *   4. with plausible replies (normal mode) every command succeeds, except the FAILS_OFFLINE few, which fail
 *      in rule 3's shape;
 *   5. in the empty modes a list command (named list, ls, recent, pinned, archived, muted, hidden, members, blocked,
 *      pending, sent-requests, ...) never answers `{"success": true}`: it prints its natural empty value, and a
 *      command in src/utils/list-replies.js prints exactly the value listed there.
 * In the empty modes a command may fail (it found nothing to act on), but only in the shape rule 3 gives.
 *
 * Speed: one spawned CLI costs ~1.4 s of module loading on Windows, so each walk runs in one worker process that
 * loads the CLI once (tests/helpers/cli-batch-worker.mjs); the five walks take about 20 s. Every violation the worker reports is
 * re-run as a real child process before it fails the suite, so a harness artifact cannot.
 */

import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { CONFIG_DIR, getAccountDbPath, saveCredentials } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";
import { PINNED_MESSAGE_TOPIC } from "../../src/zalo/custom/pin.js";
import { runCli } from "../helpers/cli.js";
import { EMPTY_MODES, FAKE_GROUP_ID, FAKE_OWN_ID, FAKE_PEER_ID } from "../helpers/fake-api.js";
import { LIST_COMMANDS, emptyListReply } from "../../src/utils/list-replies.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FAKE_API = join(ROOT, "tests", "helpers", "fake-api.js");
const WORKER = join(ROOT, "tests", "helpers", "cli-batch-worker.mjs");
const NO_NETWORK = join(ROOT, "tests", "helpers", "no-network.mjs");
const FIXTURES = join(ROOT, "tests", "fixtures");

/** A second registered account, so `account remove` has something other than the active one to remove. */
const SPARE_ACCOUNT = "1000000000000000009";
/** A conversation only `conv forget` touches, so the others keep their cached message. */
const FORGET_THREAD = "1000000000000000004";

/**
 * The cached messages of the current walk: one each for `msg delete` and `msg undo` (which turn theirs into a
 * tombstone for good), one for everything else. Fresh ids per walk, see {@link seedMessages}.
 */
let msgs;

/**
 * Commands this suite does not run, each with the reason. Keep it short: everything else runs.
 * A command is here only when it cannot finish on its own offline (a QR scan, a phone tap, a daemon that runs
 * until stopped, an npm install) -- not because its output is inconvenient.
 */
export const EXCLUDED = {
    login: "QR login: waits for a phone scan",
    "account login": "QR login: waits for a phone scan",
    "account switch": "logs in for real with the target account's saved credentials (no fake seam on that path)",
    update: "runs npm install -g",
    listen: "daemon: runs until stopped",
    "mcp start": "daemon: runs until stopped",
    "fleet start": "starts daemon processes",
    "fleet restart": "stops and starts daemon processes",
    "fleet stop": "signals daemon processes",
    sync: "phone-backed restore: waits for a tap on the phone",
    "sync-mobile": "phone-backed restore: waits for a tap on the phone",
};

/**
 * Commands whose correct offline answer, even with plausible replies, is a failure -- asserted in the failure
 * shape (rule 3) in every mode, instead of rule 4. Each needs something no fake session provides.
 */
export const FAILS_OFFLINE = {
    "msg send-qr-transfer": "fetches the VietQR image from qr.sepay.vn",
    "cloud get": "needs an item in the local zCloud index, its signed download URL and the account's viewer key",
    "mcp wait": "asks a running `mcp start` server",
    "mcp mark-read": "asks a running `mcp start` server",
    "sync-cloud": "needs the account's zCloud viewer key, which only a real zCloud subscription hands out",
    "conv unhide": "needs the hidden-chat PIN typed by a person (no terminal and no --pin-stdin here: exit 2)",
    "conv hidden-pin": "needs the hidden-chat PINs typed by a person (no terminal and no --pin-stdin here: exit 2)",
};

/** Run after every other command, in this order: they change the registry and credentials the others read. */
const LAST = ["logout", "account remove"];

// ---------------------------------------------------------------------------------------------------------------
// The tree

/** Every personal leaf command: `{ path, cmd }`, in registration order. */
async function personalLeaves() {
    const indexSrc = readFileSync(join(ROOT, "src", "index.js"), "utf8");
    const registrars = [...indexSrc.matchAll(/import \{ (register\w+) \} from "(\.\/commands\/[\w-]+\.js)"/g)].map(
        (m) => ({ fn: m[1], file: m[2] }),
    );
    const leaves = [];
    const walk = (cmd, path) => {
        for (const sub of cmd.commands) {
            const p = [...path, sub.name()];
            if (sub.commands.length) walk(sub, p);
            else leaves.push({ path: p, cmd: sub });
        }
    };
    for (const { fn, file } of registrars) {
        const mod = await import(pathToFileURL(join(ROOT, "src", file)).href);
        const program = new Command();
        mod[fn](program);
        walk(program, []);
    }
    // `update` is registered inline in src/index.js.
    leaves.push({ path: ["update"], cmd: new Command("update") });
    return leaves.filter((l) => l.path[0] !== "oa");
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

let files;

/** A plausible value for a positional argument, by its name. */
function argValue(name, path) {
    const n = name.toLowerCase();
    if (/group/.test(n)) return FAKE_GROUP_ID;
    if (/^(threadid|userid|friendid|ownerid)s?$/.test(n) || /memberids|userids|friendids/.test(n)) return FAKE_PEER_ID;
    if (/msgid/.test(n)) return path[1] === "delete" ? msgs.del : path[1] === "undo" ? msgs.undo : msgs.main;
    if (n === "imagepath" || n === "filepath") return files.image;
    if (n === "paths") return path[1] === "send-file" ? files.text : files.image;
    if (n === "video") return files.video;
    if (/url|link/.test(n)) return "https://example.com/fake";
    if (n === "phones") return "0123456789";
    if (n === "accountnumber") return "0123456789";
    if (n === "query" || n === "keyword" || n === "name" || n === "username") return "fake";
    if (n === "on|off") return "on";
    return "1";
}

/** Per-command argv where the name-based guess is not valid input. Values follow the command path. */
const argvTable = () => ({
    "msg react": [msgs.main, FAKE_PEER_ID, "like"],
    "msg unpin": [msgs.main, FAKE_PEER_ID],
    "msg report": [FAKE_PEER_ID, "--reason", "annoy"],
    "msg send-bank": [FAKE_PEER_ID, "0123456789", "--bank", "vcb"],
    "msg send-qr-transfer": [FAKE_PEER_ID, "0123456789", "--bank", "vcb"],
    "msg history": [FAKE_PEER_ID, "--limit", "1"],
    "friend find-username": ["fakeuser"],
    "group join": ["https://zalo.me/g/fakelink"],
    "group link-preview": ["https://zalo.me/g/fakelink"],
    "group settings": [FAKE_GROUP_ID, "--no-lock-poll"],
    "conv mute": [FAKE_PEER_ID],
    "conv delete": [FAKE_PEER_ID],
    "conv auto-delete": [FAKE_PEER_ID, "1d"],
    "conv forget": [FORGET_THREAD],
    "account remove": [SPARE_ACCOUNT],
    "account export": ["--output", join(files.dir, "exported-creds.json")],
    // The sandbox's own provider: re-wraps the fake account's keyring offline, and every later case still opens it.
    "account security provider": ["test"],
    "profile bio": ["fake bio"],
    "profile update": ["--name", "Fake Name"],
    "profile set": ["online-status", "1"],
    "profile active": ["on"],
    "profile lang": ["vi"],
    "poll create": [FAKE_GROUP_ID, "Fake question", "A", "B"],
    "reminder create": [FAKE_PEER_ID, "Fake reminder", "--time", "2099-01-01 09:00"],
    "reminder edit": ["1", FAKE_PEER_ID, "Fake reminder", "--time", "2099-01-01 09:00"],
    "auto-reply create": ["Fake reply"],
    "auto-reply update": ["1", "Fake reply"],
    "label update": ['[{"id":1,"text":"Fake","color":"#ff0000","conversations":[]}]'],
    "read run": ["aliases"],
    "write run": [
        "blocksharing-update",
        "--args",
        JSON.stringify({ threadId: FAKE_PEER_ID, isGroup: false, enabled: true }),
    ],
    "catalog add-product": ["1", "Fake product", "1000", "Fake description"],
    "catalog update-product": ["1", "1", "Fake product", "1000", "Fake description"],
    "bank add": ["0123456789", "--bank", "vcb", "--name", "FAKE NAME"],
    "bank update": ["1", "0123456789", "--bank", "vcb", "--name", "FAKE NAME"],
    "mcp mark-read": ["1"],
    "mcp wait": ["--timeout", "1"],
    "fleet generate": [],
    "sync-media": ["--dry-run"],
    "sync-reactions": ["--wait", "1", "--pages", "1"],
    "cloud get": [],
    "cloud plan": [],
    "mcp approver": ["status"],
});

/**
 * Per-command replies on top of the mode's (tests/helpers/fake-api.js `ZALO_TEST_FAKE_API_REPLIES`), for a command
 * that reads a particular answer before it acts. Applied in every mode: the empty modes empty the rest.
 */
const repliesTable = () => ({
    // No hidden-chat PIN set: with one, `conv hidden` asks for it even when nothing is hidden (exit 2 here).
    "conv hidden": { getHiddenConversations: { threads: [], pin: "" } },
    // The conversation's pin list holds the message, so there is a pin to take off.
    "msg unpin": {
        getFriendBoardList: {
            version: 1,
            data: [{ id: "1", type: PINNED_MESSAGE_TOPIC, params: JSON.stringify({ global_msg_id: msgs.main }) }],
        },
    },
});

/** The argv after `--json` for one leaf. */
function argvFor({ path, cmd }) {
    const key = path.join(" ");
    const ARGV = argvTable();
    let rest;
    if (Object.hasOwn(ARGV, key)) rest = [...ARGV[key]];
    else {
        rest = cmd.registeredArguments.filter((a) => a.required).map((a) => argValue(a.name(), path));
        for (const o of cmd.options) {
            if (o.mandatory) rest.push(o.long, o.long === "--thumb" ? files.image : "1");
        }
    }
    if (key === "fleet generate") rest.push("--out", files.fleetDir);
    if (key === "cloud get") rest.push("1", "--out", join(files.dir, "cloud-get.bin"));
    if (cmd.options.some((o) => o.long === "--yes") && !rest.includes("--dry-run")) rest.push("--yes");
    return [...path, ...rest];
}

// ---------------------------------------------------------------------------------------------------------------
// Running

const baseEnv = (mode) => ({
    ZALO_TEST_FAKE_API: FAKE_API,
    ZALO_TEST_FAKE_API_MODE: mode,
    ZALO_AGENT_NO_UPDATE_CHECK: "1",
});

/** The environment runCli gives a child, so the worker sees the same sandbox. */
function childEnv(mode) {
    const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...baseEnv(mode) };
    Object.assign(env, { USERPROFILE: SANDBOX_HOME, HOME: SANDBOX_HOME, HOMEDRIVE: "", HOMEPATH: "" });
    env.ZALO_SANDBOX_ACTIVE = "1";
    for (const k of ["ZALO_ENV_FILE", "ZALO_CONFIG_DIR", "ZALO_CREDENTIALS_DIR", "ZALO_DATA_DIR", "ZALO_DB_DIR"]) {
        delete env[k];
    }
    delete env.ZALO_MEDIA_DIR;
    delete env.ZALO_OA_DIR;
    return env;
}

/** Run cases in one worker process. */
function runBatch(cases, mode) {
    const casesPath = join(files.dir, `cases-${mode}.json`);
    const outPath = join(files.dir, `out-${mode}.json`);
    writeFileSync(casesPath, JSON.stringify(cases));
    return new Promise((res, rej) => {
        execFile(
            process.execPath,
            [WORKER, casesPath, outPath],
            { env: childEnv(mode), timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
            (err, _stdout, stderr) => {
                if (err) return rej(new Error(`worker failed: ${err.message}\n${stderr}`));
                res(JSON.parse(readFileSync(outPath, "utf8")));
            },
        );
    });
}

/** Run one case as a real child process. */
async function runReal(argv, mode, env = {}) {
    return runCli(argv, {
        home: SANDBOX_HOME,
        timeout: 60_000,
        env: { ...baseEnv(mode), NODE_OPTIONS: `--import=${pathToFileURL(NO_NETWORK).href}`, ...env },
    });
}

const DECORATION = /^\s*[✓●⚠✗]/m;

/**
 * The contract violations in one result, or [] when it holds.
 *
 * @param {{code:number|null, stdout:string, timedOut?:boolean}} r
 * @param {string} mode
 * @param {boolean} [expectFailure] - a {@link FAILS_OFFLINE} command
 * @returns {string[]}
 */
export function violations(r, mode, expectFailure = false) {
    if (r.timedOut) return ["did not finish"];
    const out = [];
    const text = r.stdout.trim();
    if (DECORATION.test(r.stdout)) out.push("human decoration on stdout");
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        out.push(text ? `stdout is not one JSON value: ${JSON.stringify(text.slice(0, 120))}` : "stdout is empty");
        return out;
    }
    if (value === null || typeof value !== "object") {
        out.push(`stdout is a bare ${value === null ? "null" : typeof value}: ${JSON.stringify(value)}`);
        return out;
    }
    const isError = !Array.isArray(value) && Object.hasOwn(value, "error");
    if (isError) {
        if (Object.keys(value)[0] !== "error") out.push(`"error" is not the first key`);
        if (!r.code) out.push(`failure exited ${r.code}`);
        if (mode === "normal" && !expectFailure) {
            out.push(`failed with plausible replies: ${String(value.error).slice(0, 160)}`);
        }
    } else if (r.code) {
        out.push(`exit code ${r.code} without {"error"}`);
    } else if (expectFailure) {
        out.push("succeeded, but it cannot offline: is it still asking what it needs?");
    }
    return out;
}

/** A command whose reply is a list, by its name (the last word of its path). */
const LIST_NAME =
    /^(list|ls|recent|pinned|archived|muted|hidden|members|members-info|blocked|pending|sent-requests|[\w-]+-list|recommendations|common-groups|avatars|products|accounts|responses|invite-boxes|online|close|find-phones|devices)$/;

/**
 * Rule 5: what a list command printed for an empty answer, or [] when it holds.
 *
 * @param {string} id - the command path
 * @param {{code:number|null, stdout:string}} r
 * @param {string} mode
 * @returns {string[]}
 */
export function listViolations(id, r, mode) {
    if (mode === "normal") return [];
    const listed = LIST_COMMANDS.includes(id);
    if (!listed && !LIST_NAME.test(id.split(" ").pop())) return [];
    let value;
    try {
        value = JSON.parse(r.stdout.trim());
    } catch {
        return []; // rule 1 reports it
    }
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "error")) return [];
    if (value && typeof value === "object" && !Array.isArray(value) && value.success === true) {
        return ['a list command answered {"success": true} instead of an empty list'];
    }
    if (listed) {
        try {
            assert.deepEqual(value, emptyListReply(id));
        } catch {
            return [`empty reply ${JSON.stringify(value).slice(0, 120)} is not ${JSON.stringify(emptyListReply(id))}`];
        }
    }
    return [];
}

/**
 * The registry and saved login every case starts from: the fake account active with credentials (`account
 * export` reads them), and a spare account for `account remove`. Re-run after each walk, whose `logout` and
 * `account remove` take them away.
 */
function seedAccounts() {
    addAccount(SPARE_ACCOUNT, "Spare");
    addAccount(FAKE_OWN_ID, "Fake Self");
    saveCredentials(FAKE_OWN_ID, { imei: "fake-imei", cookie: [], userAgent: "fake-agent", language: "vi" });
}

/**
 * Cache this walk's incoming messages, so the commands that act on a message (react, pin, forward, recall,
 * delete, conv read/delete) find its cliMsgId and sender as they would after `listen` or `sync`.
 *
 * @param {number} walk - 0 for the first walk, 1 for the next, ...
 */
function seedMessages(walk) {
    const id = (k) => String(1000000000000000100n + BigInt(walk * 10 + k));
    msgs = { main: id(0), del: id(1), undo: id(2) };
    const ts = Date.now() - 60_000;
    // Known to be a 1-1, as `listen` or `sync` would have recorded it: `msg forward` will not guess.
    upsertThread({ threadId: FAKE_PEER_ID, type: "dm", name: "Fake Friend", lastUpdate: ts });
    for (const [k, msgId] of Object.values(msgs).entries()) {
        insertMessage({
            msgId,
            threadId: FAKE_PEER_ID,
            senderId: FAKE_PEER_ID,
            senderName: "Fake Friend",
            text: "fake message",
            timestamp: ts + k,
            type: "webchat",
            raw_data: {
                msgId,
                cliMsgId: id(k + 5),
                uidFrom: FAKE_PEER_ID,
                idTo: FAKE_OWN_ID,
                msgType: "webchat",
                content: "fake message",
                ts: String(ts + k),
            },
            has_attachment: false,
        });
    }
}

// ---------------------------------------------------------------------------------------------------------------

describe("--json contract: every personal command against a fake session", { timeout: 900_000 }, () => {
    let leaves;
    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.ok(SANDBOX_CONFIG_DIR);
        const dir = mkdtempSync(join(SANDBOX_HOME, "contract-"));
        files = {
            dir,
            image: join(dir, "fake.png"),
            text: join(dir, "fake.txt"),
            video: join(dir, "fake.mp4"),
            fleetDir: join(dir, "fleet"),
        };
        copyFileSync(join(FIXTURES, "image-64x48.png"), files.image);
        copyFileSync(join(FIXTURES, "notes.txt"), files.text);
        writeFileSync(files.video, Buffer.alloc(64));
        seedAccounts();
        initDb(getAccountDbPath(FAKE_OWN_ID));
        leaves = await personalLeaves();
    });

    it("walks every personal command, minus a short justified exclusion list", () => {
        const names = leaves.map((l) => l.path.join(" "));
        for (const x of Object.keys(EXCLUDED)) assert.ok(names.includes(x), `excluded command ${x} does not exist`);
        assert.ok(names.length >= 200, `only ${names.length} personal commands found`);
        assert.ok(Object.keys(EXCLUDED).length <= 12, "the exclusion list keeps growing: run them instead");
        for (const x of LIST_COMMANDS) assert.ok(names.includes(x), `list-replies.js names ${x}, which does not exist`);
    });

    it("a list command's empty reply is never {success: true} (rule 5 itself)", () => {
        const out = (v) => ({ code: 0, stdout: JSON.stringify(v) });
        assert.equal(listViolations("conv archived", out({ success: true }), "null").length, 1);
        assert.equal(listViolations("group pending", out(emptyListReply("group pending")), "null").length, 0);
        assert.equal(listViolations("conv archived", out({}), "empty-object").length, 1, "{} is not {items: []}");
        assert.equal(listViolations("friend online", out({ success: true }), "normal").length, 0, "normal mode");
        assert.equal(listViolations("conv pin", out({ success: true }), "null").length, 0, "not a list command");
    });

    for (const [walk, mode] of ["normal", ...EMPTY_MODES].entries()) {
        it(`holds for every command when Zalo answers ${mode === "normal" ? "plausibly" : mode}`, async () => {
            seedMessages(walk);
            const cases = leaves
                .filter((l) => !Object.hasOwn(EXCLUDED, l.path.join(" ")))
                .map((l) => {
                    const id = l.path.join(" ");
                    const replies = repliesTable()[id];
                    const env = replies ? { ZALO_TEST_FAKE_API_REPLIES: JSON.stringify(replies) } : undefined;
                    return { id, argv: ["--json", ...argvFor(l)], env };
                });
            const rank = (id) => LAST.indexOf(id);
            cases.sort((a, b) => rank(a.id) - rank(b.id));
            const results = await runBatch(cases, mode);
            seedAccounts();
            const failures = [];
            for (const r of results) {
                const expectFailure = Object.hasOwn(FAILS_OFFLINE, r.id);
                const check = (x) => [...violations(x, mode, expectFailure), ...listViolations(r.id, x, mode)];
                if (!check(r).length) continue;
                // Confirm in a real process before blaming the command.
                const { argv, env } = cases.find((c) => c.id === r.id);
                const real = await runReal(argv, mode, env);
                seedAccounts();
                const v = check(real);
                if (v.length) failures.push(`${r.id} (exit ${real.code}): ${v.join("; ")}`);
            }
            assert.equal(
                failures.length,
                0,
                `${failures.length} command(s) break the --json contract:\n${failures.join("\n")}`,
            );
        });
    }
});
