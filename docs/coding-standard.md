# Coding standard

How code in this repository is named, commented, shaped, tested and reviewed — for Rust (`crates/`, `apps/desktop`),
TypeScript (`packages/`, `scripts/`, `tests/`, `apps/desktop/ui`) and Python (`clients/python`, `hosts/hermes`), and for
every agent and person writing it. Build and layout instructions are in `AGENTS.md`; merge rules in `CLAUDE.md`. Where
this document and those two disagree, they win. Where this document and the surrounding code disagree, see §5.1 (the
touch rule): match the file you are in, bring new files to the standard.

Two kinds of rule appear below. **Enforced** rules are checked by a script or a compiler flag that CI runs today; the
check is named. **Agreed** rules are reviewed by people and agents until §10 turns them into checks. Nothing here is
optional because it is "agreed" — it is only not yet automated.

## 1. Principles

1. **Correct, then clear, then fast.** A fast wrong answer is the worst outcome a memory engine can give. Optimise with a
   measurement in hand (§6.6), never from a hunch.
2. **Fail closed.** A missing check, an unknown input, an unavailable dependency or an unreadable file refuses the
   operation and says why. Nothing degrades silently: a feature that cannot run reports `degraded`, `skipped` or
   `E_NOT_AVAILABLE` with a reason (`docs/errors.md`).
3. **One source of truth.** Types come from JSON Schema (`packages/rpc-schema`, `packages/config-schema`,
   `packages/log-schema`); docs that describe generated surface are generated (`pnpm docs:gen`); a constant that two
   languages share lives in a schema or a fixture both read (`fixtures/vectors.json`, the address vectors). Hand copies
   are bugs.
4. **Explicit over clever.** Boundaries, budgets, limits and defaults are written down in code and in the schema
   (`x-restart`, `x-tier`, `x-stability`, `x-since`, `x-server`), not implied by behaviour.
5. **No hidden state, no hidden network.** Every file a process writes has a documented place under `<home>`; every
   outbound connection passes the egress policy; every test seam is gated by `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
6. **Secrets never travel in code paths that print.** Not in argv, not in logs, not in traces, not in `--json` output
   except `secret get --reveal`, not in prompts.
7. **A dependency is a decision**, recorded in the PR with its licence, its size and what it replaces
   (`docs/dependency-policy.md`).
8. **Small, verified steps.** One pull request per package of work (AGENTS.md), tests first, every claim in a PR
   description backed by a command and its output.

## 2. Boundaries and hygiene (enforced)

- `scripts/lint-hygiene.mjs` (`pnpm lint`) scans `packages/`, `crates/`, `tests/`, `scripts/`, `apps/`, `clients/` and
  `hosts/`: no "openclaw" string, no `OPENCLAW_*` environment name, no OpenClaw-adapter-shaped import outside its short
  allow-list; no private key material and no forbidden secret or image filenames among tracked blobs; the
  installer/supervisor boundary (`crates/plur1bus/src/install` is reached only from `setup`, `update` and `1staid
  repair`, never from `supervisor/`); the extension boundary (the supervisor-safe files of `crates/plur1bus/src/ext`
  never link the `.p1x` parser, verifier, packer or extractor). `node scripts/lint-hygiene.mjs --self-test` runs its
  regression suite; extend the allow-list only with a reason in the same PR.
- `scripts/release/check-source-quality.mjs`: every `tsconfig` is strict; no retired theme token.
- `scripts/check-i18n.mjs`: de/en catalogues complete, placeholders matched, no dead key, no hard-coded user-visible
  string outside a catalogue (allow-list entries need a `reason`).
- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`
  (`deny.toml`: licence allow-list, no unknown registry or git source).
- `.editorconfig`: UTF-8, LF, final newline, trailing whitespace trimmed (not in Markdown), two-space indent for
  TypeScript, JavaScript, JSON and YAML.

## 3. Naming

The same concept has the same name in every language and on the wire: `agentId`, `fingerprintId`, `identityId`,
`capChars`, `softBudgetMs`. When a name crosses a boundary it changes only its case convention, never its words.

### 3.1 Rust

| Thing | Convention | Examples in the tree |
|---|---|---|
| crates | `plur1bus-<area>` | `plur1bus-rpc`, `plur1bus-config`, `plur1bus-log-schema`, `plur1bus-ext` |
| modules, files, functions, locals | `snake_case` | `supervisor::child::core_spec`, `install::pins::trust_seams_allowed` |
| types, traits, enum variants | `UpperCamelCase` | `RestartPolicy`, `RoleKind`, `Target::LinuxArm64` |
| constants, statics | `SCREAMING_SNAKE_CASE` | `CORE_READY_FLOOR`, `STEP_ORDER`, `RESERVED_NAMES` |
| error types | one `enum <Area>Error` per subsystem with `Display`; variants name the failure, not the place | `ExtError`, `BackupError`, `ServiceError`, `UpdateError`, `StepError`, `OpError` |
| test functions | a sentence in `snake_case` that states the behaviour | `repair_never_removes_a_live_endpoint`, `admin_commands_fail_as_json_without_a_core` |
| seams and env | `PLUR1BUS_TEST_<WHAT>` for seams, `PLUR1BUS_<WHAT>` for real overrides | `PLUR1BUS_TEST_EXT_FAIL_AT`, `PLUR1BUS_NODE_MIRROR` |
| `--json` schema ids | `<command>.<sub>/<major>`, inserted by `output.rs`'s `document()` | `memory.list/1`, `1staid.repair/1`, `error/1` |

No `I`/`T` prefixes, no Hungarian suffixes, no abbreviations that are not already words in the tree (`cfg`, `ctx`,
`id`, `rpc`, `acl` are; `mgr`, `svc`, `tmp2` are not). A boolean reads as a question: `read_only`, `is_live`,
`honours_seams`.

### 3.2 TypeScript

| Thing | Convention | Examples |
|---|---|---|
| packages | `@plur1bus/<area>`, directory `packages/<area>` | `@plur1bus/module-api`, `@plur1bus/channels-telegram` |
| files | `kebab-case.ts`; a file is named after the one thing it exports | `config-source.ts`, `restore-reapply.ts`, `engine-config.ts` |
| types, interfaces, classes | `UpperCamelCase`, no `I` prefix | `HarnessConfig`, `RpcError`, `EngineClient` |
| functions, variables, properties | `camelCase` | `buildEngineConfig`, `checkEngineEgress` |
| module-level literal constants | `UPPER_SNAKE_CASE` | `E5_SMALL`, `BGE_RERANKER`, `ENGINE_REAPPLY_MODULE` |
| closed value sets | a `const` object or a string-literal union, never `enum` (`erasableSyntaxOnly`) | `type JobTrigger = "cron" \| "manual" \| …` |
| tests | `test/**/*.test.ts`; `describe` for the unit, `it("…")` a full sentence that states the behaviour; a test that pins observed rather than specified behaviour starts with `characterization:` | `it("the index must pin the root version and the revocation file …")` |
| RPC methods, notifications | `group.action`, `camelCase` segments, closed params | `memory.recall`, `admin.reembed.plan`, `config.watch` |
| config keys | `camelCase`, every key with `x-restart` and `x-tier` | `core.recall.hardBudgetMs`, `channels.telegram.webhook.secret` |
| CLI | subcommands and flags `kebab-case`; a flag is a noun or an adjective (`--dry-run`, `--tier`), never a sentence | `memory reembed --plan`, `1staid bundle --out` |
| environment | `PLUR1BUS_*` only (§2) | `PLUR1BUS_CORE_JS`, `PLUR1BUS_ALLOW_TEST_INTERNALS` |
| events and log records | catalogue names from `packages/log-schema/schema/catalogue.json`; a new event needs an entry with an example | |

### 3.3 Python

PEP 8 names; modules `snake_case`; the client stays stdlib-only; generated `_schema.py` is never edited.

### 3.4 Data at rest

- JSON on the wire and in files: `camelCase` keys; `schema` is the reserved top-level key of every `--json` document.
- SQL: `snake_case` tables and columns (`key_hash`, `expires_at`). The `speaker_mappings` table's camelCase columns are
  a legacy exception the engine's store compatibility keeps; nothing new follows it.
- Files under `<home>`: `kebab-case` with the format as the extension (`turn-journal.jsonl`, `run-state.json`); a hidden
  (dot) file only for state no operator should ever edit by hand (`.emotional-state.json`).

### 3.5 User-visible text

English and German through the de/en catalogues (`scripts/check-i18n.mjs`), never a literal in code. Neutral wording in
both languages: no gendered forms (owner decision, memory-tree spec §13). Error messages name the thing and the next
step: `engine embedding endpoint <host> is refused by the egress policy (<reason>); list the host in egress.allowHosts`.
Code, identifiers, comments and documentation are English; an owner decision quoted in a doc stays in the language it was
made in.

## 4. Comments and documentation in code

A comment records what the code cannot say: **why**, which decision, which invariant, which failure it guards. It never
narrates the statement below it.

- **Every file starts with a header** — Rust `//!`, TypeScript a `/** … */` or `//` block above the imports — of one to
  ten lines: what the module is for, what it owns, what it deliberately does not do. Readers are told to "read the
  file's own header comment" (`fake-core.mjs`); make that true.
- **Every public item has a doc comment** (`///`, `/** */`) that states the contract: inputs, result, errors, limits,
  side effects. A one-liner is fine when the name already says most of it.
- **Decisions are cited by id.** The tree does this already: `ruling R13`, `H3-R22`, `B16`, `ADR-012 §10.7`,
  `owner decision 2026-10-18`, `#601`. A rule that exists because of a decision carries the id, so a reader can look up
  the reasoning instead of re-deriving (or re-litigating) it.
- **Invariants and the reason for a limit are written where they are enforced**: `// 0 = "no known bound in that
  direction", not the Unix epoch`, `// Engine 1.16 rejects even a disabled unknown media key`.
- **TODOs carry an owner.** `TODO(#<issue>)` or an entry in `docs/reference/todo-inventory.md`; a bare `TODO`, `FIXME`
  or `XXX` does not merge (§10, CS-3). A known gap in behaviour is written as `KNOWN GAP` with the condition that closes
  it (AGENTS.md uses the phrase for the tombstone re-apply).
- **No commented-out code**, no change-log comments (`// changed 2026-10-23`), no author tags — git has them.
- **Generated files are never edited**; they say so in their first line, and `pnpm gen` / `pnpm docs:gen` regenerate
  them.
- **Density follows the file.** A dense file (one idea per line, long lines) keeps its density where you touch it; a new
  file follows §5.

Documentation outside code: hand-written docs in `docs/*.md`, decisions in `docs/adr/`, specs and plans in
`docs/superpowers/{specs,plans}` (`YYYY-MM-DD-<slug>.md`), a `README.md` per module (AGENTS.md "Module README
convention"). A PR that changes public behaviour, configuration, errors or operator actions changes the doc that
describes them in the same PR and names the validation command it ran (`skills/documentation-standards`).

## 5. Code shape

### 5.1 The touch rule

Existing files are not reformatted for their own sake: a PR changes the lines its purpose needs and leaves the rest,
including a style the standard would not choose today. Reformatting is its own PR, whitespace-only (`git diff -w`
empty), one package at a time (§10, CS-2). New files follow the standard from the first line.

### 5.2 Formatting (Rust enforced, TypeScript agreed)

- Rust: `rustfmt` defaults (100 columns), no `rustfmt.toml`; `cargo fmt --all -- --check` in CI. Clippy at
  `-D warnings` on all targets.
- TypeScript, JavaScript: two-space indent (`.editorconfig`); **120 columns** for new code, with one exception — a
  test's `it("…")` sentence may run over rather than be shortened into vagueness. One statement per line; no `a; b;`
  chains, no statement after a `{` on the same line, no single-line `if (x) { … } else { … }` with bodies. Double quotes
  for strings (the majority in `packages/core`); template literals only when interpolating. Measured on 2026-10-23:
  11.2 % of the lines in `packages/core/src` exceed 120 columns and 4 % exceed 160 — that is the backlog CS-2 clears
  file by file, not a licence to add to it.
- Python: PEP 8, 100 columns.

### 5.3 Size and structure

- A function fits on one screen (about 40 lines) and does one thing; a file owns one responsibility and is split when it
  stops fitting in a reader's head (around 500 lines is where to ask). Files that change together live together: split
  by responsibility, not by layer.
- Early returns over nesting; at most one level of ternary; no boolean parameters where two functions or an enum say
  what is meant (`OpenMode::ReadOnly`, not `open(path, true)`).
- Pure core, thin edges: parsing, validation and decisions are pure functions over plain data (`policy/decide.ts`,
  `supervisor/state.rs`), I/O happens at the boundary that calls them. This is what makes the tree testable without
  processes.
- No globals that hold state; a module-level cache is a named object with an explicit key, a size or TTL bound, and a
  way to reset it in tests.
- TypeScript specifics: ESM only, `node:` prefixes for built-ins, `import type` (`verbatimModuleSyntax`), no default
  exports, no barrel files that re-export whole packages, `unknown` at every JSON boundary narrowed by a validator —
  `any` only with a comment that says why the type cannot be expressed (`plain()` in `engine-config.ts` is the pattern:
  one small function owns the `any`, nothing else sees it).
- Rust specifics: `pub(crate)` by default, `pub` only for the crate's API; `&str`/slices in signatures, owned types in
  results; `impl Trait` for ports (`Runner`, `Monitor`), `dyn Trait` where the implementation is chosen at run time;
  `#[derive(Debug, Clone, PartialEq, Eq)]` on plain data; `serde` with `rename_all = "camelCase"` and
  `deny_unknown_fields` on closed inputs.

## 6. Efficiency

"As efficient as possible" means: within the budgets the contract states, with the least work that is still correct and
readable, proven by a measurement.

### 6.1 Budgets are part of the contract

A recall has `softMs`, `hardMs` and `capChars`; a job has a deadline; a parser has a byte limit (`packages/log-schema`,
`ext` zip audit); a prompt has a cap. Every such limit is a named constant or a config key with `x-tier`, is checked
where the work happens (not only at the entry), and produces a typed outcome when hit (`degraded.reason: "timeout"`,
`Deferral { kind: "clipped" }`), never an exception. A cancellation (`AbortSignal`, `Cancel`) is honoured at every stage
boundary — accepting one and dropping it (`docs/host-contract.md` f.1) is a defect.

### 6.2 Do I/O once, in bulk, at the edge

- One query per table, one embedding batch (`embeddingBatchSize`) per capture, one prepared statement per shape, one
  config read per change (`config.watch`, not polling the file).
- Read files once at start where the content is static (`include_str!` for schemas, `precompileMethods` for ajv
  validators — a cold compile is never mistaken for request latency).
- Node: never block the event loop for more than a few milliseconds outside start-up; synchronous `fs` only in start-up
  paths; streams for anything that can be large.
- Rust: threads and `std::sync` first; an async runtime only where a dependency forces one, and then owned by that crate
  behind a synchronous facade (the engine crate wraps Lance's `tokio` runtime; the supervisor and CLI never see it).

### 6.3 Allocation and copies

- Rust: borrow in hot paths (`&str`, `&[f32]`), `Vec::with_capacity` when the size is known, no `clone()` inside a loop
  without a comment, `Cow<str>` when a value is usually unchanged, iterators over collected temporaries.
- TypeScript: `Float32Array` for vectors (the neo-arch cosine "without array conversion" is the model), `Map`/`Set` for
  lookups, no `[...a, x]` or `concat` inside a loop (quadratic), `structuredClone` only when a deep copy is actually
  needed and never `JSON.parse(JSON.stringify(x))`, no regular expression built inside a loop.
- Both: strings are compared and hashed in one normalised form, computed once (`normalizeEmbeddingConfig` then
  `fingerprintId`).

### 6.4 Caches

Every cache has a key that includes everything the value depends on (model, dimensions, template version, normalised
input), a TTL or a size bound, an eviction path that runs without an operator, and a test that proves a changed input
misses. `embeddings` and `llm_results` in the engine, `cacheVersion` fields, `SKILL_DECISION_CACHE_VERSION` are the
patterns; a retryable failure is never cached as a negative result (change package CP-7 of the engine plan).

### 6.5 Start-up and footprint

Heavy optional dependencies load lazily on first use (`@napi-rs/keyring` on the first `secret.*` call); the core starts
without touching the keychain, the network or a model. A binary that an operator installs is as small as its job allows
(`plur1bus-attest` and the planned `plur1bus-engine` are separate binaries so `plur1bus` itself stays small).

### 6.6 Measure

`pnpm bench` (`scripts/bench/`), the startup and budget catalogue jobs in CI, `docs/ops/metrics.md`, and the reference
hardware runs of `docs/host-contract.md` (b) are where numbers come from. A PR that claims a performance effect quotes
the command and the before/after numbers. A hot path that is optimised without a measurement is rejected in review, as
is a measurement without a reproducible command.

## 7. Errors, logging, security

### 7.1 Errors

- Rust: a typed `enum <Area>Error` per subsystem with `Display`; `?` everywhere; `unwrap()`/`expect()` only in tests or
  for an invariant the line above has just established, with the invariant in the `expect` message. `Result<T, String>`
  exists at CLI edges today (115 sites); no new library code adds to it. Exit codes per `docs/errors.md`
  (`check-cli-exit-codes.mjs` checks them). A `match` on an error enum is exhaustive — no `_ =>` arm that hides a new
  variant.
- TypeScript: `RpcError(code, message)` with a code from the closed set in `rpc.schema.json`; never `throw "string"`,
  never a swallowed `catch {}` — a deliberate swallow has a comment that says what is being ignored and why. Failures
  reach the CLI and the API as `error/1` documents.
- Both: an error message names the thing and the next step (§3.5); it never contains a secret, a token or a prompt.
  Refusal before side effects: validate, then act (`stage`/`commit` with per-step rollback is the pattern for anything
  that writes more than one file).

### 7.2 Logging and traces

Only catalogue events (`packages/log-schema/schema/catalogue.json`, mirrored by `crates/plur1bus-log-schema`), through
the schema's writers, with the redaction rules as data. Levels mean what the OTel map says. A decision trace carries
ids, scores and reasons; texts only up to the configured cap. `audit.log` records are append-only and hash-chained
(`docs/audit-chain.md`); nothing else writes there.

### 7.3 Security

- Secret values enter through stdin or the secret store, never argv or an environment variable for a value
  (`secret set`, `login`); they leave only through `secret get --reveal`. Config holds secret **names**, with the one
  known exception the backup redactor tracks by a drift test.
- Paths pass `securePath`; symlinks and Windows junctions are refused where the Node engine refused symlinks; `run/`
  and pipes carry the Windows ACL of `crates/plur1bus-rpc/src/acl.rs`.
- Deny by default: egress allow-lists, `policy.decide()` for every tool call, RBAC for every human principal, closed
  RPC params (`additionalProperties: false`), byte limits on every parser.
- Test seams are compiled in but honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; a seam that is reachable without
  it is a security bug, not a convenience.
- No `eval`, no dynamic `import()` of a path an input controls, no shell string concatenation — argv arrays only.

## 8. Types, schemas, data

- JSON Schema first: a new RPC method, config key or log event starts in its schema with every annotation
  (`x-server`, `x-stability`, `x-since`, `x-restart`, `x-tier`), then `pnpm gen`, then code in both languages, then
  `pnpm docs:gen`. A method without `x-server`, a key without `x-restart` is a bug (AGENTS.md "Conventions").
- `--json` prints the raw RPC value, never a re-serialised typed struct (ruling R13); every document carries `schema`
  (ruling G15); ids are append-only (ADR-016).
- TypeScript compiles with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`: an optional property is absent or present, never `undefined` by assignment; an index read is
  checked; a `.ts` file runs under `--experimental-strip-types` without a transform.
- Rust mirrors the same semantics: `Option<T>` with `skip_serializing_if = "Option::is_none"` for optional properties,
  `deny_unknown_fields` for closed params, generated types (`typify`) for anything a schema defines.
- Versioned formats: a file or table that persists carries a version (`STORE_SCHEMA_VERSION`, `plur1bus.backup/1`,
  catalogue versions); a reader accepts what the writer of the previous version produced; a writer never changes a
  format without a version bump and a migration path.

## 9. Tests

- **Test first.** Write the failing test, run it, make it pass, run it again, commit (`superpowers:test-driven-development`).
  The test's name is the behaviour (§3); one behaviour per test; assertions on values, not on "no throw".
- **No network, no clock, no randomness** in unit tests: fixtures and local stub servers (`packages/providers`),
  `FakeClock`, injected seams (`flat-embedder`, `PLUR1BUS_SERVICE_FAKE`, `FAKE_CORE_*`), recorded provider answers for
  LLM-driven paths. A test that depends on a real service is a system test under `tests/system` or `tests/e2e`, gated by
  its documented environment variable, and **fails** rather than skips when its `*_REQUIRED=1` is set.
- **Fixtures over mocks of our own code.** Mock the boundary (a provider, the OS), not the module next door.
- **Golden and parity vectors** for anything two implementations must agree on (`fixtures/vectors.json`, the address
  vectors, the engine parity goldens). A golden changes only with a cited decision or change package in the commit body.
- **Characterisation tests are labelled** (`characterization:`) so nobody mistakes observed behaviour for a spec.
- **Coverage floors where they exist are kept** (`packages/media`: 85 % lines, functions, branches); a new library
  package declares one.
- **Never skip, disable or quarantine a test to get green** (CLAUDE.md). A flaky test is made deterministic or its cause
  is fixed; "flake" is not a root cause.
- Long local runs go to the background with their output in a log file (AGENTS.md); CI is never polled in a loop.

## 10. Enforcement plan

The agreed rules above become checks in these packages, one PR each, none of them changing behaviour.

| Id | What | Where | Owner decision |
|---|---|---|---|
| CS-0 | Publish this standard; link it from AGENTS.md | this PR | — |
| CS-1 | Rust lint policy as `[workspace.lints]` (below), inherited by every crate with `[lints] workspace = true`; measure the warning count per lint first (`cargo clippy -- -W clippy::<lint>`), then set `warn`/`deny` so CI's `-D warnings` stays green after the fixes in the same PR | root `Cargo.toml`, every `crates/*/Cargo.toml`, `apps/desktop` | which lints start at `deny` |
| CS-2 | A TypeScript formatter at 120 columns, applied package by package in whitespace-only PRs, `--check` on the formatted set in `pnpm lint`; until then §5.2 is reviewed by hand | `package.json`, `scripts/release/check-source-quality.mjs` | tool (recommended: Prettier 3, `printWidth: 120`, `trailingComma: "all"`; Biome if a Rust-native toolchain is preferred) and order of packages |
| CS-3 | `check-source-quality.mjs` gains: `TODO`/`FIXME`/`XXX` without `(#n)` or an inventory entry; `catch {}` without a comment; a changed TypeScript line over 160 columns; a new file without a header comment | `scripts/release/check-source-quality.mjs` + its node tests | — |
| CS-4 | `.plur1bus-verifiers.json` with the four argv arrays (`format`, `lint`, `typecheck`, `test`) so the coding gate of `skills/coding-standards` runs this repository's real commands | repo root | — |
| CS-5 | Python: `ruff` (format + lint, PEP 8 at 100 columns) for `clients/python` and `hosts/hermes` in the `python-host` job; the client stays stdlib-only at run time | `pyproject.toml`, `ci.yml` | adopt or defer |

Target `[workspace.lints]` for CS-1 (the levels are the target state; CS-1's measurement decides the first step):

```toml
[workspace.lints.rust]
unsafe_op_in_unsafe_fn = "warn"
unused_qualifications = "warn"

[workspace.lints.clippy]
all = { level = "deny", priority = -1 }
dbg_macro = "deny"
todo = "deny"
unimplemented = "deny"
unwrap_used = "warn"          # tests: #![cfg_attr(test, allow(clippy::unwrap_used))]
expect_used = "warn"
panic = "warn"
large_enum_variant = "warn"
needless_pass_by_value = "warn"
```

Library crates add `#![warn(missing_docs)]` and `#![warn(clippy::print_stdout, clippy::print_stderr)]` in their
`lib.rs`; the `plur1bus` binary prints through `output.rs` and keeps stdout.

## 11. Commits, pull requests and the author's checklist

- Commits are authored as `Cyb3rb1ade <cyb3rblade@me.com>`; trailers (co-author, session links) are kept. Subject in the
  imperative, under 72 characters, no trailing period; the body says **why** and names the decision, issue or change
  package (`ruling R13`, `#601`, `CP-5`). Generated files are regenerated in the commit that changes their source.
- One pull request per package of work; a stacked PR names its base. No force-push, rebase, amend or stash on a shared
  branch; a merge commit brings the base in. Drafts are not touched by the merge rules (CLAUDE.md).
- The PR description states what changed and why, which docs changed, and **how it was verified**: the exact commands
  and their result, including what could not be run locally and why (for example the private engine package).
- Review replies are technical: a finding is verified against the code before it is implemented or declined
  (`superpowers:receiving-code-review`).

Before requesting review, the author has run and can quote:

```text
[ ] node scripts/check-toolchain.mjs                   Node 24.21, pnpm 10, Rust 1.95
[ ] pnpm lint                                          typecheck, source quality, hygiene, i18n
[ ] pnpm test  (or the package's test script)          and the system suites the change touches
[ ] cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
[ ] pnpm gen && pnpm docs:gen                          when a schema, clap tree or route table changed; diff committed
[ ] pnpm docs:check                                    links, commands, generated docs
[ ] cargo deny check / node scripts/audit-deps.mjs     when a dependency changed; licence and size in the description
[ ] no secret, token or private key in the diff; no new TODO without an owner; no skipped or disabled test
[ ] every new public item has a doc comment; every new file has a header; every new limit is a named constant or key
[ ] the PR description quotes the commands above and their output
```
