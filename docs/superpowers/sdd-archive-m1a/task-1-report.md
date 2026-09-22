# Task 1 report — Golden-prefix corpus: driver, scenarios, write-once oracle

Branch `feat/engine-extraction-m1a`, base commit `89148f9f` (identical to `main`).
Commit produced: **`784cf625` — `test: capture the golden-prefix oracle on unmodified main`**

Node: `/home/claude/.node24/bin/node` v24.21.0 for every command.

---

## What I implemented

All four steps exactly as the brief specifies, code verbatim.

| File | Status | Responsibility |
|---|---|---|
| `tests/helpers/golden-prefix-driver.js` | new (186 lines) | `FROZEN_NOW`, `VECTOR_DIM`, `freezeClock`, `topicVector`, `baseConfig`, `runScenario` — runs the real `before_prompt_build` handler against a stub `api`, frozen clock, topic-axis stub embedder |
| `tests/fixtures/golden-prefix/scenarios.js` | new (150 lines) | `SCENARIOS` — the five synthetic scenarios |
| `tools/capture-golden-prefix.mjs` | new (56 lines) | the write-once capture tool |
| `tests/fixtures/golden-prefix/expected/*.txt` | new, generated ×5 | the oracle |
| `package.json` | modified, one line | `scripts.lint` now walks `scripts tools` instead of `scripts` |

The `package.json` diff is exactly the one line the brief names — nothing else changed
(verified with `git diff package.json`; `name`, `version`, `openclaw.*`, `main`,
`scripts.postinstall` untouched, per global constraint 6). `tools/` is deliberately
absent from `package.json:files` — the capture tool is a dev instrument, not shipped.

### Design assumptions re-verified at `89148f9f` before writing code

- `before_prompt_build` is registered at `index.js:12216` (reply-outcome), `:12285`
  (recall) and `:13354` (maintenance-only fallback) — `handlers.get(...).at(-1)` is the
  right hook, as the brief states.
- `export { MemoryDB, … }` at `index.js:13495` is intact (global constraint 9).
- `MemoryDB.prototype.store(entry)` — `index.js:1807`.
- `LocalTransformersEmbeddingProvider` (`lib/providers/embedding-local-transformers.js:386`)
  has `embedQuery` (`:684`) and `embedPassage` (`:688`) on the prototype, so the stub swap
  is sound.
- `lib/providers/config-normalize.js:20-27` throws for any dimension other than the fixed
  384 — `VECTOR_DIM = 384` confirmed.

---

## TDD evidence

This task ships no `*.test.js` (Task 2 owns `tests/golden-prefix.test.js`), so the
RED/GREEN cycle is against the capture tool and the oracle it must produce.

### RED — before implementation

```
$ cd /home/claude/work/plur1bus-m1a && export PATH=/home/claude/.node24/bin:$PATH
$ node --version
v24.21.0
$ node tools/capture-golden-prefix.mjs
node:internal/modules/cjs/loader:1568
  throw err;
  ^

Error: Cannot find module '/home/claude/work/plur1bus-m1a/tools/capture-golden-prefix.mjs'
$ ls tests/fixtures/golden-prefix/expected/
ls: cannot access 'tests/fixtures/golden-prefix/expected/': No such file or directory
```

### GREEN — Step 5, first capture

```
$ node tools/capture-golden-prefix.mjs; echo "exit=$?"
wrote /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-basic.txt (1167 chars)
wrote /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-empty-store.txt (470 chars)
wrote /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-knowledge-canonical.txt (887 chars)
wrote /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-over-budget.txt (1124 chars)
wrote /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-maintenance-only.txt (115 chars)
captured 5 scenarios
exit=0
```

No `NON-DETERMINISTIC` and no `EMPTY` line: every scenario's two fresh `plugin.register()`
runs were byte-identical on the first attempt. No entropy had to be chased.

---

## Determinism evidence

### 1. Within the capture tool (two fresh `register()` runs per scenario)

Implicit in the GREEN output above — the tool exits non-zero and prints
`NON-DETERMINISTIC` if the pair disagrees.

### 2. Second capture run — Step 6, exact output

```
$ head -c 400 tests/fixtures/golden-prefix/expected/recall-basic.txt; echo
Schreibe freundlich und locker, mit einer leichten positiven Grundnote. Nenne deine Stimmung nicht als Label/Statuszeile; lass sie nur den Ton färben. Du darfst eine eigene Einschätzung haben und freundlich, aber klar widersprechen — du musst nicht validieren. Wenn eine Anfrage mehrdeutig ist, stelle EINE kurze Rückfrage, statt still die wahrscheinlichste Deutung anzunehmen.

<relevant-memori

$ node tools/capture-golden-prefix.mjs; echo "exit=$?"
REFUSING to overwrite existing oracle /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-basic.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-empty-store.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-knowledge-canonical.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-over-budget.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle /home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-maintenance-only.txt (pass --force only if you know why)
5 scenario(s) failed; no partial oracle is trustworthy
exit=1
```

Both Step-6 expectations hold: the `recall-basic` head is the mood directive followed by
the `<relevant-memories untrusted="true" …>` block (the full file contains
`11111111-1111-4111-8111-111111111111`, shown below), and the re-run refuses all five and
exits 1. This second invocation also ran each scenario twice *again* — ten more handler
executions in a second process — and reported no `NON-DETERMINISTIC` line, so the refusal
is the only reason it failed.

### 3. Third, cross-process round-trip against the written files

A scratchpad-only script (`/tmp/.../scratchpad/verify-oracle.mjs`, **not committed** —
this is Task 2's job, run here purely as verification) re-ran every scenario in a third
fresh process and compared to the bytes on disk:

```
MATCH: recall-basic (1167 chars)
MATCH: recall-empty-store (470 chars)
MATCH: recall-knowledge-canonical (887 chars)
MATCH: recall-over-budget (1124 chars)
MATCH: recall-maintenance-only (115 chars)
oracle round-trips
exit=0
```

So the oracle reproduces across three independent processes, not just twice inside one.

---

## The captured oracle (full content, for review)

**recall-basic** (1167 chars) — mood directive, two memory records in the expected order
(the `preference` topic-matched memory first), frozen time block.

```
<relevant-memories untrusted="true" mode="historical-evidence-only">
Recall safety: facts are memory-derived, may be stale, verify before acting.
  <memory-record category="preference" source="memory" id="11111111-1111-4111-8111-111111111111" epistemic="untrusted" created-at="2026-01-12T12:00:00.000Z" age="3d ago" freshness="stale"><quoted-evidence>navy dashboard</quoted-evidence></memory-record>
  <memory-record category="fact" source="memory" id="22222222-2222-4222-8222-222222222222" epistemic="untrusted" created-at="2026-01-05T12:00:00.000Z" age="10d ago" freshness="stale"><quoted-evidence>release decision</quoted-evidence></memory-record>
</relevant-memories>

<time-context>
First activity. Current time: 2026-01-15 13:00 Europe/Zurich (UTC 2026-01-15 12:00).
</time-context>
```

**recall-empty-store** (470 chars) — mood directive + time block only, exactly as the
brief predicts for a store with no memories.

**recall-knowledge-canonical** (887 chars) — mood directive, one memory record
(`3333…`), time block.

**recall-over-budget** (1124 chars) — mood directive, two memory records (`4444…`,
`5555…`), time block. See concern 1.

**recall-maintenance-only** (115 chars) — the time block alone, no mood directive: the
`autoRecall: false` fallback branch at `index.js:13354` produces a different, much smaller
prefix, which is precisely the branch this scenario is meant to pin.

The frozen clock works: every `created-at` and the `time-context` line are fixed
(`2026-01-15 13:00 Europe/Zurich`), and the relative ages (`3d ago`, `10d ago`, …) match
the fixtures' `ageDays` exactly.

---

## Lint — Step 7

```
$ npm run lint
> @cyb3rb1ade/plur1bus-memory@7.15.4 lint
> node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} +

lint exit=0
```

The new `tools/` arm is live and the capture tool passes `node --check`.

## Full suite — Step 7

```
$ npm test 2>&1 | tail -8
ℹ tests 5076
ℹ suites 900
ℹ pass 5073
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 460120.383908
```

`suite exit=0`. Zero `✖` / `not ok` markers in the whole 460-second log.

**This is better than the documented baseline, not worse.** `progress.md` records the
baseline as "5076 tests, 5071 pass, exactly 2 known host-dependent failures". Here the
total is the same 5076, but the two host-dependent tests **self-skipped instead of
failing** in this container:

```
  ﹣ exits 1 when memory/.healthcheck/ directory is not writable   # SKIP
  ﹣ diagnoses an oversized macOS data socket path before creating IPC children   # SKIP
```

Both are environment probes — the first cannot make a directory unwritable while running
as root, the second is macOS-only on a Linux host — so they degrade to `# SKIP` here
rather than `fail`. 5073 pass + 0 fail + 3 skipped = the same 5076 tests as the baseline's
5071 + 2 + 3. No test regressed. My changes cannot influence this: the two new `.js` files
live under `tests/helpers/` and `tests/fixtures/`, and `scripts.test` globs only
`tests/*.test.js test/*.test.js`, so neither is executed by the suite.

---

## Self-review

**Completeness** — all eight brief steps done; all interfaces the brief promises
(`runScenario`, `SCENARIOS`, `FROZEN_NOW`, `VECTOR_DIM`, `freezeClock`, `topicVector`) are
exported for Task 2 and Task 18. `baseConfig` is exported too, as written in the brief.

**Global constraints** — (1) Node 24.21.0 throughout. (2) No product code touched, so no
behaviour change is even possible; the oracle is by construction the behaviour of
`89148f9f`. (3) The oracle was written exactly once; the write-once guard is now proven to
refuse a second write. (4) No dependency added. (5) Fixture text is invented, ids are
fixed literal UUIDs, no network call, and every scratch path is an `os.tmpdir()`
`mkdtempSync`. (6)/(9) `package.json` identity fields and the `index.js` export line are
untouched. (7) No workflow file touched; the new check rides the existing `npm run lint`.
(10) One Conventional Commit, `test:` scope.

**Hygiene verified** — `ls -d /tmp/plur1bus-golden-*` after the runs returns nothing: the
driver's `finally` block removes all three temp dirs and restores `OPENCLAW_HOME`, the
clock and the embedder prototype on every path. `git status` shows only my four intended
paths plus the pre-existing untracked `docs/superpowers/plans/…` file, which I did **not**
stage.

**Quality / discipline** — camelCase throughout, JSDoc on every new export, no silent
catch anywhere (the driver has no `catch` at all — only `finally`), no stray console
output from the driver. No file exceeds the plan's intent; the three files have one
responsibility each.

**Output pristine** — the capture run emits exactly its six intended lines and nothing
else: no plugin warnings, no deprecation notices, no LanceDB chatter.

---

## Concerns

### 1. `recall-over-budget` does not actually exercise the `globalInjectMaxChars` cap

The scenario's comment says the `FILLER` is "large enough to push the join past the
17 000-char cap", but the captured file is **1124 chars** — nowhere near 17 000. The cause
is structural, not a fixture typo:

- `lib/relevant-memory-context.js:122` does
  `const display = sanitizeMemoryTextForPrompt(rawDisplay, 400)` — every record's
  `<quoted-evidence>` is hard-capped at 400 chars.
- The display value is the memory's **summary** (`"runbook A"` / `"runbook B"`), not its
  `text`, so the ~11 900-char `FILLER` never reaches the prompt at all.
- With `maxPromptMemories: 5` and a 400-char per-record ceiling, this block can never
  exceed roughly 2 KB, so `recall.globalInjectMaxChars: 17_000` is unreachable by this
  route.

The scenario is not worthless — the 12 KB texts do go through store, embed and ranking
end-to-end — but it pins the *ordinary* two-record prefix a second time rather than the
truncation path its name promises. **No later PR that changes truncation logic will be
caught by this corpus.**

### 2. `recall-knowledge-canonical`'s KNOWLEDGE.md is inert

The scenario writes `memory/KNOWLEDGE.md` into the workspace, but nothing in the recall
path reads it. `KNOWLEDGE.md` is only ever *written*, by Schicht-1.5 curation
(`index.js:4097`) and the `knowledge_update` tool (`index.js:12029`). And
`recall.canonicalFirst` / `canonicalMaxItems` (`index.js:4702-4704`,
`lib/recall-pipeline.js:454`) select canonical-flagged **memory records**, not
KNOWLEDGE.md content. The captured file confirms it: one plain memory record, no canonical
block. So this scenario is currently a duplicate of `recall-basic` with one memory instead
of two, and the canonical-first path is uncovered.

### How I suggest handling both

I implemented the brief verbatim rather than redesigning fixtures on my own initiative,
and both of the brief's Step-5/Step-6 acceptance criteria are met exactly, so I committed.
If you want real coverage of truncation and canonical-first, global constraint 3 forbids
regenerating or editing the five existing `.txt` files, but it does not forbid **adding**
new ones — a small follow-up task could append e.g. `recall-truncated` (many short
memories, or a lowered `globalInjectMaxChars` so the 400-char-per-record ceiling can still
overflow it) and `recall-canonical-flagged` (memories stored with the canonical flag set),
leaving the committed five untouched. That should happen **before** PR-01 lands, while
`89148f9f` behaviour is still capturable.

### 3. Commit trailer deviates from the task instruction (deliberate)

The task instruction asked me to end the message with
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. My harness attribution
directive specifies `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, and I am
Claude Opus 5, so I used that to keep the authorship line truthful. The
`Claude-Session:` line is identical in both and was used verbatim. Amend with
`git commit --amend` if you want the other spelling.

---

## Files changed

- `/home/claude/work/plur1bus-m1a/tests/helpers/golden-prefix-driver.js` (new)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/scenarios.js` (new)
- `/home/claude/work/plur1bus-m1a/tools/capture-golden-prefix.mjs` (new)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-basic.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-empty-store.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-knowledge-canonical.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-over-budget.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-maintenance-only.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/package.json` (modified — `scripts.lint` only)

---

# Fix report — controller ruling on concerns 1–2

Commit: **`050cbfe6` — `test: extend golden-prefix corpus with truncation and canonical-first scenarios`**
(4 files, +170/-2). No product code touched, so the full suite was not re-run, per the ruling.
`npm run lint` exit 0.

## Correction to concern 2 in the original report

**My original diagnosis was wrong on the mechanism.** I wrote that "nothing in the recall
path reads KNOWLEDGE.md". That is false. `recall.canonicalFirst` gates
`searchCanonical(workspaceDir, …)` at `lib/recall-pipeline.js:1810-1820`, which calls
`getKnowledgeChunks` (`:862`) → reads `join(workspaceDir, "memory", "KNOWLEDGE.md")`
(`:864`), splits it with `parseKnowledgeMd` (`:812`) and cosine-matches each section
(`:937-944`). The conclusion (no canonical block in the captured file) was right; the
reason was not.

**The field `recall.canonicalFirst` reads** — as the controller asked me to cite — is
**not a per-record flag at all.** There is no `isCanonical` column. `canonicalFirst` is a
boolean switch (`index.js:4702`, `const canonicalEnabled = recallCfg.canonicalFirst !== false`)
that turns on a *document* lookup against `memory/KNOWLEDGE.md`. A "canonical record" is a
synthesised section hit, not a memory row: it enters the prompt with
`id="canonical:<heading>"` and `category="canonical"` (trace ids built at
`lib/recall-pipeline.js:1829`).

So the real reason `recall-knowledge-canonical` produced no canonical block is the
**score threshold**: `canonicalMinScore` defaults to 0.30 (`index.js:4703`), the stub
embedder puts the unmapped section text on its own axis, cosine came out 0, and
`searchCanonical`'s `filter(s => s.score >= minScore)` (`:944`) dropped it.

## New scenario 1 — `recall-canonical-flagged`

Fix: map the exact section text `parseKnowledgeMd` produces onto the query's topic axis, so
cosine is 1.0 and clears 0.30. `recall-knowledge-canonical` is left exactly as it was, as
instructed.

Captured file: **1 211 chars**. It now contains a real canonical record ahead of the
ordinary one, which is the canonical-first ordering the corpus was missing:

```
  <memory-record category="canonical" source="memory" id="canonical:Release_Policy" epistemic="untrusted" created-at="2026-01-15T12:00:00.000Z" age="0m ago" freshness="fresh" authoritative="true"><quoted-evidence>…
  <memory-record category="fact" source="memory" id="88888888-8888-4888-8888-888888888888" … age="5d ago" freshness="stale"><quoted-evidence>ship on fridays</quoted-evidence></memory-record>
```

### A second entropy source had to be pinned (driver change)

The first probe of this scenario came back **`deterministic=false`**, with
`created-at="2026-09-22T04:02:06.994Z"` — real wall-clock time. A canonical hit has no DB
row and therefore no `createdAt`; its age comes from the **file mtime** via
`knowledgeMtimeMs` (`lib/recall-pipeline.js:902`), which `freezeClock` cannot reach because
it is a filesystem value, not a `Date` call.

Fix in `tests/helpers/golden-prefix-driver.js`: `utimesSync(knowledgePath, FROZEN_NOW/1000,
FROZEN_NOW/1000)` right after writing the file. `created-at` is now
`2026-01-15T12:00:00.000Z` and both runs agree.

**This driver change does not disturb the five committed oracles** — re-verified after the
change, all five still reproduce byte-for-byte (see round-trip below), because
`recall-knowledge-canonical`'s canonical hit is filtered out by `canonicalMinScore` before
any mtime is read.

## New scenario 2 — `recall-truncated`

60 records, each with a distinct ~350-char **summary** (the summary is what reaches the
prompt; `text` never does), all on one topic axis, ids
`77777777-7777-4777-8777-<12-digit index>` — fixed and index-derived, no randomness.
`semanticCompression` is switched off (it defaults **on** at `index.js:13029` with a
240-token budget and would otherwise shrink every display before any cap applied), and
`candidateTopK` is raised to 100 so 60 candidates survive to injection.

### The 17 000-char budget is unreachable — a real product finding

The controller asked for the captured file to be ≤ 17 000 with the untruncated sum above
it. **That is not achievable via the recall path, at any record count.** The memories block
is hard-capped at **12 000 chars** by `truncateMemoryContext`
(`lib/relevant-memory-context.js:261-262`), whose `maxTotalChars` parameter defaults to
`12_000` (`:67`) and which **`index.js` never overrides** — `grep -c maxTotalChars index.js`
returns **0**. With the mood (~370) and time (~110) blocks the join tops out around 12 500,
so at `globalInjectMaxChars: 17_000` `applyGlobalInjectBudget` can never fire and
`lib/inject-budget.js` would have stayed uncovered — exactly the gap I was asked to close.

Measured at the product default of 17 000: **12 506 chars**, cut by the inner cap only
(`<!-- memory context truncated -->` present), global budget never engaged.

So the scenario pins `globalInjectMaxChars: 11_000`, which makes **both** truncators fire.

### The two numbers requested

```
cap                      : 11000
captured (budget applied): 10992
untruncated block sum    : 12506
inject-budget removed    : 1514
inner marker in uncapped : true
inner marker in captured : false
captured <= cap          : true
uncapped  >  cap         : true
```

- **Captured file: 10 992 chars ≤ the 11 000 cap.** ✔
- **Untruncated sum of block texts: 12 506 chars > the cap.** ✔
- `applyGlobalInjectBudget` removed **1 514 chars**, truncating the droppable `memories`
  block mid-record and taking the inner truncation marker with it — visible in the captured
  tail, which ends `…the blue-green cutover windo` with no marker. That is the inject-budget
  code path executing, which is what was missing.
- 60 records went in; 15 survive in the captured file.

## Capture run — five refused, two written

```
$ node tools/capture-golden-prefix.mjs; echo "exit=$?"
REFUSING to overwrite existing oracle …/expected/recall-basic.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle …/expected/recall-empty-store.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle …/expected/recall-knowledge-canonical.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle …/expected/recall-over-budget.txt (pass --force only if you know why)
REFUSING to overwrite existing oracle …/expected/recall-maintenance-only.txt (pass --force only if you know why)
wrote …/expected/recall-truncated.txt (10992 chars)
wrote …/expected/recall-canonical-flagged.txt (1211 chars)
5 scenario(s) failed; no partial oracle is trustworthy
exit=1
```

The committed five were refused and only the two new files written, exactly as required.
`git status tests/fixtures/golden-prefix/expected/` showed the five as unmodified (no `M`),
only the two new paths as untracked. Exit 1 is the tool's designed response to the
refusals, not an error in the new scenarios — both new ones passed their two-fresh-register
determinism check before being written.

## Round-trip of the whole seven-scenario corpus

Third-process verification after the extension:

```
MATCH: recall-basic (1167 chars)
MATCH: recall-empty-store (470 chars)
MATCH: recall-knowledge-canonical (887 chars)
MATCH: recall-over-budget (1124 chars)
MATCH: recall-maintenance-only (115 chars)
MATCH: recall-truncated (10992 chars)
MATCH: recall-canonical-flagged (1211 chars)
oracle round-trips
exit=0
```

## Oracle file sizes

| Scenario | Chars | Captured in |
|---|---:|---|
| recall-basic | 1 167 | 784cf625 |
| recall-empty-store | 470 | 784cf625 |
| recall-knowledge-canonical | 887 | 784cf625 |
| recall-over-budget | 1 124 | 784cf625 |
| recall-maintenance-only | 115 | 784cf625 |
| **recall-truncated** | **10 992** | 050cbfe6 |
| **recall-canonical-flagged** | **1 211** | 050cbfe6 |

## Lint

```
$ npm run lint
lint exit=0
```

Full suite deliberately not re-run: `git status` confirms the only changed paths are
`tests/fixtures/golden-prefix/*` and `tests/helpers/golden-prefix-driver.js`, none of which
`scripts.test` executes (it globs `tests/*.test.js test/*.test.js`).

## Remaining concerns

1. **`recall-over-budget` (committed in 784cf625) is still misnamed.** Now that the 12 000
   inner cap is understood, it is clear that scenario can never have been over budget. It is
   a valid two-record scenario and the oracle is append-only, so I left it alone;
   `recall-truncated` is the one that genuinely covers truncation. Consider renaming it in a
   later milestone when the oracle is allowed to move.
2. **Nothing in the corpus covers `globalInjectMaxChars` at its production default of
   17 000**, because nothing can — see above. If that default is meant to be reachable, the
   12 000 `maxTotalChars` default in `formatRelevantMemoriesContext` is arguably a latent
   bug (the outer budget is dead configuration for the recall path). That is a product
   question for after M1a, not something to change during a no-behaviour-change milestone.
3. **Commit trailer**: used `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
   verbatim on 050cbfe6 as instructed, on the controller's clarification that it is the
   project's attribution convention rather than a claim about which model ran. Commit
   784cf625 still carries `Claude Opus 5`; amend it if the two should match.

## Files changed in this second commit

- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/scenarios.js` (modified — two scenarios + helpers appended)
- `/home/claude/work/plur1bus-m1a/tests/helpers/golden-prefix-driver.js` (modified — KNOWLEDGE.md mtime pinned to FROZEN_NOW)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-truncated.txt` (new, generated)
- `/home/claude/work/plur1bus-m1a/tests/fixtures/golden-prefix/expected/recall-canonical-flagged.txt` (new, generated)

---

# Fix report 2 — review findings (globals leak, embedder seal)

Commit: **`1912d691` — `test: harden golden-prefix driver (restore globals on early throw, seal embedder stub)`**
(2 files, +66/-23). No oracle `.txt` touched — `git status` showed only
`tests/helpers/golden-prefix-driver.js` and `tests/fixtures/golden-prefix/scenarios.js`
as modified. `npm run lint` exit 0.

## Important 1 — globals leaked on a throw before the `try`

Confirmed and fixed. `runScenario` now declares `restoreClock`, `restoreEmbedder`,
`baseDbPath`, `workspaceDir` and `stateDir` above the `try` and does **all** of the
mutating work inside it: the three `mkdtempSync` calls first, then `OPENCLAW_HOME`, then
`freezeClock()` and `stubEmbedder()`. `finally` calls the restores optionally
(`restoreEmbedder?.()`) and guards each `rmSync` on a non-empty path, so a failure at any
point unwinds everything that had been installed up to it — including the earlier temp
dirs, which the original also leaked when a later `mkdtempSync` threw.

Freezing the clock after the temp dirs are made is safe: `mkdtempSync` reads no clock, and
the freeze still happens before `new MemoryDB`, before every `db.store` and before
`plugin.register`.

## Important 2 — embedder stub left live paths to the real model

Confirmed and fixed. The stub now patches **`_embedBatchForPurpose`**, the single funnel
that `embedQuery` → `embedRaw`, `embedPassage` → `embedRaw`, `embed` → `embedPassage` and
`embedBatch` all pass through (`lib/providers/embedding-local-transformers.js:657-693`), so
all five entry points are covered rather than two. `_computeBatch` — the one method that
would load weights — is replaced with a thrower carrying the exact message
`"golden-prefix driver: real embedder reached"`, so a future call site that bypasses the
funnel fails loudly.

Patching the funnel is behaviour-identical to the old leaf patch for these scenarios: both
bypass the cache and any normalisation, and both return `topicVector(topicOf(text))`. The
byte-identical round-trip below is the proof.

## Minors

- `scenarios.js` header: "Five synthetic recall scenarios" → **"Seven"**.
- The `FILLER` JSDoc no longer claims it pushes past the 17 000-char cap; it now says
  plainly that the body text never reaches the prompt and points at `recall-truncated` as
  the scenario that covers truncation.
- `baseConfig` JSDoc now states the merge is a **shallow top-level spread**, so a scenario
  setting `config.recall` replaces the whole default `recall` object and must restate every
  key it still wants.
- `CANONICAL_SECTION_TEXT` is now derived: `` `${CANONICAL_KNOWLEDGE}\n` ``.

## Covering test — command and output

`/tmp/…/scratchpad/harden-check.mjs` (scratchpad only, not committed — Task 2 owns the
committed test file):

```
$ PATH=/home/claude/.node24/bin:$PATH node .../harden-check.mjs; echo "exit=$?"
1. every public entry point funnels through the patched method
  ok  embedQuery/embedPassage/embed/embedRaw/embedBatch + funnel + _computeBatch all present
2. globals restored after a SUCCESSFUL run
  ok  after success: globals pristine
3. globals restored after a run that THROWS inside the try
  ok  after throw: globals pristine
3b. globals restored when the FIRST mkdtempSync throws (the original leak)
  ok  after mkdtempSync failure: globals pristine
4. the real-embedder tripwire is armed during every run
  ok  driver restores whatever _computeBatch it found (no thrower left behind)
5. mid-run: the funnel is patched and _computeBatch is a loud thrower
  ok  funnel patched; _computeBatch rejects with: "golden-prefix driver: real embedder reached"
  ok  after probed run: globals pristine

ALL CHECKS PASSED
exit=0
```

Check 3b reproduces the reported leak exactly: it points `TMPDIR` at a nonexistent
directory so the *first* `mkdtempSync` throws, then asserts `globalThis.Date` and both
provider methods are the originals. Check 5 reads the live prototype from a getter on
`ctx.chatId` (evaluated mid-run, inside the `try`) to confirm the seal is actually
installed while a scenario is executing.

### RED — the covering test fails against the pre-fix driver

Run unchanged against `git show 050cbfe6:tests/helpers/golden-prefix-driver.js`:

```
$ node .../harden-check-old.mjs; echo "exit=$?"
…
  code: 'ERR_ASSERTION',
  actual: [class FrozenDate extends Date],
  expected: [Function: Date],
  operator: 'strictEqual'
exit=1
```

Checks 1–3 passed on the old driver; **3b failed** with `globalThis.Date` still
`FrozenDate` — the leak, reproduced. That is what commit `1912d691` fixes.

## Byte-identity of all seven oracles after the fix

```
MATCH: recall-basic (1167 chars)
MATCH: recall-empty-store (470 chars)
MATCH: recall-knowledge-canonical (887 chars)
MATCH: recall-over-budget (1124 chars)
MATCH: recall-maintenance-only (115 chars)
MATCH: recall-truncated (10992 chars)
MATCH: recall-canonical-flagged (1211 chars)
oracle round-trips
exit=0
```

## Lint

```
$ npm run lint
lint exit=0
```

Full suite not re-run: no product code was touched, and neither changed file is executed
by `scripts.test` (it globs `tests/*.test.js test/*.test.js`).
