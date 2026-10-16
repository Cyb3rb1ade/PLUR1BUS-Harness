# L11 skill mining: prepared harness and missing engine contract

Builds on Draft #540 (which builds on #536). Basis: `origin/main` at `3859b949`, refreshed before each phase and normally merged. Engine and extension lifecycle code are unchanged.

## Contract inventory

The pinned engine dependency is `6868b7b117cf7d59b24eb1e75f02aafc1a48f46c`. Its public `types/engine.d.ts`, `MemoryOps` (around lines 744–766), defines `propose(sharedId, newText, principal, agent, opts)` for a change to a shared memory card the caller can read but does not own. `proposals.accept` refreshes the shared copy and its original memory card. Proposal records require `sharedId`, `sourceId`, sharing agent and workspace/user pool. The interface requires user origin for filing; this is not a generic background artifact queue. The harness `memory-ops.ts` correctly exposes those semantics unchanged.

There is no public artifact proposal discriminant, SKILL.md payload, artifact author provenance, workflow hash rejection key or X1 skill-install result. The engine's skill-miner files are internal implementation, not an authorized harness import surface. Deprecated `runCommand` is not a replacement typed artifact API. Reusing a dummy shared memory card would change the meaning and access model of the existing queue.

The owner package excludes engine changes and requires using the engine queue. Therefore production submission remains unavailable. `SkillMining` has an explicit engine-owned artifact port, no implementation for the current memory-correction API, and no local fallback queue. A fresh core exposes the absence in Doctor. There is no fake proposal RPC/CLI/UI, new RPC schema or parity-table change.

## Implemented harness preparation

| Component | Behavior | Named test |
| --- | --- | --- |
| `skill-mining/evidence.ts` | Composition records central dispatcher identity/session/turn/call/tool/version/success, without arguments/results/text | only a real dispatcher result reaches the mining evidence hook |
| `skill-mining/miner.ts` | Archived, completed, exact-owner/agent/scope sessions; incognito/failed/unverified calls excluded; registered tool/version proof required | two proven completed same-scope sessions yield an inactive skill with provenance IDs and no session contents; active, incognito, failed, unproven and error-result sessions cannot train mining |
| Candidate generation | Generic reviewed workflow, tool names/version hashes and session IDs only; no transcript/title/argument/output copying | marker assertions in the same-scope test |
| Proposal port | Pending and `enabled:false`; scope/hash duplicate rejection; changed workflow gets another hash; concurrent runs coalesce | rejected hash stays suppressed…; pending candidates never enter the live capability index…; workflow identity is stable… |
| Bounds | 2 distinct sessions, 2–20 steps, max 200 sessions/20k events; partial pages fail closed | agent views cannot inject foreign sessions or events; partial source windows fail closed |
| `skills.mine` job adapter | Accepts only a host-owned scope, rejects caller-supplied scope; unavailable backend returns skipped; not registered or scheduled in production yet | missing engine artifact API fails before proposing… |
| Artifact provenance | Persisted author plus content hash; unknown files are human; an observed human edit revokes earlier agent attribution | approval setting survives restart; observed human edits permanently revoke previous agent attribution |
| Self-knowledge gate | Default approval on, persisted; owner-only policy change audited before mutation; human files always become proposals even when agent-owned approval is disabled | human skills, persona, agent instructions and project documentation always become proposals with unchanged bytes; only owner may disable default approval… |
| Doctor | Explicit unavailable-contract state, without claiming an active miner | reports the absent skill-artifact queue without claiming that mining is enabled |

The artifact gate is a tested library boundary, not a process-wide interceptor. It is not bound to Dreams or all filesystem/host/exec writers. Its role and path arguments must ultimately come from resolved host authority and D106 canonical roots, not model/RPC text. All tests against the queue use an explicit in-memory test port; they establish the orchestration contract, not persistence or acceptance in the current engine.

## Required additive engine-owner contract

This is a prerequisite specification, not a request sent to another chat or repository and not an engine change in this PR.

1. An artifact variant in the existing engine proposal store, isolated from D31 memory corrections. It carries kind (`skill` or self-knowledge artifact), scope binding, author, workflow/content hash, old-version hash where relevant, inactive candidate payload, provenance session IDs and reason. Background/system producers may only propose.
2. Scope/hash lookup and atomic idempotent proposal creation. Pending/accepted/rejected hashes suppress the same unchanged workflow across restarts. Scope is derived from trusted host context; foreign pools/scopes are inaccessible.
3. Owner/admin preview, amend, reject and accept with authenticated human review and audit. Agents cannot accept their own proposals; changing content/target requires a new preview/version check.
4. Accepting a skill delegates to the existing X1 install path and ends installed **disabled**. It never overwrites a human file or automatically grants the generating agent access. A separate explicit enable makes it routable on the next turn (D103). Acceptance alone cannot both leave it disabled and route it; these lifecycle steps must stay distinct.
5. Human-artifact changes remain proposals until an explicit human application step; default self-knowledge write approval is on, disabling it is owner-only/audited, and disabling it never permits unattended replacement of human artifacts.
6. Strict size/redaction/scope/provenance validation plus a stable result/error contract. No arbitrary filesystem target or enabled flag may come from model metadata.

After that contract is available, bind the prepared ports, add additive schema/RPC_RULES/fixtures/Rust tables, wire CLI + DE/EN review component in Skills & Plugins, and register the scoped nightly system job. End-to-end acceptance must include preview→amend/reject/accept→disabled install→explicit enable→next-turn routing, restart rejection dedup, marker exclusion, and human-file protection through every self-improvement writer.

## Threats

| Attack | Protection | Test/evidence |
| --- | --- | --- |
| Forged model tool result claims success | Separate dispatcher-owned proof, exact owner/agent/session/turn/call/tool/version match | evidence hook and proof restart tests |
| Mine foreign session content | Exact scope binding, independent recheck of listed session metadata, no content copying | same-scope marker test; injected foreign-session source test |
| Incognito/failed/unfinished session becomes permanent skill | Excluded before grouping | active/incognito/failed/unproven/error-result test |
| Repeat a rejected workflow, including reordered scope keys | Canonical hash; engine-owned lookup; same-scope in-process coalescing | rejection/hash stability/concurrent tests; real backend persistence remains prerequisite |
| Candidate auto-enables or overwrites a skill | No installer/writer/enable hook; pending disabled payload only | pending candidates never enter the live capability index |
| Human skill/persona/instructions/docs overwritten | Provenance defaults human; proposal-only library gate, audit-first policy toggle | artifact-policy tests; global writer integration remains open |
| Current memory correction queue used with wrong semantics | Unavailable production adapter; Doctor and failed submission | missing engine artifact API…; Doctor regression |

## Owner questions and KNOWN-GAP todos

- Resolve the public artifact proposal contract with the engine owner. No engine modifications or messages to other people/chats were made here. The asynchronous owner question remains the decision point for the next integration step.
- Confirm the initial mining threshold (two distinct archived successful sessions), generic tool-sequence scope and retention for the metadata-only execution ledger. Review thresholds after useful Nightly evidence exists; no automatic activation is proposed.
- Bind the scope to the eventual task/project authority; current session `scope` defaults to `user` and does not itself establish a global project ACL.
- Implement and test the missing review transport/UI/X1 lifecycle only against the real engine-backed queue. No fabricated memory-card anchors, local proposal store or direct engine internals.
- Bind artifact provenance/approval enforcement across self-improvement writers without changing the parallel Dreams owner. Current library tests do not establish that global guarantee.
- Live D103/D105 model quality and source lifecycle gaps from #536/#540 remain. M2 acceptance 14 is partial; M6 criterion 11 remains open.
