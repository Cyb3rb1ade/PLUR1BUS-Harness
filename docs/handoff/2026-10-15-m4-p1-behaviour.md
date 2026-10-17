# M4 phase 1 — behaviour profiles

## Inventar

Core resolver, isolated turn context, host output budget, six adapter gates, sparse agent configuration,
channel.get effective projection, switchboard profile inspection/editor, schema-generated clients/docs.
Owner package and execution plan are in docs/superpowers/{specs,plans}/2026-10-15-m4-channels*.

## Entscheidungen

- ADR-003's actual levels, rather than the shorthand names in the package; no fifth chat layer.
- Permission fields all restrict. Empty allowlist means deny-all; omitted means inherit.
- Current host connection ids equal channel ids. Unknown bot-connection ids are rejected rather than silently ignored.
- AsyncLocalStorage carries host-resolved policy across both provider-owned and TurnRunner-owned dispatch loops.
- Engine scope restrictions that the current public API cannot express suppress the entire memory call.

## Bedrohungstabelle

| Angriff | Schutz | Test |
| --- | --- | --- |
| Specific override re-enables a forbidden tool/scope | Deny union / allow intersection | behaviour.test.ts matrix and 1000 property trials |
| Group message without mention enters a turn | Adapter + router use the shared authoritative policy | e2e-matrix.test.ts hosted group regression |
| Local slash command bypasses denies | Gate before pairing/status side effects | e2e-slack.test.ts denied slash commands |
| Legacy allowlist widens on-mention | Legacy compatibility only without authoritative host | behaviour-runtime.test.ts |
| Concurrent turn borrows another chat's tools | AsyncLocalStorage context, dispatcher execution gate | behaviour-runtime.test.ts concurrent dispatcher |
| Model guesses a tool hidden from its catalog | Execution gate as well as catalog filtering | behaviour-runtime.test.ts |
| Group text captured under unrestricted engine ACL | Suppress unsupported memory calls; content-free log receipt | behaviour-runtime.test.ts memory test |
| Output flood / repeated edits | Bounded fixed-window buckets, fail closed at capacity | switchboard.test.ts outbound ceilings |
| Profile editor widens another layer or overwrites a concurrent edit | Fixed channel key, current-value check and ifRevision | switchboard-behaviour.test.ts; supervisor schema/audit policy |

## Verhaltensänderungen

Hosted groups require transport-decoded addressing, including configurations with legacy `always`.
A legacy policy cannot widen the delivered group restriction. Owner/admin must edit the broader policy
if future shipped defaults permit widening. Group capture is a content-free harness receipt; group
recall is unavailable on the current engine API. Direct chats retain unrestricted engine access unless
explicitly narrowed. Local pairing/status commands honor command restrictions.

## Owner-Fragen

Pairing-code entropy remains unchanged and open as requested. There is still one connection per channel
kind in the host; multiple connections of the same kind need an explicit future host/config extension.
The memory-scope API gap requires an engine-side contract extension, outside this package's authorization.

## Konflikt-Hotspots

Small wiring edits in channels/switchboard.ts, tools/dispatcher.ts, composition/provider.ts,
agent config schema, channel.get RPC result and adapter receive/send boundaries. M6 provider registry
changes must retain the execution gate, not merely catalog filtering. Identity files are untouched.

## Ehrliche Validierung

Node 24.21.0, pnpm 10.28.0, Rust 1.95.0 on macOS arm64. See the execution ledger for final commands/results.
An independent read-only reviewer found and prompted fixes for Matrix addressing, Slack command gates,
legacy allowlist widening, connection-id ambiguity and missing outbound ceilings. No CI polling.
No live service credentials or public network channel traffic used.

## KNOWN-GAP-todos

- Current engine API lacks a request scope mask: restricted profiles get no engine memory calls.
- Provenance-only creates a harness log receipt, not a durable searchable engine memory.
- This phase does not claim any Matrix crypto, Buzz transport, cron delivery or D93 handoff acceptance.

Final check details: 122 focused tests passed, schema 48 passed, lint/typecheck and docs generation passed.
The broader 2470-test regression had one pre-existing failure: composition/tools path classification;
the same assertion fails against an untouched origin/main archive at 4557176c. The Web Approvals focus
assertion failed in the broad run/retry but passed on the baseline archive, so it remains an unresolved
flaky test, not a proven baseline defect. docs:check confirms generated docs/OpenAPI/settings/help
are current, then fails in the existing bundle-user-docs child-process test for a checkout path with
spaces (expected exit 1, got 0). The broad workspace suite was stopped during unrelated Web tests
and is not claimed green. Existing channel contract KNOWN-GAP TODOs were retained unchanged.
