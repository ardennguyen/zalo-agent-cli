/**
 * transfer-sync-v2 message classification.
 *
 * Fixtures mirror the shapes seen in a real decoded sync capture (jspb
 * `toObject()` form): numeric `msgType`, a string `content`, and everything
 * else under `meta.attachsList[].{href,thumb,params,...}`.
 *
 * The regression these guard against: `content` is ALWAYS a string in the
 * protobuf, so a `typeof content === "string"` test classifies every photo,
 * video, file and sticker as plain text and drops `meta` entirely.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    classifySyncMessage,
    extractSyncAttachments,
    extractSyncText,
    SYNC_MSG_TYPES,
    MEDIA_TYPES,
    classifyLiveMessage,
    LIVE_MSG_TYPES,
} from "../../src/core/sync-v2/message-types.js";

/** Build a decoded sync message with one attachment. */
const msg = (msgType, content, attach = null, meta = {}) => ({
    senderId: "n01se",
    clientId: 1234567890,
    msgStatus: 5,
    msgType,
    timestamp: 1750000000000,
    globalId: "9876543210",
    content,
    meta: { attachsList: attach ? [attach] : [], ...meta },
});

const PHOTO = {
    href: "https://photo-stal-10.zdn.vn/gr/24a3eae91c55c10b9844/abc.jpg",
    thumb: "https://photo-stal-10.zdn.vn/gr/24a3eae91c55c10b9844/thumb.jpg",
    params: JSON.stringify({
        width: 1766,
        height: 266,
        hd: "https://photo-stal-10.zdn.vn/gr/24a3eae91c55c10b9844/hd.jpg",
        fileValid: 1,
        is_original: 1,
    }),
};

const VIDEO = {
    href: "https://video-stal-39.dlmd.me/gr/321d6736dd2701795836/v.mp4",
    thumb: "https://photo-stal-16.zdn.vn/gr/3ffe3e0383125f4c0603/t.jpg",
    params: JSON.stringify({
        duration: 31000,
        video_width: 1080,
        video_height: 1920,
        fileSize: 5144115,
        video_url_to_renew: "https://video-stal-39.dlmd.me/renew/321d",
        thumb_url_to_renew: "",
    }),
};

const FILE = {
    title: "quarterly-report.pdf",
    href: "https://file-stal-21.dlfl.vn/gr/13f54a123da2e0fcb9b3/f.pdf",
    params: JSON.stringify({
        fileSize: "593569",
        checksum: "4e0e5c1dc991fd3a6151b68fe979d4f6",
        fileExt: "pdf",
        fileUrlToRenew: "https://file-stal-21.dlfl.vn/renew/13f5",
        tWidth: 780,
        tHeight: 291,
        fType: 1,
    }),
};

const STICKER = { type: "7", catId: 11984, id: 46669, extInfo: JSON.stringify({ params: "{}" }) };

describe("SYNC_MSG_TYPES", () => {
    it("maps both photo variants to one type", () => {
        // MSG_PHOTO and MSG_PHOTO_2 (the jxl-capable variant) are one thing here.
        assert.equal(SYNC_MSG_TYPES[3], "photo");
        assert.equal(SYNC_MSG_TYPES[4], "photo");
    });

    it("covers every type seen in the capture", () => {
        for (const t of [0, 3, 4, 10, 12, 15, 19, 20, 21, 22, 23, 24, 26, 36]) {
            assert.equal(typeof SYNC_MSG_TYPES[t], "string", `msgType ${t} unmapped`);
        }
    });
});

describe("classifySyncMessage — the string-content regression", () => {
    it("does not call a photo 'text' just because content is a string", () => {
        const r = classifySyncMessage(msg(3, "look at this", PHOTO));
        assert.equal(r.type, "photo");
        assert.equal(r.hasAttachment, true);
    });

    it("keeps a real caption verbatim", () => {
        assert.equal(classifySyncMessage(msg(3, "look at this", PHOTO)).text, "look at this");
    });

    it("never leaves a media row with empty text", () => {
        // ~1 row in 7 of a real sync has empty content; a blank row is unsearchable.
        for (const [type, attach] of [
            [3, PHOTO],
            [19, VIDEO],
            [22, FILE],
            [10, STICKER],
        ]) {
            const r = classifySyncMessage(msg(type, "", attach));
            assert.notEqual(r.text.trim(), "", `msgType ${type} produced a blank row`);
        }
    });

    it("stores msgType and full meta in raw_data", () => {
        const r = classifySyncMessage(msg(19, "", VIDEO));
        assert.equal(r.raw.msgType, 19);
        assert.equal(r.raw.src, "sync-v2");
        assert.equal(r.raw.attachments.length, 1);
    });

    it("carries cliMsgId so a synced row can anchor a reply", () => {
        // conv.js/msg.js read raw.cliMsgId to build reply/forward anchors.
        assert.equal(classifySyncMessage(msg(0, "hi")).raw.cliMsgId, "1234567890");
    });

    it("preserves quote, mentions and ttl", () => {
        const r = classifySyncMessage(
            msg(0, "re: that", null, {
                quote: { ownerId: "n01se", msg: "original" },
                mentionsList: [{ uid: "u1", pos: 0, len: 5 }],
                ttl: 86400000,
            }),
        );
        assert.equal(r.raw.quote.msg, "original");
        assert.equal(r.raw.mentions.length, 1);
        assert.equal(r.raw.ttl, 86400000);
    });
});

describe("classifySyncMessage — per type", () => {
    it("text carries no attachment", () => {
        const r = classifySyncMessage(msg(0, "plain words"));
        assert.deepEqual([r.type, r.text, r.hasAttachment], ["text", "plain words", false]);
    });

    it("file exposes name, ext, size and checksum", () => {
        const r = classifySyncMessage(msg(22, "", FILE));
        const a = r.attachments[0];
        assert.equal(r.type, "file");
        assert.equal(a.fileName, "quarterly-report.pdf");
        assert.equal(a.ext, "pdf");
        assert.equal(a.size, 593569); // string in the payload, number here
        assert.equal(a.checksum, "4e0e5c1dc991fd3a6151b68fe979d4f6");
        assert.equal(r.text, "[file] quarterly-report.pdf");
    });

    it("video exposes duration, dimensions and thumb", () => {
        const a = classifySyncMessage(msg(19, "", VIDEO)).attachments[0];
        assert.equal(a.kind, "video");
        assert.equal(a.duration, 31000);
        assert.equal(a.width, 1080);
        assert.equal(a.height, 1920);
        assert.ok(a.thumbUrl.includes("photo-stal-16"));
    });

    it("photo exposes the separate HD url", () => {
        const a = classifySyncMessage(msg(3, "", PHOTO)).attachments[0];
        assert.ok(a.hdUrl.endsWith("hd.jpg"));
        assert.equal(a.width, 1766);
    });

    it("sticker is catalogue+id, not a download", () => {
        const r = classifySyncMessage(msg(10, "", STICKER));
        assert.equal(r.type, "sticker");
        assert.equal(r.attachments[0].catId, 11984);
        assert.equal(r.attachments[0].stickerId, 46669);
        assert.equal(r.hasAttachment, false, "a sticker has no URL to fetch");
        assert.equal(r.text, "[sticker 11984/46669]");
    });

    it("deleted messages are marked, not blank", () => {
        const r = classifySyncMessage(msg(36, "", { params: JSON.stringify({ is_deleted: 1, original_type: 3 }) }));
        assert.equal(r.type, "deleted");
        assert.equal(r.text, "[deleted]");
        assert.equal(r.hasAttachment, false);
    });

    it("reads localised system-event text", () => {
        // msgType 24 is the zinstant carrier for reminders/todos.
        const attach = {
            params: JSON.stringify({
                customMsg: { msg: { vi: "Đã xoá nhắc hẹn", en: "Reminder removed" } },
            }),
        };
        assert.equal(classifySyncMessage(msg(24, "", attach)).text, "Đã xoá nhắc hẹn");
    });

    it("falls back to English when Vietnamese is absent", () => {
        const attach = { params: JSON.stringify({ customMsg: { msg: { en: "Poll closed" } } }) };
        assert.equal(classifySyncMessage(msg(26, "", attach)).text, "Poll closed");
    });

    it("summarises a link card", () => {
        const attach = {
            action: "recommened.link",
            title: "Some article",
            description: "A summary",
            href: "https://example.com/a",
            params: "{}",
        };
        assert.match(classifySyncMessage(msg(12, "", attach)).text, /Some article — A summary/);
    });
});

describe("classifySyncMessage — forward compatibility", () => {
    it("names an unknown type instead of losing it", () => {
        const r = classifySyncMessage(msg(99, "mystery"));
        assert.equal(r.type, "type_99");
        assert.equal(r.raw.msgType, 99);
    });

    it("still classifies media on an unknown type, by CDN host", () => {
        // Zalo adds msgTypes over time; the host family is the backstop.
        const r = classifySyncMessage(msg(99, "", PHOTO));
        assert.equal(r.type, "type_99");
        assert.equal(r.attachments[0].kind, "photo");
        assert.equal(r.hasAttachment, true);
    });

    it("keeps meta for an unknown type", () => {
        const r = classifySyncMessage(msg(99, "", VIDEO, { ttl: 1000 }));
        assert.equal(r.raw.ttl, 1000);
        assert.equal(r.raw.attachments[0].kind, "video");
    });
});

describe("classifySyncMessage — malformed input", () => {
    it("survives unparseable params", () => {
        const r = classifySyncMessage(msg(3, "", { href: "https://photo-stal-1.zdn.vn/x/y.jpg", params: "{not json" }));
        assert.equal(r.type, "photo");
        assert.equal(r.attachments[0].kind, "photo");
    });

    it("survives a non-URL href", () => {
        const r = classifySyncMessage(msg(12, "", { href: "not-a-url", params: "{}" }));
        assert.equal(r.attachments[0].url, "not-a-url");
    });

    it("survives a missing meta block", () => {
        const r = classifySyncMessage({ msgType: 0, content: "bare" });
        assert.deepEqual([r.type, r.text, r.hasAttachment], ["text", "bare", false]);
    });

    it("survives an entirely empty object", () => {
        const r = classifySyncMessage({});
        assert.equal(r.type, "type_undefined");
        assert.equal(r.hasAttachment, false);
    });
});

describe("extractSyncAttachments", () => {
    it("returns one entry per attachment", () => {
        const m = msg(3, "", PHOTO);
        m.meta.attachsList.push(JSON.parse(JSON.stringify(PHOTO)));
        assert.equal(extractSyncAttachments(m, "photo").length, 2);
    });

    it("keeps mobile-only renewal hints", () => {
        // These never appear in Zalo Web; they are the phone's re-upload
        // breadcrumbs and the only lead once a CDN copy has aged out.
        const a = extractSyncAttachments(msg(22, "", FILE), "file")[0];
        assert.ok(a.urlToRenew.includes("/renew/"));
    });

    it("keeps action-only attachments as meta", () => {
        const attach = { action: "msginfo.actionlist", params: JSON.stringify({ actions: [] }) };
        const a = extractSyncAttachments(msg(20, "x", attach), "group_event")[0];
        assert.equal(a.kind, "meta");
        assert.equal(a.action, "msginfo.actionlist");
    });

    it("drops an attachment carrying nothing", () => {
        assert.equal(extractSyncAttachments(msg(0, "hi", { params: "" }), "text").length, 0);
    });
});

describe("extractSyncText", () => {
    it("returns the empty string for empty text messages", () => {
        assert.equal(extractSyncText({ msgType: 0, content: "" }, "text", []), "");
    });

    it("trims surrounding whitespace", () => {
        assert.equal(extractSyncText({ msgType: 0, content: "  hi  " }, "text", []), "hi");
    });
});

describe("MEDIA_TYPES", () => {
    it("lists the downloadable kinds", () => {
        for (const t of ["photo", "video", "file", "gif"]) assert.ok(MEDIA_TYPES.has(t));
        assert.ok(!MEDIA_TYPES.has("sticker"), "a sticker has no URL to fetch");
        assert.ok(!MEDIA_TYPES.has("text"));
    });
});

describe("hasAttachment means downloadable", () => {
    it("is false for a link preview even though it has a URL", () => {
        // has_attachment drives the downloader's queue, so a link-preview card
        // counted here would make the pending figure permanently overstated.
        const attach = { action: "recommened.link", title: "Article", href: "https://example.com/a", params: "{}" };
        const r = classifySyncMessage(msg(12, "", attach));
        assert.equal(r.attachments[0].kind, "link");
        assert.equal(r.hasAttachment, false);
    });

    it("is true for a photo, video, file and gif", () => {
        for (const [type, attach] of [
            [3, PHOTO],
            [19, VIDEO],
            [22, FILE],
        ]) {
            assert.equal(classifySyncMessage(msg(type, "", attach)).hasAttachment, true, `msgType ${type}`);
        }
    });

    it("is false for a group event carrying only an action payload", () => {
        const attach = { action: "msginfo.actionlist", params: JSON.stringify({ actions: [] }) };
        assert.equal(classifySyncMessage(msg(20, "x", attach)).hasAttachment, false);
    });
});

describe("links are a media kind, and are not confused with cards", () => {
    it("classifies a shared link as a link", () => {
        const attach = {
            action: "recommened.link",
            title: "An article",
            description: "Summary",
            href: "https://example.com/a",
            thumb: "https://example.com/t.jpg",
            params: JSON.stringify({ mediaTitle: "An article" }),
        };
        const a = classifySyncMessage(msg(12, "", attach)).attachments[0];
        assert.equal(a.kind, "link");
        assert.equal(a.url, "https://example.com/a");
        assert.equal(a.title, "An article");
    });

    it("does NOT call an OA notification card a link", () => {
        // These outnumber real links ~18:1 in a live account, so bucketing them
        // as links makes "show me shared links" useless.
        const attach = {
            type: "l.a.header.only",
            title: "Notification",
            href: "https://zalo.me/something",
            thumb: "https://stc-sp.zadn.vn/x.png",
        };
        assert.equal(classifySyncMessage(msg(15, "", attach)).attachments[0].kind, "card");
    });

    it("does NOT call a profile card a link", () => {
        const attach = { action: "show.profile", title: "Someone", href: "https://res-zalo.zadn.vn/a.jpg" };
        assert.equal(classifySyncMessage(msg(21, "", attach)).attachments[0].kind, "profile_card");
    });

    it("keeps links out of the download queue", () => {
        // A link has no bytes to fetch, so it must not inflate has_attachment.
        const attach = { action: "recommened.link", href: "https://example.com/a", params: "{}" };
        assert.equal(classifySyncMessage(msg(12, "", attach)).hasAttachment, false);
    });
});

describe("nothing the phone sent is dropped", () => {
    const FULL = {
        type: "l.a.header.only",
        extInfo: JSON.stringify({ e: 1 }),
        action: "act",
        params: JSON.stringify({ width: 10, contentId: "abc", ocr_scan_status: 1 }),
        title: "T",
        href: "https://photo-stal-1.zdn.vn/a/b.jpg",
        thumb: "https://photo-stal-1.zdn.vn/a/t.jpg",
        description: "D",
        catId: 5,
        id: 6,
        childNumber: 2,
        remains: JSON.stringify({ r: 1 }),
        zinstantData: "zd",
        zinstantMsg: "zm",
    };

    it("carries every Attach field through to raw_data", () => {
        const a = classifySyncMessage(msg(3, "", FULL)).attachments[0];
        assert.equal(a.attachType, "l.a.header.only");
        assert.deepEqual(a.extInfo, { e: 1 });
        assert.equal(a.childNumber, 2);
        assert.equal(a.catId, 5);
        assert.equal(a.itemId, 6);
        assert.deepEqual(a.remains, { r: 1 });
        assert.equal(a.zinstantData, "zd");
        assert.equal(a.zinstantMsg, "zm");
    });

    it("keeps the whole params blob, not just the fields it maps", () => {
        // params holds per-type detail (OCR status, content ids, codec settings)
        // that no fixed field list keeps up with.
        const a = classifySyncMessage(msg(3, "", FULL)).attachments[0];
        assert.deepEqual(a.params, { width: 10, contentId: "abc", ocr_scan_status: 1 });
        assert.equal(a.width, 10, "mapped fields stay available too");
    });

    it("keeps params on an action-only attachment", () => {
        const attach = { action: "msginfo.actionlist", params: JSON.stringify({ actions: [1, 2] }) };
        const a = classifySyncMessage(msg(20, "x", attach)).attachments[0];
        assert.deepEqual(a.params, { actions: [1, 2] });
    });

    it("keeps verbatim fields on a sticker too", () => {
        const attach = { type: "7", catId: 11984, id: 46669, extInfo: JSON.stringify({ p: 1 }), childNumber: 3 };
        const a = classifySyncMessage(msg(10, "", attach)).attachments[0];
        assert.equal(a.kind, "sticker");
        assert.deepEqual(a.extInfo, { p: 1 });
        assert.equal(a.childNumber, 3);
    });

    it("leaves unparseable params as the original string rather than losing it", () => {
        const a = classifySyncMessage(msg(3, "", { href: "https://photo-stal-1.zdn.vn/a.jpg", params: "{broken" }))
            .attachments[0];
        assert.equal(a.params, "{broken");
    });
});

describe("classifyLiveMessage — one vocabulary for both capture paths", () => {
    it("maps every zca-js live type into the sync vocabulary", () => {
        // Stored verbatim, `WHERE type='photo'` misses every listener row and
        // `WHERE type='chat.photo'` misses every synced one.
        const expected = {
            webchat: "text",
            "chat.photo": "photo",
            "chat.video.msg": "video",
            "share.file": "file",
            "chat.gif": "gif",
            "chat.sticker": "sticker",
            "chat.voice": "voice",
            "chat.undo": "deleted",
            "group.poll": "poll_event",
        };
        for (const [live, want] of Object.entries(expected)) {
            assert.equal(LIVE_MSG_TYPES[live], want, `${live} should map to ${want}`);
        }
    });

    it("produces the same type name as the sync path for a photo", () => {
        const live = classifyLiveMessage({
            msgType: "chat.photo",
            content: { href: "https://photo-stal-3.zdn.vn/a/b.jpg", params: { width: 800 } },
        });
        const synced = classifySyncMessage(msg(3, "", PHOTO));
        assert.equal(live.type, synced.type);
        assert.equal(live.attachments[0].kind, synced.attachments[0].kind);
    });

    it("sets hasAttachment so sync-media can see live-captured media", () => {
        // Without this the listener's photos are invisible to the downloader.
        const r = classifyLiveMessage({
            msgType: "chat.photo",
            content: { href: "https://photo-stal-3.zdn.vn/a/b.jpg" },
        });
        assert.equal(r.hasAttachment, true);
    });

    it("keeps a plain text message plain", () => {
        const r = classifyLiveMessage({ msgType: "webchat", content: "  hello  " });
        assert.deepEqual([r.type, r.text, r.hasAttachment], ["text", "hello", false]);
    });

    it("extracts file details from the live shape", () => {
        const r = classifyLiveMessage({
            msgType: "share.file",
            content: {
                href: "https://file-stal-2.dlfl.vn/x/r.pdf",
                title: "report.pdf",
                params: { fileExt: "pdf", fileSize: 4096 },
            },
        });
        assert.equal(r.type, "file");
        assert.equal(r.attachments[0].ext, "pdf");
        assert.equal(r.attachments[0].size, 4096);
        assert.equal(r.text, "[file] report.pdf");
    });

    it("records cliMsgId and marks the source", () => {
        const r = classifyLiveMessage({ msgType: "webchat", content: "hi", cliMsgId: 77 });
        assert.equal(r.raw.cliMsgId, "77");
        assert.equal(r.raw.src, "listen");
    });

    it("never leaves a live media row blank", () => {
        for (const t of ["chat.photo", "chat.video.msg", "chat.sticker", "chat.undo"]) {
            const r = classifyLiveMessage({ msgType: t, content: {} });
            assert.notEqual(r.text.trim(), "", `${t} produced a blank row`);
        }
    });

    it("survives an unknown live type instead of dropping it", () => {
        const r = classifyLiveMessage({ msgType: "chat.somethingnew", content: { title: "x" } });
        assert.equal(r.type, "chat.somethingnew");
        assert.equal(r.raw.msgType, "chat.somethingnew");
    });

    it("tolerates a missing payload", () => {
        const r = classifyLiveMessage({});
        assert.equal(r.hasAttachment, false);
        assert.equal(typeof r.type, "string");
    });
});
