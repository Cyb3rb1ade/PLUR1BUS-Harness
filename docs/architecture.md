# Runtime isolation and collaboration

This table describes the M5 PR stack on the 2026-10-15 base `4557176c`, including
its M3 P1 dependency. It is an application ACL/port boundary within the Core
process. It is not a separate OS identity or VM for each agent.

| Data/resource | Owner and boundary | Explicit sharing path | Evidence |
| --- | --- | --- | --- |
| Engine `agent-private` memory | Agent's engine principal; collaboration targets have no recall/capture port | None implicit | `packages/core/test/collab/isolation.test.ts` real SQLite stores + fake engine |
| Engine `user` memory | Authenticated person's engine principal | No automatic copying through collaboration | Same test seeds both scopes and checks caller/pool/remote/prompt/transcript |
| Workspace/project pool | Project-specific data; no private engine store is attached to targets | Board post or explicitly selected promotion content | `collab/tools.test.ts`, `collab/chat-promotion.test.ts` |
| Direct chat | Immutable owner, agent, kind and scope; M3 authenticated person binding | RAM preview and explicit no-content/summary/selected/transcript choice | `collab/chat-promotion.test.ts`; M3 chat surface tests |
| Incognito chat | M3 volatile SessionStore; no private preview content written to disk | Explicit confirmed promotion only; durable delegation refused | Incognito promotion test; M3 session tests |
| Delegation transcript | Project session with opaque project owner; span/session/W3C binding | `collab.session.replay` rechecks current project rights | `collab/replay.test.ts`, including restart and foreign-person denial |
| Peer output | Untrusted provenance `tool_result`, escaped in Web | Bounded return contract/artifact references | `collab/tools.test.ts`, Chromium cards/transcript tests |
| Approval/grant authority | Chain-backed permission stores; authenticated person/task/source bindings | Explicit delegable references, checked again before execution | `collab/handoff.test.ts`; original D109 tests |
| Tool registry | Per turn/agent view over catalog; normal D109 dispatcher | Target tool view only; reviewer has read-only checkout tools | `collab/tools.test.ts`, `composition/*` tests |
| Git checkout | Supervisor-bound `ProjectWorktreePort`; no model-selected root | M6 can supply the same existing checkout port | `collab/coding-gate.test.ts`; no second worktree creator |
| Verifier processes | Fixed argv, OS sandbox, private temp/env, bounded execution; network off unless committed convention allows it | Exit status/output digest; human-only audited override | Real macOS sandbox network/read/timeout tests |
| External/A2A target | Stateless adapter; no PLUR1BUS memory store | `DelegationTarget` contract only | Port defined; M6 owns concrete adapters and their acceptance |
| Catalogs, broker, OS user | Process-wide infrastructure; no per-agent OS isolation claim | Scoped views/ACLs; trusted adapters remain trusted in-process code | ADR-003 and composition sources |

Never serialize the runtime `HandoffContext` to an external target: it contains
Core-only authority checks/callbacks. Only the validated D104 contract and
explicit artifacts cross an adapter's transport boundary.

Production Web exposure for new M5 RPCs is an explicit allowlist release gate.
See [collaboration](collaboration.md), [milestones](milestones.md) and the
[phase-5 handoff](handoff/2026-10-15-m5-p5.md). No API ownership exception has been
inferred from passing Core or mocked-browser tests.
