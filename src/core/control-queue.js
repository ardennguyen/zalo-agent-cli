/**
 * The `601` control frames and the queues behind them (plan item X4).
 *
 * A `601` carries `controls[]`, each `{actionId, controlId, content: {act, act_type, data}}`, plus `queueStatus` with
 * the control queues' cursors: `603_1`, `603_0` and `604_0`, each `{ids, lastId}`. The Web client uses those
 * `lastId`s as the cursor of its next `603` pull, so that controls that arrived while it was offline (a group
 * event, an unread mark, a sync status) are fetched when it comes back.
 *
 * This client does not pull `603` yet: what the server answers has not been decoded in a session of ours (see
 * ./../zalo/pulls.js). What it does now is the groundwork that cannot lose anything:
 *
 *  - {@link readControls} sorts the controls of a frame by what they are, so a control nobody handles is named
 *    instead of vanishing;
 *  - {@link controlCursorsOf} reads the control queues' cursors, which the daemon keeps (forward only), so the
 *    pull has a cursor the day it exists.
 *
 * Nothing here acknowledges a control: acknowledging only what is safely stored is the rule (./queue-verify.js),
 * and the controls this client handles are acted on in memory, not stored.
 */

/** The control queues named in every `601` reply. */
export const CONTROL_QUEUES = Object.freeze(["603_1", "603_0", "604_0"]);

/**
 * What a control is, by `act_type` and `act`. The values come from the captured frames and from the handlers
 * this client already has (zca-js's `file_done`, `group`, `fr`; ./read-state.js's `mark_unread`; the sync status
 * frames).
 */
const KNOWN = new Map([
    ["transfer_sync2", { kind: "sync", handler: "sync-v2" }],
    ["mark_unread", { kind: "read-state", handler: "read-state" }],
    ["file_done", { kind: "upload", handler: "zca-js" }],
    ["group", { kind: "group-event", handler: "zca-js" }],
    ["fr", { kind: "friend-event", handler: "zca-js" }],
]);

/**
 * The controls of one `601` frame's `data`.
 *
 * @param {object|null|undefined} data - a decoded 601 frame's `data`
 * @returns {Array<{actionId: string|null, actType: string, act: string, kind: string, handler: string|null,
 *   handled: boolean}>} `handled` is false for a control this client has no handler for
 */
export function readControls(data) {
    const out = [];
    for (const c of Array.isArray(data?.controls) ? data.controls : []) {
        const content = c?.content;
        if (!content || typeof content !== "object") continue;
        const actType = String(content.act_type ?? "");
        const act = String(content.act ?? "");
        const known = KNOWN.get(actType) ?? KNOWN.get(act);
        out.push({
            actionId: c.actionId === undefined || c.actionId === null ? null : String(c.actionId),
            actType,
            act,
            kind: known?.kind ?? "unknown",
            handler: known?.handler ?? null,
            handled: Boolean(known),
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
