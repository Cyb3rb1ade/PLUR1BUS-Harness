# M3 — identity v2 and pairing (ADR-007, D24)

**Goal.** One human across channels *only by proof* (D24). A human principal owns linked channel identities (N:1);
an identity is linked by a one-time pairing code confirmed on the owner side, or manually by the owner, never by a
heuristic (ADR-007 Q4, answered 2026-10-05). Unlinking revokes at once. Surfaces: `identity.*` RPC (core, owner
only) and `plur1bus user ls|add|pair|link|unlink`.

**Out of scope (Open points in the PR).** The engine `subject`/`user:v2` derivation and union recall (engine PR, ADR-007
Action 4), the `memory.rebind` backfill that Q4 allows for manual links (the pinned engine has the op; wiring it is a
separate package), the RBAC `authorize()` chokepoint (M3 roles), the `signed_challenge` proof flow (modelled, refused).

## Files

| File | Purpose |
|---|---|
| `packages/core/src/identity/store.ts` | `node:sqlite` file `state/identity.sqlite`, `PRAGMA user_version` migrations; tables `humans`, `identities`, `pairings`, `attempts` |
| `packages/core/src/identity/codes.ts` | code generation (8 chars, 32-symbol unambiguous alphabet, `crypto.randomInt`), salted hash, constant-time compare |
| `packages/core/src/identity/ratelimit.ts` | failed-claim limiter per source and global, fake-clock friendly |
| `packages/core/src/identity/audit.ts` | append to `logs/audit.log` (same line shape as `crates/plur1bus/src/audit.rs`), never a code |
| `packages/core/src/identity/service.ts` | the service: `createHuman`, `link`, `startPairing`, `claim`, `confirm`, `unlink`, `list`, `resolve`, `linkedV1Principals` |
| `packages/core/src/identity/rpc.ts` | `identity.*` handlers and error mapping |
| `packages/rpc-schema/schema/rpc.schema.json` (+ fixtures, stability test) | seven closed, experimental core methods, `x-since` 1.5.0 (no version bump) |
| `packages/core/src/core.ts`, `rpc/methods.ts` | one new block each: open the store, merge the handlers, close on stop |
| `packages/webmcp/src/provider.ts` | `identity.` is a forbidden prefix (never a WebMCP tool) |
| `crates/plur1bus/src/commands/user.rs`, `cli.rs`, `main.rs` | the CLI; `user` leaves the stub list |
| `docs/` | `pnpm docs:gen`; `docs/identity.md` (hand-written), AGENTS.md rows |

## Tasks → acceptance

1. Store + migrations (idempotent, `user_version`, N:1 unique-active index).
2. Codes and limiter (pure, tested with a fake clock).
3. Service: pairing happy path; refusals; unlink; no heuristic.
4. RPC schema + handlers + audit; core wiring.
5. CLI + system test; docs.

| Acceptance | Test |
|---|---|
| Pairing happy path (start → claim → confirm → link) | `identity/service.test.ts` "pairing happy path" |
| Expired code refused | `service.test.ts` "expired code" |
| Reused code refused | `service.test.ts` "reused code" |
| Wrong code refused, uniform error | `service.test.ts` "wrong code" |
| Brute-force rate limit (per source and global, lock holds even for the right code) | `ratelimit.test.ts`, `service.test.ts` "brute force" |
| Unlink revokes immediately (resolve and union drop it) | `service.test.ts` "unlink revokes" |
| No heuristic link, identical display name | `service.test.ts` "no heuristic link" |
| Codes never logged (log, audit, list output, DB) | `service.test.ts` + `identity-rpc.test.ts` "codes never persisted or logged" |
| N:1, an identity belongs to at most one human | `service.test.ts` "identity exclusivity" |
| RPC owner-only, closed params | `identity-rpc.test.ts`, `rpc-schema/test/stability.test.ts` |
| CLI end to end | `tests/system/identity.test.ts`, `crates/plur1bus/tests/user.rs` |
