/**
 * Phone numbers for ZBS sends by phone, per Zalo's ZBS docs ("API Gửi tin", "API Gửi tin sử dụng hash phone",
 * "API Gửi tin với hệ mã hóa RSA", "API Gửi tin Journey"): the number must be linked to a Zalo account and written
 * in the country-code form, e.g. 0987654321 → 84987654321 (the docs also accept +84987654321; we send the digits).
 */

import { createHash } from "node:crypto";
import { OAError } from "../oa/transport.js";

/**
 * Normalize a recipient phone number to the country-code form the ZBS docs ask for.
 *
 * - spaces, dots, dashes and parentheses are dropped;
 * - `+84…` → `84…`; a Vietnamese `0…` number → `84…` (the docs' own example);
 * - a 9-digit number without its leading 0 (the docs' error table names this spreadsheet form) → `84…`;
 * - anything else must already be 8–15 digits starting with a country code (no leading 0).
 *
 * @param {string|number} phone
 * @returns {string} digits only, country code first
 * @throws {OAError} code `invalid_input` when it cannot be a phone number
 */
export function normalizePhone(phone) {
    const raw = String(phone ?? "").trim();
    const compact = raw.replace(/[\s.\-()]/g, "");
    if (!/^\+?\d+$/.test(compact)) {
        throw new OAError(`Not a phone number: "${raw}" (use 84xxxxxxxxx or 0xxxxxxxxx)`, { code: "invalid_input" });
    }
    let digits = compact.replace(/^\+/, "");
    if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;
    else if (digits.length === 9 && !compact.startsWith("+")) digits = `84${digits}`;
    if (digits.startsWith("84") && digits.length !== 11) {
        throw new OAError(`Not a Vietnamese mobile number: "${raw}" (84 + 9 digits, e.g. 84901234567)`, {
            code: "invalid_input",
        });
    }
    if (digits.length < 8 || digits.length > 15) {
        throw new OAError(`Not a phone number: "${raw}" (8-15 digits with the country code)`, {
            code: "invalid_input",
        });
    }
    return digits;
}

/** A SHA-256 digest in hex: what `hash_phone` carries. */
const HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * The `hash_phone` value: SHA-256 (hex) of the normalized phone number (country-code form, e.g. 84901234567).
 * A value that already is a 64-hex SHA-256 digest is passed through (lowercased), so a caller that never holds the
 * plain number can still send.
 *
 * @param {string} phone - a phone number, or an existing SHA-256 hex digest
 * @returns {string} 64 lowercase hex characters
 */
export function hashPhone(phone) {
    const s = String(phone ?? "").trim();
    if (HASH_RE.test(s)) return s.toLowerCase();
    return createHash("sha256").update(normalizePhone(s)).digest("hex");
}
