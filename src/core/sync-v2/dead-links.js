/**
 * The media links the CDN has already answered 404 or 410 for, so a run does not ask again.
 *
 * Zalo keeps the same memory: a link it was told is gone is not requested a second time. Without it every
 * `sync-media` began by re-asking, newest first, the same tens of thousands of dead links before it reached one that
 * still worked.
 *
 * Keyed by the link, never by the message: a fresh sync that hands out a new link for the same message is tried like
 * any other. The file holds no link either -- only a truncated SHA-256 of each -- and is sealed with the account's
 * data key like the conversation index beside it. It lives in the account's own media folder (never in a shared
 * override root), is capped, and drops its oldest entries first. A run that cannot read it starts with an empty list
 * rather than failing, and a run that cannot write it loses only the memory, never a download.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readSealedJson, writeSealedJson } from "../keystore/index.js";

/** The file name, at the root of `accounts/<ownId>/media/`. */
export const DEAD_LINKS_FILE = "_dead-links.json";

/** At most this many links are remembered; past it the oldest go first. */
export const DEAD_LINKS_CAP = 100_000;

/** The sealed-file spec. */
const SPEC = Object.freeze({ kind: "media-dead-links", use: "data" });

/** New entries between two writes during a run, so a killed run keeps most of what it learned. */
const FLUSH_EVERY = 500;

/**
 * The key a link is remembered by: 128 bits of its SHA-256, base64url. Not reversible to the link.
 *
 * @param {string} url
 * @returns {string}
 */
export function deadLinkKey(url) {
    return createHash("sha256").update(String(url)).digest("base64url").slice(0, 22);
}

/**
 * Open an account's dead-link list.
 *
 * @param {string} mediaDir - the account's own media folder (`<accountDir>/media`)
 * @param {{id: string, dir: string}} scope - the account
 * @param {{cap?: number}} [opts]
 * @returns {{has: (url: string) => boolean, add: (url: string) => void, flush: () => void, readonly size: number,
 *   file: string}}
 */
export function openDeadLinks(mediaDir, scope, { cap = DEAD_LINKS_CAP } = {}) {
    const file = join(mediaDir, DEAD_LINKS_FILE);
    // Insertion order is age order: a Set iterates oldest first, which is what eviction needs.
    const keys = new Set();
    try {
        const saved = readSealedJson(file, scope, SPEC);
        if (Array.isArray(saved?.keys)) for (const k of saved.keys) if (typeof k === "string") keys.add(k);
    } catch {
        /* unreadable (damaged, or no key now): start empty; the next write replaces it */
    }
    let unsaved = 0;
    const flush = () => {
        if (!unsaved) return;
        try {
            mkdirSync(mediaDir, { recursive: true });
            writeSealedJson(file, scope, SPEC, { v: 1, keys: [...keys] });
            unsaved = 0;
        } catch {
            /* a memory, never a reason to fail a download run */
        }
    };
    return {
        file,
        get size() {
            return keys.size;
        },
        has: (url) => keys.has(deadLinkKey(url)),
        add(url) {
            const k = deadLinkKey(url);
            if (keys.has(k)) return;
            keys.add(k);
            while (keys.size > cap) keys.delete(keys.values().next().value);
            if (++unsaved >= FLUSH_EVERY) flush();
        },
        flush,
    };
}
