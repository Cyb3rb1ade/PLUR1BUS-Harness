# @plur1bus/channels-discord

Discord channel for the switchboard: a lean Gateway v10 + REST v10 client built on Node's global `WebSocket` and `fetch`,
implementing the core `Channel` lifecycle plus the rich ports (`onMessage`, `sendTurn`, `edit`, `typing`, `prompt`,
`onDecision`). Direct messages, guild channels and threads (replies inside an existing thread), mention/reply policies,
bounded attachments in and out, streaming edits, D109 approval buttons, `/link` pairing and `/status`.

No runtime dependency. Why no `discord.js`: the repo's zero-dependency policy for channel packages, the licence audit
(`scripts/audit-deps.mjs`) would have to cover a large transitive tree, and the Telegram channel already set the precedent
of an own minimal client. The surface needed here is small (about a dozen REST routes, one gateway loop, interaction
callbacks), so the client stays within review reach. See the [operator guide](../../docs/channels/discord.md) for the
developer-portal setup, every option and the limits.

- Manifest: `channel.json`, `discord`, version `0.1.0`, API `1`, `direct` and `group` chat kinds.
- Public API: `DiscordChannel`, `createDiscordChannel(config, deps)`, `splitMessage`, `toPlatformMarkdown`, `redactString`,
  `CallbackSigner`, `RestLimiter`, `FileGatewayStateStore` / `MemoryGatewayStateStore`, `parseConfig`, `outputAttachment`.
- Credentials enter only through `SecretReader` (the config names the secret). The token is sent only in the
  `Authorization` header and the gateway identify frame.
- `accountId` for pairing is the bot's own user id.
- Model output is always sent with `allowed_mentions: { parse: [] }`, so it cannot ping `@everyone`, roles or users.
- Gateway: Hello, Identify, Resume (in process and across restarts when a state store is given), Heartbeat with jitter and
  ACK tracking (a missed ACK is a zombie connection: reconnect with resume), Reconnect, Invalid Session. Close codes
  4004 / 4010 / 4011 / 4012 / 4013 / 4014 are fatal: `host.fail()`, no retry. Other closes back off exponentially with jitter.
- REST: per-route buckets from `X-RateLimit-*`, a global limit, 429 with `Retry-After` / `retry_after` clamped to 1 s .. 5 min,
  bounded retries for 5xx and transport failures, no retry for other 4xx.

## Layout

- `src/channel.ts`: the channel (lifecycle, inbound policy, outbound, approvals, interactions, `/link`, `/status`).
- `src/gateway.ts`, `src/api.ts`, `src/rate-limit.ts`: the gateway loop, REST client and limiter.
- `src/markdown.ts`, `src/split.ts`: safe conversion and code-fence-aware splitting.
- `src/callback.ts`: signed, single-use, sender-bound handles for button `custom_id`s.
- `src/state.ts`: resume-state store (fail closed on corrupt files; only Discord gateway hosts are ever dialled).
- `src/config.ts`: closed-world config validation.
- `test/helpers/`: an in-process gateway (`FakeGateway`), a loopback REST stand-in with a CDN rewrite, a virtual clock, and
  `contract.ts` (the shared contract harness).

## Tests

```sh
cd packages/channels-discord && node ../../scripts/test-package.mjs
```

All tests run in-process: a scripted gateway through the `webSocket` seam, a loopback REST server through `baseUrl`, a
virtual clock through `sleep` / `now` / `random`, and an invented token (`FAKEBOTTOKEN_...`). No test opens a real
Discord connection. Typecheck: `npx tsc -p tsconfig.base.json --noEmit 2>&1 | grep packages/channels-discord/`.

## Limits

- Single shard, JSON encoding, no compression. The gateway URL defaults to `wss://gateway.discord.gg`; `session_start_limit`
  is not read from `GET /gateway/bot`, so a crash loop is slowed by backoff, not by the identify budget.
- A deliberate stop closes with code `4000` so the session stays resumable (close codes 1000 and 1001 invalidate it).
- A thread is a chat of its own: it is accepted when its id or its parent channel id is on the allowlist. The parent is learned
  from thread and guild snapshot events, so threads created while the bot was offline are known after the next such event.
  Thread creation is not implemented.
- After a restart, outbound direct messages need a fresh inbound message from that user (the DM mapping is in memory).
- Ambiguous network failures on `POST` may duplicate an outbound message (the request may have been applied).
- `edit` takes at most one message (2000 characters); longer streams must be split by the caller.
- Reactions and HTML/embeds are not used.
