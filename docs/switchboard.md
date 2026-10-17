# Switchboard

The switchboard connects chat platforms to the harness core. Each platform is a channel: a
package that implements the core `Channel` contract (`packages/core/src/channels/`) and is
configured under `channels.<id>.*`. Every channel is off by default. The core process hosts the
enabled ones (see [Operation](#operation-how-channels-are-started-and-watched)); a change to
`channels.<id>.*` restarts that one channel and nothing else.

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

Secrets: a `*Secret` key takes the **name** of a secret. Store the value with `plur1bus secret set <name>` (read from stdin), then `plur1bus channel set <id> tokenSecret <name>`. The CLI checks the name before it calls the core: text outside the name format, or a value that looks like a credential, is refused (`reason: secret-value`, exit 2) and nothing is sent. The core applies the same rule. A value is never echoed, stored or logged; treat a credential you typed as exposed and rotate it.

Limits: the write commands need a running core under a supervisor (`reason: config-not-writable` otherwise). Runtime state and health come from the switchboard registry (below). `--send-owner` needs the channel to be running and your identity linked; it sends to the chat the channel itself names for you (`resolveOwnerTarget`): the DM chat in Telegram, the DM channel Discord opens for you, the IM Slack opens, your direct Matrix room (or a new one you are invited to), your address (e-mail) or your number (Signal). A channel without that method gets the linked user id as the chat id.

## Operation: how channels are started and watched

The channel packages are libraries behind the core `Channel` contract. They are not module processes of their own: the **core process** hosts them (`packages/core/src/channels/switchboard.ts`), using the same lifecycle as any channel (`ChannelRegistry`: start, stop, health watch, restart with backoff) and the same inbound path (`ChannelRouter`). Every channel is configured under its `channels.<id>` block.

- **Start and stop.** `channels.<id>.enabled: true` starts the channel; `false` stops it. Any other key under `channels.<id>` (restart class `module:<id>`) stops and starts that one channel with the new value. No other channel and no other part of the core restarts. A disabled channel loads no code.
- **Misconfigured.** A channel that is enabled but cannot start for a reason retrying will not fix is parked with state `misconfigured` and the reason in `lastError`: a secret that is not stored, a secret name outside `channels.<id>.` (a channel reads only its own secrets), or a value the adapter refuses (for example an allowlist entry that is not an id). Nothing is retried and nothing crashes. The switchboard looks for a missing secret again after 30 s, then 60 s and so on up to 10 minutes (each look is an audited secret read); changing the configuration looks at once.
- **Failures while running.** A start that fails, an unhealthy adapter or a fatal error from the platform restarts the channel with backoff (1 s doubling up to 60 s), up to the manifest's `maxRestarts` (8). After that the state is `failed` until the configuration changes.
- **Secrets.** The adapter reads its secrets through the core's secret store (`lease` as the core, audited). A secret value never appears in `lastError`, in logs or in `channel.*` answers.
- **Inbound.** A message goes through the router: the identity service decides who the sender is (a handle linked to a person; unlinked senders get the pairing notice only), the chat's one active session (D21, kind `channel`, `chatKey` = `<channel>:<chat id>`) takes the turn, the reply goes back to the same chat (not yet enforced: the active session is found by chat key alone, so when a handle is unlinked from one person and linked to another, the new person's turn still runs in the earlier person's session until `/new` archives it). `/new` archives the chat's session. `/link <code>` pairing happens in the adapter (slash command, text command or mail) and creates a pending claim that the owner confirms (`plur1bus identity`).
- **Approvals (D109).** When a tool call in a channel session needs approval, the person gets the adapter's own prompt (buttons, reaction or reply code) in the same **private** chat. Only handles linked to that person may answer; the press becomes `ApprovalService.decide` at surface T2. In a group chat no prompt is shown (the request would be visible to the room); it waits for another surface.
- **Images.** Images a turn produced (media store outputs) follow the text reply into the same chat. A chat can be sent only outputs that one of its own turns produced.

### Status fields

`plur1bus channel list|status|show` (and `channel.list|status|get`) report, per channel:

| Field | Meaning |
|---|---|
| `state` | `not-registered` (the core hosts no switchboard), `stopped` (disabled), `waiting`, `starting`, `running`, `backoff` (restarting), `failed` (gave up), `misconfigured` (parked, see `lastError`). |
| `health` | `ok` (running and the adapter's last health answer is ok), `failing` (backoff, failed, misconfigured or an unhealthy adapter), `unknown` (not running). `channel show` also probes the adapter now. |
| `lastError` | The last failure or the misconfiguration reason, with secret values and token-shaped strings masked. |
| `attempts` | Failed starts since the last stable run (a run of one minute counts as stable). |
| `startedAt` | When the running instance started. |

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `misconfigured`, `secret not found: …` | Store the secret under exactly that name: `plur1bus secret set channels.<id>.<name>`. The channel starts by itself within a few minutes, or at once after `plur1bus channel disable <id>` and `enable <id>`. |
| `misconfigured`, `secret names must start with channels.<id>.` | Rename the secret and the `*Secret` key; a channel does not read other credentials. |
| `misconfigured`, `invalid configuration: …` | The adapter refused a value; fix it with `plur1bus channel set`. |
| `backoff`/`failed` and `lastError` names the platform | The platform refused the credentials or is unreachable; see the channel's own guide. Fix, then change any key (or disable and enable) to start again after `failed`. |
| A person writes and gets only the pairing notice | The handle is not linked. Mint a code (`plur1bus identity link`), send `/link <code>` from the account, then confirm the claim. |
| `--send-owner`: `owner-not-linked` / `channel-not-running` | Link your identity on that channel; make sure the channel is `running`. |

## Verification

```sh
pnpm --filter "@plur1bus/channels-*" test
pnpm docs:check
```

The shared contract suite (`packages/channels-discord/test/contract-suite.test.ts`) runs every
new channel against the core `Channel` contract with a fake platform and no network.

## Behaviour profiles (M4 phase 1)

ADR-003 uses exactly four configurable levels, stored in `agents.<agentId>.behaviour`:
`default` → `direct` / `group` → `byChannelKind.<kind>` → `byBotConnection.<connection>`.
The current host has one connection per channel kind; its stable connection ids are `telegram`,
`discord`, `matrix`, `slack`, `signal`, `email` (and `buzz` reserved for M4 phase 3). Other connection
keys are rejected by configuration validation. There is no per-chat permission layer.

`packages/core/src/channels/behaviour.ts` is the shared resolver and message gate for all six adapters.
Transport allowlists and signature/address parsing still run first. Reply policies use the order
`always` → `on-mention` → `never`; capture uses `full` → `provenance-only` → `none`. Denies union,
allowlists intersect, numeric ceilings take the minimum, `captureOtherSpeakers` can only become
false and `requireLinkedPrincipalForUserScope` can only become true. Allow entries are literal
names, deny entries additionally support `*`. An omitted allowlist inherits; an empty one denies all.

Shipped group restrictions: `on-mention`, `provenance-only`, scopes `agent-private`/`workspace`,
no capture of other speakers, linked principal required for user scope, 60 replies/hour,
20 edits/minute, 8192 UTF-16 units per reply. Direct ceilings are 3600/hour, 60/minute and 65536 units.
Output caps never split a surrogate pair. Reply budgets are enforced per person on router turns and
per chat at adapter output boundaries; edits have a separate minute window. A refused output is silent.

The switchboard detail shows effective direct/group values and participating source paths for every
field, in English and German. Its editor writes only the displayed channel-kind layer via the existing
supervisor `config.set`, with schema validation, owner/admin write roles, audit and revision protection.
Broader restrictions must be changed at their owning level. Live changes affect subsequent turns;
running turns retain their initial tool/memory policy snapshot.

**Engine limitation (pin `6868b7b1`, not a permission widening):** `Principal`/`recall`/`capture` have
no per-request allowed-scope mask. When an effective profile excludes any engine scope, the memory
port returns `behaviour-scope-unavailable` and calls no engine recall/capture. `provenance-only`
records a content-free receipt in the harness log, not a searchable engine memory. Accordingly,
group recall and durable provenance memory are not accepted yet. No engine code or pin is changed.

Evidence: `core/test/channels/behaviour.test.ts` (64-case matrix and 1000 deterministic property trials),
`behaviour-runtime.test.ts`, hosted Matrix and Slack gate regressions, and
`web/test/switchboard-behaviour.test.ts` (DE/EN, field origins, channel-only write, CSRF and axe).
