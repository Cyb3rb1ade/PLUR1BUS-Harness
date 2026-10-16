# Live capabilities, message triage and reviewed skill mining

> Execution: native implementation in this isolated worktree, in three sequential branches/PRs. The owner's supplied package is the execution contract.

**Goal:** Close runtime discovery/triage wiring and add inactive, reviewed skill proposals without changing engine or extension lifecycle owners.

**Architecture:** The composition owns a persistent capability service. Each turn derives visibility from current admitted registrations and the supervisor extension catalogue. Triage uses the existing provider/budget boundary. Mining uses the engine proposal queue and the existing disabled skill installer.

**Tech stack:** Node 24.21, TypeScript source-condition tests, node:sqlite/FTS5, existing Rust CLI and RPC schema codegen. No new dependencies.

**Specs:** `2026-09-24-m1b-2a-core-daemon-cli-design.md` D69/D97/D103/D105; `2026-09-28-basics-quality-bar-design.md` D103/D105/F5; owner package dated 2026-10-16.

## Global constraints

- Separate branches: `codex/d103-p1-live-index`, `codex/d105-p2-triage`, `codex/l11-p3-skill-mining`; normal merges only; open predecessor becomes a documented Draft dependency.
- No engine changes, new dependencies, CI polling, force push, rebase, amend or stash. Primary checkout and backups untouched.
- Extension lifecycle, MCP tools, collaboration tools, D106 eval gate, Dreams and importer remain with their owners.
- New RPC requires schema, RBAC, fixtures, Rust parity and generated docs; in-process tools must not collide with RPC names.
- Owner commit identity and trailers follow the supplied package.

## Review focus

1. Stale persisted tools must never grant visibility after MCP revocation or under another principal.
2. Extension overlay/revocation checks must remain authoritative, including on supervisor disconnect.
3. Third-party descriptions cannot select effect/risk or grant permissions; all execution uses dispatcher.
4. Local embedding failure must preserve lexical routing and show degradation in Doctor.
5. Mining must not copy session content across scopes, overwrite human files, or enable its own proposals.

## Phase 1: live index

- [x] Inventory existing registration/index/triage/composition and supervisor APIs.
- [x] Extend `toolcall/sqlite-registry.ts`: hashes, literal FTS5 search, local vector cache keyed by identity/hash; preserve old rows and stats.
- [x] Add `toolcall/live-index.ts`, `extension-feed.ts`, `calibration.ts`: skill snapshots/watch, read-only ext.watch/ext.list, per-turn view, local engine vectors, nightly system job.
- [x] Bind provider/composition lifetime, dynamic suffix skill injection and scoped dispatcher-only `capabilities.search`.
- [x] Extend common tool registration with optional discovery metadata for plugin/channel owners; no tools implemented for them.
- [ ] Run affected tests, typecheck, hygiene, i18n; record actual results and remaining acceptance gaps in the PR.

Interfaces: `LiveCapabilityIndex.view(scope, tools, selection, agent) -> CapabilityView`; `prepare(query, view, signal) -> Promise<CapabilityIndex>`; `job() -> SystemJobHandler`; `status()` -> Doctor snapshot. `ToolDef.discovery` is metadata only; capability/effect/risk remain the registry's validated fields.

## Phase 2: message triage

- [ ] Reuse one asynchronous triage call, with validated decisions and timeout fallback; no second classification in role routing.
- [ ] Load model class mappings from file at message/task boundaries; hold class within each task.
- [ ] Keep chat/failure on default profile and the core tool set.
- [ ] Add at least 60 independent message/recording goldens in dedicated fixtures with segmentation/under-provisioning gates; no D106 gate changes.
- [ ] Validate, commit and create the dependent PR.

## Phase 3: reviewed mining

- [ ] Inventory actual task completion/session records and engine proposal APIs before choosing a mining trigger.
- [ ] Mine repeated successful same-scope workflows into redacted, provenance-only inactive proposals; deduplicate rejected workflow hashes.
- [ ] Bind review-only RPC/CLI/library component with owner/admin RBAC and audit, preserving engine queue ownership and disabled X1 installation.
- [ ] Enforce artifact provenance and default approval for self-knowledge without modifying Dreams or bypassing existing approvals.
- [ ] Add scope/marker/overwrite/rejection/lifecycle acceptance tests; update milestones/tool reliability only with named evidence.
