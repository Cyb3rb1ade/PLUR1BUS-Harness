# Switchboard

The switchboard connects chat platforms to the harness core. Each platform is a channel: a
package that implements the core `Channel` contract (`packages/core/src/channels/`) and is
configured under `channels.<id>.*`. Every channel is off by default and needs a restart of its
module to take effect.

## Kanäle

| Channel | Package | Chats | Status |
| --- | --- | --- | --- |
| Telegram | `packages/channels-telegram` | direct, group | Shipped (see [telegram.md](channels/telegram.md)) |
| Discord | `packages/channels-discord` | direct, guild channel, thread | New ([discord.md](channels/discord.md)) |
| Slack | `packages/channels-slack` | direct, channel, group | New ([slack.md](channels/slack.md)) |
| Matrix | `packages/channels-matrix` | direct, room, thread | New ([matrix.md](channels/matrix.md)) |
| Signal | `packages/channels-signal` | direct, group | New ([signal.md](channels/signal.md)) |
| E-mail | `packages/channels-email` | direct (mail thread) | New ([email.md](channels/email.md)) |
| WhatsApp | — | — | Follow-up package |

All new channels share the same behaviour where the platform allows it: allowlists that deny by
default, a reply policy for groups (`mention`, `always`, `allowlist`), bounded attachments,
secret references by name only, `/link <code>` pairing through the identity port, and approval
prompts (D109) that only the listed approver can answer.

## Kanal × Feature

Capabilities as declared by each package (`capabilities` on the channel object). "Inbound only"
means the platform's events are received and passed on, but the channel does not send them.

| Feature | Telegram | Discord | Slack | Matrix | Signal | E-mail |
| --- | --- | --- | --- | --- | --- | --- |
| Text in and out | yes | yes | yes | yes | yes | yes |
| Threads / replies | reply, forum topics | reply, threads | `thread_ts` | `m.thread`, reply | quote-reply (this process) | mail threads |
| Mentions | yes | yes | yes | yes | yes | — |
| Attachments in | yes (rich turn) | yes (rich turn) | yes (rich turn) | yes (rich turn) | yes (rich turn) | yes (rich turn) |
| Attachments out | yes | yes | yes | yes | yes | yes |
| Edit / streaming | no | yes | yes | yes | yes | no |
| Typing indicator | yes | yes | no | yes | yes | no |
| Reactions | no | no | inbound only | inbound only | inbound only | no |
| Buttons | yes (framework not bound) | yes | yes | no | no | no |
| Approval mode (D109) | port only | buttons | buttons | reactions | reply code | reply code |
| Markdown on output | HTML/MarkdownV2 escape | converted | converted (mrkdwn) | converted (HTML subset) | converted (text styles) | converted (text + HTML) |
| Max text per message | 4096 | 2000 | 3500 | 16000 | 2000 | 200 000 |
| Encrypted rooms | — | n/a | n/a | refused (E2EE follow-up) | n/a | n/a |
| Pairing `/link` | yes | slash command | slash command | text command | text command | text in subject or body |

Notes:

- The core framework path is text-only. Attachments, buttons, reactions, thread identity and
  edits go through each package's adapter port (`onMessage` / `sendTurn`). When a text-only
  turn is not enough, the package logs a `framework-rich-turn-gap` line and does not claim
  support. Binding rich turns to the core event model is the first interface wish (see below).
- Approval prompts go through the existing approval path. No channel grants approval by itself:
  a press, reaction or reply only produces a decision when the sender is on the approver list,
  the prompt is unexpired, and the handle has not been used before.
- Matrix and Slack reactions are received as events only; they are not used to approve.

## Interface wishes

These need a change in shared core code and are therefore not worked around in the packages:

1. A core event model for rich inbound turns (attachments, reactions, thread ids, auth results).
2. A core approval decision port bound to D109 authorisation (`onDecision` has no consumer yet).
3. A shared `SentRef` / `ApprovalPrompt` / `ApprovalDecision` type instead of one copy per package.
4. Persistent thread-key and cursor ports shared across channels (email, matrix, discord).
5. An idempotency key or receipt on outbound sends, so ambiguous network failures can be retried.
6. A capability-gated typing hook, so hosts can skip a no-op `typing()`.
7. An async-capable pairing port (`IdentityService.claim` is synchronous today).

## Configuration

Each channel has its own object under `channels` in `config.json`. Secrets are referenced by
name (`tokenSecret`, `botTokenSecret`, `accessTokenSecret`, `passwordSecret`), never by value.
The full key list and defaults are generated in [config.md](config.md).

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "tokenSecret": "channels.discord.token",
      "allowlist": ["123456789012345678"],
      "dmAllowlist": ["234567890123456789"],
      "replyPolicy": "mention"
    }
  }
}
```

## Verification

```sh
pnpm --filter "@plur1bus/channels-*" test
pnpm docs:check
```

The shared contract suite (`packages/channels-discord/test/contract-suite.test.ts`) runs every
new channel against the core `Channel` contract with a fake platform and no network.
