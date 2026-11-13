/**
 * The account's privacy settings and profile fields, as `profile` (src/commands/profile.js) and the MCP tool
 * `zalo_profile` read and write them: both call the functions here, so both answer the same JSON.
 */

/**
 * The settings `profile set` changes, by the name the CLI and `zalo_profile` use: Zalo's key as `getSettings` reads
 * it (`key`), the key `/api/setting/update` takes when it differs (`writeKey`; the Focused/Other switch is written
 * as `archivedChatStatus` and read back as `archived_chat_status`), a label, and the values with their
 * meaning.
 */
export const SETTING_MAP = {
    "online-status": {
        key: "show_online_status",
        label: "Show online status",
        values: { 0: "hidden", 1: "visible" },
    },
    "seen-status": {
        key: "display_seen_status",
        label: "Display seen status",
        values: { 0: "hidden", 1: "visible" },
    },
    birthday: {
        key: "view_birthday",
        label: "Birthday visibility",
        values: { 0: "hidden", 1: "full (day/month/year)", 2: "partial (day/month)" },
    },
    "receive-msg": {
        key: "receive_message",
        label: "Receive messages from",
        values: { 1: "everyone", 2: "friends only" },
    },
    "accept-call": {
        key: "accept_stranger_call",
        label: "Accept calls from",
        values: { 2: "friends only", 3: "everyone", 4: "friends + contacted" },
    },
    "add-by-phone": {
        key: "add_friend_via_phone",
        label: "Find by phone number",
        values: { 0: "disabled", 1: "enabled" },
    },
    "add-by-qr": {
        key: "add_friend_via_qr",
        label: "Find by QR code",
        values: { 0: "disabled", 1: "enabled" },
    },
    "add-by-group": {
        key: "add_friend_via_group",
        label: "Find via group",
        values: { 0: "disabled", 1: "enabled" },
    },
    "add-by-card": {
        key: "add_friend_via_contact",
        label: "Find via a shared contact card",
        values: { 0: "disabled", 1: "enabled" },
    },
    recommend: {
        key: "display_on_recommend_friend",
        label: "Show in friend recommendations",
        values: { 0: "disabled", 1: "enabled" },
    },
    "focused-tabs": {
        key: "archived_chat_status",
        writeKey: "archivedChatStatus",
        label: "Focused and Other tabs",
        values: { 0: "off (one list)", 1: "on (Focused and Other)" },
    },
};

/**
 * Settings `profile settings` shows but `profile set` does not change: Zalo only reads the first two, and quick
 * messages are switched with `quick-msg enable|disable` (written as `quickMessageStatus`).
 */
export const READ_ONLY_SETTINGS = {
    "stranger-messages": {
        key: "setting_show_stranger_msg_directly",
        label: "Show strangers' messages directly",
        values: { 0: "no (message requests)", 1: "yes" },
    },
    "two-factor": {
        key: "setting_2FA_status",
        label: "Two-factor authentication",
        values: { 0: "off", 1: "on" },
    },
    "quick-messages": {
        key: "quick_message_status",
        label: "Quick messages",
        values: { 0: "off", 1: "on" },
        changeWith: "quick-msg enable|disable",
    },
};

/** The key `/api/setting/update` takes for quick messages (`updateSettings({quickMessageStatus})`). */
export const QUICK_MESSAGE_WRITE_KEY = "quickMessageStatus";

/**
 * A setting's value as a number: Zalo answers a bool for some settings, which is 1 or 0 here.
 *
 * @param {unknown} raw
 * @returns {number|string|null}
 */
export function settingValue(raw) {
    if (raw === true) return 1;
    if (raw === false) return 0;
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : String(raw);
}

/** One row of {@link describeSettings}. */
function settingRow(setting, meta, raw) {
    const value = settingValue(raw?.[meta.key]);
    return {
        setting,
        key: meta.key,
        label: meta.label,
        value,
        meaning: value === null ? null : (meta.values[value] ?? null),
        ...(meta.changeWith && { changeWith: meta.changeWith }),
    };
}

/**
 * `getSettings()` as `profile settings` and `zalo_profile` `settings` report it: the settings `profile set` changes,
 * the read-only ones, and every other key Zalo sent, as it sent it, under `other`.
 *
 * @param {object|null|undefined} raw - `getSettings()`
 * @returns {{settings: object[], readOnly: object[], other: object}}
 */
export function describeSettings(raw) {
    const res = raw && typeof raw === "object" ? raw : {};
    const settings = Object.entries(SETTING_MAP).map(([slug, meta]) => settingRow(slug, meta, res));
    const readOnly = Object.entries(READ_ONLY_SETTINGS).map(([slug, meta]) => settingRow(slug, meta, res));
    const mapped = new Set([...Object.values(SETTING_MAP), ...Object.values(READ_ONLY_SETTINGS)].map((m) => m.key));
    const other = Object.fromEntries(Object.entries(res).filter(([k]) => !mapped.has(k)));
    return { settings, readOnly, other };
}

/**
 * The settings a change names (a `my_settings` control's data), each one this client knows with its name, value and
 * meaning. A key is matched by the name Zalo reads it by or the one it writes it by.
 *
 * @param {object} changes - Zalo's keys and their new values
 * @returns {Array<{setting: string, key: string, value: number|string|null, meaning: string|null}>}
 */
export function describeSettingChanges(changes) {
    const out = [];
    const all = [...Object.entries(SETTING_MAP), ...Object.entries(READ_ONLY_SETTINGS)];
    for (const [key, raw] of Object.entries(changes || {})) {
        const hit =
            all.find(([, m]) => m.key === key || m.writeKey === key) ??
            (key === QUICK_MESSAGE_WRITE_KEY ? ["quick-messages", READ_ONLY_SETTINGS["quick-messages"]] : null);
        if (!hit) continue;
        const value = settingValue(raw);
        out.push({ setting: hit[0], key, value, meaning: value === null ? null : (hit[1].values[value] ?? null) });
    }
    return out;
}

/**
 * Why a `profile set` value is refused, or undefined when it is valid.
 *
 * @param {string} setting - a {@link SETTING_MAP} name
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function settingValueError(setting, value) {
    const meta = SETTING_MAP[setting];
    if (!meta) {
        const readOnly = READ_ONLY_SETTINGS[setting];
        if (readOnly) {
            return readOnly.changeWith
                ? `${setting} is changed with \`${readOnly.changeWith}\`, not \`profile set\`.`
                : `${setting} is read-only here: Zalo does not change it either.`;
        }
        return `Unknown setting: "${setting}". Valid: ${Object.keys(SETTING_MAP).join(", ")}.`;
    }
    const text = String(value ?? "");
    if (/^\d+$/.test(text) && Object.hasOwn(meta.values, String(Number(text)))) return undefined;
    const valid = Object.entries(meta.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    return `Invalid value for ${setting}. Valid: ${valid}.`;
}

/**
 * Change one setting (`profile set`, `zalo_profile` `set`). Zalo answers with an empty body, so the reply is what
 * was set.
 *
 * @param {object} api - logged-in session
 * @param {string} setting - a {@link SETTING_MAP} name
 * @param {number|string} value
 * @returns {Promise<{success: true, setting: string, value: number, meaning: string}>}
 * @throws {Error} for an unknown setting or value, before any request
 */
export async function updateSetting(api, setting, value) {
    const why = settingValueError(setting, value);
    if (why) throw new Error(why);
    const meta = SETTING_MAP[setting];
    const n = Number(value);
    await api.updateSettings(meta.writeKey ?? meta.key, n);
    return { success: true, setting, value: n, meaning: meta.values[n] };
}

/**
 * Turn quick messages on or off for this account (`quick-msg enable|disable`, `zalo_quick_message`
 * `enable`/`disable`), as Zalo's quick-message switch does: `/api/setting/update` with `quickMessageStatus`.
 * Unverified live.
 *
 * @param {object} api - logged-in session
 * @param {boolean} enabled
 * @returns {Promise<{success: true, enabled: boolean}>}
 */
export async function setQuickMessageStatus(api, enabled) {
    await api.updateSettings(QUICK_MESSAGE_WRITE_KEY, enabled ? 1 : 0);
    return { success: true, enabled: Boolean(enabled) };
}

/**
 * The `updateProfile` payload: Zalo takes the name, birthday and gender together, so the ones not being changed are
 * filled in from the current profile.
 *
 * @param {object} current - `fetchAccountInfo().profile`
 * @param {{name?: string, dob?: string, gender?: number|string}} change - dob as YYYY-MM-DD, gender 0 (male) or 1
 * @returns {{profile: {name: string, dob: string, gender: number}}}
 */
export function profileUpdatePayload(current, change) {
    const p = current || {};
    // Convert sdob (DD/MM/YYYY) to YYYY-MM-DD format required by API
    let currentDob = "2000-01-01";
    if (p.sdob) {
        const parts = p.sdob.split("/");
        if (parts.length === 3) currentDob = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return {
        profile: {
            name: change.name || p.displayName || p.zaloName,
            dob: change.dob || currentDob,
            gender: change.gender !== undefined ? Number(change.gender) : (p.gender ?? 0),
        },
    };
}
