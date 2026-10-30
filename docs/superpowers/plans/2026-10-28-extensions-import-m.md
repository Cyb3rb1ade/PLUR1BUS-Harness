> Superseded by [work package M v2](2026-10-28-extensions-import-m-v2.md), supplied by the owner during execution.

# Extensions and graphical import — work package M

> **For agentic workers:** execute the owner's task sequence A1–E3 with test-first changes and one commit per task. Read the task brief and its cited design before editing.

**Goal:** install and manage MCP servers and bundles through the real supervisor/API, and import supported source data through the web and desktop interfaces.

**Architecture:** package bytes stay in bounded Rust workers; the supervisor owns configuration and atomic extension transactions. The Core owns MCP connections, policy, secrets and importer domain logic. Full import and rollback use a supervisor maintenance child, with a bounded authorization/event bridge while the Core is stopped.

**Tech stack:** existing Rust workspace, Node 24.21.0, pnpm 10.28.0, TypeScript, Preact and Tauri. Prefer existing dependencies; unverified MCPB signatures use the explicitly permitted unsigned fallback.

**Spec:** `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`; the owner's 2026-10-28 work package M overrides older defaults. The original attachment and pasted request are the authoritative task/acceptance checklist.

## Global constraints

- One PR, titled `extensions and import: MCP servers, bundles, web install and the import assistant (X2, X3)`.
- Commit author: `Cyb3rb1ade <cyb3rblade@me.com>`; task subjects start `M-A1:` through `M-E3:`.
- Execute parts A, B, C, D, E in that order. Each task has a failing behavior test, implementation, passing verification and commit.
- Preserve existing CLI raw RPC JSON, schema identifiers, and optional RPC behavior. No rebase, amend, force push or CI polling.
- Do not edit `crates/plur1bus-engine`, `packages/core/src/engine`, `packages/webmcp`, or CI workflows.
- Schemas are authoritative. Generate sources with `pnpm gen` and references with `pnpm docs:gen`; repeat generation to prove idempotence.
- Keep the parser out of supervisor-safe extension files and keep Engine domain logic out of the supervisor.
- Honor the owner's nine assumptions and fourteen acceptance tests. Stop on the owner's explicitly named compatibility, dependency, data-loss or test-weakening blockers.
- Long runs execute in the background and write logs outside tracked source.

## Integration decisions

1. Disabled installation is the default and the sole new UI action. Preserve shipped explicit CLI/RPC `enable` and replacement-state behavior to satisfy additive compatibility.
2. MCP code uses `extensions/packages/<name>/`; reuse `packages.rs` preparation/transaction primitives across the existing worker boundary.
3. `provider` remains supported by its existing library API but is not newly advertised by the extension RPC lifecycle.
4. A desktop upload uses a person-bound device credential with explicitly enrolled extension scope. Personal API tokens remain agent principals and cannot acquire human-only actions. Existing devices retain their enrolled scope.
5. Maintenance authorization is established before shutdown and confined to a run/person/action/lifetime. It must not become a general stale-role cache.
6. Ordinary importer CLI stdout stays one existing envelope. A separate worker protocol carries progress, configuration requests and cancellation.
7. Existing CLI rollback behavior stays unchanged; the new GUI maintenance path requests complete target rollback explicitly.
8. Snapshot transport preserves `snapshot.json` and validates its files before staging beneath `<home>/import/<run>/snapshot/`. Target reports remain under `<home>/imports/<run>/`.

## Review focus

- Disabling or narrowing an MCP server during a turn must revoke subsequent execution while retaining the turn's descriptor snapshot.
- Worker-supplied paths and upload metadata must not escape supervisor-derived directories, cross principals or survive one-use consumption.
- Core shutdown must not remove the browser's bounded import status, cancellation and progress authority; completion/failure must restart the Core.
- MCPB framing, malformed variables, nested bundles and normalization warnings must fail before live filesystem/configuration writes.
- Source mappings, resumes, adoption paths and snapshots must be bound to a detected source for remote sessions; secrets must never enter printable results.

## Part A — MCP servers and bundles

### Task A1: Schemas and accepted kinds

Files: RPC/config JSON schemas, `packages/config-schema/src/index.ts`, `crates/plur1bus-ext/src/verify.rs`, worker inspection/staging, generated sources and schema tests.

Interfaces: additive `ExtKind` values `mcp-server`, `bundle`; typed `mcp.servers.<name>.{enabled,agents}`, agents `"all" | AgentId[]`; live/advanced configuration. Existing enum variants and method annotations remain valid.

- [x] Test new kinds, reject unknown kinds, validate scopes and closed entries, and prove live restart/tier classification.
- [x] Implement schemas and X2 acceptance without exposing provider over RPC.
- [x] Run schema suites, Rust verifier tests and generation twice; commit `M-A1`.

A1 uses RPC 1.7.0; existing method/type introduction annotations stay unchanged, and the `ExtKind` description records
the two values added in 1.7.0. Explicit MCP agent selections are unique and bounded to 256 entries, following the
configuration schema's requirement that every array has a limit. The package-store library keeps provider support;
the worker's RPC kind set excludes it. MCP/bundle commit and execution remain subsequent tasks.

### Task A2: MCP package lifecycle

Files: `crates/plur1bus/src/ext/{packages,stage,commit,record,paths,state,list,overlays,remove,mod}.rs`, CLI filters and lifecycle tests.

Interfaces: existing `StagedItem`, `ModuleHost` and `PackageStore` preparation, rename, rollback and recovery. Store payload hashes below `extensions/packages/<name>/payload` and move complete trees through existing trash.

- [x] Test disabled install, list/show, failure rollback, crash recovery, uninstall and restore.
- [x] Connect the existing package store across the worker boundary and add explicit kind dispatch.
- [x] Run lifecycle/worker/store tests and hygiene; commit `M-A2`.

A2 depends on the A9 manifest parser, so A9 lands before A2. Worker preparation calls the existing `PackageStore`
under inspection-owned staging; the supervisor moves its complete checked tree with the existing transaction stack.
New MCP state records also bind the exact verified `p1x.json` bytes with optional `manifestSha256`, while legacy
records remain readable. Bundle commit remains refused until A10.

### Task A3: MCP activation

Files: extension lifecycle/list and supervisor host; tests in `ext_lifecycle.rs` and `ext_supervisor.rs`.

Interfaces: `ModuleHost::set_config` and `notify`; MCP flags write only through supervisor configuration.

- [x] Test `all`, selected valid agents, unknown agents, disable, notification and rollback.
- [x] Implement activation, derived agent lists and `ext.changed`; commit `M-A3` after tests.

A3 writes one MCP activation section through the existing config port. Disabling selected agents expands `all` over
configured agents; removing the last selection disables the server. Unknown or repeated agent identifiers are refused
before writes, unchanged selections are no-ops, and the CLI gains repeatable `plugin enable|disable --agent` options.
The real supervisor regression checks persisted configuration and `ext.changed`, in addition to offline rollback tests.

### Task A4: Live MCP composition

Files: Core MCP extension reconciler, `composition/index.ts`, MCP registry/config, config change subscription and tests.

- [ ] Test installed local/remote definitions, absolute pinned runtime/cwd, live register/unregister and stop on disable.
- [ ] Read only installed metadata, reconcile at turn boundaries, add absolute interpreters to command policy and preserve legacy configuration.
- [ ] Run composition/MCP suites; commit `M-A4`.

### Task A5: Agent visibility

Files: Core composition tools, MCP visibility/dispatch port and tests.

- [ ] Test A sees tools/B does not, next-turn descriptor changes and call denial after revocation.
- [ ] Filter selected servers per turn and recheck authority at execution; commit `M-A5` after tests.

### Task A6: Declared tool effects

Files: `tools/mcp-bridge.ts`, policy capability/effect bindings and dispatcher tests.

- [ ] Test manifest read/write/destructive effects, ask defaults and annotation escalation through the actual policy decision.
- [ ] Bind declared effect and coherent capability; retain the conservative fallback for undeclared tools.
- [ ] Run bridge/policy/dispatcher suites; commit `M-A6`.

### Task A7: Secret slots

Files: MCP spawn/auth secret ports, Core extension setup RPC, supervisor metadata overlay port, CLI/Web setup adapters and schemas.

- [ ] Test `ext:<name>:<slot>`, required-slot overlays, lease revocation, scrubbed process env and no secret output.
- [ ] Add declared-slot-only setup and leased stdio/header injection; commit `M-A7` after tests.

### Task A8: Remote authentication

Files: `mcp/auth.ts`, auth interaction adapter/ladder, MCP error overlay and auth tests.

- [ ] Add separate failing tests for missing required issuer, client metadata documents, alternate authorization servers and scope union.
- [ ] Share the interaction boundary without duplicating token exchange; support ladder methods and map auth-required to error.
- [ ] Run auth, redaction and MCP suites; commit `M-A8`.

### Task A9: MCPB and DXT normalization

Files: new `crates/plur1bus-ext/src/mcpb.rs`, manifest schema/tests, worker inspection, `mcp import` CLI alias.

- [ ] Test 0.1–0.4 manifests, uv constraints, signature framing/tamper, user config, path variables and platform overrides.
- [ ] Strip/validate signature framing before ZIP audit; normalize to unsigned p1x with explicit signature-not-checked disclosure when verification is unavailable.
- [ ] Run normalizer/refusal tests, CLI compatibility and dependency gates if needed; commit `M-A9`.

### Task A10: Atomic bundles

Files: kind checks, worker bundle preparation and extension transaction/lifecycle code.

- [ ] Test member hashes, complete nested verification, recursive refusal, rollback after each member, grouped toggles and cascade uninstall.
- [ ] Hold one mutation/skills lock and one rollback stack, derive partial activation metadata; commit `M-A10` after tests.

### Task A11: Claude Code plugins

Files: normalizer module and worker input detection.

- [ ] Test plugin.json optional/default layout, skills/MCP members and skipped component reports, bounded egress-only URL loading.
- [ ] Normalize supported components to a bundle using existing p1x builders; commit `M-A11` after tests.

### Task A12: Extension data directory

Files: `packages/module-api/src/runtime.ts`, supervisor child environment, MCP launch environment and tests.

- [ ] Test stable `ctx.dataDir`/`P1X_DATA`, creation, persistence and absent ambient secrets.
- [ ] Add the module context field and native/MCP process bindings; commit `M-A12` after tests.

### Task A13: Imported MCP configuration

Files: importer source/types/normalization, additive extension provenance schema and tests.

- [ ] Test both sources, disabled records, imported trust and allowlist-only secret migration.
- [ ] Never copy foreign plugin code or arbitrary inline env/header secrets; commit `M-A13` after tests.

## Part B — Real web installation

- [ ] **B1:** add human-only `extensions.read/manage`, RPC rules and docs; exhaustively test roles and agents; commit `M-B1`.
- [ ] **B2:** use one shared explicit delegated-method/action manifest in API and supervisor; test both actual gates and source.path refusal; commit `M-B2`.
- [ ] **B3:** stream authenticated/CSRF-checked uploads to private `run/uploads/`, hash with configured/default 256 MiB limit, distinct rate class and ten-minute cleanup; test bounded memory/expiry; generate API docs; commit `M-B3`.
- [ ] **B4:** additive source oneOf upload/path, atomic owner-bound upload claim and deletion on every result; bind inspections to the person; test replay/cross-person/traversal; commit `M-B4`.
- [ ] **B5:** supervisor ext.watch relay with current-role/session event filtering and lifetime management; test real subscription/revocation/reconnect; commit `M-B5`.
- [ ] **B6:** additive inspection fetch and `/extensions/confirm` page with trust-specific acknowledgments, signer, unverified publisher, license and script first lines; test no install before confirmation; commit `M-B6`.
- [ ] **B7:** upload/inspect/confirm flow, agent switches, kind filters, folder/.skill transport, import tab and Settings Modules rows; restrict sidebar/page/palette consistently; commit `M-B7`.
- [ ] **B8:** browser fixtures plus signed-package real-stack upload→inspect→install→enable; de/en axe and upload limits/ownership/expiry; commit `M-B8`.

## Part C — Graphical import

- [ ] **C1:** optional progress and AbortSignal through all importers and snapshot/rollback; persist/resume only at entity boundaries; test cancellation and completed ledger boundaries; commit `M-C1`.
- [ ] **C2:** inject config writer, Engine/factory and shared lock/maintenance ports; thread path mappings through both full importers; test supervisor config writes and unchanged offline envelopes; commit `M-C2`.
- [ ] **C3:** additive closed/annotated admin.import methods: detect/wsl.list/plan/skills Core, apply/status/abort/runs/rollback supervisor; import.progress supervisor notification; generate/test; commit `M-C3`.
- [ ] **C4:** generic supervisor maintenance gate/worker: validate authority, stop Core, acquire real lock, run import worker, route config/progress/cancel, restart finally; test busy/failure/resume/auth while stopped and complete GUI rollback; commit `M-C4`.
- [ ] **C5:** human-only Owner/Admin import actions and Owner-only secret migration; source capability binding for all path-bearing input; synchronized API gates/events; matrix/adversarial tests; commit `M-C5`.
- [ ] **C6:** allowlist-only Secret Store migration, owner checks and full output/event/log leak sweep; commit `M-C6`.
- [ ] **C7:** `/import` wizard and setup step following §B.8, de/en/five states, explicit unavailable cron/sessions, container snapshot upload/trust anchor and CLI guidance; browser/axe tests; commit `M-C7`.
- [ ] **C8:** real-supervisor import system suite with progress, recall after restart, rollback, concurrent busy and interrupted resume; run RPC/leak/unit suites; commit `M-C8`.

## Part D — Desktop

- [ ] **D1:** Rust-only retained file offers, bounded native upload through gated active connection and person-bound enrolled device credential, connection picker, native-built confirmation route/origin; correct MIME/UTI, preserve catalogue deep-link unavailable; test no install before confirmation; commit `M-D1`.
- [ ] **D2:** native file selection and host.importSnapshot worker packaging/archive/upload handshake, reuse createSnapshot validation and container source staging; test injected host/native seams; commit `M-D2`.
- [ ] **D3:** native/UI/format/deeplink tests with scratch credentials and no real keychain; run Desktop Green with exact locked dependencies; commit `M-D3`.

## Part E — Documentation and final verification

- [ ] **E1:** update extension/MCP/import/web/desktop/RBAC references and de/en user help to implemented behavior; commit `M-E1`.
- [ ] **E2:** extension design amendments for D46 correction, actual storage, current formats and nine owner assumptions; commit `M-E2`.
- [ ] **E3:** regenerate docs, verify idempotent gen/docs, lint, tests, fmt/clippy, real-stack system tests and Desktop Green. Record actual logs and known host failures; fresh branch review; commit `M-E3`.

## Delivery

Map all fourteen owner acceptance points to concrete tests and results. The German PR description begins with the nine owner assumptions, each justified, and includes every task, test commands/results, dependencies/licenses, amendments and remaining owner questions. Push once ready, create one PR, attach it to this chat and report its number. Do not poll CI or merge.
