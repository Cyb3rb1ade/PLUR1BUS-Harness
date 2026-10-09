# Matrix channel

Package: `packages/channels-matrix/` (`@plur1bus/channels-matrix`). Client-Server API r0/v3 over `fetch`, no runtime dependencies.

## Scope and status

| Function | Status |
| --- | --- |
| Text in/out, DMs, rooms, threads (`m.thread`), replies (`m.in_reply_to`), mentions (`m.mentions`) | Yes |
| Edits (streaming via `m.replace`), typing | Yes |
| Media in/out (`m.image`, `m.file`, `m.audio`, `m.video`) | Yes, bounded, MIME allowlist |
| Reaction-based approvals (D109) | Yes |
| `/link <code>` or `!link <code>` pairing (DM only) | Yes, needs the `pairing` port |
| End-to-end encryption | **No.** Encrypted rooms are refused (see below) |
| Reply-code approval fallback | No (follow-up) |

## 1. Create the bot account

On your homeserver create a regular account for the bot, for example `@bot:example.org`. Use your server's admin tools or
registration flow. Disable open registration if the server is shared. The bot needs no admin rights. For reaction approvals it
should be able to redact reactions from others (power level), otherwise unauthorized reactions stay visible (they are still
ignored).

## 2. Obtain an access token without putting it in config

Log in once with the password login endpoint, from a machine you control. Do not paste the token into config, source files,
tickets or shell history:

```bash
read -rs PW && curl -sS -X POST https://matrix.example.org/_matrix/client/v3/login \
  -H 'content-type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"bot\"},\"password\":\"$PW\",\"initial_device_display_name\":\"PLUR1BUS bot\"}" \
  -o login.json && unset PW
```

Copy `access_token` from `login.json` into your host secret store under a name such as `matrix/bot-token`, then delete `login.json`.
Note `device_id` from the same response. Set `deviceId` in config if you want the channel to refuse a token from another device.
Use a dedicated device per bot; logging in again creates a new device.

Config refers to the secret **name** only:

```json
{
  "homeserverUrl": "https://matrix.example.org",
  "userId": "@bot:example.org",
  "accessTokenSecret": "matrix/bot-token",
  "deviceId": "ABCDEF1234",
  "autoJoin": "allowlist",
  "allowlist": ["!roomid:example.org"],
  "dmAllowlist": ["@alice:example.org"],
  "replyPolicy": "mention",
  "maxMediaBytes": 10485760,
  "locale": "en"
}
```

## 3. Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `homeserverUrl` | required | `https://…`; plain `http` only for loopback (`127.0.0.1`, `localhost`, `[::1]`). No credentials, query or fragment. |
| `userId` | required | The bot's full mxid. Checked against `whoami` at start; a mismatch refuses to start. |
| `accessTokenSecret` | required | Secret name. Empty or malformed values refuse to start. |
| `deviceId` | none | If set, must match `whoami`. |
| `autoJoin` | `allowlist` | `allowlist`: accept invites from an allowlisted room or a `dmAllowlist` inviter, decline others. `never`: leave invites pending. |
| `allowlist` | `[]` | Room ids (`!…`) the bot may use. Empty = nobody, inbound and outbound. |
| `dmAllowlist` | `[]` | Sender mxids that may DM the bot. Empty = no DMs. |
| `userAllowlist` | absent | If set, only these senders are heard in groups. Required for `replyPolicy: allowlist`. |
| `replyPolicy` | `mention` | Groups only. `mention`: only when addressed. `always`: every message of an allowlisted room. `allowlist`: all messages from `userAllowlist`, others only when addressed. |
| `maxMediaBytes` | 10 MiB | Hard maximum 25 MiB. Checked before download and while streaming. |
| `locale` | `en` | `en` or `de` for the bot's own messages. |

## 4. Rooms, DMs and invites

- A **DM** is a room that `m.direct` ties to a peer on `dmAllowlist`, or a room joined from a direct invite by such a peer.
  Member counts never decide this. A 2-person room is a group room unless the rules above say otherwise.
- The room allowlist does not grant DM access. An allowlisted room with an unlisted member is a group conversation, so
  `replyPolicy` applies, and that member is not treated as a DM sender.
- **Invites:** with `autoJoin: allowlist` the bot joins when the room is allowlisted or the inviter is on `dmAllowlist`, and
  leaves (declines) otherwise. Declines are logged without content. With `autoJoin: never` invites stay pending and the bot
  never joins or leaves.
- **History:** the first start performs an initial sync that establishes the sync position and discards old timeline
  events. Old messages are never replayed. Messages sent while the bot was offline before its first start are not delivered.

## 5. Unencrypted rooms only (no E2EE yet)

The channel does not hold Megolm keys. An encrypted room (`m.room.encryption` state, or `m.room.encrypted` events) is refused:
the bot sends **one** plain notice per room ("This room is end-to-end encrypted; this bot cannot read it yet. Please use an
unencrypted room.") and then ignores the room. The refusal is remembered in memory, so after a restart the notice can be sent
again on the next encrypted event. Encrypted attachments are refused. Use unencrypted rooms for the bot until the E2EE
follow-up package lands.

## 6. Reply rules

- Inbound: replies and threads are recognised. The legacy reply quote (`> <@user> …`) is stripped from the body when the event
  carries mx-reply HTML. Thread fallbacks are not treated as replies. `chatId` for a thread is `<roomId>:<threadRootEventId>`,
  so each thread is its own session and replies go back into it.
- Outbound: `replyTo` sets `m.in_reply_to`. In a thread the event carries `m.thread`; `is_falling_back` is true when there is no
  explicit reply target.
- Outbound text carries `m.mentions: {}`, so model text does not ping people. A literal `@room` is neutralised.
- Edits (`m.replace`) from other users are not dispatched. Own events and the bot's own notices are ignored, so there are no loops.

## 7. Approvals (reactions)

`prompt()` sends the question with a numbered choice list and pre-seeds one reaction per choice: `1️⃣`, `2️⃣`, … and `❌` for
`deny`. Only `approverIds` can activate a choice, by reacting with that emoji. Rules:

- single use; TTL default 5 minutes, maximum 24 hours (validated before anything is sent);
- chat-bound: a reaction in another room is ignored;
- an unauthorized reaction is redacted (best effort) and logged without content;
- an expired or replayed activation by an approver gets one plain notice ("This confirmation is no longer valid.") and no decision;
- the channel never grants anything itself: a valid activation only emits an `ApprovalDecision` for the host.

## 8. `/link` pairing

In a DM, send `/link <code>` or `!link <code>` (some clients intercept `/`). The sender is the Matrix user, and the account is
the bot's own mxid. The channel calls `pairing.claim({ code, identity: { channel: "matrix", accountId: <bot mxid>, userId: <sender> } })`.
Replies are uniform on failure. The code is never forwarded to the host and never logged. In groups `/link` is ignored and
not forwarded, so the code cannot leak to other members. Without a `pairing` port every attempt gets the failure reply.

## 9. Media

- Inbound: `mxc://` URIs are downloaded only from the configured homeserver, via the authenticated media endpoint
  (`/_matrix/client/v1/media/…`, multipart). If the server does not know it (404 / `M_UNRECOGNIZED`), the deprecated v3 endpoint is
  used. Redirects are refused. Size is bounded before and during the transfer; MIME must be on the allowlist (images, audio,
  video, PDF, JSON, ZIP, plain text). HTML, SVG and executables are refused. Encrypted files are refused.
- Outbound: uploads use `/_matrix/media/v3/upload` (the only upload path in the spec). Images from the output store are checked
  for authorization and integrity before any read.

## 10. Limits

- Outbound text per event: 16000 UTF-8 bytes of Markdown source. Matrix caps an event at 65 KiB; the rest is formatting headroom.
  Fences are closed and reopened across chunks.
- Rate limits: `429 M_LIMIT_EXCEEDED` waits `retry_after_ms` clamped to 1 s – 5 min. Sends retry with bounded backoff and jitter
  for rate limits, network errors, timeouts and 5xx; 4xx other than 429 is not retried. A 403 marks the room inactive until restart.
- Retries reuse one transaction id, so a retried send is de-duplicated by the homeserver for this device. Beyond the server's
  transaction window a network-ambiguous send may still duplicate.
- Dedupe: processed event ids are kept in a bounded in-memory set (4096 entries). A restart may redeliver recent events that
  the sync token had not yet covered.

## 11. Troubleshooting

- Start refuses with "does not match the configured userId": the token belongs to another account. Fix the secret or config.
- Start refuses with "sync state is unusable": the sync position file is corrupt. Remove it deliberately to re-run the initial
  sync (history is then discarded, as on any first start).
- 401 at runtime: the token was revoked. The channel reports fatal (`host.fail`) and stops. Re-login, update the secret, restart.
- No messages in a room: check `allowlist`, `replyPolicy`, the mention, and whether the room is encrypted (you should see a notice).
- Invites ignored: check `autoJoin` and that the inviter is on `dmAllowlist` or the room is on `allowlist`.

## 12. Interface wishes (for the core contract)

- A typed `ChannelMessage` with thread and reply fields in `InboundMessage` (today only adapter ports carry them).
- A standard approval-reaction contract shared with Telegram buttons (`prompt`/`onDecision` is already the same shape).
- A typing and edit capability negotiation the framework can read before choosing streaming.
- Explicit encrypted-room signalling so the host can pick a room for the user instead of learning from a notice.
