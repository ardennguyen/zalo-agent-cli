/**
 * Searching the local message cache, the way Zalo's own clients do (plan items F3 to F9).
 *
 * Zalo searches messages in the client's own store: there is no server endpoint, and this does not call one either.
 * What it does follow from the official client (see docs/agent-notes.md, "Search"): the keyword and the text are folded
 * alike (src/utils/vn-text.js), the keyword is cut to 100 characters, a hit is shown as a preview of 70 characters
 * before the match and 30 after, results come in pages, and the footer says how far back the local data reaches.
 *
 * A search never writes a message. It may fill in the folded text of rows an older version wrote
 * ({@link backfillTextNorm}); that is derived data.
 */
import {
    countSearchMatchesByType,
    getMessagesAround,
    getOldestCachedTimestamp,
    getSyncState,
    iterateSearchRows,
    searchMessageRows,
} from "./db.js";
import { coverageReport } from "./coverage.js";
import { foldWithMap, normalizeKeyword } from "../utils/vn-text.js";

/** Characters of a hit's preview before the match and after it (Zalo's `max_preview_len` 70 and `bonus_preview_len` 30). */
export const SNIPPET_BEFORE = 70;
export const SNIPPET_AFTER = 30;
/** The most hits a page holds, and the most messages shown around a hit. */
export const MAX_PAGE = 200;
export const MAX_CONTEXT = 10;

/** Names for groups of message types, for `--type`. */
const TYPE_ALIASES = Object.freeze({
    media: ["photo", "video"],
    images: ["photo"],
    image: ["photo"],
    files: ["file"],
    links: ["link"],
    messages: ["text"],
});

/**
 * The message types a `types` option names.
 *
 * @param {string|string[]|null|undefined} input - `"text,file"`, `["photo"]`, or an alias (`media`, `files`, `links`)
 * @returns {string[]|undefined} undefined for no filter
 */
export function resolveTypes(input) {
    const names = (Array.isArray(input) ? input : String(input ?? "").split(","))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean);
    if (!names.length || names.includes("all")) return undefined;
    return [...new Set(names.flatMap((n) => TYPE_ALIASES[n] ?? [n]))];
}

/**
 * A page cursor, as text: the last hit of the page before.
 *
 * @param {{timestamp: number, msgId: string}} last
 * @returns {string}
 */
export function encodeCursor(last) {
    return Buffer.from(JSON.stringify({ t: Number(last.timestamp), m: String(last.msgId) })).toString("base64url");
}

/**
 * @param {string|null|undefined} cursor
 * @returns {{timestamp: number, msgId: string}|null} null for none
 * @throws {Error} for a cursor that is not one of ours
 */
export function decodeCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === "") return null;
    try {
        const o = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
        if (Number.isFinite(o?.t) && typeof o?.m === "string") return { timestamp: o.t, msgId: o.m };
    } catch {
        /* falls through */
    }
    throw new Error("Invalid cursor: pass the nextCursor of a previous page, unchanged.");
}

/**
 * A preview of a text around the keyword: up to `before` characters ahead of the match, the match, up to `after`
 * after, with an ellipsis where the text goes on. Line breaks become spaces one for one, so positions stay true.
 *
 * @param {string} text
 * @param {string} norm - the folded keyword
 * @param {{before?: number, after?: number}} [opts]
 * @returns {{text: string, matchStart: number, matchEnd: number}|{text: string, matchStart: null, matchEnd: null}}
 *   `matchStart` and `matchEnd` locate the keyword in `text` (the preview) for highlighting
 */
export function makeSnippet(text, norm, { before = SNIPPET_BEFORE, after = SNIPPET_AFTER } = {}) {
    const source = String(text ?? "");
    const { norm: folded, map } = foldWithMap(source);
    const at = norm ? folded.indexOf(norm) : -1;
    if (at < 0) {
        const cut = source.length > before + after;
        return {
            text: source.slice(0, before + after).replace(/\s/g, " ") + (cut ? "…" : ""),
            matchStart: null,
            matchEnd: null,
        };
    }
    const start = map[at];
    const end = map[at + norm.length - 1] + 1;
    const from = Math.max(0, start - before);
    const to = Math.min(source.length, end + after);
    const lead = from > 0 ? "…" : "";
    return {
        text: lead + source.slice(from, to).replace(/\s/g, " ") + (to < source.length ? "…" : ""),
        matchStart: lead.length + (start - from),
        matchEnd: lead.length + (end - from),
    };
}

/** Does the text hold the keyword with its accents, ignoring case only (the `exact` mode)? */
function matchesExact(text, keyword) {
    return String(text ?? "")
        .normalize("NFC")
        .toLowerCase()
        .includes(keyword.normalize("NFC").toLowerCase());
}

/**
 * What the search could not see, in the terms of the sync that fills the cache: how far back the cache reaches, when a
 * phone-backed restore last finished, and the coverage gaps still pending with the command that closes them.
 *
 * @param {object} [opts]
 * @param {string} [opts.threadId] - the conversation searched, or none for the whole account
 * @returns {{oldestCachedAt: string|null, lastSyncAt: string|null, pendingGaps: number, command: string|null, note: string}}
 */
export function searchCoverage({ threadId } = {}) {
    const oldest = getOldestCachedTimestamp(threadId);
    const lastSync = Number(getSyncState("lastSyncOkAt"));
    const gaps = coverageReport();
    const oldestCachedAt = oldest ? new Date(oldest).toISOString() : null;
    const lastSyncAt = Number.isFinite(lastSync) && lastSync > 0 ? new Date(lastSync).toISOString() : null;
    const parts = [
        oldestCachedAt
            ? `Searched the local cache only, which holds messages since ${oldestCachedAt.slice(0, 10)}${threadId ? " in this conversation" : ""}.`
            : "Searched the local cache only, which holds no messages yet.",
    ];
    if (!lastSyncAt) parts.push("No phone restore has finished: older history is on your phone (`zalo-agent sync`).");
    if (gaps.pendingCount > 0)
        parts.push(`${gaps.pendingCount} coverage gap(s) pending: \`${gaps.command}\` restores them.`);
    return { oldestCachedAt, lastSyncAt, pendingGaps: gaps.pendingCount, command: gaps.command, note: parts.join(" ") };
}

/**
 * One page of a search of the local cache.
 *
 * @param {object} opts
 * @param {string} opts.query - the keyword (cut to 100 characters, folded)
 * @param {"fold"|"exact"} [opts.accents="fold"] - `fold`: "duoc" finds "được"; `exact`: accents must match (case may not)
 * @param {string} [opts.threadId]
 * @param {string} [opts.senderId]
 * @param {number} [opts.since] - epoch ms
 * @param {number} [opts.until] - epoch ms
 * @param {string|string[]} [opts.types] - see {@link resolveTypes}
 * @param {number} [opts.limit=50] - hits per page, at most {@link MAX_PAGE}
 * @param {string} [opts.cursor] - `nextCursor` of the page before
 * @param {number} [opts.context=0] - messages shown before and after each hit, at most {@link MAX_CONTEXT}
 * @param {boolean} [opts.counts] - the tabs' numbers (default: on the first page only)
 * @returns {{
 *   query: string, accents: string, truncatedKeyword: boolean, count: number,
 *   hits: Array<{row: object, snippet: object, context?: {before: object[], after: object[]}}>,
 *   hasMore: boolean, nextCursor: string|null, counts: Record<string, number>|null, coverage: object
 * }}
 * @throws {Error} for an empty keyword or a cursor that is not ours
 */
export function searchPage(opts = {}) {
    const kw = normalizeKeyword(opts.query);
    if (!kw.norm) throw new Error("A search query is required.");
    const accents = opts.accents === "exact" ? "exact" : "fold";
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(opts.limit)) || 50));
    const context = Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(Number(opts.context)) || 0));
    const filters = {
        norm: kw.norm,
        threadId: opts.threadId,
        senderId: opts.senderId,
        since: opts.since,
        until: opts.until,
        types: resolveTypes(opts.types),
    };
    const after = decodeCursor(opts.cursor);
    const firstPage = after === null;

    // Fold mode: the SQL is the whole answer. Exact mode: the SQL finds the candidates, newest first, and the accents
    // are checked here, one row at a time until the page is full (and one more, to know whether there is a next).
    const hits = [];
    if (accents === "exact") {
        for (const row of iterateSearchRows({ ...filters, after })) {
            if (!matchesExact(row.text, kw.keyword)) continue;
            hits.push(row);
            if (hits.length > limit) break;
        }
    } else {
        hits.push(...searchMessageRows({ ...filters, after, limit: limit + 1 }));
    }
    const hasMore = hits.length > limit;
    const page = hits.slice(0, limit);

    let counts = null;
    if (opts.counts ?? firstPage) {
        counts = accents === "exact" ? exactCounts(filters, kw.keyword) : countSearchMatchesByType(filters);
    }

    return {
        query: kw.keyword,
        accents,
        truncatedKeyword: kw.truncated,
        count: page.length,
        hits: page.map((row) => ({
            row,
            snippet: makeSnippet(row.text, kw.norm),
            ...(context > 0 && {
                context: getMessagesAround(
                    row.threadId,
                    { timestamp: row.timestamp, msgId: row.msgId },
                    context,
                    context,
                ),
            }),
        })),
        hasMore,
        nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)) : null,
        counts,
        coverage: searchCoverage({ threadId: opts.threadId }),
    };
}

/** The tabs' numbers for the exact mode: every candidate, checked for its accents. */
function exactCounts(filters, keyword) {
    const counts = {};
    for (const r of iterateSearchRows({ ...filters, types: undefined })) {
        if (matchesExact(r.text, keyword)) counts[r.type ?? ""] = (counts[r.type ?? ""] ?? 0) + 1;
    }
    return counts;
}
