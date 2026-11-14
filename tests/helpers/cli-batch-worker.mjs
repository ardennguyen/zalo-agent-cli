/**
 * Runs many CLI invocations in ONE process, for suites that walk the whole command tree.
 *
 * A spawned `node src/index.js` pays about 1.4 s of module loading on Windows before it does anything, so
 * 201 commands times several reply modes would take most of half an hour as separate processes. This worker
 * loads the module graph once and then, per case, re-evaluates only `src/index.js` (a fresh Commander program,
 * via a cache-busting query) with `process.argv` set to the case's argv.
 *
 * What a real process would do and this one emulates:
 *   - stdout / stderr: captured per case from `process.stdout.write` / `process.stderr.write`;
 *   - `process.exit(code)`: recorded, then thrown as {@link ExitSignal} so nothing after it runs on; output
 *     written after the exit is dropped, as it would be;
 *   - the exit code: the recorded `process.exit` code, else `process.exitCode` once the command settles.
 * Module state that outlives a case and would leak into the next one is reset: the `error()` JSON latch,
 * `ZALO_JSON_MODE`, the pinned account and `process.exitCode`.
 *
 * It is a harness, not the CLI: tests/cli/json-contract.test.js re-runs every case this worker reports as
 * failing in a real child process before it reports the failure.
 *
 * Usage (environment as tests/helpers/cli.js `runCli` sets it): `node cli-batch-worker.mjs <cases.json> <out.json>`
 * where cases.json is `[{ id, argv, env?, timeoutMs? }]` (`env`: variables set for that case only); out.json receives `[{ id, code, stdout, stderr, timedOut }]`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "./no-network.mjs";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.js");
const [casesPath, outPath] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));

class ExitSignal extends Error {
    constructor(code) {
        super(`process.exit(${code})`);
        this.exitCode = code;
    }
}

const { Command } = await import("commander");
const { _resetErrorLatch } = await import(pathToFileURL(resolve(CLI, "..", "utils", "output.js")).href);
const { setPinnedAccount } = await import(pathToFileURL(resolve(CLI, "..", "core", "accounts.js")).href);

const realExit = process.exit.bind(process);
let current = null;

process.stdout.write = (chunk, ...rest) => {
    if (current && !current.exited) current.stdout += String(chunk);
    const cb = rest.find((r) => typeof r === "function");
    if (cb) cb();
    return true;
};
process.stderr.write = (chunk, ...rest) => {
    if (current && !current.exited) current.stderr += String(chunk);
    const cb = rest.find((r) => typeof r === "function");
    if (cb) cb();
    return true;
};
process.exit = (code) => {
    const c = code ?? process.exitCode ?? 0;
    if (current && !current.exited) {
        current.exited = true;
        current.code = Number(c) || 0;
        current.settle();
    }
    throw new ExitSignal(c);
};
// An exit thrown from a callback or an un-awaited promise surfaces here; anything else is a crash of the
// case, which a real process would report on stderr and exit 1 for.
const onStray = (e) => {
    if (e instanceof ExitSignal) return;
    if (current && !current.exited) {
        current.stderr += `${e?.stack || e}\n`;
        current.exited = true;
        current.code = 1;
        current.settle();
    }
};
process.on("uncaughtException", onStray);
process.on("unhandledRejection", onStray);

// Capture the program's parseAsync promise, so the worker knows when a case has finished.
const realParseAsync = Command.prototype.parseAsync;
let lastRun = null;
Command.prototype.parseAsync = function (...args) {
    lastRun = realParseAsync.apply(this, args);
    return lastRun;
};

const results = [];
let n = 0;
for (const c of cases) {
    _resetErrorLatch();
    delete process.env.ZALO_JSON_MODE;
    setPinnedAccount(null);
    process.exitCode = undefined;
    process.argv = [process.execPath, CLI, ...c.argv];
    const savedEnv = Object.fromEntries(Object.keys(c.env ?? {}).map((k) => [k, process.env[k]]));
    Object.assign(process.env, c.env ?? {});
    lastRun = null;
    const state = { stdout: "", stderr: "", exited: false, code: null, timedOut: false };
    const done = new Promise((res) => (state.settle = res));
    current = state;
    const timer = setTimeout(() => {
        if (state.exited) return;
        state.timedOut = true;
        state.exited = true;
        state.code = null;
        state.settle();
    }, c.timeoutMs ?? 15_000);
    try {
        await import(`${pathToFileURL(CLI).href}?case=${++n}`);
        // index.js does not await its own parseAsync; the patched prototype caught it.
        await Promise.race([lastRun?.catch(onStray), done]);
    } catch (e) {
        onStray(e);
    }
    // Let output scheduled with setImmediate (e.g. a listener's 'closed') land before the case is closed.
    await new Promise((r) => setImmediate(r));
    clearTimeout(timer);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    if (!state.exited) {
        state.exited = true;
        state.code = Number(process.exitCode) || 0;
    }
    current = null;
    results.push({ id: c.id, code: state.code, stdout: state.stdout, stderr: state.stderr, timedOut: state.timedOut });
}

writeFileSync(outPath, JSON.stringify(results));
// Timers and handles a case left behind (a listener, a db) must not keep the worker alive.
realExit(0);
