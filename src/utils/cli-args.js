/**
 * Small argument parsers for the commands that wrap a zca-js call taking an
 * enum or a boolean: typing indicator, report, active status, language.
 *
 * Each throws an Error whose message says what was accepted, so the command's
 * catch block can print it as the usage error. None touches Zalo.
 */
import { ReportReason, UpdateLangAvailableLanguages } from "zca-js";

/**
 * `--type <n>`: 0 = user, 1 = group.
 *
 * @param {string|number} value
 * @returns {0|1}
 * @throws {Error} for anything else
 */
export function parseThreadTypeArg(value) {
    const s = String(value).trim();
    if (s === "0") return 0;
    if (s === "1") return 1;
    throw new Error(`--type must be 0 (user) or 1 (group), got "${value}"`);
}

/**
 * `on` / `off` (also true/false, 1/0, yes/no, enable/disable).
 *
 * @param {string} value
 * @param {string} [what] - the setting's name, for the error message
 * @returns {boolean}
 * @throws {Error} for anything else
 */
export function parseOnOff(value, what = "value") {
    const s = String(value).trim().toLowerCase();
    if (["on", "true", "1", "yes", "enable", "enabled"].includes(s)) return true;
    if (["off", "false", "0", "no", "disable", "disabled"].includes(s)) return false;
    throw new Error(`${what} must be "on" or "off", got "${value}"`);
}

/**
 * `vi` / `en`, as zca-js's `updateLang` takes them (it sends `VI` / `EN`).
 *
 * @param {string} value
 * @returns {string} an UpdateLangAvailableLanguages value
 * @throws {Error} for any other language
 */
export function parseLanguage(value) {
    const key = String(value).trim().toUpperCase();
    if (key in UpdateLangAvailableLanguages) return UpdateLangAvailableLanguages[key];
    throw new Error(`language must be one of: ${Object.keys(UpdateLangAvailableLanguages).join(", ").toLowerCase()}`);
}

/** The reasons `msg report` accepts, by name. */
export const REPORT_REASONS = Object.freeze({
    sensitive: ReportReason.Sensitive,
    annoy: ReportReason.Annoy,
    fraud: ReportReason.Fraud,
    other: ReportReason.Other,
});

/**
 * The options object zca-js's `sendReport` takes.
 *
 * `other` is the only reason that carries text, and zca-js sends it only for
 * that reason, so a text given with another reason would be dropped without a
 * word: refuse it instead of pretending it was reported.
 *
 * @param {string} reason - sensitive | annoy | fraud | other
 * @param {string} [content] - required with `other`, refused otherwise
 * @returns {{reason: number, content?: string}}
 * @throws {Error} for an unknown reason, `other` without text, or text with any other reason
 */
export function parseReportReason(reason, content) {
    const key = String(reason).trim().toLowerCase();
    if (!(key in REPORT_REASONS)) {
        throw new Error(`--reason must be one of: ${Object.keys(REPORT_REASONS).join(", ")}, got "${reason}"`);
    }
    const text = content === undefined ? "" : String(content).trim();
    if (key === "other") {
        if (!text) throw new Error('--reason other needs the details: add --content "<what happened>"');
        return { reason: REPORT_REASONS.other, content: text };
    }
    if (text) throw new Error(`--content is only sent with --reason other; "${key}" carries no text`);
    return { reason: REPORT_REASONS[key] };
}
