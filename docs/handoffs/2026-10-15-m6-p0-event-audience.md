# M6 Phase 0 — event audience handoff (2026-10-15)

Base: `origin/main` at `4557176c` (includes #468 and #490).
Branch: `codex/m6-p0-event-audience`.

## Inventory

- `events-map.ts`: explicit agent audiences for all seven audited engine events.
- `core.ts`: convert engine audience IDs to typed `{ agentId }` targets; address
  `agent.activity`; bind subscription admission and delivery to the existing resolver.
- `module-api/rpc-server.ts`: invoke the process's guarded subscription handler;
  check explicit agent filters; check current visibility at delivery, including
  legacy events; distinguish agent, person and connection targets; preserve order
  with a bounded per-connection notification queue.
- `rbac/guard.ts`: additive `events.subscribe` rule using `agent.list` on system.
- `api/events-route.ts`: forward the eight agent event names only with a typed
  agent target and an independent `agent.read` check.
- Seven audit todos activated; real delegated-socket tests and a real-core HTTP/SSE
  regression added. Existing local-owner test remains byte-for-byte unchanged.
- Event and RBAC documentation updated. No dependency, engine, RPC schema, config
  schema or generated-document changes.

## Decisions

#468 already protected web SSE: the old allowlist omitted recall, job, dream, ACL
and activity notifications altogether, and `webEventAllowed` permitted only a
matching person/connection or the global `core.state` event. The vulnerable
boundary was the shared IPC subscription/delivery path, where naming an agent
was only a selection filter. The fix lives there, with a second check in web SSE.
The new SSE allowlist supports authorized agent telemetry, rather than testing
only the old blanket omission.

Agent audience targets are typed objects. Legacy strings continue to mean
connection IDs or an explicit subscription's agent filter; they do not grant an
unfiltered API subscription access. Engine map audiences remain string agent IDs
internally; the composition root turns them into typed delivery targets.

Visibility uses the current stored principal and existing `agent.read` policy:
Owner/Admin see all agents; Member/Viewer need use/manage. Operator preserves
its existing `agent.read` policy. Token scopes narrow the decision. An absent
visibility hook denies delegated agent delivery. Standalone local IPC remains
local-owner compatible. The process-owned subscription guard uses `RPC_RULES`
and cannot bypass current person authentication. A credential-only API control
connection may subscribe to exactly `api.account.changed`, with no agent filter;
it never inherits local-owner visibility.

The existing core test “a subscriber without names gets recall.completed and
never engine.event” was not edited. It passes through the normal local owner
resolver and receives the typed agent audience without an explicit agent filter.

## Threat table

| Attack | Protection | Test |
| --- | --- | --- |
| Viewer subscribes without agent filter and observes another agent | Current `agent.read` at delivery | `module-api/test/agent-audience.test.ts`; `core/test/event-audience-sse.test.ts` |
| Viewer names another agent to evade ACL | Subscription admission checks current visibility | Both new suites |
| Role/right changes after subscription | Fresh resolver per delivery | `agent-audience.test.ts`, revocation assertion |
| Agent ID collides with connection ID | Typed `{ agentId }` separate from connection target | Typed delivery suite, existing private-audience suite |
| Resolver fails or visibility hook missing | Deny delivery | `agent-audience.test.ts` |
| Async lookups reorder events | Per-connection serial queue | Sequence 1, 2, 3 assertion |
| Identity lookup stalls while event storm accumulates | 1,024 queued event cap, disconnect | Event queue test |
| Web feed/replay mixes sessions | Existing session-keyed feed and audience checks | `api/test/web-events-connections.test.ts` |
| New audiences remove unfiltered local owner recall | Local owner resolver authorizes agent audience | Unmodified `core.test.ts` regression; real-core SSE test |

## Behavior changes

Subscriptions with an explicit inaccessible agent now fail with `E_DENIED`.
Unauthenticated process-owned subscriptions fail through the existing guard.
Agent events reach authorized unfiltered API subscriptions, and web SSE forwards
only the eight documented agent event names. Failed visibility lookup drops the
notification. Per-connection asynchronous delivery retains generation order; an
overloaded lookup queue disconnects its socket. No new error codes.

## Owner questions

None. No Owner default was changed. Operator uses the existing RBAC policy.

## Conflict hotspots

`core.ts` composition, the additive `RPC_RULES` entry, shared `rpc-server.ts`
subscription/notify handling, and the API event allowlist. Sonnet's forthcoming
Guard/identity work should retain the current-person resolver at both admission
and delivery. Phases 1–4 should consume typed agent audiences for new surfaces.

## Validation

Local macOS, Node 24.21.0, pnpm 10.28.0. Toolchain check and frozen-lockfile install
passed. The seven activated audit tests were first observed failing due to absent
agent audiences, then passed after the fix.

- Focused event mapping, new socket tests and real-core HTTP/SSE: 39 passed,
  zero failures/skips/todos.
- Existing core integration, core RBAC, all module-api and API tests: 1,454 tests,
  1,445 passed, zero failures, five existing skips, four existing todos.
- `pnpm lint`: passed, including generation/build, workspace typecheck, hygiene,
  i18n and 99 script tests.
- `git diff --check`: passed.

No CI polling. Windows and Linux were not run locally. The fixture socket paths
support Windows named pipes; the new tests participate in the existing package
matrix. Rust was not changed or tested. No manual GUI acceptance was performed.

## KNOWN-GAP todos

The seven Phase 0 todos are gone. Four unrelated API todos remain in the broad
run: OpenAPI closed error union/status parity, the global session cap, and Windows
reserved static-path names. Their assertions were not weakened. Phases 1–4 and
M6 acceptance criteria 2/4/5/6/8/9/10 are still pending; this PR alone does not
claim M6 completion.
