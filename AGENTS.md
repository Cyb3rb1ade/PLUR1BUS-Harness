# AGENTS.md

The harness edition of "how does an agent build, test and find things here." (The engine repo,
`openclaw-plur1bus-memory`, has its own `AGENTS.md`; this one is for `PLUR1BUS-Harness`.)

## What this repo is

`PLUR1BUS-Harness` is the harness: a Rust CLI + supervisor (`crates/plur1bus`), a TypeScript core
process that binds the engine to a JSON-RPC surface (`packages/core`), the schemas that generate
both sides' types (`packages/rpc-schema`, `packages/config-schema`), and a module API for future
first- and third-party modules (`packages/module-api`), and the WebMCP mapping (`packages/webmcp`). The memory engine itself lives in a
separate repository, `openclaw-plur1bus-memory` (published as `@cyb3rb1ade/plur1bus-memory`), and
is consumed here **pinned to an exact commit** — never a `^`/`~` range, never `link:`, in any
committed lockfile (see `packages/core/package.json`'s dependency). Local development may use
`pnpm link --global` against a working copy of the engine, but its effect must never be committed.

## Toolchain

- **Node 24.21**, not the container's default `node` (v22). Always put it first on `PATH`:
  ```bash
  export PATH=/home/claude/.node24/bin:$PATH
  node -v   # must print v24.21.0
  ```
- **pnpm 10** workspaces (`pnpm-workspace.yaml`, `packageManager: pnpm@10.28.0`). Some names are
  pnpm built-in commands (`docs` among them), which is why the docs script is called `docs:gen`;
  if a root script ever collides with a built-in, run it as `pnpm run <name>` so the workspace
  script runs and not pnpm's own command.
- **Rust 1.95** (`rust-toolchain.toml`, with `clippy` and `rustfmt`), one Cargo workspace under
  `crates/`.
- `node scripts/check-toolchain.mjs` (or `pnpm check`) verifies the installed Node/pnpm/cargo meet
  the floors in `package.json#engines` and `rust-toolchain.toml` and fails loudly if not — run it
  first when something behaves oddly in a fresh shell.

## Build / test / lint

Root scripts (`package.json`), each fanning out to every workspace package with
`pnpm -r --workspace-concurrency=1 <script>`:

| Command | Does |
|---|---|
| `pnpm gen` | Regenerates generated sources: `packages/rpc-schema/generated/*` (from `schema/rpc.schema.json`) and `packages/config-schema/fixtures/*` (from `schema/config.schema.json` via `src/index.ts`). Run before `build` after touching either schema. |
| `pnpm build` | `esbuild`-bundles each TypeScript package to `dist/` (ESM, `--packages=external`, Node 24 target). |
| `pnpm test` | Runs every package's `test` script (see below) plus each package's own `gen`/build-adjacent step where its `test` script needs one (e.g. `config-schema` and `rpc-schema` regenerate before testing). |
| `pnpm typecheck` | `tsc -p tsconfig.base.json --noEmit` across all package sources. |
| `pnpm lint` | `pnpm typecheck` + `node scripts/lint-hygiene.mjs` (below). |
| `pnpm docs:gen` | Builds the CLI (`cargo build -q -p plur1bus`), then regenerates `docs/config-engine-keys.md` (`scripts/gen-engine-keys.mjs`) and `docs/rpc.md` + `docs/cli.md` + `docs/config.md` (`scripts/gen-docs.mjs`). |
| `pnpm docs:check` | Builds the CLI, then `scripts/gen-docs.mjs --check`: fails when `docs/rpc.md`, `docs/cli.md` or `docs/config.md` differs from what the schema and the clap tree produce. CI runs it. |

One crate (from the repo root):

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

One package's tests directly (no build step, no `dist/`):

```bash
cd packages/core && node --experimental-strip-types --conditions=source --test test/**/*.test.ts
```

That's the shape of it; `scripts/test-package.mjs` (used by every package's `test` script) actually
runs `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test
--test-concurrency=1 test/**/*.test.ts` — copy that exactly if running a single package's tests by
hand.

`--conditions=source` matters for the packages other packages import as dependencies —
`packages/rpc-schema`, `packages/config-schema`, `packages/module-api`, `packages/webmcp` — whose `exports` map is
`{ "source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }`; with that
flag, a test importing `@plur1bus/rpc-schema` etc. reads the TypeScript **source**, never a
possibly-stale `dist/`. `packages/core` is different: it's the process entry point, not a library
other packages import via `exports` (its `exports` is just `{ ".": "./dist/index.js" }`, and its own
tests import its `src/*.ts` files directly by relative path, not through the package's own export
map), so it has no `source` condition to add. `--experimental-strip-types` runs `.ts` directly, no
separate transpile step.

System (stack-level) test, run against a built release binary — see `.github/workflows/ci.yml`:

```bash
cargo build --release -p plur1bus
PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/*.test.ts
```

Env vars that matter when driving the core directly instead of through the CLI:

- `PLUR1BUS_BIN` — the `plur1bus` binary a system test shells out to.
- `PLUR1BUS_CORE_JS` — path to the built core entry (`packages/core/dist/core.js`); `plur1bus core
  run` and the supervisor's own spawn (`supervisor::child::core_spec`) both use this instead of the
  (not-yet-installed, 2a-H3b `setup`) `<home>/runtime/core/core.js`.
- `PLUR1BUS_NODE` — the Node binary `plur1bus core run` and the supervisor exec; falls back to
  `<home>/runtime/node-*` (2a-H3b) then whatever `node` is on `PATH`. Must name `node`/`node.exe`
  directly — never a shell shim (`.cmd`, a wrapper script) — because the supervisor's identity
  checks require the reported child pid to be the real Node process (ADR-012 §10.7).
- `PLUR1BUS_ALLOW_TEST_INTERNALS=1` — required alongside `--test-internals flat-embedder` on
  `packages/core/dist/core.js` (see below); refused without it. Also gates the supervisor-only test
  seams below.
- `PLUR1BUS_SUPERVISOR_TIME_SCALE=<float>` — multiplies every supervisor duration (backoff, health
  interval, hang/kill thresholds, the stable-ready window); must be finite and > 0, else the
  supervisor exits 2. Requires `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
- `PLUR1BUS_SOAK_TURNS`, `PLUR1BUS_SOAK_SEED` — the kill-soak system test's turn count (default 200
  in CI, 1000 in the nightly) and its mulberry32 seed (printed as a diagnostic either way, so a
  failing run can be replayed — though replay reproduces only the kill schedule, not timing,
  outages or journal replays).
- `PLUR1BUS_SOAK_RECALL_BUDGET_MS` — the kill soak's per-`memory recall` wall budget (default 1000; the nightly's
  1 000-turn run sets 3000 because recall slows as the agents' tables grow).
- `PLUR1BUS_REAL_MODELS=1` (with optional `PLUR1BUS_MODELS_CACHE=<dir>` for the ~600 MB download) — the
  real-model acceptance (`tests/system/two-session-recall.test.ts`, criterion 1). `PLUR1BUS_SYSTEM_INTERNALS`
  picks the flat seam's variant otherwise (`flat-embedder-cold`, see below).
- `PLUR1BUS_CI_RECALL_HARD_MS=<ms>` — ruling H3-R26, set only by the nightly: shared CI runners are not reference
  hardware, so the test raises the test home's `core.recall.hardBudgetMs` to this value (a slow runner must not
  abort the recall; both measured recalls must still answer `degraded: null`) and reports the 400 ms
  (`timing.totalMs`) / 600 ms (CLI wall time) targets as diagnostics plus a GitHub Actions `::warning::` instead of
  failing on them. **The strict acceptance runs on reference hardware with it unset**, where the targets are
  asserted:

  ```bash
  cargo build --release -p plur1bus && pnpm build
  PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_REAL_MODELS=1 PLUR1BUS_MODELS_CACHE=~/.cache/plur1bus-models \
    node --experimental-strip-types --test tests/system/two-session-recall.test.ts
  ```
- `PLUR1BUS_SERVICE_TEST=1` — required, alongside `PLUR1BUS_SERVICE_FAKE` unset, for
  `tests/service_real.rs` to touch a real systemd/launchd/Task Scheduler installation instead of
  being skipped; `PLUR1BUS_SERVICE_FAKE=<dir>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) instead
  selects the fake service-manager seam (`crates/plur1bus/src/service/fake.rs`) that every other
  service test runs against.
- `PLUR1BUS_SERVICE_MANAGER=launchd` — set by the launchd unit itself (`service/launchd.rs`'s
  rendered plist always writes it first in `EnvironmentVariables`); the supervisor reads it to remap
  its own non-transient exit codes 2 and 3 to 0 before exiting, so launchd's `KeepAlive =
  { SuccessfulExit = false }` does not loop a usage error or a lost single-instance race forever
  (`supervisor::exit_code`, B16, ADR-012 §10.7). Not meaningful outside a launchd-installed service.
- `PLUR1BUS_MODULE_API_CURRENT=<n>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — overrides the
  supervisor's own module API version (module-guide.md "API-version policy"; `modules::manifest`).
- `PLUR1BUS_FIXTURE_MODULE=<dir>` — where a Rust test finds the built fixture module to install
  into a test home; default `packages/module-fixture/dist` (`pnpm build` builds it before `cargo
  test`, which is why CI always runs the TS build first).
- `FAKE_CORE_RESTART_PENDING=1`, `FAKE_CORE_WATCH_CONFIG=1`, `FAKE_CORE_LATER_MODE=<mode>`,
  `FAKE_CORE_CONFIG_CHECK=1` (all with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — seams on
  `crates/plur1bus/tests/fixtures/fake-core.mjs` used only by the supervisor's own Rust tests: a
  one-shot `core.status.config.restartPending`, a fake core that calls `config.watch` at start and
  logs `config-watched`, a mode that changes for every core of a home after the first, and a fake
  core that rejects a configuration the same way the real core's `config.json` validation would.

## Where things live

| Path | Language | Package | Purpose |
|---|---|---|---|
| `crates/plur1bus` | Rust | binary `plur1bus` | CLI + supervisor: `agent`, `memory` (including `memory list/show/forget/correct/share/state/propose/proposals list\|accept\|reject`, the MemoryOps surface, `crates/plur1bus/src/commands/memory_ops.rs`), `dreams`, `config` (`get`/`set`/`schema`, each with `--tier basic\|advanced`, routed through the supervisor's `config.get\|set\|watch` when one answers — ADR-013 §5), `module` (`list\|graph\|install\|uninstall\|start\|stop\|restart`, `src/commands/module.rs`, module-guide.md), `admin` (`obsidian detect\|prepare\|confirm`, `migrate`, `embedding probe\|serve`, `src/commands/admin.rs`, B15 — never exposed over WebMCP, see Conventions), `core` (internal), `daemon start\|stop\|restart\|status` (`src/commands/daemon.rs`), `service install\|uninstall\|status` (`src/commands/service.rs`), `1staid check` (`src/commands/firstaid.rs`, read-only diagnostics) — all real — plus the hidden `supervise` subcommand (`src/supervisor/`, spawned by `daemon start`/the OS service, never run directly by a user) and still-stubbed `setup`, `update`, `user`, `model`, `login`, `channel`, `project`, `import`, `uninstall`, `1staid repair` (relabelled `2a-H3b-b` in their help text and `--json` `milestone` field). Every command supports `--json`, and every `--json` document carries a top-level `schema` id (see Conventions). |
| `crates/plur1bus/src/supervisor` | Rust | (part of `plur1bus`) | The supervisor itself: `mod.rs` (state machine, restart scheduler, `SupervisorState`/`Shared`, slots as role-keyed `Slot`s — core and modules alike), `modules.rs` (the module lifecycle: `ModulesView`/held-back reasons, `start_modules`, `reconcile_stop`/`reconcile_start`, the `module.*` op handlers, `module_list`), `server.rs` (the `supervisor.auth`/`daemon.*`/`config.*`/`module.*` RPC server), `config.rs` (owns `config.json`: `ConfigState`, the polling watcher, `set`, live appliers, B18's invalid-file handling), `subscribers.rs` (per-connection notification queues for `config.watch`/`module.watch`), `child.rs` (`Monitor`: spawn, health polling, hang-kill, backoff, `module_spec`/`module_plan`), `adopt.rs` (peer-credentialed adoption of an already-running core or module, `Peer`, `probe_child`), `state.rs` (`Role`/`RoleKind`, `Health`, `CrashReason`, `RestartPolicy`, `Backoff`, pure and unit-tested), `logfile.rs` (`RotatingFile`, size-based log rotation), `pipe_windows.rs` (the Windows named-pipe ACL and overlapped I/O, `cfg(windows)`). See ADR-012 §10, ADR-013 §5, module-guide.md. |
| `crates/plur1bus/src/modules` | Rust | (part of `plur1bus`) | Module manifests independent of the supervisor's runtime state: `manifest.rs` (`Manifest`, `parse_manifest`, `RESERVED_NAMES`, the API-version policy), `graph.rs` (`band`, `graph`, `start_order`), `install.rs` (`stage`/`commit`/`uninstall`, `InstallError`, staging recovery, B14). See module-guide.md. |
| `crates/plur1bus/src/service` | Rust | (part of `plur1bus`) | OS service registration: `mod.rs` (`Manager`, `Unit`, `Runner` trait), `systemd.rs`, `launchd.rs` (writes `PLUR1BUS_SERVICE_MANAGER=launchd`, B16), `schtasks.rs` (one renderer/installer per OS), `fake.rs` (the `PLUR1BUS_SERVICE_FAKE` test seam). See ADR-012 §10.6, §10.7. |
| `crates/plur1bus-rpc` | Rust | lib | JSON-RPC client types and transport for the core's, the supervisor's and a module's RPC surfaces (`Endpoint::{Core,Supervisor,Module}`); `capabilities.rs` (the `x-server`-filtered capability builder, Rust side of `buildCapabilities`); `win.rs`/`acl.rs` (Windows pipe DACL, peer-pid checks, overlapped I/O with real read deadlines). |
| `crates/plur1bus-config` | Rust | lib | `config.json` load/validate/write against the same schema TypeScript uses (`packages/config-schema/schema/config.schema.json`, included via `include_str!`); `revision`/`set_many` (a config's content hash and a multi-key apply, used by the supervisor's `config.set`). |
| `packages/rpc-schema` | JSON Schema + codegen | `@plur1bus/rpc-schema` | The single source for RPC methods/params/results/notifications/errors, now split across three `x-server` values (`core`, `supervisor`, `module`). `pnpm gen` writes `generated/types.ts` and `generated/names.json`; never edit `generated/` by hand. |
| `packages/core` | TypeScript | `@plur1bus/core` | The core process: engine binding (`engine-config.ts`), RPC server (`rpc/server.ts`, now a thin `server: "core"` binding over module-api's shared server), config load/watch (`config-source.ts`: a live `config.watch` against the supervisor, falling back to reading `config.json` when none answers), journal (background replay while serving, `replay.ts`), activity, agent registry, admin ops over RPC (`admin-ops.ts`: obsidian, migrate, embedding probe/serve), CLI-facing `bin.ts`. |
| `packages/module-api` | TypeScript | `@plur1bus/module-api` | The module runtime and manifest: `manifest.ts` (schema, `apiVersionSupported`), `runtime.ts` (`runModule`, `ModuleContext` — module-guide.md), `control-server.ts`/`client.ts` (the module's own RPC endpoint and its client of the core), `config-watch.ts` (`watchSupervisorConfig`), `paths.ts` (address/run-file rules shared with the Rust supervisor), plus pieces moved here from the core so a module and the core share one implementation: the RPC server core, `RpcError`, the rotating logger, `securePath`, the orphan watch, the adoption-nonce check, and the exclusive lock. |
| `packages/module-fixture` | TypeScript | `@plur1bus/module-fixture` (private) | The one module this repo ships, for tests only: exercises `runModule`, the supervisor's module handling and the D14 manifest end to end. `module.json` declares `needs: [core]`, `provides: [fixture.echo]`, `consumes: [memory]`, `scope: installation`, `priority: 500`; `dist/package.json` is `{"type":"module"}` (B12/H3B-R23, module-guide.md). Its `README.md` follows the "Module README convention" below. |
| `packages/webmcp` | TypeScript | `@plur1bus/webmcp` | WebMCP mapping in both directions (D55): core capabilities + RPC schema → WebMCP tools for the M3 GUI (`buildWebMcpTools`, `registerPlur1busTools`), and page tools → `webmcp:<origin>/<tool>` MCP descriptors plus the origin allowlist for the browser bridge. `FORBIDDEN_PREFIX` includes `"admin."`: every `admin.*` method is refused as a WebMCP tool regardless of its stability or `x-server`, tested even against a hypothetical future `admin.*` method (B15). Platform-neutral (no Node/DOM imports); WebMCP draft differences live in `src/adapter.ts`. |
| `packages/config-schema` | JSON Schema | `@plur1bus/config-schema` | `config.json` schema with `x-restart` per key, now including the `modules.<name>` namespace (`x-restart: "module:$key"`, `enabled` default `true`); `pnpm gen` writes `fixtures/defaults.json` and `fixtures/restart-plan-cases.json`. |
| `docs/` | Markdown | — | `docs/config-engine-keys.md`, `docs/config.md`, `docs/rpc.md` and `docs/cli.md` are generated (`pnpm docs:gen`); `docs/module-guide.md` is hand-written (module manifest, `runModule`, the module lifecycle and configuration — spec §5, D14); ADRs live in `docs/adr/` (ADR-012 process model/languages/RPC/lock, ADR-013 configuration/restart classes, ADR-016 API stability and versioning); the rest is hand-written design/status/planning material, including `docs/superpowers/` (specs, plans). |
| `scripts/` | Node | — | Cross-cutting tooling: `check-toolchain.mjs`, `test-package.mjs` (shared by every package's `test` script), `gen-engine-keys.mjs`, `gen-docs.mjs`, `lint-hygiene.mjs`, `copy-dir.mjs`. |

`tests/system` now exists (`two-session-recall`, `memory-ops`, `reconnect`, `kill-soak.test.ts`,
`config-restart.test.ts`, `modules.test.ts`, `admin.test.ts`, `helpers.ts`), built up across 2a-H2
through 2a-H3b-a; see "Build / test / lint" above for how to run it. `skills/plur1bus-harness` is
still named only in the design spec and does not exist yet — it is 2a-H3b-b work — do not assume it
is there.

## Conventions

- **JSON Schema is the source of truth for RPC and config types**, in both languages. Edit
  `packages/rpc-schema/schema/rpc.schema.json` or `packages/config-schema/schema/config.schema.json`
  and run `pnpm gen`; never hand-edit anything under a package's `generated/` directory — it is
  overwritten on the next `gen`.
- **Every config key carries `x-restart`** (`"core"` or `"live"`) in `config.schema.json`, including
  every engine pass-through key (see `docs/config-engine-keys.md` for why those are all `core` for
  now). A key without `x-restart` is a bug in the schema, not a documentation gap. **Every key that
  carries `x-restart` also carries `x-tier`** (`"basic"` or `"advanced"`, D29/ADR-013 §2a), resolved
  the same nearest-ancestor way as `x-restart` (`tierOf`/`tier_of`, `filterSchemaByTier`/
  `filter_schema_by_tier`, `filterConfigByTier`/`filter_config_by_tier`); `config schema|get --tier
  basic|advanced` and the generated `docs/config.md` both filter on it.
- **Every RPC method and notification carries `x-stability` (`"experimental"` or `"stable"`) and
  `x-since`** in `rpc.schema.json`, and a deprecated one also carries `x-deprecated: { since,
  removeAfter, replacement }` (ADR-016 §4/§5/§10). `buildCapabilities` derives `core.auth`'s
  `capabilities` entirely from these annotations — never a hand-kept list — so a method's stability
  can't drift from what `docs/rpc.md`'s generated `## Stability` section and `core.auth` both show.
- **Every RPC method carries `x-server: "core" | "supervisor" | "module"`, and every notification
  carries `x-server: "core" | "supervisor"`** (RPC schema 1.3.0, ADR-012 §3/§10, ADR-016's
  implementation records). `buildCapabilities(features, server)` / `capabilities(server, features)`
  filter by it before returning a handshake's `capabilities`, so `core.auth` never lists a
  `daemon.*` or `module.*` method, `supervisor.auth` never lists `memory.*`, and a module's own
  `module.auth` handshake lists only the four methods every module serves (`module.auth|status
  |adopt|shutdown` — no module ever advertises a notification). A method with no `x-server` is a
  bug in the schema, the same as a method with no `x-stability`. `admin.*` is `x-server: "core"`
  like any other core method, but is additionally never offered as a WebMCP tool (see the
  `packages/webmcp` row above) — a person can run it from the CLI, an agent cannot reach it through
  WebMCP.
- **Every RPC method's `params` object is closed** — `additionalProperties: false` — in
  `rpc.schema.json`. An RPC method whose params allow unknown properties is a bug.
- **`--json` output is always the raw RPC value, never a re-serialized typed struct.** Every CLI
  `--json` path prints the `serde_json::Value` `Client::call` returned (or, for a locally-built
  error/stub result, a hand-built `json!` object) straight through — it never goes back through a
  `plur1bus_rpc::types` struct first. `typify`-generated structs are for *reading* fields, not for
  re-emitting output: they drop unknown keys on a result type whose schema has
  `additionalProperties: true`, and they drop empty optionals, so re-serializing one would silently
  narrow what `--json` promises to print (this is ruling R13; recorded in
  `docs/adr/ADR-012-process-model-and-languages.md`). **Every `--json` document also carries a
  top-level `"schema": "<command>/<major>"` key** (a dotted command path, e.g. `memory.list/1`;
  every failure document is `error/1`), inserted once by `crates/plur1bus/src/output.rs`'s
  `document()` helper (ADR-016 §8, ruling G15) — no RPC method result may declare a top-level
  `schema` property of its own, so the two can never collide; `config schema --json`'s id sits
  beside the JSON Schema value (`{ schema, tier, jsonSchema }`), never spliced into it.
- TypeScript is compiled with `erasableSyntaxOnly` (`tsconfig.base.json`): no `enum`, no parameter
  properties, no non-ASCII-erasable construct — only syntax `node --experimental-strip-types` can
  strip without a real transform.
- **No OpenClaw idiom in the harness's own source.** `scripts/lint-hygiene.mjs` (run by `pnpm lint`)
  scans `packages/`, `crates/`, `tests/`, `scripts/` for the string "openclaw", `OPENCLAW_*` env
  names, and OpenClaw-adapter-style imports, with a short, explicit allow-list (the engine's pinned
  git dependency line, a couple of test files that document the very patterns being checked for).
  The harness talks to the engine only through its public `EngineConfig`/plugin surface, never
  through anything OpenClaw-shaped.
- **Commit identity**: commits in this repo are authored as `Cyb3rb1ade
  <84099452+Cyb3rb1ade@users.noreply.github.com>` (the owner's identity); trailers (co-author,
  session links) are kept, not stripped.
- **Secrets**: don't commit any. `GH_ENGINE_READ_TOKEN` (CI-only, set by the owner) is the one
  secret this repo's CI touches, used solely to fetch the pinned engine dependency if that repo is
  private; it is never written to a file or a lockfile. A local `pnpm link --global` override for
  engine development never enters a committed lockfile either.

## Running the core by hand

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/core build   # writes packages/core/dist/core.js
PLUR1BUS_CORE_JS=packages/core/dist/core.js cargo run -p plur1bus -- core run --home /tmp/h
```

`core run` execs Node on `dist/core.js --home <path>` and prints `{"ready":true,"address":...,"pid":...}`
on success once the RPC server is listening. This stays the developer path for running the core with
no supervisor at all (ADR-012 §8).

**Under a supervisor** (spawns and monitors the core, restarts it with backoff, adds `daemon`/
`1staid check`; ADR-012 §10):

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/core build
PLUR1BUS_CORE_JS=packages/core/dist/core.js cargo run -p plur1bus -- --home /tmp/h daemon start
cargo run -p plur1bus -- --home /tmp/h daemon status   # {"supervisor":{...},"children":[{...}]}
cargo run -p plur1bus -- --home /tmp/h 1staid check    # read-only diagnostics, never starts/signals anything
cargo run -p plur1bus -- --home /tmp/h daemon stop
```

`daemon start` spawns the *supervisor* (`plur1bus supervise`, a hidden subcommand — not meant to be
run directly), which in turn spawns the core using the same `PLUR1BUS_CORE_JS`/`PLUR1BUS_NODE`
lookup as `core run`. If a registered OS service already owns this home (`service install`),
`daemon start` starts that service instead of spawning a detached process directly.

For a fast, no-network, no-ONNX-model test loop, run `dist/core.js` directly with the test seam:

```bash
PLUR1BUS_ALLOW_TEST_INTERNALS=1 node packages/core/dist/core.js --home /tmp/h --test-internals flat-embedder
```

`flat-embedder-cold` is the same seam, but the first 2 query embeddings of each core process take 350 ms
each, one at a time (a cold model): system tests pick it with `PLUR1BUS_SYSTEM_INTERNALS=flat-embedder-cold`
(CI runs `two-session-recall` that way), so a recall that does not wait for the model warm-up
(`waitEngineReady`) overruns the core's 600 ms hard budget and answers `aborted`.

`flat-embedder` swaps in a fixed embedding vector and a null reranker (production config always
turns the reranker on in `engine-config.ts`, which would otherwise try to download the ONNX
reranker model in a test run). Because every text gets the same vector, the engine's capture-time
duplicate check (cosine similarity ≥ `duplicateThreshold`) treats any two captures as duplicates by
default; a test that needs to actually capture two or more distinct facts must raise the threshold
past 1.0 in its config, e.g. `cfg.engine.duplicateThreshold = 1.01`.

## Module README convention (D14)

Now exercised: `packages/module-fixture/README.md` is the first module built against it, and every
module under `packages/` or `modules/` (an installed, on-disk module lives under `<home>/modules/`
instead, D14/module-guide.md) ships its own `README.md` covering, at minimum:

1. Purpose — what the module does and why it exists.
2. Its manifest (name, `provides`/`consumes`/`needs`, version).
3. The RPC methods it provides and the ones it consumes from the core or other modules.
4. The restart class (`module:<name>`, since it is the config keys under `modules.<name>` a
   module's own README documents) of every config key it owns.
5. How to run and test it in isolation, without starting the full supervisor.

`docs/module-guide.md` covers the manifest format and the module runtime end to end; a module's own
README documents that specific module against it, the way `packages/module-fixture/README.md`
does.

## Docs

`pnpm docs:gen` builds the CLI and regenerates every generated doc: `docs/config-engine-keys.md`
(`scripts/gen-engine-keys.mjs`, from the pinned engine's plugin manifest — now with a `Tier` column,
D29), `docs/rpc.md` (from `packages/rpc-schema/schema/rpc.schema.json`, including each method's and
notification's stability/since/deprecated line and a `## Stability` section), `docs/cli.md` (from
the clap tree via the hidden `plur1bus __markdown` subcommand) and `docs/config.md` (from
`config.schema.json`'s `x-tier` annotations, one row per tiered node, mirroring `config schema
--tier`), the last three by `scripts/gen-docs.mjs`. `pnpm docs:check` runs `scripts/gen-docs.mjs
--check`, which fails when any of `docs/rpc.md`, `docs/cli.md` or `docs/config.md` is stale; CI runs
it on every OS. After touching the RPC schema, the config schema or any clap definition (help text
included), run `pnpm docs:gen` and commit the result; never hand-edit a generated doc.
`docs/module-guide.md` is hand-written and is never checked by `docs:check`, but it documents
generated surface (the manifest schema, `modules.<name>` config, the `module.*` RPC methods) and
should be re-read whenever those change underneath it. The decision records for the process model,
languages, RPC and lock (ADR-012), for configuration and restart classes (ADR-013) and for API
stability and versioning (ADR-016) are in `docs/adr/`; all three carry a 2a-H3a implementation
record (the supervisor, `daemon`/`service`/`1staid check`, the Windows named-pipe ACL, model warm-up
and the `x-server`-split RPC schema) and a **2a-H3b-a** record (the supervisor's ownership of
`config.json`, config-driven restarts, module processes, `module.*`/`admin.*` over RPC — ADR-012
§10, ADR-013 §5, ADR-016's implementation records). Every CLI stub that still says "2a-H3b" now
means **2a-H3b-b**: only `setup`, `update`, `user`, `model`, `login`, `channel`, `project`, `import`,
`uninstall` and `1staid repair` remain stubs — `config`, `module`, `daemon`, `service`, `1staid
check` and `admin` are all real commands now.
