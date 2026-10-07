# A4 — Telegram channel (`packages/channels-telegram`)

## Goal
A Telegram channel implementation for the user's own bots: long polling (`getUpdates`) with persisted offset, text in/out,
4096-character splitting, a chat-id allowlist (default empty = nothing allowed), and a bot token read only from the secret
store and never present in config or logs.

## Coupling
The A3 channel framework is not on `main`. This package therefore defines a narrow port (`src/port.ts`: `ChannelPort`,
`InboundMessage`, `SecretReader`, `ChannelLogger`, `OffsetStore`) that A3 can adopt or adapt. `SecretReader` is the one method
of the M2 secret store that the channel needs (`reveal(name)`). No new dependency: Node's global `fetch`.

## Steps (test first, small commits)
1. This plan.
2. `split.ts` + tests (4096, lossless, surrogate pairs, break preference).
3. `redact.ts`, `api.ts` (Bot API client, error taxonomy incl. 429 `retry_after`) + tests against a fake HTTP server.
4. `offset.ts` (atomic file store).
5. `channel.ts` (poll loop, allowlist, send with retry) + tests.
6. README, PR.

## Rulings (fail closed)
See the PR; every one is marked `// RULING:` in code.
