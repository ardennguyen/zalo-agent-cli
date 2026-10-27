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
                        if (note(cmd, c.actType, c.act, [])) fresh++;
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
    return {
        stop() {
            for (const off of offs.splice(0)) off();
        },
        names: acts.names,
    };
}
