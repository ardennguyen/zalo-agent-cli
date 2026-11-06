/**
 * End-to-end encrypted messages this client cannot read, counted and named once per daemon.
 *
 * Zalo routes an end-to-end encrypted conversation's messages (`chat.e2ee.*`) through the Signal pushes 551, 552 and
 * 535. This client has no Signal keys, so the listener announces each one marked `data.undecryptable`, with its
 * ciphertext removed from `content` (design 6.1 item 7, src/zalo/listener/dispatch.js). `listen` and `mcp start`
 * each build one notice: the first such message is logged with what it means, every one is counted, and none is
 * logged again, so a busy encrypted conversation cannot flood the log.
 *
 * Nothing here writes to stdout; the line carries no id, name or content.
 */

/**
 * Build a daemon's notice.
 *
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.log] - where the one line goes (stderr)
 * @returns {{note: (msg: object) => boolean, count: () => number}} `note` counts a listener message that is
 *   undecryptable and answers whether it was; `count` is how many were seen
 */
export function createUndecryptableNotice({ log = (line) => console.error(line) } = {}) {
    let seen = 0;
    return {
        note(msg) {
            if (msg?.data?.undecryptable !== true) return false;
            seen++;
            if (seen === 1) {
                try {
                    log(
                        "an end-to-end encrypted message arrived; this client cannot decrypt it, so it is kept " +
                            "without its text (marked undecryptable). Later ones are counted, not logged again.",
                    );
                } catch {
                    /* a broken logger must not break the daemon */
                }
            }
            return true;
        },
        count: () => seen,
    };
}
