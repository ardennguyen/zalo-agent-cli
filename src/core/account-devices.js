/**
 * The account's linked devices, as `account devices` prints them.
 *
 * Zalo's device list (zca-js `getListDevice`) names one primary device, the phone (`masterId`), and the companions
 * linked to it: the PC and web clients, and this CLI once it has logged in with the official QR flow (it is a trusted
 * companion device, see docs/agent-notes.md). A companion is `{id, linkId, platform, status, expireTs, encIdentity,
 * encAccSign}`; the last two are the signed identity material, which is never printed.
 *
 * This client is the companion whose `id` is the `companionId` saved in `trusted-device.json`: the list says which
 * entry is this CLI, so a person can tell it from the web and PC entries, and can see after a logout or a purge that the
 * phone still lists it until it is removed there.
 */

/** Zalo's name for a companion's platform, as far as it is known: the codes are the server's, the names are not. */
const PLATFORM_NAMES = new Map();

/**
 * One companion, reduced to what a person can use.
 *
 * @param {object} c - an entry of `devices.companions`
 * @param {{companionId?: number|string|null}} [mine] - this client's saved identity
 * @returns {{id: number|string|null, platform: number|string|null, platformName: string|null, status: number|null,
 *   expires: number|null, thisClient: boolean}} `expires` is a Unix time in milliseconds, or null for no expiry
 */
export function summarizeCompanion(c, mine = {}) {
    const expireTs = Number(c?.expireTs);
    const platform = c?.platform ?? null;
    return {
        id: c?.id ?? null,
        platform,
        platformName: PLATFORM_NAMES.get(Number(platform)) ?? null,
        status: Number.isFinite(Number(c?.status)) ? Number(c.status) : null,
        expires: Number.isFinite(expireTs) && expireTs > 0 ? expireTs : null,
        thisClient:
            mine?.companionId !== undefined &&
            mine?.companionId !== null &&
            c?.id !== undefined &&
            String(c.id) === String(mine.companionId),
    };
}

/**
 * The lines of `account devices`, for a person.
 *
 * @param {object|null|undefined} devices - `getListDevice().devices`
 * @param {{companionId?: number|string|null}} [mine]
 * @returns {string[]}
 */
export function describeDevices(devices, mine = {}) {
    if (!devices) return ["No device data returned."];
    const lines = [];
    if (devices.masterId) lines.push(`Primary device (the phone): ${devices.masterId}`);
    if (devices.lastUpdateTs)
        lines.push(`List last updated:           ${new Date(devices.lastUpdateTs).toLocaleString()}`);
    const companions = (devices.companions || []).map((c) => summarizeCompanion(c, mine));
    if (!companions.length) {
        lines.push("No companion devices are linked to this account.");
        return lines;
    }
    lines.push(`Linked companion devices (${companions.length}):`);
    for (const c of companions) {
        const bits = [
            `#${c.id}`,
            c.platformName ? `${c.platformName} (platform ${c.platform})` : `platform ${c.platform}`,
        ];
        bits.push(c.status === 1 ? "active" : `status ${c.status}`);
        bits.push(c.expires ? `expires ${new Date(c.expires).toLocaleString()}` : "no expiry");
        lines.push(`  - ${bits.join(", ")}${c.thisClient ? "   <- this CLI" : ""}`);
    }
    if (!companions.some((c) => c.thisClient) && (mine?.companionId ?? null) !== null) {
        lines.push(
            "This CLI's saved companion identity is not in the list (it was removed on the phone, or the login was reset).",
        );
    }
    return lines;
}
