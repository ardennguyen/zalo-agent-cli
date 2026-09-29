/**
 * Drive the real CLI against an offline, logged-in session.
 *
 * `runOffline()` spawns `node src/index.js …` with ./offline-session.js
 * preloaded, so the command runs its real action code, zca-js builds its real
 * requests, and every request lands decrypted in a log this helper hands back.
 * That is what lets a test assert the request that actually goes out -- host
 * service, path, method and params -- instead of a string in the source.
 *
 * `seedAccount()` / `seedThread()` / `seedMessage()` write the sandboxed
 * config the child reads: an active account, fake credentials (never real
 * ones), and zalo.db rows shaped like the listener's and the mobile sync's.
 * The test process is the writer here, not a command, so AGENTS.md's
 * one-writer rule for commands is untouched.
 *
 * Import ../../helpers/sandbox.js FIRST in the test file, as always.
 */
import { SANDBOX_HOME, SANDBOX_CONFIG_DIR } from "../../helpers/sandbox.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../../helpers/cli.js";
import { initDb, insertMessage, upsertThread } from "../../../src/core/db.js";

const PRELOAD = pathToFileURL(join(import.meta.dirname, "offline-session.js")).href;

/** Made-up ids. None of them belongs to anyone. */
export const OWN_UID = "100000000000000001";
export const SEND2ME_ID = "400000000000000001";

let dbReady = false;

/**
 * Register one active account with fake credentials in the sandbox.
 *
 * @param {string} [uid]
 */
export function seedAccount(uid = OWN_UID) {
    mkdirSync(join(SANDBOX_CONFIG_DIR, "credentials"), { recursive: true });
    mkdirSync(join(SANDBOX_CONFIG_DIR, "accounts", uid), { recursive: true });
    writeFileSync(
        join(SANDBOX_CONFIG_DIR, "accounts.json"),
        JSON.stringify([{ ownId: uid, name: "Offline Test", proxy: null, active: true }], null, 2),
    );
    writeFileSync(
        join(SANDBOX_CONFIG_DIR, "credentials", `cred_${uid}.json`),
        JSON.stringify({ imei: "offline-test-imei", cookie: [], userAgent: "offline-test-agent", language: "vi" }),
    );
    if (!dbReady) {
        initDb(join(SANDBOX_CONFIG_DIR, "accounts", uid, "zalo.db"));
        dbReady = true;
    }
}

/**
 * Record a conversation's kind the way the listener does.
 *
 * @param {string} threadId
 * @param {"dm"|"group"} type
 */
export function seedThread(threadId, type) {
    upsertThread({ threadId, type, name: `offline ${type} ${threadId.slice(-3)}`, lastUpdate: 1700000000000 });
}

/**
 * Insert one cached message.
 *
 * @param {object} m
 * @param {string} m.msgId
 * @param {string} m.threadId
 * @param {string} m.senderId - numeric uid (listener) or a noised id (sync)
 * @param {string} [m.senderName]
 * @param {string} [m.text]
 * @param {number} m.timestamp - the server ts
 * @param {string} [m.type] - the classifier's vocabulary ("text", "photo", …)
 * @param {string|null} [m.cliMsgId]
 * @param {"listen"|"sync-v2"} [m.src]
 */
export function seedMessage(m) {
    const src = m.src || "listen";
    const text = m.text ?? "";
    const raw =
        src === "sync-v2"
            ? { src, msgType: 1, cliMsgId: m.cliMsgId ?? undefined, content: text || undefined }
            : { src, msgType: "webchat", cliMsgId: m.cliMsgId ?? undefined, content: text || undefined };
    insertMessage({
        msgId: m.msgId,
        threadId: m.threadId,
        senderId: m.senderId,
        senderName: m.senderName ?? "",
        text,
        timestamp: m.timestamp,
        type: m.type || "text",
        raw_data: raw,
        has_attachment: 0,
    });
}

/**
 * Run the CLI with the offline session preloaded.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.uid]
 * @param {string|null} [opts.send2me] - null leaves `send2me_id` out of loginInfo
 * @param {object} [opts.responses] - per-path response overrides (see offline-session.js)
 * @param {boolean} [opts.unpatched] - reproduce an install whose zca-js patch did not apply
 * @param {number} [opts.timeout]
 * @returns {Promise<{code:number, stdout:string, stderr:string, all:string, requests:object[]}>}
 */
export async function runOffline(args, opts = {}) {
    const dir = mkdtempSync(join(SANDBOX_HOME, "offline-run-"));
    const log = join(dir, "requests.jsonl");
    const env = {
        NODE_OPTIONS: `--import=${PRELOAD}`,
        ZALO_OFFLINE_LOG: log,
        ZALO_OFFLINE_UID: opts.uid || OWN_UID,
        ZALO_OFFLINE_SEND2ME: opts.send2me === null ? "none" : opts.send2me || SEND2ME_ID,
        ZALO_OFFLINE_UNPATCHED: opts.unpatched ? "1" : "",
    };
    if (opts.responses) {
        const file = join(dir, "responses.json");
        writeFileSync(file, JSON.stringify(opts.responses));
        env.ZALO_OFFLINE_RESPONSES = file;
    }
    const r = await runCli(args, { home: SANDBOX_HOME, timeout: opts.timeout || 60_000, env });
    const requests = existsSync(log)
        ? readFileSync(log, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
        : [];
    return { ...r, requests };
}

/**
 * The requests whose path ends with `suffix`.
 *
 * @param {object[]} requests
 * @param {string} suffix
 * @returns {object[]}
 */
export function requestsTo(requests, suffix) {
    return requests.filter((q) => q.path.endsWith(suffix));
}
