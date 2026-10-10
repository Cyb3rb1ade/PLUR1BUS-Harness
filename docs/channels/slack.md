# Slack channel

This guide sets up the Slack channel package (`packages/channels-slack`) for a workspace. It follows the same structure as the [Telegram guide](telegram.md).

## Principles

- **Socket Mode only.** The bot opens an outbound WebSocket with an app-level token. There is no public request URL, no slash-command HTTP endpoint and no inbound port. Nothing in this integration is reachable from the internet.
- **Credentials stay in the secret store.** Config holds secret **names** only. Never paste a token into config, source, tests, command lines, or logs. The channel refuses a config value that looks like a credential.
- **Allowlists fail closed.** An empty `allowlist` admits no conversation. An empty `dmAllowlist` admits no direct messages.
- **Nothing is granted by a click.** Approval buttons only report a human's decision to the host. The host decides what it means.

## 1. Create the app

Open <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick the workspace, and paste the manifest below in YAML (or switch to JSON). Review the summary and create the app.

```yaml
display_information:
  name: plur1bus
  description: Harness bridge
features:
  bot_user:
    display_name: plur1bus
    always_online: true
  slash_commands:
    - command: /plur1bus
      description: Link this account or show status
      usage_hint: "link <code> | status"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - chat:write
      - files:read
      - files:write
      - reactions:read
      - users:read
      - commands
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Notes on the manifest:

- `socket_mode_enabled: true` is what keeps the app off the public internet. With Socket Mode, Slack does not need a request URL for events, interactivity or commands. Leave the request URL fields empty.
- `interactivity.is_enabled: true` delivers Block Kit button presses (approvals and generic buttons) over the socket.
- `users:read` is requested for future identity lookups. The current code path does not call `users.*`; remove it if your review policy forbids unused scopes.
- `chat:write` is required for posting, updating and ephemeral replies. `files:write` is required for uploads.

## 2. Install and collect the tokens

1. **Install to workspace** (OAuth & Permissions). Copy the **Bot User OAuth Token**, which starts with `xoxb-`. This is the bot token.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes.** Add the single scope **`connections:write`**. Copy the token, which starts with `xapp-`. This is the app-level token used only for `apps.connections.open`.
3. Store both in the host secret store as `channels.slack.bot-token` and `channels.slack.app-token` (the switchboard only reads secrets named `channels.slack.*`). Pass those names as `botTokenSecret` and `appTokenSecret`.

Do not reinstall the app after rotating a token without updating the secret store. A revoked token is a fatal start failure (`invalid_auth`, `token_revoked`, `account_inactive`); the channel does not retry it.

## 3. Add the bot to conversations

- **Channels and private channels:** invite the bot with `/invite @plur1bus`. A channel the bot is not in produces `not_in_channel`; the channel is then marked inactive until restart.
- **Direct messages:** a user opens a DM with the bot from the app's **App Home** tab. The bot can reply in a DM only after it has received an accepted message from that user in the same process (see the reply rules).
- **Group DMs:** add the bot to the group conversation.

Copy each conversation ID (channel details, or the link menu: the ID starts with `C`, `G`, or `D`) and list it in `allowlist`. Copy each user ID (profile, "Copy member ID", starts with `U` or `W`) and list it in `dmAllowlist` or `userAllowlist`.

## 4. Configure the channel

```json
{
  "enabled": true,
  "botTokenSecret": "channels.slack.bot-token",
  "appTokenSecret": "channels.slack.app-token",
  "teamId": "T0123ABCD",
  "allowlist": ["C0123ABCD", "G0123ABCD"],
  "dmAllowlist": ["U0123ABCD"],
  "replyPolicy": "mention",
  "maxMediaBytes": 10485760,
  "locale": "en"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Read by the host registry. |
| `botTokenSecret` | required | Secret name of the `xoxb-` bot token. |
| `appTokenSecret` | required | Secret name of the `xapp-` app-level token (`connections:write`). |
| `teamId` | unset | If set, `auth.test` must report this workspace or start fails. |
| `allowlist` | required | Channel, group, or DM conversation IDs that may talk to the bot. Empty allows nothing. |
| `dmAllowlist` | required | User IDs that may DM the bot. Empty allows no DMs. |
| `userAllowlist` | unset | If present, only these users are heard in groups (see reply rules). |
| `replyPolicy` | `mention` | `mention`, `always` or `allowlist`. Groups only. |
| `maxMediaBytes` | 10 MiB | Hard maximum 25 MiB; checked before and during download and before upload. |
| `locale` | `en` | `en` or `de` for bot strings. |

Changes take effect when the channel restarts.

## 5. Reply rules

- **Direct messages:** answered if the sender is in `dmAllowlist` or the DM channel is in `allowlist`. Anything else is dropped silently; the log records only the reason, never the content.
- **Groups and channels:** the channel must be in `allowlist`. Otherwise the message is dropped.
- `replyPolicy: mention` (default): only messages that mention the bot (`@plur1bus`) are heard. Thread replies that do not mention the bot are not treated as addressed.
- `replyPolicy: always`: every message in an allowed group is heard.
- `replyPolicy: allowlist`: messages from `userAllowlist` members are heard; others are heard only when they mention the bot. Without `userAllowlist` this behaves like `mention`.
- `userAllowlist` present: non-members are never heard in groups under `mention` and `always`. Under `allowlist`, a non-member is heard only when mentioning the bot. This is the one exception to "only these senders are heard", and it is intentional.
- Bot messages, the bot's own messages, and message subtypes other than `file_share` and `thread_broadcast` are ignored. A message delivered twice (as `message` and `app_mention`) is processed once.
- Mentions of the bot are removed from the text before the host sees it.
- Replies go to the thread the inbound message belongs to. A top-level message gets a top-level reply.

Conversation keys: a channel is `C0123ABCD`. A thread in a channel is `C0123ABCD:1700000000.000100`. Each thread is its own session, and replies return to that thread.

## 6. Approvals (D109)

`prompt({ chatId, text, choices, approverIds, ttlMs?, threadId? })` posts the text and one button per choice:

- Each button's `action_id` is a random handle plus a MAC, bound to the chat and to the approver list. It carries no choice name, no user data, and no approval text. `value` is empty.
- Handles are single-use and expire after `ttlMs` (default 5 minutes, maximum 24 hours). A restart invalidates all outstanding handles.
- Only `approverIds` may decide. A press from anyone else gets an ephemeral refusal and does not consume the handle. A press from outside the policy (DM sender not allowed, channel not allowlisted, or outside `userAllowlist`) is dropped before any handle is touched.
- A replayed, expired or forged handle gets an ephemeral "expired" reply and never produces a decision.
- The approver's first valid press emits one `ApprovalDecision` to `onDecision` and replaces the message with the outcome (`chat.update` without blocks removes the buttons).

Approval buttons are the approval mechanism for Slack. Reaction-based approval is not offered.

## 7. Pairing with `/plur1bus link`

In a DM with the bot, type `/plur1bus link CODE`, where `CODE` is the one-time code from the harness. The pairing claim uses `accountId` = the bot's own user ID and `userId` = the sender's user ID.

- Only DMs are accepted. In a channel the command is refused with a direct-message hint.
- The reply is uniform: every failure gets the same pairing-failed text, whatever the cause. Success gets a separate text that says to confirm the link in the identity page.
- The code is never logged or echoed.
- Without a host `pairing` port, `link` is not offered; `/plur1bus status` still works.
- `/plur1bus status` reports whether the bot is connected.

The slash command replies are ephemeral: only the person who typed the command sees them.

## 8. Messages and formatting

- Markdown from the model is converted to Slack mrkdwn: bold, italic, strike, inline and fenced code, links, lists, quotes, headings (as bold lines), rules, and tables (as code blocks).
- `&`, `<` and `>` are escaped, so `<!channel>`, `<!here>`, `<@U…>`, `<#C…>` and any raw link token in model or user text are shown literally. Only validated `http(s)` and `mailto` links from markdown become Slack links.
- Links are sent with unfurling off and `link_names` off. Nothing pings a channel or a user unless the host asks for it through an approval text, which names the decider.
- Long text is split at 3500 characters (buttons: 2900 per section) without tearing a code fence, a surrogate pair, or an angle-bracket token.

## 9. Files

- **In:** images, documents, audio and video are downloaded with the bot token, but only from `files.slack.com` (or the injected test host). Redirects are checked hop by hop. A redirect to another host is refused. Size is checked against the declared size and during download. The MIME type must be on a conservative allowlist (images, audio, video, PDF, zip, JSON, plain text). HTML, SVG and executables are refused, and a message with a refused file is dropped entirely. Attachments reach the rich `onMessage` handler. The text-only framework path logs `channel.slack.framework-rich-turn-gap`.
- **Out:** attachments use the `files.getUploadURLExternal`, raw POST, `files.completeUploadExternal` flow. `sendOutput(chatId, outputId)` reads from the trusted output store after `authorize` and an integrity check (SHA-256 and size). Uploads are refused above `maxMediaBytes` and for MIME types outside the allowlist.

## 10. Rate limits and retries

- Per-channel pacing: about one `chat.postMessage` or `chat.update` per second per conversation, plus a global cap of 20 requests per second.
- `429` with `Retry-After` waits the server hint, clamped to 1 s to 5 min. Network, timeout and `5xx` failures retry with exponential backoff and jitter, up to three retries. Other `4xx` responses are not retried.
- A `not_in_channel`, `channel_not_found`, `is_archived` or `user_not_in_channel` answer marks the conversation inactive for this process. Fix membership and restart.
- Ambiguous network failures may duplicate a `chat.postMessage`. A retry after a dropped response can post twice.

## 11. Reconnects and idempotence

- Socket Mode: each envelope is acknowledged before it is processed. A late ack makes Slack redeliver, so duplicates are dropped by envelope id and by event id (bounded cache). Pass a `seen` store (`FileSeenStore`) to keep event ids across restarts. A corrupt store fails start closed.
- `disconnect` with `refresh_requested` or `warning` opens a replacement connection with a fresh URL, then closes the old one. Other drops reconnect with exponential backoff and jitter. A connection that stays up for 30 seconds resets the backoff.
- `invalid_auth`, `account_inactive`, `token_revoked`, `not_authed`, `token_expired`, `invalid_token`, `not_allowed_token_type`, `missing_scope` and a `link_disabled` disconnect are fatal: the channel reports `host.fail()` once and stops retrying.
- Dedupe persists each event id before dispatch, so a crash after dispatch does not replay it. A crash before dispatch loses that one event.

## 12. Limits

- Edit: `edit()` changes one message and must fit in one Slack message (3500 characters). Uploaded files are not editable.
- Typing: not available for bots through the general API. `typing()` resolves without doing anything.
- Buttons and handles reset on restart. An approval outstanding across a restart is refused with "expired", so the host should re-prompt.
- DMs: the bot can answer a DM user only after that user has written to the bot in this process, because opening a DM needs `im:write`, which is not requested.
- `chat:write` lets the bot post in any channel it is a member of. Only allowlisted conversations are used, but the scope itself is workspace-wide.

## 13. Troubleshooting

| Symptom | Check |
| --- | --- |
| `slack authentication failed` at start | The bot token is wrong or revoked (`auth.test` `invalid_auth`). Replace the secret, restart. |
| Start fails with `not set` or `unexpected format` | The secret name points to nothing, or to a value that is not `xoxb-…` / `xapp-…`. |
| Connects, then nothing is heard | Check Socket Mode is on, event subscriptions include `message.*` and `app_mention`, the bot is in the channel, and the channel is in `allowlist`. |
| Channel messages ignored | Under `mention` the bot must be mentioned. Check `replyPolicy` and `userAllowlist`. |
| Button press does nothing | Check interactivity is on, the press came from an approver, and the prompt has not expired. Restarts invalidate handles. |
| `/plur1bus` not recognised | The slash command must exist in the manifest and the app must be reinstalled after changes. |
| `not_in_channel` | Invite the bot to the channel with `/invite @plur1bus`, then restart. |
| Files rejected | Check size, MIME type (HTML, SVG and executables are refused by policy) and that the file host is `files.slack.com`. |
| Duplicate posts after an outage | Expected under ambiguous network failure (see section 10). |

## Interface wishes

Items the text-only core does not yet carry, collected for the lead:

- Rich turns: attachments, reactions, callbacks and thread keys need a framework event model (`chatId` already encodes the thread).
- Approvals: `ApprovalPrompt`/`ApprovalDecision` should live in a shared package, not be duplicated per channel.
- Pairing: `claim` should be async-capable so the channel can await durable rate limits.
- `typing()` could be a capability-gated call so hosts can skip it entirely.

## Verification

```sh
node ../../scripts/test-package.mjs   # from packages/channels-slack
```

Slack's official references: [Socket Mode](https://api.slack.com/apis/socket-mode), [app manifests](https://api.slack.com/reference/manifests), [chat.postMessage](https://api.slack.com/methods/chat.postMessage), [Block Kit](https://api.slack.com/block-kit).
