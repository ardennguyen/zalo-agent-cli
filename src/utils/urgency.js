/**
 * Zalo's message urgency, as the apps' Important/Urgent option sends it.
 *
 * Zalo Web marks a text message `metaData: {urgency: 1}` (important) or
 * `metaData: {urgency: 2}` (urgent) on the ordinary send endpoints, group and
 * 1-1 alike; zca-js builds that object from `sendMessage({msg, urgency})` and
 * ignores any other value. `msg send --urgency` and `zalo_send_message`'s
 * `urgency` both map a name to the level here, so the two cannot drift.
 */

/** Zalo's message urgency levels, as the apps offer them. */
export const URGENCY_LEVELS = { important: 1, urgent: 2 };

/**
 * The level for an urgency name, or null for anything that is not one.
 *
 * Case and surrounding spaces are ignored, as `msg send --urgency` always has.
 * "normal" is not a level: an ordinary message carries no urgency at all.
 *
 * @param {string} value - `important` or `urgent`
 * @returns {number|null} 1 or 2, or null
 */
export function urgencyLevel(value) {
    return URGENCY_LEVELS[String(value).trim().toLowerCase()] || null;
}
