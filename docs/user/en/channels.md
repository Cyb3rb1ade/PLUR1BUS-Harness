# Channels

Channels connect chat platforms to Plur1bus. You write to the assistant on Telegram, Discord, Slack, Matrix, Signal or
by e-mail, and the reply comes back there. This page shows how to set up a channel, link an account to the assistant and
manage channels. Each channel's setup in full is on its own page under [../../channels/](../../channels/). The German
version of this page is [../de/channels.md](../de/channels.md).

## First: does the channel run in your build?

Channels only run when the switchboard host is part of your build. Check this first:

```sh
plur1bus channel status
```

The command needs a running core (`plur1bus daemon start`). If the list shows the state `not-registered` for a channel
and the note "This core runs no switchboard host" below it, this build does not start channels. The setup below is then prepared but
takes effect only in a build that includes the host. If that note is missing, the build has a host;
`plur1bus channel show <channel>` then shows the channel's state and last error.

## Channels at a glance

| Channel | Chats | Note |
|---|---|---|
| Telegram | direct messages, groups | mature |
| Discord | direct messages, server channel, thread | new |
| Slack | direct messages, channel, group | new |
| Matrix | direct messages, room, thread | new; unencrypted rooms only |
| Signal | direct messages, group | new; needs signal-cli |
| E-mail | direct, in the mail thread | new |

WhatsApp is not implemented yet.

All channels are off by default. An allowlist (`allowlist`, `dmAllowlist`) lets nobody in at first: anything not on it is
neither accepted nor answered. You never enter credentials directly; you give only the name of a secret.

## Setup in five steps

These steps apply to every channel. The details about the provider's console, permissions and ids are on the channel's
own page.

1. Create a bot or account with the provider and get its access key.
2. Store the key as a secret. The command reads the value from standard input:

   ```sh
   printf %s "$DISCORD_BOT_TOKEN" | plur1bus secret set channels.discord.token
   ```

3. Point the configuration at the secret's name. The keys are listed in [../../config.md](../../config.md):

   ```sh
   plur1bus channel set discord tokenSecret channels.discord.token
   plur1bus channel set discord allowlist '["123456789012345678"]'
   ```

4. Switch the channel on. This restarts its module:

   ```sh
   plur1bus channel enable discord
   ```

5. Check the connection:

   ```sh
   plur1bus channel test discord
   ```

### Each channel in brief

- **Telegram:** Create the bot with BotFather. For groups, add the group ID to the allowlist. If the bot should read every
  message in a group, turn off Privacy Mode with `/setprivacy` in BotFather. The configuration is on
  [../../channels/telegram.md](../../channels/telegram.md); this channel is not listed in the configuration reference.
- **Discord:** Create the application and the bot in the Developer Portal. Turn on the privileged intent MESSAGE_CONTENT
  there as well. Invite the bot to your server. Details: [../../channels/discord.md](../../channels/discord.md).
- **Slack:** Create an app. You need a bot token (`xoxb-…`) and an app token (`xapp-…`) with the `connections:write`
  scope for Socket Mode. Invite the bot to every channel where it should reply. Details:
  [../../channels/slack.md](../../channels/slack.md).
- **Matrix:** Create a dedicated bot account and get its access token without writing the token into the configuration.
  Encrypted rooms are not supported yet. Details: [../../channels/matrix.md](../../channels/matrix.md).
- **Signal:** Install signal-cli, register or link the account, and keep the signal-cli daemon running. Details:
  [../../channels/signal.md](../../channels/signal.md).
- **E-mail:** Set up a dedicated mailbox. For the sender check you need the `authServId` of your mail server. Details:
  [../../channels/email.md](../../channels/email.md).

## Link accounts with /link

So the assistant knows who you are, link your account on the channel to your user:

1. On your computer, create a one-time code:

   ```sh
   plur1bus identity link --channel <channel>
   ```

2. Send the bot `/link <code>` in a direct chat. On Slack the command is `/plur1bus link <code>`; on Discord it is a
   slash command; on Matrix, Signal and e-mail you write the command as text. `plur1bus channel link-help <channel>`
   shows the exact form for your channel.
3. The link becomes active only when you confirm it. Waiting pairings are listed by `plur1bus identity links` under
   `pairings`, each with `id` and `state`. Confirm one with `plur1bus identity approve <id>`, or decline it with
   `plur1bus identity decline <id>`. The message in the channel does not show the ID; it only asks you to confirm the link
   under "My identities" in the web interface. Existing links are in the same output under `links`.

The code is valid only briefly and works once. If you have no code left, create a new one.

## Manage channels

| Command | What it does |
|---|---|
| `plur1bus channel list` | All channels with status, configuration and health. |
| `plur1bus channel show <channel>` | The effective configuration; secrets appear only as names. |
| `plur1bus channel enable <channel>` and `disable <channel>` | Switches the channel on or off. |
| `plur1bus channel set <channel> <key> <value>` | Sets one key, checked against the schema first. |
| `plur1bus channel test <channel>` | Checks the channel's health. With `--send-owner` it sends a test message to your own linked identity. |
| `plur1bus channel status` | All channels in a compact list. |
| `plur1bus channel link-help <channel>` | Explains how `/link` works on this channel. |

A value that looks like an access key is refused for keys with the suffix `Secret`. It is not stored and not printed.
Always store keys with `plur1bus secret set <name>`, then pass only the name.

## When something goes wrong

| Error | Meaning | What to do |
|---|---|---|
| `E_CORE_UNAVAILABLE` | The core is not running. | `plur1bus daemon start`. |
| `E_NOT_AVAILABLE`, `config-not-writable` | No supervisor owns the configuration. | `plur1bus daemon start`, then repeat the command. |
| `E_NOT_AVAILABLE`, `channel-not-running` | `channel test --send-owner` needs a running channel. | Switch the channel on with `channel enable` and restart the daemon. |
| `E_NOT_FOUND`, `owner-not-linked` | Your account is not linked on this channel. | Follow the steps under "Link accounts with /link". |
| `E_INVALID_PARAMS`, `secret-value` (exit 2) | You gave an access key as the value. | Store the key as a secret, rotate it, then pass only the name. |
| `E_INVALID_PARAMS`, `invalid-value` | The value does not match the schema. | Read the `detail` in the error; nothing was written. |
| Status `not-registered` | The build has no switchboard host. | See "First" above. |

The full list is in [../../errors.md](../../errors.md).
