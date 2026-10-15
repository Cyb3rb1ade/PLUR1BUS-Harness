# M4 phase 5 — Web continuation and own channel DMs

Draft PR: [#506](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/506).

## Inventory and decisions

Adds a private SQLite WAL/FULL handoff registry, trusted host ingress recording, four closed-schema RPCs and authenticated API routes, `/web` across hosted channels, and DE/EN read-only channel history with Continue in Web. No new dependency. M3 phase 1 (#493) is merged normally because its chat routes are required; this PR remains stacked on #505. No engine changes.

Tokens contain 32 random bytes, expire after ten minutes, are stored only as hashes and are bound to a currently authorized person. A wrong-person attempt does not consume the token. Redemption consumes it before creating a separate direct chat; a crash can consume the link without creating the chat. This is at-most-once redemption, not exactly-once delivery. The source channel remains active.

The new chat receives existing prepared summaries and bounded recent excerpts as quoted, untrusted user context. No additional cloud/model call generates this preamble. `handoffFrom` records the source. The trusted source registry never infers ownership from transport strings supplied by RPC.

## Threat table

| Attack | Protection | Named evidence |
| --- | --- | --- |
| Link theft or reuse | login plus live person/agent/link checks; hash, expiry, conditional one-use consumption | handoff.test.ts; API channel-handoff.test.ts |
| Foreign history or revoked identity | exact live person/channel/account/sender binding on every operation | handoff.test.ts; core.test.ts |
| Group or legacy transcript disclosure | permanent group/legacy taint; only newly observed trusted DMs visible | handoff.test.ts group-to-direct and historical-session cases |
| Token leakage in logs | fragment arrival, immediate browser history replacement, POST body, fixed send errors | host.test.ts; core.test.ts throwing adapter; browser tests |
| Browser bypass or malformed request | authenticated session, CSRF on writes, closed params/results and explicit route catalogue | API route and OpenAPI hardening tests |
| In-place channel mutation | read-only history; new direct chat with immutable owner/kind | Core/RPC and browser tests |
| Context instruction injection | quoted untrusted user-role preamble, bounded excerpts, no system-role import | handoff service tests |

## Behaviour changes

A paired person can use `/web` even before a first model turn. Configure `core.webHandoffBaseUrl` to the actual Web address; HTTPS is required except on loopback, and credentials/query/fragment are forbidden. The API currently may use a dynamic port, so this address is explicit rather than guessed. Own-history continuation in Web works without that external-link base.

A session once observed as a group or as an unknown historical transcript remains excluded. Existing histories are not migrated by guessing; `/new` starts a fresh eligible channel session. A failed handoff fragment followed by a fresh fragment is handled as a new redemption attempt. Disabled people and unlinked senders receive no continuation authority.

Delivery now returns fixed transport errors rather than arbitrary adapter exception text. Follow-up Buzz hardening makes recipient delivery independent of the optional archive-copy acknowledgement, applies UTF-8 byte limits and serializes startup. These Buzz fixes were also committed to #503 and merged through #505 normally.

## Owner questions and hotspots

No additional dependency approval is needed. Matrix remains blocked under the owner-authorized fallback: default-off memory E2EE, explicit restart warning, no persistent-key acceptance. Pairing entropy remains unchanged. Review the explicit Web base URL and the bounded extractive preamble UX.

Hotspots: M3 chat Core/API routes and SessionStore, channel command hook/router, schema and Rust fixture mappings, generated API/Python/settings docs, Web Chat page, delivery send errors. Merge normally with M3 and earlier M4 PRs. The Rust fixture test explicitly maps the new methods and M3 method fixtures; it does not skip them.

## Validation

Node 24.21.0. Owned focused checks: 28/28; final Web/schema/actual-Core checks: 109/109, including DE/EN browser and axe. API route/security subset after catalogue updates: 78 tests, 77 passed, one existing TODO, zero failed. Buzz final suite: 11/11. Seven-adapter run: 1784 tests, 1763 passed, 21 existing TODOs, zero failed. Broad earlier Core/API/RPC run exposed six API catalogue/fixture failures, all addressed and rerun in the focused API subset; it is not itself recorded as a green broad run.

Final lint passes, including typecheck/builds and 99 script tests. The Rust RPC crate passes with all three fixture/generative/Serde tables complete; its all-target Clippy with warnings denied and cargo fmt also pass. Full-workspace Rust results are recorded in the execution ledger. docs generation, generated freshness and link checks pass; `docs:check` still fails the previously reproduced untouched-main stale-bundle subprocess assertion (`bundle-user-docs.test.mjs`, expected 1, got 0). Earlier Approvals/recurring browser gaps remain documented in prior handoffs. No claim that the complete workspace suite is green. No CI polling, GitHub merge or real external messages.

## Known gaps / acceptance

M4 is not complete. Persistent WASM Matrix storage, cross-signing bootstrap/recovery and verification on all five targets remain open. Other channel interoperability and operating-system acceptance use local fakes here and still need real accounts/platform runs. Legacy channel history is deliberately unavailable without trusted provenance. System/Dreams delivery sends fixed status only; subscription management is RPC-only. See [review demo](../demos/m4.md) and [milestone status](../milestones.md).
