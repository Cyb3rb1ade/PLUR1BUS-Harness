# M3 Phase 4 — provisioning, AgentScope and model licences

## Inventory

- Core: durable `agents/saga.ts`; existing create/recovery/rights/config lifecycle extended; shared ALS scope and memory-port enforcement; private model licence ledger; licence and validated embedding-selection RPCs; existing voice confirmation paths share the ledger.
- API: authenticated licence/select allowlist and NC configuration preflight; real HTTP/core integration coverage.
- Web: agent-create and first-run persona provisioning use `agent.create` with stable idempotency keys; Memory confirmation calls authenticated licence/select RPCs; DE/EN isolation table and Help documents.
- Rust: fresh noninteractive full-profile setup explicitly persists E5-small; host-only setup keeps operator-owned model provisioning. RPC schema, generated bindings, fixtures and RPC documentation updated.
- Existing archive-first delete/export/identity confirmation remain; engine erasure is unavailable and hard delete remains fail-closed.

## Decisions

Engine-first means the existing public `open`/`close` runtime reservation. The pinned engine exposes no reversible durable identity creation or erasure. Provisioning stays paused, admits no turns/captures, and closes its reservation on compensation. Physical namespace erasure is neither attempted nor claimed.

The journal persists intent before each attempted effect, includes the failed step in rollback, and compensates in reverse order. Configuration rollback uses expected content and supervisor revision CAS. Completed journals have a separate activation acknowledgement: startup either compensates incomplete work or completes committed activation. Failed compensation blocks startup.

Model acceptance is actor/revision specific and audited before persistence. The authenticated principal and server clock establish who/when; clients cannot inject these facts. Known Jina revisions are exact artifacts from the pinned engine. Runtime licence checks cover direct configuration-file changes, while pure migration inspection remains possible.

The wizard only completes Memory after actual model selection succeeds. The existing public migration driver is reused; a missing engine generation-validation API is an actionable failure, including for empty stores. A zero-row plan cannot safely replace validation while captures may run.

## Threat table

| Attack | Protection | Named test/evidence |
|---|---|---|
| Duplicate submission or lost HTTP response | Actor/key/digest-bound journal replay | saga/idempotency tests; `m3-agent-licences-e2e.test.ts` |
| Failure after a side effect or crash at any creation step | Durable intent, reverse rollback and startup recovery | saga tests inject every actual create step; child-process crash tests |
| Concurrent config change during rollback | Expected-content and revision CAS; fail closed | agent creation/config compensation tests |
| Unscoped worker reads another agent's store | Process ALS scope must match explicit agent before I/O | worker test imports real turn-memory port and proves no storage call |
| Spoofed licence actor/time or stale revision | Closed params, authenticated principal, server time, exact revision gate | licence ledger tests; real HTTP/core licensing test |
| Unattended NC model selection | Explicit E5-small setup persistence | Rust setup tests and real setup CLI fixture |
| Wizard silently succeeds with previous embedding | Selection RPC must enact or explicitly refuse | real HTTP E5 selection / unsupported Gemma / missing Jina validation tests |

## Behaviour changes

Browser create requests now go through the server saga. Same actor/key/input produces one agent; conflicting input returns `E_CONFLICT`. First-run persona uses the same flow for a new agent. Engine memory work outside the established matching AgentScope is denied before storage. NC selections require durable acceptance, and Memory setup no longer reports completion while the selected embedding is ineffective.

## Owner questions / known gaps

Acceptance criterion 1 is **not fully fulfilled** for real Gemma/Jina model choice: the pinned engine rejects Gemma 2/Qwen3 migration targets and does not expose public generation validation for Jina. The actionable wizard failure is covered; real inference/download/migration was not run. The named TODO in `packages/api/test/m3-agent-licences-e2e.test.ts` keeps true selected-model HTTP acceptance visible. The owner decision is whether to add the missing public engine validation and supported targets in a separate engine change. This phase does not change the engine.

Acceptance criterion 2 establishes reversible runtime reservation and no captures during provisioning. If criterion 2 instead requires physical durable identity erasure, it remains an engine Owner question. Hard-delete erasure is explicitly unavailable.

## Conflict hotspots

`packages/core/src/core.ts`, `turn-loop.ts`, API transport allowlists, RPC schema/generated docs, first-run Memory/Persona sections, Agents UI and Help bundle generation. Phase 1 was normally merged and its chat principal/scope wiring preserved. Phase 2/3 predecessor merges and final PR are coordinated by the root agent; no rebase, amend, stash or force-push.

## Validation

Run locally with Node 24.21 and canonical `TMPDIR=/private/tmp` on macOS:

- Full core: 8,661 tests; 8,594 pass, 0 fail, 19 skipped, 48 existing TODO (`/tmp/m3-p4-core-latest.log`).
- Full API: 656 tests; 647 pass, 0 fail, 4 skipped, 5 TODO including the new honest real-model migration TODO (`/tmp/m3-p4-api-final.log`).
- Changed integration/regression suite: 53 pass (`/tmp/m3-p4-changed-final.log`). Saga/worker/licence focused suite: 21 pass (`/tmp/m3-p4-focused.log`).
- Real Chrome setup/NC/agent/voice browser suite: 38 pass, no skip (`/tmp/m3-p4-browser-final.log`).
- Rust setup unit tests: 17 pass; real setup CLI integration: 1 pass (`/tmp/m3-p4-rust.log`, `/tmp/m3-p4-setup-integration.log`).
- Lint/typecheck, hygiene and 99 script tests passed; generated docs check passed (`/tmp/m3-p4-lint.log`, `/tmp/m3-p4-docs-check-final.log`).
- Post-Phase-1 normal merge: regenerated sources, lint/typecheck/hygiene and script tests passed (`/tmp/m3-p4-postmerge-gen.log`, `/tmp/m3-p4-postmerge-lint.log`); saga/scope/licence focused tests 23 pass (`/tmp/m3-p4-postmerge-focused.log`); real HTTP/core chat+licensing regression 3 pass, 0 fail, 1 honest model-migration TODO (`/tmp/m3-p4-postmerge-api.log`).

No CI polling. No real model inference/download, microphone/human voice acceptance, physical engine erasure or release/install acceptance claimed.

After normal Phase-2 merge (`56dabc9c`), combined saga/scope/licence/RBAC/private-device/HTTP+TLS/remote-config validation: 608 tests, 607 pass, 0 fail, 1 documented model-migration TODO (`/tmp/m3-p4-stack-focused.log`). Lint/typecheck/hygiene/script tests and docs regeneration/check passed. The forced real-supervisor configuration acceptance passed after rebuilding the CLI with the merged schema (`/tmp/m3-p4-stack-config-final.log`); the initial stale pre-build binary was explicitly rerun. An added Member regression confirms switched trust summaries expose only caller-visible device IDs.

Final normal Phase-3 merge (`555e9647`, predecessor Draft #495): regenerated schema/docs; combined 615 tests, 614 pass, 0 fail, 1 model-migration TODO (`/tmp/m3-p4-final-focused.log`); forced real supervisor configuration test 1 pass; lint/typecheck/hygiene/script tests and docs check pass. Real Chrome integrated Agent/Memory/Voice/Bootstrap suite: 40 tests, 39 pass, 0 fail, no skip, 1 explicit hardware acceptance TODO (`/tmp/m3-p4-final-browser.log`). Physical WebAuthn hardware remains unrun.

Review follow-up: unattended setup now appends E5 only when no embedding configuration exists. Existing explicit provider/model/dimensions survive installation and subsequent reruns; unconfirmed NC execution still fails the core licence gate. The real CLI regression covers Jina v3/1024 and Qwen3/768, each across two setup runs, alongside the retained fresh E5 and no-silent-NC-consent cases (3 tests passed, `/tmp/m3-p4-setup-preserve.log`). Full setup CLI integration: 12 passed, 0 failed (`/tmp/m3-p4-setup-all-final.log`); cargo fmt check passed. No engine migration, inference or bypass was introduced.
