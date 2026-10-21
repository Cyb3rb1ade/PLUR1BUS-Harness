# GP5 Q3 follow-up: late Inbox port and import baseline evidence

Q3 remains a Draft on Q2 #711 (`codex/gp5-q2-audit-health`). Controller owns main integration. No main/PR integration, CI polling, dependency-pin or lockfile change is part of this follow-up.

The late-bound port preserves the original one-argument publish call when options are absent and forwards explicit `cooldownMs` options. The original late-binding assertion is unchanged, including `[["publish", [notice1]], ...]`. A new real-Inbox regression dismisses a notice, retries one millisecond before the rolling one-hour boundary, then verifies publication at the boundary. This checks propagation through the composition port, service and SQLite cooldown store.

Node 24.21.0 / pnpm 10.28.0, actual installed Engine at exact package/lockfile pin `98dfe2f03363f6291daa9f85e473578770fb5c55` (runtime import exposes 20 exports; no shim). RED `/tmp/gp5-n3-red.log`: composition suite 19 tests, 18 pass, 1 fail, zero skips/TODOs; the unchanged late-binding assertion fails on the extra `undefined` argument. GREEN `/tmp/gp5-n3-green.log`:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/core/test/composition/inbox.test.ts packages/core/test/inbox/*.test.ts packages/core/test/audit/*.test.ts
```

143 tests: 142 pass, 0 fail, 0 skipped, 1 existing #662 detail-redaction TODO. This includes real Core startup/socket/SQLite notice tests; the flat embedder seam avoids model downloads and does not replace the installed Engine. The original assertion was neither edited nor weakened. No full-Core green claim or native-all-platform acceptance is made.

## Exact matching-main proof for inherited nine import failures

Fetched `origin/main` is `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`. `git rev-parse origin/main:PATH HEAD:PATH` returned identical pairs for every following file, before this follow-up; none is changed here:

| File | Identical Git blob |
|---|---|
| `packages/core/src/import/fs-atomic.ts` | `9773746a9513bc118cc0d1687c9459d3886cf076` |
| `packages/core/src/import/rollback.ts` | `991b6a4dcc000bdb91a1dcfc76e06f1362dff58f` |
| `packages/core/test/import/fs-atomic.test.ts` | `57eb5c7d6ea3df7913c172ed9be2603e1745f206` |
| `packages/core/test/import/rollback-ledger.test.ts` | `2eb54599ab9e38f5e6b1003481acbeeb6ff54371` |
| `packages/core/test/import/helpers.ts` | `df500cd6e584f5589e6a787d478407c4b962bc7a` |
| `packages/core/src/import/ledger.ts` | `c2120295d6979c219e41efdcc5b5a0f514c9f8f2` |
| `packages/core/test/import/fixtures.ts` | `678c7f25a32e72f5266ce5bf838d86658e8b1bae` |
| `packages/core/test/helpers/temp-dir.ts` | `789604c869b2484c3882e5f86189edc20cb32904` |
| `packages/core/src/paths.ts` | `2bf201e07ee203d71bf3d398c19745fa366727cf` |

The nine affected assertions and existing Q2 reproduction commands are in [the Q2 handoff](2026-10-21-q2-audit-health.md). Independent [A2 #671](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/671) owns the fixes; its [baseline evidence](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/codex/gp3-a2-curated-knowledge/docs/handoffs/2026-10-21-A2-macos-baseline.md) records the nine original failures plus the new alias regression RED (81 tests, 71 pass/10 fail), later containment and ENOTDIR regressions, and final 84/84 safety GREEN. A2 canonically resolves the nearest existing directory ancestor with missing suffixes, rejects escaping symlinks/cycles/non-directory ancestors, and preserves caller path spelling on validated rollback results. Typecheck against the real Engine, toolchain check, hygiene, documentation links and `git diff --check` passed. No A2 fix is duplicated into the audit stack. Matching source/test blobs are evidence of the inherited baseline; this is not a claim of a new full-main run.
