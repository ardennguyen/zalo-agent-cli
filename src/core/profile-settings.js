/**
 * The account's privacy settings and profile fields, as `profile` (src/commands/profile.js) and the MCP tool
 * `zalo_profile` read and write them.
 */

/** Valid privacy setting keys and their human-readable labels + value descriptions. */
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
    recommend: {
        key: "display_on_recommend_friend",
        label: "Show in friend recommendations",
        values: { 0: "disabled", 1: "enabled" },
    },
};

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
