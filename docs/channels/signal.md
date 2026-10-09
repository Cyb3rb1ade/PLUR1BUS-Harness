# Signal channel

The Signal channel talks to a locally running `signal-cli` daemon over JSON-RPC 2.0 (newline-delimited). It connects to a unix socket or loopback TCP endpoint that you start yourself. The channel never spawns `signal-cli`, never registers or links an account, and stores no credentials: the daemon owns the Signal account and its keys.

## 1. Install signal-cli

Install a current `signal-cli` release (Java runtime required) from the project's releases page and check it with `signal-cli --version`. Use the same version on the machine that will run the daemon. Check the exact flags with `signal-cli daemon --help` for your version; the names below follow the 0.13 line.

## 2. Register or link the account

Pick one of two ways. Keep the account data in a private directory owned by the service user (`signal-cli --config <dir>` sets it).

- **Dedicated number (recommended):** register a number that is used only by the bot. `signal-cli -a +4915112345678 register`, then enter the SMS or voice code with `signal-cli -a +4915112345678 verify CODE`. A captcha may be required; follow the message from signal-cli.
- **Secondary device on your own phone:** `signal-cli link -n "switchboard"` prints a `sgnl://linkdevice?...` URI. Render it as a QR code on a trusted machine and scan it in Signal under Settings, Linked devices. The bot then shares your identity. Use this only if you accept that the bot can read everything your account can read.

Confirm the account is listed by signal-cli (subcommand names vary by version; `signal-cli --help` lists them). The channel refuses to run if the daemon reports the account as not registered.

## 3. Run the daemon

Unix socket (preferred, no network listener):

```sh
signal-cli -a +4915112345678 daemon --socket /home/bot/.local/state/signal/signal.sock
```

Loopback TCP (use only if the socket is not possible):

```sh
signal-cli -a +4915112345678 daemon --tcp 127.0.0.1:7583
```

Socket permissions: create the directory with mode `0700` and make the socket owned by the service user only (`chmod 600` after creation if your signal-cli version creates it world-readable). Anyone who can connect to the socket can send messages as the account. Do not place it in a shared `/tmp`.

Keep the daemon running as a service:

- **systemd (Linux):** a user unit with `ExecStart=/usr/bin/signal-cli --config %h/.local/share/signal-cli -a +4915112345678 daemon --socket %t/signal/signal.sock`, `Restart=always`, `RestartSec=5`. Set `RuntimeDirectory=signal` so `%t/signal` is created with user-only permissions.
- **launchd (macOS):** a LaunchAgent in `~/Library/LaunchAgents` with the same arguments, `KeepAlive` true, and stdout/stderr redirected to a private log file. Logs can contain message metadata; keep them private and rotate them.

## 4. Configure the channel

Only secret-free configuration goes in the channel config. Your host supplies the channel factory and the pairing, output and logging ports.

```json
{
  "enabled": true,
  "account": "+4915112345678",
  "endpoint": { "socketPath": "/home/bot/.local/state/signal/signal.sock" },
  "allowlist": ["Zm9vYmFyYmF6cXV4ZmFrZWdyb3VwaWQ="],
  "dmAllowlist": ["+4915187654321"],
  "userAllowlist": ["+4915187654321"],
  "replyPolicy": "mention",
  "maxMediaBytes": 10485760,
  "locale": "en"
}
```

| Key | Default / meaning |
| --- | --- |
| `account` | Required. The registered account, E.164 (`+` and 7 to 15 digits). |
| `endpoint` | Required. `{ "socketPath": "/abs/path.sock" }` or `{ "host": "127.0.0.1", "port": 7583 }`. |
| `allowRemoteEndpoint` | `false`. Required for a non-loopback `host`. JSON-RPC is plaintext: only use this over a private tunnel you trust. |
| `allowlist` | Group ids that may talk to the bot. Empty allows no group, inbound or outbound. |
| `dmAllowlist` | Sender ids (E.164 or uuid) that may DM the bot. Empty allows no DMs. |
| `userAllowlist` | Optional. In groups, only these senders are heard (see reply rules). |
| `replyPolicy` | `mention` (default), `always`, or `allowlist`. Groups only. |
| `maxMediaBytes` | 10 MiB by default, hard maximum 25 MiB. Applies to inbound and outbound attachments. |
| `locale` | `en` (default) or `de` for bot-authored strings. |

Configuration takes effect on channel restart. Invalid values fail at construction with a fixed message. Chat and sender ids appear in the config file; the phone numbers you put there are personal data, so keep the config private.

## Identities: what the ids mean

- **Sender id:** the E.164 number when the daemon provides one, otherwise the ACI uuid. Allowlists accept either form. The uuid never changes; a number can.
- **Chat id:** for groups, the Signal group id (base64). For direct messages, the sender id.
- **Account id for pairing:** the configured `account`. The bot's uuid is learned from `listAccounts` and used only to recognise the bot in mentions and quotes.
- Sender ids are transport metadata, not harness principals. Identity resolution happens in the host through pairing.

## Reply rules

Direct messages are answered when the sender is in `dmAllowlist` (or the sender id is in `allowlist`). Anything else is dropped silently; the log records the reason, never the content.

In groups, the group must be in `allowlist`. Then:

- `mention` (default): a message is handled when it mentions the bot or quotes one of its messages.
- `always`: every message in an allowed group is handled.
- `allowlist`: members of `userAllowlist` are handled always; other senders only when they address the bot.

With `userAllowlist` set and `mention` or `always`, senders outside that list are not heard at all. A mention of the bot is stripped from the text; other mentions become `@name`.

Messages from the bot itself, sync copies, receipts and typing notices are ignored. Duplicate deliveries (same source and timestamp) are processed once within a bounded cache.

## Inbound content

- **Text** arrives as plain text. Replies to a bot message count as addressed.
- **Attachments** (images, audio, video, PDFs, plain text) are fetched through the daemon's `getAttachment` call. The declared size, the MIME allowlist and the decoded size are checked before the bytes are used. Anything refused gets a short notice and the message is not delivered. HTML, SVG and executables are not accepted.
- **Reactions** are delivered only on the rich `onMessage` port, never as text.
- **View-once** messages are refused with a notice; their content is never fetched.
- **Disappearing messages** are delivered with `expiresInSeconds` so the host can decide how to store them.
- **Commands:** `/link <code>` and `/help` in direct messages only (see below). Other slash text is ordinary text.

## Outbound content

Markdown is converted to plain text with Signal text styles: bold, italic, strikethrough, monospace (inline code and code blocks) and spoiler. Links become `text (url)` because Signal has no link markup. Headings become bold lines, bullets become `•`. Literal `@` text stays literal. Messages are split at 2000 UTF-16 code units, preferring paragraph breaks, and styles are re-based for each part, so a code block that spans two parts stays monospace in both.

- Quote-reply: `replyTo` quotes the referenced message when the channel saw it (a bounded recent cache). Otherwise the message is sent without a quote.
- Attachments are sent as `data:` URIs with the filename sanitised. Output-store images are authorised before the file is read and verified against their hash.
- Edits use signal-cli's `editTimestamp` for the channel's own messages and must fit in one message.
- Typing indicators are best effort.
- Buttons are not supported and throw `UnsupportedError` (code `unsupported`).

## Approvals (reply codes)

`prompt()` posts the question with numbered choices and a random four-character token, for example:

```
Run the tool?

1 = once
2 = session
3 = always
0 = deny

Reply "7K2Q <number>" with the number of your choice (for example "7K2Q 1").
```

A decision is accepted only when all of these hold: the reply contains both the token and a valid code; it comes from a listed approver in the same chat; the prompt has not expired (default five minutes, maximum 24 hours); and it has not been used. A decision is emitted once. Wrong senders and invalid codes get a generic refusal and do not consume the prompt; twenty failed attempts end it. The channel never grants anything itself: `onDecision` only reports what the approver typed, and the host decides what it means.

## Identity pairing: `/link`

In a direct message from an allowlisted sender, `/link <code>` submits the code to the host's pairing port with `channel: "signal"`, `accountId` set to the configured `account`, and `userId` set to the sender id. The reply is the same for every failure. The code is never logged, echoed or included in an error. Without a pairing port, `/link` replies with the failure text and claims nothing.

## Limits and known gaps

- No end-to-end encryption features beyond what Signal does. No group administration (member changes, group settings, admin-only commands).
- No threads, buttons, or reaction approvals. Reactions are received but not sent.
- Quote-replies need a message the channel has seen in this process; after a restart, replies are sent unquoted.
- Send retries apply only to daemon rate limits, which are rejected before delivery. Timeouts and dropped connections are not retried, because the message may already have been delivered. Signal has no idempotency key, so a retry after such a failure could duplicate a message.
- Rate limits: each chat is limited to about one message per second, and daemon `RATE_LIMIT` responses wait the server's hint (clamped to 1 s to 5 min).
- Attachment bytes travel over the daemon socket as base64, so a 25 MiB attachment means roughly 33 MB per JSON line. The channel reads at most 40 MiB per line.
- Bounded caches (dedupe, quote authors, pending approvals) are process-local and reset on restart.
- The channel is a library. The host wires it into the registry, supplies pairing and output ports, and decides how decisions are applied.

## Troubleshooting

- **Start fails with "signal daemon start failed":** the daemon is not running, or the socket path or port is wrong. Check that the daemon is up and listening on that socket or port.
- **"not registered":** the account was never linked on this daemon, or the daemon runs with a different `--config` directory.
- **Send fails with an untrusted identity:** a contact's safety number changed. Verify it in Signal, then trust the new key with signal-cli's trust subcommand for your version.
- **Messages ignored:** check `allowlist` (group ids) and `dmAllowlist` (sender ids), the reply policy, and whether the bot was mentioned. Logs say why without showing content.
- **Attachment refused:** check `maxMediaBytes` and the MIME type. The refusal does not reveal the file.
- **Socket permission denied:** the service user must own the socket and its directory.
- **Daemon restarted:** the channel reconnects with backoff and jitter and re-subscribes. Pending approvals are lost and must be asked again.

## Interface wishes

- A rich-turn binding in the core for attachments and reactions, so `channel.signal.framework-rich-turn-gap` stops being logged for every attachment.
- A sender-identity port that accepts both number and uuid for one person.
- A shared approval contract (reply codes and buttons) with the same decision shape across channels.
- An idempotency key or message receipt on send, so ambiguous network failures can be retried safely.
