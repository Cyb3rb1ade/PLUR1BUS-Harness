# Protocol follow-up implementation plan

> **For agentic workers:** Use the existing work-package R instructions. Each fix starts with a failing regression test, then the smallest production change and focused verification.

**Goal:** Close the two concrete merge blockers discovered while taking over #824.

**Architecture:** Preserve the shared Core exposure policy and the existing RBAC token action contract. Protocol memory operations must use the authenticated principal and shared policy before reaching the engine. Translate OAuth protocol scopes to explicit RBAC action scopes at token issuance and refresh.

**Tech stack:** Node 24.21.0, pnpm 10.28.0, Rust 1.95.0; no new dependencies.

**Spec:** Work package R supplied on 2026-10-30, #824 acceptance matrix, AGENTS.md and CLAUDE.md. The owner supplied the B1–B8/S1–S15 completion list and handed #820 to Codex.

**Compatibility ruling:** A personal protocol token remains an `agent` principal for human-only RBAC and D109. Its verified token ID and matching agent binding identify its backing person for explicitly authorized memory capture and own-user recall. True agent principals retain no user scope or capture attribution. This preserves the documented `memory_store` workflow while applying the shared exposure policy.

## Global constraints

- Work from #824 head `3c3ac736ea69a32dc7bd445478e1e963851bc2c5`; preserve history, no rebase or force push.
- Changes remain in #824; RPC minor remains 1.9.0 while it is the first merged protocol PR.
- Preserve ordinary CLI/Hermes memory behavior and all existing JSON result fields.
- Exposure is the intersection of channel switches, current role/object rights and token restrictions; refuse scopes the engine cannot enforce.
- No disabled/skipped tests, no new dependencies, no CI polling.

## Review focus

- Disabled MCP scopes must prevent engine access.
- A use-only principal must not receive agent-private memory.
- Token sensitivity filters and disclosure restrictions must survive MCP tools/call.
- A2A's default scope must survive authorization-code exchange and refresh.
- OAuth protocol aliases must narrow current RBAC rights and keep advertised scope names in OAuth responses.

### Task 1: OAuth scope issuance

Files: `packages/api/src/oauth/service.ts`, a focused scope mapping helper if necessary, and OAuth API regression tests.

- [x] Reproduce `a2a.task`, `memory.read`, `memory.write` failing with the real TokenService.
- [x] Translate protocol aliases to explicit existing RBAC actions for code exchange and refresh; keep protocol grant/response scope names.
- [x] Verify audience isolation, narrowed refresh and current role checks; run affected OAuth/token tests.

### Task 2: MCP memory exposure

Files: Core memory RPC boundary/shared exposure adapter and its composition wiring, API MCP memory tool only where required, focused integration tests.

- [x] Reproduce MCP tools/call reaching memory with disabled exposure or token restrictions.
- [x] Apply the shared exposure policy with the authenticated principal at the trusted Core boundary, including sensitivity filtering and fail-closed engine scope limits.
- [x] Cover default/disabled exposure, member use without manage, token recall/filter/disclose/capture restrictions and allowed owner access; preserve CLI/Hermes behavior.
- [x] Run affected MCP, exposure, RBAC and memory tests.

### Task 3: Verification and integration

- [x] Run `pnpm lint`, affected Core/API tests and `pnpm docs:check` with the required toolchain.
- [x] Obtain an independent review of the patch and fix actionable defects.
- [ ] Commit fixes separately, verify the remote branch still has the expected ancestry, then push normally to #824.
- [ ] Merge only after current-head required CI checks succeed, using a merge commit with expectedHeadSha.

## Subsequent work

#820 Q3 follows in its existing PR, with main merged and RPC 1.10.0 after #824. R-2a is ineligible: recent main/nightly Windows jobs fail, so its gate configuration remains unchanged. R-2b precedes MM. K #809 is merged with the feature-input fix; RE-08 T2 remains a prerequisite for MM-2b.

## Validation and limits

The final API package run passed 1,053 tests with zero failures (two existing skips and two TODOs). The targeted memory/exposure regressions passed 57 tests, and the OAuth/token selection passed 94. `pnpm lint` and `pnpm docs:check` exited zero.

The complete Core run passed 11,216 tests but failed four environment-sensitive tests: bracketed IPv6 loopback through the environment proxy, host-exec process-group descendant liveness, MCP stdio shutdown descendant liveness, and exec.run timeout descendant liveness. The full IPv6 file passes with loopback proxy exclusions. The host-exec failure also reproduces on unchanged main in this execution environment, whose PID 1 retains orphan zombies. These failures are reported, not skipped or hidden; current-head CI remains the merge gate.

Matching manual sensitivity labels cause `sensitivity-not-enforceable` for filtered aggregate recall because the pinned engine supplies no reliable per-card membership. This conservative refusal applies across stored manual labels until that engine limitation is resolved; unrelated categories do not block recall, and clearing a matching label restores rule-filtered recall. Unfiltered recall retains its existing result shape.
