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

- [ ] N-A1: `session/turn-telemetry.ts`, session completion, metrics and Doctor; telemetry persistence tests.
- [ ] N-A2: real `createTurnProvider` baseline via turn eval before changing behavior; retain JSON/Markdown numbers.
- [ ] N-B1: recoverable model-bound failed results, unknown tool discovery hint, consecutive limit; N1 internal markers and sanitization.
- [ ] N-B2: preserve and update provider failure tests; all N1 path/error sources and immediate-stop cases.
- [ ] N-B3: document model error contract in composition and tool reliability.
- [ ] N-C1: full bounded authored descriptions; sorted bounded stable system list; session snapshot.
- [ ] N-C2: read-only `skill.load`, body without frontmatter and file list; used statistics.
- [ ] N-C3: confined bounded `skill.read`, traversal and symlink tests.
- [ ] N-C4: preload through persisted call/result pairs after user message, suppress session reloads.
- [ ] N-C5: metadata-only search and ready local embeddings, bounded twelve-result test.
- [ ] N-C6: shipped skill category/useWhen and authored first-party discovery metadata.
- [ ] N-D1: prior user/task query context and guarded completed-event restoration on followups.
- [ ] N-D2: calibrated confidence threshold; uncertain results preserve catalogue without injection.
- [ ] N-D3: route each task fairly within three skills; multi-task checklist.
- [ ] N-D4: rule fallback, retain core/list for chat, router budgets and latency telemetry.
- [ ] N-E1: stable system instructions and low-confidence search hint.
- [ ] N-E2: live advanced agent toolUse.mode default prefer and trusted turn override.
- [ ] N-E3: DE/EN categories, paths, URLs, current-data words, attachments and skill tools detect need.
- [ ] N-E4: first model round forced when appropriate; subsequent requests auto.
- [ ] N-E5: candidate-specific support including Anthropic Thinking and conservative local flag.
- [ ] N-E6: one buffered retry; streamed answers counted without retracting output.
- [ ] N-E7: cache evidence and sourced provider behavior, explicit limits on unavailable live measurements.
- [x] N-E8: regenerate config fixtures and documentation.
- [ ] N-F1: stable first-party file/web/skill/search/memory core, policy-bound web.fetch registration.
- [ ] N-F2: growing bounded session offers, discovered tools become offered only at next turn boundary.
- [ ] N-F3: enforce candidate family tool cap with core priority and explicit small-family handling.
- [ ] N-F4: omit optional vendor tool-search APIs; explain in PR.
- [ ] N-G1: fixture turn eval in normal CI with DE/EN, no-need, skill, followup, multi and recovery cases.
- [ ] N-G2: separate nightly real-model turn eval job with quality/policy/cache metrics.
- [ ] N-H: pinned and pipeline docs, ADR notes, web event types; generated docs check.

## Final checks

Run `pnpm gen`, verify no new generated diff; `pnpm lint`, `pnpm test`, `pnpm docs:check`, hygiene and turn eval. No Rust source changes planned; record unavailable tooling accurately. Independent final review checks the fourteen owner acceptance criteria against tests. Open the prescribed PR with German description, commands/results, baseline comparison, deviations and owner questions; attach PR to this chat and report its number.
