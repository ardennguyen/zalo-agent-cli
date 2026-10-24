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

import { CHROME_VERSIONS, UA_PLATFORMS, buildUserAgent } from "../zalo/profile.js";
import { secChUaFor } from "../zalo/headers.js";

/**
 * Windows-first, Chrome-only presets, built from the protocol profile
 * (src/zalo/profile.js), which owns the Chrome builds and platforms.
 * Deliberately not branching into Firefox/Safari: those browsers don't send
 * sec-ch-ua headers at all, and Zalo's own device-label rendering already
 * appears tuned for Chrome/Chromium (see the hardcoded literals this patch
 * replaces) -- straying from Chrome would trade one kind of oddity for
 * another. Varying version + OS build is enough to avoid every install
 * presenting an identical fingerprint.
 */
const PRESETS = UA_PLATFORMS.flatMap((platform) =>
    CHROME_VERSIONS.map((v) => ({ userAgent: buildUserAgent(platform, v), secChUaPlatform: platform.hint })),
);

/**
 * Pick a random, internally-consistent fingerprint for a fresh QR login.
 * @returns {{userAgent: string, secChUa: string, secChUaPlatform: string, secChUaMobile: string}}
 */
export function generateDeviceFingerprint() {
    const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    // The brand list comes from src/zalo/headers.js, which also derives the hints of every later request from
    // the saved User-Agent, so the QR login and the session after it present the same browser.
    return {
        userAgent: preset.userAgent,
        secChUa: secChUaFor(preset.userAgent).secChUa,
        secChUaPlatform: preset.secChUaPlatform,
        secChUaMobile: "?0",
    };
}
