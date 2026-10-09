# @plur1bus/channels-slack

Slack channel library implementing the core `Channel` lifecycle and rich adapter ports. Transport is **Socket Mode only**: the app opens an outbound WebSocket with an app-level token, so the harness never needs a public endpoint. Supports DMs, channels, private channels and group DMs, threads, mentions, bounded file in/out, Block Kit approval buttons, signed single-use action handles, and the `/plur1bus link <code>` pairing command. No runtime dependency: the WebSocket is Node's global client behind an injectable factory, and the Web API is `fetch` behind a `baseUrl` seam.

See [the operational guide](../../docs/channels/slack.md) for app creation (manifest included), secret names, every option, reply rules, approvals, limits and troubleshooting.

- Manifest: `channel.json`, `slack`, version `0.1.0`, API `1`, `direct` and `group` chat kinds. A library consumed by a host factory; not a standalone D14 module process.
- RPC methods provided/consumed: none. The host supplies `ChannelHost`, the secret reader, an optional pairing port, an optional output port and an optional dedupe store.
- Configuration takes effect on channel restart. Empty allowlists deny access. Credentials only enter through `SecretReader`; a config value that looks like a credential is refused.
- `start(host)`/`stop()`/`health()`/`send(message)` implement core v1 (text, markdown converted, split). `onMessage`/`sendTurn`/`edit`/`typing`/`prompt`/`onDecision` expose the rich surface the text-only core cannot carry.
- `accountId` for pairing is the bot's own Slack user id (`auth.test` `user_id`). Slack user ids are not harness Principals.
- `typing()` is a documented no-op (`capabilities.typing` is false). `edit()` uses `chat.update`; uploaded files cannot be edited.
- `idle()` resolves once every queued inbound envelope has been processed (test and shutdown seam).
- Isolated tests: `node ../../scripts/test-package.mjs` from this directory, or `pnpm --filter @plur1bus/channels-slack test`. The fake Web API runs on loopback and the fake Socket Mode hub runs in-process. Tokens are invented and no external request is made. Time is virtual: `sleep`, `now` and `random` are injected.

## Layout

- `src/socket.ts`: Socket Mode client (hello, ack-before-process, dedupe by envelope id, refresh/warning overlap, backoff with jitter, fatal auth codes).
- `src/api.ts`: Web API client (bearer per call, 429 clamp, typed errors, pinned download and upload hosts, manual redirect checks).
- `src/mrkdwn.ts`, `src/split.ts`: CommonMark to Slack mrkdwn (control tokens neutralised) and code-fence-aware splitting.
- `src/actions.ts`: opaque, signed, single-use action handles bound to chat and approvers.
- `src/channel.ts`: lifecycle, inbound policy, outbound plumbing, approvals, commands.
- `test/helpers/fake-slack.ts`, `test/helpers/contract.ts`: fake platform and the lead's contract harness.
