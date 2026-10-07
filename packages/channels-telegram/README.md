# @plur1bus/channels-telegram

Telegram Bot API library implementing the existing core `Channel` lifecycle and the original #157 convenience port. Supports private/group/supergroup chats, forum topics, bounded inbound/outbound media, polling or a host-mounted webhook handler, localized commands, signed inline callbacks, rate limiting and a D93 `/web` link-provider port. No new runtime dependency, public server or framework change.

See [the operational guide](../../docs/channels/telegram.md) for BotFather/Privacy Mode setup, every option, examples, troubleshooting, the main-baseline inventory and follow-ups.

- Manifest: `channel.json`, `telegram`, version `0.1.0`, API `1`, `direct` and `group` chat kinds. A library consumed by a host factory; not a standalone D14 module process.
- RPC methods provided/consumed: none. The host supplies `ChannelHost`, secret reading, persistent offset storage and optional rich-turn / handoff bindings.
- Configuration takes effect on channel restart. Empty chat/user allowlists deny access. Bot tokens only enter through `SecretReader`.
- `start(host)`/`stop()`/`health()`/`send(message)` implement core v1. `onMessage`/`sendTurn` expose rich Telegram turns that the current text-only core cannot carry; binding them is a follow-up. Telegram sender IDs are not harness Principals.
- `ConfirmPrompt` exposes buttons for future D109 binding; callbacks never grant approval themselves. `/web` requires a host provider that authenticates a linked person and creates a single-use HTTPS link.
- Isolated tests: `pnpm --filter @plur1bus/channels-telegram test`. The fake HTTP Bot API runs in-process on loopback, with invented tokens and no external requests.
