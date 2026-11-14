/**
 * DPoP (Demonstrating Proof-of-Possession) for the Social API, as Zalo's Social docs ("Demonstrating
 * Proof-of-Possession") describe it: every token request and API call may carry a `DPoP` header, a JWT signed with
 * the app's private key, whose header holds the public key. A token obtained with DPoP only works with proofs from
 * the same key pair (a refresh too), so the key is kept with the login.
 *
 * - header: `{ "typ": "dpop+jwt", "alg": "ES256", "jwk": { "kty": "EC", "crv": "P-256", "x", "y" } }`
 * - payload: `{ "htu": <the full URL called, with its path>, "htm": <the method>, "iat": <Unix seconds> }`
 * - signature: ES256 over `base64url(header) + "." + base64url(payload)`, no padding.
 *
 * `htu` is the URL without its query string (RFC 9449; the docs' examples carry none).
 */

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * A new P-256 key pair for DPoP, as a private JWK (it holds the public `x`/`y` too).
 * @returns {{ kty: "EC", crv: "P-256", x: string, y: string, d: string }}
 */
export function createDpopKey() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return privateKey.export({ format: "jwk" });
}

/**
 * The public half of a DPoP private JWK, as the proof's header carries it.
 * @param {{ kty: string, crv: string, x: string, y: string }} jwk
 * @returns {{ kty: string, crv: string, x: string, y: string }}
 */
export function publicJwk(jwk) {
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * One DPoP proof for one request.
 *
 * @param {{ method: string, url: string, key: object, now?: number }} req - `key` is the private JWK from
 *   {@link createDpopKey}; `now` in milliseconds (tests)
 * @returns {string} the compact JWT for the `DPoP` header
 */
export function dpopProof({ method, url, key, now = Date.now() }) {
    const u = new URL(url);
    const htu = `${u.origin}${u.pathname}`;
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk(key) };
    const payload = { htu, htm: String(method).toUpperCase(), iat: Math.floor(now / 1000) };
    const input = `${b64url(header)}.${b64url(payload)}`;
    const signature = sign("sha256", Buffer.from(input), {
        key: createPrivateKey({ key, format: "jwk" }),
        dsaEncoding: "ieee-p1363", // JWS ES256: r || s, 64 bytes
    });
    return `${input}.${signature.toString("base64url")}`;
}
