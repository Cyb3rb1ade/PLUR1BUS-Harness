# A2 macOS baseline proof — 2026-10-21

Pre-follow-up `767a8d86cad87abaca8015bc9dba8d150afbff18` versus fetched `origin/main` `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`. The following production files, exact original tests and fixture/ledger helpers have identical Git blobs (verified with `git rev-parse REF:PATH`):

| File | Identical blob SHA |
|---|---|
| `packages/core/src/import/fs-atomic.ts` | `9773746a9513bc118cc0d1687c9459d3886cf076` |
| `packages/core/src/import/rollback.ts` | `991b6a4dcc000bdb91a1dcfc76e06f1362dff58f` |
| `packages/core/test/import/fs-atomic.test.ts` | `57eb5c7d6ea3df7913c172ed9be2603e1745f206` |
| `packages/core/test/import/rollback-ledger.test.ts` | `2eb54599ab9e38f5e6b1003481acbeeb6ff54371` |
| `packages/core/test/import/helpers.ts` | `df500cd6e584f5589e6a787d478407c4b962bc7a` |
| `packages/core/src/import/ledger.ts` | `c2120295d6979c219e41efdcc5b5a0f514c9f8f2` |

`paths.ts` differs only by the additive unused-by-rollback `KNOWLEDGE_RELATIVE_PATH` export and its comment; removing exactly those three added lines yields byte-identical main content. Existing layout/path functions are unchanged. `test/helpers/temp-dir.ts` and `module-api/test/helpers/temp-dir.ts` are also blob-identical.

With the exact private Engine installed frozen/offline, Node24.21 on macOS, both original test files plus the new alias regression ran against unchanged production code. `/tmp/memissues-a2-red.log`: 81 tests, 71 pass/10 fail. The ten failures are the following original nine plus the newly added alias regression. This is matching-main source/test proof, not a claim that a separate full main checkout was run.

1. is true for the root itself and for descendants, also for paths that do not exist
2. '..' segments are resolved before the comparison
3. a dangling symlink is judged by its own (unresolvable) path, not by what it points to
4. classifies pre-import files as unchanged, revert or restore
5. reports the snapshot, the report path and the manifest hash it verified
6. a file the import deleted comes back from the snapshot
7. a report that names a different run than the directory it sits in is refused (report-missing / report-outside-home)
8. manifest content: not JSON, wrong schema, wrong run id, no files map, a snapshot file missing or altered
9. a failure while restoring a deleted file leaves the home as it was for that file and the retry restores it

After the two production fixes and two further fail-closed regressions: `/tmp/memissues-a2-containment-green.log`, 83/83 pass. Complete import+knowledge: `/tmp/memissues-a2-import-knowledge-final.log`, 1,154 tests /1,148 pass /0 fail /4 skips /2 TODOs. No original assertion was weakened or removed. Other PRs that retain the identical main blobs still need #671's fixes on macOS; no integration merge was performed here.


Portability follow-up: the new alias/escape and cycle regressions run without platform skips. They create directory links with absolute targets, selecting junctions on Windows and `dir` symlinks elsewhere. No native Windows run is claimed; the existing baseline skips are unchanged.

The final portable follow-up also checks that a missing suffix is appended only beneath a real directory. A real-file fixture with only `realpath` ENOENT reporting injected failed RED (30/31), then passed with the directory-ancestor guard. Final macOS safety run: **84/84**, zero skips/TODOs (`/tmp/memissues-a2-portability-safety-final.log`). Complete final import+knowledge: **1,155 /1,149 pass /0 fail /4 existing skips /2 existing TODOs** (`/tmp/memissues-a2-portability-import-final.log`). Actual private Engine typecheck, hygiene and source-quality checks passed. The earlier full-Core/workspace counts describe the pre-portability run; no later full green run is claimed.
