/**
 * Classify and unpack messages coming out of the transfer-sync-v2 protobuf.
 *
 * The sync payload is NOT the same shape as a live listener event. `Message`
 * carries a numeric `msgType` and a **string** `content` (protobuf field 7),
 * with everything else — attachments, quote, mentions, TTL, bubble styling —
 * hanging off `meta` (field 8). Media is present only as CDN references:
 * `attach.href` / `attach.thumb` plus a JSON `attach.params` blob. No file
 * bytes ever travel in the sync stream.
 *
 * Because `content` is always a string, a `typeof content === "string"` test
 * can't tell text from a photo — the numeric `msgType` and the attachment
 * shape are the only real signals, which is what this module reads.
 *
 * msgType numbers were recovered empirically from a decoded sync capture and
 * cross-checked against Zalo Web's own switch statements (MSG_PHOTO /
 * MSG_PHOTO_2 / MSG_VIDEO / MSG_FILE / MSG_CONTACT). Zalo adds types over
 * time, so an unknown number degrades to `type_<n>` and — critically — still
 * keeps its full `meta`, rather than being silently flattened to text.
 */

/** Numeric sync msgType -> stable CLI type name. */
export const SYNC_MSG_TYPES = {
    0: "text",
    3: "photo", // MSG_PHOTO
    4: "photo", // MSG_PHOTO_2 (jxl-capable variant)
    // A voice note. Measured: attach href on f2-voice-aac-dl.zdn.vn (.aac),
    // params m4a/duration/waveformSamples. Unmapped, it was stored as type_6
    // with a non-media kind, so has_attachment stayed 0 and the audio was
    // silently never downloaded.
    6: "voice",
    10: "sticker",
    12: "link", // link/media preview, action "recommened.link"
    15: "card", // OA / system rich card, attach.type "l.a.*"
    18: "location", // shared location; attach params carry latitude/longitude
    19: "video", // MSG_VIDEO
    20: "group_event", // action "msginfo.actionlist"
    21: "profile_card", // action "show.profile"
    22: "file", // MSG_FILE
    23: "gif",
    24: "event", // zinstant template event (reminders, todos, ...)
    26: "poll_event",
    36: "deleted", // undone/recalled; content empty, params.is_deleted
};

/**
 * CDN host families, used to classify media when `msgType` is unknown.
 * Zalo shards these numerically (photo-stal-10, photo-stal-35, ...), so the
 * patterns match the family rather than a specific host.
 */
const HOST_KINDS = [
    [/(^|\.)photo-stal-\d+\./i, "photo"],
    [/(^|\.)video-stal-\d+\./i, "video"],
    [/(^|\.)file-stal-\d+\./i, "file"],
    [/(^|\.)zalo-gif\./i, "gif"],
];

/** Types whose payload points at a downloadable binary. */
export const MEDIA_TYPES = new Set(["photo", "video", "file", "gif", "voice", "audio", "doodle"]);

/** Parse a JSON string field that Zalo sometimes leaves empty or malformed. */
function parseJson(value) {
    if (!value || typeof value !== "string") return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/** Classify a single attachment by the URL it points at. */
function kindFromUrl(url) {
    if (!url) return null;
    let host;
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    for (const [re, kind] of HOST_KINDS) if (re.test(host)) return kind;
    return null;
}

/** First non-empty value among the given params keys. */
function pick(params, ...keys) {
    if (!params) return undefined;
    for (const k of keys) {
        const v = params[k];
        if (v !== undefined && v !== null && v !== "" && v !== 0) return v;
    }
    return undefined;
}

/**
 * Unpack `meta.attachsList` into a flat, download-ready shape.
 *
 * Kind resolution is deliberately belt-and-braces: the message's own type
 * wins, but a recognised CDN host can still classify an attachment hanging
 * off a msgType this build has never seen.
 *
 * @param {object} msg - a decoded Sync2.Message.Message (jspb toObject form)
 * @param {string} [msgTypeName] - resolved type name, if already computed
 * @returns {Array<object>} one entry per attachment that carries something useful
 */
export function extractSyncAttachments(msg, msgTypeName) {
    const type = msgTypeName || SYNC_MSG_TYPES[msg?.msgType] || `type_${msg?.msgType}`;
    const out = [];
    for (const a of msg?.meta?.attachsList || []) {
        const params = parseJson(a.params) || {};
        const extInfo = parseJson(a.extInfo);
        const kind = kindFromUrl(a.href) || (MEDIA_TYPES.has(type) ? type : null) || (a.catId ? "sticker" : null);

        // Fields the normalized shape below does not otherwise name. Carried
        // verbatim so nothing the phone sent is lost: a later build must be
        // able to read what this one does not understand, and `params` in
        // particular holds per-type detail (OCR status, content ids, video
        // codec settings) that no fixed field list would keep up with.
        const verbatim = {
            attachType: a.type || undefined,
            childNumber: a.childNumber || undefined,
            extInfo: extInfo || a.extInfo || undefined,
            params: Object.keys(params).length ? params : a.params || undefined,
            remains: parseJson(a.remains) || a.remains || undefined,
            zinstantData: a.zinstantData || undefined,
            zinstantMsg: a.zinstantMsg || undefined,
        };

        // A sticker is identified by catalogue + id, not a URL.
        if (kind === "sticker" || (type === "sticker" && a.catId)) {
            out.push({
                kind: "sticker",
                catId: a.catId ?? null,
                stickerId: a.id ?? null,
                stickerType: a.type ?? null,
                ...verbatim,
            });
            continue;
        }

        const url = a.href || undefined;
        const thumbUrl = a.thumb || undefined;
        if (!url && !thumbUrl) {
            // Pure action/system attachment (group events, zinstant templates).
            // Keep it only when it carries a payload worth reading back.
            if (a.action || a.title || Object.keys(params).length) {
                out.push({
                    kind: kind || "meta",
                    action: a.action || undefined,
                    title: a.title || undefined,
                    description: a.description || undefined,
                    catId: a.catId || undefined,
                    itemId: a.id || undefined,
                    ...verbatim,
                });
            }
            continue;
        }

        out.push({
            // Fall back to the message's own type, NOT a blanket "link": an OA
            // notification card and a profile card both carry an href, and
            // calling them links makes "show me the links in this thread"
            // return mostly notifications. Zalo Web is equally narrow — its
            // Link store takes only action "recommened.link".
            kind: kind || type,
            url,
            thumbUrl,
            // Photos carry a separate full-resolution URL in params.hd.
            hdUrl: typeof params.hd === "string" && params.hd ? params.hd : undefined,
            title: a.title || undefined,
            description: a.description || undefined,
            action: a.action || undefined,
            fileName: type === "file" ? a.title || undefined : undefined,
            ext: params.fileExt || undefined,
            size: Number(pick(params, "fileSize", "video_file_size")) || undefined,
            checksum: params.checksum || undefined,
            width: Number(pick(params, "width", "video_width", "tWidth")) || undefined,
            height: Number(pick(params, "height", "video_height", "tHeight")) || undefined,
            duration: Number(pick(params, "duration")) || undefined,
            // Mobile-only renewal hints. Zalo Web never sends these; the phone
            // uses them to re-upload media whose CDN copy has aged out.
            urlToRenew: pick(params, "fileUrlToRenew", "video_url_to_renew") || undefined,
            thumbUrlToRenew: pick(params, "thumbUrlToRenew", "thumb_url_to_renew") || undefined,
            catId: a.catId || undefined,
            itemId: a.id || undefined,
            ...verbatim,
        });
    }
    return out;
}

/** Localised system-event text, preferring Vietnamese then English. */
function customMsgText(params) {
    const msg = params?.customMsg?.msg;
    if (!msg) return null;
    if (typeof msg === "string") return msg;
    return msg.vi || msg.en || Object.values(msg)[0] || null;
}

/**
 * Best-effort human-readable text for a synced message.
 *
 * For media the caption lives in `content` and is frequently empty, so the
 * fallback is a type marker plus whatever identifying detail the attachment
 * carries (a filename, a link title). That keeps `text` searchable instead of
 * leaving a blank row, which is what the previous implementation produced for
 * roughly one row in seven.
 *
 * @param {object} msg - decoded sync message
 * @param {string} type - resolved type name
 * @param {Array<object>} attachments - from extractSyncAttachments()
 * @returns {string}
 */
export function extractSyncText(msg, type, attachments = []) {
    const content = typeof msg?.content === "string" ? msg.content.trim() : "";
    if (type === "text") return content;
    if (content && type !== "deleted") {
        // A real caption / body — keep it verbatim.
        if (type !== "event" && type !== "group_event" && type !== "poll_event") return content;
    }

    const a = attachments[0] || {};
    const params = parseJson(msg?.meta?.attachsList?.[0]?.params) || {};

    switch (type) {
        case "deleted":
            return "[deleted]";
        case "sticker":
            return a.catId ? `[sticker ${a.catId}/${a.stickerId}]` : "[sticker]";
        case "file":
            return a.fileName ? `[file] ${a.fileName}` : "[file]";
        case "photo":
        case "video":
        case "gif":
            return a.title ? `[${type}] ${a.title}` : `[${type}]`;
        case "link":
        case "card":
        case "profile_card":
            return [a.title, a.description, a.url].filter(Boolean).join(" — ") || `[${type}]`;
        case "event":
        case "group_event":
        case "poll_event":
            return customMsgText(params) || content || `[${type}]`;
        default:
            return content || (a.title ? `[${type}] ${a.title}` : `[${type}]`);
    }
}

/**
 * Turn one decoded sync message into the row this CLI stores.
 *
 * `raw_data` keeps the whole payload — including `cliMsgId`, which makes a
 * synced row usable as a reply/forward anchor the way a listener-captured row
 * already is.
 *
 * @param {object} msg - decoded Sync2.Message.Message (jspb toObject form)
 * @returns {{type: string, text: string, hasAttachment: boolean, attachments: Array<object>, raw: object}}
 */
export function classifySyncMessage(msg) {
    const type = SYNC_MSG_TYPES[msg?.msgType] ?? `type_${msg?.msgType}`;
    const attachments = extractSyncAttachments(msg, type);
    const text = extractSyncText(msg, type, attachments);
    const meta = msg?.meta || {};
    // "Has an attachment" means "has a file worth fetching". A link-preview
    // card carries a URL too, but it points at a web page, so counting it
    // would make the pending-media figure disagree with what can actually be
    // downloaded — and `has_attachment` is exactly what the downloader reads.
    const downloadable = attachments.filter((a) => (a.url || a.thumbUrl) && MEDIA_TYPES.has(a.kind));

    return {
        type,
        text,
        hasAttachment: downloadable.length > 0,
        attachments,
        raw: {
            src: "sync-v2",
            msgType: msg?.msgType,
            msgStatus: msg?.msgStatus,
            cliMsgId: msg?.clientId === undefined || msg?.clientId === null ? undefined : String(msg.clientId),
            content: typeof msg?.content === "string" && msg.content ? msg.content : undefined,
            attachments: attachments.length ? attachments : undefined,
            // Everything else the payload carried, kept verbatim so a later
            // build can read fields this one doesn't understand yet.
            quote: meta.quote || undefined,
            mentions: meta.mentionsList?.length ? meta.mentionsList : undefined,
            reference: meta.reference || undefined,
            property: meta.property || undefined,
            ttl: meta.ttl ? Number(meta.ttl) : undefined,
        },
    };
}

/**
 * zca-js live-event msgType -> the SAME vocabulary the sync path uses.
 *
 * The listener and the mobile sync describe identical things in different
 * words: a photo arrives as `chat.photo` live and as numeric msgType 3 from the
 * phone. Stored verbatim, `WHERE type = 'photo'` silently misses every
 * listener-captured row and `WHERE type = 'chat.photo'` misses every synced
 * one. One vocabulary, one set of queries.
 */
export const LIVE_MSG_TYPES = {
    webchat: "text",
    "chat.photo": "photo",
    "chat.video.msg": "video",
    "share.file": "file",
    "chat.gif": "gif",
    "chat.sticker": "sticker",
    "chat.voice": "voice",
    "chat.doodle": "doodle",
    "chat.link": "link",
    "chat.recommended": "link",
    "chat.zalo.me": "link",
    "chat.location.new": "location",
    "chat.todo": "event",
    // Zalo's "zinstant" rich content -- a bank card is one. Measured: the same
    // action zinstant.bankcard arrives as chat.webcontent live and as msgType 24
    // from a sync, so unmapped it was stored under the raw spelling live.
    "chat.webcontent": "event",
    "group.poll": "poll_event",
    "chat.undo": "deleted",
    "chat.delete": "deleted",
    "chat.ecard": "card",
};

/** Read `params` from a live payload, which may be an object or a JSON string. */
function liveParams(content) {
    const p = content?.params;
    if (!p) return {};
    if (typeof p === "object") return p;
    try {
        return JSON.parse(p);
    } catch {
        return {};
    }
}

/**
 * Classify a live listener message into the same shape as a synced one.
 *
 * The payload differs from the protobuf: here `content` really is an object for
 * media, URLs are named `href`/`oriUrl`/`normalUrl`/`hdUrl`, and there is no
 * `meta` wrapper. What comes out is deliberately identical to
 * {@link classifySyncMessage} so both paths write interchangeable rows and one
 * downloader serves both.
 *
 * @param {{msgType?: string, content?: object|string, msgId?: string|number, cliMsgId?: string|number}} data
 *   the zca-js `msg.data` object
 * @returns {{type: string, text: string, hasAttachment: boolean, attachments: Array<object>, raw: object}}
 */
export function classifyLiveMessage(data) {
    const rawType = data?.msgType || "";
    const type = LIVE_MSG_TYPES[rawType] || (typeof data?.content === "string" ? "text" : rawType || "attachment");
    const content = data?.content;
    const attachments = [];

    if (content && typeof content === "object") {
        const params = liveParams(content);
        const url = content.href || content.oriUrl || content.normalUrl || undefined;
        const thumbUrl = content.thumb || content.thumbUrl || undefined;
        const kind = kindFromUrl(url) || (MEDIA_TYPES.has(type) ? type : type);
        // A sticker is identified by catalogue + id, not a URL, so the generic
        // test below never fired for one: the same sticker produced one
        // attachment from a sync and zero from the listener, and its text read
        // "[sticker]" instead of "[sticker <cat>/<id>]". Mirrors the sync
        // branch in extractSyncAttachments.
        if (type === "sticker") {
            attachments.push({
                kind: "sticker",
                catId: content.catId ?? content.cat_id ?? null,
                stickerId: content.id ?? content.stickerId ?? null,
                stickerType: content.type ?? null,
                params: Object.keys(params).length ? params : undefined,
            });
        } else if (url || thumbUrl || content.title || Object.keys(params).length) {
            attachments.push({
                kind,
                url,
                thumbUrl,
                hdUrl: content.hdUrl || (typeof params.hd === "string" ? params.hd : undefined),
                title: content.title || undefined,
                description: content.description || undefined,
                action: content.action || undefined,
                fileName: type === "file" ? content.title || undefined : undefined,
                ext: params.fileExt || content.fileExt || undefined,
                size: Number(pick(params, "fileSize", "video_file_size")) || Number(content.fileSize) || undefined,
                checksum: params.checksum || content.checksum || undefined,
                width: Number(pick(params, "width", "video_width", "tWidth")) || undefined,
                height: Number(pick(params, "height", "video_height", "tHeight")) || undefined,
                duration: Number(pick(params, "duration")) || undefined,
                params: Object.keys(params).length ? params : undefined,
            });
        }
    }

    const downloadable = attachments.filter((a) => (a.url || a.thumbUrl) && MEDIA_TYPES.has(a.kind));
    // Hand extractSyncText the SAME shape the sync path gives it. It reads the
    // first attachment's params to build an event/poll sentence, so passing a
    // synthetic empty meta made every system event read as a bare "[event]"
    // when captured live and as its real text when restored from the phone.
    const liveMeta =
        attachments.length && attachments[0].params
            ? { attachsList: [{ params: JSON.stringify(attachments[0].params) }] }
            : {};
    const text =
        typeof content === "string"
            ? content.trim()
            : extractSyncText({ content: "", meta: liveMeta }, type, attachments) || `[${type}]`;

    return {
        type,
        text,
        hasAttachment: downloadable.length > 0,
        attachments,
        raw: {
            src: "listen",
            msgType: rawType || undefined,
            cliMsgId: data?.cliMsgId === undefined || data?.cliMsgId === null ? undefined : String(data.cliMsgId),
            content: typeof content === "string" ? content || undefined : content,
            attachments: attachments.length ? attachments : undefined,
            // The sync path records these; the live path dropped them, so the
            // same message was richer or poorer depending on how it was
            // captured. zca-js supplies all of them on a live event.
            quote: data?.quote || undefined,
            mentions: data?.mentions?.length ? data.mentions : undefined,
            ttl: data?.ttl ? Number(data.ttl) : undefined,
            property: data?.propertyExt || undefined,
        },
    };
}
