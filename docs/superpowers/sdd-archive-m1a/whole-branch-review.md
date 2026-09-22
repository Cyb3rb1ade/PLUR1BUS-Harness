# Whole-branch review — feat/engine-extraction-m1a (89148f9f..0c5e3f69)

Reviewer: fresh Opus, 2026-09-22 17:2x. Verdict: **MERGEABLE AFTER FIX WAVE**. No BLOCKER. All 22 ledger rulings: AGREE (T12 with caveat, see finding 5).

Independently verified: registration order identical to main call-for-call (17-row mapping); moved bodies line-faithful; catch-clause set identical except intentional `catch (sinkErr)`; golden oracle touched only in Task 1 (784cf625, 050cbfe6); `Exact<>` gate non-vacuous and fails on drift; `.github/` untouched; name/version/deps unchanged; `runtimeIfUsable` never returns null so `host.runtime ?? undefined` == main; `recordNamespacePhases` dead in production; 9 chmod sites map 1:1 with identical modes.

## Fix wave (FIX NOW — all one/two-line, zero behaviour risk)

1. MUST-FIX `CHANGELOG.md:59-62` — drop "oder fehlschlägt" (securePath only catches ENOENT; non-ENOENT icacls failure rethrows, lib/platform.js:71-77).
2. MUST-FIX `tests/llm-result-cache-integration.test.js:529-530` — add `assert.doesNotMatch(assemblePromptContextSource, /makeQuerySummarizer\(mergingLlmCfg/)` and same for `registerCommandsSource`.
3. SHOULD-FIX `scripts/lint-no-api-outside-adapter.mjs:25` — optional root argv like lint-engine-imports.mjs:47; `tests/lint-no-api-outside-adapter.test.js:33,45` probes → `makeTempDir()` (currently writes into real engine/ + adapter/; t.after skipped on SIGKILL → lint red for everyone).
4. SHOULD-FIX `adapter/openclaw/README.md:64-80` — every index.js line number stale (Task 19 added ~13 lines at index.js:688; file is 7662 not 7629). Re-derive or replace with grep anchors.
5. SHOULD-FIX "three gateway_start/gateway_stop pairs" wrong in `adapter/openclaw/README.md:26`, `docs/engine-api.md:111`, `adapter/openclaw/register-gateway.js:4` — actual: one lone gateway_start (Neo warm-up :54) + two pairs (Obsidian :78-79, Neo service :108-109); third pair is in register-commands.js:621-622. register-gateway.js docblock citations are against an intermediate tree.
6. SHOULD-FIX `engine/recall/minimal-maintenance.js:7` + `docs/engine-api.md:96-99` — soften "host-neutral" claim: engine/** reads OPENCLAW_HOME/OPENCLAW_CONFIG_PATH at 8 sites (assemble-prompt-context.js:283; plur1bus-command.js:230,231,1182,1212,1213,1320,1321). Do NOT change code (env-reading is the faithful move).
7. NIT `tests/golden-prefix.test.js:37` — `>= 5` → `>= 7`, rename test.
8. NIT `tests/helpers/runtime-sources.js:105` — "Repo-relative" → "Absolute".
9. NIT `scripts/lint-engine-imports.mjs:27-32` — correct comment-stripping claim (block-comment continuation without `*` not stripped → loud false positive).
10. NIT `docs/engine-api.md:99` — add "declared in the contract (types/engine.d.ts:421), not implemented"; add one bullet for `recallTimingSink` / `api.__recallTimingSinkForTests` under "What is implemented in M1a".
11. NIT `lib/platform.js` securePath JSDoc — state `fd` is POSIX-only (win32 re-resolves by path; lib/shared-memory-migration.js:216).
12. Optional: delete `engine/.gitkeep`, `adapter/openclaw/.gitkeep`.

Fix wave rule: touches tests/ and scripts/ → full suite before re-review. Then scoped re-review (Sonnet) of the fix diff only.

## PR-description items (known, accepted)

- `recall-over-budget` scenario misnomer (oracle append-only).
- T1 product findings: dead `recall.globalInjectMaxChars` (17 000 unreachable, memories block capped 12 000); `applyGlobalInjectBudget` cuts mid-attribute → malformed XML in `recall-truncated` oracle; LanceDB tie-break needs `--test-concurrency=1`; golden driver `hooks.at(-1)` selects recall hook positionally.
- `PLUR1BUS_TYPECHECK_OPTIONAL=1` = green-without-checking switch.
- `types/engine.conformance.ts` ships inert in tarball.
- Both linters line-oriented/text-based; computed `import(x)` and `createRequire(...)("openclaw")` not caught.
- Transitive reach engine/capture/capture-turn.js → lib/dreaming/light-dream.js → lib/acl-middleware.js → lib/memory-request-context.js:346 → `openclaw/plugin-sdk/routing` (latent default param).
- securePath ignores `fd` on win32; `lib/providers/scoped-embedding-ipc.js:279` only securePath site outside a try.
- `handleObsidianBridgeCommand` assertion in b13 test vacuous (pre-existing).
- `lib/host-services.js:47` binds logger methods once at construction (main re-read api.logger per call; no host swaps it).
- Plan's "Done means" `git diff main -- tests/fixtures/golden-prefix/expected/` cannot be empty (corpus born on branch); real check: `git log 89148f9f..HEAD -- <path>` = 784cf625 + 050cbfe6 only.

## Owner-gate notes (M1a gate, before M1b)

1. Engine not host-neutral yet in two gate-invisible ways: lib/ transitive `openclaw/plugin-sdk/routing`; 8 `process.env.OPENCLAW_*` reads in engine/**. PR-06/PR-14 must own both; milestone wording outruns enforcement.
2. `securePath` fails open on Windows and no caller checks `{ applied, reason }` (not a regression — main's chmod was equally ineffective). Decide: warn on `applied:false`? swallow non-ENOENT throw?
3. `isUnsafeLink`, `ipcAddress`, `canonicalIdentityPath` have no call site yet; `isUnsafeLink` win32 branch false-positives on case-different spelling / junction ancestors — needs its own gate before wiring.
4. `process.env.HOME` → `homedir()` is a real intentional behaviour change (HOME unset: model cache moves from ./.openclaw to real home). CHANGELOG-recorded; "zero behaviour change" true of PR-03, not literally of PR-01.
5. `PLUR1BUS_TYPECHECK_OPTIONAL=1` off switch for the contract's only gate — keep?
6. B6 numbers: ×1 worst p95 242 ms; ×5 recall-truncated p50 612 / p95 808 ms (N=20, p95=p99=max; stub embedder, synthetic corpus). Owner decides the recall budget.
7. Commit author/signature choice (commits are `Claude <noreply@anthropic.com>`, unsigned): leave / self-sign / rewrite+force-push.
