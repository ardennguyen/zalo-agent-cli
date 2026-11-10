/**
 * The `601` controls Zalo pushes about changes made on another device, which this client used to name as
 * unhandled: a product catalog changed, a DM reminder created, edited or removed, the account's device list changed.
 *
 * What Zalo Web does with each (read in its bundle, 2026-11-06), and what this does:
 *
 * - **`prod_catalog`** (`add_prod`, `edit_prod`, `del_prod`, `del_list_prod`, `add_catalog`, `edit_catalog`,
 *   `del_catalog`, `enable_feature`). The Web applies the control's data to its catalog store (an `item` row for an add
 *   or an edit; `catalog_id`, `product_id` or `product_ids` for a delete) and repaints. This client keeps no catalog:
 *   `catalog` commands read it live. So nothing is stored; the change is reported.
 * - **`oneone` / `remove_reminder11`**. The Web removes the reminder (`reminderId`) from the conversation's board. This
 *   removes the row `sync-boards` stored for it, from whichever end of the DM it was stored under, and reports it.
 * - **`oneone` / `create_reminder11`, `update_reminder11`** (seen live, key names only). The Web inserts or updates the
 *   reminder on the conversation's board from the control's own reminder object (`reminderId`, `creatorUid`, `toUid`,
 *   `editorUid`, `emoji`, `params` with the title, `startTime`, `duration`, `repeat`, `color`, `createTime`,
 *   `editTime`). This writes the row `sync-boards` would write (under the other end of the DM, type `dm`) and reports
 *   it. Not verified against a live payload: the field names are the Web's.
 * - **`my_settings` / `update`**. The Web merges the changed settings into its store. This reports them as a
 *   `settings_changed` event (`listen --events settings`); nothing is stored.
 * - **`user_devices` / `update_user_devices`**. The Web's trusted-device module checks the new, signed device list it
 *   carries (`devices`) against its own identity, and may sign itself out if it is no longer on it. This client does
 *   not verify that list; it logs one line every time (a device signed in or out is worth seeing whether or not anyone
 *   asked for the event) and reports it. `account devices` reads the current list.
 *
 * - **`mute` / `set`, `unset`** (seen live, key names only: `toId`, `muteType`, `duration`, `startTime`, `systemTime`,
 *   `advanced`). Zalo PC (26.10.20, `_processMuteConversations`) keeps the last control per `toId`, reads `muteType` 1
 *   as a DM and anything else as a group, drops a `set` whose `duration` (seconds, -1 for "until turned back on") has
 *   already run out since `systemTime`, and hands the rest to its mute store. This client keeps no mute list
 *   (`conv muted` reads it live): it reports a `mute_changed` event per conversation.
 * - **`label_convers` / `update`** (no data). Zalo PC refetches its labels (`syncLabelFromServer`). This reports a
 *   `labels_changed` event; `label list` reads them.
 * - **`archived_chat` / `update`** (`{version, actionType, items}`). Zalo PC, when `version` is newer than its own,
 *   refetches the archived list and repaints the conversations in `items` (`{id, type: 1 group}`). This reports an
 *   `archived_changed` event (`actionType` 0 moved them to Other, 1 back, as `conv archive` sends it).
 * - **`quick_message` / `create`, `update`, `delete`** (`{items, version}`). Zalo PC applies the items to its quick
 *   message store. This reports a `quick_messages_changed` event; `quick-msg list` reads them.
 * - **`conv_settings` / `update_ttl`** (`{threadId, ttl, fromId, isGroup, ts}`). Zalo PC stores the conversation's new
 *   auto-delete time and adds a local "auto-delete set" line to the conversation. This client writes no message rows
 *   of its own (AGENTS.md §13): it reports an `auto_delete_changed` event; `conv auto-delete-status` reads it.
 *
 * Only key names were ever seen for these controls (`unknown-acts.json`), never values, so an event names the fields
 * the Web reads and carries the control's own data whole under `control`. The device list's signed identity material
 * (`encIdentity`, `encAccSign`) is removed from it first, as `account devices` never prints it.
 *
 * A control can come twice (live, then again in a replayed `603` page): one already seen (by its action id) is skipped.
 * `listen` and `mcp start` both build one (AGENTS.md §13); only `listen` prints the events.
 */
import { removeReminder, upsertReminder } from "./db.js";
import { describeSettingChanges } from "./profile-settings.js";
import { readControls } from "../zalo/queues/control-queue.js";

/** The control push that carries them. */
export const CMD_PUSH_CONTROLS = 601;

/** How many action ids are remembered to skip a control seen twice. */
const SEEN_MAX = 500;

/** Keys of the device list that are signed identity material, never passed on. */
const SECRET_KEYS = new Set(["encIdentity", "encAccSign"]);

/** A copy of `value` without the keys in {@link SECRET_KEYS}, at any depth. */
export function withoutSecrets(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => withoutSecrets(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (!SECRET_KEYS.has(k)) out[k] = withoutSecrets(v, depth + 1);
    }
    return out;
}

const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

/**
 * A catalog control as an event. The ids are the ones the Web reads for each act.
 *
 * @param {{act: string, data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function catalogEvent(c) {
    const d = c.data || {};
    const item = d.item && typeof d.item === "object" ? d.item : null;
    const isCatalog = /catalog/.test(c.act);
    const productIds = Array.isArray(d.product_ids)
        ? d.product_ids.map(String)
        : [str(d.product_id) ?? (!isCatalog ? str(item?.product_id) : null)].filter(Boolean);
    return {
        event: "catalog_changed",
        act: c.act,
        catalogId: str(d.catalog_id) ?? (isCatalog ? str(item?.id) : str(item?.catalog_id)),
        productIds,
        ts: c.ts,
        control: c.data,
    };
}

/**
 * A device-list control as an event.
 *
 * @param {{data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function devicesEvent(c) {
    const companions = c.data?.devices?.companions;
    return {
        event: "devices_changed",
        companions: Array.isArray(companions) ? companions.length : null,
        ts: c.ts,
        control: withoutSecrets(c.data),
    };
}

/**
 * A `my_settings` control (this account's own settings changed on another device) as an event: the changed keys as
 * Zalo names them under `settings`, and each one this client knows under `changed`, with its `profile set` name
 * (src/core/profile-settings.js). Zalo Web merges the same `data` into its settings store.
 *
 * @param {{act: string, data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function settingsEvent(c) {
    const settings = c.data && typeof c.data === "object" ? c.data : {};
    return {
        event: "settings_changed",
        act: c.act,
        changed: describeSettingChanges(settings),
        settings,
        ts: c.ts,
    };
}

/**
 * The conversation a DM reminder belongs to: the end of it that is not this account. The control names the creator
 * (`creatorUid`) and the other end (`toUid`).
 *
 * @param {object} d - the control's data
 * @param {string|null} ownId
 * @returns {string|null}
 */
export function reminderThreadOf(d, ownId) {
    const to = str(d?.toUid);
    const creator = str(d?.creatorUid);
    if (to && to !== String(ownId)) return to;
    if (creator && creator !== String(ownId)) return creator;
    return to ?? creator;
}

/** A control's `params` (JSON text or an object) read as an object, or null. */
function paramsOf(d) {
    let params = d?.params;
    if (typeof params === "string") {
        try {
            params = JSON.parse(params);
        } catch {
            params = null;
        }
    }
    return params && typeof params === "object" ? params : null;
}

/**
 * The reminder row a `create_reminder11` / `update_reminder11` control describes, in the shape `sync-boards` stores
 * (src/core/sync-v2/board.js `normalizeReminder`), or null without an id or a conversation.
 *
 * @param {object} d - the control's data
 * @param {string|null} threadId - the DM it belongs to
 * @returns {object|null}
 */
export function reminderRowOf(d, threadId) {
    const reminderId = str(d?.reminderId ?? d?.id);
    if (!reminderId || !threadId) return null;
    return {
        reminderId,
        threadId,
        threadType: "dm",
        title: str(paramsOf(d)?.title),
        creatorId: str(d.creatorUid ?? d.creatorId),
        createTime: d.createTime,
        editTime: d.editTime,
        startTime: d.startTime,
        duration: d.duration,
        repeatMode: d.repeat,
        emoji: str(d.emoji),
        color: d.color,
        eventType: d.eventType ?? d.type,
        raw_data: d,
    };
}

/** A number, or null for anything that is not one. */
const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** A thread type from a group flag. */
const threadTypeOf = (isGroup) => (isGroup ? "group" : "dm");

/**
 * The `mute_changed` events of one frame's `mute` controls, as Zalo PC reads them: the last control per conversation
 * wins, `muteType` 1 is a DM and anything else a group, and a `set` whose time has already run out changes nothing.
 *
 * @param {Array<{act: string, data: object|null, ts: number|null}>} controls - the frame's `mute` controls, in order
 * @param {number} [nowMs]
 * @returns {object[]}
 */
export function muteEvents(controls, nowMs = Date.now()) {
    const last = new Map();
    for (const c of controls) {
        const toId = str(c.data?.toId);
        if (toId && (c.act === "set" || c.act === "unset")) last.set(toId, c);
    }
    const out = [];
    for (const [threadId, c] of last) {
        const d = c.data;
        const muted = c.act === "set";
        const duration = num(d.duration);
        const since = num(d.startTime) ?? num(d.systemTime);
        let until = null;
        if (muted && duration !== null && duration !== -1) {
            const systemTime = num(d.systemTime);
            if (systemTime !== null && Math.round(nowMs / 1000) - systemTime > duration) continue;
            if (since !== null) until = (since + duration) * 1000;
        }
        out.push({
            event: "mute_changed",
            threadId,
            threadType: num(d.muteType) === 1 ? "dm" : "group",
            muted,
            duration: muted ? duration : null,
            until,
            ts: c.ts,
            control: d,
        });
    }
    return out;
}

/**
 * An `archived_chat/update` control as an event.
 *
 * @param {{data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function archivedEvent(c) {
    const d = c.data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    const actionType = num(d.actionType);
    return {
        event: "archived_changed",
        archived: actionType === 0 ? true : actionType === 1 ? false : null,
        threads: items
            .filter((i) => i && str(i.id))
            .map((i) => ({ threadId: String(i.id), threadType: threadTypeOf(num(i.type) === 1) })),
        version: num(d.version),
        ts: c.ts,
        control: c.data,
    };
}

/**
 * A `quick_message` control as an event.
 *
 * @param {{act: string, data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function quickMessageEvent(c) {
    const d = c.data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    return {
        event: "quick_messages_changed",
        act: c.act,
        quickMessageIds: items.map((i) => str(i?.id)).filter(Boolean),
        version: num(d.version),
        ts: c.ts,
        control: c.data,
    };
}

/**
 * A `conv_settings/update_ttl` control as an event. `ttl` is in milliseconds, 0 for off, as `conv auto-delete` sends it.
 *
 * @param {{data: object|null, ts: number|null}} c
 * @returns {object}
 */
export function autoDeleteEvent(c) {
    const d = c.data || {};
    const isGroup = d.isGroup === true || d.isGroup === 1 || d.isGroup === "1" || d.isGroup === "true";
    return {
        event: "auto_delete_changed",
        threadId: str(d.threadId),
        threadType: threadTypeOf(isGroup),
        ttl: num(d.ttl),
        by: str(d.fromId),
        ts: num(d.ts) ?? c.ts,
        control: c.data,
    };
}

/**
 * Apply and report the controls of one `601` frame.
 *
 * @param {object} args
 * @param {object|null|undefined} args.data - the frame's data
 * @param {string|null} [args.ownId]
 * @param {Set<string>} [args.seen] - action ids already handled (updated)
 * @param {typeof removeReminder} [args.remove]
 * @param {typeof upsertReminder} [args.upsert]
 * @param {(line: string) => void} [args.say]
 * @param {() => number} [args.now] - to tell a mute that has already run out
 * @returns {object[]} the events, in the frame's order (a frame's mute changes come last, one per conversation)
 */
export function applyControlEvents({
    data,
    ownId = null,
    seen = new Set(),
    remove = removeReminder,
    upsert = upsertReminder,
    say = () => {},
    now = Date.now,
}) {
    const out = [];
    // A frame's mute controls are read together, as Zalo PC does: the last one per conversation wins.
    const mutes = [];
    // One frame (a control replay can carry many) says "the device list changed" once, with a count.
    let deviceChanges = 0;
    let lastDevices = null;
    for (const c of readControls(data)) {
        if (c.handler !== "control-events") continue;
        if (c.actionId) {
            if (seen.has(c.actionId)) continue;
            seen.add(c.actionId);
            if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
        }
        if (c.kind === "catalog") {
            out.push(catalogEvent(c));
        } else if (c.kind === "mute") {
            mutes.push(c);
        } else if (c.kind === "labels") {
            if (c.act === "update") out.push({ event: "labels_changed", ts: c.ts });
        } else if (c.kind === "archived") {
            if (c.act === "update" && c.data) out.push(archivedEvent(c));
        } else if (c.kind === "quick-message") {
            if (["create", "update", "delete"].includes(c.act) && c.data) out.push(quickMessageEvent(c));
        } else if (c.kind === "auto-delete") {
            if (c.data) out.push(autoDeleteEvent(c));
        } else if (c.kind === "settings") {
            out.push(settingsEvent(c));
        } else if (c.kind === "devices") {
            const ev = devicesEvent(c);
            deviceChanges++;
            lastDevices = ev;
            out.push(ev);
        } else if (c.kind === "reminder" && c.act !== "remove_reminder11") {
            const d = c.data || {};
            const threadId = reminderThreadOf(d, ownId);
            const row = reminderRowOf(d, threadId);
            let stored = false;
            if (row) {
                try {
                    upsert(row);
                    stored = true;
                } catch (e) {
                    say(`could not store reminder ${row.reminderId}: ${e?.message || e}`);
                }
            }
            const created = c.act === "create_reminder11";
            out.push({
                event: created ? "reminder_created" : "reminder_updated",
                threadId,
                reminderId: row?.reminderId ?? str(d.reminderId ?? d.id),
                by: created ? str(d.creatorUid) : (str(d.editorUid) ?? str(d.creatorUid)),
                title: row?.title ?? null,
                emoji: str(d.emoji),
                startTime: Number(d.startTime) || null,
                stored,
                ts: c.ts,
                control: c.data,
            });
        } else if (c.kind === "reminder") {
            const d = c.data || {};
            const reminderId = str(d.reminderId ?? d.id);
            let threadId = reminderThreadOf(d, ownId);
            let removed = 0;
            if (reminderId) {
                try {
                    const r = remove(reminderId, [str(d.toUid), str(d.creatorUid)]);
                    removed = r.removed;
                    if (r.threadIds.length) threadId = r.threadIds[0];
                } catch (e) {
                    say(`could not remove reminder ${reminderId}: ${e?.message || e}`);
                }
            }
            const title = str(paramsOf(d)?.title);
            out.push({
                event: "reminder_removed",
                threadId,
                reminderId,
                removedBy: str(d.editorUid) ?? str(d.creatorUid),
                title,
                emoji: str(d.emoji),
                stored: removed > 0,
                ts: c.ts,
                control: c.data,
            });
        }
    }
    if (mutes.length) out.push(...muteEvents(mutes, now()));
    if (deviceChanges) {
        say(
            "the account's device list changed" +
                (deviceChanges > 1 ? ` (${deviceChanges} controls)` : "") +
                " (a device signed in or out" +
                (lastDevices.companions === null ? "" : `; ${lastDevices.companions} companion device(s) now`) +
                "); `zalo-agent account devices` lists them",
        );
    }
    return out;
}

/** The `listen --events` kind each event is printed under (none is in the default set). */
export const CONTROL_EVENT_KINDS = Object.freeze({
    catalog_changed: "catalog",
    reminder_created: "reminder",
    reminder_updated: "reminder",
    reminder_removed: "reminder",
    devices_changed: "devices",
    settings_changed: "settings",
    mute_changed: "conversation",
    labels_changed: "conversation",
    archived_changed: "conversation",
    auto_delete_changed: "conversation",
    quick_messages_changed: "quick-message",
});

/** A ttl in milliseconds as a person reads it: off, or days, or hours. */
function ttlText(ms) {
    if (!ms) return "off";
    const days = ms / 86_400_000;
    return Number.isInteger(days) ? `${days}d` : `${Math.round(ms / 3_600_000)}h`;
}

/**
 * One event of {@link applyControlEvents} as the line `listen` prints for it.
 *
 * @param {object} ev
 * @returns {string}
 */
export function describeControlEvent(ev) {
    switch (ev.event) {
        case "catalog_changed":
            return `Catalog: ${ev.act} (catalog ${ev.catalogId ?? "?"})`;
        case "reminder_created":
            return `Reminder created: ${ev.title ?? ev.reminderId ?? "?"} in ${ev.threadId ?? "?"}`;
        case "reminder_updated":
            return `Reminder edited: ${ev.title ?? ev.reminderId ?? "?"} in ${ev.threadId ?? "?"}`;
        case "reminder_removed":
            return `Reminder removed: ${ev.reminderId ?? "?"} in ${ev.threadId ?? "?"}`;
        case "devices_changed":
            return "The account's device list changed — see `zalo-agent account devices`";
        case "settings_changed":
            return `Settings changed on another device: ${
                ev.changed.map((c) => `${c.setting}=${c.value}`).join(", ") || Object.keys(ev.settings).join(", ")
            }`;
        case "mute_changed":
            return ev.muted
                ? `Muted: ${ev.threadId} (${ev.until ? `until ${new Date(ev.until).toLocaleString()}` : "until unmuted"})`
                : `Unmuted: ${ev.threadId}`;
        case "labels_changed":
            return "Conversation labels changed on another device — see `zalo-agent label list`";
        case "archived_changed":
            return `${{ true: "Moved to Other (archived)", false: "Moved back from Other" }[ev.archived] ?? "Archived list changed"}: ${
                ev.threads.map((t) => t.threadId).join(", ") || "?"
            }`;
        case "auto_delete_changed":
            return `Auto-delete in ${ev.threadId ?? "?"} set to ${ttlText(ev.ttl)}`;
        case "quick_messages_changed":
            return `Quick message ${ev.act}d: ${ev.quickMessageIds.join(", ") || "?"} — see \`zalo-agent quick-msg list\``;
        default:
            return ev.event;
    }
}

/**
 * Handle these controls from a socket tap, for one account.
 *
 * @param {object} args
 * @param {{on: (cmd: number, fn: (frame: object) => void) => () => void}} args.tap
 * @param {string|null} [args.ownId] - this account's id, to tell the two ends of a DM reminder apart
 * @param {(event: object) => void} [args.onEvent] - told every event (`listen` prints them)
 * @param {(line: string) => void} [args.log]
 * @param {typeof removeReminder} [args.remove] - test seam
 * @param {typeof upsertReminder} [args.upsert] - test seam
 * @returns {{stop: () => void}}
 */
export function attachControlEvents({
    tap,
    ownId = null,
    onEvent = () => {},
    log = (line) => console.error(line),
    remove = removeReminder,
    upsert = upsertReminder,
}) {
    const say = (line) => {
        try {
            log(`controls: ${line}`);
        } catch {
            /* a broken logger must not break the socket */
        }
    };
    const seen = new Set();
    const off = tap.on(CMD_PUSH_CONTROLS, (frame) => {
        let events = [];
        try {
            events = applyControlEvents({ data: frame?.data, ownId, seen, remove, upsert, say });
        } catch (e) {
            say(`could not read a control frame: ${e?.message || e}`);
        }
        for (const ev of events) {
            try {
                onEvent(ev);
            } catch (e) {
                say(`an event handler failed: ${e?.message || e}`);
            }
        }
    });
    return { stop: off };
}
