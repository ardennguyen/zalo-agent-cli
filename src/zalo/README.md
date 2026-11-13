# src/zalo — the protocol layer

Everything in this CLI that speaks Zalo's protocol: the session cipher and transport, the endpoint
modules, the chat socket and its supervisor, logins (saved and QR), logout, receipts, zCloud, transfer sync
(cmd 590/591), the socket's queues, and the message-text helpers. Every request follows Zalo's own wire format.

It is a library the CLI uses, never the other way round: **nothing under `src/zalo/` imports `src/core`,
`src/utils`, `src/commands`, `src/mcp` or `src/index.js`.** ESLint (`no-restricted-imports` on `src/zalo/**`) and
`tests/unit/zalo-boundary.test.js` enforce it.

## Public surface

`index.js` re-exports what a program other than this CLI needs:

| Area                     | Exports                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Making a session         | `buildSessionOptions`, `openSession` (saved login), `openQrSession`, `qrLogin`, `loginWithSession`, `stopUpkeep`, `createDrStore`, `createTrustStore`, `createProxyFetch`, `generateDeviceFingerprint`, the profile values      |
| The session object       | `createApi`, `AREAS`                                                                                                                                                                                                            |
| The socket               | `createListener`/`Listener`, `superviseListener`/`SocketSupervisor`, `startKeepAlive`, `createSocketTap`, `drainReactionBacklog`                                                                                                |
| Errors and enums         | everything in `errors.js` and `enums.js`                                                                                                                                                                                        |
| Other calls              | `callRead`/`callWrite` and their tables, `registerLocalRead`, receipts, `serverLogout`, `officialLogout`, `customCall`, and the hand-built calls as namespaces (`pin`, `forward`, `groupHistory`, `groupSettings`, `zcloud`, …) |
| Message text             | `markdownToZalo`, `parseMentionSpecs`/`expandMentions`, `splitMessage`/`sendParts`, `urgencyLevel`, `extractMessageText`                                                                                                        |
| Transfer sync and queues | `transfer`, `syncChannel`, `syncDownload`, `syncAssets`, `messageTypes`, `offlineQueue`, `controlQueue`, `queueVerify` (namespaces)                                                                                             |

The CLI itself imports the modules directly; `index.js` is for other consumers.

## What the caller injects

The layer computes no application paths and reads no application config. The caller passes in:

- **Network:** the proxy (`buildSessionOptions(proxyUrl)` builds the WebSocket agent and an undici `fetch` with
  its dispatcher), or its own `fetch` where a function takes one.
- **Paths:** where a login's server settings live (`drStoreFor(ownId)` → `createDrStore(file)`), where the
  companion-device identity lives (`createTrustStore(dirFor)`), the transfer-sync session file
  (`syncChannel.createSessionStore(file)`) and the asset cache (`syncAssets.ensureAssets(cacheDir)`).
- **Logging:** a `log` function where one is taken (socket tap, delivered receipts), `setUserInfoLogger` for paced
  lookups; the default is silent or stderr, never stdout.
- **Storage:** what a protocol call receives is handed to the caller (`drainReactionBacklog({store})`); the local
  reads' answers are registered with `registerLocalRead(name, handler)`.
- **Environment:** `ZALO_API_VERSION` and `ZALO_QR_FLOW` are read from `process.env` by default; `resolveApiVersion`,
  `resolveQrFlow`, `getProfile` and `buildSessionOptions` take an `env` object instead.

## Stability

Internal. The layout and names may still change until the layer is published as a package of its own; until then
nothing outside this repository should import it.
