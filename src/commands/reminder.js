/**
 * Reminder commands — create, list, info, edit, remove reminders in users/groups.
 */

import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { getMessageById, upsertMessage, dbExists } from "../core/db.js";
import { success, error, info, output } from "../utils/output.js";

/** Repeat mode labels matching zca-js ReminderRepeatMode enum. */
const REPEAT_MODES = { none: 0, daily: 1, weekly: 2, monthly: 3 };
const REPEAT_LABELS = { 0: "None", 1: "Daily", 2: "Weekly", 3: "Monthly" };

/** Parse a datetime string into Unix timestamp (ms). Accepts ISO or "YYYY-MM-DD HH:mm". */
function parseTime(str) {
    // Try "YYYY-MM-DD HH:mm" format
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, mo, d, h, mi] = match;
        return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
    }
    // Fallback to Date.parse (ISO, etc.)
    const ts = Date.parse(str);
    if (isNaN(ts)) return null;
    return ts;
}

export function registerReminderCommands(program) {
    const reminder = program.command("reminder").description("Create and manage reminders in users/groups");

    reminder
        .command("create <threadId> <title>")
        .description("Create a reminder. Use --msg-id to auto-fill title from a message.")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--time <datetime>", 'Reminder time: "YYYY-MM-DD HH:mm" (default: now)')
        .option("--emoji <emoji>", "Emoji icon", "⏰")
        .option("--repeat <mode>", "Repeat: none, daily, weekly, monthly", "none")
        .option("--msg-id <msgId>", "Look up this message and use its text as the reminder title (checks local cache first, falls back to live WS fetch)")
        .option("--timeout <ms>", "Timeout in ms for live WS fallback when --msg-id is not cached", "15000")
        .action(async (threadId, title, opts) => {
            const jsonMode = program.opts().json;
            try {
                const repeatMode = REPEAT_MODES[opts.repeat];
                if (repeatMode === undefined) {
                    error(`Invalid repeat mode: "${opts.repeat}". Valid: none, daily, weekly, monthly`);
                    return;
                }
                let startTime = Date.now();
                if (opts.time) {
                    startTime = parseTime(opts.time);
                    if (!startTime) {
                        error(`Invalid time format: "${opts.time}". Use "YYYY-MM-DD HH:mm" or ISO format.`);
                        return;
                    }
                }

                // --msg-id: resolve title from message text
                if (opts.msgId) {
                    const ownId = getActive()?.ownId ?? null;
                    let resolved = null;

                    // Step 1: SQLite cache lookup
                    if (ownId && dbExists(ownId)) {
                        const row = getMessageById(ownId, opts.msgId);
                        if (row?.content) {
                            resolved = row.content;
                            if (!jsonMode) info(`Using cached message text as title: "${resolved}"`);
                        }
                    }

                    // Step 2: WS live fallback if cache miss
                    if (!resolved) {
                        if (!jsonMode) info(`Message not in cache — fetching from Zalo (timeout: ${opts.timeout}ms)...`);
                        const api = getApi();
                        const threadType = Number(opts.type);
                        const timeout = Number(opts.timeout);

                        resolved = await new Promise((resolve) => {
                            let found = false;
                            const timer = setTimeout(() => {
                                if (!found) {
                                    api.listener.stop();
                                    resolve(null);
                                }
                            }, timeout);

                            api.listener.on("old_messages", (messages) => {
                                if (found) return;
                                for (const msg of messages) {
                                    const msgId = msg.data?.msgId || msg.msgId;
                                    if (String(msgId) !== String(opts.msgId)) continue;
                                    // Found — extract content
                                    const content = typeof msg.data?.content === "string"
                                        ? msg.data.content
                                        : (msg.data?.content?.title ?? null);
                                    if (!content) continue;
                                    found = true;
                                    clearTimeout(timer);
                                    // Backfill cache
                                    if (ownId) {
                                        try {
                                            upsertMessage(ownId, {
                                                msgId:     String(msgId),
                                                threadId:  msg.threadId || threadId,
                                                threadType,
                                                uidFrom:   msg.data?.uidFrom || null,
                                                isSelf:    false,
                                                msgType:   msg.data?.msgType || "text",
                                                content,
                                                timestamp: msg.data?.ts ? Number(msg.data.ts) : Date.now(),
                                            });
                                        } catch { /* non-blocking */ }
                                    }
                                    api.listener.stop();
                                    resolve(content);
                                    return;
                                }
                                // Not in this page — request older page
                                const lastMsg = messages[messages.length - 1];
                                const lastId = lastMsg?.data?.actionId || lastMsg?.data?.msgId || null;
                                if (lastId) api.listener.requestOldMessages(threadType, lastId);
                            });

                            api.listener.on("connected", () => {
                                api.listener.requestOldMessages(threadType, null);
                            });
                            api.listener.on("error", () => {
                                clearTimeout(timer);
                                api.listener.stop();
                                resolve(null);
                            });
                            api.listener.start({ retryOnClose: false });
                        });

                        if (!resolved) {
                            error(
                                `Message "${opts.msgId}" not found in cache or recent history.\n` +
                                `  Tip: run "zalo-agent listen" to populate the local cache, or omit --msg-id and pass the title directly.`
                            );
                            process.exit(1);
                        }
                        if (!jsonMode) info(`Found message text: "${resolved}"`);
                    }

                    title = resolved;
                }

                const result = await getApi().createReminder(
                    { title, emoji: opts.emoji, startTime, repeat: repeatMode },
                    threadId,
                    Number(opts.type),
                );
                output(result, jsonMode, () => {
                    success(`Reminder created: "${title}"`);
                    const id = result.reminderId || result.id || "?";
                    info(`Reminder ID: ${id}`);
                    info(`Time: ${new Date(startTime).toLocaleString()}`);
                    if (repeatMode > 0) info(`Repeat: ${REPEAT_LABELS[repeatMode]}`);
                });
            } catch (e) {
                error(`Create reminder failed: ${e.message}`);
            }
        });

    reminder
        .command("list <threadId>")
        .description("List reminders in a thread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-n, --count <n>", "Max results", "20")
        .action(async (threadId, opts) => {
            try {
                let result;
                try {
                    result = await getApi().getListReminder({ count: Number(opts.count) }, threadId, Number(opts.type));
                } catch {
                    result = null;
                }
                const items = Array.isArray(result) ? result : [];
                output(items, program.opts().json, () => {
                    if (items.length === 0) {
                        info("No reminders found.");
                        return;
                    }
                    info(`${items.length} reminder(s):`);
                    console.log();
                    for (const r of items) {
                        const id = r.reminderId || r.id || "?";
                        const title = r.params?.title || "?";
                        const time = new Date(r.startTime).toLocaleString();
                        const repeat = REPEAT_LABELS[r.repeat] || "None";
                        const emoji = r.emoji || "";
                        console.log(`  ${emoji} [${id}] ${title}`);
                        console.log(`     Time: ${time} | Repeat: ${repeat}`);
                    }
                });
            } catch (e) {
                error(`List reminders failed: ${e.message}`);
            }
        });

    reminder
        .command("info <reminderId>")
        .description("View reminder details (group reminders only)")
        .action(async (reminderId) => {
            try {
                const result = await getApi().getReminder(reminderId);
                output(result, program.opts().json, () => {
                    const title = result.params?.title || "?";
                    const id = result.id || reminderId;
                    info(`Title: ${result.emoji || ""} ${title}`);
                    info(`Reminder ID: ${id}`);
                    info(`Created: ${new Date(result.createTime).toLocaleString()}`);
                    info(`Time: ${new Date(result.startTime).toLocaleString()}`);
                    info(`Repeat: ${REPEAT_LABELS[result.repeat] || "None"}`);
                    info(`Creator: ${result.creatorId}`);
                    if (result.responseMem) {
                        info(
                            `Responses: ${result.responseMem.acceptMember} accepted, ${result.responseMem.rejectMember} rejected`,
                        );
                    }
                });
            } catch (e) {
                error(`Get reminder failed: ${e.message}`);
            }
        });

    reminder
        .command("responses <reminderId>")
        .description("View who accepted/rejected a reminder (group only)")
        .action(async (reminderId) => {
            try {
                const result = await getApi().getReminderResponses(reminderId);
                output(result, program.opts().json, () => {
                    const accepted = result.acceptMember || [];
                    const rejected = result.rejectMember || [];
                    info(`Accepted (${accepted.length}):`);
                    accepted.forEach((uid) => console.log(`  ✓ ${uid}`));
                    info(`Rejected (${rejected.length}):`);
                    rejected.forEach((uid) => console.log(`  ✗ ${uid}`));
                });
            } catch (e) {
                error(`Get responses failed: ${e.message}`);
            }
        });

    reminder
        .command("edit <reminderId> <threadId> <title>")
        .description("Edit a reminder")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--time <datetime>", 'New time: "YYYY-MM-DD HH:mm"')
        .option("--emoji <emoji>", "New emoji icon")
        .option("--repeat <mode>", "Repeat: none, daily, weekly, monthly")
        .action(async (reminderId, threadId, title, opts) => {
            try {
                const editOpts = { title, topicId: reminderId };
                if (opts.emoji) editOpts.emoji = opts.emoji;
                if (opts.time) {
                    const ts = parseTime(opts.time);
                    if (!ts) {
                        error(`Invalid time format: "${opts.time}". Use "YYYY-MM-DD HH:mm".`);
                        return;
                    }
                    editOpts.startTime = ts;
                }
                if (opts.repeat) {
                    const mode = REPEAT_MODES[opts.repeat];
                    if (mode === undefined) {
                        error(`Invalid repeat mode: "${opts.repeat}". Valid: none, daily, weekly, monthly`);
                        return;
                    }
                    editOpts.repeat = mode;
                }
                const result = await getApi().editReminder(editOpts, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Reminder ${reminderId} updated`));
            } catch (e) {
                error(`Edit reminder failed: ${e.message}`);
            }
        });

    reminder
        .command("remove <reminderId> <threadId>")
        .description("Remove a reminder")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (reminderId, threadId, opts) => {
            try {
                const result = await getApi().removeReminder(reminderId, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Reminder ${reminderId} removed`));
            } catch (e) {
                error(`Remove reminder failed: ${e.message}`);
            }
        });
}
