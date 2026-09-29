import { join } from "path";
import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { acquireLock, releaseLock, checkLock } from "../core/lock.js";
import { error, info, success, warning, output } from "../utils/output.js";
import { parseIntAtLeast, parseIntOption } from "../utils/parse-options.js";
import { SyncManager } from "../core/sync.js";
import { SyncV2, resolveSyncWindow } from "../core/sync-v2/index.js";
import {
    downloadSyncedMedia,
    pruneDownloadedMedia,
    describeDownloadReasons,
    DOWNLOADABLE_KINDS,
} from "../core/sync-v2/media.js";
import { syncBoards } from "../core/sync-v2/board.js";
import { drainReactions, placeUnresolvedReactions } from "../core/sync-v2/reactions.js";
import { syncCloudIndex } from "../core/sync-v2/zcloud.js";
import { syncConvState } from "../core/sync-v2/conv-state.js";
import { planSyncRun } from "../core/sync-v2/plan.js";
import { startKeepAlive } from "../core/sync-v2/keepalive.js";
import { getSyncChannel, syncViaDaemon } from "../core/daemon-channel.js";
import { attachLiveStore } from "../core/live-store.js";
import {
    initDb,
    getRecentThreads,
    getThreadNames,
    countPendingAttachments,
    getSyncState,
    setSyncState,
    clearSyncState,
    getOrphanThreads,
} from "../core/db.js";

/** Zalo close code for a duplicate web session (Zalo Web is open elsewhere). */
const CLOSE_DUPLICATE = 3000;

/**
 * Reaction-drain budget for the unified run.
 *
 * Named because the daemon path has to ask for exactly the same thing: the
 * stage runs in another process there, and a page cap that differed between
 * the two would make the same command truncate in one setup and not the other.
 */
const DRAIN_PAGES = 20;
const DRAIN_WAIT_MS = 15000;

/**
 * Human-friendly relative age for the "already synced …" skip message.
 *
 * @param {number|null} ms - age in milliseconds, or null.
 * @returns {string}
 */
function formatAge(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 1000) return "moments";
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} seconds`;
    const min = Math.round(sec / 60);
    if (min < 60) return min === 1 ? "1 minute" : `${min} minutes`;
    const hr = Math.round(min / 60);
    if (hr < 24) return hr === 1 ? "1 hour" : `${hr} hours`;
    const day = Math.round(hr / 24);
    return day === 1 ? "1 day" : `${day} days`;
}

export function registerSyncCommands(program) {
    program
        .command("sync")
        .description(
            "Pull ALL message state in one run: message history (one phone prompt), the reaction backlog, " +
                "pinned and unread conversations, notes/pins/polls/reminders, the zCloud index, and media. " +
                "One lock and one socket window for the socket stages, then the REST stages. The sync-* " +
                "commands remain for re-running a single stage",
        )
        .option(
            "-F, --force",
            "Restore messages even if a successful sync completed within the last hour (re-pings the phone)",
        )
        .option("-d, --days <n>", "Restore only the last N days of messages", parseIntAtLeast(1))
        .option("--from <date>", "Restore messages from this date onward (YYYY-MM-DD); overrides --days")
        .option(
            "-w, --wait <seconds>",
            "How long to wait for the phone confirmation (floored at 180)",
            parseIntOption,
            180,
        )
        .option("--no-messages", "Skip the message restore (no phone prompt)")
        .option("--no-reactions", "Skip the reaction backlog")
        .option("--no-conv-state", "Skip pinned and unread conversations")
        .option("--no-boards", "Skip notes, pinned messages, polls and reminders")
        .option("--no-cloud", "Skip the zCloud index")
        .option("--no-media", "Skip downloading attachments")
        .option(
            "--no-removals",
            "Do not apply un-react entries from the reaction backlog (see sync-reactions --no-removals)",
        )
        .option(
            "--shard-size <n>",
            "Conversations per message batch (1-30, default 30). Fewer means more, smaller batches: " +
                "the first one comes back sooner and less is lost if the connection drops, at the cost of " +
                "more sync sessions. The server rejects a batch of more than 30",
            parseIntAtLeast(1),
        )
        .option("--plan", "Print which stages would run, in what order and why, then exit. Sends nothing")
        .action(async (opts) => {
            // Only the message restore carries a window; accepting one with the
            // restore switched off would silently mean nothing.
            if ((opts.days !== undefined || opts.from !== undefined) && opts.messages === false) {
                error("--days/--from apply to the message restore, which --no-messages switches off.");
                process.exit(1);
            }
            await runUnifiedSync(requireAccount(), opts, Boolean(program.opts().json));
        });

    program
        .command("sync-mobile")
        .description(
            "Restore message history from your phone into the local cache (zalo.db). " +
                "Use --transfer for the real phone-backed restore (transfer-sync-v2): it sends one " +
                "sync request your phone confirms, then decrypts and stores your history. " +
                "The default path is a best-effort server socket backfill (usually empty); --legacy is retired.",
        )
        .option(
            "-t, --transfer",
            "Real mobile restore over transfer-sync-v2: enumerate conversations, request message history, decrypt (libzproto) and write it to zalo.db. Sends ONE sync request to your phone — confirm the 'ĐỒNG BỘ NGAY' prompt when it appears",
        )
        .option(
            "-F, --force",
            "Skip the 'already synced recently' shortcut and sync anyway. By default a sync is skipped when a successful one completed within the last hour and no gap is pending — mirroring Zalo Web, which only re-syncs when it thinks something is missing",
        )
        .option(
            "-d, --days <n>",
            "Restore only the last N days of history instead of everything (--transfer only). " +
                "A narrower window asks the phone for fewer conversations, so the run is much shorter. " +
                "Default: full history",
            parseIntAtLeast(1),
        )
        .option(
            "--from <date>",
            "Restore everything from this date onward (YYYY-MM-DD), --transfer only. Overrides --days. " +
                "The default is already everything your phone still holds, so this is for deliberately " +
                "narrowing a run, not widening it",
        )
        .option(
            "-L, --legacy",
            "Try the retired pull_mobile_msg/get_crossdb phone-transfer endpoint instead. One attempt only — it pings your mobile app",
        )
        .option(
            "-M, --messages-only",
            "Restore messages but do NOT fetch their media. By default a transfer sync downloads the attachments it " +
                "recorded once the messages are stored, because a message whose photo or file is missing is only half " +
                "restored. Use this when you want the history quickly and will run `sync-media` later",
        )
        .option("-w, --wait <seconds>", "Give up after this long", parseIntOption, 30)
        .option(
            "--shard-size <n>",
            "Conversations per message batch (1-30, default 30), --transfer only. Fewer means more, " +
                "smaller batches: the first one comes back sooner and less is lost if the connection " +
                "drops, at the cost of more sync sessions. The server rejects a batch of more than 30",
            parseIntAtLeast(1),
        )
        .action(async (opts) => {
            // --days is a property of the cmd 590 query the phone answers, so
            // it only means anything on the transfer path. Say so instead of
            // accepting the flag and quietly ignoring it.
            if (opts.messagesOnly && !opts.transfer) {
                error("--messages-only only applies to the real phone-backed restore.");
                info("Run: zalo-agent sync-mobile --transfer --messages-only");
                process.exit(1);
            }
            if (opts.from !== undefined && !opts.transfer) {
                error("--from only applies to the real phone-backed restore.");
                info(`Run: zalo-agent sync-mobile --transfer --from ${opts.from}`);
                process.exit(1);
            }
            if (opts.days !== undefined && !opts.transfer) {
                error("--days only applies to the real phone-backed restore.");
                info(`Run: zalo-agent sync-mobile --transfer --days ${opts.days}`);
                process.exit(1);
            }

            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }

            if (opts.transfer) {
                await runTransferSync(activeAcc, opts);
                return;
            }
            if (opts.legacy) {
                await runLegacySync(activeAcc, opts);
                return;
            }
            await runSocketBackfill(activeAcc, opts);
        });

    program
        .command("sync-media")
        .description(
            "Download the attachments a mobile sync recorded. transfer-sync carries only CDN " +
                "references, never file bytes, so this is the separate fetch step. Needs no phone " +
                "confirmation. Expired links are retried once through Zalo's renewlink endpoint",
        )
        .option("-T, --thread <threadId>", "Only this conversation")
        .option(
            "-k, --kind <kinds>",
            `Comma-separated kinds to fetch (${[...DOWNLOADABLE_KINDS].join(", ")}). Default: all of them`,
        )
        .option("-n, --limit <n>", "Consider at most this many messages", parseIntAtLeast(1), 500)
        .option("-d, --days <n>", "Only attachments from the last N days", parseIntAtLeast(1))
        .option("-c, --concurrency <n>", "Parallel downloads", parseIntAtLeast(1), 4)
        .option("-m, --max-size <mb>", "Skip attachments larger than this many MB", parseIntAtLeast(1))
        .option(
            "--timeout <seconds>",
            "Give up on a single download after this long. Guards against a server that sends headers " +
                "then stops writing, which would otherwise block a worker forever",
            parseIntAtLeast(5),
            60,
        )
        .option("--thumbs", "Also save thumbnails alongside the full media")
        .option(
            "--prune <days|all>",
            "Delete downloaded media instead of downloading it: either attached to messages older than " +
                "N days, or `all` for every downloaded file. Message text is never touched. Always " +
                "preview with --dry-run first",
        )
        .option("--all", "With --prune, delete every downloaded file regardless of age")
        .option(
            "--prune-orphans",
            "Delete downloaded media belonging to conversations the account no longer has — dispersed " +
                "groups, deleted chats, groups you were removed from. Message text is kept; use " +
                "`conv forget --orphans` to remove that too",
        )
        .option(
            "--all-history",
            "Consider every attachment, not just those inside the window the last mobile sync covered",
        )
        .option(
            "--include-pruned",
            "Also re-fetch media you previously pruned. Pruning is treated as a decision, so it is " +
                "skipped by automatic fetches until you ask for it back",
        )
        .option("--dry-run", "Report what would be fetched without downloading anything")
        .action(async (opts) => {
            if (opts.pruneOrphans) {
                await runPruneOrphans(requireAccount(), opts);
                return;
            }
            if (opts.prune !== undefined) {
                // Validate the argument BEFORE anything else, so a typo is
                // reported as a typo rather than as "no active account".
                const wantsAll = Boolean(opts.all) || String(opts.prune).toLowerCase() === "all";
                const n = Number(opts.prune);
                if (!wantsAll && (!Number.isInteger(n) || n < 1)) {
                    error(`--prune needs a whole number of days (1 or more), or "all". Got: ${opts.prune}`);
                    info("Run: zalo-agent sync-media --prune 90 --dry-run");
                    process.exit(1);
                }
                await runMediaPrune(requireAccount(), opts);
                return;
            }
            if (opts.all) {
                error("--all only means anything together with --prune.");
                info("Run: zalo-agent sync-media --prune all --dry-run");
                process.exit(1);
            }
            await runMediaDownload(requireAccount(), opts);
        });

    program
        .command("sync-reactions")
        .description(
            "Retrieve existing reactions from Zalo's servers into the local cache. Reactions are the one " +
                "thing a transfer sync cannot restore — the Sync2 payload has no reaction field — but they " +
                "ARE served over the socket (cmd 610 for 1-1, 611 for groups), which is how Zalo Web shows " +
                "them after a fresh login. Needs no phone confirmation",
        )
        .option("-w, --wait <seconds>", "Per-page deadline", parseIntAtLeast(1), 15)
        .option("-p, --pages <n>", "Max pages per thread type", parseIntAtLeast(1), 20)
        .option(
            "--no-removals",
            "Do not apply un-react entries from the backlog. The default DOES apply them, because the " +
                "backlog is an ordered action log rather than a snapshot: skipping them leaves reactions " +
                "that were later taken off. Use this only to see every reaction a message ever had",
        )
        .action(async (opts) => {
            await runReactionSync(requireAccount(), opts);
        });

    program
        .command("sync-boards")
        .description(
            "Sync notes, pinned messages, polls and reminders into the local cache. These are NOT " +
                "part of the message stream — Zalo keeps them behind per-thread board endpoints — so " +
                "they need this separate pass. Needs no phone confirmation",
        )
        .option("-T, --thread <threadId>", "Only this conversation")
        .option("-n, --limit <n>", "Visit at most this many threads (most recent first)", parseIntAtLeast(1), 200)
        .option("-c, --concurrency <n>", "Threads fetched in parallel", parseIntAtLeast(1), 3)
        .option("--no-reminders", "Skip reminders")
        .option("--no-boards", "Skip notes/pinned messages/polls")
        .action(async (opts) => {
            await runBoardSync(requireAccount(), opts);
        });

    program
        .command("sync-cloud")
        .description(
            "Walk the zCloud ('Cloud của tôi') media index and record it locally — the same " +
                "reconciliation Zalo Web runs when it receives a cloud verify event. Records where " +
                "each backup lives; it does not download or decrypt cloud blobs",
        )
        .option("-p, --pages <n>", "Maximum pages to walk", parseIntAtLeast(1), 50)
        .option("-s, --page-size <n>", "Items per page (Zalo Web uses 300)", parseIntAtLeast(1), 300)
        .option("-r, --resume <noiseId>", "Resume from this cursor instead of starting over")
        .action(async (opts) => {
            await runCloudSync(requireAccount(), opts);
        });
}

/** The active account, or exit with the same message every command uses. */
function requireAccount() {
    const acc = getActive();
    if (!acc) {
        error("No active account. Please login first.");
        process.exit(1);
    }
    return acc;
}

const MB = 1024 * 1024;

/** Download attachments recorded by an earlier sync. No phone, no socket. */
async function runMediaDownload(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    let kinds;
    if (opts.kind) {
        kinds = String(opts.kind)
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
        const unknown = kinds.filter((k) => !DOWNLOADABLE_KINDS.has(k));
        if (unknown.length) {
            error(`Unknown kind(s): ${unknown.join(", ")}`);
            info(`Valid kinds: ${[...DOWNLOADABLE_KINDS].join(", ")}`);
            process.exit(1);
        }
    }

    // Follow the window the last mobile sync covered. Fetching media for
    // messages outside it is pointless work: those rows were never refreshed,
    // so their links are the oldest and likeliest to be dead. --all-history
    // opts out, and an explicit --days still wins.
    let since = opts.days ? Date.now() - opts.days * 86400000 : undefined;
    if (since === undefined && !opts.allHistory) {
        const covered = Number(getSyncState("lastSyncOkFrom"));
        if (Number.isFinite(covered) && covered > 0) {
            since = covered;
            info(
                `Limiting to the window the last sync covered (since ${new Date(covered).toISOString().slice(0, 10)}).`,
            );
            info("Pass --all-history to consider everything in the cache.");
        }
    }

    const pending = countPendingAttachments(opts.thread || null);
    if (!pending) {
        success("No attachments waiting to be downloaded.");
        info("Run `zalo-agent sync-mobile --transfer` first if you have not synced yet.");
        process.exit(0);
    }
    info(`${pending} attachment(s) not yet downloaded.`);

    // Media lives behind the same session as everything else, but only the
    // renewal of an expired URL actually needs it — so a missing session
    // degrades to "fetch what is still live" rather than failing outright.
    let api = null;
    try {
        api = getApi();
    } catch {
        warning("No active session — expired links cannot be renewed on this run.");
    }

    let last = 0;
    const stats = await downloadSyncedMedia({
        api,
        accountDir,
        threadId: opts.thread,
        kinds,
        limit: opts.limit,
        since,
        concurrency: opts.concurrency,
        maxBytes: opts.maxSize ? opts.maxSize * MB : undefined,
        timeoutMs: (opts.timeout || 60) * 1000,
        thumbs: Boolean(opts.thumbs),
        includePruned: Boolean(opts.includePruned),
        dryRun: Boolean(opts.dryRun),
        threadNames: getThreadNames(),
        onProgress: (p) => {
            if (p.phase === "dry-run") info(p.detail);
            // One line per 25 files keeps a 10k-file run readable.
            if (p.phase === "saved" && (p.done === p.total || p.done - last >= 25)) {
                last = p.done;
                info(`  ${p.done}/${p.total} downloaded`);
            }
        },
    });

    if (opts.dryRun) {
        success(`Dry run: ${stats.considered} attachment(s) would be fetched.`);
        process.exit(0);
    }
    success(`Downloaded ${stats.downloaded}/${stats.considered} attachment(s) (${formatBytes(stats.bytes)}).`);
    if (stats.renewed) info(`Renewed ${stats.renewed} expired link(s).`);
    if (stats.expired) {
        warning(`${stats.expired} link(s) are gone (HTTP 404/410 or a lapsed signature).`);
        info("Zalo only keeps media for a limited time; past that the file exists only on the sending device.");
    }
    if (stats.throttled) {
        warning(
            `${stats.throttled} request(s) were rate limited (${describeDownloadReasons(stats.reasons, "throttled")}).`,
        );
        info("Those attachments are still marked pending, so re-running picks them up. Wait a while first.");
        info("A lower --concurrency makes a long run far less likely to trip it.");
    }
    // Deliberately not called rate limiting. Zalo answers 403 for a lapsed
    // signature and under load alike, and nothing in the response says which.
    // This bucket used to be merged into the one above and announced as near-
    // certain throttling, which sent people off to wait and retry a link that
    // no amount of waiting would bring back.
    if (stats.unknown) {
        warning(
            `${stats.unknown} request(s) failed without saying why (${describeDownloadReasons(stats.reasons, "unknown")}).`,
        );
        info("A 403 from Zalo means either a lapsed signature or load — the response does not distinguish them.");
        info("They stay pending, so a re-run retries them; if the same ones keep failing, waiting will not help.");
        info("Only a fresh mobile sync can hand back a new link: `zalo-agent sync --from <YYYY-MM-DD>`.");
        info("(It does not always issue one — the renewal hints Zalo sends are mobile-only.)");
    }
    if (stats.abortedEarly) {
        warning("Stopped early: too many requests in a row came back unusable. Nothing is lost — re-run to continue.");
    }
    const other = stats.failed - stats.expired - stats.throttled - stats.unknown;
    if (other > 0) {
        warning(`${other} attachment(s) failed for other reasons.`);
        for (const f of stats.failures.slice(0, 5)) info(`  ${f.msgId}: ${f.reason}`);
    }
    process.exit(0);
}

/** Reclaim media held by conversations the account no longer has. */
async function runPruneOrphans(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    const orphans = getOrphanThreads().filter((t) => t.files > 0);
    if (!orphans.length) {
        success("No orphaned conversations are holding downloaded media.");
        info("Orphans are found from leave/disperse events and from the conversation list a sync returns.");
        process.exit(0);
    }

    const totalFiles = orphans.reduce((n, t) => n + (t.files || 0), 0);
    if (opts.dryRun) {
        success(`Dry run: ${totalFiles} file(s) across ${orphans.length} orphaned conversation(s).`);
        for (const t of orphans.slice(0, 15)) {
            info(`  ${t.threadId}${t.name ? ` (${t.name})` : ""} — ${t.files} file(s)`);
        }
        info("Message text is kept. Use `conv forget --orphans` to remove that too.");
        process.exit(0);
    }

    let deleted = 0;
    let bytes = 0;
    for (const t of orphans) {
        const st = await pruneDownloadedMedia({ all: true, threadId: t.threadId });
        deleted += st.deleted;
        bytes += st.bytes;
    }
    success(`Deleted ${deleted} file(s) (${formatBytes(bytes)}) from ${orphans.length} orphaned conversation(s).`);
    info("Their message text is still here — `conv forget --orphans` removes that too.");
    process.exit(0);
}

/** Delete downloaded media older than N days. Never removes message rows. */
async function runMediaPrune(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    // "all" is a mode, not a very large number of days: a cutoff computed from
    // a bad date could silently become delete-everything, a named mode cannot.
    const wantsAll = Boolean(opts.all) || String(opts.prune).toLowerCase() === "all";
    const days = wantsAll ? 0 : Number(opts.prune);
    if (!wantsAll && (!Number.isInteger(days) || days < 1)) {
        error(`--prune needs a whole number of days (1 or more), or "all". Got: ${opts.prune}`);
        info("Run: zalo-agent sync-media --prune 90 --dry-run");
        process.exit(1);
    }

    const scope = wantsAll ? "every downloaded file" : `media older than ${days} day(s)`;
    const stats = await pruneDownloadedMedia({
        olderThanDays: days,
        all: wantsAll,
        threadId: opts.thread,
        dryRun: Boolean(opts.dryRun),
    });

    const cutoff = stats.all ? "any date" : new Date(stats.cutoff).toISOString().slice(0, 10);
    if (!stats.considered) {
        success(`Nothing to prune — no downloaded media matched ${scope}.`);
        process.exit(0);
    }
    if (opts.dryRun) {
        success(`Dry run: ${stats.considered} file(s), ${formatBytes(stats.bytes)} — ${scope}.`);
        info("Message text is untouched; pruned files can be re-downloaded while their links live.");
        info("Re-run without --dry-run to delete them.");
        process.exit(0);
    }
    success(`Deleted ${stats.deleted} file(s), reclaiming ${formatBytes(stats.bytes)} (${scope}, before ${cutoff}).`);
    if (stats.missing) info(`${stats.missing} row(s) pointed at files already gone — those pointers were cleared.`);
    if (stats.failed) {
        warning(`${stats.failed} file(s) could not be deleted.`);
        for (const f of stats.failures.slice(0, 5)) info(`  ${f.msgId}: ${f.reason}`);
    }
    info("Message history is unchanged; these attachments are queued for download again.");
    process.exit(0);
}

/** Sync board items + reminders for the cached threads. No phone, no socket. */
async function runBoardSync(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    let api;
    try {
        api = getApi();
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const r = await boardPass(api, opts);
    if (r.status === "skipped") {
        warning(opts.thread ? `Thread ${opts.thread} is not in the local cache.` : "No threads in the local cache.");
        info("Run `zalo-agent sync-mobile --transfer` first.");
    }
    process.exit(0);
}

/**
 * One board pass over the cached threads. Exit-free, so `sync` can run it as a
 * stage and `sync-boards` as a command.
 *
 * @param {object} api
 * @param {{limit?: number, thread?: string, boards?: boolean, reminders?: boolean, concurrency?: number}} opts
 * @returns {Promise<{status: "ok"|"skipped", reason?: string, stats?: object}>}
 */
async function boardPass(api, opts) {
    const all = getRecentThreads(opts.limit);
    const threads = (opts.thread ? all.filter((t) => String(t.threadId) === String(opts.thread)) : all).map((t) => ({
        threadId: String(t.threadId),
        type: t.type,
        name: t.name,
    }));
    if (!threads.length) {
        return {
            status: "skipped",
            reason: opts.thread ? `thread ${opts.thread} is not in the local cache` : "no threads in the local cache",
        };
    }

    // A live board event flags its thread; those go first so a quick run after
    // seeing "Board changed" refreshes the thing that actually moved.
    const stale = threads.filter((t) => getSyncState(`boardStale:${t.threadId}`));
    if (stale.length && !opts.thread) {
        info(`${stale.length} thread(s) had a board change since the last pass — doing those first.`);
        const rest = threads.filter((t) => !getSyncState(`boardStale:${t.threadId}`));
        threads.length = 0;
        threads.push(...stale, ...rest);
    }

    info(`Checking ${threads.length} thread(s) — one request each, so this is paced deliberately.`);
    let last = 0;
    const stats = await syncBoards({
        api,
        threads,
        boards: opts.boards !== false,
        reminders: opts.reminders !== false,
        concurrency: opts.concurrency,
        onProgress: (p) => {
            // The flag exists to say "come back to this one". Clearing it is
            // what makes the next run's prioritization mean anything, and it
            // must not be cleared for a thread whose own fetch failed.
            if (p.phase === "thread" && p.ok) clearSyncState(`boardStale:${p.threadId}`);
            if (p.done === p.total || p.done - last >= 25) {
                last = p.done;
                info(`  ${p.done}/${p.total} threads`);
            }
        },
    });

    success(
        `Stored ${stats.boardItems} board item(s) and ${stats.reminders} reminder(s) from ${stats.threads} thread(s).`,
    );
    if (stats.failed) {
        warning(`${stats.failed} request(s) failed (left groups and blocked peers are expected here).`);
        for (const f of stats.failures.slice(0, 5)) info(`  ${f.threadId} (${f.what}): ${f.reason}`);
    }
    return { status: "ok", stats };
}

/**
 * Retrieve the reaction backlog over the socket. No phone confirmation.
 *
 * Reactions were long documented here as unrecoverable, which conflated two
 * things: the transfer-sync payload genuinely has no reaction field, but the
 * socket serves them on cmd 610/611 and Zalo Web asks for both on every
 * connect. Measured on a real account, one request pair returned 28 direct and
 * 50 group reactions while the local cache held one row.
 *
 * @param {{ownId: string, name?: string}} activeAcc
 * @param {{wait?: number, pages?: number, applyRemovals?: boolean}} opts
 */
async function runReactionSync(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    let api;
    try {
        api = getApi();
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const waitMs = Math.max(1, Number(opts.wait) || 15) * 1000;

    // A daemon holding the account's session can drain on it. Nothing is
    // stopped and nothing is evicted, so this is no longer a reason to refuse.
    const chan = getSyncChannel(accountDir, "reactions");
    if (chan) {
        info("A listen/mcp daemon holds this account's session — draining on its socket.");
        info("Requesting the reaction backlog (cmd 610 for 1-1, 611 for groups)…");
        const r = await syncViaDaemon(accountDir, {
            stage: "reactions",
            params: { waitMs, maxPages: opts.pages, applyRemovals: opts.removals !== false },
            onEvent: reactionProgress,
        });
        if (!r?.ok) {
            error(`Failed: ${daemonStageError(r)}`);
            process.exit(1);
        }
        reportReactionStage(r.result, r.result.placed || 0, r.result.unresolvedLeft || 0, opts.pages);
        process.exit(0);
    }

    // One socket and one db writer per account, same as every other path that
    // opens the WebSocket.
    if (!acquireLock(accountDir)) {
        error(`A listen daemon (or MCP server) is already running for account ${activeAcc.ownId}.`);
        // It holds the lock but published no channel, so it cannot run the
        // drain for us either. Restarting it is what makes that possible.
        info("Stop it first — Zalo permits one web session per account.");
        info("(A daemon started with a working sync channel would have run this drain on its own socket.)");
        process.exit(1);
    }

    let exitCode = 1;

    try {
        info("Connecting…");
        const connected = await connectListener(api, waitMs);

        if (!connected.ok) {
            if (connected.reason === "duplicate") {
                error("Zalo closed this connection: another web session is already open on this account.");
                info("Zalo allows one web session per account. Sign out of Zalo Web, then run this again.");
            } else {
                error(`Could not open a connection: ${connected.reason}`);
            }
        } else {
            const stats = await drainPass(api, { waitMs, pages: opts.pages, removals: opts.removals });
            reportReactionDrain(stats, opts);
            exitCode = 0;
        }
    } catch (err) {
        error(`Failed: ${err.message}`);
    } finally {
        try {
            api.listener.stop();
        } catch {
            // Already closed — nothing to clean up.
        }
        releaseLock(accountDir);
    }

    process.exit(exitCode);
}

/**
 * Drain the reaction backlog on an already-open socket. Exit-free.
 *
 * @param {object} api - with a started listener
 * @param {{waitMs: number, pages?: number, removals?: boolean}} opts
 * @returns {Promise<object>} drainReactions stats
 */
function drainPass(api, opts) {
    info("Requesting the reaction backlog (cmd 610 for 1-1, 611 for groups)…");
    return drainReactions({
        listener: api.listener,
        timeoutMs: opts.waitMs,
        maxPages: opts.pages,
        applyRemovals: opts.removals !== false,
        onProgress: reactionProgress,
    });
}

/**
 * Print one drain progress callback.
 *
 * Shared with the daemon path, where the identical callbacks arrive as events
 * off the channel rather than from a local `drainReactions` — the run must
 * look the same to the person watching it either way.
 *
 * @param {{phase: string, type?: string, page?: number, received?: number,
 *   more?: number, detail?: string}} p
 */
function reactionProgress(p) {
    if (p.phase === "page") {
        info(`  ${p.type} page ${p.page}: ${p.received} reaction(s)${p.more ? " (more)" : ""}`);
    } else if (p.phase === "timeout") {
        warning(`  ${p.type}: ${p.detail}`);
    } else if (p.phase === "warn") {
        warning(`  ${p.detail}`);
    }
}

/**
 * Report and classify a finished reaction stage, whichever socket it ran on.
 *
 * The retry pass runs in whichever process owns the db — here when this
 * process holds the socket, inside the daemon when the stage ran there — so
 * the two paths hand in `placed`/`left` already counted and share everything
 * downstream of that.
 *
 * @param {object} stats - drainReactions stats
 * @param {number} placed - unresolved reactions placed on the retry pass
 * @param {number} left - still unplaceable
 * @param {number} [pages=DRAIN_PAGES] - the cap that was asked for, so a
 *   truncation message names the number the caller would have to raise
 * @returns {{status: string, reason: string, stats: object}}
 */
function reportReactionStage(stats, placed, left, pages = DRAIN_PAGES) {
    reportReactionDrain(stats, { pages });
    if (placed) info(`Placed ${placed} reaction(s) whose message is now stored.`);
    return {
        status: stats.truncated ? "partial" : "ok",
        reason: `${stats.stored + placed} stored`,
        stats: { received: stats.received, stored: stats.stored + placed, unresolved: left },
    };
}

/**
 * Say why a stage the daemon was asked to run did not produce a result.
 *
 * Every one of these ends the stage. None of them may fall back to opening a
 * socket here: a daemon that answered at all still holds the account's one web
 * session, and a second would evict it — which is the harm this whole path
 * exists to avoid.
 *
 * @param {object|null} r - syncViaDaemon() result; null means it vanished
 * @returns {string}
 */
function daemonStageError(r) {
    if (!r) return "the daemon went away before the request — re-run `zalo-agent sync`";
    if (r.status === 409) {
        const since = r.busySince ? ` (started ${formatAge(Date.now() - Number(r.busySince))} ago)` : "";
        return `a ${r.busyStage || "sync"} is already running on that daemon${since} — wait for it to finish`;
    }
    // 404 is the daemon that predates these routes entirely; 503 is a newer
    // one wired without that stage. `getSyncChannel()` normally keeps us out
    // of both by reading the descriptor first, so reaching here means the
    // daemon was replaced between the plan and the request.
    if (r.status === 404 || r.status === 503) {
        return "that daemon does not run sync stages — restart it to pick the capability up";
    }
    if (r.disconnected) return `${r.error} — the daemon may have restarted; re-run \`zalo-agent sync\``;
    return r.error || "the daemon reported no result";
}

/**
 * Report a finished drain in the words `sync-reactions` has always used.
 *
 * @param {object} stats - drainReactions stats
 * @param {{pages?: number}} opts
 */
function reportReactionDrain(stats, opts) {
    if (stats.received === 0) {
        warning("The server returned no reactions.");
        info(
            "That is a caught-up queue, not a missing feature: this channel is what Zalo Web itself " +
                "asks on every connect. Reactions arriving from now on are captured by `zalo-agent listen`.",
        );
        return;
    }
    success(
        `Stored ${stats.stored} of ${stats.received} reaction(s) ` +
            `(${stats.byType.dm} direct, ${stats.byType.group} group; ${stats.changed} row(s) changed).`,
    );
    if (stats.skippedRemovals) {
        warning(
            `Skipped ${stats.skippedRemovals} un-react entr(y/ies) because of --no-removals, so the ` +
                "cache now holds reactions that were later taken off.",
        );
    }
    if (stats.truncated) {
        warning(`Stopped at the ${opts.pages}-page cap; re-run with a higher --pages for the rest.`);
    }
}

/** Walk the zCloud index. No phone, no socket. */
async function runCloudSync(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    let api;
    try {
        api = getApi();
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const r = await cloudPass(api, opts);
    if (r.status === "unavailable") {
        error("Could not read the cloud index.");
        for (const f of r.stats.failures.slice(0, 3)) info(`  ${f.reason}`);
        info("This account may not have zCloud enabled, or the endpoint may have changed.");
        process.exit(1);
    }
    if (r.stats.lastNoiseId && !r.stats.complete) info(`Resume cursor: ${r.stats.lastNoiseId}`);
    info("Cloud blobs are stored encrypted; this pass records where they live, it does not download them.");
    process.exit(0);
}

/**
 * One walk of the zCloud index. Exit-free.
 *
 * The cursor used to be printed and thrown away, so a walk capped by --pages
 * could only be continued by hand-copying it into --resume. It is now kept:
 * saved when the walk stops on the cap, cleared when the server says it has
 * nothing further, and an explicit --resume still wins.
 *
 * @param {object} api
 * @param {{resume?: string, pageSize?: number, pages?: number}} opts
 * @returns {Promise<{status: "ok"|"unavailable", stats: object}>}
 */
async function cloudPass(api, opts) {
    const saved = getSyncState("cloudCursor");
    const resume = opts.resume || saved || "";
    if (!opts.resume && saved) info("Continuing the cloud walk from where the last capped run stopped.");
    info("Walking the zCloud media index…");
    const stats = await syncCloudIndex({
        api,
        lastNoiseId: resume,
        pageSize: opts.pageSize,
        maxPages: opts.pages,
        onProgress: (p) => info(`  page ${p.page}: ${p.items} item(s) so far`),
    });
    if (stats.failed && !stats.items) return { status: "unavailable", stats };
    if (stats.complete) clearSyncState("cloudCursor");
    else if (stats.lastNoiseId) setSyncState("cloudCursor", String(stats.lastNoiseId));
    success(`Recorded ${stats.items} cloud item(s) across ${stats.pages} page(s).`);
    return { status: "ok", stats };
}

/** Human-readable byte count for the download summary. */
function formatBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Open the listener socket and resolve once connected (or on close/error/timeout).
 *
 * @param {object} api
 * @param {number} waitMs
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
function connectListener(api, waitMs) {
    return new Promise((res) => {
        let settled = false;
        const onConnected = () => done({ ok: true });
        const onClosed = (code) =>
            done({ ok: false, reason: code === CLOSE_DUPLICATE ? "duplicate" : `closed (${code})` });
        const onError = (e) => done({ ok: false, reason: e && e.message ? e.message : "socket error" });
        // Every handler comes off again when this settles. It used to leave all
        // three behind, which was harmless while a process connected exactly
        // once -- a reconnect makes them accumulate, and a stale "closed"
        // handler would resolve the NEXT connect attempt with the PREVIOUS
        // socket's close code.
        const done = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            api.listener.removeListener("connected", onConnected);
            api.listener.removeListener("closed", onClosed);
            api.listener.removeListener("error", onError);
            res(v);
        };
        const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), waitMs);
        api.listener.on("connected", onConnected);
        api.listener.on("closed", onClosed);
        api.listener.on("error", onError);
        api.listener.start({ retryOnClose: false });
    });
}

/**
 * Re-open the socket after it dropped mid-stage.
 *
 * Handed to `SyncV2.restore()` as its `reconnect`: that class never starts or
 * stops the listener itself, so the decision to reconnect is the caller's. A
 * 1006 is NOT in the server's own `close_and_retry_codes`
 * (`settings.features.socket`, measured: 5008 5007 3003 3000 5014 4002 5015
 * 5017 5016), so zca-js will never retry one for us -- without this, a dropped
 * wire ends the run and the phone confirmation it already spent is gone.
 *
 * @param {object} api
 * @param {number} [waitMs=30000]
 * @returns {Promise<boolean>} true once a live socket is back
 */
async function reconnectListener(api, waitMs = 30000) {
    // zca-js nulls `ws` on close and throws "Already started" while it is set,
    // so a socket still hanging around has to be put down first.
    if (api?.listener?.ws) await closeListener(api);
    const r = await connectListener(api, waitMs);
    return r.ok === true;
}

/**
 * Real mobile restore over transfer-sync-v2 (socket cmd 590/591): enumerate
 * conversations, request message history sharded at <=30 partitions, decrypt
 * with libzproto, decode protobuf, map opaque conv ids to real thread ids via
 * the friend/group lists, and write into zalo.db. Sends ONE sync request the
 * owner confirms on their phone. See src/core/sync-v2/index.js.
 *
 * @param {{ownId: string, name?: string}} activeAcc
 * @param {{force?: boolean, wait?: number, days?: number}} opts
 */
async function runTransferSync(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);

    let api;
    let syncManager;
    try {
        api = getApi();
        syncManager = new SyncManager(api, activeAcc.ownId);
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const win = resolveSyncWindow(opts.days, Date.now(), opts.from);

    // Debounce: skip a redundant run so we don't re-ping the phone, unless
    // --force. Asking for a wider window than the last run covered is not
    // redundant, so that is allowed through (reason "wider-window").
    const freshness = syncManager.checkSyncFreshness({ force: opts.force, coversFrom: win.from });
    if (freshness.skip) {
        success(`Already synced ${formatAge(freshness.ageMs)} ago — skipping to avoid re-pinging your phone.`);
        info("Pass --force to sync anyway.");
        process.exit(0);
    }
    if (freshness.reason === "wider-window") {
        info(`Last sync covered less than this — syncing ${win.label} despite the recent run.`);
    }

    // Transfer sync needs time for the phone confirmation; use a generous window.
    const waitMs = Math.max(180, Number(opts.wait) || 0) * 1000;
    let exitCode = 1;

    // A running daemon holds the account's one web session and can run the
    // restore on it. Stopping it to sync used to be the only option, and the
    // stop/start opened a fresh coverage gap around the very run meant to
    // close one. See src/core/daemon-channel.js.
    const chan = getSyncChannel(accountDir, "messages");
    if (chan) {
        // SyncV2 opens the db itself on the local path; here it opens the
        // daemon's copy in the daemon's process, so the media tail below has
        // nothing to read from until we open ours.
        initDb(join(accountDir, "zalo.db"));
        info("A listen/mcp daemon holds this account's session — running the restore on its socket.");
        info("Nothing is stopped: it keeps capturing live messages while the restore runs.");
        info(`Restoring ${win.label}.`);
        if (win.clamped) info("(--days reaches past the oldest history this sync can request.)");
        warning("This sends ONE sync request to your phone — confirm the 'ĐỒNG BỘ NGAY' prompt when it appears.");
        const r = await syncViaDaemon(accountDir, {
            stage: "messages",
            params: { days: opts.days ?? null, from: opts.from, shardSize: opts.shardSize, waitMs },
            onEvent: ({ phase, detail }) => {
                if (phase === "confirm") warning(detail);
                else if (detail) info(`  ${detail}`);
            },
        });
        if (!r?.ok) {
            error(`Failed: ${daemonStageError(r)}`);
        } else {
            reportRestore(r.result, win);
            exitCode = 0;
        }
    } else if (!acquireLock(accountDir)) {
        error(`A listen daemon is already running for account ${activeAcc.ownId}.`);
        // It holds the lock but published no channel, so it cannot run the
        // restore for us either. Restarting it is what makes that possible.
        info("Stop it first — one socket per account.");
        info("(A daemon started with a working sync channel would have run this restore on its own socket.)");
        process.exit(1);
    } else {
        // One heartbeat for the whole socket window. `SyncV2.restore()` can
        // hold this socket idle for minutes waiting on the phone, and the
        // server-advised ping is 180000 ms -- the full width of that wait.
        let heartbeat = null;
        try {
            info("Connecting…");
            const connected = await connectListener(api, 30000);
            if (!connected.ok) {
                if (connected.reason === "duplicate") {
                    error("Zalo closed this connection: another web session is already open on this account.");
                    info("Zalo allows one web session per account. Sign out of Zalo Web, then run this again.");
                } else {
                    error(`Could not open a connection: ${connected.reason}`);
                }
            } else {
                syncManager.markConnected();
                heartbeat = startKeepAlive(api.listener);
                info(`Restoring ${win.label}.`);
                if (win.clamped) info("(--days reaches past the oldest history this sync can request.)");
                warning(
                    "This sends ONE sync request to your phone — confirm the 'ĐỒNG BỘ NGAY' prompt when it appears.",
                );
                const sv = new SyncV2(api, activeAcc.ownId);
                const res = await sv.restore({
                    days: opts.days,
                    from: opts.from,
                    shardSize: opts.shardSize,
                    waitMs,
                    // This command owns the socket for the whole run, so it owns
                    // the heartbeat too -- see runUnifiedSync for why.
                    keepAlive: false,
                    reconnect: () => reconnectListener(api),
                    onStatus: ({ phase, detail }) => {
                        if (phase === "confirm") warning(detail);
                        else if (detail) info(`  ${detail}`);
                    },
                });
                reportRestore(res, win);
                exitCode = 0;
            }
        } catch (err) {
            error(`Failed: ${err.message}`);
        } finally {
            try {
                heartbeat?.stop();
            } catch {
                /* already stopped */
            }
            try {
                api.listener.stop();
            } catch {
                // already closed
            }
            releaseLock(accountDir);
        }
    }

    // Media is fetched only after the socket is closed and the lock released:
    // it needs neither, and holding them through a multi-thousand-file
    // download would block `listen` for no reason. A failure here never turns
    // a successful restore into a failed run -- the messages are already safe.
    if (exitCode === 0 && !opts.messagesOnly) {
        try {
            await fetchMediaAfterRestore(accountDir, api, win.from);
        } catch (err) {
            warning(`Media download stopped: ${err.message}`);
            info("The messages are stored. Run `zalo-agent sync-media` to retry the files.");
        }
    } else if (exitCode === 0 && opts.messagesOnly) {
        const pending = countPendingAttachments();
        if (pending)
            info(`${pending} attachment(s) left undownloaded (--messages-only). Run \`zalo-agent sync-media\`.`);
    }
    process.exit(exitCode);
}

/**
 * Report a finished restore, in the words `sync-mobile --transfer` has always
 * used. Exit-free, and says what happened so `sync` can summarize it.
 *
 * @param {object} res - SyncV2.restore() result
 * @param {{label: string, days: number|null}} win
 * @returns {{status: "ok"|"partial"|"unconfirmed", reason: string}}
 */
function reportRestore(res, win) {
    if (res.conversations === 0 && res.reason === "empty-window") {
        // The phone answered; the window is just empty. Different problem,
        // different advice.
        success(`Nothing to restore — no conversation activity in ${win.label}.`);
        if (win.days) info("Pass a larger --days, or drop --days for full history.");
        return { status: "ok", reason: "phone confirmed: nothing missed in this window" };
    }
    if (res.reason === "partial" || res.reason === "socket-lost") {
        const how = res.reason === "socket-lost" ? "the connection dropped" : "the run was cut short";
        warning(
            `Partial restore: ${res.messagesSaved} message(s) from ${res.conversations} conversation(s) before ${how}.`,
        );
        info("What arrived is stored. Re-run with --force to fetch the rest.");
        if (res.reason === "socket-lost" && res.resumes) {
            info(`The connection was re-established ${res.resumes} time(s) and dropped again.`);
        }
        return { status: "partial", reason: `${res.messagesSaved} message(s) before ${how}` };
    }
    if (res.conversations === 0) {
        warning("No conversations returned — the phone prompt may not have been confirmed in time. Try again.");
        return { status: "unconfirmed", reason: "the phone prompt was not confirmed in time" };
    }
    success(
        `Restored ${res.messagesSaved} message(s) from ${res.conversations} conversation(s) (${win.label}) into the local cache.`,
    );
    info(
        `Threads resolved to real ids/names: ${res.threadsMapped}; unresolved (non-friend or OA): ${res.threadsUnmapped}.`,
    );
    const breakdown = Object.entries(res.typeCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t, c]) => `${t} ${c}`)
        .join(", ");
    if (breakdown) info(`By type: ${breakdown}.`);
    if (res.attachmentsSaved) info(`${res.attachmentsSaved} message(s) carry media.`);
    // The conversation round is the only authoritative list of what the account
    // still has. Anything cached outside it is orphaned and nothing else would
    // ever notice.
    try {
        const orphans = getOrphanThreads(res.liveThreadIds || null);
        const withData = orphans.filter((t) => (t.messages || 0) + (t.files || 0) > 0);
        if (withData.length) {
            const files = withData.reduce((n, t) => n + (t.files || 0), 0);
            warning(
                `${withData.length} conversation(s) are no longer on your account but still cached here (${files} downloaded file(s)).`,
            );
            info("Reclaim the space with `zalo-agent sync-media --prune-orphans`,");
            info("or remove them entirely with `zalo-agent conv forget --orphans`.");
        }
    } catch {
        /* orphan reporting must never fail a successful restore */
    }
    return { status: "ok", reason: `${res.messagesSaved} message(s) from ${res.conversations} conversation(s)` };
}

/**
 * Download everything the restore just recorded.
 *
 * Scoped to the window just synced and never to pruned media, but otherwise
 * uncapped: the point of a default-on fetch is that a restored
 * conversation is complete, and a silent 500-file ceiling would leave it not
 * obviously broken. Interrupting is safe -- `sync-media` resumes from whatever
 * still has no localPath.
 *
 * @param {string} accountDir
 * @param {object|null} api - needed only to renew expired links
 */
async function fetchMediaAfterRestore(accountDir, api, since) {
    const pending = countPendingAttachments();
    if (!pending) return null;

    info(`Downloading ${pending} attachment(s) — no phone confirmation needed. Ctrl-C is safe; it resumes.`);
    let last = 0;
    // Tallied here rather than read off the result: the result does not exist
    // until the whole download resolves, so progress lines would all read 0 B.
    let bytes = 0;
    const stats = await downloadSyncedMedia({
        api,
        accountDir,
        limit: Number.MAX_SAFE_INTEGER,
        // Only media inside the window this run actually covered, and never
        // anything deliberately pruned. Without both, a sync silently undoes a
        // `sync-media --prune`: pruning clears localPath to requeue the row, so
        // an unscoped fetch re-downloads exactly what was just deleted.
        since: Number.isFinite(since) && since > 0 ? since : undefined,
        includePruned: false,
        concurrency: 4,
        threadNames: getThreadNames(),
        onProgress: (p) => {
            if (p.phase !== "saved") return;
            bytes += p.bytes || 0;
            if (p.done === p.total || p.done - last >= 50) {
                last = p.done;
                info(`  ${p.done}/${p.total} files (${formatBytes(bytes)})`);
            }
        },
    });
    success(`Downloaded ${stats.downloaded}/${stats.considered} file(s) (${formatBytes(stats.bytes)}).`);
    if (stats.renewed) info(`Renewed ${stats.renewed} expired link(s).`);
    if (stats.expired) {
        warning(`${stats.expired} link(s) are gone and could not be renewed.`);
        info("Zalo keeps media for a limited time; past that the file exists only on the sending device.");
    }
    if (stats.throttled) {
        warning(
            `${stats.throttled} request(s) were rate limited (${describeDownloadReasons(stats.reasons, "throttled")}).`,
        );
        info("Re-run `zalo-agent sync-media` later to pick them up; a lower --concurrency helps.");
    }
    if (stats.unknown) {
        warning(
            `${stats.unknown} request(s) failed without saying why (${describeDownloadReasons(stats.reasons, "unknown")}).`,
        );
        info("403 is ambiguous — a lapsed signature and load look identical. Re-run `zalo-agent sync-media` first;");
        info("if they keep failing, only a fresh `zalo-agent sync --from <YYYY-MM-DD>` can hand back a new link.");
    }
    if (stats.abortedEarly) warning("Media stopped early after too many unusable responses; nothing is lost.");
    return stats;
}

/**
 * Stop the listener and wait for its socket to actually close.
 *
 * stop() returns at once, but the socket's own onclose runs later and resets
 * the listener a second time. Releasing daemon.lock before that lands would let
 * a `listen` started in the gap be nulled by our late reset. Bounded, so a
 * socket that already died cannot hang the run.
 *
 * @param {object} api
 * @param {number} [ms=3000]
 * @returns {Promise<void>}
 */
function closeListener(api, ms = 3000) {
    return new Promise((res) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res();
        };
        const timer = setTimeout(finish, ms);
        try {
            api.listener.once("closed", finish);
            api.listener.once("disconnected", finish);
            api.listener.stop();
        } catch {
            finish();
        }
    });
}

/** True while the listener's socket is connecting or open. */
function socketAlive(api) {
    const ws = api?.listener?.ws;
    return Boolean(ws) && ws.readyState <= 1;
}

/** One line per stage, for the human summary. */
const STATUS_MARK = { ok: "✓", partial: "◐", skipped: "–", unavailable: "○", unconfirmed: "?", failed: "✗" };

/**
 * Print a plan without running it.
 *
 * @param {object} plan - planSyncRun() result
 * @param {object} win - resolveSyncWindow() result
 * @param {boolean} jsonMode
 */
function printPlan(plan, win, jsonMode) {
    output(
        {
            window: win.label,
            openSocket: plan.openSocket,
            viaDaemon: plan.viaDaemon,
            stages: plan.stages.map((s) => ({
                stage: s.name,
                transport: s.transport,
                run: s.run,
                via: s.via,
                wakesPhone: s.phone && s.run,
                why: s.why,
            })),
        },
        jsonMode,
        () => {
            info(`Plan for \`zalo-agent sync\` — ${win.label}. Nothing has been sent.`);
            if (plan.viaDaemon) {
                info("Runs the socket stages on the running listen/mcp daemon's socket — opens no WebSocket here,");
                info("stops nothing, and the daemon keeps capturing live messages throughout.");
            } else {
                info(plan.openSocket ? "Opens the WebSocket once, for the socket stages." : "Opens no WebSocket.");
            }
            for (const s of plan.stages) {
                const tag = s.run ? (s.phone ? "RUN  (wakes your phone)" : "RUN") : "skip";
                // The transport column says HOW; this says WHOSE socket.
                const where = s.run && s.via === "daemon" ? `${s.transport}→daemon` : s.transport;
                console.log(`    ${tag.padEnd(24)} ${s.name.padEnd(10)} ${where.padEnd(14)} ${s.why || s.label}`);
            }
        },
    );
}

/**
 * One run that pulls every kind of message state the account has.
 *
 * Reactions, pinned conversations, notes, polls and reminders are all state
 * of the messages and conversations, and they were split across five
 * commands -- two of which each opened their own socket and took their own
 * lock, so a full refresh meant running five things in the right order and
 * evicting Zalo Web twice. This runs them as stages of one process: one lock,
 * one socket window shared by the socket stages, then the REST stages, and one
 * exit code at the end. The five commands remain for targeted re-runs.
 *
 * Order, and why:
 *   1. open the socket once, with a live-store tap throughout, so nothing
 *      that arrives during the run is lost;
 *   2. restore messages (the only phone prompt, at most once), alone and
 *      exactly as `sync-mobile --transfer` does -- running the reaction drain
 *      beside it cost the restore its socket on every live attempt;
 *   3. drain the reaction backlog on the same socket;
 *   4. retry reactions whose message was not stored when they arrived;
 *   5. close the socket, wait for it, release the lock;
 *   6. REST stages: pinned/unread, boards, cloud, then media last.
 *
 * Never calls a run* function: those end the process. Only exit-free helpers.
 *
 * @param {{ownId: string}} activeAcc
 * @param {object} opts - command options
 * @param {boolean} jsonMode
 */
async function runUnifiedSync(activeAcc, opts, jsonMode) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
    initDb(join(accountDir, "zalo.db"));

    let api;
    let syncManager;
    try {
        api = getApi();
        syncManager = new SyncManager(api, activeAcc.ownId);
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const win = resolveSyncWindow(opts.days, Date.now(), opts.from);
    const freshness = syncManager.checkSyncFreshness({ force: opts.force, coversFrom: win.from });
    const want = {
        messages: opts.messages !== false,
        reactions: opts.reactions !== false,
        convState: opts.convState !== false,
        boards: opts.boards !== false,
        cloud: opts.cloud !== false,
        media: opts.media !== false,
    };

    // A running listen/mcp daemon holds the account's one web session — and can
    // now run the socket stages on it. So a daemon being up no longer means
    // these stages are skipped, and the old recipe (stop it, sync, start it
    // again) is no longer the way to close a gap: the stop/start itself opened
    // a fresh ~70s hole with no repair path. See src/core/daemon-channel.js.
    const chan = getSyncChannel(accountDir);

    if (opts.plan) {
        printPlan(
            planSyncRun({
                want,
                freshness,
                lockOk: !checkLock(accountDir).locked,
                daemonChannel: Boolean(chan),
            }),
            win,
            jsonMode,
        );
        process.exit(0);
    }

    // Take the lock only if a socket stage could run HERE: REST stages need
    // neither the socket nor exclusivity, exactly as sync-boards and sync-media
    // never did, and a stage running on the daemon runs under the daemon's own
    // lock — taking it is neither possible nor wanted.
    const mightUseSocket = (want.messages && !freshness.skip) || want.reactions;
    const lockHeld = mightUseSocket && !chan ? acquireLock(accountDir) : false;
    // `lockOk` asks one thing: may THIS process open the socket? Moot when no
    // socket stage is wanted; no when a daemon is serving one (it holds the
    // lock, and `daemonChannel` is what turns that from a skip into a hand-off).
    const lockOk = !mightUseSocket ? true : chan ? false : lockHeld;
    const plan = planSyncRun({ want, freshness, lockOk, daemonChannel: Boolean(chan) });
    const runs = (name) => plan.stages.find((s) => s.name === name)?.run;

    const results = [];
    const record = (stage, status, reason = "", stats = undefined) => results.push({ stage, status, reason, stats });
    for (const s of plan.stages) if (!s.run) record(s.name, "skipped", s.why);

    // ---- socket stages on the running daemon's socket
    //
    // Nothing here opens a connection, takes the lock or stops anything. The
    // daemon runs each stage on the session it already holds and streams the
    // same progress callbacks back, so the run reads identically -- and it
    // keeps capturing live traffic throughout, which is the entire point:
    // the stop/sync/start recipe this replaces lost every message that
    // arrived in the ~70s the daemon was down.
    if (plan.viaDaemon) {
        info("A listen/mcp daemon holds this account's session — running the socket stages on it.");
        info("Nothing is stopped, so live capture continues while they run.");

        if (runs("messages")) {
            info(`Restoring ${win.label}.`);
            if (win.clamped) info("(--days reaches past the oldest history this sync can request.)");
            // Unchanged by the hand-off. The daemon supplies the socket; only
            // the owner's phone can supply the history.
            warning("This sends ONE sync request to your phone — confirm the 'ĐỒNG BỘ NGAY' prompt when it appears.");
            const r = await syncViaDaemon(accountDir, {
                stage: "messages",
                params: {
                    days: opts.days ?? null,
                    from: opts.from,
                    shardSize: opts.shardSize,
                    waitMs: Math.max(180, Number(opts.wait) || 0) * 1000,
                },
                onEvent: ({ phase, detail }) => {
                    if (phase === "confirm") warning(detail);
                    else if (detail) info(`  ${detail}`);
                },
            });
            if (!r?.ok) {
                const why = daemonStageError(r);
                warning(`Message restore failed: ${why}`);
                record("messages", "failed", why);
            } else {
                const rep = reportRestore(r.result, win);
                record("messages", rep.status, rep.reason, {
                    conversations: r.result.conversations,
                    messagesSaved: r.result.messagesSaved,
                });
            }
        }

        if (runs("reactions")) {
            info("Requesting the reaction backlog (cmd 610 for 1-1, 611 for groups)…");
            const r = await syncViaDaemon(accountDir, {
                stage: "reactions",
                params: { waitMs: DRAIN_WAIT_MS, maxPages: DRAIN_PAGES, applyRemovals: opts.removals !== false },
                onEvent: reactionProgress,
            });
            if (!r?.ok) {
                const why = daemonStageError(r);
                warning(`Reaction backlog failed: ${why}`);
                record("reactions", "failed", why);
            } else if (!r.result.received && r.result.socketAlive === false) {
                // Same rule as the local path: an empty drain on a dead socket
                // is a lost connection, not the caught-up queue it looks like.
                warning("Reaction backlog: the daemon's socket closed before it answered.");
                record("reactions", "failed", "socket closed before the backlog answered");
            } else {
                const rep = reportReactionStage(r.result, r.result.placed || 0, r.result.unresolvedLeft || 0);
                record("reactions", rep.status, rep.reason, rep.stats);
            }
        }
    }

    // ---- socket window
    if (plan.openSocket) {
        let detachLive = () => {};
        // ONE heartbeat for the whole socket window, covering every socket
        // stage and the gaps between them.
        //
        // The socket is not unpinged without this -- zca-js sends Zalo's
        // `cmd 2/1` ping on the interval the server hands out at login, which
        // this account's login reports as 180000 ms, the same value a captured
        // Zalo Web session used. The problem is that 180 s is the entire width
        // of the phone wait: the restore sends nothing and receives nothing for
        // minutes, so the flow can sit silent right up against the server's own
        // liveness bound with no margin, and one late ping means six minutes of
        // silence. This pings at a third of that, and counts the echoes -- a
        // ping count running ahead of the echo count is the only trace a bare
        // 1006 (no close frame) ever leaves behind.
        //
        // It reads `listener.ws` fresh on every tick, so it keeps working
        // across the reconnect `reconnectListener` performs mid-restore.
        let heartbeat = null;
        try {
            info("Connecting…");
            const connected = await connectListener(api, 30000);
            if (!connected.ok) {
                const why =
                    connected.reason === "duplicate"
                        ? "another web session is open on this account (sign out of Zalo Web)"
                        : `could not open a connection: ${connected.reason}`;
                warning(`Socket stages skipped — ${why}.`);
                for (const n of ["messages", "reactions"]) if (runs(n)) record(n, "failed", why);
            } else {
                syncManager.markConnected();
                heartbeat = startKeepAlive(api.listener);

                // The restore runs FIRST and ALONE, exactly as `sync-mobile
                // --transfer` runs it -- its own live-store tap included. The
                // first version drained the reaction backlog concurrently, as
                // Zalo Web does on connect, and the restore then lost its socket
                // (close 1006) at batch 0 of 5 on both live attempts, right after
                // the phone confirmed. The same window on the same account
                // restored 11,324 messages through the old command minutes later.
                // Each half is proven alone, so they now run one after the other
                // on the same socket.
                if (runs("messages")) {
                    info(`Restoring ${win.label}.`);
                    if (win.clamped) info("(--days reaches past the oldest history this sync can request.)");
                    warning(
                        "This sends ONE sync request to your phone — confirm the 'ĐỒNG BỘ NGAY' prompt when it appears.",
                    );
                    try {
                        const res = await new SyncV2(api, activeAcc.ownId).restore({
                            days: opts.days,
                            from: opts.from,
                            shardSize: opts.shardSize,
                            waitMs: Math.max(180, Number(opts.wait) || 0) * 1000,
                            // The window-level heartbeat above covers this stage.
                            keepAlive: false,
                            reconnect: () => reconnectListener(api),
                            onStatus: ({ phase, detail }) => {
                                if (phase === "confirm") warning(detail);
                                else if (detail) info(`  ${detail}`);
                            },
                        });
                        const r = reportRestore(res, win);
                        record("messages", r.status, r.reason, {
                            conversations: res.conversations,
                            messagesSaved: res.messagesSaved,
                        });
                    } catch (err) {
                        warning(`Message restore failed: ${err.message}`);
                        record("messages", "failed", err.message);
                    }
                }

                if (runs("reactions")) {
                    // The restore detached its own tap; keep live traffic
                    // captured for the rest of the socket window.
                    detachLive = attachLiveStore(api.listener);
                    const rx = await drainPass(api, {
                        waitMs: DRAIN_WAIT_MS,
                        pages: DRAIN_PAGES,
                        removals: opts.removals,
                    }).catch((e) => ({ error: e }));
                    if (rx.error) {
                        warning(`Reaction backlog failed: ${rx.error.message}`);
                        record("reactions", "failed", rx.error.message);
                    } else if (!rx.received && !socketAlive(api)) {
                        // An empty drain on a dead socket is a lost connection,
                        // not the "caught-up queue" an empty drain normally is.
                        warning("Reaction backlog: the socket closed before it answered.");
                        record("reactions", "failed", "socket closed before the backlog answered");
                    } else {
                        // A reaction naming only a client id is unresolvable until
                        // its message is stored. The restore has run by now, but
                        // the backlog reaches further back than a windowed one.
                        const placed = placeUnresolvedReactions(rx.unresolved);
                        const rep = reportReactionStage(rx, placed, (rx.unresolved?.length || 0) - placed);
                        record("reactions", rep.status, rep.reason, rep.stats);
                    }
                }
            }
        } catch (err) {
            warning(`Socket stages stopped: ${err.message}`);
            for (const n of ["messages", "reactions"]) {
                if (runs(n) && !results.some((r) => r.stage === n)) record(n, "failed", err.message);
            }
        } finally {
            try {
                heartbeat?.stop();
            } catch {
                /* already stopped */
            }
            try {
                detachLive();
            } catch {
                /* already detached */
            }
            await closeListener(api);
            if (lockHeld) releaseLock(accountDir);
        }
    } else if (lockHeld) {
        releaseLock(accountDir);
    }

    // ---- REST stages, after the socket is closed and the lock released
    if (runs("convState")) {
        try {
            info("Reading pinned and unread-marked conversations…");
            const st = await syncConvState({ api });
            success(
                `Pinned: ${st.pinned}${st.unpinned ? ` (${st.unpinned} unpinned elsewhere)` : ""}; ` +
                    `unread-marked: ${st.unread}${st.unmarked ? ` (${st.unmarked} cleared elsewhere)` : ""}.`,
            );
            if (st.unresolved || st.ambiguous) {
                info(
                    `${st.unresolved} conversation(s) not in the local cache` +
                        (st.ambiguous ? `, ${st.ambiguous} unread mark(s) matching more than one thread` : "") +
                        " — left alone rather than guessed.",
                );
            }
            record(
                "convState",
                st.failures.length ? (st.failures.length === 2 ? "failed" : "partial") : "ok",
                st.failures.map((f) => `${f.what}: ${f.reason}`).join("; "),
                { pinned: st.pinned, unread: st.unread, unresolved: st.unresolved, ambiguous: st.ambiguous },
            );
        } catch (err) {
            warning(`Conversation state failed: ${err.message}`);
            record("convState", "failed", err.message);
        }
    }

    if (runs("boards")) {
        try {
            const r = await boardPass(api, { limit: 200, concurrency: 3, boards: true, reminders: true });
            if (r.status === "skipped") record("boards", "skipped", r.reason);
            else {
                record("boards", r.stats.failed ? "partial" : "ok", `${r.stats.failed} request(s) failed`, {
                    boardItems: r.stats.boardItems,
                    reminders: r.stats.reminders,
                    threads: r.stats.threads,
                });
            }
        } catch (err) {
            warning(`Boards failed: ${err.message}`);
            record("boards", "failed", err.message);
        }
    }

    if (runs("cloud")) {
        try {
            const r = await cloudPass(api, { pages: 50, pageSize: 300 });
            if (r.status === "unavailable") {
                // Not a failure: an account without zCloud answers exactly like
                // this, and `sync` must not exit 1 on every such account.
                info("zCloud index unavailable (zCloud off, or the endpoint changed).");
                record("cloud", "unavailable", r.stats.failures[0]?.reason || "no items readable");
            } else {
                record(
                    "cloud",
                    r.stats.complete ? "ok" : "partial",
                    r.stats.complete ? "" : "stopped at the page cap",
                    {
                        items: r.stats.items,
                    },
                );
            }
        } catch (err) {
            warning(`Cloud index failed: ${err.message}`);
            record("cloud", "failed", err.message);
        }
    }

    if (runs("media")) {
        try {
            const since = Number(getSyncState("lastSyncOkFrom"));
            const m = await fetchMediaAfterRestore(accountDir, api, since);
            if (!m) record("media", "ok", "nothing waiting to download");
            else {
                const short = m.expired || m.throttled || m.unknown || m.abortedEarly;
                record("media", short ? "partial" : "ok", "", {
                    downloaded: m.downloaded,
                    considered: m.considered,
                    expired: m.expired,
                    throttled: m.throttled,
                    unknown: m.unknown,
                    reasons: m.reasons,
                });
            }
        } catch (err) {
            warning(`Media download stopped: ${err.message}`);
            info("The messages are stored. Run `zalo-agent sync-media` to retry the files.");
            record("media", "failed", err.message);
        }
    }

    // ---- one summary, one exit code
    const order = plan.stages.map((s) => s.name);
    results.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    const exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
    output({ window: win.label, stages: results, exitCode }, jsonMode, () => {
        info("Summary:");
        for (const r of results) {
            console.log(
                `    ${STATUS_MARK[r.status] || "·"} ${r.stage.padEnd(10)} ${r.status.padEnd(12)} ${r.reason || ""}`,
            );
        }
    });
    process.exit(exitCode);
}

/**
 * Best-effort backfill: ask Zalo's servers for old messages over the WebSocket
 * (socket cmd 510 for DMs, 511 for groups) and write whatever comes back into
 * zalo.db.
 *
 * HONEST STATUS, measured 2026-09-20: on the account this was developed
 * against, Zalo answers both commands with an EMPTY set — including when given
 * the exact `lastId` anchors Zalo Web itself sends. Zalo Web gets the same
 * empty answer and then falls back to `transfer-sync-v2` (socket cmd 590/591,
 * libsignal-encrypted), which is the only path observed carrying real data and
 * is NOT implemented here.
 *
 * DO NOT read "no phone contact" as a feature. The phone IS the data source:
 * the account owner confirmed that a real Zalo Web sync makes their phone show
 * a request notification, which means cmd 590 causes the server to wake the
 * phone, and the phone encrypts the payload that comes back as cmd 601. A run
 * of this command that leaves the phone silent has not synced anything.
 *
 * So this is a probe that costs nothing and occasionally may return something,
 * not a restore. What it improves on is harm, not capability: the version it
 * replaced pinged the owner's phone ~24 times per run chasing a retired REST
 * endpoint that could never answer. See agent/work/transfer-sync-v2/NOTES.md § Mobile sync.
 *
 * @param {{ownId: string, name?: string}} activeAcc
 * @param {{wait?: number}} opts
 */
async function runSocketBackfill(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);

    // Build the SyncManager first so we can consult the local sync-freshness
    // marker BEFORE touching the network. A redundant run should neither open
    // a socket (which would evict a live Zalo Web session) nor, once the
    // transfer-sync path lands, wake the owner's phone — the same debounce Zalo
    // Web applies to its own "Đồng bộ tin nhắn".
    let api;
    let syncManager;
    try {
        api = getApi();
        syncManager = new SyncManager(api, activeAcc.ownId);
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const freshness = syncManager.checkSyncFreshness({ force: opts.force });
    if (freshness.skip) {
        success(`Already synced ${formatAge(freshness.ageMs)} ago — skipping to avoid re-pinging the server.`);
        info(
            "Nothing looks missing since then. Pass --force to sync anyway, or run `zalo-agent listen` to keep the cache live.",
        );
        process.exit(0);
    }

    // The backfill opens a WebSocket and writes to zalo.db, which is exactly
    // what the `listen` daemon does. One socket and one db writer per account.
    //
    // This is the ONE socket path that is not routed through a running
    // daemon's channel, and deliberately: cmd 510/511 is measured to answer
    // empty (see the docblock above), so a hand-off would be a socket path
    // built for an endpoint that cannot answer -- relocating the defect, not
    // fixing it. The real restore IS routed, so say so rather than repeating
    // "stop the daemon", which is no longer the answer to anything.
    if (!acquireLock(accountDir)) {
        error(`A listen daemon is already running for account ${activeAcc.ownId}.`);
        if (getSyncChannel(accountDir)) {
            info("You do not need to stop it: `zalo-agent sync` runs the socket stages on that daemon's socket.");
            info("This default path only asks cmd 510/511, which Zalo answers empty. The real restore is:");
            info("  zalo-agent sync");
        } else {
            info("Stop it first, or let it keep the cache up to date on its own — it writes the same rows.");
            info("(A daemon started with a working sync channel would let `zalo-agent sync` run without stopping it.)");
        }
        process.exit(1);
    }

    const waitMs = Math.max(1, Number(opts.wait) || 30) * 1000;
    let exitCode = 1;

    try {
        info("Connecting…");
        const connected = await connectListener(api, waitMs);

        if (!connected.ok) {
            if (connected.reason === "duplicate") {
                error("Zalo closed this connection: another web session is already open on this account.");
                info("Zalo allows one web session per account. Sign out of Zalo Web, then run this again.");
            } else {
                error(`Could not open a connection: ${connected.reason}`);
            }
        } else {
            syncManager.markConnected();
            info("Requesting recent history from the server…");
            const res = await syncManager.backfillOverSocket(api.listener, {
                timeoutMs: waitMs,
                onBatch: ({ count, threadType }) => {
                    info(`  received ${count} ${threadType === 0 ? "direct" : "group"} message(s)`);
                },
            });

            if (res.total === 0) {
                warning("No history returned — and your phone was never asked.");
                info(
                    "A real Zalo sync notifies your phone, because the phone is the data source: Zalo Web sends " +
                        "socket cmd 590, the server wakes the phone, the phone encrypts and uploads, and the payload " +
                        "comes back as cmd 601. That handshake (transfer-sync-v2) is what `--transfer` runs; this " +
                        "default path does not, so the absence of a notification on your phone means no real sync took place.",
                );
                info("For the real restore run: zalo-agent sync  (or sync-mobile --transfer for messages alone)");
                exitCode = 0;
            } else {
                success(`Backfilled ${res.saved}/${res.total} message(s) into the local cache.`);
                if (res.reason === "timeout") {
                    warning("Stopped on the wait limit — re-run with a longer --wait if you expected more.");
                }
                exitCode = 0;
            }
        }
    } catch (err) {
        error(`Failed: ${err.message}`);
    } finally {
        try {
            api.listener.stop();
        } catch {
            // Already closed — nothing to clean up.
        }
        releaseLock(accountDir);
    }

    process.exit(exitCode);
}

/**
 * The retired path, kept behind --legacy so the behavior stays inspectable.
 *
 * `/api/message/pull_mobile_msg` and `/api/message/get_crossdb` are still
 * present in Zalo Web's own bundle but have ZERO call sites in it — the client
 * moved to a WebSocket protocol (cmd 590/591, "transfer-sync-v2"). The
 * endpoints answer with an empty payload rather than an error, which is why
 * this used to look like "the phone hasn't replied yet" and retry for two
 * minutes, putting a notification on the owner's phone each time.
 *
 * It runs exactly once now.
 *
 * @param {{ownId: string}} activeAcc
 * @param {{force?: boolean}} opts
 */
async function runLegacySync(activeAcc, opts) {
    warning(
        "--legacy uses an endpoint Zalo has retired. This pings your mobile app and will most likely find nothing.",
    );
    try {
        const syncManager = new SyncManager(getApi(), activeAcc.ownId);
        const res = await syncManager.pollSync(0, 0, { force: !!opts.force });

        switch (res.status) {
            case "already-synced":
                success("Already synced — no known missed messages since the last successful sync.");
                info("Pass --force to check anyway.");
                process.exit(0);
                break;
            case "saved":
                success(`Synced ${res.saved}/${res.total} message(s) from mobile into the local cache.`);
                process.exit(0);
                break;
            case "empty-or-unrecognized":
                success("Sync round-trip completed — nothing new to save.");
                process.exit(0);
                break;
            case "legacy-retired":
                error("The legacy mobile-sync endpoint returned nothing — Zalo no longer serves it.");
                info("Run `zalo-agent sync-mobile` without --legacy to backfill over the WebSocket instead.");
                process.exit(1);
                break;
            case "crossdb-error":
                error(`Sync failed: ${res.error}`);
                process.exit(1);
                break;
            default:
                error(`Unrecognized sync result: ${res.status}`);
                process.exit(1);
        }
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }
}
