# Task 9 (PR-02d) report — the `api.` boundary lint

## Implementation

Created `scripts/lint-no-api-outside-adapter.mjs` verbatim per the brief:
scans `lib/**/*.js` and `engine/**/*.js`, skips `node_modules`, allowlists
`index.js`, `adapter/**`, `lib/setup/*-plugin-runtime.js`,
`lib/runtime-shutdown.js`, `lib/host-services.js`,
`lib/providers/openclaw-memory-embedding-adapters.js`,
`lib/providers/scoped-embedding-ipc.js`; regex `(?<![.\w$/-])api\s*\./` with
comment-stripping (`/* */`, `//`, leading `*` doc lines) before matching.
Exits 1 with `file:line` per violation, exits 0 printing
`lint-no-api-outside-adapter: clean` otherwise.

Created `tests/lint-no-api-outside-adapter.test.js` verbatim per the brief
(3 cases: clean tree, plants+removes a violation under `engine/`, allows one
under `adapter/`).

Wired into `package.json:scripts.lint`, appending
`&& node scripts/lint-no-api-outside-adapter.mjs`.

Repo rules applied (mandatory per Task 3 learnings):
1. `.gitignore` — added `!scripts/lint-no-api-outside-adapter.mjs` under the
   `scripts/*` per-file allowlist (next to `!scripts/typecheck.mjs`).
2. `scripts/lib/deploy-integrity.mjs` — added
   `"scripts/lint-no-api-outside-adapter.mjs"` to `DEPLOY_FILES`, inserted
   between `"scripts/importance-backfill.mjs"` and
   `"scripts/repair-tombstones.mjs"`. Note: this section of `DEPLOY_FILES`
   (the "Operator- und Wartungsskripte" block) is not globally alphabetical —
   it reads as historically appended in rough per-addition runs — but the
   immediate local run `dedupe-memory-ids → importance-backfill →
   lint-no-api-outside-adapter → repair-tombstones` is alphabetical (d < i <
   l < r), matching the pattern of prior insertions in that block.

## Pre-wiring scan (Step 2 of brief, run before touching `npm run lint`)

```
$ /home/claude/.node24/bin/node scripts/lint-no-api-outside-adapter.mjs; echo "exit=$?"
lint-no-api-outside-adapter: clean
exit=0
```

**No hits outside the allowlist.** No widening of the allowlist was needed
and none was done.

Verified the three near-misses the brief calls out are still present and are
correctly excluded by the `/`-guard and comment stripper (confirmed by
`grep`, and by the script's own clean exit):
- `lib/llm-call.js:77` — `endpoint: llmCfg.baseUrl || "https://api.openai.com/v1"` (excluded: `/api` — the `/` immediately before `api` fails the negative lookbehind `(?<![.\w$/-])`).
- `lib/providers/reranker-cohere.js:52` — `await fetch("https://api.cohere.com/v2/rerank", {` (same `/api` guard).
- `lib/telegram-commands/status-data.js:9` — ` * Die plugin-interne Variante (api.pluginConfig.obsidianBridge.enabled)` (excluded: it's a `/** ... */` block-comment line; `stripComments` strips lines starting with `*` via the `^\s*\*.*$` branch).

**Regex robustness assessment (brief asked to check and say):** the
comment-stripping is a per-line, not multi-line-aware, pass:
- Single-line `//` comments and inline block comments (`/* ... */` fully on
  one line) are stripped correctly.
- A line that is itself the middle of a *multi-line* `/* ... */` block
  (i.e. not starting with `*` after trim, e.g. a block comment opened
  earlier with free-form text spanning several lines without a `*` prefix)
  would **not** be stripped, so an `api.` reference written in prose inside
  such a block would be flagged as a false positive. This is a real gap in
  the brief's script, but it does not affect the current tree — the scan
  came back clean, meaning no file in `lib/`/`engine/` today has this
  pattern, and the three documented near-misses (all single-line forms) are
  handled correctly. I did not alter the brief's regex/stripper since the
  brief's code is to be taken verbatim and the pre-wiring scan found nothing
  to react to; flagging this as a residual risk for future block-comment
  prose rather than a defect requiring immediate action.

## RED/GREEN

New test, run standalone:
```
▶ lint-no-api-outside-adapter
  ✔ passes on the current tree
  ✔ fails on an api. reference under engine/
  ✔ allows an api. reference inside the adapter
✔ lint-no-api-outside-adapter
ℹ tests 3
ℹ pass 3
ℹ fail 0
```
(The test itself is the RED/GREEN proof: case 2 plants a real violation
under `engine/__lint_probe__/bad.js` and asserts exit 1 with the expected
`file:line`, then removes it; case 3 does the adapter-allowed counterpart.)

## Lint / golden / deploy-manifest test

```
$ PATH=/home/claude/.node24/bin:$PATH npm run lint
> node --check index.js && ... && node scripts/typecheck.mjs && node scripts/lint-no-api-outside-adapter.mjs
lint-no-api-outside-adapter: clean
lint_exit=0
```

```
$ node --test --test-concurrency=1 tests/deploy-manifest-covers-shipped-scripts.test.js
ℹ tests 3 / pass 3 / fail 0
```

```
$ node --test --test-concurrency=1 tests/golden-prefix.test.js
ℹ tests 9 / pass 9 / fail 0
```

## Full suite

```
$ PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test
ℹ tests 5135
ℹ pass 5132
ℹ fail 0
ℹ skipped 3
```
Matches the required baseline (`fail 0, skipped 3`).

## Commit

`fd5bac5b` — `chore(host): forbid the OpenClaw api surface outside the adapter`
Files: `.gitignore`, `package.json`, `scripts/lib/deploy-integrity.mjs`,
`scripts/lint-no-api-outside-adapter.mjs` (new),
`tests/lint-no-api-outside-adapter.test.js` (new).

An unrelated pre-existing untracked file,
`docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md`, was left out
of the commit (not part of this task, not touched).

## Self-review / concerns

- Script and test bodies match the brief byte-for-byte (no deviation).
- `package.json:scripts.lint` change is a pure append, no reordering.
- Both repo-hygiene rules (`.gitignore`, `DEPLOY_FILES`) applied; the
  `deploy-manifest-covers-shipped-scripts` test passes, confirming coverage.
- No behavior change to any shipped runtime file — this task only adds a
  dev-time lint script and its test.
- Only outstanding item is the documentary note above about the
  comment-stripper's line-oriented limitation for multi-line block-comment
  prose. It's inert today (scan is clean) and the brief's code was
  implemented verbatim as instructed, so no code change was made for it —
  flagging it here per the task's request to report, not silently patch.
- DEPLOY_FILES insertion point is locally alphabetical but the surrounding
  block as a whole is not; flagged above in case the reviewer expected
  strict global alphabetical order instead.
