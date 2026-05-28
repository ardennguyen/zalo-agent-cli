/**
 * Reminder commands — create, list, info, edit, remove reminders in users/groups.
 */

import { getApi } from "../core/zalo-client.js";
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
        .description("Create a reminder")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--time <datetime>", 'Reminder time: "YYYY-MM-DD HH:mm" (default: now)')
        .option("--emoji <emoji>", "Emoji icon", "⏰")
        .option("--repeat <mode>", "Repeat: none, daily, weekly, monthly", "none")
        .action(async (threadId, title, opts) => {
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
                const result = await getApi().createReminder(
                    { title, emoji: opts.emoji, startTime, repeat: repeatMode },
                    threadId,
                    Number(opts.type),
                );
                output(result, program.opts().json, () => {
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
