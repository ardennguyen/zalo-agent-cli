/**
 * The protocol layer's public entry: what a program that is not this CLI needs to log in to Zalo, call it, listen
 * on its socket and restore history from the phone.
 *
 * Nothing under src/zalo imports the application (src/core, src/utils, src/commands, src/mcp, src/index.js); the
 * caller hands in what is its own -- paths, a proxy, a logger, the answers of the local reads. See ./README.md.
 * Internal until it is published as a package of its own: names here may still change.
 */

// ── making a session ───────────────────────────────────────────────────────
export { AREAS, createApi } from "./api.js";
export { buildSessionOptions, createProxyFetch, openQrSession, openSession, readImageMetadata } from "./client.js";
export { createDrStore, loginWithSession, stopUpkeep } from "./login.js";
export { qrLogin } from "./qr-login.js";
export { TRUST_FILE, createTrustStore } from "./trust-store.js";
export { generateDeviceFingerprint } from "./device-fingerprint.js";
export { API_TYPE, DEFAULT_API_VERSION, getProfile, resolveApiVersion, resolveQrFlow } from "./profile.js";
export * from "./enums.js";
export * from "./errors.js";

// ── the socket ─────────────────────────────────────────────────────────────
export { Listener, createListener } from "./listener/listener.js";
export { SocketSupervisor, superviseListener } from "./socket.js";
export { startKeepAlive } from "./listener/keepalive.js";
export { createSocketTap } from "./listener/socket-tap.js";
export { drainReactionBacklog } from "./listener/reactions.js";

// ── calls beside the session object ────────────────────────────────────────
export { customCall, getWithParams, postWithParams } from "./session-call.js";
export { READS, READ_NAMES, callRead, describeReads, registerLocalRead } from "./reads.js";
export { WRITES, WRITE_NAMES, callWrite, describeWrites } from "./writes.js";
export {
    createDeliveredReceipts,
    sendDeliveredReceipt,
    sendReactionSeen,
    sendSeenReceipt,
    zaloPost,
} from "./receipts.js";
export { keySessionLogout, serverLogout } from "./logout.js";
export { officialLogout } from "./official-logout.js";
export * as pin from "./custom/pin.js";
export * as forward from "./custom/forward.js";
export * as groupHistory from "./custom/group-history.js";
export * as groupInvite from "./custom/group-invite.js";
export * as groupSettings from "./custom/group-settings.js";
export * as groupVisibility from "./custom/group-visibility.js";
export * as gid from "./custom/gid.js";
export * as renewLink from "./custom/renewlink.js";
export * as userInfo from "./custom/user-info.js";
export * as zcloud from "./zcloud.js";
export * as zcloudE2ee from "./zcloud-e2ee.js";

// ── message text ───────────────────────────────────────────────────────────
export { looksLikeMarkdown, markdownToZalo } from "./format/markdown.js";
export { expandMentions, parseMentionSpecs } from "./format/mentions.js";
export { MESSAGE_BYTE_LIMIT, sendParts, splitMessage } from "./format/split-message.js";
export { urgencyLevel } from "./format/urgency.js";
export { extractMessageText } from "./format/extract-message-text.js";

// ── transfer sync (cmd 590/591) and the socket's queues ────────────────────
export * as transfer from "./transfer-sync/transfer.js";
export * as syncChannel from "./transfer-sync/channel.js";
export * as syncDownload from "./transfer-sync/download.js";
export * as syncAssets from "./transfer-sync/assets.js";
export * as messageTypes from "./transfer-sync/message-types.js";
export * as offlineQueue from "./queues/offline-queue.js";
export * as controlQueue from "./queues/control-queue.js";
export * as queueVerify from "./queues/queue-verify.js";

// ── files several processes share ──────────────────────────────────────────
export { withFileLock, writeFileAtomic } from "./kernel/atomic-file.js";
export { plainCodec, secretFileCodec, setSecretFileCodec } from "./kernel/secret-file.js";
