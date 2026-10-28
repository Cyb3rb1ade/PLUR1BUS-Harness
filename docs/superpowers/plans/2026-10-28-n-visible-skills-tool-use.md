# Visible skills and reliable tool use implementation plan

> Agentic workers: use test-driven development, scoped parallel workers and independent final review.

**Goal:** Implement owner work package N and N1 with one PR and task-prefixed commits.

**Architecture:** Keep discovery and policy distinct. Stable skill metadata belongs in the system zone; skill bodies are persisted tool results. Transform failures only at the model boundary. Apply tool choice per actual provider candidate and only before the first call.

**Tech stack:** TypeScript/Node 24, JSON Schema, existing provider adapters and SQLite stores.

**Spec:** Owner work package N (2026-10-28), amendment N1; D69/D97/D103/D105 and ADR-010/015.

## Global constraints

- One PR; no merge, rebase, force push or CI polling; commits Cyb3rb1ade <cyb3rblade@me.com>.
- Tests first; long runs in background with logs. No test skips or weaker assertions.
- No RPC schema changes, new dependencies or engine changes. Generated files only through generators.
- Model error sanitization never changes successful results, log redaction or audit details.
- Skills and tools respect current agent permissions; catalogues change only at turn boundaries.

## Review focus

- Revocation after a prior session offer must remove authorization even for a remembered tool or skill.
- Foreign/failed sessions must never supply restored selections or loaded skill material.
- Failed tools retain paired messages even with duplicate calls, cancellation or the error limit.
- Provider fallback must honor its own dialect, reasoning mode and forced-choice support.
- Skill file reads must stay confined across symlink/path changes and bounded oversized inputs.

## Tasks and validation

Each task follows write test → observe red → implementation → targeted green → task-prefixed commit.

- [x] N-A1: `session/turn-telemetry.ts`, session completion, metrics and Doctor; telemetry persistence tests.
- [x] N-A2: real `createTurnProvider` baseline via turn eval before changing behavior; retain JSON/Markdown numbers.
- [x] N-B1: recoverable model-bound failed results, unknown tool discovery hint, consecutive limit; N1 internal markers and sanitization.
- [x] N-B2: preserve and update provider failure tests; all N1 path/error sources and immediate-stop cases.
- [x] N-B3: document model error contract in composition and tool reliability.
- [x] N-C1: full bounded authored descriptions; sorted bounded stable system list; session snapshot.
- [x] N-C2: read-only `skill.load`, body without frontmatter and file list; used statistics.
- [x] N-C3: confined bounded `skill.read`, traversal and symlink tests.
- [x] N-C4: preload through persisted call/result pairs after user message, suppress session reloads.
- [x] N-C5: metadata-only search and ready local embeddings, bounded twelve-result test.
- [x] N-C6: shipped skill category/useWhen and authored first-party discovery metadata.
- [x] N-D1: prior user/task query context and guarded completed-event restoration on followups.
- [x] N-D2: calibrated confidence threshold; uncertain results preserve catalogue without injection.
- [x] N-D3: route each task fairly within three skills; multi-task checklist.
- [x] N-D4: rule fallback, retain core/list for chat, router budgets and latency telemetry.
- [x] N-E1: stable system instructions and low-confidence search hint.
- [x] N-E2: live advanced agent toolUse.mode default prefer and trusted turn override.
- [x] N-E3: DE/EN categories, paths, URLs, current-data words, attachments and skill tools detect need.
- [x] N-E4: first model round forced when appropriate; subsequent requests auto.
- [x] N-E5: candidate-specific support including Anthropic Thinking and conservative local flag.
- [x] N-E6: one buffered retry; streamed answers counted without retracting output.
- [ ] N-E7: structural prefix and existing cache-usage telemetry are covered; current vendor-source verification and before/after live cache measurement remain blocked by proxy CONNECT 403 and missing model credentials. See the dated limits in `docs/tool-reliability.md`.
- [x] N-E8: regenerate config fixtures and documentation.
- [x] N-F1: stable first-party file/web/skill/search/memory core, policy-bound web.fetch registration.
- [x] N-F2: growing bounded session offers, discovered tools become offered only at next turn boundary.
- [x] N-F3: enforce candidate family tool cap with core priority and explicit small-family handling.
- [x] N-F4: omit optional vendor tool-search APIs; explain in PR.
- [x] N-G1: fixture turn eval in normal CI with DE/EN, no-need, skill, followup, multi and recovery cases.
- [x] N-G2: separate nightly real-model turn eval job with quality/policy/cache metrics.
- [x] N-H: pinned and pipeline docs, ADR notes, web event types; generated docs check.

## Final checks

Run `pnpm gen`, verify no new generated diff; `pnpm lint`, `pnpm test`, `pnpm docs:check`, hygiene and turn eval. No Rust source changes planned; record unavailable tooling accurately. Independent final review checks the fourteen owner acceptance criteria against tests. Open the prescribed PR with German description, commands/results, baseline comparison, deviations and owner questions; attach PR to this chat and report its number.


## Verification record (2026-10-28)

- Immutable baseline at `fd25a143`: 2/20 scenarios passed; tool use 18/20, skill loads 0/10, tool-prefix changes 3/24. Provenance is recorded in `docs/handoffs/2026-10-28-n-baseline.md`.
- Final actual-turn fixture eval: 20/20 scenarios passed; tool use 20/20, skill loads 10/10, prefix changes 0/24. Supplemental policy probes: 22/22 scenarios, two actual denied attempts, zero executed violations. These are harness fixtures, not real-model quality results.
- `pnpm gen`, `pnpm docs:gen`, `pnpm lint`, `pnpm docs:check`, toolchain and hygiene checks passed on Node 24.21.0, pnpm 10.28.0 and Rust 1.95. Regeneration adds no changes beyond the committed generated fixtures.
- Full `python3 /workspace/n-subreaper.py pnpm test`: 17,707 tests total, 22 packages pass, one unchanged documents package fails. Core: 10,667 pass, zero fail; providers: 703/703; web: 529 pass, zero fail; config schema: 110/110. Existing skips/TODOs remain unchanged.
- Documents: 45/58 pass, 13 fail, zero skips. Managed Chromium blocks all local render URLs; pristine `fd25a143` has the same 12 render/layout failures. The existing page-target startup race was independently reproduced and accounts for the additional final failure. Documents source, tests and fonts have no diff. No browser policy, assertion, exclusion or skip was changed.
- PID 1 does not reap orphaned descendants. The external subreaper supplies normal init reaping without repository changes. Unchanged focused process suites pass on both baseline and branch (21/21), as does Hostctl hardening (25/25); the final full suite uses this launcher.
- Independent whole-change review found six issues, each confirmed by a failing regression and fixed. Final focused review/N1/session tests: 98/98; actual four-adapter recovery/policy integration: 75/75; compaction plus eval: 12/12. No findings were deferred.
- N1 transforms only model-bound error results; log and audit detail and successful results remain unchanged. The log schema and log redactor have no diff.
- D4 uses the owner's permitted alternative of 2000-ms routed-decision defaults instead of parallel recall. Local/fallback tool limits are explicitly 16 so the mandatory core fits. Optional F4 vendor APIs are omitted; portable discovery remains in use.
- Real-model cache shares and latency quality were not measured. The separate scheduled eval requires owner-configured model profiles and credentials; D110's direct OpenAI credential gate remains intact.
- Followup review corrections use additional task-prefixed commits; no amend, rebase, squash or force push. No Rust source, dependency or RPC schema change. No CI polling or merge.
