/**
 * Voice-message transcripts, kept as they arrive.
 *
 * `write run voice-to-text` asks Zalo to transcribe a voice message and gets back only a request id. The text comes
 * later, as a `601` control on the socket: `act_type "voice2text"`, `act "convert_finish"`, its data `{req_id, err,
 * text, url, has_more}` (seen live, 2026-10-27; the key names are the web client's own). A command that is not the
 * daemon has no socket to hear it on, so the daemon (`listen`, `mcp start`) writes each answer into a small file in the
 * account folder, and `read run voice-transcript` reads it from there.
 *
 * A long message can arrive in pieces: `has_more` says another piece follows, and the pieces are joined in the order
 * they come. The file holds the text of voice messages, like the message cache does, at 0600 and in the account
 * folder; it keeps the last {@link MAX_ITEMS} requests and nothing else (not the voice file's address).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { readControls } from "./control-queue.js";

/** The control push that carries it. */
export const CMD_PUSH_CONTROLS = 601;
/** The control's own names. */
export const VOICE_ACT_TYPE = "voice2text";
export const VOICE_ACT = "convert_finish";
/** How many requests the file keeps: older ones are dropped first. */
export const MAX_ITEMS = 100;

/**
 * Where an account's transcripts are kept.
 *
 * @param {string} accountDir
 * @returns {string}
 */
export function voiceTextFile(accountDir) {
    return join(accountDir, "voice-text.json");
}

/**
 * The saved transcripts: `{reqId: {at, err, text, done}}`, empty when there is no usable file.
 *
 * @param {string} file
 * @returns {Record<string, {at: number, err: number, text: string, done: boolean}>}
 */
export function loadTranscripts(file) {
    try {
        const items = JSON.parse(readFileSync(file, "utf8"))?.items;
        return items && typeof items === "object" && !Array.isArray(items) ? { ...items } : {};
    } catch {
        return {};
    }
}

/**
 * One transcript, or all of them (newest first) when no request id is given.
 *
 * @param {string} file
 * @param {string} [reqId]
 * @returns {{reqId: string, at: string, err: number, text: string, done: boolean}|null|Array<object>}
 */
export function readTranscript(file, reqId) {
    const items = loadTranscripts(file);
    const shape = (id, v) => ({ reqId: id, at: new Date(v.at).toISOString(), err: v.err, text: v.text, done: v.done });
    if (reqId) return items[reqId] ? shape(reqId, items[reqId]) : null;
    return Object.entries(items)
        .sort((a, b) => b[1].at - a[1].at)
        .map(([id, v]) => shape(id, v));
}

/**
 * A recorder for one account.
 *
 * @param {object} args
 * @param {string} args.file
 * @param {() => number} [args.now]
 * @param {(line: string) => void} [args.log] - told once per finished transcript (never the text)
 * @returns {{observe: (cmd: number, data: object|null|undefined) => number}} `observe` returns how many answers of this
 *   frame it recorded
 */
export function createVoiceText({ file, now = Date.now, log = () => {} }) {
    const items = loadTranscripts(file);

    function save() {
        try {
            writeFileAtomic(file, JSON.stringify({ items }), { mode: 0o600 });
        } catch {
            /* the file is a convenience: failing to write it must not disturb the socket */
        }
    }

    function record(d) {
        const reqId = String(d.req_id ?? "");
        if (!reqId) return false;
        const text = typeof d.text === "string" ? d.text : "";
        const done = !(d.has_more === true || Number(d.has_more) === 1);
        const err = Number(d.err) || 0;
        const prev = items[reqId];
        items[reqId] = {
            at: now(),
            err,
            // The pieces of a long message are joined in the order they arrive.
            text: prev && !prev.done ? prev.text + text : text,
            done,
        };
        const keep = Object.entries(items)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, MAX_ITEMS);
        for (const id of Object.keys(items)) delete items[id];
        for (const [id, v] of keep) items[id] = v;
        if (done) {
            try {
                log(
                    `voice transcript ${err ? `failed (error ${err})` : "ready"}: request ${reqId}; read it with \`read run voice-transcript\``,
                );
            } catch {
                /* a broken logger must not break the socket */
            }
        }
        return true;
    }

    return {
        observe(cmd, data) {
            let recorded = 0;
            try {
                if (cmd !== CMD_PUSH_CONTROLS) return 0;
                for (const c of readControls(data)) {
                    if (c.actType !== VOICE_ACT_TYPE || c.act !== VOICE_ACT || !c.data) continue;
                    if (record(c.data)) recorded++;
                }
                if (recorded) save();
            } catch {
                /* a frame of a shape nobody expected is skipped */
            }
            return recorded;
        },
    };
}

/**
 * Record transcripts from a socket tap, for one account. Built the same by `listen` and `mcp start`.
 *
 * @param {object} args
 * @param {{on: (cmd: number, fn: (frame: object) => void) => () => void}} args.tap
 * @param {string} args.file
 * @param {(line: string) => void} [args.log]
 * @returns {{stop: () => void}}
 */
export function attachVoiceText({ tap, file, log }) {
    const recorder = createVoiceText({ file, log });
    const off = tap.on(CMD_PUSH_CONTROLS, (frame) => recorder.observe(CMD_PUSH_CONTROLS, frame.data));
    return {
        stop() {
            off();
        },
    };
}
