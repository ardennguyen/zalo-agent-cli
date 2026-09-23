/**
 * Mobile sync and live listener must describe the same message the same way.
 *
 * Two capture paths write the same table: the phone's Sync2 protobuf
 * (numeric msgType, content in `content`, detail in `meta.attachsList`) and the
 * live socket (string msgType, detail inside `content`). They are meant to be
 * interchangeable — `msg history` does not tell you which one stored a row, and
 * a query like `WHERE type = 'location'` has to match either.
 *
 * They were not interchangeable. An audit of the real cache found a shared
 * location stored as `location` live and `type_18` from sync; a sticker stored
 * with one attachment and its catalogue id from sync and zero attachments live;
 * and system events (reminders, polls) rendering as a real sentence from sync
 * and as a bare `[event]` live. Each is a silent, per-type divergence that only
 * shows up when you compare the two paths directly — which is what this does.
 *
 * Every case below feeds the SAME logical message to both classifiers in the
 * two encodings Zalo actually uses, and asserts the four fields that reach the
 * row: type, text, hasAttachment, and the attachment count.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyLiveMessage, classifySyncMessage } from "../../src/core/sync-v2/message-types.js";

const J = (o) => JSON.stringify(o);

/**
 * One logical message in both wire encodings.
 * @type {Array<{name: string, live: object, sync: object, expect: string}>}
 */
const CASES = [
    {
        name: "plain text",
        expect: "text",
        live: { msgType: "webchat", content: "hello" },
        sync: { msgType: 0, content: "hello", meta: {} },
    },
    {
        name: "photo",
        expect: "photo",
        live: { msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a.jpg", title: "a.jpg" } },
        sync: {
            msgType: 3,
            content: "",
            meta: { attachsList: [{ href: "https://photo-stal-3.zdn.vn/a.jpg", title: "a.jpg" }] },
        },
    },
    {
        name: "video",
        expect: "video",
        live: { msgType: "chat.video.msg", content: { href: "https://video-stal-7.zdn.vn/v.mp4", title: "v.mp4" } },
        sync: {
            msgType: 19,
            content: "",
            meta: { attachsList: [{ href: "https://video-stal-7.zdn.vn/v.mp4", title: "v.mp4" }] },
        },
    },
    {
        name: "file",
        expect: "file",
        live: { msgType: "share.file", content: { href: "https://file-stal-2.zdn.vn/d.pdf", title: "d.pdf" } },
        sync: {
            msgType: 22,
            content: "",
            meta: { attachsList: [{ href: "https://file-stal-2.zdn.vn/d.pdf", title: "d.pdf" }] },
        },
    },
    {
        name: "gif",
        expect: "gif",
        live: { msgType: "chat.gif", content: { href: "https://zalo-gif.zadn.vn/g.gif", title: "g.gif" } },
        sync: {
            msgType: 23,
            content: "",
            meta: { attachsList: [{ href: "https://zalo-gif.zadn.vn/g.gif", title: "g.gif" }] },
        },
    },
    {
        name: "link preview",
        expect: "link",
        live: { msgType: "chat.recommended", content: { href: "https://e.com/x", title: "T", description: "D" } },
        sync: {
            msgType: 12,
            content: "",
            meta: { attachsList: [{ href: "https://e.com/x", title: "T", description: "D" }] },
        },
    },
    {
        // Identified by catalogue + id, not a URL — which is why the live path's
        // generic "has a url or a title?" test used to skip it entirely.
        name: "sticker",
        expect: "sticker",
        live: { msgType: "chat.sticker", content: { catId: 42, id: 777, type: 5 } },
        sync: { msgType: 10, content: "", meta: { attachsList: [{ catId: 42, id: 777, type: 5 }] } },
    },
    {
        // msgType 18 had no sync mapping, so the same pin was `location` live
        // and `type_18` from the phone. Three such rows existed in a real cache.
        name: "shared location",
        expect: "location",
        live: { msgType: "chat.location.new", content: { params: J({ latitude: 10.7, longitude: 106.6 }) } },
        sync: {
            msgType: 18,
            content: "",
            meta: { attachsList: [{ params: J({ latitude: 10.7, longitude: 106.6 }) }] },
        },
    },
    {
        // The text comes from the attachment's params. The live path passed an
        // empty meta, so it never found them.
        name: "reminder / todo event",
        expect: "event",
        live: { msgType: "chat.todo", content: { params: J({ customMsg: { title: "Reminder set" } }) } },
        sync: {
            msgType: 24,
            content: "",
            meta: { attachsList: [{ params: J({ customMsg: { title: "Reminder set" } }) }] },
        },
    },
    {
        // Measured: the same doodle arrives live as chat.doodle and from a sync
        // as msgType 2 with a photo-CDN jpg -- stored as type_2 before 2 mapped.
        name: "doodle",
        expect: "doodle",
        live: { msgType: "chat.doodle", content: { href: "https://photo-stal-10.zdn.vn/d.jpg" } },
        sync: { msgType: 2, content: "", meta: { attachsList: [{ href: "https://photo-stal-10.zdn.vn/d.jpg" }] } },
    },
    {
        // Measured from a phone-sent voice note: msgType 6, href on the voice
        // CDN (.aac), params m4a/duration/waveformSamples. Unmapped, sync stored
        // it as type_6 with has_attachment 0 -- the audio was never fetched.
        name: "voice note",
        expect: "voice",
        live: {
            msgType: "chat.voice",
            content: { href: "https://f2-voice-aac-dl.zdn.vn/x.aac", params: J({ m4a: "x", duration: 3000 }) },
        },
        sync: {
            msgType: 6,
            content: "",
            meta: {
                attachsList: [
                    { href: "https://f2-voice-aac-dl.zdn.vn/x.aac", params: J({ m4a: "x", duration: 3000 }) },
                ],
            },
        },
    },
    {
        // Measured: the same action zinstant.bankcard arrived as chat.webcontent
        // live and as msgType 24 from a sync. chat.webcontent was missing from
        // the live map, so it was stored under its raw spelling.
        name: "zinstant content (bank card)",
        expect: "event",
        live: {
            msgType: "chat.webcontent",
            content: { action: "zinstant.bankcard", params: J({ customMsg: { title: "Bank card" } }) },
        },
        sync: {
            msgType: 24,
            content: "",
            meta: { attachsList: [{ action: "zinstant.bankcard", params: J({ customMsg: { title: "Bank card" } }) }] },
        },
    },
    {
        name: "poll event",
        expect: "poll_event",
        live: { msgType: "group.poll", content: { params: J({ customMsg: { title: "Poll closed" } }) } },
        sync: {
            msgType: 26,
            content: "",
            meta: { attachsList: [{ params: J({ customMsg: { title: "Poll closed" } }) }] },
        },
    },
];

describe("mobile sync and live listener agree per message type", () => {
    for (const c of CASES) {
        it(`${c.name}: same type, text, attachment count and hasAttachment`, () => {
            const live = classifyLiveMessage(c.live);
            const sync = classifySyncMessage(c.sync);

            assert.equal(live.type, c.expect, "live type");
            assert.equal(sync.type, c.expect, "sync type");
            assert.equal(
                live.text,
                sync.text,
                `text differs — live ${JSON.stringify(live.text)} vs sync ${JSON.stringify(sync.text)}`,
            );
            assert.equal(
                live.attachments.length,
                sync.attachments.length,
                `attachment count differs — live ${live.attachments.length} vs sync ${sync.attachments.length}`,
            );
            assert.equal(live.hasAttachment, sync.hasAttachment, "hasAttachment differs");
        });
    }

    it("a sticker keeps its catalogue identity on both paths", () => {
        // Without it a live-captured sticker cannot be identified or re-sent.
        const live = classifyLiveMessage({ msgType: "chat.sticker", content: { catId: 42, id: 777, type: 5 } });
        const sync = classifySyncMessage({
            msgType: 10,
            content: "",
            meta: { attachsList: [{ catId: 42, id: 777, type: 5 }] },
        });
        for (const [label, r] of [
            ["live", live],
            ["sync", sync],
        ]) {
            assert.equal(r.attachments[0].kind, "sticker", `${label} kind`);
            assert.equal(r.attachments[0].catId, 42, `${label} catId`);
            assert.equal(r.attachments[0].stickerId, 777, `${label} stickerId`);
        }
    });

    it("the live path records the per-message detail the sync path records", () => {
        // quote, mentions, ttl and property were dropped live, so a row's
        // fidelity depended on which path happened to capture it.
        const live = classifyLiveMessage({
            msgType: "webchat",
            content: "hi",
            quote: { globalMsgId: 9, msg: "earlier" },
            mentions: [{ uid: "u2", pos: 0, len: 3 }],
            ttl: 86400000,
            propertyExt: { color: 1, size: 2 },
        });
        assert.ok(live.raw.quote, "quote");
        assert.equal(live.raw.mentions.length, 1, "mentions");
        assert.equal(live.raw.ttl, 86400000, "ttl");
        assert.ok(live.raw.property, "property");
    });

    it("omits those fields entirely when the message has none", () => {
        const live = classifyLiveMessage({ msgType: "webchat", content: "hi" });
        for (const k of ["quote", "mentions", "ttl", "property"]) {
            assert.equal(live.raw[k], undefined, `${k} must not appear as null noise`);
        }
    });
});
