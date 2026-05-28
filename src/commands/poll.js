/**
 * Poll commands — create, view, vote, add options, lock, and share polls in groups.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, info, output } from "../utils/output.js";

export function registerPollCommands(program) {
    const poll = program.command("poll").description("Create and manage polls in groups");

    poll.command("create <groupId> <question> <options...>")
        .description("Create a poll in a group (options separated by spaces, quote multi-word options)")
        .option("--multi", "Allow multiple choices")
        .option("--add-options", "Allow members to add new options")
        .option("--anonymous", "Hide voter identities")
        .option("--hide-preview", "Hide results until voted")
        .option("--expire <minutes>", "Auto-close after N minutes", parseInt)
        .action(async (groupId, question, options, opts) => {
            try {
                if (options.length < 2) {
                    error("A poll requires at least 2 options.");
                    return;
                }
                const expiredTime = opts.expire ? opts.expire * 60 * 1000 : 0;
                const result = await getApi().createPoll(
                    {
                        question,
                        options,
                        allowMultiChoices: !!opts.multi,
                        allowAddNewOption: !!opts.addOptions,
                        isAnonymous: !!opts.anonymous,
                        hideVotePreview: !!opts.hidePreview,
                        expiredTime,
                    },
                    groupId,
                );
                output(result, program.opts().json, () => {
                    success(`Poll created: "${question}"`);
                    info(`Poll ID: ${result.poll_id}`);
                    if (result.options) {
                        result.options.forEach((o) => console.log(`  [${o.option_id}] ${o.content}`));
                    }
                });
            } catch (e) {
                error(`Create poll failed: ${e.message}`);
            }
        });

    poll.command("info <pollId>")
        .description("View poll details and results")
        .action(async (pollId) => {
            try {
                const result = await getApi().getPollDetail(Number(pollId));
                output(result, program.opts().json, () => {
                    info(`Question: ${result.question}`);
                    info(`Poll ID: ${result.poll_id}`);
                    info(`Status: ${result.closed ? "Closed" : "Open"}`);
                    info(`Total votes: ${result.num_vote}`);
                    info(`Multi-choice: ${result.allow_multi_choices ? "Yes" : "No"}`);
                    info(`Anonymous: ${result.is_anonymous ? "Yes" : "No"}`);
                    if (result.expired_time > 0) {
                        const expDate = new Date(result.expired_time);
                        info(`Expires: ${expDate.toLocaleString()}`);
                    }
                    console.log();
                    console.log("  ID    VOTES  OPTION");
                    console.log("  " + "-".repeat(50));
                    for (const o of result.options || []) {
                        const voted = o.voted ? " ✓" : "";
                        console.log(
                            `  ${String(o.option_id).padEnd(6)} ${String(o.votes).padEnd(6)} ${o.content}${voted}`,
                        );
                    }
                });
            } catch (e) {
                error(`Get poll failed: ${e.message}`);
            }
        });

    poll.command("vote <pollId> <optionIds...>")
        .description("Vote on a poll (use option IDs from 'poll info')")
        .action(async (pollId, optionIds) => {
            try {
                const ids = optionIds.map(Number);
                const result = await getApi().votePoll(Number(pollId), ids);
                output(result, program.opts().json, () => {
                    success(`Voted on poll ${pollId}`);
                    if (result.options) {
                        for (const o of result.options) {
                            const voted = o.voted ? " ✓" : "";
                            console.log(`  [${o.option_id}] ${o.content}: ${o.votes} vote(s)${voted}`);
                        }
                    }
                });
            } catch (e) {
                error(`Vote failed: ${e.message}`);
            }
        });

    poll.command("unvote <pollId>")
        .description("Remove your vote from a poll")
        .action(async (pollId) => {
            try {
                const result = await getApi().votePoll(Number(pollId), []);
                output(result, program.opts().json, () => success(`Removed vote from poll ${pollId}`));
            } catch (e) {
                error(`Unvote failed: ${e.message}`);
            }
        });

    poll.command("add-option <pollId> <options...>")
        .description("Add new options to an existing poll")
        .option("--vote", "Also vote for the new options")
        .action(async (pollId, options, opts) => {
            try {
                const newOptions = options.map((content) => ({
                    content,
                    voted: !!opts.vote,
                }));
                const result = await getApi().addPollOptions({
                    pollId: Number(pollId),
                    options: newOptions,
                    votedOptionIds: [],
                });
                output(result, program.opts().json, () => {
                    success(`Added ${options.length} option(s) to poll ${pollId}`);
                    if (result.options) {
                        for (const o of result.options) {
                            console.log(`  [${o.option_id}] ${o.content}: ${o.votes} vote(s)`);
                        }
                    }
                });
            } catch (e) {
                error(`Add option failed: ${e.message}`);
            }
        });

    poll.command("lock <pollId>")
        .description("Lock/close a poll (no more votes)")
        .action(async (pollId) => {
            try {
                const result = await getApi().lockPoll(Number(pollId));
                output(result, program.opts().json, () => success(`Poll ${pollId} locked`));
            } catch (e) {
                error(`Lock poll failed: ${e.message}`);
            }
        });

    poll.command("share <pollId>")
        .description("Share a poll")
        .action(async (pollId) => {
            try {
                const result = await getApi().sharePoll(Number(pollId));
                output(result, program.opts().json, () => success(`Poll ${pollId} shared`));
            } catch (e) {
                error(`Share poll failed: ${e.message}`);
            }
        });
}
