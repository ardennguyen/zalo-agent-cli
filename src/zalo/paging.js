/**
 * Reading every page of a paged list, one request at a time.
 *
 * A list the caller did not bound is read to its end, the way Zalo's own apps read the same lists (blocked
 * members, catalogs, products, boards): page after page while the server says there is more. The walk
 * ends on whichever comes first:
 *
 * - `empty`: a page with no items;
 * - `end`: the page says there is nothing after it (`more` false);
 * - `cursor`: the cursor for the next page is the one just used, or the page repeats the one before it item for item
 *   (a server that ignores the page asked for would otherwise answer the same page forever);
 *   It is said in the reply's note.
 * - `rateLimited`: Zalo answered 221 ("too many requests"); what was read so far is returned, with a note.
 *
 * There is no fixed page count: a list ends where the server says it does. Any other error on the first page is
 * thrown as it came; on a later page it is thrown too, since a list that stops at an arbitrary failed page would read
 * as complete.
 */
import { errorCodeOf } from "./errors.js";

/** Zalo's "too many requests" code. */
export const RATE_LIMITED_CODE = 221;

/** The note a walk cut short by {@link RATE_LIMITED_CODE} carries. */
export function rateLimitedNote(pages) {
    return (
        `Zalo answered 221 (too many requests) on page ${pages + 1}: the list stops at the ${pages} page(s) read ` +
        "so far. Wait a while and ask again for the rest."
    );
}

/** The note a walk ended by a cursor that stopped advancing carries. */
export function stalledNote(pages) {
    return `The server's cursor stopped advancing after page ${pages}: the list ends there.`;
}

/**
 * Read a list to its end.
 *
 * @template T
 * @param {object} spec
 * @param {(page: number, cursor: any) => Promise<any>} spec.fetch - one page; `page` counts from `firstPage`, `cursor`
 *   is `firstCursor` on the first call and then what `next` returned
 * @param {(reply: any) => T[]} spec.items - the page's items
 * @param {(reply: any, items: T[]) => boolean} [spec.more] - whether the server says there is more (omitted: a
 *   non-empty page is followed by another, and only an empty one ends the list)
 * @param {(reply: any, items: T[], cursor: any) => any} [spec.next] - the cursor of the next page (omitted: none)
 * @param {(reply: any, items: T[]) => boolean} [spec.isEmpty] - whether the page is empty (omitted: no items); for a
 *   list whose items are a filtered part of what the page held
 * @param {(item: T) => string} [spec.key] - an item's identity, to see a page that repeats the one before
 * @param {number} [spec.firstPage=1]
 * @param {any} [spec.firstCursor=null]
 * @returns {Promise<{items: T[], first: any, last: any, pages: number, complete: boolean,
 *   stoppedBy: "empty"|"end"|"cursor"|"rateLimited", note: string|null}>} `first` / `last` are the first and last
 *   replies (null when none came); `complete` is false only when Zalo rate-limited the walk
 * @throws {Error} any error but 221
 */
export async function readAllPages({ fetch, items, more, next, isEmpty, key, firstPage = 1, firstCursor = null }) {
    const out = [];
    let first = null;
    let last = null;
    let pages = 0;
    let cursor = firstCursor;
    let previousKeys = null;
    for (let page = firstPage; ; page++) {
        let reply;
        try {
            reply = await fetch(page, cursor);
        } catch (e) {
            if (errorCodeOf(e) === RATE_LIMITED_CODE) {
                return {
                    items: out,
                    first,
                    last,
                    pages,
                    complete: false,
                    stoppedBy: "rateLimited",
                    note: rateLimitedNote(pages),
                };
            }
            throw e;
        }
        pages++;
        if (first === null) first = reply;
        last = reply;
        const got = items(reply) ?? [];
        if (isEmpty ? isEmpty(reply, got) : !got.length)
            return { items: out, first, last, pages, complete: true, stoppedBy: "empty", note: null };
        const keys = key ? got.map((it) => String(key(it))).join("\u0000") : null;
        if (keys !== null && keys !== "" && keys === previousKeys) {
            return { items: out, first, last, pages, complete: true, stoppedBy: "cursor", note: stalledNote(pages) };
        }
        previousKeys = keys;
        out.push(...got);
        if (more && !more(reply, got)) {
            return { items: out, first, last, pages, complete: true, stoppedBy: "end", note: null };
        }
        if (next) {
            const n = next(reply, got, cursor);
            if (n === undefined || n === null || JSON.stringify(n) === JSON.stringify(cursor)) {
                return {
                    items: out,
                    first,
                    last,
                    pages,
                    complete: true,
                    stoppedBy: "cursor",
                    note: stalledNote(pages),
                };
            }
            cursor = n;
        }
    }
}
