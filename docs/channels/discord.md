# Discord channel

Operator guide for the `@plur1bus/channels-discord` package: developer-portal setup, configuration, reply rules, approvals,
pairing, limits and troubleshooting. The package README covers the code layout.

## 1. Create the application and the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose **New Application**.
2. On **General Information** copy the **Application ID**. It is optional in the config (the bot user id is used when it is
   absent, which is the normal case for bots). Keep it if you have one.
3. Open **Bot**. The bot user already exists. Check **Public Bot** only if you want strangers to be able to invite it; for a
   private switchboard leave it off.
4. Click **Reset Token** and copy the token once. Store it in the host secret store under a name of your choice, for example
   `discord-bot-token`. Never paste it into the config, a command line, a commit or a chat.

## 2. Privileged intents

On the **Bot** page under **Privileged Gateway Intents** enable **Message Content Intent**. Without it the gateway closes
with `4014` (disallowed intents) and the channel stops with `host.fail()` and no retry. The package also needs
`GUILDS`, `GUILD_MESSAGES` and `DIRECT_MESSAGES`; those are not privileged.

A bot in more than 100 servers needs Discord's verification before privileged intents are approved. Below that limit the
toggle is enough.

## 3. Invite the bot (OAuth2 scopes and permissions)

Open **OAuth2 → URL Generator** and select:

- Scopes: `bot` and `applications.commands`. The second one registers the slash commands `/link` and `/status`.
- Bot permissions (integer `274878008320`):

| Permission | Bit | Why |
| --- | --- | --- |
| View Channels | `1024` | see the channel |
| Send Messages | `2048` | replies |
| Attach Files | `32768` | outbound images |
| Read Message History | `65536` | reply context |
| Send Messages in Threads | `274877906944` | replies inside threads |

Open the generated URL, pick the server and confirm. For direct messages the user must share a server with the bot or must
have messaged the bot first; that is a Discord rule, not a setting here.

## 4. Find the ids (Developer Mode)

In Discord open **User Settings → Advanced → Developer Mode**. Then right-click a server, channel, thread or user and choose
**Copy Server ID**, **Copy Channel ID**, **Copy User ID**. Config ids are these decimal strings, always as JSON strings.

## 5. Configure the channel

The config holds secret **names** only.

```json
{
  "enabled": true,
  "tokenSecret": "discord-bot-token",
  "allowlist": ["123456789012345678"],
  "dmAllowlist": ["234567890123456789"],
  "replyPolicy": "mention",
  "maxMediaBytes": 10485760,
  "locale": "en"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | read by the host; the channel itself starts only when the host calls `start` |
| `tokenSecret` | required | name of the bot token in the secret store |
| `applicationId` | bot user id | set only if your application id differs |
| `intents` | `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT` | list of names from `DISCORD_INTENTS`, or a bitfield |
| `allowlist` | `[]` | guild channel, thread or DM channel ids the bot may talk in; empty means nobody |
| `dmAllowlist` | `[]` | user ids that may direct-message the bot; empty means no DMs |
| `userAllowlist` | absent | when present, only these users are heard in groups |
| `replyPolicy` | `mention` | group behaviour, see below |
| `maxMediaBytes` | 10 MiB | per attachment, hard maximum 25 MiB |
| `locale` | `en` | `en` or `de` for user-visible bot text |

Host-only dependencies (never in the JSON config): `secrets`, `pairing` (the identity service), `outputs` (the output store
port), `stateStore` (`FileGatewayStateStore` in a private state directory for resume across restarts), `logger`.

Unknown config keys are refused when the channel is constructed.

## 6. Reply rules

- **Direct messages** are answered when the sender is in `dmAllowlist`, or the DM channel is in `allowlist`. Anyone else is
  dropped silently; the log records the drop without content.
- **Guild channels** are answered only when the channel id is in `allowlist`.
- **Threads** are chats of their own: a thread is answered when its id, or the id of its parent channel, is in `allowlist`.
  The parent is learned from `THREAD_CREATE`, `THREAD_UPDATE` and the `GUILD_CREATE` snapshot, so a thread that was created
  while the bot was offline is known after the next of those events. Replies go into the thread the message came from.
- **Bot and own messages** are always ignored (loop prevention).
- `replyPolicy`:
  - `mention`: only when the bot is mentioned (`<@id>` or `<@!id>`, stripped from the text) or one of its messages is replied to.
  - `always`: every message in an allowed channel.
  - `allowlist`: every message from `userAllowlist` members; other people only when they address the bot.
- A `userAllowlist` restricts who is heard in groups, even when a stranger mentions the bot.
- Duplicate deliveries of the same message id are processed once.

## 7. Approvals (D109 buttons)

`prompt` sends a message with one button per choice (up to five per row, five rows). Each button carries an opaque, signed,
single-use handle of at most 39 characters, bound to the chat and to the `approverIds`.

- Only an approver can press. Anyone else gets an ephemeral refusal and the handle stays valid for the approver.
- A forged, expired, replayed or wrong-channel press is refused politely and never emitted as a decision.
- The first valid press emits one `ApprovalDecision` and edits the message so that every button is disabled.
- TTL defaults to 5 minutes; the maximum is 24 hours.
- A decision is a request to the host, not a grant. The channel never grants anything itself.

## 8. Pairing with `/link`

`/link code:<code>` works in direct messages only (guild use gets a refusal). It calls `pairing.claim` with
`{ channel: "discord", accountId: <bot user id>, userId: <sender id> }`. Every failure gets the same reply, and the code is
never logged or echoed. The command is registered only when a `pairing` port is supplied.

`/status` answers ephemerally with the connection state.

Interactions are acknowledged within Discord's 3-second limit. If an answer takes longer, the channel first sends a deferred
ephemeral acknowledgement and then edits the original response.

## 9. Messages, formatting and attachments

- Text is converted for safe display. Formatting and code fences survive; every mention (`<@…>`, `<@&…>`, `<#…>`, slash-command
  references) and `@everyone` / `@here` is defused with a zero-width character, and every message carries
  `allowed_mentions: { parse: [] }`.
- Messages longer than 2000 characters are split. An open code fence is closed at the cut and reopened with its language.
- Replies use `message_reference` on the first part only.
- Attachments in: bounded by declared and downloaded size, by a MIME allowlist, and downloaded only from Discord's CDN hosts
  over https without redirects. A rejected attachment drops the whole message, as on Telegram.
- Attachments out: from the output store only, after `authorize` and an integrity check (`sendOutput`), one file per message.
- Typing indicator: `typing`. Streaming: `sendTurn` then `edit`, which is rate-limit aware through the shared limiter.

## 10. Limits

- A single shard, JSON encoding. Session start limits are not read; backoff limits the crash-loop rate.
- A deliberate stop closes the gateway with code `4000` (resumable). With `FileGatewayStateStore` a restart resumes the
  session while Discord still holds it; after that the bot identifies afresh. Without a state store, the in-process session
  is kept across `stop()` / `start()` only.
- Threads are chats: replies go into the thread the message came from. Creating threads is not implemented.
- After a restart, the bot can reply in a direct-message channel only after that user has written to the bot again. The
  channel-to-user mapping is in memory; a rebuilt mapping from the Discord REST API is a follow-up.
- An ambiguous network failure on a send (no response) may duplicate that message, because Discord may have applied it.
- `edit` takes one message of at most 2000 characters.
- Rate limits: 429 waits for the clamped `Retry-After` (1 s to 5 min), then retries a bounded number of times.

## 11. Troubleshooting

| Symptom | Check |
| --- | --- |
| `start` rejects with a 401 | token replaced or wrong secret name; reset the token, update the secret, restart |
| `host.fail` with close 4004 | the token is invalid; the channel does not retry |
| close 4014 | Message Content Intent is not enabled in the portal |
| close 4013 | intents list contains an unknown or invalid entry |
| Bot is silent in a channel | channel id missing from `allowlist`; or `mention` policy and the bot was not mentioned |
| Bot is silent in a thread | the thread's parent channel (or the thread) is missing from `allowlist`; a thread created while the bot was offline needs one thread event first |
| Bot is silent in DMs | sender missing from `dmAllowlist`; or the user shares no server with the bot |
| `403 forbidden` on send | the bot lacks View / Send permission in that channel |
| `/link` says it failed | the code is wrong, expired or was already used; request a new one |
| `/link` is missing from the command list | the host did not supply a `pairing` port |
| Buttons say "expired or invalid" | the TTL passed or the prompt was already answered; send a new prompt |

## 12. Interface wishes (for the core)

- A text-only framework path cannot carry attachments, buttons, thread ids or edits. Those go through `onMessage` / `sendTurn`
  today; the framework path logs `channel.discord.framework-rich-turn-gap` for them.
- A decision port in the core would let approvals bind to the D109 authorisation directly.
- A shared `SentRef` / `ApprovalPrompt` type would remove the per-package duplicates.
- A chat-kind value for threads would avoid overloading `direct` / `group`.
