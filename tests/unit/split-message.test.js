/**
 * Splitting a long message the way Zalo Web does (src/utils/split-message.js).
 *
 * Zalo refuses an oversized message instead of cutting it (measured live: plain text past 3000 UTF-16 units is a
 * 114, a styled message past roughly 3.1 KB of text plus style JSON is a 112), and Chinese or long bulleted answers
 * reach that early. The Web client splits at 3000 bytes of text plus styles JSON, at a newline when it can.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { markdownToZalo } from "../../src/utils/markdown.js";
import { MESSAGE_BYTE_LIMIT, sendParts, splitMessage } from "../../src/utils/split-message.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const bytes = (s) => Buffer.byteLength(s, "utf8");
const cost = (p) => bytes(p.text) + (p.styles.length > 0 ? bytes(JSON.stringify(p.styles)) : 0);
const squash = (s) => s.replace(/\s+/g, "");
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("a message that fits", () => {
    it("comes back untouched, the same text with nothing trimmed", () => {
        const text = "  hello 😀\n\n";
        const parts = splitMessage({ text });
        assert.equal(parts.length, 1);
        assert.equal(parts[0].text, text);
    });

    it("is not split at 3000 bytes exactly, and is at 3001", () => {
        assert.equal(splitMessage({ text: "a".repeat(MESSAGE_BYTE_LIMIT) }).length, 1);
        assert.equal(splitMessage({ text: "a".repeat(MESSAGE_BYTE_LIMIT + 1) }).length, 2);
    });
});

describe("what makes a message too big", () => {
    it("counts bytes, not characters: 1200 Chinese characters are 3600 bytes", () => {
        const parts = splitMessage({ text: "这".repeat(1200) });
        assert.ok(parts.length >= 2);
        for (const p of parts) assert.ok(cost(p) <= MESSAGE_BYTE_LIMIT);
    });

    it("counts the style list too: a short text with ninety bullets is too big", () => {
        const md = markdownToZalo(Array.from({ length: 90 }, (_, i) => `- item ${i}`).join("\n"));
        assert.ok(cost(md) > MESSAGE_BYTE_LIMIT, "the fixture is over the budget only because of its styles");
        assert.ok(bytes(md.text) < MESSAGE_BYTE_LIMIT);
        const parts = splitMessage(md);
        assert.ok(parts.length >= 2);
        for (const p of parts) assert.ok(cost(p) <= MESSAGE_BYTE_LIMIT, `part costs ${cost(p)}`);
    });
});

describe("where it cuts", () => {
    it("at a newline when there is one in the last two thirds", () => {
        const para = (n) => words(n);
        const text = [para(300), para(300), para(300), para(300)].join("\n\n");
        const parts = splitMessage({ text });
        assert.ok(parts.length >= 2);
        // A part ends at a paragraph end, never in the middle of a word.
        for (const p of parts) assert.match(p.text, /word\d+$/);
        assert.equal(squash(parts.map((p) => p.text).join("")), squash(text));
    });

    it("at a sentence end, then a space, when there is no newline", () => {
        const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
        const parts = splitMessage({ text });
        assert.ok(parts.length >= 2);
        for (const p of parts) assert.match(p.text, /here\.$/);
    });

    it("at Chinese punctuation, which Web's ASCII-only list would miss", () => {
        const text = "这是一个测试的句子，用来检查切分。".repeat(300);
        const parts = splitMessage({ text });
        assert.ok(parts.length >= 2);
        for (const p of parts.slice(0, -1)) assert.match(p.text, /[。，]$/);
        for (const p of parts) assert.ok(cost(p) <= MESSAGE_BYTE_LIMIT);
    });

    it("blind, but inside the budget, when the text has no break at all", () => {
        const parts = splitMessage({ text: "x".repeat(9000) });
        assert.equal(parts.length, 3);
        assert.equal(parts.map((p) => p.text).join(""), "x".repeat(9000));
    });

    it("never inside an emoji", () => {
        const text = "😀".repeat(2500); // 10000 bytes, every cut candidate lands inside a pair
        const parts = splitMessage({ text });
        assert.ok(parts.length >= 4);
        for (const p of parts) {
            assert.equal(p.text, [...p.text].join(""), "no lone surrogate");
            assert.ok(cost(p) <= MESSAGE_BYTE_LIMIT);
        }
        assert.equal(parts.map((p) => p.text).join(""), text);
    });

    it("drops the whitespace at a cut, as Web trims its parts", () => {
        const parts = splitMessage({ text: `${words(400)}\n\n\n${words(400)}` });
        for (const p of parts) assert.equal(p.text, p.text.trim());
    });
});

describe("styles and mentions across the cut", () => {
    it("re-bases every style to its own part, and a list line keeps its whole line", () => {
        const md = markdownToZalo(Array.from({ length: 200 }, (_, i) => `- **bold ${i}** and more text`).join("\n"));
        const parts = splitMessage(md);
        assert.ok(parts.length >= 2);
        let lists = 0;
        for (const p of parts) {
            for (const s of p.styles) {
                assert.ok(s.start >= 0 && s.len > 0 && s.start + s.len <= p.text.length, "range inside its own text");
                if (s.st === "lst_1") {
                    lists++;
                    const line = p.text.slice(s.start, s.start + s.len);
                    assert.match(line, /^bold \d+ and more text$/, "the list range covers exactly one line");
                }
            }
        }
        assert.equal(lists, 200, "no list line was lost or cut");
    });

    it("clips a range that spans a cut into both parts", () => {
        const text = "a".repeat(5000);
        const parts = splitMessage({ text, styles: [{ start: 100, len: 4000, st: "b" }] });
        assert.equal(parts.length, 2);
        assert.deepEqual(parts[0].styles, [{ start: 100, len: parts[0].text.length - 100, st: "b" }]);
        const second = parts[1].styles[0];
        assert.equal(second.start, 0);
        assert.equal(parts[0].text.length + second.len, 4100);
    });

    it("never cuts a mention: it moves before it, and re-bases the offsets", () => {
        const tag = "@Trần Bích Ngọc";
        const text = `${"a".repeat(2990)}${tag} ${"b".repeat(2000)}`;
        const mentions = [{ pos: 2990, len: tag.length, uid: "123" }];
        const parts = splitMessage({ text, mentions });
        const owner = parts.find((p) => p.mentions.length > 0);
        assert.ok(owner, "the mention survives");
        const m = owner.mentions[0];
        assert.equal(owner.text.slice(m.pos, m.pos + m.len), tag);
        assert.equal(parts.flatMap((p) => p.mentions).length, 1, "and only once");
    });
});

describe("invariants over random text", () => {
    it("every part fits, no range leaves its text, and the words survive in order", () => {
        const pieces = [
            "**重点**",
            "- 项目\n",
            "word ",
            "😀",
            "\n\n",
            "你好，",
            "世界。",
            "x",
            " ",
            "Việt Nam ",
            "1. một\n",
            "snake_case ",
        ];
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let round = 0; round < 60; round++) {
            let src = "";
            const n = 200 + Math.floor(rnd() * 1500);
            for (let i = 0; i < n; i++) src += pieces[Math.floor(rnd() * pieces.length)];
            const md = markdownToZalo(src);
            const parts = splitMessage(md);
            for (const p of parts) {
                assert.ok(cost(p) <= MESSAGE_BYTE_LIMIT, `round ${round}: part costs ${cost(p)}`);
                assert.equal(p.text, [...p.text].join(""), "no lone surrogate");
                for (const s of p.styles) assert.ok(s.start >= 0 && s.len > 0 && s.start + s.len <= p.text.length);
            }
            assert.equal(squash(parts.map((p) => p.text).join("")), squash(md.text), `round ${round}: text lost`);
        }
    });
});

describe("sendParts", () => {
    const noWait = { sleep: async () => {} };

    it("sends in order, pauses between parts and not before the first, and returns each answer", async () => {
        const order = [];
        const waits = [];
        const answers = await sendParts(
            [{ text: "a" }, { text: "b" }, { text: "c" }],
            async (p, i) => {
                order.push(p.text);
                return { n: i };
            },
            { gapMs: 300, sleep: async (ms) => waits.push(ms) },
        );
        assert.deepEqual(order, ["a", "b", "c"]);
        assert.deepEqual(waits, [300, 300]);
        assert.deepEqual(answers, [{ n: 0 }, { n: 1 }, { n: 2 }]);
    });

    it("a first part that fails throws Zalo's own error, nothing delivered to report", async () => {
        const boom = Object.assign(new Error("Tham số không hợp lệ"), { code: 114 });
        await assert.rejects(
            sendParts([{ text: "a" }, { text: "b" }], async () => Promise.reject(boom), noWait),
            (e) => e === boom,
        );
    });

    it("a later part that fails says how many already went out and keeps the answers", async () => {
        let calls = 0;
        await assert.rejects(
            sendParts(
                [{ text: "a" }, { text: "b" }, { text: "c" }],
                async () => {
                    if (++calls === 3) throw Object.assign(new Error("Lỗi không xác định"), { code: 112 });
                    return { ok: calls };
                },
                noWait,
            ),
            (e) => {
                assert.match(e.message, /part 3 of 3 failed; the 2 earlier part\(s\) were already delivered/);
                assert.match(e.message, /Lỗi không xác định/);
                assert.equal(e.code, 112);
                assert.deepEqual(e.sent, [{ ok: 1 }, { ok: 2 }]);
                return true;
            },
        );
        assert.equal(calls, 3, "stopped at the failure");
    });
});
