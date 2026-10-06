# Identity and pairing (M3, ADR-007, D24)

One human across channels **only by proof**. A *human* is an opaque principal (a UUIDv7, never reused). A *linked
identity* is a channel handle (`channel`, `accountId`, `userId`) that belongs to one human. A human can have many
handles (N:1); a handle belongs to at most one human at a time. Nothing is linked by a matching display name, ever: the
display name is a label for people and is never compared.

## Ways to link

| Proof method | How | Notes |
|---|---|---|
| `pairing_code` | `user pair start` → the person sends the code from the handle → an adapter relays it (`user pair claim`) → the owner confirms (`user pair confirm`) | the claim alone links nothing |
| `owner_manual` | `user link <human> --channel … --account … --user-id …` | the owner's deliberate action, audited |
| `signed_challenge` | modelled in the store, **refused** for now (no flow yet) | fail closed |

## The pairing code

8 characters from a 32-symbol alphabet without `0 O 1 I` (about 40 bits, `crypto.randomInt`), valid 10 minutes, **single
use** (consumed at claim), at most 3 pending per human and channel, bound to the channel it was minted for. It is shown
once, in the `pair start` result; the store keeps only a salted SHA-256, and no log, audit line or `list` output ever
contains a code, a presented code included. A wrong, expired, reused or wrong-channel code all answer the same
`E_DENIED reason=invalid-code`.

**Brute force.** Failed claims are counted per handle (5 in 15 minutes) and over all handles together (20 in 15
minutes); past either limit every claim, a correct one included, answers `E_DENIED reason=rate-limited` with
`retryAfterMs=N` until the lock lapses (15 minutes). The counters live in the database, so restarting the core does not
reset them.

## Unlink

`user unlink <link>` revokes at once: the handle stops resolving to the human and leaves the set of v1 principals the
engine reads (`linkedV1Principals`). The record stays for the audit trail. Rows written under that handle's v1 principal
become unreadable to the human until it is linked again (ADR-007).

## Storage, audit, access

- `state/identity.sqlite` (`node:sqlite`, WAL; `PRAGMA user_version` migrations, a newer file is refused, never altered).
- `logs/audit.log`: `identity.human.create`, `identity.link`, `identity.pair.start|claim|confirm|rate-limited`,
  `identity.unlink`, in the same line shape as the CLI's own audit entries.
- `identity.*` RPC methods (`identity.list`, `.human.create`, `.link`, `.pair.start`, `.pair.claim`, `.pair.confirm`,
  `.unlink`) are experimental, closed, **owner only** (the CLI caller) and never offered as WebMCP tools.

## Not here yet

The engine side (`subject` on `Principal`, `user:v2` derivation, union recall over `linkedV1Principals`; ADR-007 action
4), the `memory.rebind` metadata backfill that Q4 allows after a manual link, the RBAC `authorize()` chokepoint and a
channel adapter that relays claims (M4). Until the chokepoint lands, "owner" means the local CLI session that holds the
core token.
