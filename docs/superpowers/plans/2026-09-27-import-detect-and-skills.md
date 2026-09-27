# Import Detect and Skills Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two importer pieces pulled forward from M7 by the owner on 2026-09-27: a read-only `plur1bus import <openclaw|hermes> --detect` and a real skills importer `plur1bus import <openclaw|hermes> --skills` (dry-run default, `--apply` to write, `--rollback <report>`).

**Architecture:** The Rust CLI parses the command and spawns Node once on `import.js`, a second esbuild entry of `packages/core` that ships beside `core.js` in the core payload. Node is needed because detect opens LanceDB (the engine's own `@lancedb/lancedb`, resolved through the pinned engine package) and SQLite (`node:sqlite`). The Node side prints one envelope line on stdout; the Rust side turns it into the usual `--json` document (`schema` inserted by `output.rs`) or prints the human rendering. The importer never runs inside the core process and never talks to a running core or supervisor.

**Tech Stack:** Rust 1.95 (clap, serde_json), Node 24.21 TypeScript run with `--experimental-strip-types`, `node:sqlite`, `@lancedb/lancedb` 0.26 (via the engine), esbuild.

**Spec:** `docs/import.md` (binding; amended by Task 1), ADR-012 (process model), `docs/milestones.md` M7, spec rows D49/D56/D57 in `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`, the brief in the owner's 2026-09-27 request.

## Global Constraints

- The source is strictly read-only. SQLite is never opened in place for writing: a database up to 256 MiB (with its `-wal`) is copied into a private temp dir and opened there; a larger one is opened `readOnly` with `immutable=1` (the WAL is then not consulted, reported as a warning). LanceDB is only opened, `schema()`/`countRows()`/`select(["embeddingFingerprint"])`; tests assert the source fixture is byte-identical (paths, contents, mtimes) before and after.
- Never read or print secret values. `.env` is parsed for key names only; `auth.json`, `auth-profiles.json`, `credentials/`, `openclaw-agent.sqlite` are never opened (presence only). Config values at secret-shaped keys are reported by path only. Skill files named `.env`, `.env.*`, `auth.json`, `credentials.json`, `*.pem`, `*.key`, `id_rsa*` are never copied.
- The embedding cache's `debug_text` column and LanceDB `text`/content columns are never selected.
- No network, no provider calls, no model loading, no engine instance.
- Reports (JSON and human) carry no memory content, no skill bodies, no secrets.
- Imported skills land **disabled** unless `--enable` (security default; owner decision to confirm).
- Skill folder cap: 8 MiB and 2000 files by default (`--max-skill-bytes`). Symlinks that resolve outside the skill folder are skipped and counted; directory symlinks inside a skill are skipped (no loops).
- Skill ids: folder basename, lowercased, must match `^[a-z0-9][a-z0-9._-]{0,63}$`; anything else is refused `invalid-id`.
- Hygiene: `scripts/lint-hygiene.mjs` allows OpenClaw names only in the importer's own files (`packages/core/src/import/**`, `packages/core/src/import-bin.ts`, `packages/core/test/import/**`, `crates/plur1bus/src/commands/import.rs`, `crates/plur1bus/tests/import.rs`, and the `import` lines of `cli.rs`/`main.rs`); `dist/core.js` must not contain the importer (test).
- `--json` documents: `import.detect/1`, `import.skills/1`, `import.rollback/1`; failures `error/1` as everywhere else.
- Commits as `Cyb3rb1ade <84099452+Cyb3rb1ade@users.noreply.github.com>` with the session trailers; no push, amend or stash.

## Review Focus

1. A live source (OpenClaw running, SQLite in WAL mode with `-wal`/`-shm` present) — detect must still read consistent counts and leave every source byte unchanged. Test: fixture cache DB left open in WAL mode while detect runs (Task 4).
2. A source path that is not an installation at all (empty dir, a harness home, a file) — refuse with a named reason, exit 2, never a half report. Test in Task 3/5.
3. Re-running `--skills --apply` after an interrupted apply (a skill dir renamed into place but not yet indexed, a leftover `.staging/`) — converges without duplicates. Test in Task 7.
4. Rolling back an old run after a newer import changed `skills/` — refused `E_ROLLBACK_STALE` instead of clobbering the newer state. Test in Task 7.
5. A tampered report or index (`../` ids, snapshot path outside the run dir) — refused, nothing written. Test in Task 7.

---

## File Structure

- `packages/core/src/import/json5.ts` — JSON5 parser (config is JSON5).
- `packages/core/src/import/yaml-lite.ts` — restricted YAML reader (block maps/sequences, scalars, flow lists of scalars; `|`/`>` block scalars) for Hermes `config.yaml` and SKILL.md frontmatter.
- `packages/core/src/import/readonly.ts` — read-only primitives: bounded file read, `.env` key names, SQLite open (copy-to-temp / immutable), LanceDB loader, secret-file names.
- `packages/core/src/import/catalog.ts` — pinned model catalog (revision, quantization, native dims, default prefixes, licence, artefact digest) mirrored from the pinned engine, drift-checked by a test.
- `packages/core/src/import/identity.ts` — identity fields `{value, source}`, target identity from the harness config, comparison verdict, reranker classification.
- `packages/core/src/import/sources/openclaw.ts`, `sources/hermes.ts` — root/version/agents/plur1bus/stores/reranker/skill roots/secret presence.
- `packages/core/src/import/skills-scan.ts` — skill enumeration, frontmatter, folder hash `plur1bus-skill-sha256/v1`, script detection, symlink/secret/size handling, copy plan.
- `packages/core/src/import/skills-registry.ts` — `<home>/skills/index.json` read/write (atomic, unknown fields preserved), lock.
- `packages/core/src/import/skills-import.ts` — plan, apply (snapshot, staging, conflict strategies, progressive report), rollback.
- `packages/core/src/import/detect.ts` — assemble `import.detect/1`.
- `packages/core/src/import/render.ts` — human renderings.
- `packages/core/src/import-bin.ts` — argv → run → envelope line.
- `crates/plur1bus/src/commands/import.rs` — clap args → spawn → output.
- Tests: `packages/core/test/import/*.test.ts`, `packages/core/test/import/fixtures.ts`, `crates/plur1bus/tests/import.rs`, `crates/plur1bus/tests/fixtures/fake-import.mjs`.

## Contracts fixed by this plan

**Envelope (Node → Rust, one stdout line):** `{"ok":true,"schema":"import.detect/1","value":{…},"human":"…"}` or `{"ok":false,"error":"E_…","message":"…","reason":"…","exit":2}`. `value` never has a top-level `schema` key.

**Error codes:** `E_INVALID_PARAMS` (2), `E_NOT_AVAILABLE` (2, full import → M7), `E_SOURCE_NOT_FOUND` (2), `E_SOURCE_UNSUPPORTED` (2, version undeterminable/refused, named `reason`), `E_LOCKED` (3), `E_ROLLBACK_STALE` (2), `E_ROLLBACK_INVALID` (2), `E_IMPORT_FAILED` (1).

**Skill index** `<home>/skills/index.json`: `{"version":1,"skills":[{"id","source","sourcePath","sha256","enabled","importedAt"}]}`, sorted by id; `source` is `"openclaw"`/`"hermes"` for imports; unknown top-level and entry fields are preserved on rewrite. Skill content lives at `<home>/skills/<id>/SKILL.md` (+ folder).

**Folder hash `plur1bus-skill-sha256/v1`:** over the files that would be copied, sorted by POSIX relative path: `sha256( Σ relpath + "\0" + sha256hex(content) + "\n" )`, prefixed `sha256:`.

**Identity field sources:** `store-metadata` (generation manifest, re-embedding state fingerprint, per-row `embeddingFingerprint`), `config`, `cache` (embedding cache), `model-cache` (local model artefact dir), `vector-schema` (Lance `FixedSizeList` size), `derived` (from other confirmed fields), `not-applicable`, `unknown`. Target fields: `harness-config`, `harness-default`, `engine-catalog`.

## Tasks

### Task 1: Spec amendment, CLI stub text, generated CLI docs

**Files:** Modify `docs/import.md` (new §8 "Detect (read-only, pulled forward)", §9 "Skills import (pulled forward)", reranker rows in §2.3/§2.3.2, milestone note at the top), `docs/milestones.md` (M7 note), `crates/plur1bus/src/cli.rs` (import help text, now `[experimental]`), `docs/cli.md` via `pnpm docs:gen` (done in Task 8 when the clap tree is final).

- [ ] Write the sections: pipeline mapping (detect = phase 1 only; skills import = phases 2–7 for one entity kind), resolution order of the source root, version gates, the detect JSON shape, identity field table with sources, the reranker rule (not fatal, report line + recommendation, licence classes `permissive` / `non-commercial` / `remote-service-terms` / `unknown` per ADR-006 and the setup licence gate), skill index format, folder hash, conflict strategies, snapshot/rollback, disabled-by-default, the Hermes skills/soul/cron mapping reference, and the M1b-3→M7 resolution.
- [ ] Commit `docs(import): specify detect and skills import (pulled forward 2026-09-27)`.

### Task 2: Parsers and read-only primitives

**Files:** Create `json5.ts`, `yaml-lite.ts`, `readonly.ts`; tests `test/import/parsers.test.ts`, `test/import/readonly.test.ts`.

**Interfaces — Produces:** `parseJson5(text: string): unknown` (throws `SyntaxError`); `readYaml(text: string): { value: unknown; unsupported: string[] }`; `frontmatter(text: string): Record<string, unknown> | null`; `envKeyNames(path: string): string[]`; `openSqliteReadOnly(path: string): { db: DatabaseSync; close(): void; mode: "copy" | "immutable" }`; `loadLanceDb(): Promise<typeof import("@lancedb/lancedb") | null>`; `isSecretFileName(name: string): boolean`; `readBounded(path: string, max: number): string | null`.

- [ ] Tests: JSON5 comments/trailing commas/unquoted keys/single quotes/hex/`Infinity`; YAML nested maps, `- a` lists, `[a, b]`, quoted scalars, `|` and `>`; `envKeyNames` on a file with `export A=secret` and `B="x=y"` returns `["A","B"]` and the returned value never contains `secret`; `openSqliteReadOnly` on a WAL database whose writer is still open sees WAL rows and leaves the dir byte-identical.
- [ ] Implement, run `node --experimental-strip-types --conditions=source --test test/import/*.test.ts`, commit.

### Task 3: Catalog, identity and target

**Files:** Create `catalog.ts`, `identity.ts`; test `test/import/identity.test.ts`.

**Interfaces — Produces:** `CATALOG: Record<string, CatalogEntry>` with `{ role, revision, quantization, nativeDimensions?, queryPrefix?, passagePrefix?, licence, licenceClass, artefactDigest }`; `artefactDigest(artifacts: {path,sha256}[]): string`; `type Field<T> = { value: T | null; source: FieldSource; note?: string }`; `IDENTITY_FIELDS = ["provider","model","revision","artefactHash","quantization","dimension","prefixSchema","normalization","tokenCap","endpoint"]`; `targetIdentity(home: string): { configSource: "config.json" | "defaults"; fields: Record<string, Field<unknown>>; reranker: RerankerInfo }`; `compareIdentity(source, target): { verdict: "match" | "mismatch" | "undetermined"; fields: Record<string, "match" | "mismatch" | "unknown"> }`; `classifyReranker(cfg): RerankerInfo`.

- [ ] Tests: every catalog entry equals the pinned engine's `lib/providers/local-model-artifacts.js` profile (revision, dtype, licence, digest over its artifacts) — test-only import; `targetIdentity` on an empty home gives E5-small/384/`query: `/`passage: `/fp32 from `harness-default`/`engine-catalog`; an unknown field makes the verdict `undetermined`, a differing confirmed field `mismatch`; Jina reranker → `non-commercial`, BGE → `permissive`, Cohere → `remote` + `remote-service-terms`.
- [ ] Implement, run, commit.

### Task 4: OpenClaw source

**Files:** Create `sources/openclaw.ts`, `test/import/fixtures.ts` (synthetic OpenClaw and Hermes builders), `test/import/detect-openclaw.test.ts`.

**Interfaces — Consumes:** Task 2, 3. **Produces:** `resolveOpenclawRoot(opts: { source?: string; env: NodeJS.ProcessEnv; homedir: string }): { root: string; resolvedFrom: string; configPath: string }`; `detectOpenclaw(ctx: SourceCtx): Promise<SourceReport>` where `SourceReport = { source, version, agents, plur1bus, rerankers, skillRoots: SkillRoot[], secrets, other, warnings }`; `SkillRoot = { dir: string; tier: string; agentId: string | null }`.

Root order: `--source`, `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE` (`~/.openclaw-<p>`), `OPENCLAW_HOME/.openclaw`, `~/.openclaw`; config `OPENCLAW_CONFIG_PATH` or `<root>/openclaw.json`. Version: `meta.lastTouchedVersion` and `state/openclaw.sqlite` `schema_meta.schema_version` (`meta_key='primary'`); neither → `E_SOURCE_UNSUPPORTED reason=version-undeterminable`; no config and no state DB → `E_SOURCE_NOT_FOUND reason=not-an-openclaw-state-dir`. Agents: `agents.entries` / `agents.list` / implicit `main`, plus `agents/*` dirs. Plugin: `plugins.entries["memory-lancedb-namespaced"]`, version from `extensions/*/package.json` or `npm/projects/*/node_modules/@cyb3rb1ade/plur1bus-memory/package.json`, else `plugins.installs`. Stores per engine layout (legacy-flat / named / generation), shared pools under `.plur1bus-shared/{workspaces,users}`, embedding cache `embedding-cache-v2/*.db` grouped by `(provider, model, dimensions)`, re-embedding state `control/reembedding-state.json`, generation manifests. Skill roots: `skills.load.extraDirs`, `<root>/skills` (managed), `<agentDir>/workshop-skills`, `<workspace>/.agents/skills`, `<workspace>/skills`, `OPENCLAW_BUNDLED_SKILLS_DIR` (bundled).

- [ ] Fixture: agent `alpha` store (LanceDB 384-d) with an embedding cache holding two identities (E5-small 384 and Jina v5 nano 768), agent `beta` store with no metadata and a 768-d schema, a shared workspace pool, plugin entry with a Cohere reranker, model cache for E5 at the pinned revision, `.env`/`auth-profiles.json`/`credentials/`/config `apiKey` carrying the fake token `sk-fixture-NOT-REAL-9f8e7d`, cache `debug_text` and memory rows carrying the content marker `CONTENT-MARKER-do-not-report`.
- [ ] Tests: version + agents; per store the field sources (dimension from `vector-schema`, alpha `distinctIdentities: 2` → `mismatch` with reason `multiple-identities`, beta `undetermined` → planned `re-embedding-migration`); reranker line; not-an-installation refusal; byte-identical source while the cache writer stays open in WAL mode; no token/marker anywhere in the result.
- [ ] Implement, run, commit.

### Task 5: Hermes source

**Files:** Create `sources/hermes.ts`; test `test/import/detect-hermes.test.ts`.

**Produces:** `resolveHermesRoot(opts: { source?: string; profile?: string; env; homedir })`, `detectHermes(ctx): Promise<SourceReport>`.

Root: `--source`, `HERMES_HOME`, `~/.hermes`; `--profile <name>` narrows to `<root>/profiles/<name>`. Markers: root `config.yaml`/`.env`/`state.db`; none → `E_SOURCE_NOT_FOUND reason=not-a-hermes-home`. Version: `_config_version` (integer; missing → `E_SOURCE_UNSUPPORTED reason=config-version-unreadable`; > 45 → warning `newer-than-tested`), `state.db` `schema_version.version` (30 tested). Agents: `default` + each `profiles/<name>`. Skills: `<profile>/skills` (nested categories), `skills.external_dirs`, `HERMES_OPTIONAL_SKILLS` (tier `optional`). PLUR1BUS: `memory.provider` recorded; stores and reranker `not-applicable`.

- [ ] Tests: root + profile, version fields, skills from two profiles and an external dir, `.env` key names only, `auth.json` presence only, refusal on an empty dir, byte-identical source.
- [ ] Implement, run, commit.

### Task 6: Skill scan and detect assembly

**Files:** Create `skills-scan.ts`, `skills-registry.ts` (read side), `detect.ts`, `render.ts`; test `test/import/skills-scan.test.ts`, `test/import/detect.test.ts`.

**Produces:** `scanSkills(roots: SkillRoot[], opts: { maxBytes: number; maxFiles: number }): ScannedSkill[]` (`{ id, name, description, path, realPath, tier, agentId, bytes, files, sha256, hasScripts, scripts, skipped: { symlinkEscapes: string[]; symlinkDirs: string[]; secretFiles: number; vcs: number }, problems: string[], shadowedBy: string | null, entries: CopyEntry[] }`); `readIndex(home): SkillIndex`; `harnessSkillState(home, id): { exists: boolean; sha256: string | null; indexed: boolean }`; `detect(opts): Promise<DetectReport>`; `renderDetect(r): string`.

- [ ] Tests: the script skill (`scripts/run.sh`, exec bit) → `hasScripts`; the symlink-escape skill → escape listed, target not hashed; a folder over the cap → problem `too-large`; an id already in the harness index with a different hash → `plannedAction: "conflict-skip"`, identical → `skip-identical`; description truncated at 300 chars; the detect document has the documented top-level keys and the human rendering names every section.
- [ ] Implement, run, commit.

### Task 7: Skills import — plan, apply, rollback

**Files:** Create `skills-import.ts`, extend `skills-registry.ts` (write, lock); test `test/import/skills-import.test.ts`.

**Produces:** `importSkills(opts: { sourceType; source: SourceReport; home: string; apply: boolean; enable: boolean; onConflict: "skip" | "rename" | "replace"; maxBytes: number }): Promise<SkillsReport>`; `rollback(opts: { home: string; reportPath: string; apply: boolean; sourceType }): RollbackReport`.

Apply: lock `skills/.lock` (pid; stale pid taken over, live → `E_LOCKED`), clear `skills/.staging`, snapshot `skills/` to `<home>/imports/<runId>/snapshot/skills`, write `report.json` (status `running`) and rewrite it after every skill and at the end (`completed`), per skill: copy into `.staging/<id>-<rand>`, re-hash, rename into place, then update the index atomically. Conflicts: `skip` (default); `rename` → `<id>-<sourceType>[-N]`; `replace` → old folder moved to `<home>/imports/<runId>/replaced/<id>`. On-disk folder with the same hash but no index entry → adopted. Report records `indexSha256After`. Rollback: validates `runId` (`^[0-9TZ-]+-[0-9a-f]{8}$`) and that the snapshot is inside `<home>/imports/<runId>/`, refuses `E_ROLLBACK_STALE` when the current index hash differs from `indexSha256After`, dry-run lists the per-id changes, `--apply` moves the current `skills/` to `<home>/imports/<runId>/rolled-back/` and restores the snapshot.

- [ ] Tests: dry-run writes nothing to home or source; apply imports disabled skills (index entries have the six fields), skips the conflicting id, never copies `.env`/escaped targets; second apply is all `skip-identical`, zero writes; interrupted apply (folder in place, no index entry, leftover staging) converges; `rename` and `replace` (backup exists); `--enable`; lock held by a live pid → `E_LOCKED`; rollback restores the exact snapshot; rollback after a later import → `E_ROLLBACK_STALE`; tampered report → `E_ROLLBACK_INVALID`; reports contain no token/marker; source byte-identical. Loop the file 10× without flakes.
- [ ] Implement, run, commit.

### Task 8: Node entry, Rust command, hygiene, docs

**Files:** Create `packages/core/src/import-bin.ts`, `crates/plur1bus/src/commands/import.rs`, `crates/plur1bus/tests/import.rs`, `crates/plur1bus/tests/fixtures/fake-import.mjs`; modify `packages/core/package.json` (build entry `dist/import.js`), `crates/plur1bus/src/{cli.rs,main.rs,commands/mod.rs}`, `crates/plur1bus/tests/cli.rs` (import no longer a stub), `scripts/lint-hygiene.mjs`, `packages/core/test/import-hygiene.test.ts` (core bundle excludes the importer), `docs/cli.md` (generated), `AGENTS.md` (importer row + env vars).

**Interfaces:** `plur1bus import <SOURCE> [--detect | --skills | --rollback <REPORT>] [--source <PATH>] [--profile <NAME>] [--apply] [--enable] [--on-conflict skip|rename|replace] [--max-skill-bytes <N>]`; no mode → `E_NOT_AVAILABLE milestone=M7`. `import.js` is `$PLUR1BUS_IMPORT_JS`, else `import.js` beside `locate_core_js`. Node via `locate_node`.

- [ ] Rust tests (fake import script): args forwarded, `schema` inserted, human passthrough, error envelope → `error/1` with `reason` and exit code, missing script → `E_IMPORT_FAILED`, no mode → M7 stub; one end-to-end test against the real `packages/core/dist/import.js` on a Rust-built skills-only OpenClaw fixture.
- [ ] TS test `import-bin.test.ts`: spawn `src/import-bin.ts` for detect and skills, parse the envelope.
- [ ] `pnpm docs:gen`; full verification (`cargo test --workspace`, `pnpm lint`, `pnpm test`, cross-clippy, `cargo fmt --check`, 10× loop); commit.

### Task 9: Fresh-eyes whole-branch review

- [ ] Review the whole diff against this plan and `docs/import.md` §8/§9; fix findings with tests; commit.
