# Identity v2, linking and pairing (M3, ADR-007)

Harness users have opaque UUIDv7 ids, never reused. `deriveUserPrincipal(harnessUserId)` returns
`user:v2:` plus the lowercase SHA-256 of the exact UTF-8 id. No trimming, case folding or Unicode
normalization occurs: an id is not a display name. Existing channel principals remain
`user:v1:sha256(JSON.stringify([channel, accountId, userId]))`. Identity validates the complete
`^user:v(1|2):[a-f0-9]{64}$` grammar. An incomplete channel triple is rejected.

A channel identity is `(channel kind, accountId, external userId)`. All three fields matter; the
same external id in different bot accounts is a different identity. Linking is N:1: many channel
identities may belong to one user, each identity to at most one user. Display names never establish
ownership. An already-linked identity is rejected, including when a competing link appears between
claim and confirmation. There is no automatic transfer or user merge.

## Inventory on origin/main (U1)

Baseline: `9fc5ff09` (2026-10-07). The Q4 owner decision is incorporated in ADR-007, dated
2026-10-05; no separate `status/2026-10-05-owner-decision-adr007-q4` file was found.
Paths in the table are relative to `packages/core/` unless prefixed `docs/`.

| ADR-007 requirement | On main? | File / test on main; missing work in this PR |
|---|---|---|
| Canonical v2, exact opaque id, v1 compatibility | No | `src/identity/service.ts` has `v1PrincipalOf`; add `principals.ts`, `test/identity/v2.test.ts` |
| N:1 durable approved links, provenance, confirmer, archive unlink | Yes | `src/identity/store.ts`, `service.ts`; `test/identity/service.test.ts` |
| Pending → claimed → confirmed/declined/expired | Partial | `service.ts`, `store.ts`; existing tests; move proofs out of durable storage |
| Eight-symbol hashed code, single use, channel binding | Yes | `codes.ts`, `service.ts`; service/RPC tests |
| One-hour expiry, pending cap including claims | Partial | Main uses 10 minutes and counts only unclaimed codes; update service/tests |
| Channel/global lockouts, restart persistence | Yes | `ratelimit.ts`, `service.ts`; service/RPC tests |
| User and global issuance limits; user claim limit | No | Add to service; `test/identity/v2.test.ts` |
| Union v2 ∪ active v1 without vector writes (M3 acceptance 6) | Partial | `linkedV1Principals` exists; add `recall.ts` / `resolvePrincipals` and fake recall acceptance |
| Q4 metadata-only dry-run/apply/report/reversal | No | Add `backfill.ts`, durable operation ledger in store; fake engine tests |
| Self/Admin authorization, agents denied | Partial | RPC has local CLI-owner guard; add authorize port reusing read-only RBAC |
| Injected audit, no plaintext identifiers | Partial | Audit callback exists but contains raw handles; hash identifiers and emit semantic events |
| No heuristic linking, exclusive channel ownership | Yes | `service.ts`; existing no-heuristic and N:1 tests |

## Pairing and link lifecycle

`startPairing` issues an eight-character CSPRNG code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
(40 bits), bound to a user and channel. The default lifetime is one hour; injected shorter positive
TTLs are supported. Only salted SHA-256 hashes are stored. A user can have at most three live proofs
per channel, counting both pending and claimed proofs. A channel adapter must authenticate the
sender and supply its complete triple to `claim`; it must not trust sender fields supplied in text.

A successful claim consumes the code and enters `claimed`, awaiting explicit human confirmation.
Approval creates a durable link with `proofMethod=pairing_code`, timestamps and confirmer. Decline
links nothing. Confirmation has its own TTL, expires at the boundary, and rechecks exclusivity.
`owner_manual` links are explicit, deliberate actions. `signed_challenge` remains a reserved model
value; no flow offers it. There is no heuristic association flow.

Rate limits use 15-minute windows and 15-minute locks:

| Counter | Threshold | Meaning |
|---|---|---|
| Channel identity | 5 | Failed guesses; includes wrong, expired and reused codes |
| Global guesses | 20 | Rotating channel identities cannot evade the lock |
| User issuance | 10 | Successful code issuances across all channels |
| Global issuance | 100 | Successful issuances across all users |
| User claims | 5 | Valid claims awaiting confirmation across channel identities |

Counters are durable SQLite rows; keys for users and channel triples are hashed. A locked channel
or global guess counter blocks even a correct code. Invalid guesses have one uniform error.
Code hash comparison uses `timingSafeEqual`, checks all candidates without stopping at a match,
and hashes malformed submissions too. Work depends on candidate count; this is not a promise of
constant wall time for the entire database operation.

## Storage and access

`IdentityStorePort.open` injects the SQLite connection. Default `openStore` uses
`state/identity.sqlite`, WAL, schema-version migrations and secure file permissions (`0600` on
POSIX, platform ACL on Windows). Schema 2 preserves humans, approved and revoked links, and
rate-limit counters from schema 1. It deliberately discards old pending/claimed proof state.

Pairings are SQLite TEMP tables with `temp_store=MEMORY`: they disappear on restart and are absent
from durable database backups/imports. There is no spill file containing proofs. A restart requires
fresh pairing. Approved links and their archive remain durable. `revokedAt` distinguishes an active
approved link from an archived removed link; the existing RPC response shape is preserved.

`AuthorizePort` receives a transport-authenticated `Actor`, action and affected user. The default
adapter calls existing RBAC `users.manage` or `my.write`; it does not change the RBAC policy.
Owner/Admin may manage links; Operator/Member may manage their own; Viewer cannot write. Missing
person proof, unauthenticated actors, cross-user non-admin writes and all agents are denied. Even
an injected policy cannot authorize an agent. Back-fill is an admin operation (`users.manage`).
The actor's role/kind must come from authentication, never request text.

Existing experimental `identity.*` RPC methods retain their local token/CLI owner guard. That core-library slice added no RPC
method or schema. The new surface bindings below use the authenticated central guard.

Audit is an injected callback (`AuditEvent`). Existing `identity.*` events are retained, alongside
`link.requested`, `link.approved`, `link.declined`, `link.removed`, `pairing.failed` and
`pairing.locked`. Targets, actors, names, external ids, principals and receipts are SHA-256 hashed.
Codes never reach audit. Channel kind, status, timestamps and counts remain readable. Durable
records remain authoritative if the external emitter fails.

## Union reads and canonical writes

`RecallScopeProvider.resolvePrincipals(userV2)` returns the known user's v2 followed by every
currently approved v1, deduplicated and in stable link order. Unknown users, malformed principals
and malformed stored v1 hashes fail closed. `capturePrincipal(userV2)` returns exactly that v2;
capture never writes one row for every union member. Unlinked channel callers continue using
v1, not an inferred v2. The provider itself performs no memory or vector writes.

Unlink archives the record immediately and removes v1 from future union resolutions. Old v1 rows
become invisible through this user's union until relinking. Existing v2 rows remain visible,
including rows deliberately transferred by back-fill. This distinction must be shown before
unlink confirmation. A running/reversing back-fill must be recovered before unlinking.

## Q4 metadata back-fill

The owner decision requires deliberate manual linking to transfer existing memories through a
dedicated engine metadata operation. `createBackfill` implements this boundary through
`MetadataRebindPort`: `run({linkId,dryRun}, actor)` previews count without store writes or applies
v1 → v2; it never invokes share, embedding or a direct vector-store API. It returns a report with
source/target, count, timestamp, preview flag and engine receipt, and emits a redacted audit event.
Automatic/heuristic matches must never call this operation.

The durable ledger reserves an operation id before calling the engine. The engine port **must**
atomically persist that operation id and its result with its metadata transaction. Retrying after
an uncertain response uses the same id; completed calls reuse the recorded receipt. No distributed
transaction or exactly-once guarantee is claimed without this engine contract.

`reverse({linkId,dryRun}, actor)` uses the receipt's exact affected-row set. It must not reverse all
v2 memories: unrelated and newly captured rows belong to the canonical user. The engine must make
reverse idempotent by its operation id as well. Reversed operations remain in the ledger and are
not automatically reapplied. Reversal is explicit; unlink never silently reverses a transfer.

## Follow-ups outside this PR's file scope

- Bind `RecallScopeProvider` in the engine/core request path: authenticated `subject` for v2,
  engine-derived linked triples for reads, single principal for writes. Harness hashes here are
  local identity bookkeeping; the engine still owns final ACL principal derivation.
- Implement/bind the dedicated engine `memory.rebind` transaction and receipt-based reversal,
  retaining vectors unchanged. Wire deliberate manual link completion to preview → confirmed
  link → back-fill; the existing synchronous `identity.link` RPC cannot perform engine transfer
  yet. The fake-backed port is complete here; Q4 production transfer is not claimed complete.
- Bind authenticated users/roles to existing `identity.*` RPC, CLI/UI and confirmation screens.
  Expose back-fill preview/apply/reverse in an authorized admin surface in a separate schema PR.
- Bind channel adapters' pairing commands to authenticated sender triples and human confirmation;
  keep the channel registry's `IdentityPort` fail closed while a claim awaits confirmation.
- Add identity-bound confirmation from both sides for any future user merge; currently attaching
  an identity already owned elsewhere is rejected.

## Local verification

Run with Node 24.21.0 and source conditions:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/identity/*.test.ts
pnpm typecheck
pnpm lint
```

Tests use synthetic identities, scratch SQLite databases, injected clocks and fake engine ports.
The RPC tests use a local Unix socket/named pipe; no external network or real user data is used.
The fake recall acceptance asserts both scopes and zero memory writes. Metadata tests cover
preview/apply/reversal, duplicate calls and recovery after an engine commit with a lost response.

## Identity v2 surfaces

New human-only RPC methods: `identity.link.request`, `identity.link.list`,
`identity.link.approve`, `identity.link.decline`, `identity.link.remove`,
`identity.principals`. The central guard supplies the authenticated Principal.
Request fields never supply roles, principal kind or trust. Optional `humanId` on
request/list/principals is an administrator target override; other people operate
on their own authenticated user id. Approve/decline/remove derive the affected
user from stored records and apply the same ownership check. Every agent principal
is refused, including an agent carrying Owner role.

Request returns `{id,code,expiresAt}` exactly once. Listing returns metadata and
pending/claimed pairings without code hashes or plaintext codes. Union inspection
returns the existing v2 plus active linked v1 principals. A human must already
exist in the identity directory. Legacy local-owner RPC uses the `local-owner`
principal: until the API binds a real directory user, CLI owners can explicitly
select an existing human using `--human` (obtain/create one with `user ls/add`).

```sh
plur1bus identity link --channel telegram --human <human-id>
plur1bus identity links --human <human-id>
plur1bus identity approve <pairing-id>
plur1bus identity decline <pairing-id>
plur1bus identity unlink <link-id>
plur1bus identity whoami --human <human-id>
```

All support global `--json`. “My identities” (`#/identities`) lists links, issues
codes in transient page state, shows pending confirmation, approves/declines, and
confirms unlink with the union-visibility consequence. Codes are never persisted
in browser storage and disappear when leaving the page. Renewing issues a new
proof subject to existing pending/issuance limits; it does not invalidate other
live proofs or bypass rate limits.

Telegram accepts `/link <code>` in private chats when the host injects the
existing IdentityService.claim port. The bot's getMe id and authenticated sender
id establish the complete triple; command text supplies only the code. The
identity port owns durable guess lockouts. Uniform failure replies disclose no
ownership, submitted codes never reach logs, and a successful claim still awaits
human confirmation. Group chats never claim a proof. Production hosts must bind
this optional port; the standalone adapter does not manufacture an identity
service or automatically approve claims. The API-layer Web principal binding is
outside this work package's allowed files.
