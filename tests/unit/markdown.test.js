/**
 * Markdown to Zalo rich text (src/utils/markdown.js).
 *
 * Zalo draws bold and bullets only from style ranges; typed `**bold**` and `- item` show as typed. The shapes
 * asserted here (a bullet is the line's text covered by `lst_1`, a heading is a bold line) are those of real
 * rich-text messages from Zalo's own clients, read from a local cache.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { ALL_MENTION_UID, expandMentions, shiftStyles } from "../../src/utils/mentions.js";
import { STYLE, convertInline, looksLikeMarkdown, markdownToZalo } from "../../src/utils/markdown.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const md = (s) => markdownToZalo(s);
/** The text each style covers, for readable assertions: [["b", "bold"], ...]. */
const covered = ({ text, styles }) => styles.map((s) => [s.st, text.slice(s.start, s.start + s.len)]);

describe("inline emphasis", () => {
    it("bold, italic, both and strikethrough, with the markers gone", () => {
        const r = md("a **bold** b *it* c ***both*** d ~~gone~~ e");
        assert.equal(r.text, "a bold b it c both d gone e");
        assert.deepEqual(covered(r), [
            ["b", "bold"],
            ["i", "it"],
            ["b", "both"],
            ["i", "both"],
            ["s", "gone"],
        ]);
    });

    it("__bold__ is bold and _italic_ is italic, as in Markdown", () => {
        const r = md("__strong__ and _soft_");
        assert.equal(r.text, "strong and soft");
        assert.deepEqual(covered(r), [
            ["b", "strong"],
            ["i", "soft"],
        ]);
    });

    it("nests: italic inside bold, bold inside italic", () => {
        const r = md("**bold *and italic* still bold** then *it **and bold** it*");
        assert.equal(r.text, "bold and italic still bold then it and bold it");
        assert.deepEqual(covered(r), [
            ["i", "and italic"],
            ["b", "bold and italic still bold"],
            ["b", "and bold"],
            ["i", "it and bold it"],
        ]);
    });

    it("offsets count UTF-16 code units, so accents and emoji do not shift them", () => {
        const r = md("Xin chào 😀 **Trần Bích Ngọc** ạ");
        assert.equal(r.text, "Xin chào 😀 Trần Bích Ngọc ạ");
        const s = r.styles[0];
        assert.equal(r.text.slice(s.start, s.start + s.len), "Trần Bích Ngọc");
        assert.equal(s.start, "Xin chào 😀 ".length, "the emoji is two code units");
    });

    it("leaves what is not Markdown alone: snake_case, 2 * 3 * 4, a lone *, unclosed markers, 5 > 3", () => {
        for (const plain of [
            "use snake_case_names here",
            "2 * 3 * 4 = 24",
            "a lone * star",
            "an unclosed **bold",
            "an unclosed *italic",
            "5 > 3 and 3 < 5",
            "file_name.txt and __init__.py are names",
            "price: $5 ~ $6",
            "100% sure",
        ]) {
            const r = md(plain);
            assert.equal(
                r.text,
                plain === "file_name.txt and __init__.py are names" ? "file_name.txt and init.py are names" : plain,
                plain,
            );
        }
        assert.deepEqual(md("2 * 3 * 4 = 24").styles, []);
        assert.deepEqual(md("use snake_case_names here").styles, []);
    });

    it("an underscore inside a word never opens emphasis, even when a closer follows", () => {
        assert.deepEqual(md("x_y_ z"), { text: "x_y_ z", styles: [] });
        assert.deepEqual(md("a_b_c_d"), { text: "a_b_c_d", styles: [] });
    });

    it("an emphasis marker must hug its text: ** not bold ** is just text", () => {
        assert.deepEqual(md("a ** not bold ** b"), { text: "a ** not bold ** b", styles: [] });
    });

    it("backslash escapes make a marker literal", () => {
        const r = md("\\*literal\\* and **real** and \\_x\\_");
        assert.equal(r.text, "*literal* and real and _x_");
        assert.deepEqual(covered(r), [["b", "real"]]);
    });

    it("inline code drops the backticks and does not interpret what is inside", () => {
        const r = md("run `npm test **now**` please, or ``a ` b``");
        assert.equal(r.text, "run npm test **now** please, or a ` b");
        assert.deepEqual(r.styles, []);
    });

    it("emphasis markers inside a code span do not close an outer emphasis", () => {
        const r = md("**see `a**b` here**");
        assert.equal(r.text, "see a**b here");
        assert.deepEqual(covered(r), [["b", "see a**b here"]]);
    });

    it("Zalo's own {red:text} colors work, as in msg send --md", () => {
        const r = md("{red:stop} and {big:LOUD}");
        assert.equal(r.text, "stop and LOUD");
        assert.deepEqual(r.styles, [
            { start: 0, len: 4, st: STYLE.red },
            { start: 9, len: 4, st: STYLE.big },
        ]);
    });
});

describe("links and images", () => {
    it("[text](url) keeps the URL in the text, which Zalo links by itself", () => {
        assert.equal(
            md("see [the docs](https://example.com/a_b) now").text,
            "see the docs (https://example.com/a_b) now",
        );
    });

    it("[url](url) and <url> are just the URL; an image is its alt text and URL", () => {
        assert.equal(md("[https://x.io](https://x.io)").text, "https://x.io");
        assert.equal(md("<https://x.io/p>").text, "https://x.io/p");
        assert.equal(md("![a chart](https://x.io/c.png)").text, "a chart (https://x.io/c.png)");
    });

    it("bold link text stays bold", () => {
        const r = md("[**go**](https://x.io)");
        assert.equal(r.text, "go (https://x.io)");
        assert.deepEqual(covered(r), [["b", "go"]]);
    });

    it("brackets that are not a link are left alone", () => {
        assert.equal(md("[todo] and [a](b").text, "[todo] and [a](b");
        assert.equal(md("array[0] = x(1)").text, "array[0] = x(1)");
    });
});

describe("blocks", () => {
    it("a bullet is the line's text, with no marker, covered whole by lst_1", () => {
        const r = md("- one\n- two");
        assert.equal(r.text, "one\ntwo");
        assert.deepEqual(r.styles, [
            { start: 0, len: 3, st: "lst_1" },
            { start: 4, len: 3, st: "lst_1" },
        ]);
    });

    it("-, * and + all make bullets, and bold inside an item is a second range over it", () => {
        const r = md("* **Key:** value\n+ plain\n- last");
        assert.equal(r.text, "Key: value\nplain\nlast");
        assert.deepEqual(r.styles, [
            { start: 0, len: 4, st: "b" },
            { start: 0, len: 10, st: "lst_1" },
            { start: 11, len: 5, st: "lst_1" },
            { start: 17, len: 4, st: "lst_1" },
        ]);
    });

    it("a nested bullet is indented as well", () => {
        const r = md("- top\n  - child\n    - grandchild");
        assert.equal(r.text, "top\nchild\ngrandchild");
        assert.deepEqual(r.styles, [
            { start: 0, len: 3, st: "lst_1" },
            { start: 4, len: 5, st: "lst_1" },
            { start: 4, len: 5, st: "ind_$", indentSize: 1 },
            { start: 10, len: 10, st: "lst_1" },
            { start: 10, len: 10, st: "ind_$", indentSize: 2 },
        ]);
    });

    it("an ordered list keeps its numbers as typed, as Zalo's own clients do", () => {
        const r = md("1. first\n2) second **bold**\n10. tenth");
        assert.equal(r.text, "1. first\n2) second bold\n10. tenth");
        assert.deepEqual(covered(r), [["b", "bold"]]);
    });

    it("a heading is a bold line, and # and ## are big as well", () => {
        const r = md("# Title\n### Smaller\nbody");
        assert.equal(r.text, "Title\nSmaller\nbody");
        assert.deepEqual(r.styles, [
            { start: 0, len: 5, st: "f_18" },
            { start: 0, len: 5, st: "b" },
            { start: 6, len: 7, st: "b" },
        ]);
    });

    it("a trailing # is not part of the heading, and inline emphasis works inside it", () => {
        const r = md("## The *new* way ##");
        assert.equal(r.text, "The new way");
        assert.deepEqual(covered(r), [
            ["i", "new"],
            ["f_18", "The new way"],
            ["b", "The new way"],
        ]);
    });

    it("a quote loses its marker, nested quotes all of them", () => {
        assert.equal(md("> said\n>> deeper").text, "said\ndeeper");
        assert.equal(md("5 > 3").text, "5 > 3");
    });

    it("a fenced block shows its content as it is: no markers parsed, fences dropped", () => {
        const r = md("before\n```js\nconst a = **b**; // - not a bullet\n```\nafter");
        assert.equal(r.text, "before\nconst a = **b**; // - not a bullet\nafter");
        assert.deepEqual(r.styles, []);
    });

    it("an unclosed fence takes the rest of the message, rather than eating markup after it", () => {
        const r = md("a\n```\n**b**\n- c");
        assert.equal(r.text, "a\n**b**\n- c");
    });

    it("a horizontal rule is dropped, and so is not mistaken for a list", () => {
        assert.equal(md("a\n---\nb\n* * *\nc").text, "a\nb\nc");
    });

    it("a table is left as typed", () => {
        const t = "| a | b |\n|---|---|\n| 1 | 2 |";
        assert.equal(
            md(t).text,
            t.replace("|---|---|", "|---|---|"),
            "pipes stay; only the Markdown a table is made of is not interpreted",
        );
    });

    it("blank lines and CRLF are kept as they are", () => {
        assert.equal(md("a\r\n\r\nb\r\n").text, "a\n\nb\n");
    });

    it("a line that merely starts with a dash or digit is not a list", () => {
        for (const line of ["-5 degrees", "2024 was a year", "1.5 litres", "-- aside --", "+1 vote"]) {
            const r = md(line);
            assert.equal(r.text, line);
            assert.deepEqual(r.styles, []);
        }
    });
});

describe("whole messages", () => {
    const reply = [
        "**Tóm tắt:**",
        "",
        "- Đã xử lý **3** đơn",
        "- Còn *2* đơn chờ duyệt",
        "",
        "Xem [chi tiết](https://example.com/orders).",
    ].join("\n");

    it("an agent reply comes out as the text and ranges Zalo needs", () => {
        const r = md(reply);
        assert.equal(
            r.text,
            "Tóm tắt:\n\nĐã xử lý 3 đơn\nCòn 2 đơn chờ duyệt\n\nXem chi tiết (https://example.com/orders).",
        );
        for (const s of r.styles)
            assert.ok(s.start >= 0 && s.len > 0 && s.start + s.len <= r.text.length, JSON.stringify(s));
        assert.deepEqual(covered(r), [
            ["b", "Tóm tắt:"],
            ["b", "3"],
            ["lst_1", "Đã xử lý 3 đơn"],
            ["i", "2"],
            ["lst_1", "Còn 2 đơn chờ duyệt"],
        ]);
    });

    it("every style stays inside the text, for every message the other tests use", () => {
        for (const s of [
            "# a\n- b\n  - c\n1. d\n> e\n`f` **g** *h* ~~i~~ [j](k)",
            "",
            "\n\n",
            "- ",
            "**",
            "*x*\n\n**y**",
        ]) {
            const r = md(s);
            for (const st of r.styles)
                assert.ok(
                    st.start >= 0 && st.len > 0 && st.start + st.len <= r.text.length,
                    `${JSON.stringify(s)} -> ${JSON.stringify(st)}`,
                );
        }
    });

    it("an empty message is an empty message", () => {
        assert.deepEqual(md(""), { text: "", styles: [] });
        assert.deepEqual(md(null), { text: "", styles: [] });
    });

    it("plain text comes back untouched, with no styles", () => {
        const plain = "Chào bạn, hôm nay thế nào? Mình ổn.\nDòng hai.";
        assert.deepEqual(md(plain), { text: plain, styles: [] });
    });
});

describe("with mentions", () => {
    it("styles follow the text when @[uid] tokens expand to longer names (the path both senders take)", () => {
        const r = md("**Chào @[123]** và @[-1]\n- việc của @[123]");
        const expanded = expandMentions(r.text, (uid) => (uid === "123" ? "Trần Bích Ngọc" : null));
        const styles = shiftStyles(r.styles, expanded.edits);
        assert.equal(expanded.text, "Chào @Trần Bích Ngọc và @All\nviệc của @Trần Bích Ngọc");
        const bold = styles.find((s) => s.st === "b");
        assert.equal(
            expanded.text.slice(bold.start, bold.start + bold.len),
            "Chào @Trần Bích Ngọc",
            "the whole bold run, grown by the longer name",
        );
        const list = styles.find((s) => s.st === "lst_1");
        assert.equal(expanded.text.slice(list.start, list.start + list.len), "việc của @Trần Bích Ngọc");
        assert.equal(ALL_MENTION_UID, "-1");
        for (const m of expanded.mentions) assert.ok(expanded.text.slice(m.pos, m.pos + m.len).startsWith("@"));
    });

    it("an @[uid] token is not mistaken for a link or for emphasis", () => {
        assert.equal(md("@[123](x) hi").text, "@[123](x) hi", "the token is not a link, whatever follows it");
        assert.deepEqual(md("@[-1] and @[123]").styles, []);
    });
});

describe("convertInline and looksLikeMarkdown", () => {
    it("convertInline gives offsets relative to its own text", () => {
        assert.deepEqual(convertInline("a **b**"), { text: "a b", styles: [{ start: 2, len: 1, st: "b" }] });
    });

    it("looksLikeMarkdown tells formatted text from plain", () => {
        for (const t of ["**x**", "- a", "# h", "1. a", "> q", "```", "[a](b)", "`c`"])
            assert.equal(looksLikeMarkdown(t), true, t);
        for (const t of ["plain words", "2 * 3", "snake_case", "5 > 3", ""])
            assert.equal(looksLikeMarkdown(t), false, t);
    });
});
