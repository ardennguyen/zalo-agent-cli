/**
 * The one login a wire run stands on: a saved-session login through `src/zalo/login.js`, against the fake Zalo the
 * caller installed (tests/unit/fake-zalo-session.js). The engine under test is then built on its ctx.
 *
 * A test that uses it must import tests/helpers/sandbox.js first. Every id here is fake.
 */
import { loginWithSession } from "../../../src/zalo/login.js";
import { API_TYPE, DEFAULT_API_VERSION } from "../../../src/zalo/profile.js";
import { FAKE_CREDENTIALS } from "../../unit/fake-zalo-session.js";

/** The session options the engine passes at login. */
const ZALO_OPTIONS = Object.freeze({ selfListen: true });

/**
 * One saved-session login through `src/zalo/login.js` against the installed fake; no upkeep timers.
 *
 * @param {object} [zaloOptions] - merged over the engine's login options (e.g. an `imageMetadataGetter`)
 * @returns {Promise<{api: object, ctx: object, serviceMap: Record<string, string[]>, wsUrls: string[]}>}
 */
export async function loginOnce(zaloOptions = {}) {
    const api = await loginWithSession(structuredClone(FAKE_CREDENTIALS), {
        apiType: API_TYPE,
        apiVersion: DEFAULT_API_VERSION,
        zaloOptions: { ...ZALO_OPTIONS, ...zaloOptions },
        upkeep: false,
    });
    const ctx = api.getContext();
    return { api, ctx, serviceMap: ctx.loginInfo.zpw_service_map_v3, wsUrls: ctx.loginInfo.zpw_ws };
}
