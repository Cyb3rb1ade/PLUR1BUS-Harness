# A3 — Channel framework (registry, manifest, lifecycle)

Branch `claude/a3-channel-framework`. Code: `packages/core/src/channels/**`, tests `packages/core/test/channels/**`.
Sources: extensions-ecosystem spec (channel kind = a D14 module with `kind: channel`), direct-chat spec §4 (D21: one active
session per channel chat), ADR-007 (pairing: unknown identities stay unlinked, fail closed).

## Scope
1. `types.ts` — `Channel` (`start`/`stop`/`health`, inbound via a `ChannelHost.receive`, outbound via `send`), the message shapes,
   and two narrow ports for things not on `main` yet: `IdentityPort` (resolve a channel identity, claim a pairing code) and
   `SessionPort` (find/create the active session of a chat, submit a turn). Tests use fakes; the real M3 identity layer and the
   `session.*` store bind to the ports later.
2. `manifest.ts` — channel manifest (`channel.json`) JSON Schema (closed object) with a small validator; no new dependency.
3. `backoff.ts` + `clock.ts` — pure exponential backoff with a deterministic jitter-free default; `Clock` port with a fake in tests.
4. `router.ts` — inbound pipeline: sender resolve -> unknown/unpaired is rejected before any session exists (pairing-code claim
   is the only thing an unknown sender can do) -> D21: exactly one active session per (channel, chat) -> `submit` -> reply out.
5. `registry.ts` — lifecycle: register validated manifests, delayed start (`startDelayMs`), every channel call wrapped (throw,
   reject or hang = isolated failure), crash -> `backoff` -> restart, give up after `maxRestarts` (state `failed`), clean stop.
6. `loopback.ts` — reference channel that is driven in-process by tests.

## Test plan
Isolation (throwing start/stop/health/handler never reaches the caller or other channels), D21 (concurrent inbound on one chat
-> one session; different chats / channels -> different; `/new` rotates and the old one is no longer active), unknown sender
(rejected, no session, no submit, content not forwarded; pairing code claims then admits), backoff (fake clock), manifest
validation, delayed start, stop cancels timers.
