### Task 20: documentation — the harness column, the engine API, the changelog

**Files:**
- Modify: `docs/compatibility-openclaw.md:175-190` — add the `Harness behaviour` column (risk R6)
- Create: `docs/engine-api.md`
- Modify: `CHANGELOG.md` — add an `## [Unreleased]` section above `## [7.15.4]`
- Modify: `package.json` — add `"docs/engine-api.md"` to `files`

**Interfaces:**
- Consumes: `types/engine.d.ts` (Task 3); the module layout from Tasks 10–17.
- Produces: nothing executable.

**Constraint check:** `.github/workflows/*` stays untouched (Global Constraint 7); `package.json:version` stays `7.15.4` (Global Constraint 6) — the `Unreleased` heading is how an unreleased change is recorded in a Keep-a-Changelog file, which is the format this CHANGELOG declares at `CHANGELOG.md:5`.

- [ ] **Step 1: Add the fourth column to the compatibility matrix**

`docs/compatibility-openclaw.md:175-176` is today:

```markdown
| OpenClaw feature | PLUR1BUS overlap | Compatibility policy |
| --- | --- | --- |
```

Change both lines to:

```markdown
| OpenClaw feature | PLUR1BUS overlap | Compatibility policy | Harness behaviour |
| --- | --- | --- | --- |
```

and append one cell to each of the 14 rows at `:177-190`, in this order (R6 fixes the first ten; the last four are this workstream's proposal and are marked as such):

| Row (`docs/compatibility-openclaw.md`) | Cell to append |
|---|---|
| `:177` Exclusive memory slot and `memory-core` tools | `n/a (harness owns this) — the harness has no plugin slot; the engine is the only memory owner.` |
| `:178` Active Memory | `n/a (harness owns this) — one automatic pre-reply lane, `Engine.recall`.` |
| `:179` Memory-core dreaming | `n/a (harness owns this) — the harness scheduler owns every phase (ADR-009, owner A6).` |
| `:180` Skill Workshop self-learning | `Live — the harness exposes the same proposal lane; PLUR1BUS never applies a skill autonomously.` |
| `:181` System-owned skill collection review | `Live — distinct job ids stay distinct; the harness scheduler runs the PLUR1BUS miner only.` |
| `:182` Scheduled tasks / cron dispatcher | `n/a (harness owns this) — in-process `Engine.jobs.run()`, never a host cron (owner A6, D4).` |
| `:183` Config-watcher handoff and restart recovery | `Live — the core daemon supervises the engine; `Engine.close()` gets a real teardown budget.` |
| `:184` Configurable model-selection scopes | `Live — the harness supplies the effective model through `HostServices.llm`.` |
| `:185` Session provenance and `openclaw memory forget` | `Live — `AdminOps.forget` stays archive-first and confirmation-bound; no cross-store deletion.` |
| `:186` Compaction memory flush | `n/a (harness owns this) — `Engine.checkpoint(agentId, "compaction")` replaces the read of `event.compactedAt` (PR-15).` |
| `:187` `USER.md` user model | `Proposed: live — the harness keeps an identity file and a user file per agent (owner D14); PLUR1BUS stays provenance-bearing recall and never auto-promotes into them.` |
| `:188` Standing intents | `Proposed: live — the harness owns exact-time reminders; event-conditioned intents stay out of scope for v0.1.` |
| `:189` Memory Wiki / Obsidian mode | `Proposed: live — one writer per vault, unchanged; the harness mounts the same Obsidian bridge through `AdminOps.obsidian`.` |
| `:190` Session/workspace ownership | `n/a (harness owns this) — the harness mints a `Principal` with `trust: "proved"` at admission; no ticket chain (ADR-007, host-contract §c.2).` |

Immediately after the table, add:

```markdown
The **Harness behaviour** column is the drift tripwire for risk R2 in
`PLUR1BUS-Harness/docs/engine-extraction.md` §d: a row whose OpenClaw side
changes without this cell changing is an unreviewed divergence. Cells marked
*Proposed* are this workstream's reading and are open at the M1a owner gate.
```

- [ ] **Step 2: Write `docs/engine-api.md`**

```markdown
# The PLUR1BUS engine API

**Contract version 1.0.0** · frozen 2026-09-22 · source of truth: `types/engine.d.ts`

This document explains the contract; `types/engine.d.ts` *is* the contract, and
`types/engine.conformance.ts` fails `npm run typecheck` if the two disagree on
any of the four decisions below.

## Why it is frozen

Phase 0 sketched this API in four places and they disagreed on four points
(`PLUR1BUS-Harness/docs/phase0/review-report.md`, finding S4). Owner decision
**B8** (2026-09-22) settled each one, and the `.d.ts` was frozen **before**
PR-01 so both adapters — the OpenClaw plugin and the harness — are written
against one shape.

| Point | ADR-002 said | `engine-extraction.md` §b.2 said | B8 chose |
|---|---|---|---|
| Principal strength | `proof: "transport"` | `trust: "proved" \| "inferred"` | **`trust`** |
| Turn origin | one `TurnOrigin` object | string union + `AgentContext` | **union + `AgentContext`** |
| Capture | `Promise<CaptureResult>` | non-blocking handle | **`CaptureHandle`** |
| Degradation | `degraded: boolean` | `degraded: { reason, … }` | **structured, `\| null`** |

## The two halves

**`HostServices`** — what a host gives the engine. ADR-002 calls it `Host`;
they are the same type. `logger`, `stateDir`, `workspaceDir(agentId)`,
`config()`, `platform`, `runtime`, and the optional `mutateConfig`, `llm`,
`secrets`, `events`, `clock`. `lib/host-services.js` implements it for
OpenClaw (`createHostServices(api)`) and for tests (`createStubHost()`).

**`Engine`** — what the engine gives a host. Lifecycle (`open`, `close`,
`status`), the turn path (`systemSupplement`, `recall`, `capture`,
`checkpoint`), the model-facing surface (`tools`, `commands`, `runCommand`),
and the background surface (`jobs`, `embedding`, `admin`, `events`).

## Rules the types encode

- **`recall()` never throws.** A failure comes back as `degraded: { reason, capability }` with whatever blocks were assembled. The turn is never blocked.
- **`signal` is mandatory** on `RecallQuery` and `TurnRecord`. Today's memory-slot path accepts the host's signal and deliberately drops it (`lib/setup/memory-host-runtime.js:170-172`); PR-05 threads it through.
- **`capture()` returns immediately.** The caller gets a `CaptureHandle` with a `done` promise it may await or abandon.
- **The six blocks are the output shape.** `neo`, `start` and `memories` are droppable; `time`, `temporal` and `reminder` are not. The join and the cap live in `lib/inject-budget.js`, unchanged.
- **`UserPrincipal` stays `user:v1:sha256([channel, accountId, userId])`.** The hash is an on-disk pool directory name; changing it orphans every `user`-scoped row.
- **`trust: "inferred"` degrades to agent-private and never throws** — the behaviour `lib/memory-request-context.js:1405-1417` already has.

## What is implemented in M1a, and what is not

M1a implements `PlatformCapabilities` (`lib/platform.js`) and the runtime half
of `HostServices` (`lib/host-services.js`), and moves the recall, capture,
command and tool bodies into `engine/**` behind explicit context objects. No
`createEngine()` exists yet: `Engine` is the target PR-04…PR-15 build toward.

## Module layout after PR-03

| Path | Holds |
|---|---|
| `engine/recall/assemble-prompt-context.js` | the per-turn recall assembly and the six blocks |
| `engine/recall/minimal-maintenance.js` | the auto-recall-off branch |
| `engine/capture/capture-turn.js` | auto-capture |
| `engine/commands/plur1bus-command.js` | `/plur1bus` and the 17 internal job runners |
| `engine/tools/memory-tools.js` | the five model-facing tools |
| `adapter/openclaw/register-*.js` | every `api.on` / `api.register*` call |
| `index.js` | construction plus the registration calls, and the `export default` plugin factory |

`engine/**` may not import `openclaw`, `index.js`, `lib/runtime-shutdown.js`,
`lib/host-services.js`, `lib/setup/*-plugin-runtime.js` or
`lib/providers/openclaw-memory-embedding-adapters.js`, and the graph may not
contain a cycle. `scripts/lint-engine-imports.mjs` enforces all of it inside
`npm run lint`.
```

- [ ] **Step 3: Add the changelog entry**

Insert directly above `## [7.15.4] — 2026-09-21` in `CHANGELOG.md`:

```markdown
## [Unreleased]

### Hinzugefügt

- **Eingefrorener Engine-Vertrag** in `types/engine.d.ts` (Contract 1.0.0) plus
  `npm run typecheck`. Reicht `Host`/`HostServices`, `Engine`, `Principal`,
  `AgentContext`, `TurnOrigin`, `RecallQuery`/`RecallResult`, `CaptureHandle`
  und `JobRun` in einer Form ein, gegen die beide Adapter geschrieben werden.
- **`lib/platform.js`** mit `securePath`, `ipcAddress`, `isUnsafeLink` und
  `canonicalIdentityPath`.
- **`lib/host-services.js`** — `createHostServices(api)` und `createStubHost()`.
- **Golden-Prefix-Korpus** (`tests/fixtures/golden-prefix/`): fünf synthetische
  Szenarien, deren `prependContext` byteweise festgehalten ist.
- **`bench/recall-budget-probe.mjs`** — p50/p95/p99 der Recall-Latenz.
- **`docs/engine-api.md`** und die Spalte *Harness behaviour* in
  `docs/compatibility-openclaw.md`.

### Geändert

- `index.js` ist auf die Konstruktion und die Registrierungsaufrufe reduziert;
  Recall, Capture, Kommandos und Tools liegen unter `engine/`, jede
  `api.on`/`api.register*`-Stelle unter `adapter/openclaw/`. **Kein
  Verhaltensunterschied** — die volle Suite und der Golden-Prefix-Korpus sind
  die Gates.

### Behoben

- `process.env.HOME` wird nicht mehr als Home-Verzeichnis benutzt
  (`lib/providers/openclaw-memory-embedding-adapters.js`); unter Windows ist
  die Variable nicht gesetzt, der Modell-Cache landete im Arbeitsverzeichnis.
- Alle acht `chmod`-Stellen laufen über `securePath`, das unter Windows eine
  benutzergebundene ACL setzt statt nur das Read-only-Bit.
```

- [ ] **Step 4: Ship the new doc**

Add `"docs/engine-api.md"` to `package.json:files`, next to the other `docs/` entries.

- [ ] **Step 5: Verify**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/config-docs-contract.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && git diff --stat .github/ ; echo "must be empty"
```

Expected: lint 0; `tests/config-docs-contract.test.js` passes (it reads the docs and would catch a broken table); golden `pass 7 / fail 0`; suite at the accepted baseline; the `git diff --stat .github/` prints nothing.

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add docs/compatibility-openclaw.md docs/engine-api.md CHANGELOG.md package.json
git commit -m "docs: add the Harness behaviour column, docs/engine-api.md and an Unreleased entry

Closes risk R6: the compatibility matrix now has the fourth column that acts as
the drift tripwire for R2. docs/engine-api.md explains the frozen contract and
records which of the four S4 disagreements B8 settled, and how."
```

---

## Done means

All twenty tasks committed on `feat/engine-extraction-m1a`, and:

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && git diff --stat main -- .github/ ; echo "^ must be empty"
cd "$PLUR1BUS" && git diff main -- tests/fixtures/golden-prefix/expected/ ; echo "^ must be empty"
```

- lint exits 0, having run `node --check`, `tsc --noEmit`, the `api.` boundary rule and the engine dependency rule;
- the suite is at the accepted baseline — 2 failures, both the OpenClaw-host ones;
- `tests/golden-prefix.test.js` passes with the oracle **unmodified since Task 1** (the last command must print nothing);
- no workflow file changed;
- `package.json` still says `"name": "@cyb3rb1ade/plur1bus-memory"` and `"version": "7.15.4"`, with `engine/`, `adapter/`, `types/` and `docs/engine-api.md` added to `files`.

Then the M1a **owner gate**: the extraction boundary, the frozen `.d.ts` and the measured recall distribution go to the owner before M1b (PR-04…PR-09, PR-15, the daemon, the scheduler and the CLI) starts.
