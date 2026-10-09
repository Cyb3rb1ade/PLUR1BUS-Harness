# @plur1bus/channels-signal

Signal channel over a locally running [signal-cli](https://github.com/AsamK/signal-cli) JSON-RPC daemon. Implements the core `Channel` lifecycle plus the rich adapter ports (`onMessage`, `sendTurn`, `edit`, `typing`, `prompt`, `onDecision`) that the text-only framework contract cannot carry. No runtime dependency. The channel only connects to a socket or loopback TCP endpoint; it never spawns signal-cli and never registers or links an account.

See [the operational guide](../../docs/channels/signal.md) for installing signal-cli, linking the account, running the daemon, every option, limits and troubleshooting.

- Manifest: `channel.json`, `signal`, version `0.1.0`, API `1`, `direct` and `group` chat kinds.
- Config keys follow the shared channel spec (`account`, `endpoint`, `allowlist`, `dmAllowlist`, `userAllowlist`, `replyPolicy`, `maxMediaBytes`, `locale`) plus `allowRemoteEndpoint` for non-loopback TCP. Secret names are not used: the daemon owns the account.
- Factory: `createSignalChannel(config, deps)`. Deps: `pairing`, `outputs`, `logger`, and test seams `connect`, `sleep`, `now`, `random`, `timeout`, `rpcTimeoutMs`, `maxSendRetries`.
- Approvals are reply codes (`<TOKEN> <number>`): Signal has no buttons, and reactions are not used as approval signals.
- Isolated tests: `cd packages/channels-signal && node ../../scripts/test-package.mjs`. The fake daemon is an in-process JSON-RPC server on 127.0.0.1 with an invented account; nothing reaches the network.
- Source layout: `src/rpc.ts` (framing, timeouts, error mapping), `src/markdown.ts` (CommonMark to text styles), `src/split.ts`, `src/approvals.ts`, `src/channel.ts` (lifecycle, inbound, outbound, `/link`), `src/messages.ts` (en/de strings), `src/port.ts` (duplicated port types, marked as a shared-package candidate).
