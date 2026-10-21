/**
 * What a daemon's log does between a line being written and it reaching `daemon.log`: a level filter,
 * a timestamp (or JSON), and size-based rotation.
 *
 * `daemon.log` used to be everything `mcp start` / `listen` print, forever: one line per HTTP request
 * (with the caller's address and user agent), one per message (with its text), no timestamps, and a file
 * that only ever grew. A fleet of daemons turns that into disk pressure and a log pipeline full of noise,
 * and the message lines put private text in a file whose job is to say what the daemon is doing.
 *
 *   - Levels `error` < `warn` < `info` < `debug`, default `info`. A line is `debug` when it starts with
 *     {@link DEBUG_MARK}: the per-request and per-message lines. Every other line is classified by its
 *     wording ({@link classifyLine}), because the daemons write free text through console.error from a
 *     hundred places and this changes none of them.
 *   - Text lines get an ISO timestamp; `ZALO_LOG_FORMAT=json` writes one JSON object per line instead.
 *   - The file is rotated by size: `daemon.log` -> `daemon.log.1` -> ... -> `daemon.log.<keep>`, the
 *     oldest dropped.
 *
 * Settings: `ZALO_LOG_LEVEL`, `ZALO_LOG_FORMAT`, `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP`, each with an
 * `_<ownId>` form that wins, and `--log-level` on both daemons.
 */

import fs from "node:fs";

export const LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug"]);
export const LOG_FORMATS = Object.freeze(["text", "json"]);

/** A line that begins with this is a `debug` line: per request, per message. */
export const DEBUG_MARK = "[debug] ";

export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_KEEP = 3;
/** Below this a rotation would run every few lines. */
export const MIN_MAX_BYTES = 4 * 1024;

const ANSI = /\x1b\[[0-9;]*m/g;
const rank = (level) => LOG_LEVELS.indexOf(level);

/**
 * The level of one log line, by its wording. Not exact, and not meant to be: it decides which lines a
 * `warn` or `error` setting keeps, and a missed one is one the daemon wrote as plain text.
 *
 * @param {string} line
 * @returns {"error"|"warn"|"info"|"debug"}
 */
export function classifyLine(line) {
    if (line.startsWith(DEBUG_MARK)) return "debug";
    const text = line.replace(ANSI, "");
    if (/WARNING|⚠|\bwarn(ing)?\b/i.test(text)) return "warn";
    if (
        /\b(fail(ed|ure|s)?|error|exception|fatal|refus(ed|ing)|cannot|could not|unable|exited|crash(ed)?)\b|✗|✖|ECONN|EADDR|EPERM|EACCES/i.test(
            text,
        )
    ) {
        return "error";
    }
    return "info";
}

/**
 * Parse `20m`, `500k`, `1g` or a plain byte count.
 * @param {string|number|null|undefined} value
 * @returns {number|null} Bytes, or null when it is not a size
 */
export function parseSize(value) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)b?\s*$/i.exec(String(value ?? ""));
    if (!m) return null;
    const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
    return Math.floor(Number(m[1]) * mult);
}

/**
 * The logging settings of one daemon: flag, then `NAME_<ownId>`, then `NAME`, then the defaults. A value
 * that cannot be used is reported and replaced by the default, so a typo is not mistaken for a setting.
 *
 * @param {object} args
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {string|null} [args.ownId]
 * @param {string|null} [args.levelFlag] - `--log-level`
 * @returns {{ level: string, format: string, maxBytes: number, keep: number, warnings: string[], explicit: boolean }}
 *   `explicit` is true when anything was asked for, so a foreground run knows to filter its stderr at all
 */
export function resolveLogSettings({ env = process.env, ownId = null, levelFlag = null } = {}) {
    const warnings = [];
    const pick = (name) => {
        const scoped = ownId ? env[`${name}_${ownId}`] : undefined;
        const v = typeof scoped === "string" && scoped.trim() ? scoped : env[name];
        return typeof v === "string" && v.trim() ? v.trim() : null;
    };

    const rawLevel = levelFlag?.trim() || pick("ZALO_LOG_LEVEL");
    let level = DEFAULT_LOG_LEVEL;
    if (rawLevel) {
        if (LOG_LEVELS.includes(rawLevel.toLowerCase())) level = rawLevel.toLowerCase();
        else
            warnings.push(`log level "${rawLevel}" is not one of ${LOG_LEVELS.join(", ")}; using ${DEFAULT_LOG_LEVEL}`);
    }

    const rawFormat = pick("ZALO_LOG_FORMAT");
    let format = "text";
    if (rawFormat) {
        if (LOG_FORMATS.includes(rawFormat.toLowerCase())) format = rawFormat.toLowerCase();
        else warnings.push(`log format "${rawFormat}" is not one of ${LOG_FORMATS.join(", ")}; using text`);
    }

    const rawSize = pick("ZALO_LOG_MAX_SIZE");
    let maxBytes = DEFAULT_MAX_BYTES;
    if (rawSize) {
        const n = parseSize(rawSize);
        if (n !== null && n >= MIN_MAX_BYTES) maxBytes = n;
        else warnings.push(`log max size "${rawSize}" is not a size of at least 4k (e.g. 20m, 1g); using 50m`);
    }

    const rawKeep = pick("ZALO_LOG_KEEP");
    let keep = DEFAULT_KEEP;
    if (rawKeep) {
        const n = Number(rawKeep);
        if (Number.isInteger(n) && n >= 0 && n <= 50) keep = n;
        else warnings.push(`log keep "${rawKeep}" is not a whole number from 0 to 50; using ${DEFAULT_KEEP}`);
    }

    const explicit = Boolean(levelFlag || pick("ZALO_LOG_LEVEL") || pick("ZALO_LOG_FORMAT"));
    return { level, format, maxBytes, keep, warnings, explicit };
}

/**
 * One log line, as it is written.
 *
 * @param {object} args
 * @param {string} args.line - Without its newline
 * @param {string} args.level - The line's level
 * @param {"text"|"json"} args.format
 * @param {Date} args.at
 * @param {string|null} [args.accountId]
 * @returns {string} Without a newline
 */
export function formatLine({ line, level, format, at, accountId = null }) {
    if (format === "json") {
        const plain = line.replace(ANSI, "");
        const msg = plain.startsWith(DEBUG_MARK) ? plain.slice(DEBUG_MARK.length) : plain;
        return JSON.stringify({
            ts: at.toISOString(),
            level,
            ...(accountId ? { account: accountId } : {}),
            msg: msg.trimEnd(),
        });
    }
    return `${at.toISOString()} ${line}`;
}

/**
 * A log file that rotates by size.
 *
 * @param {object} args
 * @param {string} args.file
 * @param {number} args.maxBytes
 * @param {number} args.keep - How many rotated files to keep (0: just start over)
 * @param {typeof fs} [args.fsImpl] - Test seam
 * @param {() => Date} [args.now]
 * @returns {{ write: (text: string) => void, rotate: () => boolean, close: () => void, size: () => number }}
 */
export function createRotatingFile({ file, maxBytes, keep, fsImpl = fs, now = () => new Date() }) {
    let fd = null;
    let size = 0;
    let rotateAt = maxBytes;

    const open = () => {
        fd = fsImpl.openSync(file, "a", 0o600);
        try {
            size = fsImpl.fstatSync(fd).size;
        } catch {
            size = 0;
        }
    };

    function rotate() {
        try {
            if (fd !== null) fsImpl.closeSync(fd);
        } catch {
            /* closing a handle that is already gone */
        }
        fd = null;
        try {
            if (keep > 0) {
                for (let i = keep - 1; i >= 1; i--) {
                    try {
                        fsImpl.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
                    } catch (e) {
                        if (e.code !== "ENOENT") throw e;
                    }
                }
                fsImpl.renameSync(file, `${file}.1`);
            } else {
                fsImpl.unlinkSync(file);
            }
            open();
            rotateAt = maxBytes;
            const header = `--- [${now().toISOString()}] log rotated: the previous ${keep > 0 ? "file is daemon.log.1" : "log was discarded"} ---\n`;
            fsImpl.writeSync(fd, header);
            size += Buffer.byteLength(header);
            return true;
        } catch {
            // Windows refuses to rename a file another process (a tail, an editor) has open. Carry on
            // appending to the same file and look again after another megabyte.
            try {
                open();
            } catch {
                fd = null;
            }
            rotateAt = size + 1024 * 1024;
            return false;
        }
    }

    return {
        write(text) {
            try {
                if (fd === null) open();
                const buf = Buffer.from(text, "utf8");
                fsImpl.writeSync(fd, buf);
                size += buf.length;
                if (maxBytes > 0 && size >= rotateAt) rotate();
            } catch {
                /* logging must never take the daemon down */
            }
        },
        rotate,
        close() {
            try {
                if (fd !== null) fsImpl.closeSync(fd);
            } catch {
                /* already closed */
            }
            fd = null;
        },
        size: () => size,
    };
}

/**
 * The line-oriented filter in front of a file (or any `write(text)`).
 *
 * Chunks are not lines: a write can hold three lines or half of one. Complete lines are classified,
 * filtered and formatted; a partial line waits for its newline, and is flushed after a moment so it never
 * sits unwritten. A continuation (an indented line, such as a stack frame) takes the level of the line
 * before it, so an error's stack is kept or dropped with it.
 *
 * @param {object} args
 * @param {(text: string) => void} args.write
 * @param {string} [args.level]
 * @param {"text"|"json"} [args.format]
 * @param {string|null} [args.accountId]
 * @param {() => Date} [args.now]
 * @param {number} [args.flushMs]
 * @returns {{ write: (chunk: string|Buffer) => void, flush: () => void, setLevel: (l: string) => void, setFormat: (f: string) => void, level: () => string }}
 */
export function createLogSink({
    write,
    level = DEFAULT_LOG_LEVEL,
    format = "text",
    accountId = null,
    now = () => new Date(),
    flushMs = 250,
}) {
    let threshold = rank(level) >= 0 ? level : DEFAULT_LOG_LEVEL;
    let fmt = format;
    let partial = "";
    let lastLevel = "info";
    let timer = null;

    const emit = (line) => {
        const continuation = /^\s+\S/.test(line) && !line.startsWith(DEBUG_MARK);
        const lineLevel = continuation ? lastLevel : classifyLine(line);
        lastLevel = lineLevel;
        if (rank(lineLevel) > rank(threshold)) return;
        write(`${formatLine({ line, level: lineLevel, format: fmt, at: now(), accountId })}\n`);
    };

    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (partial) {
            const p = partial;
            partial = "";
            emit(p);
        }
    };

    return {
        write(chunk) {
            const text = partial + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
            const lines = text.split(/\r?\n/);
            partial = lines.pop() ?? "";
            for (const line of lines) if (line.length) emit(line);
            if (timer) clearTimeout(timer);
            timer = null;
            if (partial) {
                timer = setTimeout(flush, flushMs);
                timer.unref?.();
            }
        },
        flush,
        setLevel(l) {
            if (rank(l) >= 0) threshold = l;
        },
        setFormat(f) {
            if (LOG_FORMATS.includes(f)) fmt = f;
        },
        level: () => threshold,
    };
}
