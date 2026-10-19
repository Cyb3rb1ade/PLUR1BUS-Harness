# Phase D — engine 1.15 host ports

Scope: Fetch-Port, Secret-Port and HTTP reranker wiring. Controller PR #598 merged the separate pin upgrade to
`98dfe2f03363f6291daa9f85e473578770fb5c55` (contract 1.16 includes 1.15). This change does not update the dependency or
lockfile and does not reimplement `memory.unimport` or the import source links.

`core.ts` passes its live egress service and secret store into `createHarnessHost`. The fetch bridge has no network
fallback; the minimum accepted engine contract is 1.15 so an older engine cannot silently ignore the port. The secret
bridge resolves `apiKeyRef` through an audited short-lived core lease and immediately revokes the lease. Values remain
in memory, with the engine's bounded cache/401 invalidation semantics.

Provider projection admits `apiKeyRef` and `cohere|jina|voyage|remote` rerankers with `baseUrl` and
`cohere|jina|voyage|tei` protocols. Existing model, privacy, local-only, egress and no-fallback checks still apply.
A custom reranker endpoint binds its privacy acknowledgment to that endpoint. Generic `remote` permits keyless servers.

The engine uses its fetch port for model downloads too, so the existing guarded HTTP transport now offers an optional
bounded response stream. Its buffered callers retain their defaults. Engine downloads use backpressure, a 2-GiB decoded
body cap and a five-minute deadline; requests retain a 20-MiB cap. Cancellation and redirect modes are preserved,
and requests carrying credentials or a body never forward either across redirects.

Verification uses Node 24.21.0 and the controller’s exact target pin, installed with the frozen lockfile.
The initial port checks used a temporary local extraction of the same engine commit.
The loopback integration test calls public `Engine.embedding.embed` and `rerank` with a harness-stored key, while global
fetch throws. It verifies actual embedding/rerank results, the TEI wire request and later live egress refusal.
Transport tests cover HTTP error JSON, streaming before EOF, cancellation, redirect handling, size limits and deadlines.
Secret tests cover audit, lease cleanup, rotation, deletion and value exclusion from audit events.
The controller supplies the new engine error-code mappings; additional tests cover them. Core status tests compare
the runtime handshake version rather than duplicating the dependency version in a constant.

Live provider/model quality and real model downloads are not accepted by the loopback tests. Engine role Test buttons
and their RPC/UI wiring remain separate work.

Validation results:

- Focused host/provider/contract/egress/HTTP/error-map suite: 241 passed.
- Standalone import/probe regression suite after port wiring: 1,098 tests, 1,082 passed, the same nine baseline
  path/rollback failures, four skipped and three todo.
- Built CLI-entry and Core regression rerun: 45 passed.
- `pnpm lint`: passed (including typecheck, build/generation, hygiene, i18n and 106 tooling tests).
- Full Core run: 9,602 tests, 9,537 passed, 19 failed, 21 skipped, 25 todo. Nine entrypoint failures came from the
  initially missing build; the stale runtime-version assertion was fixed. All ten pass in the 45-test rerun above.
  The remaining nine failures are three `isInsideDir` cases in `import/fs-atomic.test.ts` and six rollback cases in
  `import/rollback-ledger.test.ts` (dry-run classification/manifest details, deleted-file restore, report run mismatch,
  manifest refusal matrix and injected restore failure). Running these two unchanged test files on the controller
  checkout also gives 64 passed / 9 failed; failures involve canonical `/private` versus symlinked temporary paths.
  These import/path behaviors were left in their owning scope.

The ports are wired at the running Core composition root and at standalone importer/probe hosts. Store probes use
scratch state directories, but their network policy and keys come from the actual target home. They re-read that
home’s validated configuration for each request/lease and never initialize a missing config file. The additional
regression test uses different scratch/target homes, an encrypted file secret backend and a live policy change.
The controller’s ongoing import-link/rollback logic remains separate.

After merging current main (including #598), the focused suite plus privacy regressions ran 265 tests: 263 passed, two todo, zero failures. Typecheck and hygiene passed. The controller’s lock-busy → E_STORAGE mapping was preserved.
