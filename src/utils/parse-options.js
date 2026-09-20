/**
 * Safe coercions for Commander option values.
 *
 * ## Why this exists
 *
 * `.option("-c, --count <n>", "Page size", parseInt, 100)` looks obviously
 * correct and is silently wrong. Commander invokes a coercion as
 * `fn(value, previousValue)`, and `previousValue` is the option's **default**.
 * JavaScript's `parseInt(string, radix)` takes a *radix* second — so the
 * default becomes the radix:
 *
 * ```
 * friend alias-list -c 100   ->  parseInt("100", 100)  ->  NaN
 * profile avatars   -c 50    ->  parseInt("50",  50)   ->  NaN
 * catalog list      -l 20    ->  parseInt("20",  20)   ->  40   ← silently wrong
 * ```
 *
 * The NaN cases reach Zalo as `NaN` and come back as
 * "Tham số không hợp lệ" — which looks exactly like a server-side rejection
 * and was in fact misfiled as an upstream defect for a while. The radix-40
 * case is worse: no error at all, just the wrong page size.
 *
 * `parseIntOption` ignores the second argument entirely and always parses
 * base 10, rejecting anything that is not a clean integer rather than
 * silently substituting a default.
 */

/**
 * Parse a Commander option value as a base-10 integer.
 *
 * @param {string} value - raw value from the command line
 * @returns {number}
 * @throws {Error} when the value is not a base-10 integer
 */
export function parseIntOption(value) {
    const n = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n) || String(n) !== String(value).trim()) {
        throw new Error(`Expected a whole number, got "${value}"`);
    }
    return n;
}

/**
 * Same, but rejects values below `min` — for counts, pages and durations
 * where a negative or zero would silently produce nonsense downstream.
 *
 * @param {number} min
 * @returns {(value: string) => number}
 */
export function parseIntAtLeast(min) {
    return (value) => {
        const n = parseIntOption(value);
        if (n < min) throw new Error(`Expected a whole number >= ${min}, got ${n}`);
        return n;
    };
}
