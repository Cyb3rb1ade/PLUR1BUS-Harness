# RE-11 — Phase 3: retire the Node engine, ADR-018, docs

**Package.** The harness stops depending on `@cyb3rb1ade/plur1bus-memory`: the default implementation flips to
`rust`, the exact-commit pin, the private-package install steps, the shim types, the engine's dependency on `transformers` (`packages/core` keeps it as a direct optional dependency, for local Florence-2 captions only, T2) and the
CI token go away, the engine-config schema's home becomes the crate, the docs and the decision record say so. Size M;
five tasks, one pull request each, across two releases.

**Depends on.** RE-10 complete; one release shipped with both implementations and `rust` as default (T1) before the
removal (T2–T5). **Enables.** Nothing further in this programme; it closes it.

**Assumes.** RE-D7 (the engine repository stays for the OpenClaw plugin line; nothing there is archived by this brief).

**Read first.**
- Plan §2.3 (Phase 3 row), RE-11 in §4, §5.1 ("Smaller, simpler distribution"), ADR-012 D7 (the decision this amends),
  ADR-013 (config keys: `x-restart`, `x-tier`; removing an enum value is a breaking config change — do it one release
  after the default flip and keep reading `"node"` as `"rust"` with a warning for one more release), ADR-016 (RPC
  stability: nothing in the RPC surface is removed by this brief).
- Every place the engine package is named today: `packages/core/package.json:20` (`"@cyb3rb1ade/plur1bus-memory":
  "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#<commit>"`), `pnpm-lock.yaml`, `packages/core/src/engine.ts`
  (`CORE_CONTRACT`, `bindEngine`), `engine-shim.d.ts`, `engine-config.ts` (`installedEngineSchema` import from the
  package), `scripts/gen-engine-keys.mjs` (reads the pinned package's manifest), `scripts/test-prep.mjs` (checks the
  private engine entry), `scripts/lint-hygiene.mjs` (the allow-list line for the engine's git dependency),
  `.github/workflows/*.yml` (every `GH_ENGINE_READ_TOKEN` step: `ci.yml`, `release-quality.yml`, `dependency-licenses.yml`,
  `container.yml`'s BuildKit secret, `nightly.yml`, `hermes-host.yml` — grep), `Dockerfile` and `containers/harness/Dockerfile`
  (the secret mount), `THIRD_PARTY.md`/`THIRD_PARTY-LICENSES.txt` (the npm rows that disappear; regenerate on macOS
  arm64 as the header states, or edit rows exactly as commit `f2752561` did), AGENTS.md (the "What this repo is"
  paragraph on the pin, "Tests lokal" on the private repository, the `GH_ENGINE_READ_TOKEN` secret note, the
  `packages/core` row), CLAUDE.md (no change expected), `docs/engine-extraction.md`, `docs/architecture.md`,
  `docs/milestones.md`, `docs/ci.md`, `docs/host-contract.md`.

**Rules that apply.** One release with both implementations and `rust` as default; removal only in the next. Nothing
is hand-edited under `generated/`; `pnpm gen` and `pnpm docs:gen` after the schema moves. The hygiene allow-list
shrinks, never grows, in this brief.

## Files

- T1: `packages/config-schema/schema/config.schema.json` (default `"rust"`), fixtures via `pnpm gen`, `docs/config.md`,
  `docs/user/**` where the engine is mentioned, release notes (`scripts/release/notes.mjs` input, if the repo keeps a
  changelog there)
- T2: `packages/core/package.json`, `pnpm-lock.yaml`, `packages/core/src/engine.ts`, `engine-shim.d.ts`, `engine-config.ts`,
  `packages/core/src/engine/select.ts` (drop the `node` branch; map a leftover `"node"` to `"rust"` with a warning),
  `scripts/test-prep.mjs`, `scripts/lint-hygiene.mjs`, `THIRD_PARTY*.md/txt`
- T3: `crates/plur1bus-engine/schema/engine-config.schema.json` becomes the only copy; `scripts/gen-engine-keys.mjs`
  reads it; `packages/core/src/engine-config.ts` imports it (the esbuild bundle inlines JSON); `docs/config-engine-keys.md`
  regenerated; RE-01's drift test removed with the package; the engine's `x-tier` annotations move into the crate's schema
  if they lived in the harness's config schema (read `docs/config-engine-keys.md`'s generator)
- T4: every workflow file with the token, both Dockerfiles, `docs/ci.md`, `docs/container.md`, AGENTS.md's secret note
- T5: `docs/adr/ADR-018-rust-engine.md`, `docs/adr/ADR-012-process-model-and-languages.md` (an amendment note pointing
  to ADR-018), `docs/engine-extraction.md` (status: historical; what (a)/(d)/(e) still hold), `docs/architecture.md`,
  `docs/milestones.md` (Track RE closed), `docs/host-contract.md` (which defects the Rust engine closed), AGENTS.md
  ("What this repo is", "Tests lokal", the crate row), the README status table in this folder

## Interfaces

**Consumes:** everything Phase 1 and 2 produced. **Produces:** nothing new; removes the Node engine surface.

## Tasks

### T1 — Default flips to `rust` (release N)

- [ ] **Step 1: failing tests:** `packages/config-schema` fixture test `defaults.json has engine.implementation rust`;
  `tests/system/setup.test.ts` (a fresh `setup` yields a home that starts the Rust engine); `select.test.ts` (an explicit
  `"node"` still works in this release).
- [ ] **Step 2:** schema default, `pnpm gen`, `pnpm docs:gen`; the release notes name the flip and the opt-out
  (`plur1bus config set engine.implementation node`) for one release.
- [ ] **Step 3: commit** `RE-11/T1: engine.implementation defaults to rust`. Ship release N.

### T2 — Remove the Node engine (release N+1)

- [ ] **Step 1: failing tests:** `grep -rn "plur1bus-memory" packages scripts crates .github Dockerfile containers` as
  a node test under `scripts/test/` asserting zero hits except docs; `select.test.ts` (`"node"` maps to `"rust"` with a
  warning line; config validation still accepts the value this release).
- [ ] **Step 2:** remove the dependency and the lock entry (`pnpm install` — not `--frozen-lockfile` — then commit the
  lock), delete `engine-shim.d.ts`, strip `engine.ts` to the client path, drop the hygiene allow-list line and the
  `test-prep.mjs` check, regenerate the third-party notices. Before the pin is removed, declare `@huggingface/transformers`
  `=4.3.1` as a direct `optionalDependencies` entry of `packages/core`. The Florence-2 caption loader imports it
  (`packages/core/src/media-search/caption/local.ts:51-70`), and today it reaches the core only through the engine's
  optional dependency (`pnpm-lock.yaml:1918-1934`, with its own closure at `:2028-2038`). Whether that import resolves
  under pnpm's isolated layout is unverified. Add a node test asserting that `import("@huggingface/transformers")`
  resolves from `packages/core`.
- [ ] **Step 3:** `pnpm test:prep` succeeds without any GitHub credential; `pnpm test`, `cargo test --workspace`.
  **Commit** `RE-11/T2: remove the Node engine dependency`.

### T3 — The engine-config schema lives in the crate (release N+1)

- [ ] **Step 1: failing test:** `scripts/gen-engine-keys.mjs --check` against the crate's schema; `pnpm docs:check`.
- [ ] **Step 2:** re-point the generator and `engine-config.ts`; delete RE-01's drift test; `pnpm docs:gen`.
- [ ] **Step 3: commit** `RE-11/T3: engine-config schema owned by the crate`.

### T4 — CI and images without the token (release N+1)

- [ ] **Step 1: failing test:** `scripts/ci/workflow-contract.test.mjs` gains `no workflow references GH_ENGINE_READ_TOKEN`;
  `scripts/release/test/container-files.test.ts` gains `no BuildKit secret for the engine`.
- [ ] **Step 2:** remove the steps and mounts; `docs/ci.md`, `docs/container.md`, AGENTS.md's secret note.
- [ ] **Step 3: commit** `RE-11/T4: CI and images need no engine token`.

### T5 — ADR-018 and the documentation sweep (release N+1)

- [ ] **Step 1:** write `docs/adr/ADR-018-rust-engine.md` in the house ADR format (context: ADR-012 D7 and this plan;
  decision: the memory engine is Rust, a supervised process, the contract schema in the crate; consequences: the
  parity suite stays, the OpenClaw plugin line is a separate code base, the forward-port triage of plan §3.10 ends);
  add the amendment note to ADR-012. ADR-018 also records RE-D15…RE-D19 and the tokenization job table of plan §2.5.
- [ ] **Step 2:** the docs listed under Files; `node scripts/check-doc-links.mjs`; `pnpm docs:check`.
- [ ] **Step 3: commit** `RE-11/T5: ADR-018 and documentation`. Close Track RE in the README status table.

## Acceptance

- Release N: both implementations ship, default `rust`, release notes say so.
- Release N+1: no reference to the Node engine package outside `docs/` history; `pnpm test:prep` needs no credential;
  `GH_ENGINE_READ_TOKEN` appears in no workflow; `pnpm docs:check`, `pnpm lint`, `cargo test --workspace` green;
  the third-party notices no longer list the npm engine closure.
- ADR-018 merged and linked from ADR-012.

## Out of scope

Archiving or changing the engine repository (RE-D7: it stays for the plugin line); any RPC removal; a store migration.

## Hand-off

T1 alone in release N. T2–T5 in release N+1, in order (T3 depends on T2's removal; T4 can run in parallel with T3).
