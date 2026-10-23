# RE-01 — Contract schema, generated types, traits, config validation

**Package.** The engine contract as a JSON Schema (`engine-contract.schema.json`), the Rust types generated from it,
the hand-written Rust traits (`Engine`, `HostServices`, `JobRegistry`, `EmbeddingService`, `MemoryOps`, `AdminOps`,
`StoreOps`), the error and cancellation types, and the engine-config validation at parity with the Node engine. Size
M. After this package every later brief compiles against fixed names and signatures.

**Depends on.** RE-00. **Enables.** RE-02…RE-09.

**Assumes.** RE-D6 (contract 1.17.0 from the start; 1.16.0 members at parity). If the owner chooses 1.16.0 first, T1
leaves the 1.17.0 members out and the rest of the brief is unchanged.

**Read first.**
- Plan §1.3 (the 27 members the core calls, the seven private deep imports), §2.4 (layout), RE-1 in §4.
- Engine repository at `98dfe2f`: `types/engine.d.ts` (1,285 lines — the source of truth for every type and doc
  comment), `engine/config/engine-config.schema.json` (57 top-level keys) and `engine/config/engine-config-schema.js`
  (194 lines, the validator entry), `engine/create-engine.js:1-200` (what `createEngine(host, config, testInternals)`
  accepts). Branch `codex/gp3-a1-curated-memory` tip `9b935ce`: `git diff 98dfe2f..9b935ce -- types/engine.d.ts` is
  the 1.17.0 delta (curation ops, memory-tree fields).
- Harness: `packages/core/src/engine.ts` (`CORE_CONTRACT = "1.16.0"`, `SUPPORTED_CONTRACT_MAJOR = 1`,
  `MIN_CONTRACT_MINOR = 15`, `assertEngineContract`, `bindEngine(host, engineConfig, testInternals)`),
  `packages/core/src/engine-shim.d.ts` (the private imports that become contract methods),
  `packages/core/src/engine-host-ports.ts` (`createEngineFetch`, `createEngineSecrets`, `ENGINE_FETCH_TIMEOUT_MS =
  300_000`, `ENGINE_MODEL_DOWNLOAD_TIMEOUT_MS = 1_800_000`), `packages/core/src/engine-config.ts` (`buildEngineConfig`:
  how harness config becomes engine config), `packages/rpc-schema/schema/rpc.schema.json` (`memory.curation.*`
  methods: the 1.17.0 expectations), `crates/plur1bus-rpc/build.rs` and `Cargo.toml` (`typify = "0.8"`, `schemars =
  "0.8"`: the generation pattern to copy), `crates/plur1bus-config/src` (how `jsonschema 0.26` is driven).
- `docs/coding-standard.md` §3.1 (Rust naming), §7.1 (error enums), §8 (types and schemas).

**Rules that apply.** The schema is the source of truth; `src/contract/generated.rs` is never edited (it is written
by `build.rs` into `OUT_DIR`). Closed structs: `deny_unknown_fields` on every input type; `camelCase` on the wire.
Members named after the OpenClaw home or runtime are not ported and must not appear in any identifier (hygiene scan).

## Files

- Create: `crates/plur1bus-engine/schema/engine-contract.schema.json`, `crates/plur1bus-engine/schema/engine-config.schema.json`
  (verbatim copy from the engine, see T3), `crates/plur1bus-engine/schema/SOURCES.md` (which commit each schema was
  copied from), `crates/plur1bus-engine/build.rs`, `src/contract/{mod,engine,host,jobs,embedding,memory_ops,admin_ops,
  store_ops,errors,cancel}.rs`, `src/config/{mod,validate,tier}.rs`, `tests/contract_roundtrip.rs`,
  `tests/config_parity.rs`, `tests/fixtures/contract/*.json`, `tests/fixtures/config/{valid,invalid}/*.json`,
  `scripts/check-engine-contract.mjs`, `scripts/test/check-engine-contract.test.mjs`
- Modify: `crates/plur1bus-engine/Cargo.toml` (`[build-dependencies] typify, schemars, serde_json`), `scripts/gen-docs.mjs`
  (a new generated doc `docs/engine-contract.md`), `package.json` only if `docs:gen`/`docs:check` need a new entry,
  `docs/engine-contract.md` (generated), `.github/workflows/ci.yml` only if `docs-hygiene` must run the new check script
- Test: the two Rust test files above, the node test for the check script

## Interfaces

**Consumes:** the crate from RE-00.

**Produces** (every later brief compiles against these exact names):

```rust
// src/contract/cancel.rs — replaces AbortSignal; checked at every stage boundary (fixes host-contract f.1)
pub struct Cancel { /* deadline: Option<Instant>, flag: Arc<AtomicBool> */ }
impl Cancel {
    pub fn never() -> Cancel;
    pub fn with_deadline(at: Instant) -> Cancel;
    pub fn cancel(&self);
    pub fn is_cancelled(&self) -> bool;
    pub fn remaining(&self) -> Option<Duration>;
    pub fn check(&self) -> Result<(), Cancelled>;    // Cancelled { reason: CancelReason::{Caller, Deadline} }
}

// src/contract/errors.rs
pub enum EngineError { Cancelled(Cancelled), Store(StoreError), Embedding(EmbedError), Host(HostError),
    MemoryOp(MemoryOpError /* code: MemoryOpErrorCode from the schema */), NotAvailable { reason: String },
    Invalid { field: String, message: String } }
// Display: "<kind>: <detail>"; no secret, token or text body in any variant.

// src/contract/engine.rs
pub trait Engine: Send + Sync {
    fn contract(&self) -> ContractVersion;                       // ContractVersion("1.17.0")
    fn capabilities(&self) -> &Capabilities;
    fn open(&self) -> Result<(), EngineError>;
    fn close(&self) -> Result<(), EngineError>;
    fn status(&self) -> EngineStatus;
    fn system_supplement(&self, agent: &AgentContext) -> Result<Option<String>, EngineError>;
    fn recall(&self, query: RecallQuery, options: RecallOptions, cancel: &Cancel) -> Result<RecallResult, EngineError>;
    fn capture(&self, turn: TurnRecord, options: CaptureOptions) -> Result<CaptureHandle, EngineError>;
    fn checkpoint(&self, agent: &AgentId, reason: CheckpointReason) -> Result<CheckpointResult, EngineError>;
    fn jobs(&self) -> &dyn JobRegistry;
    fn embedding(&self) -> &dyn EmbeddingService;
    fn models(&self) -> &dyn ModelsService;                      // status(), warm(cancel, refresh)
    fn memory(&self) -> &dyn MemoryOps;
    fn admin(&self) -> &dyn AdminOps;
    fn stores(&self) -> &dyn StoreOps;                           // adopt(path, expected_schema) -> AdoptReport
    fn events(&self) -> EventReceiver;                           // std::sync::mpsc::Receiver<EngineEvent>
}

// src/contract/host.rs — what the engine needs from its host (plan §2.4 lists the dropped members)
pub trait HostServices: Send + Sync {
    fn state_dir(&self) -> &Path;
    fn config(&self) -> EngineConfig;
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError>;
    fn llm(&self) -> Option<&dyn LlmPort>;          // complete(LlmParams, &Cancel) -> Result<LlmResult, HostError>
    fn secrets(&self) -> Option<&dyn SecretPort>;   // get(name) -> Result<Option<SecretValue>, HostError>
    fn egress(&self) -> &dyn EgressGate;            // decide(&Target { scheme, host, port }) -> Decision
    fn emit(&self, event: &str, payload: serde_json::Value);
    fn now_ms(&self) -> i64;
    fn platform(&self) -> &PlatformCapabilities;
    fn journal_backlog(&self) -> Option<JournalBacklog>;
}
pub enum Decision { Allow { address_rules: AddressRules }, Deny { reason: String } }
pub struct AddressRules { pub allow_loopback: bool, pub allow_private: bool, pub allow_metadata: bool }

// src/contract/jobs.rs — JobName (19 variants), JobTrigger, JobOutcome, JobSpec, JobRun, JobCost from the schema
pub trait JobRegistry: Send + Sync {
    fn list(&self) -> Vec<JobSpec>;
    fn run(&self, job: JobName, agent: &AgentId, opts: RunOptions /* trigger, dry_run */, cancel: &Cancel) -> Result<JobRun, EngineError>;
    fn history(&self, agent: &AgentId, filter: HistoryFilter /* job, since, limit */) -> Result<Vec<JobRun>, EngineError>;
}

// src/contract/embedding.rs — EmbeddingIdentity, VectorSpaceIdentity, RerankHit, EmbeddingProbeResult from the schema
pub trait EmbeddingService: Send + Sync {
    fn embed(&self, texts: &[String], kind: EmbedKind /* Query | Passage */, identity: &EmbeddingIdentity, cancel: &Cancel) -> Result<Vec<Vec<f32>>, EngineError>;
    fn rerank(&self, query: &str, docs: &[String], top_n: usize, cancel: &Cancel) -> Result<Vec<RerankHit>, EngineError>;
    fn probe(&self, refresh: bool, cancel: &Cancel) -> Result<EmbeddingProbeResult, EngineError>;
    fn identities(&self) -> Vec<EmbeddingIdentity>;
}

// src/contract/memory_ops.rs and admin_ops.rs: one method per member of types/engine.d.ts `MemoryOps` and `AdminOps`,
// same names in snake_case, (principal: &Principal, agent: &AgentContext) as the last two parameters, plus the
// 1.17.0 curation members from the 9b935ce diff.

// src/config/validate.rs
pub fn validate(raw: &serde_json::Value) -> Result<EngineConfig, Vec<ConfigError>>;  // ConfigError { path, message }
pub fn tier_of(path: &str) -> Tier;   // Basic | Advanced, the same nearest-ancestor rule as plur1bus-config's tier_of
```

## Tasks

### T1 — The contract schema and the generated types (one pull request)

- [ ] **Step 1: write the failing test** `tests/contract_roundtrip.rs`:

```rust
//! Every recorded Node payload deserialises into the generated type and serialises back to the same JSON value
//! (key order ignored). The fixtures are recorded by tests/fixtures/contract/record.mjs from the pinned engine.
use plur1bus_engine::contract::*;

fn roundtrip<T: serde::de::DeserializeOwned + serde::Serialize>(name: &str) {
    let raw = std::fs::read_to_string(format!("{}/tests/fixtures/contract/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), value, "{name}");
}

#[test] fn recall_result_roundtrips() { roundtrip::<RecallResult>("recall-result"); }
#[test] fn capture_result_roundtrips() { roundtrip::<CaptureResult>("capture-result"); }
#[test] fn job_run_roundtrips() { roundtrip::<JobRun>("job-run"); }
#[test] fn memory_card_roundtrips() { roundtrip::<MemoryCard>("memory-card"); }
#[test] fn engine_status_roundtrips() { roundtrip::<EngineStatus>("engine-status"); }
#[test] fn an_unknown_field_in_a_closed_input_is_refused() {
    let bad = serde_json::json!({ "query": "x", "principal": {}, "agent": {}, "extra": 1 });
    assert!(serde_json::from_value::<RecallQuery>(bad).is_err());
}
```

- [ ] **Step 2: record the fixtures.** `tests/fixtures/contract/record.mjs` runs the pinned Node engine (resolve it from
  `packages/core`, where `pnpm install` placed it) with the flat embedder (`testInternals.embeddings` as
  `packages/core/src/bin.ts` builds it, `reranker: null`) on a temporary home, performs one capture, one recall, one
  `jobs.run("gc-run")`, one `memory.list`, one `status()`, and writes the five JSON files. Commit the script and the
  files. Document the command in the file header: `node tests/fixtures/contract/record.mjs` from `packages/core`.
- [ ] **Step 3: run the test** — Expected: FAIL (no `contract` module).
- [ ] **Step 4: write `schema/engine-contract.schema.json`.** One `$defs` entry per exported interface and union of
  `types/engine.d.ts`, doc comments carried into `description`, `additionalProperties: false` on every input type
  (`RecallQuery`, `TurnRecord`, `RecallOptions`, `CaptureOptions`, every `*Request`, every `*Query`), open on
  `DecisionTrace` only. Mark each definition with `x-since: "1.16.0"` or `"1.17.0"`. Drops (not in the schema, the
  reason in `SOURCES.md`): `HostRuntime`, `HostPathOverrides`, `HostCapabilities.pushCriticalButtons`, `mutateConfig`,
  `EmbeddingService.serve`'s IPC address type (RE-D4; the method stays, its result loses `address`/`tokenPath`).
- [ ] **Step 5: generate.** `build.rs` after `crates/plur1bus-rpc/build.rs`: `typify` renders the schema to
  `$OUT_DIR/contract.rs`; `src/contract/mod.rs` includes it and re-exports. Add `#[serde(rename_all = "camelCase")]`
  behaviour through the schema's property names (typify keeps them) and verify `deny_unknown_fields` lands on the
  closed types (typify emits it for `additionalProperties: false`).
- [ ] **Step 6: run the tests** — Expected: 6 passed.
- [ ] **Step 7: the drift check.** `scripts/check-engine-contract.mjs <path to types/engine.d.ts>` lists every exported
  interface/type name and every method name in the `.d.ts` and every `$defs` title and method in the schema, and prints
  the two differences; it exits 1 unless each missing name is in its built-in drop list (`HostRuntime`,
  `HostPathOverrides`, `pushCriticalButtons`, `mutateConfig`). `scripts/test/check-engine-contract.test.mjs` pins the
  drop list and a synthetic mismatch. The script takes the `.d.ts` path as an argument so it needs no engine install in
  the Rust crate's tests; `docs-hygiene` runs it against `packages/core/node_modules/@cyb3rb1ade/plur1bus-memory/types/engine.d.ts`
  (add the step only if the job already has the install; otherwise document the manual command in the README).
- [ ] **Step 8: commit** — `RE-01/T1: engine contract schema and generated types`.

### T2 — Traits, errors, cancellation (one pull request)

- [ ] **Step 1: failing tests** in `src/contract/cancel.rs` (unit tests): `a_deadline_in_the_past_is_cancelled_at_once`,
  `cancel_flips_is_cancelled_and_check_returns_caller`, `remaining_counts_down_and_never_goes_negative`.
- [ ] **Step 2: implement `Cancel`**, `Cancelled`, `CancelReason` as in Interfaces; `remaining()` is `None` for
  `never()`.
- [ ] **Step 3: the traits** exactly as in Interfaces, with `///` docs copied from the `.d.ts` comments; `EngineError`
  with `Display`; `impl From<Cancelled> for EngineError`. No implementation of any trait in this brief — RE-02…RE-07
  implement them; a `FakeHost` (`src/contract/testing.rs`, `#[cfg(any(test, feature = "testkit"))]`) implements
  `HostServices` over in-memory maps for later tests and is produced here.
- [ ] **Step 4:** `cargo test -p plur1bus-engine`, `cargo doc -p plur1bus-engine --no-deps` (no missing-docs warnings on
  `pub` items — the crate has `#![warn(missing_docs)]` from RE-00/CS-1).
- [ ] **Step 5: commit** — `RE-01/T2: engine traits, errors, cancellation`.

### T3 — Engine-config validation at parity (one pull request)

- [ ] **Step 1: copy** `engine/config/engine-config.schema.json` from `98dfe2f` to `schema/engine-config.schema.json`
  byte for byte; `SOURCES.md` records the commit. Add the drift test `the_copied_config_schema_equals_the_pinned_engines`
  in `tests/config_parity.rs`: when `packages/core/node_modules/@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json`
  exists, the two files are byte-identical; when it does not exist, the test **fails** with the message
  "run pnpm test:prep (the engine package is not installed)" — no silent skip (AGENTS.md "Tests lokal").
- [ ] **Step 2: record parity vectors.** `tests/fixtures/config/record.mjs` feeds 30 valid and 30 invalid
  configurations to the Node validator (`engine/config/engine-config-schema.js` — read its exports) and writes each as
  `{ config, valid, errors: [paths] }`. Choose the invalid ones to cover: unknown top-level key, wrong type, out-of-range
  number, a `namespaces` entry with a wrong shape, a `reranker` block without `provider`, a `recall` budget with
  `softBudgetMs > hardBudgetMs`.
- [ ] **Step 3: failing test** `every_recorded_configuration_gets_the_same_verdict` in `tests/config_parity.rs`.
- [ ] **Step 4: implement `config::validate`** with `jsonschema 0.26` compiled once (`OnceLock`), the schema embedded
  with `include_str!`; `ConfigError { path, message }` from the validator's instance path; `EngineConfig` is the
  generated type from T1's schema (`$defs/EngineConfig` referencing the config schema) or a second typify run over the
  config schema — pick the second if the first produces an unreadable type, and say so in the PR.
- [ ] **Step 5: `tier_of`** mirrors `crates/plur1bus-config`'s nearest-ancestor rule over the `x-tier` annotations the
  harness attaches to engine keys in `packages/config-schema` (read `docs/config-engine-keys.md` for the table the
  harness generates); test with three keys of each tier.
- [ ] **Step 6: commit** — `RE-01/T3: engine-config validation at parity with the Node validator`.

### T4 — Generated documentation (one pull request)

- [ ] **Step 1:** extend `scripts/gen-docs.mjs` to render `docs/engine-contract.md` from `schema/engine-contract.schema.json`
  (one section per `$defs` entry: description, properties with types and `x-since`), in the style of `docs/rpc.md`'s
  generation; `--check` mode compares like the other generated docs.
- [ ] **Step 2:** `pnpm docs:gen` then `pnpm docs:check` — Expected: clean; commit the generated file.
- [ ] **Step 3:** AGENTS.md "Docs" paragraph: add `docs/engine-contract.md` to the generated list. Commit —
  `RE-01/T4: generated engine-contract.md`.

## Acceptance

- `cargo test -p plur1bus-engine`: all green, including the config drift test with the engine installed.
- `node scripts/check-engine-contract.mjs <engine>/types/engine.d.ts` exits 0 and prints only the four known drops.
- `pnpm docs:check` clean; `cargo doc -p plur1bus-engine --no-deps` without warnings; clippy and fmt clean; hygiene clean.
- The PR descriptions name the engine commit the schema was written from (`98dfe2f`) and the 1.17.0 commit (`9b935ce`).

## Out of scope

Any trait implementation; the RPC schema additions (`x-server: "engine"`, RE-08); the TypeScript `EngineClient` (RE-08);
the harness's `engine-config.ts` translation (stays in TypeScript until RE-11).

## Hand-off

Four PRs, titles `RE-01/T1` … `RE-01/T4`. The schema PR (T1) is the one other briefs wait for; open it first and keep
T2–T4 small. Any rename of a produced name after T2 merges needs the controller's agreement (RE-02…RE-09 are written
against them).
