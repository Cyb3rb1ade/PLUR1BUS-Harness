# AGENTS.md

The harness edition of "how does an agent build, test and find things here." (The engine repo,
`openclaw-plur1bus-memory`, has its own `AGENTS.md`; this one is for `PLUR1BUS-Harness`.)
The HM1/HM2 installers, bootstraps, install feed, `hermes-sidecar.lock.json` and `node-pins.json` live in a third repository, `Cyb3rb1ade/PLUR1BUS-Host-Addons`.

## Arbeitsablauf für Agenten

- Pro Paket genau einen Pull Request öffnen. Nach dem Push den PR öffnen und dessen Nummer melden.
- CI nicht aktiv pollen; insbesondere keine Schleifen mit `gh pr checks` oder `gh run`. Das
  Zusammenführen übernimmt der Controller.
- Lange lokale Testläufe im Hintergrund starten und ihre Ausgabe in eine Logdatei schreiben.

## What this repo is

`PLUR1BUS-Harness` is the harness: a Rust CLI + supervisor (`crates/plur1bus`), a TypeScript core
process that binds the engine to a JSON-RPC surface (`packages/core`), the schemas that generate
both sides' types (`packages/rpc-schema`, `packages/config-schema`), and a module API for future
first- and third-party modules (`packages/module-api`), and the WebMCP mapping (`packages/webmcp`). Around them sit the Harness API (`packages/api`), the web UI (`packages/web`), the channel adapters, the provider, media, voice and document libraries, the Tauri desktop shell (`apps/desktop`) and the container distribution (`containers/`, `crates/plur1bus-containers`); "Where things live" below maps them. The memory engine itself lives in a
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
  CI pins 24.21.0; `package.json#engines` accepts `>=24.16.0 <25 || >=26.1.0`.
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

Root scripts (`package.json`). `gen` and `build` fan out with `pnpm -r --workspace-concurrency=1 <script>`; `prep` is `gen` then `build`, and `pretypecheck` and `pretest` run `prep`, so `pnpm typecheck`, `pnpm lint` and `pnpm test` regenerate and build first:

| Command | Does |
|---|---|
| `pnpm gen` | Regenerates generated sources: `packages/rpc-schema/generated/*` (from `schema/rpc.schema.json`) plus the Python client's `_schema.py` (`scripts/gen-python-client.mjs`, which also verifies the committed address vectors and never writes them), `packages/config-schema/fixtures/*` (from `schema/config.schema.json` via `src/index.ts`), `packages/log-schema/fixtures/vectors.json` and `packages/web/src/palette/settings-index.ts` (from the config schema). Run before `build` after touching a schema. |
| `pnpm build` | Bundles each TypeScript package to `dist/` (`esbuild`, ESM, `--packages=external`, Node 24 target; `packages/web` has its own `build.ts`). |
| `pnpm test:prep` | Installs the frozen workspace dependencies, runs `pnpm gen` and `pnpm build`, then checks the audit source imports, built Core entry and private Engine entry. See “Tests lokal” below. |
| `pnpm test` | `scripts/run-ts-tests.mjs`: runs every package's `test` script (`pnpm -r --workspace-concurrency=1 --no-bail`, `@plur1bus/desktop-ui` excluded, its tests run in `desktop.yml`) and fails when pnpm matched nothing or no test ran. The `test` script of `config-schema`, `log-schema` and `rpc-schema` regenerates before testing. |
| `pnpm typecheck` | `tsc -p tsconfig.base.json --noEmit` across all package sources. |
| `pnpm lint` | `pnpm typecheck`, then `scripts/release/check-source-quality.mjs`, `scripts/lint-hygiene.mjs` (below), `scripts/check-i18n.mjs` (de/en catalogue completeness) and the node tests of those scripts. |
| `pnpm docs:gen` | Builds the CLI (`cargo build -q -p plur1bus`), then regenerates `docs/config-engine-keys.md` (`scripts/gen-engine-keys.mjs`), `docs/rpc.md` + `docs/cli.md` + `docs/config.md` + `docs/log-schema.md` (`scripts/gen-docs.mjs`), `docs/openapi.json` + `docs/api-surface.md` (`scripts/gen-openapi.mjs`) and the web settings index. |
| `pnpm docs:check` | Builds the CLI, then fails when a generated doc differs from what the schemas, the clap tree and the API route table produce (`gen-docs.mjs --check`, `gen-openapi.mjs --check`, the settings-index check), and runs `check-docs-commands.mjs` (commands quoted in `docs/user/**` exist in `docs/cli.md`), `check-doc-links.mjs`, the bundled user docs check and `check-cli-exit-codes.mjs --check` (exit codes against `docs/errors.md`). CI runs it. |

## Tests lokal

Stelle Node 24.21 und pnpm 10 auf `PATH` bereit und führe im Repository-Root aus:

```bash
pnpm test:prep
```

`scripts/test-prep.mjs` führt nacheinander `pnpm install --frozen-lockfile`, `pnpm gen` und
`pnpm build` aus. Danach prüft es die tatsächlichen Audit-Quellimports, `packages/core/dist/core.js`
und die Auflösung der privaten Engine aus `packages/core`. So entstehen auch die generierten
RPC-Dateien und die `dist`-Dateien der Schema-Pakete. Jeder Fehler stoppt die Vorbereitung mit
einem Fehlercode; ein fehlender Befehl oder eine fehlende Abhängigkeit ist kein Skip.

Du brauchst authentifizierten Lesezugriff auf das private Engine-Repository oder dessen bereits
zwischengespeichertes, exakt gepinntes Paket. Ohne diese Abhängigkeit können die Core-Integrationstests
und die Engine-abhängigen TS-Tests nicht laufen. Die Vorbereitung nennt das ausdrücklich. Sie
entfernt oder ersetzt die Engine nicht und verwendet das bestehende Lockfile mit `--frozen-lockfile`.

Danach laufen die gewünschten Tests, zum Beispiel `cargo test --workspace` oder `pnpm test`.
Die gemischten Rust/TS-Audit-Tests prüfen ihre Workspace-Voraussetzungen vor dem Kindprozessstart;
`repair_never_removes_a_live_endpoint` prüft zuerst den gebauten Core. Der Paket-Testrunner ergänzt
bei `ERR_MODULE_NOT_FOUND` für die Engine den Vorbereitungsbefehl und lässt den Fehler bestehen.
Für Browser- und native Systemtests gelten zusätzlich ihre unten bzw. in `docs/ci.md` beschriebenen
Voraussetzungen. `test:prep` baut keinen Rust-Binary und installiert keinen Browser.

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

That's the shape of it; `scripts/test-package.mjs` (used by most packages' `test` script) actually
runs `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test
--test-concurrency=1 --test-timeout=120000 <the sorted test/**/*.test.ts files>` — copy that if running a
single package's tests by hand. `PLUR1BUS_TEST_SHARD=i/N` (with `PLUR1BUS_TEST_SHARD_MANIFEST=<file>`, which
records the files it ran) runs only shard i's files, dealt round-robin (`scripts/ci/test-shards.mjs`); a
malformed value stops the run. `packages/hostctl` and `packages/media` use their own `test` scripts.

`--conditions=source` matters for the packages other packages import as dependencies —
every library package except `packages/core` (`rpc-schema`, `config-schema`, `log-schema`, `module-api`, `webmcp`, `providers`, `media`, `remote-access`, `api`, the `channels-*` and so on; `module-fixture` and `web` export nothing) — whose `exports` map is
`{ "source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }`; with that
flag, a test importing `@plur1bus/rpc-schema` etc. reads the TypeScript **source**, never a
possibly-stale `dist/`. `packages/core` is different: it's the process entry point, not a library
other packages import via `exports` (its `exports` is just `{ ".": "./dist/index.js" }`, and its own
tests import its `src/*.ts` files directly by relative path, not through the package's own export
map), so it has no `source` condition to add. `--experimental-strip-types` runs `.ts` directly, no
separate transpile step.

System (stack-level) tests, run against a built release binary. `.github/workflows/ci.yml`'s `system` job runs an explicit file list (plus the cold-embedder recall and the kill soak as separate steps and `tests/e2e/smoke.test.ts`), not the glob below; the extension tests need `PLUR1BUS_EXT_FIXTURES` (below):

```bash
cargo build --release -p plur1bus
PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test --test-timeout=120000 tests/system/*.test.ts
```

Env vars that matter when driving the core directly instead of through the CLI:

- `PLUR1BUS_BIN` — the `plur1bus` binary a system test shells out to.
- `PLUR1BUS_CORE_JS` — path to the built core entry (`packages/core/dist/core.js`); `plur1bus core
  run` and the supervisor's own spawn (`supervisor::child::core_spec`) both use this instead of the
  installed `<home>/runtime/core/core.js` (written by `setup`).
- `PLUR1BUS_NODE` — the Node binary `plur1bus core run` and the supervisor exec; falls back to the install
  manifest's node path, then the first `<home>/runtime/node-*/bin/node`, then whatever `node` is on `PATH`. Must name `node`/`node.exe`
  directly — never a shell shim (`.cmd`, a wrapper script) — because the supervisor's identity
  checks require the reported child pid to be the real Node process (ADR-012 §10.7).
- `PLUR1BUS_IMPORT_JS` — the importer entry `plur1bus import` spawns (default: `import.js` beside `PLUR1BUS_CORE_JS` / `<home>/runtime/core/core.js`); the Rust tests use `crates/plur1bus/tests/fixtures/fake-import.mjs` through it, and `crates/plur1bus/tests/import.rs` runs the real `packages/core/dist/import.js` (built by `pnpm build`).
- `PLUR1BUS_ALLOW_TEST_INTERNALS=1` — required alongside `--test-internals <variant>` on
  `packages/core/dist/core.js` (`flat-embedder`, `flat-embedder-cold`, see below; `crash-reject`, `crash-throw` and
  `stall` exercise the fatal-handler and signal paths); refused without it. Also gates the supervisor-only test
  seams below. `PLUR1BUS_TEST_INTERNALS=<variant>` is its environment counterpart: `plur1bus core run` and the
  supervisor pass it on as `--test-internals <variant>`.
- `PLUR1BUS_TEST_DISCOVERY_PROFILES=<json>` — JSON string specifying provider profiles for discovery system tests; requires `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (D112).
- `PLUR1BUS_TEST_CHAT_PROVIDER=fake` — the deterministic chat provider (`packages/core/src/session/provider.ts`), registered as the local `fixture` provider for `session.submit`/`plur1bus chat`; requires `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, refused otherwise (M1b-2c). Without it a core uses the providers configured under `modelProfiles` (`packages/providers`) and answers `E_NOT_AVAILABLE reason=no-provider` when there is none. `tests/system/turn-pipeline.test.ts` and `model-switch.test.ts` instead start `tests/system/fixtures/turn-core.mjs` with `PLUR1BUS_TEST_TURN_WIRE=chat_completions|anthropic_messages|codex_responses|gemini`, a real core composition against a synthetic provider wire (needs `PLUR1BUS_ALLOW_TEST_INTERNALS=1` too).
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
- `PLUR1BUS_CI_RECALL_HARD_MS=<ms>` — ruling H3-R26, set by every CI job that runs a recall test against shared
  runners, not only the nightly: `ci.yml`'s `system` and `python-host` jobs and `release-smoke.yml` set `3000`, and
  `nightly.yml` sets `2000`. Shared CI runners are not reference hardware, so the test raises the test home's
  `core.recall.hardBudgetMs` to this value (a slow runner must not abort the recall; both measured recalls must
  still answer `degraded: null`) and reports the 400 ms (`timing.totalMs`) / 600 ms (CLI wall time) targets as
  diagnostics plus a GitHub Actions `::warning::` instead of failing on them. A recall that *does* hit the hard
  budget now answers `degraded: { reason: "timeout", ... }`, not `"aborted"` (2a-H3b-b,
  `packages/core/src/rpc/methods.ts`: the hard-budget `AbortSignal.timeout` firing is distinguished from every
  other abort source that also reports `degraded.reason === "aborted"`), and `packages/core/src/core.ts` now
  precompiles the `memory.recall`/`memory.capture` RPC validators once at core start (`precompileMethods`) rather
  than on first use, so a cold ajv compile is never mistaken for recall latency. **The strict acceptance runs on
  reference hardware with it unset**, where the targets are asserted:

  ```bash
  cargo build --release -p plur1bus && pnpm build
  PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_REAL_MODELS=1 PLUR1BUS_MODELS_CACHE=~/.cache/plur1bus-models \
    node --experimental-strip-types --test --test-timeout=300000 tests/system/two-session-recall.test.ts
  ```
- `PLUR1BUS_SERVICE_TEST=1` — required, alongside `PLUR1BUS_SERVICE_FAKE` unset, for
  `crates/plur1bus/tests/service_real.rs` to touch a real systemd/launchd/Task Scheduler installation instead of
  being skipped; `PLUR1BUS_SERVICE_FAKE=<dir>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) instead
  selects the fake service-manager seam (`crates/plur1bus/src/service/fake.rs`) that every other
  service test runs against.
- `PLUR1BUS_SERVICE_MANAGER=launchd` — set by the launchd unit itself (`service/launchd.rs`'s
  rendered plist always writes it first in `EnvironmentVariables`); the supervisor reads it to remap
  its own non-transient exit codes 2 and 3 to 0 before exiting, so launchd's `KeepAlive =
  { SuccessfulExit = false }` does not loop a usage error or a lost single-instance race forever
  (`supervisor::exit_code`, B16, ADR-012 §10.7). Not meaningful outside a launchd-installed service.
- `PLUR1BUS_REEMBED_POLL_MS=<ms>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — the poll interval of `memory reembed --run`'s follow loop instead of 1000 ms (`crates/plur1bus/tests/memory_reembed.rs`).
- **Update test seams** (all with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, and only in a build that honours seams: a debug build, or a release build without a baked release key such as the one release-smoke tests; a build with a baked `PLUR1BUS_RELEASE_PUBKEY_STABLE`/`_BETA` ignores them and says so on stderr, `install::pins::trust_seams_allowed`; the same holds for `PLUR1BUS_TEST_NODE_SHA256` and `PLUR1BUS_TEST_CORE_SHA256`): `PLUR1BUS_UPDATE_TARGET_BIN=<path>` — the binary `plur1bus update` swaps instead of `current_exe()` (tests point it at a shell script); `PLUR1BUS_UPDATE_GATE_TIMEOUT_MS=<ms>` — the health gate's budget (default 90 000); `PLUR1BUS_TEST_UPDATE_KILL_AT=<phase>` — the updater exits 137 right after writing that phase (`swapped`, `gated`, …), as a killed process would. `PLUR1BUS_TEST_RELEASE_PUBKEY` signs the local feed.
- `PLUR1BUS_SECRETS_KEYRING=off|memory` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; refused without it) — M2 secret store: `off` makes the OS keyring
  unavailable, `memory` swaps in an in-process one, so a test can never reach a real keychain. Absent, the real
  `@napi-rs/keyring` loads lazily on the first `secret.*` call (starting the core never touches the keychain). The
  encrypted-file fallback is a config flag, `secrets.fileFallback.enabled` (default `false`), not an env var.
- `PLUR1BUS_MODULE_API_CURRENT=<n>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — overrides the
  supervisor's own module API version (module-guide.md "API-version policy"; `modules::manifest`).
- `PLUR1BUS_TEST_BACKUP_FAIL_AT=<step>` (with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — makes `backup restore` fail at the named
  step so a test can prove the rollback: `extract` (after the first staged file), `swap:<i>` (after unit *i*'s live tree was moved
  aside, before the staged one is placed) or `swap-after:<i>` (after unit *i* was placed). The old state must come back byte-identical.
- **Extension test seams** (X1; every one is honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, docs/extensions.md):
  - `PLUR1BUS_TEST_EXT_PUBKEYS=<label>=<base64>[,…]` — trusted keys added to the **empty** pinned set (`plur1bus_ext::trust`), so a test can make a package `first-party`; `make-fixtures` writes it to `pubkeys.env`. No key is committed. The seam is compiled into **release** builds too (CI's system job runs `target/release/plur1bus` through it), so it is honoured whenever both variables are set in the process environment; treat that environment as trusted.
  - `PLUR1BUS_TEST_EXT_REVOCATIONS=<file>` — a revocation list in the spec §7.2 `revocations[]` shape, read besides `extensions/catalog/revocations.json`.
  - `PLUR1BUS_TEST_EXT_FAIL_AT=<step>|kill:<point>|sleep:<point>:<ms>` — an install, uninstall or restore fails at the named step after its own writes (so its undo runs), or, as `kill:<point>`, stops there with no rollback and no clean-up, as a killed process would (`ext::recover` then reconciles: `kill:code` leaves new code without its record, which recover removes, `kill:state` a record without its cache, which recover finishes), or, as `sleep:<point>:<ms>`, pauses there and goes on (a mutation in flight for a `daemon stop` to meet). Steps: `config`, `code`, `state`, `cache`, `index`, `enable`; `uninstall.{trash,code,cache,state,index,data,config}`; `restore.{config,index,code,state,data}`. Kill-only points: `code.index` (between a skill's index entry and its folder move), `code.trash` (between a replaced item's old code moving into the trash and the new code moving into place) and `enable.state` (between an `install --enable`'s acknowledgment in the record and its config or index write).
  - `PLUR1BUS_TEST_EXT_INSPECT_TTL_MS=<ms>` — the inspection's lifetime instead of 10 minutes.
  - `PLUR1BUS_TEST_HARNESS_VERSION=<semver>` — replaces the harness version in `compat` checks.
  - `PLUR1BUS_TEST_EXT_WORKER_ARGS=<op>:<arg> [<arg>…][;<op>:…]` — extra arguments the supervisor passes to its package worker for `op` (`inspect` or `stage`), operations separated by `;`, e.g. `inspect:--sleep-ms 800;stage:--crash`.
  - `PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS=<op>:<ms>` — the worker's deadline for `op` instead of 60 s (inspect) or 300 s (stage).
  - The hidden worker arguments those two drive (on `plur1bus ext __worker inspect|stage`, also gated by `PLUR1BUS_ALLOW_TEST_INTERNALS=1`): `--sleep-ms <ms>` sleeps first (to overrun a deadline or to hold the mutation lock), `--crash` aborts right after the package is spooled (inspect) or extracted into staging (stage), as a crashing parser would.
- `PLUR1BUS_FIXTURE_MODULE=<dir>` — where a Rust test finds the built fixture module to install
  into a test home; default `packages/module-fixture/dist` (`pnpm build` builds it before `cargo
  test`, which is why CI always runs the TS build first).
- `PLUR1BUS_EXT_FIXTURES=<dir>` — where `tests/system/extensions.test.ts` (via `tests/system/helpers.ts`) finds the signed and tampered packages; the test throws when it is unset. Generate them with `cargo run -q -p plur1bus-ext --features testkit --example make-fixtures -- <dir>` (the `system` job does, into `$RUNNER_TEMP/p1x-fx`).
- `PLUR1BUS_SOAK_AGENTS=<n>` — the kill soak's agent count (default `max(1, ceil(turns / 100))`).
- **More test seams, each honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`:** `PLUR1BUS_SUPERVISOR_NO_CORE_READY_FLOOR=1` drops the 10 s floor (`child::CORE_READY_FLOOR`) of the supervisor's core-ready timeout, so a test of a core that never becomes ready sees the plain scaled timeout; `PLUR1BUS_TEST_SETUP_PAUSE_AT=<step id>` makes `setup` sleep 30 s before that step and leave a `runtime/setup-paused.tmp-<pid>` marker; `PLUR1BUS_TEST_HM4_FAIL_AT=<step id>` fails that step of the HM4 profile upgrade (`crates/plur1bus/tests/setup_profile.rs`); `PLUR1BUS_TEST_NODE_SHA256` and `PLUR1BUS_TEST_CORE_SHA256` replace the pinned SHA-256 of the Node archive (current target) and of the core payload, so a test can serve its own (`src/install/pins.rs`); `PLUR1BUS_TEST_FAIL_RUN_ACL=1` makes the Windows supervisor treat setting `run/`'s ACL as failed; `PLUR1BUS_TEST_CONTAINER_CLI=<path>` replaces the Apple container CLI (and pretends a macOS ARM host) in the container commands; `PLUR1BUS_TEST_MEDIA_WAIT_MS=<ms>` shortens `media ... --wait` from ten minutes. `PLUR1BUS_NODE_MIRROR` (the Node download root of `setup`) is a real override, not a test seam.
- `PLUR1BUS_API_JS` and `PLUR1BUS_ACP_JS` — the API entry the supervisor spawns for its `api` slot (default: `api.js` beside `PLUR1BUS_CORE_JS`, else `packages/api/dist/api.js` in a checkout, else `<home>/runtime/core/api.js`) and the entry `plur1bus acp serve` execs, the same way `PLUR1BUS_IMPORT_JS` works for the importer.
- `PLUR1BUS_WEB_E2E_REQUIRED=1` and `PLUR1BUS_WEB_TRANSPORT_REQUIRED=1` — turn the skips of `packages/web`'s browser suites and of its served-stack account and transport tests (which use `PLUR1BUS_BIN`, default `target/debug/plur1bus`, and a built core) into failures; CI's `web-browser shard` jobs set both. `PLUR1BUS_CHAT_HTTP_REQUIRED=1` does the same for `packages/api/test/chat-supervisor.test.ts` (real HTTP API against a supervised core).
- `FAKE_CORE_RESTART_PENDING=1`, `FAKE_CORE_WATCH_CONFIG=1`, `FAKE_CORE_LATER_MODE=<mode>`,
  `FAKE_CORE_CONFIG_CHECK=1` (all with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) — seams on
  `crates/plur1bus/tests/fixtures/fake-core.mjs` used only by the supervisor's own Rust tests: a
  one-shot `core.status.config.restartPending`, a fake core that calls `config.watch` at start and
  logs `config-watched`, a mode that changes for every core of a home after the first, and a fake
  core that rejects a configuration the same way the real core's `config.json` validation would.
  `FAKE_CORE_ENGINE`/`FAKE_CORE_JOBS`/`FAKE_CORE_STORE_SCHEMA` (JSON) override `core.status`'s
  `engine`/`jobs`/`engine.storeSchema` fields; `FAKE_CORE_EVENTS=<file>` appends one JSON line per
  lifecycle event (`started`, `listening`, `hung`, `shutdown`, `orphaned`, `adopted`, `exiting`).
  `FAKE_CORE_MODE` (default `ok`) picks the fake core's own behaviour — read the file's own header
  comment (`crates/plur1bus/tests/fixtures/fake-core.mjs`) before relying on the exact wording, but
  as of 2a-H3b-b the modes are: `ok` (serve until `core.shutdown` or lifeline loss); `crash-after:<ms>`
  (exit 1 `<ms>` after ready — on Windows, after `run/` is secured); `exit:<code>` (exit at once, before
  the lock); `listen-on-signal` (hold the lock and write the run files, but listen only once
  `<home>/state/fake-core-listen` exists — a core still starting, for as long as a test needs; this
  replaced the earlier `listen-after:<ms>`); `hang-after:<ms>` (serve, then stop answering `<ms>` after
  ready — on Windows, after `run/` is secured; no SIGTERM handler); `no-listen` (start, run files not
  written, never listen); `slow-status:<n>:<ms>` (delay the reply to the n-th `core.status`, counted
  across connections, by `<ms>`).

## Where things live

| Path | Language | Package | Purpose |
|---|---|---|---|
| `crates/plur1bus` | Rust | binary `plur1bus` | CLI + supervisor: `agent`, `memory` (including `memory list/show/forget/correct/share/state/propose/proposals list\|accept\|reject`, the MemoryOps surface, `crates/plur1bus/src/commands/memory_ops.rs`) and, since **M2**, `memory reembed --plan\|--run\|--status\|--abort` (`src/commands/memory_reembed.rs`, `--json` schemas `memory.reembed.plan/1`, `.run/1`, `.status/1`, `.abort/1`, docs/embedding-migration.md), `dreams`, `config` (`get`/`set`/`schema`, each with `--tier basic\|advanced`, routed through the supervisor's `config.get\|set\|watch` when one answers — ADR-013 §5), `module` (`list\|graph\|install\|uninstall\|start\|stop\|restart`, `src/commands/module.rs`, module-guide.md), `admin` (`obsidian detect\|prepare\|confirm`, `migrate`, `embedding probe\|serve`, `src/commands/admin.rs`, B15 — never exposed over WebMCP, see Conventions), `core` (internal), `daemon start\|stop\|restart\|status` (`src/commands/daemon.rs`), `service install\|uninstall\|status` (`src/commands/service.rs`), `1staid check` (`src/commands/firstaid.rs`, read-only diagnostics), `1staid bundle [--out] [--lines]` (`src/commands/firstaid_bundle.rs` → `src/firstaid_bundle/`: a redacted diagnostic zip with a SHA-256 manifest, `0600`, never over an existing file, refused when its own re-scan finds a secret; `--json` schema `1staid.bundle/1`; `redact.rs` is the regex-free spec §4 redactor), `import <openclaw|hermes>` (`--detect`, `--skills`, `--rollback <report>` and, since **M7**, the full import without a mode flag: dry run by default, `--apply`, `--resume`, `--on-conflict`, `--source`/`--map` for WSL and unmapped paths, Hermes `--profile`/`--adopt-store`; `src/commands/import.rs`, spawns Node on `import.js`, docs/import.md; its exit report is §11, all twelve checklist items ticked; `import backfill --agent <id>` re-binds memory cards to the harness identity, §10.6), and, since **2a-H3b-b**, `setup` (`src/commands/setup.rs` → `src/install/`, nine fixed steps, module-guide.md §12), `update --check` (`src/commands/update.rs`, a signed release feed, `--json` schema `update.check/1`) and, since M8, `update` / `update --rollback` / `update status` (`src/commands/update_apply.rs` → `src/update/`: snapshot, swap, health gate, automatic rollback, `--from <bundle>` for an offline bundle, `update.apply/1`, `update.rollback/1`, `update.status/1`) and `1staid repair` (`src/commands/repair.rs` → `src/repair/`, `--json` schema `1staid.repair/1`, `--dry-run`/`--yes`, never touches `state/`) — all real — and, since **X1**, `skill`, `plugin` and `ext` (`list\|show\|install\|uninstall\|restore\|enable\|disable` for the first two, `ext inspect\|pack\|verify`, `src/commands/ext/`, every leaf `[experimental]`, docs/extensions.md; the hidden `ext __worker inspect\|stage` is the supervisor's package-parsing child) — and, since **D112**, `model` (`model list\|scan\|override`, `src/commands/model.rs`, `--json` schemas `model.list/1`, `model.scan/1`, `model.override/1`), and, since **M2**, `secret` (`secret status\|set\|get\|rm\|ls`, `src/commands/secret.rs`, `--json` schemas `secret.status/1`, `secret.set/1`, `secret.get/1`, `secret.rm/1`, `secret.ls/1`; a value is read from stdin only and printed only by `get --reveal`) — plus the hidden `supervise` subcommand (`src/supervisor/`, spawned by `daemon start`/the OS service, never run directly by a user) and, since **M2**, `budget` (`budget status|set`, `src/commands/budget.rs`, `--json` schemas `budget.status/1`, `budget.set/1`; token limits only, with no price table or cost limit since #601; the usage store is the core's, `packages/core/src/budget`), and, since **M3**, `user` (`ls\|add\|pair start\|claim\|confirm\|link\|unlink`, `src/commands/user.rs`, `--json` schemas `user.*/1`, every leaf `[experimental]`, docs/identity.md; `list`, `role` and `invite create\|list\|revoke` are RPC clients in `src/commands/admin_backend.rs`, docs/admin-backends.md) — and `login` (`login <provider>`, `login status|list|logout`, `src/commands/login.rs`, over the core's `auth.*` RPC; an API key is read from stdin only), `channel` (`list|show|enable|disable|set|test|status|link-help`, `src/commands/channel.rs`, over `channel.*`, secrets by name only), `project` (`src/commands/project.rs`, `project_board.rs`, over `project.*`) and `uninstall` (M8, `src/commands/uninstall.rs`, docs/uninstall.md: plan first, `--yes`, `--dry-run`, `--purge`) — all implemented, none is a stub. The other top-level groups (all in docs/cli.md) are `install` and `container` (the container distribution, see "Container image") and, as clients of the core's RPC in `src/commands/`, `session`, `chat`, `acp`, `jobs`, `voice`, `audit`, `logs`, `device`, `pairing`, `breakglass`, `grant`, `approval`, `inbox`, `trace`, `media` and `identity`, plus `completions` (shell completion scripts). Every command supports `--json`, and every `--json` document carries a top-level `schema` id (see Conventions; `setup/1`, `update.check/1` and `1staid.repair/1` are the three ids this plan adds, and `1staid.check/1`'s own `checks[]` ids are append-only — three more landed this plan, `runtime.node`/`runtime.core`/`models.cache`, ADR-016). |
| `crates/plur1bus/src/supervisor` | Rust | (part of `plur1bus`) | The supervisor itself: `mod.rs` (state machine, restart scheduler, `SupervisorState`/`Shared`, slots as role-keyed `Slot`s — the core, the first-party HTTP API (`api` role, entry `PLUR1BUS_API_JS`) and modules alike), `modules.rs` (the module lifecycle: `ModulesView`/held-back reasons, `start_modules`, `reconcile_stop`/`reconcile_start`, the `module.*` op handlers, `module_list`), `server.rs` (the `supervisor.auth`/`daemon.*`/`config.*`/`module.*` RPC server), `config.rs` (owns `config.json`: `ConfigState`, the polling watcher, `set`, live appliers, B18's invalid-file handling), `subscribers.rs` (per-connection notification queues for `config.watch`/`module.watch`), `child.rs` (`Monitor`: spawn, health polling, hang-kill, backoff, `core_spec`/`api_spec`/`module_spec`/`module_plan`), `adopt.rs` (peer-credentialed adoption of an already-running core or module, `Peer`, `probe_child`), `state.rs` (`Role`/`RoleKind`, `Health`, `CrashReason`, `RestartPolicy`, `Backoff`, pure and unit-tested), `api_transport.rs` (the supervisor trusts only the API's delegation credential and asks the core for current roles on every request), `config_policy.rs` (config annotations applied to the resulting tree, no per-key role list), `cpu.rs` (`supervisor.maxCores`: the CPUs found at start, every PLUR1BUS process bound to at most that many cores by CPU affinity, applied live, `daemon.status.cpu`; docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md), `logfile.rs` (`RotatingFile`, size-based log rotation), `pipe_windows.rs` (the Windows named-pipe ACL and overlapped I/O, `cfg(windows)`). See ADR-012 §10, ADR-013 §5, module-guide.md. |
| `crates/plur1bus/src/modules` | Rust | (part of `plur1bus`) | Module manifests independent of the supervisor's runtime state: `manifest.rs` (`Manifest`, `parse_manifest`, `RESERVED_NAMES`, the API-version policy), `graph.rs` (`band`, `graph`, `start_order`), `install.rs` (`stage`/`commit`/`uninstall`, `InstallError`, staging recovery, B14). See module-guide.md. |
| `crates/plur1bus/src/service` | Rust | (part of `plur1bus`) | OS service registration: `mod.rs` (`Manager`, `Unit`, `Runner` trait), `systemd.rs`, `launchd.rs` (writes `PLUR1BUS_SERVICE_MANAGER=launchd`, B16), `schtasks.rs` (one renderer/installer per OS), `fake.rs` (the `PLUR1BUS_SERVICE_FAKE` test seam). See ADR-012 §10.6, §10.7. |
| `crates/plur1bus/src/install` | Rust | (part of `plur1bus`) | 2a-H3b-b: installer foundations reached only from `setup`/`update`/`1staid repair`, never `supervisor/` (`scripts/lint-hygiene.mjs` enforces the boundary). `targets.rs` (the five release `Target`s), `fetch.rs`/`archive.rs` (the one verified download client and the one verified extractor, `verify_and_extract`, ⟂EXT 1; `ureq`+`rustls`, `flate2`+`tar`, `zip`), `manifest.rs` (`<home>/manifest.json` and the D78 release-manifest view, both JSON-Schema-validated, `schema/*.schema.json`), `pins.rs` (the Node version and its `SHASUMS256.txt` fixture), `setup.rs` (the nine-step installer), `skills.rs` (the skills step and third-party `CHECKSUMS` verification), `profile_upgrade.rs` (HM4: the profile transaction snapshots installed code and config, never the live `state/`) and `containers.rs` (the container-mode installer, run on the host). See ADR-012 §10.13, `docs/module-guide.md` §12. |
| `crates/plur1bus/src/repair` | Rust | (part of `plur1bus`) | 2a-H3b-b: `1staid repair`'s plan and steps. `mod.rs` (`STEP_ORDER`, the plan/print/confirm/apply loop, `--dry-run`/`--yes`, never touches `state/`), `plan.rs` (which finding maps to which step and its `Risk`), `safe.rs` (`run.permissions.fix`, `run.stale-files.remove`, `config.restore`, `service.renew`, `runtime.node\|core.reinstall`), `risky.rs` (`unit.terminate-hung` — termination through the pinned peer, §10.2's identity rule — `store.migrate`, and the log-based `service.silent-exit`/`service.restart-loop` reports, HB17). See ADR-012 §10.13. |
| `crates/plur1bus/src/backup` | Rust | (part of `plur1bus`) | M8: `backup create\|verify\|restore` (`src/commands/backup.rs`, `--json` schemas `backup.create/1`, `backup.verify/1`, `backup.restore/1`, every leaf `[experimental]`; plan `docs/superpowers/plans/2026-10-06-m8-backup-restore.md`). `manifest.rs` (`plur1bus.backup/1`, the allow-list of units — nothing else can be archived or restored, so `run/` tokens and credentials never are —, SHA-256 per file), `archive.rs` (`tar.gz`, manifest first; `visit` is the one reader), `create.rs` (point-in-time copy of the plain units plus the core's staged snapshot), `redact.rs` (a secret VALUE kept in `config.json`, today `channels.telegram.webhook.secret`, is a placeholder in the archive and a fresh random value after a restore; a drift test fails on a new credential-named config property), `restore.rs` (extract to `<home>/.restore-<id>/`, swap by rename, the displaced tree kept in `<home>/backups/pre-restore-<id>/`, rollback on failure); the tombstone registry `state/_tombstones` is no unit and never replaced, a restore leaves `state/.restore-reapply-tombstones` and the next core start re-applies the committed tombstones to the restored rows via the engine, `packages/core/src/restore-reapply.ts`, KNOWN GAP until the pinned engine ships `lib/tombstone-reapply.js`. The core side is `packages/core/src/backup-ops.ts`: RPC `admin.backup.snapshot` binds the engine package's `lib/snapshot/store-snapshot.js` (the pinned engine has no `Engine.admin` snapshot) and the SQLite backup API. Tests: `crates/plur1bus/tests/backup.rs` (hand-built archives, no core), `tests/system/backup.test.ts` (real core: create → restore gives identical recall). |
| `crates/plur1bus-rpc` | Rust | lib | JSON-RPC client types and transport for the core's, the supervisor's and a module's RPC surfaces (`Endpoint::{Core,Supervisor,Module}`); `capabilities.rs` (the `x-server`-filtered capability builder, Rust side of `buildCapabilities`); `win.rs`/`acl.rs` (Windows pipe DACL, peer-pid checks, overlapped I/O with real read deadlines). |
| `crates/plur1bus-log-schema` | Rust | lib | D111 (logging foundation, part 1): the Rust mirror of `packages/log-schema`. Embeds the four schema JSON files with `include_str!`; `Level` and its OTel/syslog map, `catalogue()`/`lookup_event`/`attrs_schema_for`, the redaction patterns as data (`rule_patterns`), and `validate_line`/`validate_audit_line` (the shared check order: level → event → byte limits → schema → key order → level/kind/stream/attrs per catalogue). No logger or writer here. `tests/parity.rs` reads `packages/log-schema/fixtures/vectors.json` (generated by the TypeScript side) and fails on any disagreement. |
| `crates/plur1bus-config` | Rust | lib | `config.json` load/validate/write against the same schema TypeScript uses (`packages/config-schema/schema/config.schema.json`, included via `include_str!`); `revision`/`set_many` (a config's content hash and a multi-key apply, used by the supervisor's `config.set`). |
| `crates/plur1bus-ext` | Rust | lib | X1: the `.p1x` package format (docs/extensions.md). `zipaudit.rs` (strict central-directory parser, streaming hash, no writes), `verify.rs` (the ordered inspect pipeline and its `checks[]`), `trust.rs` (minisign trust store, `PINNED_KEYS` **empty until X5**, the `PLUR1BUS_TEST_EXT_PUBKEYS` seam), `manifest.rs` + `schema/p1x.schema.json`, `compat.rs`, `scripts.rs`, `folder_hash.rs`, `normalise.rs`/`skill.rs` (folder, `.zip`, `.skill` → an unsigned package), `pack.rs`, `refusal.rs` (the reason vocabulary). It audits and never extracts, and the supervisor never links it for package bytes (ADR-012 §10.14). Feature `testkit` (throwaway in-memory keys, tamper variants) and `cargo run -p plur1bus-ext --features testkit --example make-fixtures -- <dir>` (writes `signed-skill.p1x`, `unsigned-folder-skill/`, `module-fixture.p1x`, `fixture-b.p1x`, the eight `tampered-*.p1x` and `pubkeys.env`; no key is ever committed). |
| `crates/plur1bus/src/ext` | Rust | (part of `plur1bus`) | X1: extension state and lifecycle. Supervisor-safe files (`mod`, `paths`, `state`, `index`, `overlays`, `host`, `worker`, `record`, `commit`, `lifecycle`, `remove`, `list`; `scripts/lint-hygiene.mjs` forbids the parser, verifier, packer, extractor and their crates in them) and the worker-only `inspect.rs`/`stage.rs`. `extensions/state.json`, `skills/index.json` (under the importer's `imports/.lock`), install commit with per-step rollback (`COMMIT_STEPS`), enable/disable, uninstall/purge/restore and the trash, overlays, `recover`. `crates/plur1bus/src/supervisor/ext.rs` serves `ext.*` over RPC 1.4.0; `crates/plur1bus/src/commands/firstaid_ext.rs` holds the three `extensions.*` `1staid` checks. |
| `crates/plur1bus-attest` | Rust | binary `plur1bus-attest` + lib | Native half of OS-backed attestation (issue #192): the core runs it as a child process for one approval, one JSON request line on stdin and one reply line on stdout, and it asks the OS for a fresh confirmation (Touch ID or account password on macOS, Windows Hello or the UAC prompt on Windows, polkit on Linux). It reports what the OS said; the binding to the approval (nonce, action hash, lifetime, single use) is checked by the core (`packages/core/src/attestation/`). `PLUR1BUS_ATTEST_BIN` names it; `plur1bus core run` and the supervisor pass the one beside the executable. |
| `crates/plur1bus-containers` | Rust | lib | Container distribution ports: the Docker Engine API (`docker.rs`, with a Windows named-pipe helper) and Apple Container (`apple.rs`) runtimes, the stack and sidecar model (`stack.rs`, `sidecar.rs`, `model.rs`), a pure install plan (`install.rs`; the caller collects consent) and Docker registry credentials (`registry.rs`). It has no CLI of its own; `plur1bus install --container`, `setup --container`, `container` and `update` drive it (`crates/plur1bus/src/commands/container.rs`). `docs/containers.md`, `docs/sidecars.md`. |
| `crates/plur1bus-engine` | Rust | binary `plur1bus-engine` + lib | The memory engine in Rust (plan `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md`, briefs `docs/superpowers/plans/rust-engine/`), which replaces the pinned Node engine package step by step. **RE-00 skeleton**: no engine behaviour yet; `--version` and a hidden placeholder `serve` (RE-08) that exits 2 with `E_NOT_AVAILABLE`. Declares `lancedb =0.26.2` (the Lance version the Node engine embeds, RE-D3), `rusqlite` (bundled), `jsonschema`, `ureq`; `lance` with its `protoc` feature builds the protobuf compiler from source, so the crate needs cmake and a C++ compiler, not `protoc`. The root `[patch.crates-io]` replaces tantivy 0.24.2 with the fork `Cyb3rb1ade/tantivy` (branch `plur1bus/0.24.2-lru-0.18.2`, commit `038215a5`, pinned by `rev`: lru 0.18.2 instead of 0.12) until the Lance pin moves past tantivy 0.24; `deny.toml` allows that git source. The only crate that opts into the root `[workspace.lints]` table (coding-standard.md §10, CS-1) so far. `crates/plur1bus-engine/README.md`. |
| `clients/python/plur1bus-memory-client` | Python | `plur1bus-memory-client` | HM2: stdlib-only Python 3.11+ client for the core RPC (socket and Windows named pipe, overlapped I/O with deadlines, server-pid check before the token is sent, `core.auth` capability discovery); `_schema.py` is generated by `scripts/gen-python-client.mjs` (part of `pnpm gen`), which also checks the committed `tests/fixtures/address-vectors.json` against `module-api` and never writes it. Wheel and sdist attached to the harness release, not on PyPI. Tests: `python3 -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client` (offline, plus `tests/live` against a built core with `PLUR1BUS_BIN`/`PLUR1BUS_CORE_JS`, `PLUR1BUS_LIVE_REQUIRED=1`). |
| `hosts/hermes/plur1bus` | Python | (Hermes directory provider) | HM2: the Hermes `MemoryProvider` (`__init__.py`), binding file and agent naming (`binding.py`), identity mapping (`mapping.py`), capture journal (`journal.py`), `hermes plur1bus status\|selftest\|bind` (`cli.py`), registry lock (`_filelock.py`); vendors the client at build time (`scripts/build-hermes-provider.mjs` → `plur1bus-hermes-provider-<v>.tar.gz`). Tests: `python3 -m unittest discover -s hosts/hermes/tests -t hosts/hermes` (stubs in `hosts/hermes/tests/stubs`) and `-s hosts/hermes/tests/e2e` against a built core. Guide: `docs/hermes-host-mode.md`. CI: `.github/workflows/hermes-host.yml` (real Hermes 0.21.4 on `ubuntu-24.04`, `macos-15`, `windows-2025`, 0.21.5 on Linux; the Windows leg is `continue-on-error` until its first green run) and the `python-host` job of `ci.yml`. |
| `packages/rpc-schema` | JSON Schema + codegen | `@plur1bus/rpc-schema` | The single source for RPC methods/params/results/notifications/errors, now split across three `x-server` values (`core`, `supervisor`, `module`). `pnpm gen` writes `generated/types.ts` and `generated/names.json`; never edit `generated/` by hand. |
| `packages/core` | TypeScript | `@plur1bus/core` | The core process: engine binding (`engine-config.ts`), RPC server (`rpc/server.ts`, now a thin `server: "core"` binding over module-api's shared server), config load/watch (`config-source.ts`: a live `config.watch` against the supervisor, falling back to reading `config.json` when none answers), journal (background replay while serving, `replay.ts`), activity, agent registry, identity and pairing (`identity/`, M3: `state/identity.sqlite`, `identity.*` RPC, docs/identity.md), admin ops over RPC (`admin-ops.ts`: obsidian, migrate, embedding probe/serve), model discovery and catalog (`discovery/`, catalog store/scanners/reconciler, D112), the re-embedding migration and compatibility probe (`embedding-migrate/`: `probe.ts`, `state.ts` checkpoint, `driver.ts`, `engine-port.ts`, `switch.ts`, `rpc.ts` → `admin.reembed.plan\|run\|status\|abort`, M2), the secret store (`secrets/`, M2: keyring and encrypted-file backends, leases, audit, `secret.*` RPC for the owner only; ADR-005), periodic background runner (`system-jobs/`, D112), usage accounting and soft/hard token limits (`budget/`, M2 L8: `node:sqlite` store under `state/`, `budget.status|set`, README beside it; tokens and calls only, there is no price table, cost field or USD limit since #601), the dreaming scheduler (`dreams/`: cron+timezone evaluator, `node:sqlite` run ledger, guards, importance/cron/catch-up triggers, `dreams.*` RPC; ADR-009, `docs/dreams.md`; never a host cron), CLI-facing `bin.ts`. A chat turn is wired together in `composition/` (below). The importer (`src/import/`, entry `src/import-bin.ts` → `dist/import.js`, docs/import.md §8/§9) is a second, separate entry: read-only source detection (OpenClaw/Hermes, PLUR1BUS stores via the engine's LanceDB, SQLite via private copies), the skill scan and the `<home>/skills` index, skills import/rollback; the core process never loads it. |
| `packages/core/src/session` | TypeScript | (part of `@plur1bus/core`) | M1b-2c: the session store (`store.ts`, `migrations.ts`: `node:sqlite` + FTS5 at `<home>/state/sessions.sqlite`, I1 immutability, D21 one active session per chat, archive-first with a stubbed audited erasure, crash recovery of running turns), the submit/event turn loop (`turn-loop.ts`: one `recall` before and one `capture` after each turn through `memory-port.ts`, the same engine calls `memory.recall`/`memory.capture` make), the `ChatProvider` seam and its deterministic fake (`provider.ts`), compaction (`compaction.ts`: L14 bound, tiered summaries, pre-swap `compaction` checkpoint; `summarizer.ts` is the LLM summariser through the existing router, the deterministic `digest` its fallback), and the `session.*` RPC handlers (`methods.ts`; owner derived from `CallerIdentity`, never sent). The CLI half is `plur1bus session list\|show\|archive` and `plur1bus chat` (`crates/plur1bus/src/commands/session.rs`, every leaf `[experimental]`). |
| `packages/core/src/acp` | TypeScript | (part of `@plur1bus/core`) | A1: the ACP (schema v1) agent side over stdio, `docs/acp.md`. `framing.ts` (line reader with a byte limit), `server.ts` (`AcpServer`: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`), `backend.ts` (`AcpBackend` port and `CoreSessionBackend`, which uses only `session.create\|submit\|events\|cancel`), `main.ts` (connect to the core, serve). Entry `src/acp-bin.ts` → `dist/acp.js`, exec'd by `plur1bus acp serve` (`crates/plur1bus/src/commands/acp.rs`; `PLUR1BUS_ACP_JS` overrides the path like `PLUR1BUS_IMPORT_JS`). |
| `packages/core/src/dreams` | TypeScript | (part of `@plur1bus/core`) | M1b-3 dreaming scheduler (ADR-009, `docs/dreams.md`): `cron.ts` (5-field evaluator with IANA timezones), `scheduler.ts` (three phases per agent, guards, importance and cron triggers, one catch-up run, crash retry with `RETRY_CAP` and `RETRY_MAX_AGE_MS`), `store.ts` (ledger `dream_run`/`dream_schedule`/`dream_candidate`, `node:sqlite`, rows written before the body runs), `candidates.ts` (stale, dedupe and utility gates), `producer.ts` (`CandidateSource` from a memory list; pinned engine has no recall/query stats), `methods.ts` (`dreams.*` RPC including `dreams.diary`). The engine owns every step; CLI `plur1bus dreams status\|run\|log\|schedule\|enable\|disable\|diary`. REM trends reader is open. |
| `packages/core/src/auth` | TypeScript | (part of `@plur1bus/core`) | M2 auth engine, token side (`docs/auth-engine.md`, ADR-005): profiles as data (`profile.ts`: `api_key`, `oauth_pkce`, `device_code`, `adc`, `external_cli`), the headless login ladder (`ladder.ts`, `env.ts`), the login flows (`login.ts`: PKCE with a loopback listener, device code), the HTTP token client and `HttpRefresher` (`http.ts`, through the egress gate), Application Default Credentials (`adc.ts`), one refresh owner (`refresh.ts`), credential pools with classified cooldowns (`pool.ts`), the credentials provider and the `SecretStore` port. The CLI half is `plur1bus login`; the ChatGPT sign-in and its billing and workload classes (D110) are in `openai-auth/`, docs/openai-auth.md. |
| `packages/core/src/policy` | TypeScript | (part of `@plur1bus/core`) | D109 as a library (`docs/policy-evaluator.md`): per-OS path canonicalisation (`paths.ts`, `paths-index.ts`), the effect axis (`effects.ts`), the capability table and every default (`capabilities.ts`), and the pure `decide()` (`decide.ts`). `tools/dispatcher.ts` calls `decide()` for every tool call (a headless ask becomes a refusal, `headless.ts`); the approval store and grants are in `approvals/` and `grants/` (below). Not RBAC (below). |
| `packages/core/src/mcp` | TypeScript | (part of `@plur1bus/core`) | M1b-2b MCP client transport (ADR-014, *Proposed*): connections over stdio and Streamable HTTP, registry with scopes and an idle manager, a schema cache that survives a stop, config validation, redaction, child env and the D19 provenance envelope. It speaks MCP 2026-07-28 (modern) and 2025-11-25 (legacy), docs/mcp-client.md. The turn composition builds a registry from `providers.mcp` (`servers`, `allowedCommands`), and `tools/mcp-bridge.ts` offers a server's tools as registered tools that only `ToolDispatcher` can run, so D109 policy gates every call. |
| `packages/core/src/prompt` | TypeScript | (part of `@plur1bus/core`) | M2 prompt-zone builder (ADR-010): deterministic serialisation and hashing (`canonical.ts`), the four zones with breakpoints and typed clip events (`builder.ts`), the per-model cache table (`model-table.ts`), the frozen-snapshot session (`session.ts`), the TTL chooser; the B6 zone-determinism gate runs in tests and `pnpm bench`. |
| `packages/core/src/rbac` | TypeScript | (part of `@plur1bus/core`) | M3 `authorize(principal, action, resource)` for human principals (`docs/rbac.md`, ADR-007): the action table (`policy.ts`), the RPC guard over the methods named in `RPC_RULES` (`guard.ts`; docs/rbac.md lists which are secured), break-glass registry and audit sinks. Distinct from D109's `policy.decide`, which governs agents. |
| `packages/core/src/tools` | TypeScript | (part of `@plur1bus/core`) | The tool layer: `registry.ts` (fail-closed registration), `dispatcher.ts` (`ToolDispatcher`: resolve, validate, policy gate, execute under limits, provenance envelope; `call` never throws), `approval.ts` (the port `approvals/service.ts` implements), `mcp-bridge.ts`, `collaboration.ts` (delegate and consult tools), `web/` (`web.fetch` and `web.search`, `docs/web-tools.md`: resolve-then-pin SSRF guard, robots and per-host pacing, HTML to Markdown with sections and a cursor, typed failures, provider fallback and normalisation), `fs/` (`file.read\|write\|list\|stat`, `docs/fs-tools.md`), `exec/` (`exec.run`), `sandbox/` (OS sandbox backends: bubblewrap on Linux, Seatbelt on macOS, none on Windows; a call that needs the sandbox is refused when none is usable; its resource limits come from the `plur1bus-sandbox-limits` launcher, `crates/plur1bus/src/bin/`) and `repair.ts` the one-round tool-call repair hook. |
| `packages/core/src/composition` | TypeScript | (part of `@plur1bus/core`) | Turn composition (`docs/composition.md`, `docs/architecture/turn-pipeline.md`): wires provider credentials and adapters, the provider router with budget admission and billing checks, tool registration (per turn, with scoped MCP servers), media, the inbox, collaboration and the trace spans around each stage. It adds little logic of its own; `core.ts` is the composition root. |
| `packages/core/src/{approvals,grants,attestation}` | TypeScript | (part of `@plur1bus/core`) | D109 approvals and grants (`docs/approvals.md`). `approvals/`: one SQLite file under `state/` for approvals, grants and an HMAC-SHA256 event chain (Ed25519 signatures on decisions, a start and daily integrity check), `service.ts` implements the dispatcher's approval port, `approval.*` RPC and the `approval.requested`/`approval.resolved` events. `grants/`: grants resolved for `decide()` through `GrantSource`, `grant.*` RPC. `attestation/`: OS-backed confirmation for one approval through the `plur1bus-attest` helper, which the core pins by path and by SHA-256. CLI: `plur1bus approval`, `plur1bus grant`. |
| `packages/core/src/audit` | TypeScript | (part of `@plur1bus/core`) | B5 hash-chained audit file (`docs/audit-chain.md`): `chain.ts` writes `{seq, prev, rec}` lines (`audit-chain.jsonl`, an anchor file, rotation) beside `logs/audit.log` and verifies them; `rpc.ts` is `audit.verify`, CLI `plur1bus audit verify`. |
| `packages/core/src/egress` | TypeScript | (part of `@plur1bus/core`) | B4 egress policy (`docs/egress.md`): a default-deny allowlist (`egress.allowHosts`, `egress.allowPorts`, `egress.allowLoopback`) decided per hop, on top of the SSRF guard in `tools/web/`; `egress.status` RPC. The web tools, MCP, model discovery, voice and the OAuth client ask it before they connect. |
| `packages/core/src/{toolcall,triage}` | TypeScript | (part of `@plur1bus/core`) | D97/D103/D105 (`docs/tool-reliability.md`). `toolcall/`: argument validation with one repair, provider dialects and quirks, result handling, a persistent capability registry (`sqlite-registry.ts`), categories, calibration and an eval. `triage/`: splits a message into tasks with a model class (`small`, `medium`, `large`, `frontier`) and a cost preference; one decision-role call under a deadline, a new class applied only at a task boundary. |
| `packages/core/src/channels` | TypeScript | (part of `@plur1bus/core`) | The core side of the switchboard (`docs/switchboard.md`): the `Channel` contract (`types.ts`), registry, router, bindings, behaviour layers, backoff and `loopback.ts`, the in-process reference channel. The core hosts the channels; each is off by default and configured under `channels.<id>.*`. CLI `plur1bus channel`. |
| `packages/core/src/collab` | TypeScript | (part of `@plur1bus/core`) | M5 collaboration core (`docs/collaboration.md`, ADR-003): a library with ports for projects, consult, delegate, guardrails and traces, the project board in `state/collab.sqlite` (`docs/projects-board.md`), hand-off envelopes (`handoff.ts`) and the coding gate and verifier (`coding-gate.ts`, `verifier.ts`). RPC `project.*` and `collab.*`; CLI `plur1bus project`, `trace`. |
| `packages/core/src/a2a` | TypeScript | (part of `@plur1bus/core`) | ADR-008 A2A server, inbound only (protocol 0.3.0, loopback `node:http`), off by default: nothing in the core starts it, and it makes no outbound call (`docs/a2a.md`). |
| `packages/core/src/{catalog,inbox}` | TypeScript | (part of `@plur1bus/core`) | `catalog/`: signed catalogue trust (`createCatalogClient`, `ext-index/`; `docs/catalog.md`). `inbox/`: one place for what the harness tells a person (store, RPC, events; `docs/inbox.md`); CLI `plur1bus inbox`. |
| `packages/core/src/{logs,metrics}` | TypeScript | (part of `@plur1bus/core`) | `logs/`: the D111 core diagnostic writer (`writer.ts`, JSONL under `@plur1bus/log-schema`, redaction) and `logs.query`/`logs.tail` (`docs/logging.md`, `docs/log-query.md`; CLI `plur1bus logs`). `metrics/`: a loopback-only, token-protected `GET /metrics` in the Prometheus text format with bounded label cardinality (`docs/ops/metrics.md`). |
| `packages/core/src/{openai-auth,voice,licences}` | TypeScript | (part of `@plur1bus/core`) | D110: `openai-auth/` (ChatGPT sign-in, the OpenAI provider binding, credentials and billing; `docs/openai-auth.md`), `voice/` (the voice broker, Voice V2 `openTalk`, routing, budget and metrics; cloud and local providers come from `packages/voice-providers`; `docs/voice.md`, `docs/voice-v2.md`) and `licences/` (the shared model-licence acceptance ledger). |
| `packages/core/src/media-search` | TypeScript | (part of `@plur1bus/core`) | Media search, harness side (`docs/media-search.md`): configuration and validation, the caption pipeline, the index hook, the backfill job and the ffmpeg ports around the engine's vector search; `media.search`, CLI `plur1bus media search\|index\|caption`. |
| `packages/core/src/host-tools` | TypeScript | (part of `@plur1bus/core`) | D106 host toolset (`apps`, `clipboard`, `exec`, `notify`, `pkg`, `proc`, `sys`, with a denylist and classification; `docs/host-tools.md`); `packages/hostctl` extends it. |
| `packages/core/src/{agents,user-jobs,privacy}` | TypeScript | (part of `@plur1bus/core`) | `agents/`: crash-consistent create saga, lifecycle and the one admission boundary for CLI RPC, channel and ACP turns and scheduler work, export, import and scope (`docs/agents.md`). `user-jobs/`: user recurring tasks, `jobs.*` (`docs/recurring.md`). `privacy/`: the "Only local models" switch and its doctor checks (`docs/privacy.md`). |
| `apps/desktop` | Rust + TypeScript | separate Cargo workspace | Tauri desktop shell (D1): the shell itself (scaffold, UI frame, connections and pairing, SPA window, app lifecycle), the container-runtime controller (`src-tauri/src/{runtime,controller}/`), host bridge (`host-helper`), signed update and upgrade/rollback logic, deep links, the installer and bundle scripts (`src-tauri/src/install/`, `scripts/build-bundle.mjs`) and the Rust mock harness and stub image are all in the tree. The transport choice (`docs/superpowers/specs/2026-10-21-desktop-transport-choice-design.md`) adds the std-only IP classifier crate `apps/desktop/net` (`plur1bus-desktop-net`, pinned to `ip.ts` by the shared vectors) and `src-tauri/src/transport/` (host validation, injected resolver/Tailscale/probe seams, `check_target`/`gate`, the `connection-transport.json` sidecar). Acceptance is not complete: real-image and API contracts, production migration evidence and the native/manual passes are open (`docs/handoff/status/desktop-shell.md`). See "Desktop shell" below and `docs/desktop.md`. |
| `packages/module-api` | TypeScript | `@plur1bus/module-api` | The module runtime and manifest: `manifest.ts` (schema, `apiVersionSupported`), `runtime.ts` (`runModule`, `ModuleContext` — module-guide.md), `control-server.ts`/`client.ts` (the module's own RPC endpoint and its client of the core), `config-watch.ts` (`watchSupervisorConfig`), `paths.ts` (address/run-file rules shared with the Rust supervisor), plus pieces moved here from the core so a module and the core share one implementation: the RPC server core, `RpcError`, the rotating logger, `securePath`, the orphan watch, the adoption-nonce check, and the exclusive lock. |
| `packages/api` | TypeScript | `@plur1bus/api` | M3 Harness API (ADR-004): authenticated listeners, deny by default (loopback always; tailnet and TLS network listeners from the `remote.*` config), the single route table (`routes.ts`, source of `docs/openapi.json` and `docs/api-surface.md`, generated by `scripts/gen-openapi.mjs`, checked by `pnpm docs:check`), accounts and login (`login.ts`, `password.ts`, `totp.ts`, `webauthn.ts`), session cookie + one-time CSRF (`session.ts`), token-bucket rate limits (`rate-limit.ts`), security headers (`headers.ts`), `error/1` failures (`errors.ts`), direct-chat REST and SSE with a `/ws` handshake, device pairing and trust rollover, native desktop attach routes, a lazy reconnecting core link (`core-link.ts`) and the standalone entry `dist/api.js`, which the supervisor spawns and monitors as its `api` role. A peer client of the core over its local RPC; tests need no engine (`FakeClock`, fake core). README: `packages/api/README.md`. |
| `packages/module-fixture` | TypeScript | `@plur1bus/module-fixture` (private) | The one module this repo ships, for tests only: exercises `runModule`, the supervisor's module handling and the D14 manifest end to end. `module.json` declares `needs: [core]`, `provides: [fixture.echo]`, `consumes: [memory]`, `scope: installation`, `priority: 500`; `dist/package.json` is `{"type":"module"}` (B12/H3B-R23, module-guide.md). Its `README.md` follows the "Module README convention" below. |
| `packages/providers` | TypeScript | `@plur1bus/providers` (private) | M2 provider adapters and routing: the wire formats `chat_completions` (OpenAI-compatible, also behind Ollama and LM Studio), `anthropic_messages`, `codex_responses` (OpenAI Responses API) and Gemini, one `ProviderError` taxonomy, local provider discovery (`local/`), and the profiles and router (`profiles/`, `router/`) that turn the config's `modelProfiles` into ordered fallback chains; the core's `composition/` wires them. No network in tests (fixtures + local stub servers). `docs/providers.md`, `docs/provider-matrix.md`; its `README.md` documents the API. |
| `packages/voice-providers` | TypeScript | `@plur1bus/voice-providers` | Cloud voice providers (ElevenLabs, xAI Grok Voice, Gemini Live, Amazon Polly), a local sherpa-onnx tier and local real-time profile logic. See `docs/voice-providers.md` and `docs/voice-local.md`. |
| `packages/media` | TypeScript | `@plur1bus/media` (private) | MG-1/MG-2 media core, dependency-free: image adapters, `AdapterRegistry`, `JobRunner`, `FileJobPersistence`, `OutputStore`, requested and delivered usage units (`docs/media.md`, `docs/media-adapters.md`); the core wires it in `composition/media.ts`, CLI `plur1bus media`. Its `test` script (`test/*.test.ts`) enforces 85 % line, function and branch coverage; `tools/coreml-sd-helper` is the Swift CoreML helper behind `coreml.ts`. |
| `packages/documents` | TypeScript | `@plur1bus/documents` (private) | D100 document design system and HTML→PDF renderer: colour tokens with computed WCAG AA contrast, nine templates, a Markdown→HTML→PDF pipeline over Chromium's `Page.printToPDF`, the `document.render` tool contract (`docs/documents.md`, README). The `documents-golden` job in `ci.yml` renders the golden set and checks it with a pixel-threshold visual diff. |
| `packages/embedding-adapters` | TypeScript | `@plur1bus/embedding-adapters` (private) | ADR-006 remote embedding and rerank adapters (OpenAI and OpenAI-compatible servers, OpenRouter, Google, Cohere, Jina, Voyage, Ollama, TEI, MTPLX, vLLM, llama.cpp, oMLX). No runtime dependencies, no network in unit tests, secrets only through an injected `getSecret()`. Not imported by the core or the engine yet (`docs/embedding-adapters.md`, "Follow-up: wiring into core/engine"). |
| `packages/remote-access` | TypeScript | `@plur1bus/remote-access` (private) | The library behind remote access (`docs/remote-access.md`): exposure modes, TLS material, pairing with certificate pinning, pair-proof for typed codes, trust rollover, the client-subnet allow-list, the security notice and the `1staid` warnings. Injected ports (clock, exec, secret store); it opens no listener. The API applies it (`remote-runtime.ts`), the core's device store uses it. |
| `packages/channels-{telegram,discord,slack,matrix,signal,email,buzz}` | TypeScript | `@plur1bus/channels-*` | Telegram, Discord, Slack, Matrix, Signal, E-mail and Buzz (Nostr direct messages) channel adapters implementing the shared `Channel` lifecycle. See each package README and `docs/channels/`. |
| `packages/hostctl` | TypeScript | `@plur1bus/hostctl` | Local-only file, process, system, application and clipboard control through the Harness ToolDispatcher and D109 policy. See `docs/hostctl.md`. |
| `packages/web` | TypeScript | `@plur1bus/web` (private) | M3 web UI: Preact + Signals SPA built to static files (no inline script, strict CSP), app shell (sidebar groups, hash routes, rail/overlay/full layout), Glow tokens with light/dark/system, de/en catalogues, sign-in through `SessionApi` (`src/session.ts`, `HttpSessionApi` against the Harness API's session routes), and the pages listed in `docs/web-ui.md` (some nav items are still placeholders). Authored with `h()` in `.ts` (no JSX). Tests (`node:test`, mock server, Chromium via Playwright (CI installs the lockfile-matched one), axe, structural responsive snapshots) skip the browser suites when no Chromium is found; `PLUR1BUS_WEB_E2E_REQUIRED=1` makes that a failure, and `PLUR1BUS_WEB_BROWSER=off` is the one explicit switch that turns them off (used only by `unit (macos-15)`; they run in `web-browser (macos-15, i/2)`, not gating, docs/ci.md). See `docs/web-ui.md`, `docs/ui/web-shell.md`, `docs/ui/framework-spike.md`. |
| `packages/webmcp` | TypeScript | `@plur1bus/webmcp` | WebMCP mapping in both directions (D55): core capabilities + RPC schema → WebMCP tools for the M3 GUI (`buildWebMcpTools`, `registerPlur1busTools`), and page tools → `webmcp:<origin>/<tool>` MCP descriptors plus the origin allowlist for the browser bridge. `FORBIDDEN_PREFIX` includes `"admin."`: every `admin.*` method is refused as a WebMCP tool regardless of its stability or `x-server`, tested even against a hypothetical future `admin.*` method (B15). Platform-neutral (no Node/DOM imports); WebMCP draft differences live in `src/adapter.ts`. |
| `packages/log-schema` | JSON Schema + TS | `@plur1bus/log-schema` | D111 (docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md): `schema/record.schema.json` (the JSONL diagnostic record, key order, limits), `schema/audit.schema.json` (the audit record: HB12 v1 fields kept, R1), `schema/catalogue.json` (the versioned event catalogue: name → kinds, stream, levels, attrs group, required attrs, one example record each), `schema/levels.json` (OTel `SeverityNumber` and syslog map), `schema/redaction.json` (patterns as data). `validateRecord`/`validateLine` and `validateAuditRecord`/`validateAuditLine` are the validators. `pnpm gen` writes `fixtures/vectors.json` (committed; the Rust parity test reads it). Edit the JSON, run `pnpm gen` and `pnpm docs:gen`; a new event needs an entry with an example. No logger, writer, OTLP or viewer lives here (later D111 parts). |
| `packages/config-schema` | JSON Schema | `@plur1bus/config-schema` | `config.json` schema with `x-restart` per key, now including the `modules.<name>` namespace (`x-restart: "module:$key"`, `enabled` default `true`); `pnpm gen` writes `fixtures/defaults.json` and `fixtures/restart-plan-cases.json`. |
| `docs/` | Markdown | — | `docs/config-engine-keys.md`, `docs/config.md`, `docs/rpc.md`, `docs/cli.md`, `docs/log-schema.md`, `docs/openapi.json` and `docs/api-surface.md` are generated (`pnpm docs:gen`); `docs/module-guide.md` is hand-written (module manifest, `runModule`, the module lifecycle and configuration — spec §5, D14); `docs/extensions.md` is hand-written (X1: the `.p1x` format, verification order, trust, lifecycle, the `skill`/`plugin`/`ext` commands, what is not protected); ADRs live in `docs/adr/` (ADR-012 process model/languages/RPC/lock, ADR-013 configuration/restart classes, ADR-016 API stability and versioning are the ones cited here; the folder holds ADR-001 to ADR-017, there is no ADR-015); `docs/ci.md` describes the CI job map and the macOS runner policy; the rest is hand-written design/status/planning material, including `docs/superpowers/` (specs, plans). |
| `scripts/` | Node | — | Cross-cutting tooling: `check-toolchain.mjs`, `test-package.mjs` (shared by most packages' `test` script) and `run-ts-tests.mjs` (root `pnpm test`), `gen-engine-keys.mjs`, `gen-docs.mjs`, `gen-openapi.mjs`, `gen-python-client.mjs`, `lint-hygiene.mjs`, `check-i18n.mjs`, `check-doc-links.mjs`, `check-docs-commands.mjs`, `check-cli-exit-codes.mjs`, `audit-deps.mjs`, `copy-dir.mjs`; `ci/` (macOS runner plan, test shards), `release/` (payload assembly, checks, release notes, third-party notices), `install/` (`install.sh`, `install.ps1`) and `bench/` (startup, budget and reference-hardware measurement scripts; `pnpm bench` is `bench.mjs`). |

`crates/plur1bus/tests/reboot.rs` is the simulated-reboot suite (unix; SIGKILL of the whole stack, stale or discarded `run/`, restart through the fake service manager, one core after a double start) and `crates/plur1bus/tests/firstaid_bundle.rs` the bundle's marker test; what only a real system can show is in `docs/reboot-survival.md`.

`tests/system` holds the stack-level tests: `two-session-recall`, `memory-ops`, `reconnect`, `kill-soak.test.ts`,
`config-restart.test.ts`, `modules.test.ts`, `admin.test.ts`, `extensions.test.ts` (X1: a signed skill and a module `.p1x` over a real supervisor, the tamper variants, the trash), `model-discovery.test.ts` (D112: full stack discovery, CLI scan/list/override, jobs.run), `model-switch.test.ts` (L9: `chat --model` needs `--yes`), `turn-pipeline.test.ts` (`plur1bus chat --json` through the daemon and a real core composition to `file.read`, once per provider wire; it and `model-switch` start `fixtures/turn-core.mjs`), `backup.test.ts`, `portable-backup.test.ts` (stores, vault, config, identities, API accounts, sessions and the dream ledger restore), `identity.test.ts`, `reembed.test.ts`, `secrets.test.ts`, `sessions.test.ts`, `dreams.test.ts`, `setup.test.ts`, `install-scripts.test.ts`, `desktop-attach.test.ts` (supervisor, loopback meta, CLI pair, redeem, SPA ticket), `redaction-everywhere.test.ts` (M2 C8: secret markers through every export, backup, report and bundle path), `help-isolation.test.ts` (`--help` ignores an invalid configuration), `helpers.ts` (with `helpers.test.ts`); `tests/e2e/smoke.test.ts` runs CLI, daemon and core on a fresh home, then backup, verify and restore into a second home. See "Build / test / lint" above for how to run them. **`skills/`** holds the bundled skills `setup`'s `skills` step copies into `<home>/skills/`, one folder each (module-guide.md §12): `plur1bus-ops/`
(`SKILL.md` plus `playbooks/{diagnose,configure,repair}.md`, the operations skill 2a-H3b-b ships; the design spec's earlier working name was `skills/plur1bus-harness`, HB13's O7 default
renamed it; a freshness test keeps it in step with the CLI it documents), `coding-standards/`, `document-design/`, `documentation-standards/`, `hostctl/`, and `third-party/` (skills from outside the project, shipped unchanged and pinned by `CHECKSUMS`; a mismatch fails the step).

## Conventions

- **Coding standard**: `docs/coding-standard.md` — naming, comments, code shape, efficiency, errors, logging,
  security, tests, the enforcement plan (CS-0…CS-5) and the author's PR checklist. The rules below are the ones it
  builds on; where the two disagree, this file wins.
- **JSON Schema is the source of truth for RPC and config types**, in both languages. Edit
  `packages/rpc-schema/schema/rpc.schema.json` or `packages/config-schema/schema/config.schema.json`
  and run `pnpm gen`; never hand-edit anything under a package's `generated/` directory — it is
  overwritten on the next `gen`.
- **Every config key carries `x-restart`** (`"core"`, `"live"`, or `"module:<name>"` under `modules.<name>` and the channel namespaces) in `config.schema.json`, including
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
  scans `packages/`, `crates/`, `tests/`, `scripts/`, `apps/`, `clients/` and `hosts/` for the string "openclaw", `OPENCLAW_*` env
  names, and OpenClaw-adapter-style imports, with a short, explicit allow-list (the engine's pinned
  git dependency line, a couple of test files that document the very patterns being checked for).
  The harness talks to the engine only through its public `EngineConfig`/plugin surface, never
  through anything OpenClaw-shaped.
- **Commit identity**: commits in this repo are authored as `Cyb3rb1ade
  <cyb3rblade@me.com>` (the owner's identity); trailers (co-author, session links) are kept,
  not stripped.
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

`pnpm docs:gen` builds the CLI and regenerates every generated doc: `docs/openapi.json` and `docs/api-surface.md` (`scripts/gen-openapi.mjs`, from the route table in `packages/api/src/routes.ts`) and, besides them, `docs/config-engine-keys.md`
(`scripts/gen-engine-keys.mjs`, from the pinned engine's plugin manifest — now with a `Tier` column,
D29), `docs/rpc.md` (from `packages/rpc-schema/schema/rpc.schema.json`, including each method's and
notification's stability/since/deprecated line and a `## Stability` section), `docs/cli.md` (from
the clap tree via the hidden `plur1bus __markdown` subcommand) `docs/config.md` (from
`config.schema.json`'s `x-tier` annotations, one row per tiered node, mirroring `config schema
--tier`) and `docs/log-schema.md` (from `packages/log-schema/schema/*.json`), the last four by `scripts/gen-docs.mjs`. `pnpm docs:check` runs `scripts/gen-docs.mjs
--check`, which fails when any of `docs/rpc.md`, `docs/cli.md`, `docs/config.md` or `docs/log-schema.md` is stale (`docs:check` also covers the OpenAPI files and the other checks listed in the table above); CI runs
it on every OS. After touching the RPC schema, the config schema or any clap definition (help text
included), run `pnpm docs:gen` and commit the result; never hand-edit a generated doc.
`docs/module-guide.md` is hand-written and is never checked by `docs:check`, but it documents
generated surface (the manifest schema, `modules.<name>` config, the `module.*` RPC methods, and,
since 2a-H3b-b, §12's installer paths) and should be re-read whenever those change underneath it. The
decision records for the process model, languages, RPC and lock (ADR-012), for configuration and
restart classes (ADR-013) and for API stability and versioning (ADR-016) are in `docs/adr/`; all
three carry a 2a-H3a implementation record (the supervisor, `daemon`/`service`/`1staid check`, the
Windows named-pipe ACL, model warm-up and the `x-server`-split RPC schema), a **2a-H3b-a** record
(the supervisor's ownership of `config.json`, config-driven restarts, module processes,
`module.*`/`admin.*` over RPC — ADR-012 §10, ADR-013 §5, ADR-016's implementation records) and,
now, a **2a-H3b-b** record (`setup`, `update --check`, `1staid repair`, the release workflow and the
Windows `run/` ACL landing — ADR-012 §10.13; the `core.recall.*` reclassification and `setup`'s
basic-tier questions — ADR-013 §9; the three new CLI `schema` ids and `1staid.check/1`'s append-only
ids — ADR-016's implementation record; ADR-006 also gained a 2a-H3b-b implementation record for the
setup wizard's use-class question and NC-licence gate). Every top-level command in `docs/cli.md` has an implemented
handler; no command answers a milestone stub any more. That includes `login`, `channel`, `project` and `uninstall`
(`src/commands/login.rs`, `channel.rs`, `project.rs`, `uninstall.rs`; `docs/uninstall.md`) and the full `import`
(M7: `--detect`, `--skills`, `--rollback` and the import itself, `src/commands/import.rs`; `docs/import.md` §10 and §11).

## Container image

`Dockerfile`, `.dockerignore`, `deploy/compose.yaml`, `deploy/container/healthcheck.mjs`, `scripts/container-smoke.sh` and
`.github/workflows/container.yml` build and test the harness image (M8; `docs/container.md`). Static invariants (digest pins,
non-root, no secret in ARG/ENV, hardened compose) are `scripts/release/test/container-files.test.ts`; run the image smoke with
`scripts/container-smoke.sh <image>`. The engine token is only ever a BuildKit secret.

The container distribution (AK; `docs/containers.md`, `docs/sidecars.md`) is additive to that image: `containers/` (`build.sh`, `harness/Dockerfile`, `sidecars/{searxng,valkey}`, `stack.json`, `compose.yaml`), the `crates/plur1bus-containers` ports (Docker Engine API and Apple Container), the host commands `plur1bus install --container` / `setup --container` and `plur1bus container` (`src/commands/container.rs`, `src/install/containers.rs`, `src/update/containers.rs`) and `.github/workflows/containers.yml`; its static checks are `tests/container-distribution-assets.test.ts` and `crates/plur1bus/tests/container_distribution.rs`. Inside the harness image `PLUR1BUS_CONTAINER=1` makes `setup` and `update` refuse with `E_NOT_AVAILABLE reason=container-managed` (`src/container.rs`).

## Desktop shell (`apps/desktop`)

The desktop is a separate Cargo workspace, excluded from the root build. Its
lockfile lives at `apps/desktop/Cargo.lock`. Use exact direct dependency versions
and `--locked` for desktop CI. Build the static UI before invoking Cargo directly:
`pnpm --filter @plur1bus/desktop-ui build`. See `docs/desktop.md` for commands and
`docs/handoff/2026-09-30-desktop-shell-codex.md` for work-package boundaries.

Never add shell, filesystem, HTTP, dialog or opener Tauri plugins. Native IPC
commands need explicit capabilities and caller origin checks. Do not put tokens
in JavaScript or files; future tests use injected seams and scratch state. The
root hygiene check scans desktop sources and all tracked blobs for private keys
and forbidden secret/image filenames; `node scripts/lint-hygiene.mjs --self-test`
runs its regression suite. Do not commit generated native/UI build outputs.


Desktop Green: from the root run `pnpm lint`, UI build/test, then from
`apps/desktop` run fmt, `cargo clippy --locked --workspace --all-targets -- -D warnings`,
`PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1 cargo clippy --locked --workspace --release -- -D warnings`,
and `cargo test --offline --locked --workspace --no-fail-fast -- --test-threads=1`.
Release all-targets includes debug-only native fixture examples and is not a
production build gate. Never bypass missing debug APIs in release product code.
Only `tauri.release.conf.json` enables signed updater artifacts; normal CI is unsigned.

DR19 debug seams are documented in `docs/desktop.md` and the handoff: scratch
`PLUR1BUS_DESKTOP_CONFIG_DIR` forces in-memory credentials; Apple CLI/Docker
candidates, clock/feed/updater test pins and endpoints are injected. Native
fixture state uses `try_state`, never unconditional state lookup at startup.
`PLUR1BUS_DESKTOP_HELPER` selects a fake helper only in debug;
`PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1` enables mock decisions only in debug.
Do not opt into a real keychain/service manager or personal runtime during tests.

Run the mock with `cargo run --locked -p plur1bus-mock-harness -- --test-control --port 18700`.
Prepare stub images/registry separately, then run
`PLUR1BUS_DESKTOP_E2E_RUNTIME=docker node apps/desktop/scripts/container-e2e.mjs docker`
(or podman); `--dry-run` prints the isolated plan without network/mutation.
The optional Apple scaffold and nightly advisory canary/repro are not release gates.
Never commit any key file, certificate secret, OCI tarball or generated build output.
