/**
 * What a restore still has to ask for, from what earlier runs settled (plan items Y5a-d).
 *
 * The phone is asked for each conversation as a partition with a window `{from, to}`: from the start of the
 * requested window to the conversation's last message. A run that is killed half way used to leave nothing behind
 * to say which partitions it had finished, and a run that only partly worked still counted as a success. This is
 * the small piece of arithmetic between the table that remembers (`sync_ranges`, see ../db.js) and the requests:
 *
 *  - a partition settled for a window that covers this one, up to this one's last message, is **skipped**;
 *  - a partition settled for the same start but only up to an earlier last message is asked for **incrementally**,
 *    from that point;
 *  - anything else, or everything with a full resync, is asked for in full;
 *  - a range that was never finished for a conversation that is no longer in the list is an **orphan**: it is
 *    dropped, so it cannot hold the account "unfinished" for good.
 *
 * Pure, so each rule is a test.
 */

/**
 * @typedef {object} Ask
 * @property {string} partition - `oneone/<id>` or `group/<id>`
 * @property {number} from - start of the window asked for
 * @property {number} to - end of it: the conversation's last message, never past now
 */

/**
 * @typedef {object} Range
 * @property {string} partition
 * @property {number} fromTs
 * @property {number} toTs
 * @property {string} status - `done`, `failed` or `pending`
 */

/**
 * Decide what to ask the phone.
 *
 * @param {object} p
 * @param {Ask[]} p.asked - every conversation, with the window this run wants for it
 * @param {Range[]} [p.prior] - what earlier runs recorded
 * @param {boolean} [p.fullResync] - ignore what earlier runs settled
 * @returns {{
 *   todo: Array<Ask & {incremental: boolean}>,
 *   skipped: string[],
 *   orphans: string[],
 * }} \`todo\` keeps the order of \`asked\`; an incremental ask carries the later \`from\`
 */
export function planRanges({ asked, prior = [], fullResync = false }) {
    const byPartition = new Map(prior.map((r) => [r.partition, r]));
    const wanted = new Set(asked.map((a) => a.partition));
    const todo = [];
    const skipped = [];

    for (const ask of asked) {
        const done = byPartition.get(ask.partition);
        const settled = !fullResync && done?.status === "done" && Number(done.fromTs) <= ask.from;
        if (settled && Number(done.toTs) >= ask.to) {
            skipped.push(ask.partition);
        } else if (settled) {
            // Everything up to the earlier last message is held: ask for what came after.
            todo.push({ ...ask, from: Math.max(ask.from, Number(done.toTs)), incremental: true });
        } else {
            todo.push({ ...ask, incremental: false });
        }
    }

    const orphans = prior.filter((r) => r.status !== "done" && !wanted.has(r.partition)).map((r) => r.partition);
    return { todo, skipped, orphans };
}

/**
 * The window a partition covers once a run has settled it: from the earlier of the two starts to this run's end.
 *
 * @param {Ask} ask
 * @param {Range|undefined} prior - the range recorded before this run, if any
 * @param {boolean} incremental - whether this run asked incrementally
 * @returns {{fromTs: number, toTs: number}}
 */
export function coveredAfter(ask, prior, incremental) {
    const fromTs = incremental && prior ? Math.min(Number(prior.fromTs), ask.from) : ask.from;
    return { fromTs, toTs: ask.to };
}

/**
 * How one partition stands after its session ended.
 *
 * A partition the phone reported as failed is failed. One it served is done. One that was neither (the session
 * ended early: a timeout, a lost socket) stays pending, which is what a resume asks for again. A session that
 * finished serves everything it was asked for, whether or not a partition with nothing in the window was named.
 *
 * @param {string} partition
 * @param {{done: boolean, failed: Set<string>, covered: Set<string>}} session
 * @returns {"done"|"failed"|"pending"}
 */
export function rangeStatusAfter(partition, session) {
    if (session.failed?.has(partition)) return "failed";
    if (session.done || session.covered?.has(partition)) return "done";
    return "pending";
}
