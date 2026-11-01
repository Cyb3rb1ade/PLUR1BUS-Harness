# TM2 / PT-2: team fixtures and arm definitions

First delivery of TM2, based on `main` at `752a184329` (D124 spec/plan merged by #852), on
`codex/tm2-team-eval`. It contains no commits from #853. The existing TM1 branch/PR is unchanged.
This is the task/arm preparation, **not completed PT-2 runtime or measurement acceptance**.

## Delivered

- 18 original MIT team-tier tasks under `tests/bench/coding/team/`: 12 decomposable tasks (three in each of
  TypeScript, Python, Rust and Go) and 6 coupled tasks. Each has three work packages, an instruction, starting tree,
  private seed generator, reference overlays, package checker scopes and an end-to-end checker.
- Three seeds per task (17, 104729, 8675309): filenames, instance identifiers and numeric inputs vary deterministically.
  The public candidate tree contains only the start, `TASK.md` and allowlisted instance metadata. No checker, oracle,
  seed-generator code or reference is copied to agent input.
- Closed manifests and exact seeded ownership templates. The initial corpus owns one source file per work package.
  This fixture validation is separate from TM4's future general plan/glob checker.
- Extensible `{ family, params }` arm definitions for `single`, its highest-effort control, `single` with independent
  review, and `explore+single`, with canonical IDs and explicit capabilities/roles. Matched comparisons own one shared token cap for all model calls; natural comparisons need
  explicit per-arm caps. `team`/`best-of-n` are extension types only. No binding invokes a model or grants authority.
- Local-capacity trial definitions: request concurrency 1/2/4 and writer-capacity multipliers 1/1.5/2.
- Core CI language prerequisites, plus a fixture/prompt change-classifier regression. New file weights in the Core shard
  timing profile are marked as local macOS measurements, separate from the existing Ubuntu Actions source.

The task allocation (131,072 tokens, 100 rounds, 2,700,000 ms) is an explicit benchmark input, not a changed product
default or a measured recommendation. Source bodies, checkers and oracles are self-authored; no upstream tasks or
third-party libraries were copied. `actions/setup-go` is the only new CI action (official v7.0.0 commit
`b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`, MIT). There are no new product dependencies, Engine pin changes, RPC/config
schema changes or database migrations.

## Evidence and review fixes from the initial delivery

The first four test-first assertions failed against the empty preparation: no tasks, no arms, no shared budget plans
and no capacity trials. The initial corpus self-test then caught an incorrect tokenization oracle and two missing
placeholder definitions; those data errors were corrected.

The initial delivery at `63e21a7599` passed 35 focused tests, zero failures, skips or TODOs. For 54 task/seed variants, all 216 package
and end-to-end scopes fail on start and pass on reference (432 scope outcomes). Additional checks grade each isolated
package solution, the intermediate coupled reference stages, actual reference diff overlap/disjointness, deterministic
materialization, candidate-tree cleanliness and negative manifests.

A read-only Claude review identified runtime-forged matched budgets, sibling-dependent compilation and missing partial
stage proofs. Three new regressions were red before their fixes. A further red case showed a missing candidate source
being misclassified as an unavailable compiler. The fixes now:

- validate budget regime and shape together, and copy only declared budget fields;
- compile one scope independently and keep healthy sibling grades when another source is invalid or absent;
- verify single-package and coupled-prefix partial solutions, not only complete references;
- reject empty oracle scopes and undeclared seeds before execution;
- separate candidate errors from genuinely unavailable compiler/runtime executables;
- allowlist child environments, omit ambient credentials, and ignore candidate Go module/toolchain/replace directives
  by building only owned source in a private standard-library module;
- emit nonzero structured failures without arbitrary candidate diagnostics (compiler canary regression);
- require an explicit fixture-root URL, including for any future bundled caller.

Claude Code 2.1.296 (`claude-sonnet-5-5`) reviewed the work in four read-only passes. The initial findings were fixed
and regression-tested; the last delta review found no actionable defect. The implementation session ran the tests.
Those initial fixes also pin Rust in a private working directory with automatic installation disabled, reject
non-directory fixture URLs and unknown natural-budget keys, and cover the ownership/language mismatch rules. The initial
portability pass checked explicit Python UTF-8 mode alongside isolated execution.

The checker helpers are fixture graders, not a second B1 runner: they do not create Git worktrees, drive turns, obtain
credentials, call models or produce a live-model comparison. The self-test executes only authored starting/reference
code. K2 must use its existing verifier sandbox and cleanup policy for model-generated candidates.

Local toolchains: Node 24.21.0, pnpm 10.28.0, Rust 1.95.0, Go 1.27.1, Python 3.13.13. `pnpm test:prep` and TypeScript
checking passed. The initial delivery also passed all 55 CI classifier/shard tests, including the fixture-only prompt case. Every long local check
writes to a log. Final publication requires the prescribed sequential
`pnpm lint`, Core test, WebMCP test, `pnpm docs:check`; exact results and the follow-up Claude review are reported in the PR.
No CI runs/checks were polled and no target-branch merge was performed. Native Windows performance has not been
measured in this local preparation; its existing test timeouts are unchanged.

## Remaining TM2 gates

1. **K2 / B1 is absent from this main base.** Per the owner, do not build an independent runner. Add the team adapter to
   `coding-bench.ts` only after K2 lands. Its formats, fresh worktrees, sandbox, shared budgets, paired statistics,
   credential/canary pattern and redacted reports remain the single runtime path.
2. Then measure each configured local model endpoint at 1/2/4 simultaneous requests, peak memory per writer and
   overcommit slowdown. Record real models, dates and denominators. No such result is invented by these fixture tests.
3. Replace `fanout-eval.ts`, its test, `m5-fanout-eval.mjs`, `eval:m5`, the old timing entry and demo commands together
   with the B1-backed evaluation. Keep the old JSON as historical routing evidence. The old runnable replay is retained
   until its real replacement exists. Add the actual baseline and nightly advisory job at that integration step.
4. **Executable `explore+single` is the last TM2 commit**, after #853 lands on `main`; merge that main, never rebase.
   Its present declaration is metadata only. #853 stays Draft on #843 until the Controller retargets/merges it.
5. Keep one TM2 PR for these follow-up commits. This preparation is ready for review; PT-2 completion/merge acceptance
   still requires the runtime and measurement gates above.

TM3 is not started: it requires `project_worktrees` from unmerged #820. TM4/TM5 wait for K1. Review findings for #853
are a separate handoff; this branch does not preempt them.


## Controller alignment: parameterized arms

The arm model no longer enumerates four fixed IDs. `canonicalArmId` derives portable identities from exact JSON
family/parameter definitions, with recursively sorted object keys (UTF-16 code-unit order) and preserved string/array values. The existing
empty `single` control retains its baseline ID. Other IDs use a readable family prefix and 128 bits of SHA-256; the
initial vectors are pinned in `collab/team-eval.test.ts`. Plans accept either the structured descriptor or its ID,
reject duplicate canonical identities, and require natural caps under canonical keys. Additional metadata supplied
by a caller cannot override the registered roles or capability requirements. New families do not become executable.

K2's B1 loader skips `tests/bench/coding/team/`. Its report schema and runtime environment allowlist remain authoritative
and will be adopted from K2's PR; no separate live runner, report schema or execution profile is introduced here.
Both packages extend `docs/ci.md`; the second to merge integrates `main` with a merge commit and resolves the overlap.
The runtime/measurement and final async-exploration gates above remain in force.


The arm follow-up additionally bounds canonicalization to 4096 visited JSON values and depth 32 (parameter root at depth 0), and documents
JSON's numeric `-0`/`0` equivalence. Its own unit group and the prescribed full local checks are reported separately
in #860; the evidence counts above describe the original preparation commit, not this follow-up.
