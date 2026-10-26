/**
 * `msg search`: search the local message cache (plan items F4, F6, F7, F9).
 *
 * Local only: it reads `zalo.db` and never contacts Zalo, so it needs no login and works offline. What it can find is
 * what the cache holds; the coverage line under the results says how far back that goes and what to run to extend it.
 */
import chalk from "chalk";
import { getActive } from "../core/accounts.js";
import { getAccountDbPath } from "../core/credentials.js";
import { configureSearchIndex, getThreadNames, initDb } from "../core/db.js";
import { MAX_CONTEXT, MAX_PAGE, searchPage } from "../core/search.js";
import { parseDateBound, parsePeriod } from "../utils/date-range.js";
import { error, info, output } from "../utils/output.js";
import { parseIntAtLeast } from "../utils/parse-options.js";

/**
 * The search options a person typed, as the filters of a query.
 *
 * @param {object} opts - the parsed command options
 * @param {string} ownId - the active account, for `--from me`
 * @param {number} [now]
 * @returns {{threadId?: string, senderId?: string, since?: number, until?: number}}
 * @throws {Error} for a date or period that is not one
 */
export function filtersFromOptions(opts, ownId, now = Date.now()) {
    const out = {};
    if (opts.thread) out.threadId = String(opts.thread);
    if (opts.from) out.senderId = String(opts.from).toLowerCase() === "me" ? String(ownId) : String(opts.from);
    // --last is a shorthand for --since, and the more specific of the two when both are given.
    if (opts.last) out.since = parsePeriod(opts.last, now);
    else if (opts.since) out.since = parseDateBound(opts.since, "start");
    if (opts.until) out.until = parseDateBound(opts.until, "end");
    if (out.since !== undefined && out.until !== undefined && out.since > out.until) {
        throw new Error("--since is after --until: nothing can be in between.");
    }
    return out;
}

/**
 * A reporter for the first search's preparation of the index: says what it is doing, then how far it is, at most every
 * 20%, so a one-time wait of a minute on a big cache is not silent.
 *
 * @param {(line: string) => void} write
 * @returns {(p: {phase: string, done: number, total: number|null}) => void}
 */
export function indexProgressReporter(write) {
    let announced = false;
    let lastStep = 0;
    let lastPhase = null;
    const words = { fold: "reading the messages", index: "building the index" };
    return ({ phase, done, total }) => {
        if (!announced) {
            announced = true;
            write("Preparing the search index (done once; the next search is quick)...");
        }
        if (phase !== lastPhase) {
            // Each phase counts its own fifths.
            lastPhase = phase;
            lastStep = 0;
        }
        if (!total) return;
        const step = Math.floor((done / total) * 5);
        if (step > lastStep) {
            lastStep = step;
            write(`  ${words[phase] ?? phase}: ${Math.min(100, step * 20)}% (${done} of ${total})`);
        }
    };
}

/** A hit as the JSON output and the MCP tool show it. */
export function hitToJson(hit, threadNames) {
    const r = hit.row;
    const lite = (m) => ({
        msgId: m.msgId,
        senderId: m.senderId,
        senderName: m.senderName || null,
        text: m.text,
        timestamp: m.timestamp,
        type: m.type,
    });
    return {
        msgId: r.msgId,
        threadId: r.threadId,
        threadName: threadNames.get(String(r.threadId))?.name ?? null,
        senderId: r.senderId,
        senderName: r.senderName || null,
        text: r.text,
        snippet: hit.snippet,
        timestamp: r.timestamp,
        type: r.type,
        hasAttachment: Boolean(r.has_attachment),
        localPath: r.localPath || null,
        ...(hit.context && { context: { before: hit.context.before.map(lite), after: hit.context.after.map(lite) } }),
    };
}

/** One hit, as a block of the human output: the messages before it, the hit with its match marked, the ones after. */
function printHit(h) {
    const when = h.timestamp ? new Date(h.timestamp).toLocaleString() : "?";
    const s = h.snippet;
    const shown =
        s.matchStart === null
            ? s.text
            : s.text.slice(0, s.matchStart) +
              chalk.bold.yellow(s.text.slice(s.matchStart, s.matchEnd)) +
              s.text.slice(s.matchEnd);
    const where = h.threadName ?? h.threadId;
    const who = h.senderName ?? h.senderId;
    const tag = h.type && h.type !== "text" ? chalk.dim(` [${h.type}]`) : "";
    const around = (m) =>
        chalk.dim(
            `      ${new Date(m.timestamp).toLocaleTimeString()} ${m.senderName ?? m.senderId}: ` +
                String(m.text ?? "")
                    .replace(/s+/g, " ")
                    .slice(0, 100),
        );
    for (const m of h.context?.before ?? []) console.log(around(m));
    console.log(`${chalk.dim(when)}  ${chalk.cyan(where)}  ${who}${tag}
  ${shown}  ${chalk.dim(`(${h.msgId})`)}`);
    for (const m of h.context?.after ?? []) console.log(around(m));
    if (h.context) console.log();
}

/**
 * Register `msg search` on the `msg` command.
 *
 * @param {import("commander").Command} msg - the `msg` command group
 * @param {import("commander").Command} program - the root, for the global `--json`
 */
export function registerMsgSearch(msg, program) {
    const cmd = msg
        .command("search <query>")
        .description(
            "Search the local message cache (no login, no network). Accent-insensitive by default: 'duoc' finds 'được'.",
        )
        .option("-t, --thread <id>", "Only this conversation")
        .option("--from <sender>", "Only messages from this sender (a user id, or 'me')")
        .option("--since <date>", "Only on or after this date (YYYY-MM-DD, local time)")
        .option("--until <date>", "Only on or before this date (YYYY-MM-DD, local time)")
        .option("--last <period>", "Only the last 7d, 2w, 3m, 1y (instead of --since)")
        .option("--type <types>", "Only these message types: text, photo, video, file, link, sticker... (comma list)")
        .option("-n, --limit <n>", `Hits per page (default 20, at most ${MAX_PAGE})`, parseIntAtLeast(1), 20)
        .option("--cursor <cursor>", "Next page: the cursor printed under the previous one")
        .option(
            "--context <n>",
            `Show n messages before and after each hit (at most ${MAX_CONTEXT})`,
            parseIntAtLeast(0),
            0,
        )
        .option("--exact", "Accents must match too (case still does not)")
        .action((query, opts) => {
            const jsonMode = program.opts().json;
            const account = getActive();
            if (!account) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            let page;
            let names;
            try {
                initDb(getAccountDbPath(account.ownId));
                configureSearchIndex({ onProgress: indexProgressReporter((line) => info(line)) });
                page = searchPage({
                    query,
                    accents: opts.exact ? "exact" : "fold",
                    types: opts.type,
                    limit: opts.limit,
                    cursor: opts.cursor,
                    context: opts.context,
                    ...filtersFromOptions(opts, account.ownId),
                });
                names = getThreadNames();
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
            const hits = page.hits.map((h) => hitToJson(h, names));
            output(
                {
                    query: page.query,
                    accents: page.accents,
                    truncatedKeyword: page.truncatedKeyword,
                    count: page.count,
                    hasMore: page.hasMore,
                    nextCursor: page.nextCursor,
                    counts: page.counts,
                    coverage: page.coverage,
                    hits,
                },
                jsonMode,
                () => {
                    const mode = page.accents === "exact" ? "accents must match" : "accents ignored";
                    info(`${page.count} result(s) for "${page.query}" (${mode})${page.hasMore ? ", more below" : ""}`);
                    if (page.truncatedKeyword) info("The keyword was cut to 100 characters.");
                    for (const h of hits) printHit(h);
                    if (page.counts && Object.keys(page.counts).length) {
                        const tabs = Object.entries(page.counts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([t, n]) => `${t || "other"} ${n}`)
                            .join(" · ");
                        info(`Matches by type: ${tabs}`);
                    }
                    if (page.hasMore) info(`More: add --cursor ${page.nextCursor}`);
                    info(page.coverage.note);
                },
            );
        });
    // The preAction hook logs in before most commands. This one reads the cache and nothing else.
    cmd.zaloLocalOnly = true;
    return cmd;
}
