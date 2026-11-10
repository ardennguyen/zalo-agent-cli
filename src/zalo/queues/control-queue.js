/**
 * The `601` control frames and the queues behind them (plan item X4).
 *
 * A `601` carries `controls[]`, each `{actionId, controlId, content: {act, act_type, data}}`, plus `queueStatus` with
 * the control queues' cursors: `603_1`, `603_0` and `604_0`, each `{ids, lastId}`. The Web client uses those
 * `lastId`s as the cursor of its next `603` pull, so that controls that arrived while it was offline (a group
 * event, an unread mark, a sync status) are fetched when it comes back.
 *
 * A daemon pulls `603` on every connect, from the cursors kept here, and replays each page as a `601` push
 * (src/core/control-replay.js, called by src/core/self-heal.js). This module is what reads those frames:
 *
 *  - {@link readControls} sorts the controls of a frame by what they are, so a control nobody handles is named
 *    instead of vanishing;
 *  - {@link controlCursorsOf} reads the control queues' cursors, which the daemon keeps (forward only) from every
 *    push and every replayed page.
 *
 * Nothing here acknowledges a control: the Web client acknowledges them with nothing at all (its cursor is the
 * mechanism; a control queue is not consumed by being read), and the controls this client handles are acted on in
 * memory, not stored.
 */

/** The control queues named in every `601` reply. */
export const CONTROL_QUEUES = Object.freeze(["603_1", "603_0", "604_0"]);

/**
 * What a control is, by `act_type/act`, `act_type` or `act`. An entry names the handler that acts on it, or (`ignored`)
 * why there is nothing for this client to do. The values come from the captured frames and from the handlers
 * this client already has (the listener's `file_done`, `video_done`, `photo_success`, `group`, `fr`; src/core/read-state.js's `mark_unread`; the sync status
 * frames).
 */
const KNOWN = new Map([
    ["transfer_sync2", { kind: "sync", handler: "sync-v2" }],
    ["mark_unread", { kind: "read-state", handler: "read-state" }],
    ["pinned_convers", { kind: "pin-state", handler: "read-state" }],
    ["file_done", { kind: "upload", handler: "listener" }],
    ["video_done", { kind: "upload", handler: "listener" }],
    ["photo_success", { kind: "upload", handler: "listener" }],
    ["group", { kind: "group-event", handler: "listener" }],
    ["fr", { kind: "friend-event", handler: "listener" }],
    // The owner's alias for someone set, changed or removed: the listener's `alias_change`; the app rereads its alias
    // list (src/core/contact-names.js), as Zalo Web does.
    ["alias", { kind: "alias", handler: "listener" }],
    // The account's own profile changed on another device: the listener's `profile_change`; on `update` the app
    // rereads its own profile name (src/core/contact-names.js).
    ["profile", { kind: "profile", handler: "listener" }],
    ["voice2text", { kind: "transcript", handler: "voice-text" }],
    // A product or catalog added, edited or deleted on another device (the whole `prod_catalog` family), a DM
    // reminder created, edited or deleted, the account's device list changed: src/core/control-events.js. Only the
    // named `oneone` acts are handled; another act of that family is still named as unhandled.
    ["prod_catalog", { kind: "catalog", handler: "control-events" }],
    ["create_reminder11", { kind: "reminder", handler: "control-events" }],
    ["update_reminder11", { kind: "reminder", handler: "control-events" }],
    ["remove_reminder11", { kind: "reminder", handler: "control-events" }],
    ["update_user_devices", { kind: "devices", handler: "control-events" }],
    // This account's own settings changed on another device (`act: "update"`, the changed keys in `data`; Zalo Web
    // merges them into its settings store): a `settings_changed` event, src/core/control-events.js.
    ["my_settings", { kind: "settings", handler: "control-events" }],
    // Hidden chats hidden or unhidden (`add_remove`), their PIN removed (`reset`) or changed (`change_pin`, the new
    // hash in `data.pin`) on another device: the app keeps its hidden set current from them.
    ["hidden_chat", { kind: "hidden-chat", handler: "hidden-chats" }],
    // A conversation muted or unmuted (`set`/`unset`, data `{toId, muteType, duration, startTime, systemTime}`), the
    // conversation labels changed (`label_convers/update`), the archived ("Other") list changed
    // (`archived_chat/update`, `{version, actionType, items}`), a quick message created, edited or deleted
    // (`quick_message`, `{items, version}`), a conversation's auto-delete time changed (`conv_settings/update_ttl`), on
    // another device. Zalo PC applies each to a store of its own; this client keeps none of them (`conv muted`,
    // `label list`, `conv archived`, `quick-msg list` and `conv auto-delete-status` read Zalo live), so each is reported
    // as an event: src/core/control-events.js.
    ["mute", { kind: "mute", handler: "control-events" }],
    ["label_convers", { kind: "labels", handler: "control-events" }],
    ["archived_chat", { kind: "archived", handler: "control-events" }],
    ["quick_message", { kind: "quick-message", handler: "control-events" }],
    ["conv_settings/update_ttl", { kind: "auto-delete", handler: "control-events" }],
    // Known, and nothing to do: what Zalo PC 26.10.20 does with each, and why this client has nothing to change.
    [
        "media_send2me",
        {
            kind: "self-chat-media",
            ignored:
                "Zalo PC adds or removes the item in its My Cloud media panel; the zCloud index follows the cloud queue (cmd 620/621), not this",
        },
    ],
    [
        "photo/renew_link",
        {
            kind: "renew-link",
            ignored:
                "the late answer to a link renewal Zalo PC made to forward media (matched by originalUrl to a waiting callback); this client reads renewlink's own reply and waits for none",
        },
    ],
    [
        "file/renew_link",
        {
            kind: "renew-link",
            ignored:
                "the late answer to a link renewal Zalo PC made to forward a file (matched by originalUrl to a waiting callback); this client reads renewlink's own reply and waits for none",
        },
    ],
    [
        "video/renew_link",
        {
            kind: "renew-link",
            ignored:
                "the late answer to a link renewal Zalo PC made to forward a video (matched by originalUrl to a waiting callback); this client reads renewlink's own reply and waits for none",
        },
    ],
    [
        "emoji_status",
        {
            kind: "emoji-status",
            ignored: "the status emoji Zalo PC paints beside a contact; this client neither keeps nor shows one",
        },
    ],
    [
        "contact_tab",
        {
            kind: "ui",
            ignored: "the Contacts tab was opened on another device: Zalo PC clears that tab's badge (UI only)",
        },
    ],
    [
        "transfer_msg",
        {
            kind: "sync",
            ignored:
                "the phone's offer to sync messages after a QR login: `login` reads it from the control queue (src/core/sync-v2/auto-sync.js), and a daemon never starts a phone-backed restore",
        },
    ],
]);

/** The entry for a control: by `act_type/act` first, then by `act_type`, then by `act`. */
function knownOf(actType, act) {
    return KNOWN.get(`${actType}/${act}`) ?? KNOWN.get(actType) ?? KNOWN.get(act) ?? null;
}

/** A control's `data`: an object, or the JSON text of one, or null when it is neither. */
function dataOf(data) {
    let obj = data;
    if (typeof data === "string") {
        try {
            obj = JSON.parse(data);
        } catch {
            return null;
        }
    }
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
}

/**
 * The controls of one `601` frame's `data`.
 *
 * @param {object|null|undefined} data - a decoded 601 frame's `data`
 * @returns {Array<{actionId: string|null, actType: string, act: string, kind: string, handler: string|null,
 *   handled: boolean, ignored: string|null, data: object|null, ts: number|null}>} `handled` is false for a control
 *   this client does not know; `ignored` is the reason a known control needs nothing done (then `handler` is null);
 *   `data` is the control's own data when it is an object; `ts` is the control's own time, when it has one
 */
export function readControls(data) {
    const out = [];
    for (const c of Array.isArray(data?.controls) ? data.controls : []) {
        const content = c?.content;
        if (!content || typeof content !== "object") continue;
        const actType = String(content.act_type ?? "");
        const act = String(content.act ?? "");
        const known = knownOf(actType, act);
        out.push({
            actionId: c.actionId === undefined || c.actionId === null ? null : String(c.actionId),
            actType,
            act,
            kind: known?.kind ?? "unknown",
            handler: known?.handler ?? null,
            handled: Boolean(known),
            ignored: known?.ignored ?? null,
            data: dataOf(content.data),
            ts: Number.isFinite(Number(content.ts)) && Number(content.ts) > 0 ? Number(content.ts) : null,
        });
    }
    return out;
}

/**
 * The control queues' cursors in a `601` frame's `data`.
 *
 * @param {object|null|undefined} data
 * @returns {Array<{queueName: string, id: string}>} only queues that name a numeric `lastId` other than 0
 */
export function controlCursorsOf(data) {
    const out = [];
    for (const queueName of CONTROL_QUEUES) {
        const id = data?.queueStatus?.[queueName]?.lastId;
        if (/^\d+$/.test(String(id ?? "")) && String(id) !== "0") out.push({ queueName, id: String(id) });
    }
    return out;
}
