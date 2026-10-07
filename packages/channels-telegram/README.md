# @plur1bus/channels-telegram

Telegram channel for the user's own bots (M4, task A4). Not a D14 module: a library that implements the `ChannelPort`
in `src/port.ts` (the A3 channel framework adopts or adapts that port).

- **Transport:** Bot API `getUpdates` long polling, text messages only, `allowed_updates: ["message"]`. The offset is
  persisted after every dispatched update (`FileOffsetStore`, atomic rename) and resumed on start. Delivery is at-most-once.
- **Outbound:** `send(chatId, text)` splits at 4096 UTF-16 code units (paragraph, newline, space, hard cut; never inside a
  surrogate pair). A 429 waits `retry_after` (clamped to 1 s – 5 min) and retries up to `maxSendRetries` (default 3).
- **Allowlist:** decimal chat ids; empty means nothing is allowed. Unlisted chats get no reply and nothing is logged but
  the chat id. Outbound sends to unlisted chats are refused.
- **Token:** read once at `start()` from the secret store (`SecretReader.reveal(tokenSecret)`), never from config. It
  appears only in the request URL inside `api.ts`; errors are fixed text and every log attribute goes through `redact.ts`.
  A 401/403/404 stops polling (no retry loop).
- **Config keys:** none owned here; the wiring (secret name, allowlist, offset directory) belongs to the A3 framework.
- **Test in isolation:** `cd packages/channels-telegram && node ../../scripts/test-package.mjs` (a local fake Bot API server, no network).
