/**
 * `group settings` as a read-modify-write.
 *
 * Zalo's setting update (GET {group}/api/group/setting/update, cmd 11816) takes
 * the group's WHOLE setting object. Nothing in it means "leave this alone", so
 * a field sent wrong is a field changed. The command used to send `opts.X ??
 * false` for its eight toggles, which turned every toggle the user did not name
 * OFF. zca-js's `updateGroupSettings` then sent `setTopicOnly` (never exposed
 * by the CLI) as 0, left `addMemberOnly` out, and hard-coded `bannFeature: 0,
 * dirtyMedia: 0, banDuration: 0, blocked_members: []` on every call.
 *
 * What Zalo Web sends instead (bundle 1.e0ef5e98f8f9d8970e2c.js, 2026-09-29
 * capture; byte offsets into that file):
 *
 *   ~10948180  the request builder: `{...setting, grid, imei}`, AES-encrypted
 *              into `params=` on a GET. The same request zca-js builds.
 *   ~4235006   the settings panel: its state starts as
 *              `{...groupInfo.setting, blocked_members: []}` and is refreshed
 *              from a forced re-read of the group.
 *   ~4238633   `_setGroup`: `Object.assign({}, this.state)`, flip ONE key,
 *              send the lot.
 *   ~6778552   the member-list "hide members" toggle:
 *              `{...getSettingsGroup(gid), lockViewMember}`, and it sends
 *              nothing when there are no settings to spread.
 *   ~4300286   after success the web stores what it sent as the group's new
 *              setting, wholesale. It treats the request as a full replace.
 *
 * So this module does the same: read the current setting, overlay only the
 * changes the user asked for, send everything else back as Zalo reported it —
 * including keys this CLI does not know. It refuses rather than guess: no
 * change asked for, or a setting it could not read completely, and nothing is
 * sent.
 *
 * Two fields needed a decision:
 *
 *   blocked_members — NOT sent. The panel sends `[]` (its state never holds
 *   the real list: that lives in a separate hook, ~4185295); the member-list
 *   toggle omits the key altogether; nothing in the web ever sends a populated
 *   list. So the server accepts a request without it. Omitting it is safe under
 *   every reading of the field under which `[]` is safe, and also under the
 *   one where `[]` means "replace the block list with nothing". Unverified live.
 *
 *   addMemberOnly — carried at its current value, as both web paths do.
 *   zca-js comments it out ("very tricky, any idea?"); the web never changes it
 *   directly, and its panel shows join approval as on when either it or
 *   joinAppr is set.
 *
 * `dirtyMedia`/`banDuration` are Zalo's own media-ban state (the web's banned
 * group manager, ~3673605, reads them to hide media: `dirtyMedia` 1 or 2 is
 * banned, `banDuration` is seconds). `bannFeature` never appears in the web
 * bundles by name. All three are sent back exactly as read.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let _utils = null;
/** zca-js internals, located the same way ./sync-v2/gid.js does. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * CLI flag -> the GroupSetting key it toggles. Each flag also has a `--no-`
 * form. `topic-only` is Zalo Web's ONLY_ADMIN_SET_TOPIC: when 1, only the
 * owner and admins can pin messages, notes and polls to the top of the chat
 * (the web's `checkAuth` denies a plain member `allowPin` then, ~2668943).
 */
export const SETTING_FLAGS = Object.freeze({
    "block-name": "blockName",
    "sign-admin": "signAdminMsg",
    "msg-history": "enableMsgHistory",
    "join-appr": "joinAppr",
    "lock-post": "lockCreatePost",
    "lock-poll": "lockCreatePoll",
    "lock-msg": "lockSendMsg",
    "lock-view-member": "lockViewMember",
    "topic-only": "setTopicOnly",
});

/**
 * Every field of zca-js's `GroupSetting` (models/Group.d.ts, none optional).
 * Each one is sent back verbatim, so each one has to have been read: a setting
 * missing any of them is refused. If a live read shows Zalo legitimately omits
 * one, relax it here and in tests/unit/group-settings.test.js together.
 */
export const GROUP_SETTING_FIELDS = Object.freeze([
    "blockName",
    "signAdminMsg",
    "addMemberOnly",
    "setTopicOnly",
    "enableMsgHistory",
    "joinAppr",
    "lockCreatePost",
    "lockCreatePoll",
    "lockSendMsg",
    "lockViewMember",
    "bannFeature",
    "dirtyMedia",
    "banDuration",
]);

/** The refusal for an invocation that names no setting. */
export const NOTHING_TO_CHANGE =
    "nothing to change: pass at least one setting flag, e.g. --join-appr or --no-join-appr " +
    "(`group info <groupId>` shows the current settings); nothing was sent";

/** Commander's option key for a flag: "lock-view-member" -> "lockViewMember". */
const optionKey = (flag) => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** A toggle as Zalo stores it. */
const bit = (value) => (Number(value) ? 1 : 0);

/**
 * The setting changes the user actually asked for.
 *
 * Commander leaves an option undefined when neither `--X` nor `--no-X` was
 * typed (`--X` is declared first, so it has no default). That undefined is the
 * whole difference between "leave it" and "turn it off", so it must never be
 * collapsed into false.
 *
 * @param {object} opts - the `group settings` Commander options
 * @returns {Record<string, 0|1>} GroupSetting key -> requested value, only for flags given
 */
export function settingChangesFromOptions(opts) {
    const changes = {};
    for (const [flag, key] of Object.entries(SETTING_FLAGS)) {
        const value = opts?.[optionKey(flag)];
        if (value === undefined) continue;
        changes[key] = value ? 1 : 0;
    }
    return changes;
}

/**
 * The group's current setting object, exactly as Zalo reports it.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} groupId
 * @returns {Promise<object>} a copy of `gridInfoMap[groupId].setting`
 * @throws {Error} when the setting cannot be read completely
 */
export async function readGroupSetting(api, groupId) {
    const refuse = (why) =>
        new Error(`could not read the current settings of group ${groupId} (${why}); nothing was sent`);
    let info;
    try {
        info = await api.getGroupInfo([groupId]);
    } catch (e) {
        throw refuse(e.message);
    }
    const entry = info?.gridInfoMap?.[groupId];
    if (!entry) throw refuse("Zalo's answer does not include this group");
    const setting = entry.setting;
    if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
        throw refuse("Zalo returned no setting object");
    }
    const missing = GROUP_SETTING_FIELDS.filter((key) => setting[key] === undefined || setting[key] === null);
    if (missing.length) {
        throw refuse(`missing ${missing.join(", ")}; sending the update without them could reset them`);
    }
    return { ...setting };
}

/**
 * Send a complete setting object: zca-js's updateGroupSettings request, minus
 * the fields it hard-codes. Same endpoint, same service, same envelope.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} groupId
 * @param {object} setting - the full setting to store
 * @returns {Promise<*>} Zalo's `data` (an empty string for this endpoint)
 */
function sendGroupSetting(api, groupId, setting) {
    const zu = zcaUtils();
    const base = `${api.zpwServiceMap.group[0]}/api/group/setting/update`;
    const call = zu.apiFactory()((_api, ctx, utils) => async () => {
        const params = { ...setting, grid: groupId, imei: ctx.imei };
        const enc = utils.encodeAES(JSON.stringify(params));
        if (!enc) throw new Error("failed to encrypt group setting params");
        const resp = await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" });
        return utils.resolve(resp);
    })(api.getContext(), api);
    return call();
}

/**
 * Change the named settings of a group and send every other field back as it was.
 *
 * Refuses, sending nothing, when no change is asked for or the current setting
 * cannot be read completely. When every requested value is already in place
 * nothing is sent either — that is reported, not refused.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} groupId
 * @param {Record<string, 0|1>} changes - from settingChangesFromOptions()
 * @returns {Promise<{groupId: string, sent: boolean, changed: object, unchanged: object, settings: object,
 *   response?: *, verified?: boolean, sideEffects?: object, notApplied?: object}>}
 *   `changed` maps key -> {from, to}; `unchanged` maps key -> the value it already had;
 *   `settings` is the full setting as sent (or as found, when nothing was sent). After a
 *   send, the group is read back: `verified` says whether that worked, `sideEffects`
 *   maps key -> {from, to} for fields Zalo changed on its own, and `notApplied` maps
 *   key -> {asked, now} for a requested change that did not stick
 */
export async function applyGroupSettingChanges(api, groupId, changes) {
    const requested = Object.entries(changes ?? {});
    if (requested.length === 0) throw new Error(NOTHING_TO_CHANGE);

    const current = await readGroupSetting(api, groupId);
    const changed = {};
    const unchanged = {};
    for (const [key, to] of requested) {
        if (bit(current[key]) === to) unchanged[key] = to;
        else changed[key] = { from: current[key], to };
    }
    if (Object.keys(changed).length === 0) {
        return { groupId, sent: false, changed, unchanged, settings: current };
    }

    // Overlay only what actually changes, so an already-set toggle keeps the
    // exact value Zalo reported rather than our 0/1 rendering of it.
    const settings = { ...current };
    for (const [key, { to }] of Object.entries(changed)) settings[key] = to;
    const response = await sendGroupSetting(api, groupId, settings);

    // Read back what Zalo now holds. Measured live 2026-09-30: turning join
    // approval on also set addMemberOnly, which we had sent at its current 0,
    // and turning it off cleared both — a change the command could not report
    // without looking. Best-effort: the write already went out.
    const sideEffects = {};
    const notApplied = {};
    let verified = false;
    try {
        const after = await readGroupSetting(api, groupId);
        verified = true;
        for (const key of new Set([...Object.keys(settings), ...Object.keys(after)])) {
            if (key in changed) {
                if (bit(after[key]) !== changed[key].to) notApplied[key] = { asked: changed[key].to, now: after[key] };
            } else if (JSON.stringify(after[key]) !== JSON.stringify(settings[key])) {
                sideEffects[key] = { from: settings[key], to: after[key] };
            }
        }
    } catch {
        /* the read-back failed; `verified` stays false */
    }
    return { groupId, sent: true, changed, unchanged, settings, response, verified, sideEffects, notApplied };
}
