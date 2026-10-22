# GP5 N1: CI contract corrections for P2, P5 and P6

2026-10-21. P2 #672 starts at `383443a4b6ce94624104f72d1e382f624a6cd23d`;
P5 #710 at `38d380ce022a71e31677e1be74372f332683bd84`; P6 #712 at
`ce88c81ae39eecc79004a3da338d57912f9b21e2`. Remote PR heads matched clean worktrees.
The corrections propagate by normal feature-branch merges P2 → P5 → P6. No main/PR integration,
repository setting, Engine pin or lockfile change, rebase, amend, force push or CI polling is involved.

## Corrected behavior

- Hermes' workflow assertion follows the actual `changes` job's `python_matrix`; the separate Desktop/Hermes
  workflows retain their own `plan` job. The `steps.plan` references in CI remain valid step references.
- The P2-added `docs-hygiene` step uses verified pnpm v6 commit
  `0977fd99725f1db4007ccb2928dbb4e90d06cc86`. Other existing action pins remain S3's responsibility.
- All `crates/**/fixtures/**` select both Rust and TypeScript. Concrete readers are
  `packages/core/test/import/folder-hash-vector.test.ts:10` (skill hash fixtures) and
  `tests/system/desktop-attach.test.ts:50` (fake API fixture). The additional parity reader
  `packages/core/test/restore-reapply.test.ts:129` reads `crates/plur1bus/src/backup/restore.rs`,
  which therefore selects both as well. Other Rust sources retain Rust-only selection.
  In P5/P6 this selects the real Core shard jobs and their exact-partition gate too.
- Only `perf-startup` and `perf-budgets` are advisory: `success`, `failure` and `skipped` are accepted,
  even if runtime is selected. Missing, malformed and `cancelled` outcomes fail. Every required job,
  including Core shards/partition in P5/P6, retains fail-closed success/skip semantics.
- Required-check migration stays disabled until a green Windows baseline and refreshed open PR heads.
  Merge-queue activation and Controller/Watcher ownership remain unchanged.

## #621 semantic integration blocker: exact evidence and Controller patch

Inspected remote `fix/macos-unit-core` / PR #621 at
`ea86c2ff94a80c6eee2c5bf3bce8f6c3040932bf`, fetched without merging it.
Its `.github/workflows/ci.yml:304–310` explicitly calls the new macOS browser shards non-gating,
then declares:

```yaml
  web-browser-macos:
    name: web-browser (macos-15, ${{ matrix.shard }}/${{ matrix.total }})
    needs: plan
    if: needs.plan.outputs.proceed == 'true' && needs.plan.outputs.macos == 'true'
```

P2 renames that **job** to `changes`; its remaining `plan` identifier is only a step.
Consequently a clean textual merge can still leave an undefined `needs.plan` job.
The P2 workflow contract also intentionally rejects added jobs missing from the aggregate gate.
Merely renaming the dependency is insufficient: it neither follows affected-web selection nor
registers the new outcome/dependency with the aggregate gate.

Before combined integration, the Controller must apply both sides in the integration source:

```yaml
  web-browser-macos:
    needs: changes
    if: needs.changes.outputs.proceed == 'true' && needs.changes.outputs.web == 'true' && needs.changes.outputs.macos == 'true'
```

Keep #621's stated advisory macOS policy and existing two-shard browser command. On P2's side:

1. Add `macos` to `gate.mjs`'s validated boolean output keys.
2. Add `'web-browser-macos': enabled && o.web === 'true' && o.macos === 'true'` to `selections`.
3. Add `web-browser-macos` to `ADVISORY`, accepting only `success|failure|skipped`; missing/cancelled remain errors.
4. Add `web-browser-macos` to `ci-gate.needs`. Keep the existing Linux browser build/shard/partition jobs required.
5. Extend table tests for proceed/web/macos combinations and all advisory/required outcomes, and update the
   test flag fixtures for the now-required `macos` output. Execute the actual workflow condition/gate contract,
   Hermes workflow tests and actionlint after refreshing both heads.

P2 does **not** pre-whitelist a job that does not yet exist. Its integration regression includes the exact stale
#621 dependency/condition shape and proves `plan` unresolved; replacing it with `changes` resolves the references.
The independent exhaustive job/dependency assertion still rejects a job missing its gate registration.
No #621 source was edited or merged. This is a required Controller integration fix, not a claimed completed integration.

## Validation of P2 corrections

Node `v24.21.0`, toolchain check passed. RED: focused CI tests 30 pass / 4 fail, covering both shared-input tests,
advisory outcomes and the new docs action pin. GREEN: `node --test scripts/ci/*.test.mjs`: 50/50, zero skip/TODO.
`PYTHONPATH=hosts/hermes python3 -m unittest tests.test_workflows`: 8/8.

Broader offline command:

```sh
node --test --test-timeout=120000 scripts/ci/*.test.mjs scripts/run-ts-tests.test.mjs scripts/lint-hygiene.test.mjs scripts/release/test/*.test.mjs
```

See the per-branch follow-up records for exact counts. Existing audit-policy package-scope TODO remains
(`scripts/release/test/audit-policy.test.mjs`); no new TODO or skipped test was introduced.
Toolchain, hygiene, source-quality, documentation links, actionlint with repository config and diff check pass.
These are local script/workflow checks; Windows baseline, refreshed hosted heads and #621 integration remain gates.
Existing main audit failures are outside this correction; no clean audit baseline or hosted green status is claimed.

P2 follow-up: the broader command completed with **128 tests: 127 pass, 0 failure, 0 skip, 1 existing TODO**.
Local logs: `/tmp/gp5-n1-p2-red.log`, `/tmp/gp5-n1-p2-final-ci.log`,
`/tmp/gp5-n1-p2-python.log`, `/tmp/gp5-n1-p2-scoped.log`.
