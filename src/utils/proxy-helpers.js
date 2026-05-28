/**
 * Proxy URL helpers — masking passwords for safe display.
 */

/**
 * Mask password in proxy URL for safe display.
 * Example: http://user:secret@host:8080 → http://user:***@host:8080
 * @param {string|null} proxyUrl
 * @returns {string}
 */
export function maskProxy(proxyUrl) {
    if (!proxyUrl) return "none";
    return proxyUrl.replace(/(\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}
