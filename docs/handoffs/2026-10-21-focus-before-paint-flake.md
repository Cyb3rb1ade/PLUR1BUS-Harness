# Focus-before-paint observer flake

Base: main `68f43bc646a90bc2cf5b7e19132b8dd8b794985a`; branch `codex/fix-focus-before-paint-flake`. The supplied CI failure was run 39529183113, #673, web-browser shard 3/4: two `{key:'composer', focused:true}` records. No hosted CI run or log was queried.

## Cause and deterministic reproduction

The chat test armed a document-wide child-list MutationObserver while the outgoing session's composer was already present, but initialized `last` to null. Any unrelated DOM mutation before navigation therefore counted that existing composer as newly inserted. The next session then contributed its real insertion. These are two observed elements, not evidence of two focus transitions on the incoming element.

A neutral comment insertion/removal outside the application forces this ordering without changing focus or application state. Before the fix the test fails exactly as reported. Trace: appeared IDs `P0-3`, `P0-7`, labels `Message to bernd`, `Message to mara`, but actual focus events only `P0-7`. The fix baselines `last` to the already-present textarea. The exact one-entry/already-focused assertion remains; incoming element identity and exactly one actual focus transition are also asserted. A genuinely repeated incoming insertion still fails.

The first stability attempt exposed the same bug in this file's Usage case on repetition 02: `Set limit` was recorded before `Confirm limit`. Its observer now starts from the existing heading title. Title rather than node identity is required because the dialog reuses its heading element across steps. A neutral mutation deterministically reproduced this second failure before the fix. The exact `['Confirm limit']` and no-unfocused-record assertions remain. No retry, sleep, count relaxation, skip or product focus change was added.

## Verification

- Ordinary initial file: 3/3. Deterministic chat regression before baseline fix: 2 pass/1 fail, with the old/new identity trace above.
- Initial repeat attempt after the chat fix: run 01 passed; run 02 failed Usage. This incomplete attempt is not the required stability result. Deterministic Usage regression: 2 pass/1 fail before its fix.
- Final test version: **20/20 full-file executions, 60/60 test cases, zero failures/skips/TODOs**, Node24.21.0, actual matching Playwright Chromium with `PLUR1BUS_WEB_E2E_REQUIRED=1`. Each repetition starts a fresh Node process, performs the normal web build and launches its browser; the runner validates exactly three passing cases and zero skips every time.
- Negative control after those repetitions: temporarily changing the product's chat focus from `useLayoutEffect` to passive `useEffect` makes this test red with `focused:false` (2 pass/1 fail). Product source was restored byte-for-byte; another complete file run then passed 3/3. No product mutation is committed.
- Final actual-private-Engine TypeScript check, hygiene, source-quality and diff checks passed. Frozen offline dependency installation and generation did not change any pin, manifest, lockfile or tracked generated output. Tests use the existing UI mock RPC and real Chromium; no real-model or hosted-run qualification is claimed.
- Independent read-only review confirmed both baseline corrections preserve the before-paint timing assertions, target transitions and failure behavior.

Each stability repetition used:

```sh
export PATH=/Users/cyberblade/.node24/bin:$PATH
PLUR1BUS_WEB_E2E_REQUIRED=1 node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/web/test/focus-before-paint.test.ts
```

Local evidence: `/tmp/focus-flake-deterministic-red.log`, `/tmp/focus-flake-usage-deterministic-red.log`, `/tmp/focus-flake-repeat-summary.log` (initial incomplete attempt), `/tmp/focus-flake-final-repeat-summary.log` and `/tmp/focus-flake-final-repeat-{01..20}.log` (required stability set), `/tmp/focus-flake-passive-negative-control.log`, `/tmp/focus-flake-restored-final-green.log`, `/tmp/focus-flake-final-typecheck.log`.

Ready PR on main, separate from the P5/P6 feature merges. No main merge, pin/lock change or CI polling. #742 was not touched. Hosted CI is deliberately uninspected; Controller owns integration.
