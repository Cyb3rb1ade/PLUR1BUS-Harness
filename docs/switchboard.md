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

## Managing channels from the CLI

`plur1bus channel` manages every channel the same way: it is generic over the config schema's `channels.*` block and the channel registry, with no per-channel logic. It talks to the core's `channel.*` RPC (Owner/Admin, people only; see [rbac.md](rbac.md#channel-management-channel)), `--json` on every leaf.

| Command | What it does |
|---|---|
| `plur1bus channel list` | Every channel: enabled, configured (every secret it references is stored), state, health. |
| `plur1bus channel show <id>` | Effective configuration with every `*Secret` key shown as a secret **name** and whether it is stored, health probe, last error, restart class. |
| `plur1bus channel enable <id>` / `disable <id>` | Writes `channels.<id>.enabled` through the supervisor's `config.set`; the channel's module restarts per the key's restart class (`module:<id>`). Enabling an unconfigured channel works and lists what is missing. |
| `plur1bus channel set <id> <key> <value>` | Sets one key (path under `channels.<id>`, e.g. `allowlist`, `imap.host`), validated against the schema before anything is written. Lists and objects are JSON. |
| `plur1bus channel test <id> [--send-owner]` | Health check (exit 1 when failing). `--send-owner` sends one fixed text to **your own** linked identity on that channel, never to a recipient you name. |
| `plur1bus channel status` | All channels, compact. |
| `plur1bus channel link-help <id>` | How `/link` pairing works on that channel (the channel manifest's optional `linkHelp`, else the generic steps). |

Secrets: a `*Secret` key takes the **name** of a secret. Store the value with `plur1bus secret set <name>` (read from stdin), then `plur1bus channel set <id> tokenSecret <name>`. A value that looks like a credential is refused (`reason: secret-value`) without being echoed, stored or logged; treat anything you typed as exposed and rotate it.

Limits: the write commands need a running core under a supervisor (`reason: config-not-writable` otherwise). Runtime state and health come from the switchboard registry; a core that runs no switchboard host reports every channel as `not-registered` (`host: false`). `--send-owner` addresses the chat whose id equals the linked identity's channel user id, which is a direct chat on Telegram-style platforms; it needs the channel to be running and the identity linked.

## Verification

```sh
pnpm --filter "@plur1bus/channels-*" test
pnpm docs:check
```

The shared contract suite (`packages/channels-discord/test/contract-suite.test.ts`) runs every
new channel against the core `Channel` contract with a fake platform and no network.
