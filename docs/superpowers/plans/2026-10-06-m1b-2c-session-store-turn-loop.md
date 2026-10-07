# M1b-2c part 1: session store and the submit/event turn loop

Branch `feat/m1b-2c-session-store-turn-loop`. Sources: milestones §M1 (Core daemon, M1b-2c, acceptance 4/7/8/9),
2a spec D1/D21–D24/D30/D32, direct-chat spec D92 (kinds, I1, §2.1), ADR-001/003/010 (L1/L2/L14), assumptions A7.

## Goal

A resident-core session store (`node:sqlite` + FTS5) and an async submit/event turn loop behind `session.*` RPC and
`plur1bus session|chat`, with the provider behind an interface (fake in tests; real adapters come from `packages/providers`).
No second memory loop: one `recall` before and one `capture` after each turn, through the same engine calls
`memory.recall`/`memory.capture` make.

## Files

| Path | Purpose |
|---|---|
| `packages/core/src/session/types.ts` | kinds, records, event names, `SessionError` |
| `packages/core/src/session/migrations.ts` | versioned migrations (`PRAGMA user_version`; refuse a newer file) |
| `packages/core/src/session/store.ts` | sessions/turns/messages/events/summaries/FTS; I1; D21 invariant; archive-first; erasure stub; crash recovery |
| `packages/core/src/session/provider.ts` | `ChatProvider` interface + `FakeChatProvider` (deterministic) |
| `packages/core/src/session/compaction.ts` | token estimate, tool-result truncation, deterministic summariser, L14 bound |
| `packages/core/src/session/turn-loop.ts` | `TurnRunner`: submit → events; recall once, capture once; compaction hook |
| `packages/core/src/session/memory-port.ts` | `TurnMemory` over the engine (recall, capture, checkpoint) |
| `packages/core/src/session/methods.ts` | `session.*` RPC handlers (owner from `CallerIdentity`) |
| `packages/core/src/core.ts` | contained wiring block: open store, recover, merge methods |
| `packages/rpc-schema/schema/rpc.schema.json` | `session.*` methods, `session.event` notification |
| `crates/plur1bus/src/commands/session.rs`, `cli.rs`, `commands/mod.rs`, `main.rs` | `session list|show|archive`, `chat` |
| `docs/*` | regenerated (`pnpm docs:gen`) |

## Tasks (test first)

1. Store: schema, migrations, I1, D21, archive-first, erasure, FTS+owner, recovery.
2. Compaction: estimate, truncation, summariser, bound property test 1×–10× window.
3. Turn loop with fake provider: events, two concurrent sessions, failure, capture/recall spies, incognito.
4. RPC schema + methods + core wiring; system-ish test through a real core with the fake provider.
5. CLI `session`, `chat`; docs:gen; full gate.

## Acceptance → test

| Criterion | Test |
|---|---|
| two concurrent sessions, no event mix-up | `test/session/turn-loop.test.ts` |
| I1 immutability | `test/session/store.test.ts` |
| FTS finds a message, owner filter | `test/session/store.test.ts`, `methods.test.ts` |
| archive-first | `test/session/store.test.ts` |
| running turn → failed at start | `test/session/store.test.ts` |
| compaction bound (L14) | `test/session/compaction.test.ts` |
| capture/recall exactly once per turn | `test/session/turn-loop.test.ts` |
| RPC docs generated | `pnpm docs:check` |
