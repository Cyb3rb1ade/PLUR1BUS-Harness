# Buzz / Nostr

Text-only one-to-one encrypted DMs (NIP-17, NIP-59, NIP-44 v2), signatures and sender allowlist before Core ingress. Groups, media and custom Buzz kinds are excluded.

Manifest: `buzz`, channel API 1, version 0.1.0, direct chats only. The package provides the Channel lifecycle/send/health contract, consumes the host's behaviour/receive ports, SecretStore, pairing claims, Egress and a durable replay store. It adds no RPC; the Core provides `channel.*`.

All `channels.buzz` config keys restart `module:buzz`: enabled, relays, privateKeySecret, senderAllowlist, locale. The private key is read from the SecretStore; config contains only its reference. Transport is the Core's existing address-pinned WebSocket implementation, with no HTTP Authorization header. Relay AUTH signs a challenge for the exact configured relay. `nostr-tools` 2.25.2 is exactly pinned (stable release checked at implementation).

Run in isolation with injected `connect` and `egress` ports, a `MemorySeenStore` for tests and `createBuzzChannel`. Production supplies `FileSeenStore` under Harness state. `pnpm --filter @plur1bus/channels-buzz test` exercises real cryptography against a fake relay; `pnpm --filter @plur1bus/channels-buzz build` bundles the entry.

Only the intersection of the recipient's signed kind-10050 DM relay list and local configured relays receives their encrypted copy. Without it, send refuses. Relay OK acknowledges recipient-relay acceptance, not end-user receipt. The optional own archive copy is best effort and cannot block an accepted recipient delivery. Replay claims precede handling: interrupted delivery can be lost; recent claims retain 65,536 event/rumor IDs, and events older than 48 hours are refused. A bounded store cannot prove indefinite replay exclusion at arbitrary traffic rates.
