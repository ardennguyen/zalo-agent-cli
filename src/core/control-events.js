/**
 * Three `601` controls Zalo pushes about changes made on another device, which this client used to name as
 * unhandled: a product catalog changed, a DM reminder removed, the account's device list changed.
 *
 * What Zalo Web does with each (read in its bundle, 2026-11-06), and what this does:
 *
 * - **`prod_catalog`** (`add_prod`, `edit_prod`, `del_prod`, `del_list_prod`, `add_catalog`, `edit_catalog`,
 *   `del_catalog`, `enable_feature`). The Web applies the control's data to its catalog store (an `item` row for an add
 *   or an edit; `catalog_id`, `product_id` or `product_ids` for a delete) and repaints. This client keeps no catalog:
 *   `catalog` commands read it live. So nothing is stored; the change is reported.
 * - **`oneone` / `remove_reminder11`**. The Web removes the reminder (`reminderId`) from the conversation's board. This
 *   removes the row `sync-boards` stored for it, from whichever end of the DM it was stored under, and reports it.
 * - **`user_devices` / `update_user_devices`**. The Web's trusted-device module checks the new, signed device list it
 *   carries (`devices`) against its own identity, and may sign itself out if it is no longer on it. This client does
 *   not verify that list; it logs one line every time (a device signed in or out is worth seeing whether or not anyone
 *   asked for the event) and reports it. `account devices` reads the current list.
 *
 * Only key names were ever seen for these controls (`unknown-acts.json`), never values, so an event names the fields
 * the Web reads and carries the control's own data whole under `control`. The device list's signed identity material
 * (`encIdentity`, `encAccSign`) is removed from it first, as `account devices` never prints it.
 *
 * A control can come twice (live, then again in a replayed `603` page): one already seen (by its action id) is skipped.
 * `listen` and `mcp start` both build one (AGENTS.md §13); only `listen` prints the events.
 */
import { removeReminder } from "./db.js";
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

/**
 * Apply and report the controls of one `601` frame.
 *
 * @param {object} args
 * @param {object|null|undefined} args.data - the frame's data
 * @param {string|null} [args.ownId]
 * @param {Set<string>} [args.seen] - action ids already handled (updated)
 * @param {typeof removeReminder} [args.remove]
 * @param {(line: string) => void} [args.say]
 * @returns {object[]} the events, in the frame's order
 */
export function applyControlEvents({ data, ownId = null, seen = new Set(), remove = removeReminder, say = () => {} }) {
    const out = [];
    for (const c of readControls(data)) {
        if (c.handler !== "control-events") continue;
        if (c.actionId) {
            if (seen.has(c.actionId)) continue;
            seen.add(c.actionId);
            if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
        }
        if (c.kind === "catalog") {
            out.push(catalogEvent(c));
        } else if (c.kind === "devices") {
            const ev = devicesEvent(c);
            say(
                "the account's device list changed (a device signed in or out" +
                    (ev.companions === null ? "" : `; ${ev.companions} companion device(s) now`) +
                    "); `zalo-agent account devices` lists them",
            );
            out.push(ev);
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
            let title = null;
            let params = d.params;
            if (typeof params === "string") {
                try {
                    params = JSON.parse(params);
                } catch {
                    params = null;
                }
            }
            if (params && typeof params === "object") title = str(params.title);
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
    return out;
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
 * @returns {{stop: () => void}}
 */
export function attachControlEvents({
    tap,
    ownId = null,
    onEvent = () => {},
    log = (line) => console.error(line),
    remove = removeReminder,
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
            events = applyControlEvents({ data: frame?.data, ownId, seen, remove, say });
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
