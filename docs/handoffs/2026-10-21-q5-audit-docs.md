# GP5 Q5: Owner notice documentation and integration gates

Q5 #715 remains Draft on `codex/gp5-q4-audit-web` (#714). Its feature branch now also includes Q3 #713 by normal merge `48c19e61e1009af14735e4b94a65f3ceadcb1bcf`, whose second parent is fixed Q3 `561d9d97604e070c5cac721962498375a8dd01f1`. Q4 prerequisite is `4b5c572265`; Q3 itself remains stacked on Q2 #711. No prerequisite is claimed merged to main. No main integration, rebase, amend, force push, CI polling, Engine-pin or lockfile change occurred.

The merge is feature-to-feature and intentionally gives this single existing Q5 Draft both Q3 and Q4 prerequisites. Its current diff against Q4 therefore includes the Q3 implementation as well as Q5 documentation. Controller must integrate the prerequisites first and retarget/reassess the final documentation diff before main integration. The user request's “after Q3 merge” is still a main-integration gate; this work prepares a reviewable follow-up now and does not claim that gate satisfied.

`docs/user/de/audit.md`, `docs/user/en/audit.md` and `docs/audit-chain.md` now describe the implementation's bounded codes, Owner-only notices, rolling maximum one notice per Owner/cause/hour, persistence across restart/dismissal/retention/clock rollback, and insertion-failure behavior. Notices contain only code, count and observation time, never record content, actors, targets, details or free-form errors. Admin audit reading remains distinct from Owner notice subscription. The help bundle is regenerated from the Markdown sources, not edited by hand. Existing #662 producer-redaction limits on audit records remain explicit.

Validation on the combined feature branch with Node 24.21.0, pnpm 10.28.0 and the actual installed Engine:

```sh
pnpm gen
node --experimental-strip-types --no-warnings=ExperimentalWarning packages/web/scripts/bundle-user-docs.ts
node --experimental-strip-types --no-warnings=ExperimentalWarning packages/web/scripts/bundle-user-docs.ts --check
node --test --test-timeout=120000 scripts/bundle-user-docs.test.mjs scripts/check-doc-links.test.mjs
PLUR1BUS_WEB_E2E_REQUIRED=1 node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/web/test/help-markdown.test.ts packages/web/test/help-page.test.ts
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/core/test/composition/inbox.test.ts packages/core/test/inbox/*.test.ts packages/core/test/audit/*.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.base.json --noEmit
node scripts/check-doc-links.mjs
node scripts/check-docs-commands.mjs
node scripts/lint-hygiene.mjs
git diff --check
```

52 documentation/help tests pass (10 bundle/link and 42 Markdown/browser/axe), zero skips/TODOs. The combined composition/Inbox/Audit suites: 143 tests, 142 pass, 0 fail, 0 skipped, 1 existing #662 detail-redaction TODO. Typecheck, generator/check, command/link checks, hygiene and whitespace checks passed. Local logs: `/tmp/gp5-n5-{bundle-tests,help-tests,core-combined,typecheck,gen,hygiene}.log`. The initial combined Core attempt stopped at module loading because RPC generated files had not yet been generated in this documentation worktree; `pnpm gen` supplied the real generated files, then the exact unchanged command passed. No test was skipped, weakened or deleted to resolve that setup failure.

Help browser tests use the existing HTTP/RPC fixtures. Combined Core tests exercise the installed Engine and real SQLite/sockets with the flat embedder seam. These checks add no real-model or native-all-platform qualification. No full-Core/workspace green claim is made. The inherited nine macOS import failures have [matching-main blob proof and separate #671 fix evidence](2026-10-21-q3-audit-notices.md); no duplicate import fix enters Q5.
