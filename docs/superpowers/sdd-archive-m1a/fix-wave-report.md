# Fix-wave report — feat/engine-extraction-m1a

Base: `0c5e3f69`. Result: two commits, `f9b88635` (test) and `cba055de` (docs).
No runtime behaviour change: only docs, comments, tests and the two lint
scripts' argument handling were touched.

## Per-item changes

### 1. MUST-FIX — CHANGELOG.md:59-62 ("oder fehlschlägt")
`securePath` only catches `ENOENT` (ACL tool unavailable); a different
`icacls` failure rethrows (`lib/platform.js:71-77`). Dropped the overstated
"fehlt oder fehlschlägt" and replaced with an accurate parenthetical.
- `CHANGELOG.md:59-61`

### 2. MUST-FIX — tests/llm-result-cache-integration.test.js:529-530
Added the two missing `assert.doesNotMatch(..., /makeQuerySummarizer\(mergingLlmCfg/)`
checks for `assemblePromptContextSource` and `registerCommandsSource`, next to
the existing ones for `source` and `memoryToolsSource`.
- `tests/llm-result-cache-integration.test.js:544-545`

### 3. SHOULD-FIX — scripts/lint-no-api-outside-adapter.mjs:25 + test fixture
- `scripts/lint-no-api-outside-adapter.mjs`: added the same optional
  `process.argv[2]` root argument `lint-engine-imports.mjs` already has
  (`root = process.argv[2] ? resolve(process.argv[2]) : <default>`), same
  comment, same default-when-omitted behaviour verified by running the
  script with no argument and confirming `clean` on the real tree.
  `scripts/lint-no-api-outside-adapter.mjs:24-30`
- `tests/lint-no-api-outside-adapter.test.js`: rewritten to build fixtures
  under `makeTempDir()` (from `tests/helpers/temp-dir.js`) and point the
  linter at that tmpdir via the new root argument, mirroring
  `tests/lint-engine-imports.test.js`'s `fixture()`/`run(target)` shape.
  No more writing probe modules into the real `engine/`/`adapter/` trees; no
  raw `mkdtempSync`.

### 4. SHOULD-FIX — adapter/openclaw/README.md:64-80 (stale index.js lines)
Re-derived every citation in the "Deliberately still in `index.js` after
M1a" table against the current tree with grep (`index.js` is `7662` lines,
confirmed with `wc -l`):
- plugin object / `export default`: `4223-7626`,`7629` → `4250-7659`,`7662`
- `api.registerMemoryCapability` block: `4282-4359` → `4309-4381`
- five host-shaped functions: `3144/3245/3289/3358/4068` →
  `3171/3272/3316/3385/4095`; named-export-list citation `index.js:7628` →
  `index.js:7661`
- `/wiki` command: `7201-7249` → `7228-7276`; `registerPluginCommand` helper
  `6881-6886` → `6908-6913`
- bare grouping block: `6867`/`7253` → `6894`/`7280`
- `skill_proposal_changed`: `5707-5773` → `5734-5800`
- reply-outcome recording/completion: `7325-7344`,`7469-7506` →
  `7352-7371`,`7496-7533`
- skill-workshop probe: `4364-4369` → `4390-4396`
- `api.config`/`api.pluginConfig`/`api.registrationMode`/`api.resolvePath`
  reads: `4266,4270-4271,4278,4289,4372,4647,4970,5691,5870,7104,7114` →
  `4293,4297-4298,4305,4316,4399,4674,4997,5718,5897,7131,7141`; also
  `createHostServices(api)` citation `4280` → `4307`
- header line rewritten from "against `index.js` at the end of PR-03 (7 629
  lines...)" to "against the current `index.js` (7 662 lines...)" with a
  note to re-derive before trusting a range.
- `register-commands.js:122`/`:377`/`:621-622`/`:1141-1143` citations were
  checked too (off by at most one line, pointing at the wrapping `if`
  instead of the call) and left as-is — the review's finding-4 scope was
  `index.js` line numbers specifically.

### 5. SHOULD-FIX — "three gateway_start/gateway_stop pairs" wording
Fixed in all three places named by the review:
- `adapter/openclaw/README.md:26` and `docs/engine-api.md:111`: reworded to
  "a lone `gateway_start` (Neo warm-up) plus two `gateway_start`/
  `gateway_stop` pairs (Obsidian bridge, Neo service)".
- `adapter/openclaw/register-gateway.js:4-16` docblock: same correction, plus
  a sentence naming the third pair's actual home
  (`register-commands.js:621-622`, the control-health probe).
- Re-verified the module's own stale `index.js:*` citations against
  `git show 89148f9f:index.js` (the pre-extraction tree the docblock is
  supposed to describe) rather than the intermediate tree they pointed at:
  Neo warm-up `5304-5318` → `5299-5307` (no matching `gateway_stop`);
  Obsidian pair `7034-7043` → `7023-7032`; Neo service pair `7484-7506` →
  `10319-10341`; shutdown-owner block `7862-7900` → `13453-13491`.

### 6. SHOULD-FIX — soften "host-neutral" claim
- `engine/recall/minimal-maintenance.js:7`: replaced the bare "Host-neutral:
  everything it needs arrives in the context object" with a note that
  `engine/**` as a whole still reads `OPENCLAW_HOME`/`OPENCLAW_CONFIG_PATH`
  from `process.env` in `assemble-prompt-context.js` and
  `plur1bus-command.js` — a faithful move of existing behaviour, not new
  coupling. Code untouched (checked with `git diff` — comment-only).
- `docs/engine-api.md` (the "What is implemented in M1a" → module-layout
  paragraph, formerly lines ~89-93): added the same caveat about the eight
  `process.env` reads.
- No `engine/**` file now spells `api.` in a comment (verified: `npm run
  lint`'s `lint-engine-imports` step passed after the edit).

### 7. NIT — tests/golden-prefix.test.js:37
`>= 5` → `>= 7`; renamed the test to "covers at least seven scenarios".
Verified `SCENARIOS.length` is actually `7`.

### 8. NIT — tests/helpers/runtime-sources.js:105
"Repo-relative path of a runtime source" → "Absolute path of a runtime
source" (the JSDoc for `runtimeSourcePath`, which returns an absolute path).

### 9. NIT — scripts/lint-engine-imports.mjs:27-32
Corrected the comment-stripping claim: a multi-line block comment's
continuation line is only stripped when it starts with `*`; one that doesn't
is scanned as code, which is a loud false positive, not a silent miss (the
previous wording implied all block comments were fully removed).

### 10. NIT — docs/engine-api.md:99
- Added "declared in the contract (`types/engine.d.ts:421`), not
  implemented" to the `createEngine()` sentence (verified line 421 is
  `export declare function createEngine(host: HostServices, config:
  EngineConfig): Engine;`).
- Added a bullet under "What is implemented in M1a" for the test-internal
  `recallTimingSink` / `api.__recallTimingSinkForTests` context key,
  matching `tests/engine-assemble-prompt-context.test.js`'s existing
  assertions about it being null/no-op for every real host.

### 11. NIT — lib/platform.js securePath JSDoc
Added: `fd` is POSIX-only and ignored on win32 (there is no
`fchmod`-equivalent ACL call, so `icacls` always re-resolves by path); named
`lib/shared-memory-migration.js:216` as the caller this matters for
(confirmed it passes both `fd` and `tempPath` to `securePath`).

### 12. Optional — delete `.gitkeep` files
`git rm engine/.gitkeep adapter/openclaw/.gitkeep`. Both directories are
populated; no test or doc referenced either file (checked with grep).

## Verification

### Lint
```
$ PATH=/home/claude/.node24/bin:$PATH npm run lint
lint-no-api-outside-adapter: clean
lint-engine-imports: clean (14 module(s))
```
Exit 0.

### Individually run test files (all green)
```
tests/llm-result-cache-integration.test.js  — tests 22, pass 22, fail 0
tests/lint-no-api-outside-adapter.test.js   — tests 3,  pass 3,  fail 0
tests/lint-engine-imports.test.js           — tests 17, pass 17, fail 0
tests/golden-prefix.test.js                 — tests 9,  pass 9,  fail 0
tests/deploy-integrity.test.js              — tests 33, pass 33, fail 0
tests/config-docs-contract.test.js          — tests 4,  pass 4,  fail 0
tests/engine-assemble-prompt-context.test.js— tests 8,  pass 8,  fail 0
tests/adapter-register-commands.test.js     — tests 5,  pass 5,  fail 0
```
Also checked (via grep) for any test that greps `.gitkeep`, `mkdtempSync`/
`tmpdir` conventions, or the README/register-gateway.js docblock text — none
assert on that prose, only `tests/adapter-register-gateway.test.js` and
`tests/llm-result-cache-lifecycle.test.js` reference `register-gateway.js`
by path (import/comment only, not content).

### Full suite (background run, ~7.8 min)
```
$ PATH=/home/claude/.node24/bin:$PATH npm test
...
ℹ tests 5225
ℹ suites 930
ℹ pass 5222
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 466735.289047
```
Matches the accepted baseline (`fail 0`, `skipped 3`).

### Diff-scope check
```
$ git diff --stat 0c5e3f69..HEAD -- '*.js' '*.mjs'
 adapter/openclaw/register-gateway.js       | 27 ++++++++------
 engine/recall/minimal-maintenance.js       |  7 +++-
 lib/platform.js                            |  7 +++-
 scripts/lint-engine-imports.mjs            | 15 +++++---
 scripts/lint-no-api-outside-adapter.mjs    | 10 ++++--
 tests/golden-prefix.test.js                |  4 +--
 tests/helpers/runtime-sources.js           |  2 +-
 tests/lint-no-api-outside-adapter.test.js  | 57 ++++++++++++++++++++----------
 tests/llm-result-cache-integration.test.js |  2 ++
 9 files changed, 91 insertions(+), 40 deletions(-)
```
Only `scripts/lint-no-api-outside-adapter.mjs`, test files, and the three
comment-only files named in the task. `git diff --stat 0c5e3f69..HEAD --
.github` is empty — `.github/` untouched. `git diff -- engine/recall/
minimal-maintenance.js lib/platform.js adapter/openclaw/register-gateway.js`
confirms all three are comment-only (no statement, import or logic line
touched).

## Commits
- `f9b88635` — `test: close the review gaps in the source guards and lint
  fixtures` (items 2, 3, 7, 8, 9)
- `cba055de` — `docs: correct the M1a review findings in changelog, READMEs
  and docblocks` (items 1, 4, 5, 6, 10, 11, 12)

## Notes / things I could not fully verify
- The `register-commands.js:122`/`:377` citations in
  `adapter/openclaw/README.md`'s "four one-line delegations" row point at the
  wrapping `if (typeof api.registerGatewayMethod ...)` line rather than the
  delegation call itself (off by 1, e.g. actual call is at line 123 not
  122). This predates the fix wave and item 4's scope was specifically
  `index.js` line numbers, so I left it alone; flagging here in case the
  owner wants it tightened too.
- `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md` is untracked
  in the worktree from before this session started; I left it untouched and
  did not commit it (not part of the fix wave).

## Status: DONE
