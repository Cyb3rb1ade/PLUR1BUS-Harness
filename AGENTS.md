# AGENTS.md

The harness edition of "how does an agent build, test and find things here." (The engine repo,
`openclaw-plur1bus-memory`, has its own `AGENTS.md`; this one is for `PLUR1BUS-Harness`.)

## What this repo is

`PLUR1BUS-Harness` is the harness: a Rust CLI + supervisor (`crates/plur1bus`), a TypeScript core
process that binds the engine to a JSON-RPC surface (`packages/core`), the schemas that generate
both sides' types (`packages/rpc-schema`, `packages/config-schema`), and a module API for future
first- and third-party modules (`packages/module-api`). The memory engine itself lives in a
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
| `pnpm docs:gen` | Builds the CLI (`cargo build -q -p plur1bus`), then regenerates `docs/config-engine-keys.md` (`scripts/gen-engine-keys.mjs`) and `docs/rpc.md` + `docs/cli.md` (`scripts/gen-docs.mjs`). |
| `pnpm docs:check` | Builds the CLI, then `scripts/gen-docs.mjs --check`: fails when `docs/rpc.md` or `docs/cli.md` differs from what the schema and the clap tree produce. CI runs it. |

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

`--conditions=source` matters for the three packages other packages import as dependencies —
`packages/rpc-schema`, `packages/config-schema`, `packages/module-api` — whose `exports` map is
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
  run` uses this instead of the (not-yet-installed, H2) `<home>/runtime/core/core.js`.
- `PLUR1BUS_NODE` — the Node binary `plur1bus core run` execs; falls back to `<home>/runtime/node-*`
  (H2) then whatever `node` is on `PATH`.
- `PLUR1BUS_ALLOW_TEST_INTERNALS=1` — required alongside `--test-internals flat-embedder` on
  `packages/core/dist/core.js` (see below); refused without it.

## Where things live

| Path | Language | Package | Purpose |
|---|---|---|---|
| `crates/plur1bus` | Rust | binary `plur1bus` | CLI + supervisor skeleton: `agent`, `memory`, `dreams`, `config`, `core` (internal), plus stubbed `setup`, `1staid`, `module`, `daemon`, `service`, `update`, `user`, `model`, `login`, `channel`, `project`, `import`, `uninstall`. Every command supports `--json`. |
| `crates/plur1bus-rpc` | Rust | lib | JSON-RPC client types and transport for the core's RPC surface. |
| `crates/plur1bus-config` | Rust | lib | `config.json` load/validate/write against the same schema TypeScript uses (`packages/config-schema/schema/config.schema.json`, included via `include_str!`). |
| `packages/rpc-schema` | JSON Schema + codegen | `@plur1bus/rpc-schema` | The single source for RPC methods/params/results/notifications/errors. `pnpm gen` writes `generated/types.ts` and `generated/names.json`; never edit `generated/` by hand. |
| `packages/core` | TypeScript | `@plur1bus/core` | The core process: engine binding (`engine-config.ts`), RPC server, config load/watch, journal, activity, agent registry, CLI-facing `bin.ts`. |
| `packages/module-api` | TypeScript | `@plur1bus/module-api` | Manifest schema and client surface for future modules (first- or third-party). |
| `packages/config-schema` | JSON Schema | `@plur1bus/config-schema` | `config.json` schema with `x-restart` per key; `pnpm gen` writes `fixtures/defaults.json` and `fixtures/restart-plan-cases.json`. |
| `docs/` | Markdown | — | `docs/config-engine-keys.md`, `docs/rpc.md` and `docs/cli.md` are generated (`pnpm docs:gen`); ADRs live in `docs/adr/` (ADR-012 process model/languages/RPC/lock, ADR-013 configuration/restart classes); the rest is hand-written design/status/planning material, including `docs/superpowers/` (specs, plans). |
| `scripts/` | Node | — | Cross-cutting tooling: `check-toolchain.mjs`, `test-package.mjs` (shared by every package's `test` script), `gen-engine-keys.mjs`, `gen-docs.mjs`, `lint-hygiene.mjs`, `copy-dir.mjs`. |

`tests/system` and `skills/plur1bus-harness` are named in the design spec but do not exist yet at
this point in the build — do not assume they are there.

## Conventions

- **JSON Schema is the source of truth for RPC and config types**, in both languages. Edit
  `packages/rpc-schema/schema/rpc.schema.json` or `packages/config-schema/schema/config.schema.json`
  and run `pnpm gen`; never hand-edit anything under a package's `generated/` directory — it is
  overwritten on the next `gen`.
- **Every config key carries `x-restart`** (`"core"` or `"live"`) in `config.schema.json`, including
  every engine pass-through key (see `docs/config-engine-keys.md` for why those are all `core` for
  now). A key without `x-restart` is a bug in the schema, not a documentation gap.
- **Every RPC method's `params` object is closed** — `additionalProperties: false` — in
  `rpc.schema.json`. An RPC method whose params allow unknown properties is a bug.
- **`--json` output is always the raw RPC value, never a re-serialized typed struct.** Every CLI
  `--json` path prints the `serde_json::Value` `Client::call` returned (or, for a locally-built
  error/stub result, a hand-built `json!` object) straight through — it never goes back through a
  `plur1bus_rpc::types` struct first. `typify`-generated structs are for *reading* fields, not for
  re-emitting output: they drop unknown keys on a result type whose schema has
  `additionalProperties: true`, and they drop empty optionals, so re-serializing one would silently
  narrow what `--json` promises to print (this is ruling R13; recorded in
  `docs/adr/ADR-012-process-model-and-languages.md`).
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
on success once the RPC server is listening.

For a fast, no-network, no-ONNX-model test loop, run `dist/core.js` directly with the test seam:

```bash
PLUR1BUS_ALLOW_TEST_INTERNALS=1 node packages/core/dist/core.js --home /tmp/h --test-internals flat-embedder
```

`flat-embedder` swaps in a fixed embedding vector and a null reranker (production config always
turns the reranker on in `engine-config.ts`, which would otherwise try to download the ONNX
reranker model in a test run). Because every text gets the same vector, the engine's capture-time
duplicate check (cosine similarity ≥ `duplicateThreshold`) treats any two captures as duplicates by
default; a test that needs to actually capture two or more distinct facts must raise the threshold
past 1.0 in its config, e.g. `cfg.engine.duplicateThreshold = 1.01`.

## Module README convention (D14)

Not yet exercised in this repo — H2 adds the first module — but the convention is fixed: every
module under `packages/` or `modules/` ships its own `README.md` covering, at minimum:

1. Purpose — what the module does and why it exists.
2. Its manifest (name, `provides`/`consumes`/`needs`, version).
3. The RPC methods it provides and the ones it consumes from the core or other modules.
4. The restart class (`core`/`live`) of every config key it owns.
5. How to run and test it in isolation, without starting the full supervisor.

## Docs

`pnpm docs:gen` builds the CLI and regenerates every generated doc: `docs/config-engine-keys.md`
(`scripts/gen-engine-keys.mjs`, from the pinned engine's plugin manifest), `docs/rpc.md` (from
`packages/rpc-schema/schema/rpc.schema.json`) and `docs/cli.md` (from the clap tree via the hidden
`plur1bus __markdown` subcommand), the last two by `scripts/gen-docs.mjs`. `pnpm docs:check` runs
`scripts/gen-docs.mjs --check`, which fails when `docs/rpc.md` or `docs/cli.md` is stale; CI runs it
on every OS. After touching the RPC schema or any clap definition (help text included), run
`pnpm docs:gen` and commit the result; never hand-edit a generated doc. The decision records for
the process model, languages, RPC and lock (ADR-012) and for configuration and restart classes
(ADR-013) are in `docs/adr/`.
