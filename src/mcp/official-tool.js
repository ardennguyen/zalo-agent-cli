/**
 * `zalo_official`: the official-API commands (`oa …`, `zbs …`, `social …`) as one MCP tool.
 *
 * Each call runs the CLI command itself, `zalo-agent --json <command> …`, in a child process: the tool and the command
 * cannot drift apart, and the official APIs never touch the personal account's session (they have their own OAuth
 * logins under ~/.zalo-agent/). The command tree is read from the same `register*` functions src/index.js calls, so the
 * tool's command list, arguments and options are the CLI's. A guarded command (src/core/confirm-guard.js) is settled
 * here first, through the server's confirm mode, and then run with `--yes`.
 *
 * The commands left out (OFFICIAL_CLI_ONLY) are the ones that take a secret as input, open a browser login, or run a
 * long-lived server; tests/unit/mcp-cli-parity.test.js holds every other one to an entry in the tool's list.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import { registerOACommands } from "../commands/oa.js";
import { registerZbsCommands } from "../commands/zbs.js";
import { registerSocialCommands } from "../commands/social.js";
import { confirmInput, dryRunInput, ticketInput } from "./action-tool.js";
import { REMOTE_FILE_HINT, fileSourceSchema } from "./file-input.js";

/** Official commands with no MCP counterpart, and why. Mirrored in skill/references/mcp-guide.md. */
export const OFFICIAL_CLI_ONLY = Object.freeze({
    "oa login": "an OAuth login in the owner's browser on a local callback port: an operator's step",
    "oa setup": "takes the OA access token as an argument: credentials never pass through an agent",
    "oa init": "the setup wizard: takes the app secret and logs in through the browser",
    "oa listen": "a long-running webhook server: run it as a service, not from a tool call",
    "social setup": "takes the app secret: credentials never pass through an agent",
    "social login": "an OAuth login in the user's browser on a local callback port",
});

/** Options a caller never sets through `options`: the tool's own inputs answer for them. */
const RESERVED = new Set(["yes", "dry-run", "json", "help"]);

/**
 * The CLI entry point the commands run through. In the published bundle (scripts/build.mjs) this module is inlined
 * into dist/index.js, which is itself the CLI entry, so __ZALO_CLI_ENTRY_SPEC__ (substituted by esbuild) resolves to
 * "./index.js". From source it is undefined and the entry is ../index.js next to src/mcp/.
 */
const CLI_ENTRY = fileURLToPath(
    new URL(typeof __ZALO_CLI_ENTRY_SPEC__ !== "undefined" ? __ZALO_CLI_ENTRY_SPEC__ : "../index.js", import.meta.url),
);

/** How long one command may run: `oa article create` and `video-upload` wait for Zalo's processing. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

let tree = null;

/**
 * The official commands by their CLI path ("oa msg text"), from the same registrations src/index.js makes.
 *
 * @returns {Map<string, import("commander").Command>}
 */
export function officialCommands() {
    if (tree) return tree;
    const program = new Command();
    registerOACommands(program);
    registerZbsCommands(program);
    registerSocialCommands(program);
    const map = new Map();
    const walk = (cmd, path) => {
        for (const c of cmd.commands) {
            const p = [...path, c.name()];
            if (c.commands.length) walk(c, p);
            else if (!OFFICIAL_CLI_ONLY[p.join(" ")]) map.set(p.join(" "), c);
        }
    };
    walk(program, []);
    tree = map;
    return map;
}

/** An option's flag name without the dashes ("oa-id", "no-wait"). */
const flagName = (o) => (o.long ?? o.short).replace(/^-+/, "");

/** The argument and option names that take a file on the machine the command runs on. */
const FILE_ARG_NAMES = new Set(["file", "file-path"]);
const FILE_OPTION_NAMES = new Set(["file", "image", "rsa-key"]);

/**
 * A command's file parameters: its positional arguments and options that take a path (`oa upload image <file-path>`,
 * `oa msg image --file`, `zbs send --rsa-key`), by name, with the position of an argument.
 *
 * @param {import("commander").Command} cmd
 * @returns {Map<string, {kind: "arg", index: number}|{kind: "option", option: object}>}
 */
export function officialFileParams(cmd) {
    const out = new Map();
    cmd.registeredArguments.forEach((a, index) => {
        if (FILE_ARG_NAMES.has(a.name())) out.set(a.name(), { kind: "arg", index });
    });
    for (const o of cmd.options) {
        if (FILE_OPTION_NAMES.has(flagName(o)) && !o.negate) out.set(flagName(o), { kind: "option", option: o });
    }
    return out;
}

/** What an option takes: nothing (a switch), one value, an optional value, or a list. */
function takes(o) {
    if (o.variadic) return "values";
    if (o.required) return "value";
    if (o.optional) return "optional value";
    return "none";
}

/**
 * One command's usage, as the tool lists it: its positional arguments and its options by flag name.
 *
 * @param {string} path
 * @param {import("commander").Command} cmd
 * @returns {object}
 */
export function describeOfficial(path, cmd) {
    return {
        command: path,
        description: cmd.description(),
        args: cmd.registeredArguments.map((a) => ({
            name: a.name(),
            required: a.required,
            ...(a.variadic && { list: true }),
            ...(a.description && { description: a.description }),
        })),
        options: cmd.options
            .filter((o) => !RESERVED.has(flagName(o)))
            .map((o) => ({
                name: flagName(o),
                takes: takes(o),
                description: o.description,
                ...(o.defaultValue !== undefined && typeof o.defaultValue !== "boolean" && { default: o.defaultValue }),
            })),
        ...(cmd.zaloGuard && { guarded: true }),
        ...(officialFileParams(cmd).size && { fileArgs: [...officialFileParams(cmd).keys()] }),
    };
}

/** The option an `options` key names: its flag name ("oa-id"), with or without dashes, or its camelCase name. */
function findOption(cmd, key) {
    const k = String(key).replace(/^-+/, "");
    return cmd.options.find((o) => flagName(o) === k || o.attributeName() === k) ?? null;
}

/**
 * The argv for one command, after checking its arguments and options against the command, plus the parsed values
 * the guard reads. Options go first as `--flag=value`, then `--`, then the arguments: an argument that starts with a
 * dash is never read as a flag.
 *
 * @param {string} path - e.g. "oa msg text"
 * @param {import("commander").Command} cmd
 * @param {string[]} [args]
 * @param {Record<string, unknown>} [options]
 * @returns {{argv: string[], positional: unknown[], opts: object} | {error: string}}
 */
export function officialArgv(path, cmd, args = [], options = {}) {
    const usage = () => ` Usage: ${JSON.stringify(describeOfficial(path, cmd))}`;
    const regs = cmd.registeredArguments;
    const variadic = regs.at(-1)?.variadic === true;
    const required = regs.filter((a) => a.required).length;
    if (args.length < required)
        return { error: `'${path}' needs ${required} argument(s), got ${args.length}.${usage()}` };
    if (!variadic && args.length > regs.length) {
        return { error: `'${path}' takes at most ${regs.length} argument(s), got ${args.length}.${usage()}` };
    }
    const positional = regs.map((a, i) => (a.variadic ? args.slice(i) : args[i]));

    const flags = [];
    const opts = {};
    for (const o of cmd.options) if (o.defaultValue !== undefined) opts[o.attributeName()] = o.defaultValue;
    for (const [key, value] of Object.entries(options ?? {})) {
        const o = findOption(cmd, key);
        if (!o || RESERVED.has(flagName(o))) {
            return { error: `'${path}' has no option '${key}'.${usage()}` };
        }
        const flag = o.long ?? o.short;
        const kind = takes(o);
        if (kind === "none") {
            if (typeof value !== "boolean") return { error: `Option '${key}' is a switch: give true or false.` };
            if (value) {
                flags.push(flag);
                opts[o.attributeName()] = !o.negate;
            }
            continue;
        }
        if (value === false || value === null) continue;
        if (kind === "optional value" && value === true) {
            flags.push(flag);
            opts[o.attributeName()] = true;
            continue;
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.length > 1 && kind !== "values") return { error: `Option '${key}' takes one value.` };
        if (values.some((v) => typeof v === "boolean" || typeof v === "object")) {
            return { error: `Option '${key}' takes a value (a string or a number).` };
        }
        for (const v of values) flags.push(`${flag}=${String(v)}`);
        opts[o.attributeName()] = kind === "values" ? values.map(String) : String(values[0]);
    }
    return { argv: [...path.split(" "), ...flags, "--", ...args.map(String)], positional, opts };
}

/**
 * Run the CLI with `argv` and settle when it exits.
 *
 * @param {string[]} argv
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runOfficialCli(argv) {
    return new Promise((done) => {
        execFile(
            process.execPath,
            [CLI_ENTRY, "--json", ...argv],
            {
                env: { ...process.env, ZALO_JSON_MODE: "1" },
                maxBuffer: 64 * 1024 * 1024,
                timeout: RUN_TIMEOUT_MS,
                windowsHide: true,
            },
            (e, stdout, stderr) => {
                const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
                done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), killed: e?.killed === true });
            },
        );
    });
}

/** The command's JSON reply: the whole of stdout, or else its last JSON value; null when there is none. */
function parseReply(stdout) {
    const text = stdout.trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        const start = Math.max(text.lastIndexOf("\n{"), text.lastIndexOf("\n["));
        if (start < 0) return null;
        try {
            return JSON.parse(text.slice(start + 1));
        } catch {
            return null;
        }
    }
}

/** The tool's metadata. */
export function officialMeta() {
    const names = [...officialCommands().keys()];
    return {
        title: "Zalo Official APIs (OA, ZBS, Social)",
        description:
            "Run one of Zalo's official-API commands, the same as the CLI `zalo-agent <command>`: Official Account " +
            "(`oa …`: consultation messages, followers, tags, articles, OA group chats, calls), ZBS Template Message " +
            "(`zbs …`: paid template messages by phone number or user id) and the Social API (`social …`: the profile " +
            "of a user who logged in to the owner's app). These use the owner's official OAuth logins, never the " +
            "personal account. Omit `command` to list every command with its arguments and options. `args` are the " +
            "positional arguments in order; `options` are named by the CLI flag without dashes, e.g. " +
            '{"oa-id": "shop", "quote": "<message id>"}; a switch takes true. The logins themselves (`oa login`, ' +
            "`oa setup`, `oa init`, `social setup`, `social login`) and `oa listen` are run by the owner on the CLI. " +
            "Guarded commands (deletions, `oa purchase confirm-order`, `oa call consent-request`) take `confirm` " +
            "and `dryRun` like every guarded action. A command that takes a file (its listing names its `fileArgs`, " +
            "e.g. `oa upload image`'s 'file-path') takes it in `fileArgs` as {fileId}, {url} or {data, name}; a " +
            "path in `args`/`options` is read only for a caller on the machine this server runs on.",
        inputSchema: z
            .object({
                command: z
                    .enum(names)
                    .optional()
                    .describe("The command, as on the CLI (e.g. 'oa msg text'); omit to list them all"),
                args: z
                    .array(z.union([z.string(), z.number()]))
                    .max(100)
                    .optional()
                    .describe("Positional arguments, in the command's order (ids as strings)"),
                options: z
                    .record(
                        z.string(),
                        z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
                    )
                    .optional()
                    .describe('Options by CLI flag name without dashes, e.g. {"oa-id": "shop", "all": true}'),
                fileArgs: z
                    .record(z.string(), fileSourceSchema())
                    .optional()
                    .describe(
                        "A command's file arguments or options, by name (its listing's `fileArgs`), as files: e.g. " +
                            '{"file-path": {"fileId": "f_..."}} for `oa upload image`. ' +
                            REMOTE_FILE_HINT,
                    ),
                confirm: confirmInput("a guarded command (deletions, paying an order, a call consent request)"),
                dryRun: dryRunInput("a guarded command"),
                ticket: ticketInput(),
            })
            .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    };
}

/**
 * zalo_official's handler.
 *
 * @param {{ok: Function, err: Function, gate: Function}} ctx - the reply wrappers and the guard (mcp-tools.js)
 * @param {{run?: typeof runOfficialCli}} [deps] - the runner (tests pass a fake)
 * @returns {(args: object, extra?: object) => Promise<object>}
 */
export function officialTool(ctx, { run = runOfficialCli } = {}) {
    return async ({ command, args = [], options = {}, fileArgs, confirm, dryRun, ticket } = {}, extra) => {
        const commands = officialCommands();
        if (!command) return ctx.ok({ commands: [...commands].map(([p, c]) => describeOfficial(p, c)) });
        const cmd = commands.get(command);
        if (!cmd) return ctx.err(`Unknown official command '${command}'. Omit command to list them.`);

        // The files: `fileArgs` items, and any path given as a file argument or option (which a caller on another
        // machine may not name), resolved to paths here for the one run (src/core/file-inputs.js).
        const params = officialFileParams(cmd);
        const argList = args.map(String);
        const opts = { ...options };
        const items = [];
        const place = [];
        for (const [name, source] of Object.entries(fileArgs ?? {})) {
            const p = params.get(name);
            if (!p) {
                return ctx.err(
                    `'${command}' takes no file '${name}'` +
                        (params.size
                            ? ` (its file arguments: ${[...params.keys()].join(", ")})`
                            : " (it takes no file)") +
                        ".",
                );
            }
            if (p.kind === "option" && opts[name] !== undefined)
                return ctx.err(`Give '${name}' in fileArgs or in options, not both.`);
            items.push(source);
            place.push({ name, ...p });
        }
        for (const [name, p] of params) {
            if (fileArgs?.[name] !== undefined) continue;
            const v = p.kind === "arg" ? argList[p.index] : opts[name];
            if (typeof v !== "string" || /^https?:\/\//i.test(v)) continue;
            items.push(v);
            place.push({ name, ...p, given: true });
        }
        // An argument given through fileArgs goes in at its position, ahead of the arguments after it.
        for (const pl of [...place].filter((x) => x.kind === "arg" && !x.given).sort((a, b) => a.index - b.index)) {
            if (argList.length < pl.index) {
                return ctx.err(`'${command}' needs its arguments before '${pl.name}' in args.`);
            }
            argList.splice(pl.index, 0, "");
        }
        const runWith = async (paths) => {
            paths.forEach((path, i) => {
                const pl = place[i];
                if (pl.kind === "arg") argList[pl.index] = path;
                else opts[pl.name] = path;
            });
            return runCommand(command, cmd, argList, opts, { confirm, dryRun, ticket }, extra);
        };
        if (!items.length) return runWith([]);
        if (!ctx.files) {
            if (place.some((x) => !x.given)) return ctx.err("This server takes no files in fileArgs.");
            return runCommand(command, cmd, argList, opts, { confirm, dryRun, ticket }, extra);
        }
        const out = await ctx.files.run(items, "fileArgs", (files) => runWith(files.map((f) => f.path)));
        return out.fileError ? ctx.err(out.fileError) : out;
    };

    async function runCommand(command, cmd, argList, opts, { confirm, dryRun, ticket }, extra) {
        const built = officialArgv(command, cmd, argList, opts);
        if (built.error) return ctx.err(built.error);

        const guard = cmd.zaloGuard;
        if (guard) {
            const target = guard.target(...built.positional, built.opts);
            const applies = guard.when ? guard.when(target, built.opts) : true;
            const held = await ctx.gate(guard.key, target, { confirm, dryRun, ticket }, extra, { applies });
            if (held) return held;
            built.argv.splice(built.argv.indexOf("--"), 0, "--yes");
        } else if (dryRun === true) {
            return ctx.err(
                `dryRun previews only the guarded commands, and '${command}' is not one: nothing was done. Call it ` +
                    "again without dryRun to do it.",
            );
        }

        const r = await run(built.argv);
        const reply = parseReply(r.stdout);
        if (r.code === 0) return ctx.ok({ command, result: reply ?? (r.stdout.trim() || null) });
        if (r.killed) return ctx.err(`'${command}' did not finish within ${RUN_TIMEOUT_MS / 60000} minutes.`);
        const why =
            (reply && typeof reply === "object" && reply.error) ||
            r.stderr.trim().split("\n").filter(Boolean).at(-1) ||
            `'${command}' exited with code ${r.code}`;
        console.error(`[mcp-tools] zalo_official ${command} error:`, why);
        return ctx.err(String(why));
    }
}
