/**
 * Zalo Official Account client: a re-export barrel over src/core/oa/*.js, so existing imports keep working.
 *
 * - transport.js: base URLs, credential storage (~/.zalo-agent/oa-credentials.json), oaRequest, OAError, uploadForm
 * - oauth.js: PKCE permission URL, code exchange, locked refresh, the callback login flow
 * - messages.js, users.js, content.js (and the other area modules): the endpoints
 *
 * Independent of the personal-account session; credentials live in ~/.zalo-agent/ (no `-cli`).
 */

import { OPENAPI_V2, oaRequest } from "./oa/transport.js";

export {
    OPENAPI_V2,
    OPENAPI_V3,
    ZBS_BASE,
    OAUTH_PERMISSION_URL,
    OAUTH_TOKEN_URL,
    OA_ERRORS,
    ZBS_ERRORS,
    UPLOAD_LIMITS,
    OAError,
    describeOAError,
    getOADataDir,
    getOACredsFile,
    saveOACreds,
    saveOAToken,
    loadOACreds,
    loadOAToken,
    tokenFields,
    getToken,
    buildUrl,
    oaRequest,
    uploadForm,
    mimeTypeOf,
} from "./oa/transport.js";
export {
    getOAuthUrl,
    exchangeCode,
    refreshAccessToken,
    refreshStoredToken,
    createCodeVerifier,
    codeChallengeFor,
    startOAuthLogin,
} from "./oa/oauth.js";
export * from "./oa/messages.js";
export * from "./oa/users.js";
export * from "./oa/content.js";

/**
 * The OA's own profile (`v2.0/oa/getoa`): name, `oa_id`, `is_verified`, `oa_type`, `cate_name`, package, …
 * @param {string} [oaId]
 * @returns {Promise<object>}
 */
export async function getOAProfile(oaId = "default") {
    return oaRequest({ url: `${OPENAPI_V2}/oa/getoa`, oaId });
}
