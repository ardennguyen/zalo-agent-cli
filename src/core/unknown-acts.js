/**
 * The control actions this client has no handler for, collected (plan item X10).
 *
 * The server pushes actions to a connected client as `602` frames (`data.actions[{act_type, act, data}]`) and as the
 * `controls[]` of a `601` frame. zca-js reads one kind of 602 (`typing`); a build of Zalo Web handles dozens more, and a
 * new one can appear with any server release. Nothing here changes how a frame is handled. It only notices a name this
 * client does not know, once, and keeps a small local file so that a person (or the next release) can see which actions
 * the server is sending that nobody handles.
 *
 * What is stored, per `act_type/act`: when it was first and last seen, how often, which command carried it, and the
 * NAMES of the keys of its `data` (never the values: a control can carry a message, a name or an id). The file lives in
 * the account folder at 0600 and holds no identity. Reading a frame is defensive on every line: a frame of an
 * unexpected shape is skipped, and nothing here can throw into the socket.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { readControls } from "./control-queue.js";

/** The chat push that carries `actions[]`. */
export const CMD_PUSH_ACTIONS = 602;
/** The control push whose `controls[]` this also reads. */
export const CMD_PUSH_CONTROLS = 601;

/** 602 actions a handler of this client or of zca-js already reads. */
const KNOWN_ACTIONS = new Set(["typing"]);

/**
 * The socket commands this client handles or names on purpose (the offline queues, messages, receipts, reactions, the
 * sync-v2 pair, the control pushes, the zCloud notice, the handshake and the keepalive). Any other command that
 * arrives is noted once, by number: the server can start sending a new one with any release, and until now the
 * ones that were not handled (533, 570 to 578, 592, 604, 614, 620, 623, 800 were seen in captures) left no trace.
 */
export const KNOWN_COMMANDS = new Set([
    1, 2, 501, 502, 504, 510, 511, 521, 522, 524, 532, 534, 590, 591, 601, 602, 603, 610, 611, 612, 613, 621,
]);

/** How many distinct names one file keeps: a flood of new names must not grow it without end. */
export const MAX_NAMES = 200;
/** How often the counts of names already known are written back. */
export const SAVE_EVERY_MS = 60_000;
/** How many key names of a `data` are kept per action. */
const MAX_KEYS = 12;

/**
 * The actions of one 602 frame.
 *
 * @param {object|null|undefined} data - a decoded 602 frame's `data`
 * @returns {Array<{actType: string, act: string, keys: string[]}>}
 */
export function readActions(data) {
    const out = [];
    for (const a of Array.isArray(data?.actions) ? data.actions : []) {
        if (!a || typeof a !== "object") continue;
        const inner = a.data;
        let obj = inner;
        if (typeof inner === "string") {
            try {
                obj = JSON.parse(inner);
            } catch {
                obj = null;
            }
        }
        out.push({
            actType: String(a.act_type ?? ""),
            act: String(a.act ?? ""),
            keys: obj && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).slice(0, MAX_KEYS) : [],
        });
    }
    return out;
}

/** The names of the saved file, or an empty set when there is no usable one. */
function loadNames(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const names = parsed?.names;
        return names && typeof names === "object" && !Array.isArray(names) ? { ...names } : {};
    } catch {
        return {};
    }
}

/**
 * A collector for one account.
 *
 * @param {object} args
 * @param {string} args.file - where the names are kept (created on the first unknown name)
 * @param {() => number} [args.now]
 * @param {(line: string) => void} [args.log] - told once per new name
 * @returns {{
 *   observeCommand: (view: object) => number,
 *   observe: (cmd: number, data: object|null|undefined) => number,
 *   names: () => Record<string, {firstSeen: number, lastSeen: number, count: number, cmd: number, keys: string[]}>,
 * }} `observe` returns how many names in this frame were new to the file
 */
export function createUnknownActs({ file, now = Date.now, log = () => {} }) {
    const names = loadNames(file);
    let dirty = false;
    let savedAt = 0;

    function note(cmd, actType, act, keys) {
        const key = `${actType || "?"}/${act || "?"}`;
        const t = now();
        const seen = names[key];
        if (seen) {
            seen.count += 1;
            seen.lastSeen = t;
            dirty = true;
            return false;
        }
        if (Object.keys(names).length >= MAX_NAMES) return false;
        names[key] = { firstSeen: t, lastSeen: t, count: 1, cmd, keys };
        try {
            log(`unknown action from the server: ${key} (cmd ${cmd}); noted in ${file}`);
        } catch {
            /* a broken logger must not break the socket */
        }
        return true;
    }

    function save() {
        dirty = false;
        savedAt = now();
        try {
            writeFileAtomic(file, JSON.stringify({ names }), { mode: 0o600 });
        } catch {
            /* the file is a convenience: failing to write it is not a reason to disturb anything */
        }
    }

    return {
        /**
         * One frame's header: a command that is not in {@link KNOWN_COMMANDS} is noted as `cmd/<cmd>_<subCmd>`, with the
         * key names of its body (never the values) from the first time it is seen.
         *
         * @param {{cmd: number, subCmd: number, size: number, frame: () => (object|null)}} view
         * @returns {number} 1 when the name was new
         */
        observeCommand(view) {
            try {
                if (KNOWN_COMMANDS.has(view.cmd)) return 0;
                const key = `cmd/${view.cmd}_${view.subCmd}`;
                let fresh = 0;
                if (names[key]) {
                    note(view.cmd, "cmd", `${view.cmd}_${view.subCmd}`, []);
                } else {
                    let keys = [];
                    try {
                        const data = view.frame()?.data;
                        if (data && typeof data === "object" && !Array.isArray(data)) {
                            keys = Object.keys(data).slice(0, MAX_KEYS);
                        }
                    } catch {
                        /* an undecodable body is still a command worth naming */
                    }
                    if (note(view.cmd, "cmd", `${view.cmd}_${view.subCmd}`, keys)) {
                        names[key].size = view.size;
                        fresh = 1;
                    }
                }
                if (fresh > 0 || (dirty && now() - savedAt >= SAVE_EVERY_MS)) save();
                return fresh;
            } catch {
                return 0;
            }
        },
        observe(cmd, data) {
            let fresh = 0;
            try {
                if (cmd === CMD_PUSH_ACTIONS) {
                    for (const a of readActions(data)) {
                        if (KNOWN_ACTIONS.has(a.actType)) continue;
                        if (note(cmd, a.actType, a.act, a.keys)) fresh++;
                    }
                } else if (cmd === CMD_PUSH_CONTROLS) {
                    for (const c of readControls(data)) {
                        if (c.handled) continue;
                        if (note(cmd, c.actType, c.act, c.data ? Object.keys(c.data).slice(0, MAX_KEYS) : [])) fresh++;
                    }
                }
                // A new name is written at once; the counts of known names at most once a minute.
                if (fresh > 0 || (dirty && now() - savedAt >= SAVE_EVERY_MS)) save();
            } catch {
                /* a frame of a shape nobody expected is skipped */
            }
            return fresh;
        },
        names: () => ({ ...names }),
    };
}

/**
 * Collect unknown actions from a socket tap, for one account. Built the same by `listen` and `mcp start`.
 *
 * @param {object} args
 * @param {{on: (cmd: number, fn: (frame: object) => void) => () => void}} args.tap
 * @param {string} args.file - see {@link createUnknownActs}
 * @param {(line: string) => void} [args.log]
 * @returns {{stop: () => void, names: ReturnType<typeof createUnknownActs>["names"]}}
 */
export function attachUnknownActs({ tap, file, log }) {
    const acts = createUnknownActs({ file, log });
    const offs = [CMD_PUSH_ACTIONS, CMD_PUSH_CONTROLS].map((cmd) =>
        tap.on(cmd, (frame) => acts.observe(cmd, frame.data)),
    );
    // Every other command, by number (a tap without `onAny` simply does not offer this).
    if (typeof tap.onAny === "function") offs.push(tap.onAny((view) => acts.observeCommand(view)));
    return {
        stop() {
            for (const off of offs.splice(0)) off();
        },
        names: acts.names,
    };
}
