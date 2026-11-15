/**
 * Run CLI commands in a long-lived in-process worker instead of one child process each.
 *
 * A spawned `node src/index.js` pays about 1.4 s of module loading on Windows before it does anything, and much
 * more on a loaded machine. tests/helpers/cli-batch-worker.mjs loads the module graph once and then runs each case
 * as a fresh Commander program (see its header for what it emulates and what module state it resets). This file
 * keeps one such worker per sandbox home and environment, forked on first use and gone with the test process.
 *
 * The worker is a harness, not the CLI, so a result it produces is trusted only when it PASSES the test's check.
 * {@link checkCli} runs the check on the worker's result; when the check throws, the same command runs again as a
 * real child process (tests/helpers/cli.js `runCli`) and the check runs on that result instead, so a harness
 * artifact can never fail a test -- the same safeguard tests/cli/json-contract.test.js applies to its walks.
 *
 * Use the worker only for commands that finish on their own: nothing that reads stdin, waits on a phone, starts a
 * daemon or depends on the process exiting (signals, a lock released at exit). Those stay on `runCli`.
 */
import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCli, stripAnsi } from "./cli.js";

const WORKER = resolve(import.meta.dirname, "cli-batch-worker.mjs");

/** Variables a worker's environment is keyed by: the ones modules read once, at load. */
const PROCESS_KEYS = ["NODE_OPTIONS", "ZALO_TEST_FAKE_API", "ZALO_TEST_FAKE_API_MODE"];

const workers = new Map();
let seq = 0;

/** The environment runCli gives a child, for `home`. */
function childEnv(home, env) {
    const out = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
    if (home) {
        Object.assign(out, { USERPROFILE: home, HOME: home, HOMEDRIVE: "", HOMEPATH: "", ZALO_SANDBOX_ACTIVE: "1" });
        for (const k of [
            "ZALO_ENV_FILE",
            "ZALO_CONFIG_DIR",
            "ZALO_CREDENTIALS_DIR",
            "ZALO_DATA_DIR",
            "ZALO_DB_DIR",
            "ZALO_MEDIA_DIR",
            "ZALO_OA_DIR",
        ]) {
            delete out[k];
        }
    }
    Object.assign(out, env);
    out.ZALO_AGENT_NO_UPDATE_CHECK = "1";
    return out;
}

/** The worker for this home and process-level environment, forked on first use. */
function workerFor(home, env) {
    const procEnv = Object.fromEntries(PROCESS_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
    const key = JSON.stringify([home ?? null, procEnv]);
    let w = workers.get(key);
    if (w) return w;
    const { NODE_OPTIONS, ...rest } = childEnv(home, procEnv);
    // A preload goes on the worker's own command line; NODE_OPTIONS would also reach a real child it starts.
    const execArgv = NODE_OPTIONS ? NODE_OPTIONS.split(/\s+/).filter(Boolean) : [];
    const child = fork(WORKER, ["--serve"], { env: rest, execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stderr.unref?.();
    const pending = new Map();
    child.on("message", (r) => {
        pending.get(r.id)?.(r);
        pending.delete(r.id);
    });
    child.on("exit", (code) => {
        workers.delete(key);
        for (const settle of pending.values()) {
            settle({ code: null, stdout: "", stderr: `worker exited (${code}): ${stderr}`, timedOut: false });
        }
        pending.clear();
    });
    // The worker must not keep the test process alive; it exits when the IPC channel closes.
    child.unref();
    child.channel?.unref();
    w = { child, pending };
    workers.set(key, w);
    return w;
}

/**
 * Run the CLI in the worker. Same arguments and result shape as tests/helpers/cli.js `runCli`.
 *
 * @param {string[]} args
 * @param {{home?: string, env?: object, timeout?: number}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, all: string, timedOut: boolean}>}
 */
export function runCliFast(args, opts = {}) {
    const { home, env = {}, timeout = 60_000 } = opts;
    const w = workerFor(home, env);
    const caseEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !PROCESS_KEYS.includes(k)));
    const id = String(++seq);
    return new Promise((res) => {
        // Referenced only while a case is in flight, so an idle worker never keeps the test process alive.
        if (!w.pending.size) w.child.channel?.ref();
        w.pending.set(id, (r) => {
            if (w.pending.size <= 1) w.child.channel?.unref();
            const stdout = stripAnsi(r.stdout);
            const stderr = stripAnsi(r.stderr);
            res({ code: r.code, stdout, stderr, all: stdout + stderr, timedOut: r.timedOut });
        });
        w.child.send({ id, argv: args, env: caseEnv, timeoutMs: timeout });
    });
}

/**
 * Run the CLI in the worker and hand the result to `check`. If `check` throws, run the command again as a real
 * child process and check that result instead: only the real process can fail the test.
 *
 * @template T
 * @param {string[]} args
 * @param {{home?: string, env?: object, timeout?: number}} opts - as {@link runCliFast}
 * @param {(r: {code: number|null, stdout: string, stderr: string, all: string}) => T | Promise<T>} check
 * @returns {Promise<T>} what `check` returned
 */
export async function checkCli(args, opts, check) {
    const fast = await runCliFast(args, opts);
    try {
        return await check(fast);
    } catch (e) {
        noteRetry(args, e);
        return check(await runCli(args, opts));
    }
}

/**
 * With ZALO_TEST_CLI_FAST_LOG set, append each case re-run as a real child (and why) to that file: a case that
 * keeps landing there is one the worker does not run the way a process does.
 *
 * @param {string[]} args
 * @param {Error} e - what the check threw on the worker's result
 */
export function noteRetry(args, e) {
    const file = process.env.ZALO_TEST_CLI_FAST_LOG;
    if (file) appendFileSync(file, `${JSON.stringify(args)} ${String(e?.message).split("\n")[0]}\n`);
}
