# Telegram channel

## Inventory (R1)

Baseline: `origin/main` at `5685974e` (includes #157 and #161). This table records the baseline, not a claim that M4 is complete.

| Function | On main? | Baseline file/test → production coverage |
| --- | --- | --- |
| Text long polling | Yes | `src/api.ts`, `src/channel.ts`; `test/channel.test.ts` |
| Chat allowlist, secret redaction | Yes | `src/channel.ts`, `src/redact.ts`; `test/channel.test.ts` |
| Offset resume and atomic file replacement | Yes | `src/offset.ts`; `test/channel.test.ts` |
| Text splitting, surrogate safety | Yes | `src/split.ts`; `test/split.test.ts` |
| 429 retry_after | Yes | `src/api.ts`, `src/channel.ts`; `test/channel.test.ts` |
| Current framework Channel contract / manifest | No (old local port only) | `src/channel.ts`, `channel.json`; `test/production.test.ts` |
| Group/supergroup policy, topics, user filter, migration | No | `src/channel.ts`; `test/production.test.ts` |
| Inbound/outbound media | No | `src/api.ts`, `src/channel.ts`, `src/port.ts`; `test/production.test.ts` |
| Webhooks / secret verification / polling switch | No | `src/channel.ts`; `test/production.test.ts` |
| Inline keyboards, signed callbacks / ConfirmPrompt | No | `src/callback.ts`, `src/channel.ts`; `test/production.test.ts` |
| Global and per-chat buckets, 403 inactive, typed 400, jitter | No | `src/rate-limit.ts`, `src/api.ts`, `src/channel.ts`; `test/production.test.ts` |
| Commands / localized scoped menus | No | `src/channel.ts`; `test/production.test.ts` |
| D93 /web link-provider port | No | `src/port.ts`, `src/channel.ts`; `test/production.test.ts` |
| Fake HTTP Bot API | Partial (poll/text/429) | `test/helpers/fake-telegram.ts`; production tests add media, registration, callbacks, 400/403 |

Paths in the table are relative to `packages/channels-telegram/`.

## Setup

Create a bot with [BotFather](https://t.me/BotFather), store its token in the host secret store, and pass the secret **name** as `tokenSecret`. Never put a token in config, source, tests, command lines or logs. Tests use an invented fixture token and an HTTP server bound to loopback in the test process. They never call Telegram.

The package is a library. Construct `TelegramChannel`, register its `channel.json` with the existing registry and a factory, and let the registry call `start(host)`. The host performs identity pairing and session routing. `senderId` is a Telegram user ID, never an authenticated harness Principal. Direct messages use `chatKind: direct`; groups/supergroups use `group`. Forum topic conversations use the opaque key `<chat-id>:<message_thread_id>`, so each topic has its own session and replies are sent back to that topic. The framework's identity resolver still receives the original sender ID.

Add the bot to a group; explicitly allowlist the negative group ID. Enable Topics in a supergroup to use forum threads. Default `groupPolicy: addressed` accepts a bot mention, reply to this bot, or a slash command addressed to this bot (including unsuffixed commands). Commands addressed to another bot and messages from bots are ignored. For `groupPolicy: all`, disable Privacy Mode with BotFather `/setprivacy` or grant the bot the appropriate admin rights; Telegram must actually deliver messages for the adapter to see them. An optional user allowlist further restricts speakers, including callbacks. Anonymous senders without a Telegram user identity are refused.

## Configuration and lifecycle

All options belong to the host's channel factory and take effect on channel restart. This package does not add root config-schema/RPC keys or a module process.

| Option | Default / meaning |
| --- | --- |
| `tokenSecret`, `secrets` | Required secret name and reader |
| `allowlist` | Required decimal chat IDs; empty allows nothing, inbound and outbound |
| `userAllowlist` | Omitted allows any human in an allowed chat; empty allows none |
| `offsetStore` | Required; use `FileOffsetStore` in a private persistent host state directory |
| `mode` | `polling` (default) or `webhook` |
| `webhook.url`, `webhook.secret` | Required in webhook mode; HTTPS URL and 1–256 allowed secret characters |
| `webhook.maxBodyBytes` | 1 MiB; also limit request bodies/timeouts in the host HTTP server |
| `botId`, `botUsername` | Normally discovered with `getMe`; explicit overrides available |
| `groupPolicy` | `addressed`; `all` accepts all delivered group messages |
| `maxMediaBytes` | 20 MiB maximum; checked before and during download and before upload |
| `maxSendRetries` | 3 for 429/network/timeout retries |
| `pollTimeoutSec` | 30 seconds |
| `commands` | Additional existing command-set entries to advertise; execution belongs to the host |
| `commandScopes` | Private and group chat scopes, each in de/en; explicit chat scopes supported |
| `webLinkProvider` | Omitted: `/web nicht konfiguriert` |
| `logger` | Optional structured, content-free log sink |
| `baseUrl`, `fetch`, `sleep`, `now`, `random` | Host transport / deterministic test seams; never derive these from inbound input |

`start()` obtains bot identity, registers commands and selects transport. Polling calls `deleteWebhook` with `drop_pending_updates: false`; webhook mode calls `setWebhook` with `secret_token` and accepts messages/callback queries. The package never starts a public server. Mount the Fetch-compatible handler in the host:

```ts
const response = await telegram.handleWebhook(request);
```

The host owns TLS, routes, connection/body deadlines and public reachability. Header verification uses constant-time comparison of SHA-256 digests. Wrong secrets get 403, malformed updates 400, oversized bodies 413, stopped/wrong-mode handlers 503. Concurrent requests are serialized and duplicate IDs are suppressed in a bounded, process-local cache. Webhook deduplication is not durable across a process restart; consumers must tolerate at-least-once delivery. `FileOffsetStore` also journals group→supergroup migrations; use the same store on restart. Custom stores can implement `loadMigrations`/`saveMigration`; without them migration aliases are process-local. Corrupt/unreadable existing state fails closed. Polling persists the next offset before asking Telegram to acknowledge it; handlers must likewise tolerate a crash between delivery and persistence.

## Rich turns, commands and handoff

Use `onMessage` for typed rich inbound turns (caption text, attachment bytes/MIME, callback and command metadata); use `sendTurn` for text, media and inline buttons. `send(chatId, text)` remains compatible with #157; `send({ chatId, text, replyTo })` implements the framework contract. Media supports photo/document/voice/audio/video inbound and outbound. Downloads use only the Bot API file endpoint; unsafe paths and redirects are refused, declared size, downloaded size and MIME are checked. No arbitrary media URL is fetched. The conservative MIME allowlist rejects explicitly labeled HTML/SVG/executables. Generic octet-stream downloads use the validated message MIME. MIME checks are not malware scanning.

`parseMode` accepts literal input and escapes it as HTML or MarkdownV2 after splitting. It does not interpret model-generated Markdown as trusted markup. Thus escape sequences remain intact and code-fence text stays literal. For rendered formatting, supply UTF-16 `entities` (bold/italic/underline/strikethrough/spoiler/code/pre) instead of `parseMode`; each chunk receives rebased entity ranges, so long code blocks reopen independently without torn entities. Parse-entity errors fall back to the original plain text; unrelated 400s do not. Global sends use a 30-token bucket refilling at ~30/s. Per-chat buckets have capacity one: private chats ~1/s, groups ~20/min shared across all topics. 429 waits the clamped server retry interval (1 s–5 min); transient transport failures use bounded exponential backoff with jitter. An ambiguous network failure may cause duplicate outbound messages. 403 marks only the affected chat inactive for this instance; fix permissions and restart. Other 400s are typed `bad-request` errors.

Menus register `/start`, `/help`, `/new`, `/web` plus supplied existing commands in German and English. `/start <deep-link-parameter>` preserves the parameter in `command.argument`. `/new` is forwarded, normalized without the bot suffix, to the framework's session router. `/help` is local. `/web` is allowed only in DMs and calls `WebLinkProvider.createLink(message)`; the provider must resolve a linked principal and generate a single-use HTTPS D93 handoff. The returned link is sent without logging its text or any provider error. D93 creates a separate web thread seeded from the channel summary, sharing agent memory; it does not merge histories.

Buttons use `prompt` (the `ConfirmPrompt` port) or `sendTurn({ buttons })`. Callback data is an opaque signed handle under 64 bytes, single-use, chat/topic-bound and optionally sender-bound. TTL defaults to five minutes (maximum 24 hours); outstanding handles are invalid after process restart. Invalid, expired, forged, replayed or wrong-user handles are politely refused. Every callback path attempts `answerCallbackQuery`, including failures. This transport is **not** an approval grant.

## Troubleshooting and follow-ups

- 401: replace the secret, restart. 409: stop the other poller / check webhook mode.
- 403 on send: bot blocked or removed; restore permissions and restart.
- No group messages: check allowlists, bot username, mention/reply policy and Privacy Mode.
- No topic replies: retain the opaque topic `chatId` on the outbound turn.
- Media rejected: check size, supported MIME and Bot API `getFile` result; no source URL or token is logged.
- `/web nicht konfiguriert`: bind a provider; the package cannot mint Web UI tokens.
- Offset write failures: fix persistent state permissions/storage. Polling waits rather than acknowledging unsaved progress.

Framework v1 is text-only. Rich turns are exposed through package ports and are not passed into the text-only framework router: media-only input must not disappear into a text session or be claimed as attachment support. Follow-ups: bind rich turns to the actual session attachment/event model and Principal/TurnOrigin, bind `ConfirmPrompt` to D109 authorization, implement the D93 linked-person/single-use link provider, register the adapter in the real host, and connect the injected transport to the host egress service. The egress service has a different guarded HTTP interface; this PR changes no core contract or global policy.

## Verification

```sh
pnpm --filter @plur1bus/channels-telegram test
pnpm exec tsc -p tsconfig.base.json --noEmit
pnpm lint
```

API method/field reference: [Telegram Bot API](https://core.telegram.org/bots/api), including `getUpdates`, `getFile`, `sendMessage`, media send methods, `setWebhook`, `deleteWebhook`, `setMyCommands` and `answerCallbackQuery`.
