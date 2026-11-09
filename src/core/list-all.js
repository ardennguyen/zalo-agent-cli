/**
 * Every page of the server-paged lists, for a command or an MCP action that was not asked for one page.
 *
 * Nothing the CLI or the MCP tools return is cut short by default: with no page asked, these read the list to its
 * end, one request at a time, the way Zalo's own clients page the same lists (each reader names the client loop it
 * follows). The walk itself, and when it stops, is src/zalo/paging.js: an empty page, the server saying there is no
 * more, a cursor that stops advancing (said in `note`), or Zalo's 221 (too many requests), which keeps what was
 * read and says so in `note`.
 *
 * Each reader returns the reply shape of the single-page call it replaces, with every page's items in it and its
 * "more" flag cleared, plus `paging`: `{pages, complete, stoppedBy, note}`. A walk that found no items returns
 * `paging` alone, so the command prints the same empty value it prints for Zalo's empty answer to one page.
 */
import { boardCursor, PAGE_SIZE } from "../zalo/api/boards.js";
import { readAllAliases } from "../zalo/api/people.js";
import { THREAD_TYPE } from "../zalo/enums.js";
import { errorCodeOf } from "../zalo/errors.js";
import { RATE_LIMITED_CODE, rateLimitedNote, readAllPages } from "../zalo/paging.js";

/** What a walk tells its caller, beside the items. */
const pagingOf = (r) => ({ pages: r.pages, complete: r.complete, stoppedBy: r.stoppedBy, note: r.note });

/**
 * The answer of a walk that found nothing: no reply fields at all, so a command prints its list's natural empty value
 * (src/utils/list-replies.js) exactly as it does for Zalo's own empty answer to a single page.
 */
const nothing = (r) => ({ paging: pagingOf(r) });

/**
 * A conversation's reminders, every page. A group's pages after the first carry the id of the last topic of the page
 * before (`lastId`, as Zalo Web pages them) and end at an empty page (a short page can be followed by more); a DM's
 * go by page number and end at an empty or short page, as Zalo Web's DM lookups do.
 *
 * @param {object} api - a logged-in api
 * @param {string} threadId
 * @param {0|1} threadType - THREAD_TYPE
 * @param {{count?: number}} [opts] - per request (Zalo's 20)
 * @returns {Promise<{reminders: object[], paging: object}>}
 */
export async function allReminders(api, threadId, threadType, { count = PAGE_SIZE } = {}) {
    if (Number(threadType) === THREAD_TYPE.GROUP) {
        const r = await readAllPages({
            fetch: (page, lastId) => api.getListReminder({ page, count, lastId }, threadId, THREAD_TYPE.GROUP),
            items: (list) => (Array.isArray(list) ? list : []),
            // The reminders are the dated topics of the page; the page's size and cursor count every topic.
            isEmpty: (list) => (list?.page?.size ?? (Array.isArray(list) ? list.length : 0)) === 0,
            next: (list) => {
                const last = Array.isArray(list) ? list.at(-1) : null;
                return list?.page?.lastId ?? last?.reminderId ?? last?.id ?? null;
            },
            firstCursor: 0,
        });
        return { reminders: r.items, paging: pagingOf(r) };
    }
    const r = await readAllPages({
        fetch: (page) => api.getListReminder({ page, count }, threadId, Number(threadType)),
        items: (list) => (Array.isArray(list) ? list : []),
        more: (_list, got) => got.length >= count,
        key: (rem) => rem?.reminderId ?? rem?.id ?? JSON.stringify(rem),
    });
    return { reminders: r.items, paging: pagingOf(r) };
}

/**
 * A group's whole board (notes, pinned messages, polls), every page: each page after the first carries the cursor of
 * the page before (`boardCursor`), and the list ends at an empty page, as Zalo Web pages it (`boardPage` in src/zalo/api/boards.js).
 *
 * @param {object} api
 * @param {string} groupId
 * @param {{count?: number}} [opts] - per request (Zalo's 20)
 * @returns {Promise<{items: object[], paging: object}>}
 */
export async function allBoardItems(api, groupId, { count = PAGE_SIZE } = {}) {
    const r = await readAllPages({
        fetch: (page, cursor) => api.getListBoard({ page, count, ...cursor }, groupId),
        items: (reply) => (Array.isArray(reply?.items) ? reply.items : []),
        next: (_reply, got) => boardCursor(got),
        firstCursor: { lastId: 0, lastType: 0 },
    });
    return { items: r.items, paging: pagingOf(r) };
}

/**
 * A group's blocked members, every page: on while the page says `has_more` 1, as Zalo PC's
 * `_getAllGroupBlockedMembers` reads them (50 a page).
 *
 * @param {object} api
 * @param {string} groupId
 * @param {{count?: number}} [opts]
 * @returns {Promise<object>} the first page's reply with every page's `blocked_members`, `has_more` 0, and `paging`
 */
export async function allGroupBlocked(api, groupId, { count = 50 } = {}) {
    const r = await readAllPages({
        fetch: (page) => api.getGroupBlockedMember({ page, count }, groupId),
        items: (reply) => (Array.isArray(reply?.blocked_members) ? reply.blocked_members : []),
        more: (reply) => Number(reply?.has_more) === 1,
        key: (m) => m?.id ?? JSON.stringify(m),
    });
    if (!r.items.length) return nothing(r);
    return { ...r.first, blocked_members: r.items, has_more: r.complete ? 0 : 1, paging: pagingOf(r) };
}

/**
 * A group seen through its invite link, with every member page: on while the page says `hasMoreMember`, joining the
 * pages' `currentMems`, as Zalo PC's `getGroupInfoByLink` does.
 *
 * @param {object} api
 * @param {string} link
 * @returns {Promise<object>} the first page's reply with every page's `currentMems`, `hasMoreMember` 0, and `paging`
 */
export async function groupLinkInfoAll(api, link) {
    const r = await readAllPages({
        fetch: (memberPage) => api.getGroupLinkInfo({ link, memberPage }),
        items: (reply) => (Array.isArray(reply?.currentMems) ? reply.currentMems : []),
        more: (reply) => Number(reply?.hasMoreMember) > 0 || reply?.hasMoreMember === true,
        key: (m) => m?.id ?? JSON.stringify(m),
    });
    if (!r.items.length) return { ...(r.first && typeof r.first === "object" ? r.first : {}), paging: pagingOf(r) };
    return { ...r.first, currentMems: r.items, hasMoreMember: r.complete ? 0 : 1, paging: pagingOf(r) };
}

/**
 * A pending group invitation's details with every member page. Zalo PC asks for the first page only (a preview);
 * this goes on while the group says `hasMoreMember`, or, when its reply has no such field, while a member page comes
 * back full.
 *
 * @param {(mpage: number) => Promise<object>} fetchPage - one member page (`getInviteBoxInfo` with `mpage`)
 * @param {number} mcount - members per page asked
 * @returns {Promise<object>} the first reply with every page's `groupInfo.currentMems`, and `paging`
 */
export async function inviteInfoAll(fetchPage, mcount) {
    const mems = (reply) => (Array.isArray(reply?.groupInfo?.currentMems) ? reply.groupInfo.currentMems : []);
    const r = await readAllPages({
        fetch: (mpage) => fetchPage(mpage),
        items: mems,
        more: (reply, got) => {
            const g = reply?.groupInfo ?? {};
            if (Object.hasOwn(g, "hasMoreMember")) return Number(g.hasMoreMember) > 0 || g.hasMoreMember === true;
            return got.length >= mcount;
        },
        key: (m) => m?.id ?? JSON.stringify(m),
    });
    if (!r.first) return { paging: pagingOf(r) };
    // A group with no member list in its answer: the first reply as it came.
    if (!Array.isArray(r.first?.groupInfo?.currentMems)) return { ...r.first, paging: pagingOf(r) };
    const groupInfo = { ...r.first.groupInfo, currentMems: r.items };
    if (Object.hasOwn(groupInfo, "hasMoreMember")) groupInfo.hasMoreMember = r.complete ? 0 : 1;
    return { ...r.first, groupInfo, paging: pagingOf(r) };
}

/**
 * The account's whole avatar gallery: on while the page says `hasMore`, joining the pages' `photos`.
 *
 * @param {object} api
 * @param {{count?: number}} [opts] - per request (50)
 * @returns {Promise<object>} the first page's reply with every page's `photos`, `hasMore` 0, and `paging`
 */
export async function allAvatars(api, { count = 50 } = {}) {
    const r = await readAllPages({
        fetch: (page) => api.getAvatarList(count, page),
        items: (reply) => (Array.isArray(reply?.photos) ? reply.photos : []),
        more: (reply) => Number(reply?.hasMore) > 0 || reply?.hasMore === true,
        key: (p) => p?.photoId ?? JSON.stringify(p),
    });
    if (!r.items.length) return nothing(r);
    return { ...r.first, photos: r.items, hasMore: r.complete ? 0 : 1, paging: pagingOf(r) };
}

/**
 * Every catalog: pages from 0 while the page says `has_more`, keeping each catalog once, as Zalo PC's catalog list
 * manager reads them (20 a page).
 *
 * @param {object} api
 * @param {{limit?: number}} [opts]
 * @returns {Promise<object>} the first page's reply with every catalog in `items`, `has_more` 0, and `paging`
 */
export async function allCatalogs(api, { limit = 20 } = {}) {
    const r = await readAllPages({
        fetch: (page) => api.getCatalogList({ limit, page }),
        items: (reply) => (Array.isArray(reply?.items) ? reply.items : []),
        more: (reply) => Number(reply?.has_more) > 0 || reply?.has_more === true,
        key: (c) => c?.id ?? JSON.stringify(c),
        firstPage: 0,
    });
    const seen = new Set();
    const items = r.items.filter((c) => {
        const id = c?.id ?? JSON.stringify(c);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    if (!items.length) return nothing(r);
    return { ...r.first, items, has_more: r.complete ? 0 : 1, paging: pagingOf(r) };
}

/**
 * Every product of a catalog: pages from 0 while the page says `has_more`, each later page asked with the first
 * product id of the page before (`lastProductId`), as Zalo PC's `doRequestGetProduct` does (100 a page).
 *
 * @param {object} api
 * @param {string} catalogId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<object>} the first page's reply with every product in `items`, `has_more` 0, and `paging`
 */
export async function allProducts(api, catalogId, { limit = 100 } = {}) {
    const r = await readAllPages({
        fetch: (page, lastProductId) => api.getProductCatalogList({ catalogId, limit, page, lastProductId }),
        items: (reply) => (Array.isArray(reply?.items) ? reply.items : []),
        more: (reply) => Number(reply?.has_more) > 0 || reply?.has_more === true,
        next: (_reply, got) => got[0]?.product_id ?? got[0]?.id ?? null,
        key: (p) => p?.product_id ?? p?.id ?? JSON.stringify(p),
        firstPage: 0,
        firstCursor: -1,
    });
    if (!r.items.length) return nothing(r);
    return { ...r.first, items: r.items, has_more: r.complete ? 0 : 1, paging: pagingOf(r) };
}

/**
 * Every saved bank account: pages from 0 while the page says `hasMore`.
 *
 * @param {object} api
 * @param {{limit?: number}} [opts] - per request (20)
 * @returns {Promise<{myBanks: object[], total: number, hasMore: boolean, paging: object}>}
 */
export async function allBankAccounts(api, { limit = 20 } = {}) {
    const r = await readAllPages({
        fetch: (page) => api.getListBankAccount(page, limit),
        items: (reply) => (Array.isArray(reply?.myBanks) ? reply.myBanks : []),
        more: (reply) => Boolean(reply?.hasMore),
        key: (a) => a?.id ?? a?.accountId ?? JSON.stringify(a),
        firstPage: 0,
    });
    if (!r.items.length) return nothing(r);
    return {
        ...r.first,
        myBanks: r.items,
        total: r.first?.total ?? r.items.length,
        hasMore: !r.complete,
        paging: pagingOf(r),
    };
}

/**
 * Every friend nickname, read the way Zalo Web pages its alias list (`readAllAliases`). A 221 on a later page keeps
 * the pages read before it and says so in `note`; on the first page it is thrown.
 *
 * @param {object} api
 * @returns {Promise<{items: Array<{userId: string, alias: string}>, paging: object}>}
 */
export async function allAliases(api) {
    let rateLimitedAt = 0;
    let pages = 0;
    const guarded = {
        getAliasList: async (count, page) => {
            try {
                const reply = await api.getAliasList(count, page);
                pages++;
                return reply;
            } catch (e) {
                if (page > 1 && errorCodeOf(e) === RATE_LIMITED_CODE) {
                    rateLimitedAt = page;
                    return { items: [], hasMore: false };
                }
                throw e;
            }
        },
    };
    const items = await readAllAliases(guarded);
    return {
        items,
        paging: {
            pages,
            complete: !rateLimitedAt,
            stoppedBy: rateLimitedAt ? "rateLimited" : "end",
            note: rateLimitedAt ? rateLimitedNote(pages) : null,
        },
    };
}
