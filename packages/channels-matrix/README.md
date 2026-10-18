# @plur1bus/channels-matrix

Matrix channel adapter (Client-Server API r0/v3 over `fetch`, exact crypto dependency `@matrix-org/matrix-sdk-crypto-wasm@18.9.0` (WASM)).

## Scope

- Text in and out, DMs and rooms, threads, replies, mentions, edits (`m.replace`), typing, media in and out
  (`m.image`/`m.file`/`m.audio`/`m.video`), reaction-based approvals (D109), `/link` (or `!link`) pairing in DMs.
- **Persistent E2EE blocked.** Default mode is off. Experimental `e2ee.mode: memory` encrypts/decrypts with real WASM but loses keys and device verification on restart. Owner/admin SAS controls are in the Switchboard. Cross-signing bootstrap/recovery backup remain unavailable.
- Operator guide: `docs/channels/matrix.md`.

## Manifest

`channel.json`: `name: matrix`, `chatKinds: direct, group`, `startDelayMs: 0`, `maxRestarts: 8`.

## Config (secret names only, see docs for the table)

`homeserverUrl`, `userId`, `accessTokenSecret`, `deviceId?`, `autoJoin`, `allowlist`, `dmAllowlist`, `userAllowlist?`,
`replyPolicy`, `maxMediaBytes`, `locale`, `enabled`, `e2ee.mode` (off/memory), `e2ee.unverifiedDevices` (reject/allow, default reject). The access token is read from the host secret store and never appears in config.

## Ports (`src/port.ts`, `DUPLICATE` marker: candidate for a shared package)

- `SecretReader`, `ChannelLogger`, `SyncTokenStore` (required: `FileSyncTokenStore` or `MemorySyncTokenStore`).
- Deps: `pairing?` (`IdentityService.claim`), `outputs?` (OutputPort), `fetch`, `sleep`, `now`, `random`, `maxSendRetries`, `syncTimeoutMs`.
- Public API: `MatrixChannel` (framework `Channel` + `onMessage`, `sendTurn`, `edit`, `typing`, `prompt`, `onDecision`),
  `createMatrixChannel(cfg, deps)`, `splitMessage`, `toMatrixText`, `redactString`.

## Running the tests in isolation

```bash
cd packages/channels-matrix && node ../../scripts/test-package.mjs
```

Tests run against an in-process loopback fake homeserver (`test/helpers/fake-matrix.ts`) with a real long poll, multipart
media, rate limits, invites and encryption state. No real network. `test/helpers/contract.ts` is the contract harness.
Typecheck: `npx tsc -p tsconfig.base.json --noEmit` from the repo root, filtered to `packages/channels-matrix/`.

## Limits

- `/sync` uses `filter` to limit event types; the first sync is an initial sync that discards history.
- Outbound text is split at 16000 UTF-8 bytes of Markdown source; fences are closed and reopened per chunk.
- Retries reuse the transaction id, so the homeserver de-duplicates a retried send for the same device.
- Edits must fit one event. Encrypted media (`file` with keys) remains refused; encrypted text requires the opt-in experimental memory mode.

All Matrix config keys have restart class `module:matrix`. `channel.crypto` is the owner/admin-only hosted SAS RPC; the standalone adapter itself exposes no RPC listener.
