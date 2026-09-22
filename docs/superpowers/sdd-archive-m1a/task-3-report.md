# Task 3 report — Freeze the engine contract (`types/engine.d.ts`, `npm run typecheck`)

**Status:** complete, all gates green.
**Commit:** `e7011635` — `types: freeze the engine contract at 1.0.0 and add npm run typecheck`
**Base:** `dac74652` (Task 2)
**Worktree:** `/home/claude/work/plur1bus-m1a`

---

## 1. What was done

Steps 1–9 of `task-3-brief.md` were implemented verbatim, plus two repo-invariant
follow-ups the brief did not list (§3).

### Files created (brief, verbatim)

| Path | Notes |
|---|---|
| `/home/claude/work/plur1bus-m1a/types/engine.d.ts` | 406 lines. The frozen contract, contract version `"1.0.0"`, copied byte-for-byte from the brief's Step 1 block. All 18 named types the brief's *Interfaces* section promises are exported. |
| `/home/claude/work/plur1bus-m1a/types/engine.conformance.ts` | 69 lines. Compile-only `Exact<>`/`assertTrue<>` assertions for the four B8 decisions plus the six-block shape, the mandatory `signal` on `RecallQuery`/`TurnRecord`, the `JobRun.outcome` union and a minimal `HostServices` literal. Copied verbatim. |
| `/home/claude/work/plur1bus-m1a/tsconfig.json` | Verbatim. `lib: ["ES2023","DOM"]` (DOM supplies `AbortSignal` without `@types/node` — Global Constraint 4), `types: []`, `strict`, `noEmit`, `include: ["types/**/*.ts"]`. |
| `/home/claude/work/plur1bus-m1a/scripts/typecheck.mjs` | Verbatim. Resolves `node_modules/.bin/tsc`, prints a plain message (exit 1) when TypeScript is absent, downgraded to a warning (exit 0) under `PLUR1BUS_TYPECHECK_OPTIONAL=1`. |

### Files modified

| Path | Change |
|---|---|
| `/home/claude/work/plur1bus-m1a/package.json` | Exactly the three changes the brief allows: `"types/"` added to `files` immediately after `"scripts/"`; `"typecheck": "node scripts/typecheck.mjs"` added to `scripts`; `scripts.lint` extended with `&& node scripts/typecheck.mjs`. No `"types"` field was added (deliberate — the `.d.ts` describes the future engine, not today's `index.js`). `name`, `version`, `main`, `openclaw.*`, `postinstall` untouched (Global Constraint 6). |
| `/home/claude/work/plur1bus-m1a/.gitignore` | **Not in the brief.** Added `!scripts/typecheck.mjs`. See §3. |
| `/home/claude/work/plur1bus-m1a/scripts/lib/deploy-integrity.mjs` | **Not in the brief.** Added `"scripts/typecheck.mjs"` to `DEPLOY_FILES`. See §3. |

No product code, no test, no fixture, no workflow and no dependency was touched.
`tests/fixtures/golden-prefix/expected/*.txt` is untouched (Global Constraint 3);
`typescript@^5.9.3` stays in `optionalDependencies` (Global Constraint 4);
`.github/workflows/*` untouched (Global Constraint 7).

---

## 2. Verification evidence

All commands run from `/home/claude/work/plur1bus-m1a` with
`PATH=/home/claude/.node24/bin:$PATH` (node v24.21.0).

### 2.1 GREEN — `npm run typecheck` (brief Step 6)

```
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"

> @cyb3rb1ade/plur1bus-memory@7.15.4 typecheck
> node scripts/typecheck.mjs

exit=0
```

No `tsc` diagnostics. Matches the brief's expectation exactly.

### 2.2 RED — deliberate contract drift proves the gate bites (brief Step 7)

Drift injected (`Principal.trust` forced back to ADR-002's rejected shape):

```
$ sed -i 's/  trust: "proved" | "inferred";/  trust: "transport";/' types/engine.d.ts
$ grep -n 'trust:' types/engine.d.ts
9: *   - `Principal.trust: "proved" | "inferred"`   (not `proof: "transport"`)
79:  trust: "transport";
```

```
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck 2>&1 | grep -v '^>'; echo "exit=${PIPESTATUS[0]}"
types/engine.conformance.ts(21,12): error TS2344: Type 'false' does not satisfy the constraint 'true'.
exit=2
```

This is the brief's predicted error, character for character, at the predicted
location (`types/engine.conformance.ts(21,12)` — the
`assertTrue<Exact<Principal["trust"], "proved" | "inferred">>()` line) with the
predicted exit code 2.

**Deviation from the brief's Step 7 restore command:** the brief restores with
`git checkout -- types/engine.d.ts 2>/dev/null || sed -i …`. At that point
`types/engine.d.ts` was still *untracked*, so `git checkout --` would have
errored (and, had it succeeded against a tracked path, would have deleted the
file). The `sed` fallback in the brief's own `||` branch was used instead:

```
$ sed -i 's/  trust: "transport";/  trust: "proved" | "inferred";/' types/engine.d.ts
$ grep -n '^  trust:' types/engine.d.ts
79:  trust: "proved" | "inferred";
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"
exit=0
```

The round trip is byte-neutral (one line out, the identical line back in); the
committed `types/engine.d.ts` is the brief's Step 1 text unchanged.

### 2.3 GREEN — `npm run lint` (brief Step 8)

```
$ PATH=/home/claude/.node24/bin:$PATH npm run lint; echo "lint_exit=$?"

> @cyb3rb1ade/plur1bus-memory@7.15.4 lint
> node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs

lint_exit=0
```

CI's existing `lint` job therefore runs the typecheck with no workflow edit
(Global Constraint 7). Re-run after the commit: `lint_exit=0`.

### 2.4 GREEN — golden-prefix byte identity (brief Step 8)

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
  ✔ recall-over-budget produces the recorded prependContext byte for byte (74.413718ms)
  ✔ recall-maintenance-only produces the recorded prependContext byte for byte (38.530841ms)
  ✔ recall-truncated produces the recorded prependContext byte for byte (671.238999ms)
  ✔ recall-canonical-flagged produces the recorded prependContext byte for byte (47.784666ms)
  ✔ is deterministic across two fresh registrations (117.205715ms)
  ✔ covers at least five scenarios (0.714922ms)
✔ golden prefix corpus (1241.001257ms)
ℹ tests 9
ℹ suites 1
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 1619.902349
golden_exit=0
```

Note: the brief predicted `pass 7`; `node --test` counts the seven leaf tests
plus the enclosing suite and the file, hence 9. `fail 0` is the invariant that
matters and it holds. All seven oracle files are untouched.

### 2.5 Full suite — run 1 (RED, one failure) and run 2 (GREEN)

**Run 1**, immediately after the four new files and the `package.json` edit:

```
$ PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test
suite_exit=1
ℹ tests 5085
ℹ suites 901
ℹ pass 5081
ℹ fail 1
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 430282.312175
```

The single failure was `tests/deploy-manifest-covers-shipped-scripts.test.js:42`:

```
    actual: [ 'scripts/typecheck.mjs' ],
    expected: [],
    operator: 'deepStrictEqual',
```

i.e. the repo's own standing rule — *"Wer ein Skript hinzufügt, muss es ins
Manifest aufnehmen"* — fired on the newly added script. Fixed as described in §3.

**Run 2**, after adding the manifest entry:

```
$ PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test
suite_exit=0
ℹ tests 5085
ℹ suites 901
ℹ pass 5082
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 430229.45002
```

**`fail 0, skipped 3` — the accepted container signature.** Global Constraint 2
satisfied: full suite at baseline *and* the golden corpus byte-identical.

The deploy-manifest test alone after the fix:

```
  ✔ jedes .mjs/.js unter scripts/ steht in DEPLOY_FILES (3.77869ms)
  ✔ scripts/ wird überhaupt ausgeliefert (sonst wäre der Test wirkungslos) (0.403064ms)
  ✔ DEPLOY_FILES enthält keine Einträge ohne Datei auf der Platte (0.827125ms)
ℹ pass 3  ℹ fail 0
```

---

## 3. Two additions the brief did not anticipate

Both are consequences of adding a file under `scripts/`, both are forced by
existing repo invariants, and neither touches behaviour.

**(a) `.gitignore` — `!scripts/typecheck.mjs`.** `.gitignore:31` is
`scripts/*`, with an explicit per-file allowlist below it
("scripts/ stays operator-local by default"). `git add scripts/typecheck.mjs`
was refused:

```
The following paths are ignored by one of your .gitignore files:
scripts/typecheck.mjs
```

Without the allowlist entry the script would never be committed, and the
committed `package.json` `lint` would reference a file absent from a fresh
clone — CI's `lint` job would fail on `MODULE_NOT_FOUND`. The entry was added
next to the other allowlisted `.mjs` helpers.

**(b) `scripts/lib/deploy-integrity.mjs` — `"scripts/typecheck.mjs"` in
`DEPLOY_FILES`.** Required by the failure in §2.5 run 1. `package.json.files`
ships `scripts/` wholesale, so the new script ships whether or not it is
listed; the manifest is what keeps a deployed copy in sync and checksummed
(`verify-plugin-deploy.mjs --repair`). Entry placed alphabetically between
`scripts/run-semantic-link-index-phase43c.mjs` and
`scripts/verify-plugin-deploy.mjs`. The manifest is data only — no code path,
no behaviour, and the test suite's other two manifest assertions
(no stale entries, `scripts/` still shipped) both still pass.

Both changes are named explicitly in the commit body.

---

## 4. Contract review — no unresolved ADR-002 conflict

The instruction was to stop and ask rather than invent a resolution if the
brief's `.d.ts` contradicted ADR-002 somewhere the brief itself does not
settle. It does not. ADR-002 is not on disk in this worktree; the project doc
`plans/2026-09-22-m1a-engine-extraction.md` was searched and carries the B8
decision table in full:

| Point | ADR-002 said | `engine-extraction.md` §b.2 said | B8 chose |
|---|---|---|---|
| Principal strength | `proof: "transport"` | `trust: "proved" \| "inferred"` | **`trust`** |
| Turn origin | one `TurnOrigin` object | string union + `AgentContext` | **union + `AgentContext`** |
| Capture | `Promise<CaptureResult>` | non-blocking handle | **`CaptureHandle`** |
| Degradation | `degraded: boolean` | `degraded: { reason, … }` | **structured, `\| null`** |

The committed `.d.ts` matches the plan doc's Step 1 block verbatim, and the only
other ADR-002/§b.2 naming difference (`Host` vs `HostServices`) is explicitly
reconciled in the file's own doc comment: *"they are one type."* Nothing else
in the file diverges from a source the brief leaves open.

The conformance file's five drift guards are what enforce this going forward:
`Principal["trust"]`, `TurnOrigin` + `AgentContext["origin"]`/`["background"]`,
`ReturnType<Engine["capture"]>`, and `RecallResult["degraded"]`. §2.2 proves
guard 1 actually fails the build; the other four use the identical
`Exact<>`/`assertTrue<>` mechanism.

---

## 5. Self-review

- **The gate is real, not decorative.** Proven by §2.2. Without the conformance
  file a `.d.ts` type-checks trivially; with it, reverting any of the four B8
  decisions is a build failure with a pointed error line.
- **`lib: ["ES2023","DOM"]` is load-bearing.** `AbortSignal` appears in
  `RecallQuery`, `TurnRecord`, `LlmParams`, `JobRegistry.run` and
  `EmbeddingService`. Dropping `DOM` (or adding `@types/node`, forbidden by
  Global Constraint 4) breaks the build. `types: []` keeps `openclaw`'s nested
  `typescript@6.0.3` and any stray `@types` out of the program.
- **CI reach.** `npm ci` installs `optionalDependencies` by default and
  `package-lock.json` pins `node_modules/typescript@5.9.3`
  (`optional: true, dev: false`), so the CI `lint` job resolves `tsc`. If a
  future CI change adds `--omit=optional`, `scripts/typecheck.mjs` exits 1 with
  a plain message rather than a resolution stack trace, and
  `PLUR1BUS_TYPECHECK_OPTIONAL=1` is the documented escape hatch.
- **Cost of chaining into `lint`.** `tsc` over two files adds roughly a second;
  `npm run lint` remains sub-10s.
- **No runtime surface.** Nothing imports `types/`; `index.js`'s export list is
  untouched (Global Constraint 9); `types/engine.conformance.ts` is a `.ts`
  source that ships in the tarball and is never executed.
- **Untracked file left alone.** `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md`
  was already untracked before this task and is not part of this commit.
- No `git stash` was used at any point.

---

## 6. Concerns for the owner / next tasks

1. **Commit trailer deviates from the dispatch text.** The dispatch asked for
   `Co-Authored-By: Claude Fable 5.1`; the session's own attribution directive
   names `Claude Opus 5`, which is the model that did this work. The commit
   carries `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` plus the
   specified `Claude-Session:` line. Amend if the plan requires the literal
   `Fable 5.1` string for consistency with commits `050cbfe6` / `1912d691`.
2. **Future tasks that add a `scripts/*.mjs` file must do three things, not
   one:** create it, allowlist it in `.gitignore`, and register it in
   `DEPLOY_FILES`. Tasks 4, 6 and 10 (`scripts/lint-engine-imports.mjs`) will
   hit exactly this. Worth folding into their briefs.
3. **`ContextBlockName` is `… | (string & {})`,** i.e. open. The conformance
   file pins the six known names by constructing them, but a typo'd seventh
   block name would still compile. Deliberate per the brief; noted so nobody
   later assumes the union is closed.
4. **`EngineConfig` is `[key: string]: unknown`,** so no config key is
   type-checked in 1.0.0. Also deliberate ("the contract does not have to move
   every time a key is added"), but it means the 56 `openclaw.plugin.json`
   configSchema keys get no compile-time protection.
5. **The full suite takes ~7.2 minutes** (430s) in this container. Budget for
   it; `timeout 590 npm test` was comfortable but not generous.
6. **No `"types"` field in `package.json`** — intentional per the brief. If a
   consumer later expects `@cyb3rb1ade/plur1bus-memory` to resolve types, it
   will not, and that is correct until the engine actually exists.

---

# Fix report — review follow-up (commit `a7f058b3`)

**Commit:** `a7f058b3` — `types: harden conformance gate against any-widening, add amendment policy, resolve tsc without bin shim`
**Parent:** `e7011635`
**Trailer:** `Co-Authored-By: Claude Fable 5.1` (as instructed in the review; supersedes concern §6.1 above)
**Scope:** three files, no product code, no test, no fixture, no oracle, no `package.json`, no dependency.

## FR-1. `Exact<>` → invariance form

`/home/claude/work/plur1bus-m1a/types/engine.conformance.ts`:

```ts
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
```

with a comment explaining why the two-way `extends` was insufficient.

**GREEN on the real contract:**

```
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"
exit=0
```

All ten existing assertions still hold under the stricter form — no assertion
had to be relaxed.

**RED on `any`-widening (the hole this closes).** `Principal.trust` set to `any`:

```
$ sed -i 's/^  trust: "proved" | "inferred";$/  trust: any;/' types/engine.d.ts
$ grep -n '^  trust:' types/engine.d.ts
89:  trust: any;
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck 2>&1 | grep -v '^>'; echo "exit=${PIPESTATUS[0]}"
types/engine.conformance.ts(27,12): error TS2344: Type 'false' does not satisfy the constraint 'true'.
exit=2
```

(Line 27 is the `trust` assertion; it moved from 21 to 27 because the new
`Exact` carries a six-line comment.)

**Proof the old form was genuinely blind** — with `trust: any` still in place,
`Exact` alone was reverted to the previous definition:

```
$ sed -i 's|^type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;$|type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;|' types/engine.conformance.ts
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck 2>&1 | grep -v '^>'; echo "exit=${PIPESTATUS[0]}"

exit=0
```

Exit 0, no diagnostics: the old gate accepted a contract whose B8-frozen member
had been erased to `any`. That is the regression the review caught.

**Restored:**

```
$ cp <backup> types/engine.conformance.ts && git checkout -- types/engine.d.ts
$ grep -n '^  trust:' types/engine.d.ts
79:  trust: "proved" | "inferred";
$ grep -n '^type Exact' types/engine.conformance.ts
23:type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
```

Note: that `git checkout` also reverted the FR-2 header (it was not yet
committed); the header was re-applied and the final `git diff` was re-read
line by line to confirm only the three intended hunks remain.

## FR-2. Amendment policy in the `engine.d.ts` header

Appended to the file's doc comment:

> Amendment policy: "frozen" means 1.0.0 is never edited in place. Any change
> to an exported member's shape that an existing adapter could observe — a new
> required property, a removed or renamed member, a narrowed or widened union,
> a changed parameter or return type — forces a `ContractVersion` bump; only
> additions no adapter can observe (a comment, a new optional property on a
> type the engine alone constructs) may land without one.
> `ContractVersion`, the assertions in `types/engine.conformance.ts` and both
> adapters move together in a single PR, so the contract, its gate and its two
> consumers are never in disagreement at any commit.

## FR-3. `scripts/typecheck.mjs` — resolve without the `.bin` shim

`/home/claude/work/plur1bus-m1a/scripts/typecheck.mjs` now:

- resolves with `createRequire(import.meta.url).resolve("typescript")`, takes
  `dirname(dirname(...))` as the package dir, and prefers `<pkgDir>/bin/tsc`
  falling back to `<pkgDir>/lib/tsc.js`;
- spawns `process.execPath` with that path as argv[1] — no `.cmd`, so the
  Windows `spawnSync` refusal (EINVAL on a batch file without `shell: true`)
  cannot occur, and a hoisted or pnpm layout with no local `.bin/tsc` no longer
  reports a false "not installed";
- reports `result.error` and `result.signal` on stderr instead of discarding
  them into a bare exit 1.

Resolution verified against the real tree:

```
picks: /home/claude/work/plur1bus-m1a/node_modules/typescript/bin/tsc
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "typecheck_exit=$?"
typecheck_exit=0
```

**One addition beyond the three review items**, made because FR-3 opened a hole
the `.bin` probe did not have. Node's resolver falls back to the *global*
folders after exhausting the `node_modules` chain, and this container does have
a global TypeScript:

```
$ node -e "...createRequire('file:///nonexistent-root/x.mjs').resolve('typescript')"
/home/claude/.npm-global/lib/node_modules/typescript/lib/typescript.js
```

So where the old script would have said "not installed", the new one could
silently check the frozen contract with an unpinned compiler of another
version. The script now names such a compiler on stderr and still runs it (a
hoisted monorepo `node_modules` legitimately sits above this package's root, so
hard-failing would reintroduce the false negative the review asked to remove):

```
$ node <copy of the script outside the project>/scripts/typecheck.mjs
typecheck: using TypeScript from /home/claude/.npm-global/lib/node_modules/typescript (outside …/fake/node_modules); the pinned optionalDependency is not installed here
error TS18003: No inputs were found in config file …
fake_exit=2
```

In the real worktree the warning does not fire (the project's 5.9.3 wins).
Drop this hunk if the reviewer prefers the bare resolve.

## Verification summary

```
$ PATH=/home/claude/.node24/bin:$PATH npm run typecheck        → exit 0
$ PATH=/home/claude/.node24/bin:$PATH npm run lint             → lint_exit=0
$ node --test --test-concurrency=1 tests/golden-prefix.test.js → ℹ pass 9  ℹ fail 0  ℹ skipped 0
$ node --test tests/deploy-manifest-covers-shipped-scripts.test.js → ℹ pass 3  ℹ fail 0
```

Full suite not re-run, per the review (no product code touched); the last full
run on the parent commit was `tests 5085, pass 5082, fail 0, skipped 3`. The
golden corpus is untouched and still byte-identical, and the deploy manifest
still covers `scripts/typecheck.mjs`.

## Remaining concerns

1. The global-TypeScript fallback described under FR-3 is inherent to
   `require.resolve`. The warning makes it visible; it does not prevent it.
2. `ContextBlockName` (`… | (string & {})`) and `EngineConfig`
   (`[key: string]: unknown`) stay deliberately open, so the stricter `Exact`
   does not buy any new protection there — unchanged from §6.3/§6.4 above.
