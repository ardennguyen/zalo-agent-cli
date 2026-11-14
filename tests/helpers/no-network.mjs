/**
 * Preload for offline CLI runs (`node --import`): `fetch` fails instead of reaching the network.
 *
 * Commands under the fake session (tests/helpers/fake-api.js) make no Zalo request, but a few fetch something
 * else on their own (a VietQR image, a link preview, a download). An offline test must not.
 */
globalThis.fetch = async (url) => {
    throw new Error(`offline test: no network (fetch ${String(url?.url ?? url).slice(0, 80)})`);
};
