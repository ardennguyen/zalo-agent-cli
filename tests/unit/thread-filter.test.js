/**
 * ThreadFilter (src/mcp/thread-filter.js): which threads the MCP server watches, which messages it keeps and which
 * ones trigger it. Each rule is one table: every row is checked and every failing row is named.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ThreadFilter } from "../../src/mcp/thread-filter.js";
import { checkTableSync } from "../helpers/table.js";

/** Helper: create a ThreadFilter with given patterns and keywords */
function makeFilter(watchThreads = ["dm:*", "group:*"], triggerKeywords = []) {
    return new ThreadFilter({ watchThreads, triggerKeywords });
}

describe("ThreadFilter shouldWatch", () => {
    it("matches glob, exact and catch-all patterns, by type, and nothing else", () => {
        // [why, watchThreads, threadId, type, expected]
        const ROWS = [
            ["dm:* matches any DM thread", ["dm:*"], "user_123", "dm", true],
            ["dm:* matches any DM thread", ["dm:*"], "abc", "dm", true],
            ["group:* matches any group thread", ["group:*"], "support_456", "group", true],
            ["group:* matches any group thread", ["group:*"], "anything", "group", true],
            ["dm:* does not match group threads", ["dm:*"], "some_group", "group", false],
            ["group:* does not match dm threads", ["group:*"], "some_user", "dm", false],
            ["exact group pattern matches its thread", ["group:support_123"], "support_123", "group", true],
            ["exact group pattern matches only its thread", ["group:support_123"], "support_456", "group", false],
            ["exact dm pattern matches its thread", ["dm:user_42"], "user_42", "dm", true],
            ["exact dm pattern matches only its thread", ["dm:user_42"], "user_99", "dm", false],
            ["exact match requires the type prefix to align", ["group:support_123"], "support_123", "dm", false],
            ["* matches a DM", ["*"], "user_1", "dm", true],
            ["* matches a group", ["*"], "group_1", "group", true],
            ["*:* matches a DM", ["*:*"], "user_1", "dm", true],
            ["*:* matches a group", ["*:*"], "group_1", "group", true],
            ["no pattern matches another group", ["group:specific_only"], "other_group", "group", false],
            ["no pattern matches a DM", ["group:specific_only"], "any_user", "dm", false],
            ["an empty watch list never matches a DM", [], "x", "dm", false],
            ["an empty watch list never matches a group", [], "y", "group", false],
        ];
        checkTableSync(
            ROWS,
            ([why, watch, id, type]) => `${why}: ${JSON.stringify(watch)} ${type}:${id}`,
            ([, watch, id, type, expected]) => assert.equal(makeFilter(watch).shouldWatch(id, type), expected),
        );
    });
});

describe("ThreadFilter shouldKeep", () => {
    it("drops system messages, stickers and short emoji or whitespace, and keeps everything else", () => {
        // [why, message, expected]
        const ROWS = [
            ...["system", "join", "leave", "pin", "unpin", "rename"].map((type) => [
                `drops a ${type} message`,
                { type, text: "some text" },
                false,
            ]),
            ["drops a sticker-only message", { type: "sticker" }, false],
            ["drops a single emoji (< 3 chars)", { text: "👍" }, false],
            ["drops a two-char emoji message", { text: "😂" }, false],
            ["keeps a message of 3+ chars", { text: "hey" }, true],
            // 1-2 spaces are < 3 chars and match /^[\s\p{Emoji}]*$/u
            ["drops a whitespace-only short message", { text: " " }, false],
            ["keeps a normal text message", { type: "text", text: "Hello there!" }, true],
            ["keeps an image message (no text)", { type: "image" }, true],
            ["keeps a file message", { type: "file" }, true],
            ["keeps a link message", { type: "link", text: "https://example.com" }, true],
            ["keeps a message with no type field", { text: "plain message" }, true],
            // No type, no text: default allow.
            ["keeps an empty message object", {}, true],
            ["keeps a null text field", { type: "text", text: null }, true],
        ];
        checkTableSync(
            ROWS,
            ([why]) => why,
            ([, msg, expected]) => assert.equal(makeFilter().shouldKeep(msg), expected),
        );
    });
});

describe("ThreadFilter isTrigger", () => {
    it("fires on any configured keyword, case-insensitively, and never without text or keywords", () => {
        // [why, keywords, message, expected]
        const ROWS = [
            ["a keyword in the text, any case", ["@bot"], { text: "Hey @BOT help me" }, true],
            ["a keyword at the start of the text", ["help"], { text: "help me please" }, true],
            ["no keyword present", ["@bot"], { text: "just a normal message" }, false],
            ["no keywords configured", [], { text: "@bot trigger me" }, false],
            ["an empty text", ["@bot"], { text: "" }, false],
            ["no text property", ["@bot"], {}, false],
            ["a null text", ["keyword"], { text: null }, false],
            ["one of several keywords", ["urgent", "help", "broken"], { text: "system is broken" }, true],
            ["another of several keywords", ["urgent", "help", "broken"], { text: "need urgent attention" }, true],
            ["none of several keywords", ["urgent", "help", "broken"], { text: "everything is fine" }, false],
        ];
        checkTableSync(
            ROWS,
            ([why]) => why,
            ([, keywords, msg, expected]) => assert.equal(makeFilter(["dm:*"], keywords).isTrigger(msg), expected),
        );
    });
});
