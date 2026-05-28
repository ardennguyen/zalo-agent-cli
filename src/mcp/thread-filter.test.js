import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ThreadFilter } from "./thread-filter.js";

/** Helper: create a ThreadFilter with given patterns and keywords */
function makeFilter(watchThreads = ["dm:*", "group:*"], triggerKeywords = []) {
    return new ThreadFilter({ watchThreads, triggerKeywords });
}

describe("ThreadFilter shouldWatch - glob patterns", () => {
    it("dm:* matches any DM thread", () => {
        const f = makeFilter(["dm:*"]);
        assert.equal(f.shouldWatch("user_123", "dm"), true);
        assert.equal(f.shouldWatch("abc", "dm"), true);
    });

    it("group:* matches any group thread", () => {
        const f = makeFilter(["group:*"]);
        assert.equal(f.shouldWatch("support_456", "group"), true);
        assert.equal(f.shouldWatch("anything", "group"), true);
    });

    it("dm:* does not match group threads", () => {
        const f = makeFilter(["dm:*"]);
        assert.equal(f.shouldWatch("some_group", "group"), false);
    });

    it("group:* does not match dm threads", () => {
        const f = makeFilter(["group:*"]);
        assert.equal(f.shouldWatch("some_user", "dm"), false);
    });
});

describe("ThreadFilter shouldWatch - exact match", () => {
    it("exact group pattern matches only that thread id", () => {
        const f = makeFilter(["group:support_123"]);
        assert.equal(f.shouldWatch("support_123", "group"), true);
        assert.equal(f.shouldWatch("support_456", "group"), false);
    });

    it("exact dm pattern matches only that thread id", () => {
        const f = makeFilter(["dm:user_42"]);
        assert.equal(f.shouldWatch("user_42", "dm"), true);
        assert.equal(f.shouldWatch("user_99", "dm"), false);
    });

    it("exact match requires type prefix to align", () => {
        const f = makeFilter(["group:support_123"]);
        // same id but different type should not match
        assert.equal(f.shouldWatch("support_123", "dm"), false);
    });
});

describe("ThreadFilter shouldWatch - catch-all patterns", () => {
    it("* matches any thread regardless of type", () => {
        const f = makeFilter(["*"]);
        assert.equal(f.shouldWatch("user_1", "dm"), true);
        assert.equal(f.shouldWatch("group_1", "group"), true);
    });

    it("*:* matches any thread regardless of type", () => {
        const f = makeFilter(["*:*"]);
        assert.equal(f.shouldWatch("user_1", "dm"), true);
        assert.equal(f.shouldWatch("group_1", "group"), true);
    });
});

describe("ThreadFilter shouldWatch - unmatched patterns", () => {
    it("returns false when no pattern matches", () => {
        const f = makeFilter(["group:specific_only"]);
        assert.equal(f.shouldWatch("other_group", "group"), false);
        assert.equal(f.shouldWatch("any_user", "dm"), false);
    });

    it("empty watchThreads array never matches", () => {
        const f = makeFilter([]);
        assert.equal(f.shouldWatch("x", "dm"), false);
        assert.equal(f.shouldWatch("y", "group"), false);
    });
});

describe("ThreadFilter shouldKeep - system messages dropped", () => {
    const SYSTEM_TYPES = ["system", "join", "leave", "pin", "unpin", "rename"];

    for (const type of SYSTEM_TYPES) {
        it(`drops message with type="${type}"`, () => {
            const f = makeFilter();
            assert.equal(f.shouldKeep({ type, text: "some text" }), false);
        });
    }
});

describe("ThreadFilter shouldKeep - sticker messages dropped", () => {
    it("drops sticker-only messages", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "sticker" }), false);
    });
});

describe("ThreadFilter shouldKeep - short emoji-only messages dropped", () => {
    it("drops single emoji (< 3 chars)", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ text: "👍" }), false);
    });

    it("drops two-char emoji message", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ text: "😂" }), false);
    });

    it("keeps messages with 3+ chars even if emoji", () => {
        const f = makeFilter();
        // Three emojis — length in JS may vary; use text that is clearly >= 3 code units
        assert.equal(f.shouldKeep({ text: "hey" }), true);
    });

    it("drops whitespace-only short message", () => {
        const f = makeFilter();
        // 1-2 spaces are < 3 chars and match /^[\s\p{Emoji}]*$/u
        assert.equal(f.shouldKeep({ text: " " }), false);
    });
});

describe("ThreadFilter shouldKeep - kept messages", () => {
    it("keeps normal text messages", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "text", text: "Hello there!" }), true);
    });

    it("keeps image messages (no text)", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "image" }), true);
    });

    it("keeps file messages", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "file" }), true);
    });

    it("keeps link messages", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "link", text: "https://example.com" }), true);
    });

    it("keeps message with no type field", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ text: "plain message" }), true);
    });
});

describe("ThreadFilter isTrigger", () => {
    it("detects keyword in message text (case-insensitive)", () => {
        const f = makeFilter(["dm:*"], ["@bot"]);
        assert.equal(f.isTrigger({ text: "Hey @BOT help me" }), true);
    });

    it("detects keyword at start of text", () => {
        const f = makeFilter(["dm:*"], ["help"]);
        assert.equal(f.isTrigger({ text: "help me please" }), true);
    });

    it("returns false when keyword not present", () => {
        const f = makeFilter(["dm:*"], ["@bot"]);
        assert.equal(f.isTrigger({ text: "just a normal message" }), false);
    });

    it("returns false when no keywords configured", () => {
        const f = makeFilter(["dm:*"], []);
        assert.equal(f.isTrigger({ text: "@bot trigger me" }), false);
    });

    it("returns false when text is empty string", () => {
        const f = makeFilter(["dm:*"], ["@bot"]);
        assert.equal(f.isTrigger({ text: "" }), false);
    });

    it("returns false when text property is missing", () => {
        const f = makeFilter(["dm:*"], ["@bot"]);
        assert.equal(f.isTrigger({}), false);
    });

    it("matches any of multiple keywords", () => {
        const f = makeFilter(["dm:*"], ["urgent", "help", "broken"]);
        assert.equal(f.isTrigger({ text: "system is broken" }), true);
        assert.equal(f.isTrigger({ text: "need urgent attention" }), true);
        assert.equal(f.isTrigger({ text: "everything is fine" }), false);
    });
});

describe("ThreadFilter edge cases", () => {
    it("shouldKeep handles empty message object", () => {
        const f = makeFilter();
        // No type, no text — should keep (default allow)
        assert.equal(f.shouldKeep({}), true);
    });

    it("shouldKeep handles null text field gracefully", () => {
        const f = makeFilter();
        assert.equal(f.shouldKeep({ type: "text", text: null }), true);
    });

    it("isTrigger handles null text field", () => {
        const f = makeFilter(["dm:*"], ["keyword"]);
        assert.equal(f.isTrigger({ text: null }), false);
    });
});
