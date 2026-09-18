/**
 * Generates a randomized-but-internally-consistent browser fingerprint
 * (User-Agent + matching Client Hints) for the one-time QR login handshake.
 *
 * Why this exists: zca-js's default QR-login fingerprint is broken and
 * identical across every install on earth — it sends a literal
 * "...Firefox/133.0" User-Agent header while our zca-js patch's
 * secChUaHeaders() fallback (and, before this patch, every hardcoded call
 * site in loginQR.js) separately claims Chromium/Chrome v130 Client Hints
 * on every QR-flow request to id.zalo.me. Real browsers never produce that
 * combination — Firefox doesn't send sec-ch-ua headers at all — and Zalo's
 * server appears to read the Client Hints for the "Thiết bị" device label
 * shown on the phone's QR-confirm screen, which is why every zca-js login
 * shows "Chrome - Windows 10" regardless of what's actually running the
 * CLI. Beyond being cosmetically wrong, a fingerprint that's byte-identical
 * across every zca-js user is itself a correlatable signal.
 *
 * Scope: this only matters for the INITIAL QR-login handshake. Once logged
 * in, the chosen userAgent is persisted in that account's credentials file
 * (see extractCredentials()/loginWithCredentials() in zalo-client.js) and
 * reused consistently for every subsequent API call — so a fresh, plausible,
 * internally-consistent choice made once here, at first login, is enough;
 * it doesn't need to be regenerated per-command. Re-scanning to log into the
 * same account again later (after a full logout, not just a session resume)
 * gets a freshly randomized fingerprint, same as a real user occasionally
 * updating their browser — that's expected, not a bug.
 */

const CHROME_VERSIONS = ["131.0.0.0", "130.0.0.0", "129.0.0.0", "128.0.0.0"];

/**
 * Windows-first, Chrome-only presets. Deliberately not branching into
 * Firefox/Safari: those browsers don't send sec-ch-ua headers at all, and
 * Zalo's own device-label rendering already appears tuned for Chrome/Chromium
 * (see the hardcoded literals this patch replaces) — straying from Chrome
 * would trade one kind of oddity for another. Varying version + OS build is
 * enough to avoid every install presenting an identical fingerprint.
 */
const PRESETS = [
    ...CHROME_VERSIONS.map((v) => ({
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
        secChUaPlatform: '"Windows"',
    })),
    ...CHROME_VERSIONS.map((v) => ({
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
        secChUaPlatform: '"macOS"',
    })),
];

function buildSecChUa(chromeVersion) {
    const major = chromeVersion.split(".")[0];
    // Matches the brand-list shape real Chrome sends (order, quoting, the
    // "Not?A_Brand" filler entry — all part of Chrome's actual GREASE
    // pattern for this header, not something we're inventing).
    return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
}

/**
 * Pick a random, internally-consistent fingerprint for a fresh QR login.
 * @returns {{userAgent: string, secChUa: string, secChUaPlatform: string, secChUaMobile: string}}
 */
export function generateDeviceFingerprint() {
    const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    const versionMatch = preset.userAgent.match(/Chrome\/([\d.]+)/);
    const chromeVersion = versionMatch ? versionMatch[1] : CHROME_VERSIONS[0];
    return {
        userAgent: preset.userAgent,
        secChUa: buildSecChUa(chromeVersion),
        secChUaPlatform: preset.secChUaPlatform,
        secChUaMobile: "?0",
    };
}
