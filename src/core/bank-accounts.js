/**
 * The account's saved bank accounts (`bank` commands).
 *
 * Pure of side effects except the reads it is handed an api for.
 */

/** Page size used when scanning the saved-account list. */
const SCAN_BATCH = 50;

/**
 * Find one saved bank account by its `account_id`.
 *
 * `deleteBankAccount` needs `isDefault`, which only the list knows, so removing
 * an account starts by finding it. Scans page by page while Zalo says there are
 * more, with a cap so a server that never stops saying so cannot loop us.
 *
 * @param {object} api - logged-in zca-js api
 * @param {number} accountId
 * @returns {Promise<object|null>} the saved account, or null when no page has it
 */
export async function findBankAccount(api, accountId) {
    for (let page = 0; page < 100; page++) {
        const res = await api.getListBankAccount(page, SCAN_BATCH);
        const hit = (res?.myBanks ?? []).find((b) => Number(b.account_id) === Number(accountId));
        if (hit) return hit;
        if (!res?.hasMore) return null;
    }
    return null;
}

/**
 * The banks whose name, short name, English name or search keywords contain `query`
 * (case-insensitive substring); all of them for an empty query.
 *
 * @param {object[]} banks - `getListBank` entries
 * @param {string} [query]
 * @returns {object[]}
 */
export function filterBanks(banks, query) {
    const q = String(query ?? "")
        .trim()
        .toLowerCase();
    const list = Array.isArray(banks) ? banks : [];
    if (!q) return list;
    return list.filter((b) =>
        [b.name, b.short_name, b.name_eng, b.search_key_word, String(b.bin)].some((s) =>
            String(s ?? "")
                .toLowerCase()
                .includes(q),
        ),
    );
}
