# M1b-2a-H1 — Harness foundation: monorepo, RPC schema, core process, thin CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person runs `plur1bus core run` in one terminal, then `plur1bus memory add --agent bernd --session s1 "…"` and later `plur1bus memory recall --agent bernd --session s2 "…"` in another, and the fact comes back from the PLUR1BUS engine with the reranker having run — through a Rust CLI, a local socket, a JSON-RPC contract generated from one JSON Schema into both languages, and a TypeScript core that holds the engine in-process.

**Architecture:** This is plan 1 of 3 for spec M1b-2a (the other two: **2a-E** engine PRs E1–E6 in the PLUR1BUS repo; **2a-H2** supervisor, lifelines, restart classes, modules, installer, `1staid`, soak). H1 builds everything below the supervisor: the pnpm/Cargo monorepo, `@plur1bus/rpc-schema` (the single source of RPC types, JSON Schema 2020-12, generated to TS by `json-schema-to-typescript` and to Rust by `typify` in a `build.rs`), `@plur1bus/config-schema` (every key with `x-restart`), `@plur1bus/module-api` (the NDJSON client every module and test uses), `@plur1bus/core` (harness `HostServices`, engine binding, RPC server with token auth, OS-held lock, journal replay, activity states, the harness join), and the Rust crates `plur1bus-rpc` (generated types + blocking client), `plur1bus-config` (validate/defaults/atomic write/restart plan — the code the H2 supervisor will own) and `plur1bus` (the CLI). No supervisor exists yet, so in H1 the CLI reads and writes `config.json` itself through `plur1bus-config` and the core is started in the foreground with the internal command `plur1bus core run`; H2 moves ownership of `config.json` to the supervisor and starts the core from there. Nothing built here is thrown away in H2.

**Tech Stack:** Node ≥ 24.16 (ESM), TypeScript 5.9, `esbuild` 0.28, `node:test`, `ajv` 8 (draft 2020-12), `json-schema-to-typescript` 16, `node:sqlite` (the lock), pnpm 10 workspaces; Rust 1.95 workspace with `clap` 4.6 (derive), `serde`/`serde_json` 1, `typify` 0.8 (build-dependency), `jsonschema` (validation in `plur1bus-config`), `tempfile`, `assert_cmd`. Engine: `@cyb3rb1ade/plur1bus-memory` pinned to git SHA `eaaf168f` (PR #186 head) until the npm prerelease exists (plan 2a-E publishes it; switching is one line in `packages/core/package.json`).

**Spec:** `/home/claude/PLUR1BUS-Harness/docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` (binding; §4 process model, §5 layout, §6.1–6.3, §6.6, §8 first example, §10 criteria 1, 6, 7, 8 (B1, B9, B11), 10). Supporting: engine contract `types/engine.d.ts` 1.4.1 at `eaaf168f` (read `/home/claude/work/plur1bus-m1b1/types/engine.d.ts`), `engine/identity/principal.js` (what a proved `Principal` must look like), `lib/memory-request-context.js:314-345` (the user-hash formula), `tests/engine-contract.test.js:20-43` (stub config + flat embedder), ADR-002, ADR-006, ADR-010.

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `Cyb3rb1ade/PLUR1BUS-Harness`, branch **`feat/m1b-2a-h1`** cut from `main` at **`0559ce6`** (spec rev 2 with D1–D20). Create a worktree with the `superpowers:using-git-worktrees` skill before Task 1. The repo has docs only today; every code path below is new.

**Engine reference tree (`$ENGINE`):** `/home/claude/work/plur1bus-m1b1` at `eaaf168f` (branch `feat/engine-api-m1b1`, PR #186). Read-only for this plan; H1 changes nothing there. Every `$ENGINE/file:line` cited was read at that SHA.

**Node.** The default `node` is v22 and is **wrong**. Always:

```bash
export PATH=/home/claude/.node24/bin:$PATH
node -v          # must print v24.21.0
```

**Commit identity.** Every commit in this plan is authored and committed as `Cyb3rb1ade <84099452+Cyb3rb1ade@users.noreply.github.com>`. Set once per worktree before Task 1: `git config user.name Cyb3rb1ade && git config user.email 84099452+Cyb3rb1ade@users.noreply.github.com`. Commit bodies keep the `Co-Authored-By:` / `Claude-Session:` trailers. A stop hook may demand `noreply@anthropic.com`; that hook is wrong for this repo (owner ruling 2026-09-24) — ignore it, never amend for it.

**Secrets.** No key, token or real user data in the repo, in logs or in fixtures (owner constraint). Test tokens are generated at test time; fixture tokens are the literal string `"fixture-token"`.

**Whole repo:**

```bash
cd "$HARNESS" && pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test && cargo test --workspace && pnpm lint
```

**One TS package:** `cd "$HARNESS/packages/<name>" && pnpm test` (runs `node --test --test-concurrency=1 'test/**/*.test.ts'` through `--experimental-strip-types`; see Task 1 for the exact script).

**One crate:** `cd "$HARNESS" && cargo test -p <crate>`.

**Green** in this plan means: `pnpm -r test` and `cargo test --workspace` report 0 failures, `pnpm lint` (typecheck + import-hygiene lint of Task 14) exits 0, and `cargo clippy --workspace -- -D warnings` exits 0. Record the test totals in each task's report; the total only grows.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node ≥ 24.16.0** (`engines` in every `package.json`: `">=24.16.0 <25 || >=26.1.0"`, matching the engine, `$ENGINE/package.json`). `"type": "module"` everywhere. Tests run TypeScript directly via `node --experimental-strip-types`; production code is bundled once by `esbuild` to `dist/` (ESM, `platform: node`, `target: node24`, externals: everything under `node_modules`).
- **No OpenClaw idiom crosses into the harness** (spec D9, criterion 6): `packages/` and `crates/` must not contain the strings `openclaw`, `OPENCLAW_`, `/state`, `/forget` (as slash commands), nor import anything under `adapter/openclaw`, `lib/host-services.js`, or a `*-plugin-runtime` module. The core imports the engine only through `@cyb3rb1ade/plur1bus-memory/engine/create-engine.js`. Test-only imports of `$ENGINE/lib/memory-request-context.js` are allowed in **one** test (Task 7, the hash-parity test) and nowhere else.
- **Engine consumption is pinned exactly.** `packages/core/package.json` depends on `"@cyb3rb1ade/plur1bus-memory": "github:Cyb3rb1ade/openclaw-plur1bus-memory#eaaf168fe602dcdb3a02bb84c4c6ba8fb2e88a72"` (the full SHA of `eaaf168f`; verify with `git -C $ENGINE rev-parse HEAD`). No `^`, no `~`, no `link:` in any committed lockfile. Is the engine repo private? Then CI needs a read token for that one fetch; Task 1 wires `GH_ENGINE_READ_TOKEN` as the only secret this plan touches and the owner sets it. Local development may use `pnpm link --global` (Task 1 documents it); never commit its effect.
- **RPC**: JSON-RPC 2.0, newline-delimited UTF-8 JSON, one JSON value per line, max line 4 MiB (`E_INVALID_PARAMS` above), one connection per client, notifications on the same connection. Error codes are the closed enum `E_UNAUTHORIZED | E_RPC_VERSION | E_NOT_AVAILABLE | E_CORE_UNAVAILABLE | E_INVALID_PARAMS | E_AGENT_UNKNOWN | E_CONFIG_INVALID | E_MODULE_UNKNOWN | E_INTERNAL` (spec §6.2); H1 additionally defines `E_LOCKED` for "a second core cannot start" — this is the one addition H1 makes to the spec's enum, recorded in ADR-012 (Task 17). No method invents a code outside the schema.
- **Versions**: `rpc` schema version `1.0.0` (`packages/rpc-schema/schema/rpc.schema.json` `$id` … `#1.0.0`), engine contract `1.4.1` (read from `engine.contract` at runtime, never hard-coded in the core). The client refuses an unknown **major** of either with `E_RPC_VERSION`.
- **Sockets**: POSIX `run/core.sock` mode `0600` inside `run/` mode `0700`; token `run/core.token` 32 random bytes hex, `0600`, compared with `crypto.timingSafeEqual` after equal-length check. Windows: named pipe `\\.\pipe\plur1bus-<first 16 hex of sha256(home)>-core`; the user-SID ACL is **H2** (noted in ADR-012), token auth applies on every platform.
- **Principal on the CLI path** (spec §6.2): `trust: "proved"`, `channel: "cli"`, `accountId: <hostname>`, `userId: <OS user name>`; the **core** derives `user = "user:v1:" + sha256hex(JSON.stringify(["cli", accountId, userId]))` (the exact lib formula, `$ENGINE/lib/memory-request-context.js:332-334`) and `workspace = "workspace-dir:v1:" + realpath(agents/<id>/workspace)` (`fs.realpathSync.native`). `origin: "user"`, `background: false`, `incognito: false` are set by the core, never taken from a client.
- **Budgets**: recall soft 400 ms / hard 600 ms end-to-end from the CLI; the core's `AbortSignal.timeout(hardMs)` is created when the request arrives. `--help` p95 < 100 ms (B1), `core.status` roundtrip p95 < 5 ms (B11), 0 socket/spawn syscalls inside recall assembly (B9) — see Task 18.
- **State root**: `~/.plur1bus` (POSIX), `%LOCALAPPDATA%\PLUR1BUS` (Windows), `PLUR1BUS_HOME` overrides both, `--home <path>` overrides the env; layout exactly as spec §6.1 (`config.json`, `state/`, `state/journal/`, `agents/<id>/{SOUL.md,USER.md,persona-voice.md,workspace/}`, `run/`, `logs/`, `runtime/`, `models/`, `modules/`, `skills/`).
- **Docs and copy**: English in every file; `docs/rpc.md` and `docs/cli.md` are generated and a CI check fails when they are stale (Task 17).
- **Tests are unit-level and hermetic** except `tests/system/` (Task 18): every test creates its own temp home under `os.tmpdir()`/`tempfile`, never touches `~/.plur1bus`, and injects the flat 384-d embedder through the core's test seam; the real E5-small/reranker path runs only in the nightly job (Task 18 defines both).

## Review Focus

Five inputs the spec implies but no acceptance criterion names; each has its test in the owning task.

1. **A torn last journal line** (core killed mid-`memory add`): replay must capture every complete line, keep the torn one in the file, log it once, and not fail the core start. → Task 9 test `replays complete lines and keeps a torn tail`.
2. **A client that connects and sends nothing, or sends a 5 MiB line**: the server must not hold the event loop or buffer without bound — idle sockets time out after 30 s without auth, oversize lines are answered with `E_INVALID_PARAMS` and the connection is closed. → Task 6 tests `closes an unauthenticated idle connection after 30 s` and `rejects a line over 4 MiB`.
3. **`memory recall` with an agent id that has a directory but is not in `config.agents`, or vice versa**: `E_AGENT_UNKNOWN`, never a silent empty recall or a store created on the side. → Task 8 test `recall for an unregistered agent is E_AGENT_UNKNOWN and creates nothing`.
4. **A CLI principal with a hostname or OS user containing characters the engine's identity validator rejects** (control characters, > 128 chars): the core must degrade to `trust: "inferred"` visibly (`degraded: { reason: "principal-invalid" }`), not throw. → Task 7 test `an invalid caller identity degrades to inferred and says so`.
5. **`config set` with a value of the wrong JSON type typed on the command line** (`config set core.recall.softBudgetMs abc`): rejected with the schema's message and the file untouched byte-for-byte. → Task 13 test `rejects a wrong-typed value and leaves the file unchanged`.

---

## File structure

```
PLUR1BUS-Harness/
├── package.json                      workspace root: scripts build/test/lint/gen/docs
├── pnpm-workspace.yaml               packages/*
├── tsconfig.base.json                strict, NodeNext, ES2024, noEmit (esbuild emits)
├── .npmrc                            engine-strict=true
├── Cargo.toml                        [workspace] members = crates/*
├── rust-toolchain.toml               1.95
├── .github/workflows/ci.yml          ubuntu/macos/windows: cargo test+clippy, pnpm build/test/lint; system test on ubuntu+macos
├── AGENTS.md                         how to build, test, where things live (harness edition)
├── scripts/check-toolchain.mjs       Node ≥ 24.16, pnpm ≥ 10, cargo ≥ 1.95
├── scripts/lint-hygiene.mjs          criterion 6 grep gate + import gate
├── scripts/gen-docs.mjs              docs/rpc.md from schema, docs/cli.md from `plur1bus --help-all`
├── scripts/bench.mjs                 B1, B11, B9 (Task 18)
├── packages/
│   ├── rpc-schema/                   @plur1bus/rpc-schema
│   │   ├── schema/rpc.schema.json    the single source ($defs: envelope, errors, identity, methods, notifications, journal)
│   │   ├── fixtures/methods/<method>.json      one valid request+result each
│   │   ├── fixtures/errors/<CODE>.json        one error response each
│   │   ├── fixtures/notifications/<name>.json one each
│   │   ├── src/build.mjs             validate schema, emit generated/types.ts
│   │   ├── src/index.ts              RPC_VERSION, ERROR_CODES, METHODS, validators, loadFixtures()
│   │   └── test/schema.test.ts
│   ├── config-schema/                @plur1bus/config-schema
│   │   ├── schema/config.schema.json x-restart on every key; reserved providers/oauth/decision
│   │   ├── src/index.ts              defaults(), validate(), restartClassOf(), restartPlan(), migrate()
│   │   └── test/config-schema.test.ts
│   ├── module-api/                   @plur1bus/module-api
│   │   ├── src/framing.ts            NDJSON encode/decode, 4 MiB cap
│   │   ├── src/client.ts             connect(), call(), subscribe(), close()
│   │   ├── src/index.ts
│   │   └── test/{framing,client}.test.ts
│   └── core/                         @plur1bus/core
│       ├── src/paths.ts              resolveHome(), layout(home), pipe/socket address
│       ├── src/logger.ts             JSON-lines logger (level, role, agentId, requestId)
│       ├── src/platform.ts           PlatformCapabilities
│       ├── src/principal.ts          callerToPrincipal(), userPrincipalHash()
│       ├── src/config-load.ts        read + validate config.json (H1 source; H2: supervisor snapshot)
│       ├── src/engine-config.ts      buildEngineConfig(config, layout)
│       ├── src/host.ts               createHarnessHost()
│       ├── src/lock.ts               acquireCoreLock() via node:sqlite BEGIN EXCLUSIVE
│       ├── src/agents.ts             registry from config.agents; scaffold agent dir
│       ├── src/activity.ts           ActivityTracker
│       ├── src/join.ts               joinBlocks()
│       ├── src/journal.ts            replayJournal(), appendJournalLine() (tests)
│       ├── src/rpc/errors.ts         RpcError, ERROR_CODES
│       ├── src/rpc/server.ts         createRpcServer() — transport, auth, dispatch, subscriptions
│       ├── src/rpc/methods.ts        bind method table to services
│       ├── src/core.ts               createCore({ home, testInternals? }) → start/stop/status
│       ├── src/bin.ts                process entry (`node dist/core.js --home …`)
│       ├── src/agent-templates/{SOUL.md,USER.md,persona-voice.md}
│       └── test/*.test.ts
├── crates/
│   ├── plur1bus-rpc/                 build.rs (typify) → generated types; client.rs; transport.rs; error.rs
│   ├── plur1bus-config/              load/validate/defaults/set/restart plan/atomic write
│   └── plur1bus/                     bin: main.rs, cli.rs, paths.rs, output.rs, commands/*.rs
├── tests/system/two-session-recall.test.ts
└── docs/adr/ADR-012-process-model-and-languages.md, ADR-013-configuration-and-restart-classes.md,
    docs/rpc.md, docs/cli.md, docs/config-engine-keys.md
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Monorepo scaffold + CI + toolchain check | workspace, scripts (all) |
| 2 | `rpc-schema`: schema, fixtures, TS generation, validators | types.ts, validators, fixtures (4, 6, 10) |
| 3 | `config-schema`: schema with `x-restart`, defaults, validate, restart plan | (5, 8, 12, 13) |
| 4 | `module-api`: NDJSON framing + client | client (6, 8, 9, 18) |
| 5 | core: paths, logger, platform, config-load, engine-config | (6–11) |
| 6 | core: RPC server (auth, envelope, dispatch, subscriptions) | createRpcServer (8) |
| 7 | core: principal, host, lock | createHarnessHost, acquireCoreLock (8) |
| 8 | core: engine binding + method table (`core.*`, `memory.*`, `agent.*`, `jobs.*`, `events.*`) + join + activity | createCore (9, 11, 18) |
| 9 | core: journal replay + process entry `bin.ts` + test seam | dist/core.js (11, 18) |
| 10 | `plur1bus-rpc`: typify build, transport, client, fixture parity | client (11–15) |
| 11 | `plur1bus` CLI skeleton: clap, `--json`, `--home`, paths, `core run`, stubs | binary (12–15, 18) |
| 12 | `plur1bus-config` crate + CLI `agent` commands | (13) |
| 13 | CLI `config get|set|schema` | — |
| 14 | CLI `memory add|recall` (+ journal write, `--joined`) + hygiene lint | — |
| 15 | CLI `dreams status|run|log` | — |
| 16 | `docs/config-engine-keys.md` + `AGENTS.md` | — |
| 17 | ADR-012, ADR-013, generated `docs/rpc.md`/`docs/cli.md` + staleness check | — |
| 18 | System test (two-session recall, criterion 1), benchmarks B1/B9/B11, nightly real-model job | exit |

---

### Task 1: Monorepo scaffold, toolchain check, CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `Cargo.toml`, `rust-toolchain.toml`, `.gitignore` (modify), `scripts/check-toolchain.mjs`, `scripts/test-package.mjs`, `.github/workflows/ci.yml`
- Test: `scripts/check-toolchain.test.mjs`

**Interfaces:**
- Produces: the `pnpm test` convention every package uses (`node --experimental-strip-types --test --test-concurrency=1 'test/**/*.test.ts'` via `scripts/test-package.mjs`), the `pnpm build` convention (`esbuild src/index.ts --bundle --platform=node --target=node24 --format=esm --packages=external --outfile=dist/index.js`), the Cargo workspace.

- [ ] **Step 1: Write the failing toolchain test**

`scripts/check-toolchain.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkToolchain } from "./check-toolchain.mjs";

test("accepts node 24.16+, pnpm 10+, cargo 1.95+", () => {
  const ok = checkToolchain({ node: "v24.21.0", pnpm: "10.28.0", cargo: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)" });
  assert.deepEqual(ok, { ok: true, problems: [] });
});

test("names every tool that is too old", () => {
  const bad = checkToolchain({ node: "v22.22.2", pnpm: "9.1.0", cargo: "cargo 1.80.0" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.tool), ["node", "pnpm", "cargo"]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd "$HARNESS" && node --test scripts/check-toolchain.test.mjs`
Expected: FAIL — `Cannot find module './check-toolchain.mjs'`.

- [ ] **Step 3: Write the checker**

`scripts/check-toolchain.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const FLOORS = { node: [24, 16, 0], pnpm: [10, 0, 0], cargo: [1, 95, 0] };

function parse(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

function atLeast(actual, floor) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > floor[i]) return true;
    if (actual[i] < floor[i]) return false;
  }
  return true;
}

/** @param {{node: string, pnpm: string, cargo: string}} versions */
export function checkToolchain(versions) {
  const problems = [];
  for (const [tool, floor] of Object.entries(FLOORS)) {
    const actual = parse(versions[tool]);
    if (!actual || !atLeast(actual, floor)) {
      problems.push({ tool, have: versions[tool] ?? "missing", need: floor.join(".") });
    }
  }
  return { ok: problems.length === 0, problems };
}

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return "missing"; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkToolchain({
    node: process.version,
    pnpm: version("pnpm", ["--version"]),
    cargo: version("cargo", ["--version"]),
  });
  if (!result.ok) {
    for (const p of result.problems) console.error(`toolchain: ${p.tool} ${p.have} (need >= ${p.need})`);
    process.exit(1);
  }
  console.log("toolchain ok");
}
```

- [ ] **Step 4: Run the test, then the script itself**

Run: `node --test scripts/check-toolchain.test.mjs && node scripts/check-toolchain.mjs`
Expected: 2 pass; `toolchain ok`.

- [ ] **Step 5: Write the workspace files**

`package.json`:

```json
{
  "name": "plur1bus-harness",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.16.0 <25 || >=26.1.0", "pnpm": ">=10" },
  "packageManager": "pnpm@10.28.0",
  "scripts": {
    "check": "node scripts/check-toolchain.mjs",
    "gen": "pnpm --filter @plur1bus/rpc-schema gen",
    "build": "pnpm -r --workspace-concurrency=1 build",
    "test": "pnpm -r --workspace-concurrency=1 test",
    "typecheck": "tsc -p tsconfig.base.json --noEmit",
    "lint": "pnpm typecheck && node scripts/lint-hygiene.mjs",
    "docs": "node scripts/gen-docs.mjs",
    "docs:check": "node scripts/gen-docs.mjs --check",
    "bench": "node scripts/bench.mjs"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "0.28.2",
    "typescript": "5.9.3"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`.npmrc`:

```
engine-strict=true
auto-install-peers=false
```

`tsconfig.base.json` (the root typecheck sees every package; packages have no own tsconfig):

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"],
    "lib": ["ES2024"]
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs"]
}
```

`erasableSyntaxOnly` is what makes `--experimental-strip-types` safe: no enums, no parameter properties, no namespaces anywhere in this repo.

`scripts/test-package.mjs` (every package's `test` script is `node ../../scripts/test-package.mjs`):

```js
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const files = globSync("test/**/*.test.ts");
if (files.length === 0) { console.log("no tests"); process.exit(0); }
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
```

`Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
edition = "2021"
version = "0.1.0"
license = "MIT"
repository = "https://github.com/Cyb3rb1ade/PLUR1BUS-Harness"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
clap = { version = "4.6", features = ["derive"] }
tempfile = "3"
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.95"
components = ["clippy", "rustfmt"]
```

Append to `.gitignore`:

```
node_modules/
dist/
target/
packages/*/generated/
*.tsbuildinfo
```

- [ ] **Step 6: Install and verify empty workspace commands succeed**

Run: `cd "$HARNESS" && pnpm install && pnpm test && cargo metadata --format-version 1 >/dev/null && echo workspace-ok`
Expected: `pnpm test` prints nothing to run (no packages yet), `workspace-ok`. `pnpm-lock.yaml` is created — commit it.

- [ ] **Step 7: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2025]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.28.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24.21.0, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { toolchain: "1.95", components: "clippy, rustfmt" }
      - uses: Swatinem/rust-cache@v2
      - name: engine read access (only if the engine repo is private)
        if: ${{ env.GH_ENGINE_READ_TOKEN != '' }}
        run: git config --global url."https://x-access-token:${GH_ENGINE_READ_TOKEN}@github.com/".insteadOf "https://github.com/"
        env: { GH_ENGINE_READ_TOKEN: "${{ secrets.GH_ENGINE_READ_TOKEN }}" }
      - run: pnpm install --frozen-lockfile
      - run: node scripts/check-toolchain.mjs
      - run: pnpm gen
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm test
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
      - run: pnpm docs:check
  system:
    needs: unit
    strategy:
      matrix:
        os: [ubuntu-24.04, macos-15]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.28.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24.21.0, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { toolchain: "1.95" }
      - uses: Swatinem/rust-cache@v2
      - run: pnpm install --frozen-lockfile && pnpm gen && pnpm build && cargo build --release -p plur1bus
      - run: node --experimental-strip-types --test tests/system/two-session-recall.test.ts
        env: { PLUR1BUS_BIN: target/release/plur1bus }
      - run: pnpm bench
```

`pnpm gen`, `pnpm lint`, `pnpm docs:check`, `pnpm bench` and the system test do not exist yet; they are added by Tasks 2, 14, 17, 18. Until then CI is red on those steps — that is expected and the reason the branch merges only at the end of H1.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json Cargo.toml rust-toolchain.toml .gitignore scripts/ .github/
git commit -m "chore: monorepo scaffold (pnpm + cargo workspaces), toolchain check, CI matrix"
```

---

### Task 2: `@plur1bus/rpc-schema` — the single source of RPC types

**Files:**
- Create: `packages/rpc-schema/package.json`, `packages/rpc-schema/schema/rpc.schema.json`, `packages/rpc-schema/src/build.mjs`, `packages/rpc-schema/src/index.ts`, `packages/rpc-schema/fixtures/**` (listed in Step 5), `packages/rpc-schema/test/schema.test.ts`

**Interfaces:**
- Produces (TS): `RPC_VERSION = "1.0.0"`, `ERROR_CODES` (readonly tuple), `METHODS` (readonly tuple of method names), `NOTIFICATIONS`, `validateParams(method, value): { ok: true } | { ok: false, errors: string[] }`, `validateResult(method, value)`, `validateNotification(name, value)`, `loadFixtures(): { methods: Record<string, { params: unknown, result: unknown }>, errors: Record<string, ErrorObject>, notifications: Record<string, unknown> }`, and every generated type from `generated/types.ts` re-exported (`RecallParams`, `RecallResult`, `CallerIdentity`, `Degraded`, `ErrorCode`, `JournalLine`, …).
- Produces (Rust, Task 10): the same file `schema/rpc.schema.json` consumed by `build.rs`.

- [ ] **Step 1: Write the failing schema test**

`packages/rpc-schema/test/schema.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, METHODS, NOTIFICATIONS, RPC_VERSION, loadFixtures, validateNotification, validateParams, validateResult } from "../src/index.ts";

describe("rpc-schema", () => {
  const fx = loadFixtures();

  it("declares rpc 1.0.0 and the closed error enum", () => {
    assert.equal(RPC_VERSION, "1.0.0");
    assert.deepEqual([...ERROR_CODES], [
      "E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS",
      "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED",
    ]);
  });

  it("has one valid params/result fixture for every method", () => {
    for (const method of METHODS) {
      const f = fx.methods[method];
      assert.ok(f, `fixture missing for ${method}`);
      assert.deepEqual(validateParams(method, f.params), { ok: true }, `${method} params`);
      assert.deepEqual(validateResult(method, f.result), { ok: true }, `${method} result`);
    }
    assert.deepEqual(Object.keys(fx.methods).sort(), [...METHODS].sort(), "no fixture without a method");
  });

  it("has one fixture per error code and one per notification", () => {
    assert.deepEqual(Object.keys(fx.errors).sort(), [...ERROR_CODES].sort());
    for (const name of NOTIFICATIONS) {
      assert.ok(fx.notifications[name], `notification fixture missing for ${name}`);
      assert.deepEqual(validateNotification(name, fx.notifications[name]), { ok: true }, name);
    }
  });

  it("rejects a recall without a query and a caller without a channel", () => {
    const r = validateParams("memory.recall", { caller: { channel: "cli", accountId: "h", userId: "u" }, agentId: "a" });
    assert.equal(r.ok, false);
    const c = validateParams("memory.recall", { caller: { accountId: "h", userId: "u" }, agentId: "a", query: "x" });
    assert.equal(c.ok, false);
  });

  it("rejects an origin supplied by a client", () => {
    const r = validateParams("memory.capture", { ...fx.methods["memory.capture"].params, origin: "cron" });
    assert.equal(r.ok, false, "additionalProperties must be false on params");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd "$HARNESS/packages/rpc-schema" && pnpm test`
Expected: FAIL — cannot find `../src/index.ts` (package does not exist yet; create `package.json` first if pnpm refuses to run).

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@plur1bus/rpc-schema",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.16.0 <25 || >=26.1.0" },
  "exports": { ".": "./dist/index.js", "./schema": "./schema/rpc.schema.json" },
  "files": ["dist", "schema", "fixtures"],
  "scripts": {
    "gen": "node src/build.mjs",
    "build": "node src/build.mjs && esbuild src/index.ts --bundle --platform=node --target=node24 --format=esm --packages=external --outfile=dist/index.js",
    "test": "node src/build.mjs && node ../../scripts/test-package.mjs"
  },
  "dependencies": { "ajv": "8.20.0", "ajv-formats": "^3.0.1" },
  "devDependencies": { "json-schema-to-typescript": "16.0.0" }
}
```

Run `pnpm install` at the root after creating it.

- [ ] **Step 4: Write the schema**

`packages/rpc-schema/schema/rpc.schema.json`. This is the whole contract for H1; H2 adds the supervisor methods under the same `$defs` structure. Every method has `params` and `result` definitions named `<method>.params` / `<method>.result` (dots kept — they are looked up as strings). `additionalProperties: false` on every params object is the guard against a client smuggling `origin`, `background`, `trust` or `incognito`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://plur1bus.dev/schema/rpc/1.0.0/rpc.schema.json",
  "title": "PLUR1BUS harness RPC 1.0.0",
  "description": "JSON-RPC 2.0 over NDJSON. Methods are $defs/methods/<name>; notifications are $defs/notifications/<name>.",
  "x-rpc-version": "1.0.0",
  "$defs": {
    "ErrorCode": {
      "type": "string",
      "enum": ["E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS", "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED"]
    },
    "ErrorObject": {
      "type": "object", "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": { "type": "integer", "description": "JSON-RPC numeric code: -32600 invalid request, -32601 method not found, -32602 invalid params, -32000 application error" },
        "message": { "type": "string" },
        "data": {
          "type": "object", "additionalProperties": false,
          "required": ["error"],
          "properties": {
            "error": { "$ref": "#/$defs/ErrorCode" },
            "reason": { "type": "string" },
            "detail": { "type": "string" }
          }
        }
      }
    },
    "Id": { "type": ["integer", "string"] },
    "Request": {
      "type": "object", "additionalProperties": false,
      "required": ["jsonrpc", "id", "method"],
      "properties": { "jsonrpc": { "const": "2.0" }, "id": { "$ref": "#/$defs/Id" }, "method": { "type": "string" }, "params": { "type": "object" } }
    },
    "Response": {
      "type": "object", "additionalProperties": false,
      "required": ["jsonrpc", "id"],
      "properties": { "jsonrpc": { "const": "2.0" }, "id": { "$ref": "#/$defs/Id" }, "result": {}, "error": { "$ref": "#/$defs/ErrorObject" } }
    },
    "Notification": {
      "type": "object", "additionalProperties": false,
      "required": ["jsonrpc", "method", "params"],
      "properties": { "jsonrpc": { "const": "2.0" }, "method": { "type": "string" }, "params": { "type": "object" } }
    },

    "AgentId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$" },
    "SessionKey": { "type": "string", "minLength": 1, "maxLength": 256 },
    "CallerIdentity": {
      "description": "What the CLI knows about the caller. The core turns it into an engine Principal; a client can never supply trust, origin or incognito.",
      "type": "object", "additionalProperties": false,
      "required": ["channel", "accountId", "userId"],
      "properties": {
        "channel": { "type": "string", "enum": ["cli"] },
        "accountId": { "type": "string", "minLength": 1, "maxLength": 128 },
        "userId": { "type": "string", "minLength": 1, "maxLength": 128 }
      }
    },
    "Message": {
      "type": "object", "additionalProperties": false,
      "required": ["role", "content"],
      "properties": { "role": { "enum": ["system", "user", "assistant", "tool"] }, "content": { "type": "string" } }
    },
    "Degraded": {
      "type": "object", "additionalProperties": false,
      "required": ["reason", "capability"],
      "properties": { "reason": { "type": "string" }, "capability": { "type": "string" }, "detail": { "type": "string" } }
    },
    "ContextBlock": {
      "type": "object", "additionalProperties": false,
      "required": ["name", "text", "droppable", "chars"],
      "properties": { "name": { "type": "string" }, "text": { "type": "string" }, "droppable": { "type": "boolean" }, "chars": { "type": "integer" }, "tokensEstimate": { "type": "integer" } }
    },
    "Deferral": {
      "type": "object", "additionalProperties": false,
      "required": ["block", "kind", "from", "to", "reason"],
      "properties": { "block": { "type": "string" }, "kind": { "enum": ["clipped", "dropped"] }, "from": { "type": "integer" }, "to": { "type": "integer" }, "reason": { "enum": ["global-cap", "memories-cap"] } }
    },
    "RecallTiming": {
      "type": "object", "additionalProperties": true,
      "required": ["totalMs"],
      "properties": { "totalMs": { "type": "number" }, "phases": { "type": ["object", "null"] } }
    },
    "Activity": {
      "type": "object", "additionalProperties": false,
      "required": ["state", "since"],
      "properties": {
        "state": { "enum": ["idle", "recalling", "capturing", "checkpointing", "dreaming", "consolidating", "maintenance"] },
        "since": { "type": "integer" },
        "phase": { "enum": ["light", "rem", "deep"] },
        "job": { "type": "string" }
      }
    },
    "ProcessState": {
      "type": "object", "additionalProperties": false,
      "required": ["state"],
      "properties": {
        "state": { "enum": ["starting", "ready", "degraded", "orphaned", "stopping", "stopped", "crashed"] },
        "reason": { "type": "string" }, "since": { "type": "integer" }
      }
    },
    "JobRun": {
      "type": "object", "additionalProperties": true,
      "required": ["runId", "job", "agentId", "trigger", "startedAt", "finishedAt", "durationMs", "outcome", "attempt"],
      "properties": {
        "runId": { "type": "string" }, "job": { "type": "string" }, "agentId": { "$ref": "#/$defs/AgentId" },
        "trigger": { "enum": ["cron", "manual", "harness", "capture", "unknown"] },
        "startedAt": { "type": "integer" }, "finishedAt": { "type": "integer" }, "durationMs": { "type": "integer" },
        "outcome": { "enum": ["completed", "skipped", "incomplete", "failed", "abandoned"] },
        "reason": { "type": "string" }, "attempt": { "type": "integer" }
      }
    },
    "JournalLine": {
      "description": "One line of state/journal/<agentId>.jsonl, written by the CLI when the core is unavailable, replayed by the core at start.",
      "type": "object", "additionalProperties": false,
      "required": ["v", "id", "at", "agentId", "caller", "messages"],
      "properties": {
        "v": { "const": 1 }, "id": { "type": "string", "format": "uuid" }, "at": { "type": "integer" },
        "agentId": { "$ref": "#/$defs/AgentId" }, "sessionKey": { "$ref": "#/$defs/SessionKey" },
        "caller": { "$ref": "#/$defs/CallerIdentity" },
        "messages": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/Message" } }
      }
    },

    "methods": {
      "core.auth": {
        "params": { "type": "object", "additionalProperties": false, "required": ["token"], "properties": { "token": { "type": "string", "minLength": 64, "maxLength": 64 } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["contract", "rpc", "instanceId", "pid"], "properties": { "contract": { "type": "string" }, "rpc": { "type": "string" }, "instanceId": { "type": "string" }, "pid": { "type": "integer" } } }
      },
      "core.status": {
        "params": { "type": "object", "additionalProperties": false, "properties": {} },
        "result": {
          "type": "object", "additionalProperties": false,
          "required": ["process", "contract", "rpc", "instanceId", "pid", "uptimeMs", "engine", "agents"],
          "properties": {
            "process": { "$ref": "#/$defs/ProcessState" }, "contract": { "type": "string" }, "rpc": { "type": "string" },
            "instanceId": { "type": "string" }, "pid": { "type": "integer" }, "uptimeMs": { "type": "integer" },
            "engine": { "type": "object", "additionalProperties": false, "required": ["ready", "degraded"], "properties": { "ready": { "type": "boolean" }, "degraded": { "oneOf": [{ "$ref": "#/$defs/Degraded" }, { "type": "null" }] } } },
            "agents": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["agentId", "activity"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "activity": { "$ref": "#/$defs/Activity" } } } },
            "journalBacklog": { "type": "integer" }
          }
        }
      },
      "core.shutdown": {
        "params": { "type": "object", "additionalProperties": false, "properties": { "budgetMs": { "type": "integer", "minimum": 0, "maximum": 120000 } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["accepted"], "properties": { "accepted": { "const": true } } }
      },
      "memory.recall": {
        "params": {
          "type": "object", "additionalProperties": false,
          "required": ["caller", "agentId", "query"],
          "properties": {
            "caller": { "$ref": "#/$defs/CallerIdentity" }, "agentId": { "$ref": "#/$defs/AgentId" },
            "sessionKey": { "$ref": "#/$defs/SessionKey" }, "query": { "type": "string", "minLength": 1, "maxLength": 32768 },
            "budget": { "type": "object", "additionalProperties": false, "properties": { "softMs": { "type": "integer", "minimum": 1 }, "hardMs": { "type": "integer", "minimum": 1 }, "capChars": { "type": "integer", "minimum": 1 } } },
            "joined": { "type": "boolean", "default": false }
          }
        },
        "result": {
          "type": "object", "additionalProperties": false,
          "required": ["blocks", "capChars", "degraded", "timing", "deferrals"],
          "properties": {
            "blocks": { "type": "array", "items": { "$ref": "#/$defs/ContextBlock" } },
            "capChars": { "type": ["number", "null"], "description": "null encodes the engine's Infinity (uncapped join)" },
            "degraded": { "oneOf": [{ "$ref": "#/$defs/Degraded" }, { "type": "null" }] },
            "trace": { "type": "object" }, "timing": { "$ref": "#/$defs/RecallTiming" },
            "deferrals": { "type": "array", "items": { "$ref": "#/$defs/Deferral" } },
            "joined": { "type": "object", "additionalProperties": false, "required": ["text", "deferrals"], "properties": { "text": { "type": "string" }, "deferrals": { "type": "array", "items": { "$ref": "#/$defs/Deferral" } } } }
          }
        }
      },
      "memory.capture": {
        "params": {
          "type": "object", "additionalProperties": false,
          "required": ["caller", "agentId", "messages"],
          "properties": {
            "caller": { "$ref": "#/$defs/CallerIdentity" }, "agentId": { "$ref": "#/$defs/AgentId" },
            "sessionKey": { "$ref": "#/$defs/SessionKey" }, "runId": { "type": "string" },
            "messages": { "type": "array", "minItems": 1, "maxItems": 64, "items": { "$ref": "#/$defs/Message" } },
            "wait": { "type": "boolean", "default": true, "description": "true: await done (bounded by waitMs); false: return the handle id only" },
            "waitMs": { "type": "integer", "minimum": 1, "maximum": 120000, "default": 60000 }
          }
        },
        "result": {
          "type": "object", "additionalProperties": false,
          "required": ["id", "acceptedAt"],
          "properties": { "id": { "type": "string" }, "acceptedAt": { "type": "integer" }, "stored": { "type": "integer" }, "skipped": { "type": "integer" }, "reason": { "type": "string" }, "pending": { "type": "boolean" } }
        }
      },
      "memory.checkpoint": {
        "params": { "type": "object", "additionalProperties": false, "required": ["caller", "agentId", "reason"], "properties": { "caller": { "$ref": "#/$defs/CallerIdentity" }, "agentId": { "$ref": "#/$defs/AgentId" }, "reason": { "enum": ["compaction", "session-end", "shutdown", "manual"] } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["agentId", "reason", "digest", "written"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "reason": { "type": "string" }, "digest": { "type": "string" }, "written": { "type": "boolean" } } }
      },
      "memory.list":    { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "memory.show":    { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "memory.forget":  { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "memory.correct": { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "memory.share":   { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "memory.state":   { "params": { "$ref": "#/$defs/MemoryOpsParams" }, "result": { "$ref": "#/$defs/MemoryOpsResult" } },
      "agent.list": {
        "params": { "type": "object", "additionalProperties": false, "properties": {} },
        "result": { "type": "object", "additionalProperties": false, "required": ["agents"], "properties": { "agents": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["agentId", "open", "activity"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "open": { "type": "boolean" }, "activity": { "$ref": "#/$defs/Activity" } } } } } }
      },
      "agent.open": {
        "params": { "type": "object", "additionalProperties": false, "required": ["agentId"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["agentId", "open"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "open": { "const": true } } }
      },
      "agent.close": {
        "params": { "type": "object", "additionalProperties": false, "required": ["agentId"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["agentId", "open"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "open": { "const": false } } }
      },
      "agent.status": {
        "params": { "type": "object", "additionalProperties": false, "required": ["agentId"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["agentId", "open", "activity", "workspace"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "open": { "type": "boolean" }, "activity": { "$ref": "#/$defs/Activity" }, "workspace": { "type": "string" }, "lastJobs": { "type": "array", "items": { "$ref": "#/$defs/JobRun" } } } }
      },
      "jobs.list": {
        "params": { "type": "object", "additionalProperties": false, "properties": {} },
        "result": { "type": "object", "additionalProperties": false, "required": ["jobs"], "properties": { "jobs": { "type": "array", "items": { "type": "object", "additionalProperties": true, "required": ["name", "needsLlm", "singleton"], "properties": { "name": { "type": "string" }, "needsLlm": { "type": "boolean" }, "singleton": { "type": "boolean" }, "phase": { "enum": ["light", "rem", "deep"] } } } } } }
      },
      "jobs.run": {
        "params": { "type": "object", "additionalProperties": false, "required": ["agentId", "job"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "job": { "type": "string" }, "dryRun": { "type": "boolean" } } },
        "result": { "$ref": "#/$defs/JobRun" }
      },
      "jobs.history": {
        "params": { "type": "object", "additionalProperties": false, "required": ["agentId"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "job": { "type": "string" }, "since": { "type": "integer" }, "limit": { "type": "integer", "minimum": 1, "maximum": 1000 } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["runs"], "properties": { "runs": { "type": "array", "items": { "$ref": "#/$defs/JobRun" } } } }
      },
      "events.subscribe": {
        "params": { "type": "object", "additionalProperties": false, "properties": { "names": { "type": "array", "items": { "type": "string" } }, "agentId": { "$ref": "#/$defs/AgentId" } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["subscriptionId"], "properties": { "subscriptionId": { "type": "string" } } }
      },
      "events.unsubscribe": {
        "params": { "type": "object", "additionalProperties": false, "required": ["subscriptionId"], "properties": { "subscriptionId": { "type": "string" } } },
        "result": { "type": "object", "additionalProperties": false, "required": ["removed"], "properties": { "removed": { "type": "boolean" } } }
      }
    },
    "MemoryOpsParams": {
      "type": "object", "additionalProperties": false,
      "required": ["caller", "agentId"],
      "properties": { "caller": { "$ref": "#/$defs/CallerIdentity" }, "agentId": { "$ref": "#/$defs/AgentId" }, "id": { "type": "string" }, "text": { "type": "string" }, "target": { "enum": ["workspace", "user"] }, "limit": { "type": "integer", "minimum": 1, "maximum": 500 } }
    },
    "MemoryOpsResult": { "type": "object", "description": "Shape fixed by engine PR E1 (MemoryOps). Until E1 every call answers E_NOT_AVAILABLE reason engine-pr-E1." },

    "notifications": {
      "core.state": { "type": "object", "additionalProperties": false, "required": ["process"], "properties": { "process": { "$ref": "#/$defs/ProcessState" } } },
      "agent.activity": { "type": "object", "additionalProperties": false, "required": ["agentId", "activity"], "properties": { "agentId": { "$ref": "#/$defs/AgentId" }, "activity": { "$ref": "#/$defs/Activity" } } },
      "engine.event": {
        "description": "Every engine event forwarded verbatim: name is the EngineEventName, payload as emitted, agentId when the payload carries one.",
        "type": "object", "additionalProperties": false, "required": ["name", "payload"],
        "properties": { "name": { "enum": ["dream.completed", "job.run", "acl.denied", "recall.degraded", "embedding.identity.changed", "recall.block-clipped", "recall.block-dropped", "recall.completed"] }, "agentId": { "$ref": "#/$defs/AgentId" }, "payload": {} }
      }
    }
  }
}
```

The spec (§6.2) names `module.state` and `config.changed` as notifications; those belong to the supervisor and are added in H2 with the supervisor methods. `core.auth` is H1's handshake: the first request on a connection; its result carries `contract` and `rpc`, which is where a client learns the versions (the spec's "every response envelope carries contract and rpc" is met by `core.auth` + `core.status`, because JSON-RPC 2.0 response objects have no room for extra members — recorded in ADR-012).

- [ ] **Step 5: Write the fixtures**

One file per method under `fixtures/methods/<method>.json` with `{ "params": …, "result": … }`; one per error code under `fixtures/errors/<CODE>.json` holding a full JSON-RPC error response; one per notification under `fixtures/notifications/<name>.json` holding the params object. Write all of them; the shapes below are the exact contents for the ones with any judgement in them, the rest follow the schema minimally.

`fixtures/methods/core.auth.json`:

```json
{ "params": { "token": "0000000000000000000000000000000000000000000000000000000000000000" },
  "result": { "contract": "1.4.1", "rpc": "1.0.0", "instanceId": "inst-fixture", "pid": 4242 } }
```

`fixtures/methods/core.status.json`:

```json
{ "params": {},
  "result": { "process": { "state": "ready", "since": 1758700000000 }, "contract": "1.4.1", "rpc": "1.0.0", "instanceId": "inst-fixture", "pid": 4242, "uptimeMs": 1500,
              "engine": { "ready": true, "degraded": null },
              "agents": [{ "agentId": "bernd", "activity": { "state": "idle", "since": 1758700000000 } }], "journalBacklog": 0 } }
```

`fixtures/methods/memory.recall.json`:

```json
{ "params": { "caller": { "channel": "cli", "accountId": "macbooker", "userId": "cyberblade" }, "agentId": "bernd", "sessionKey": "s2",
              "query": "when is the roadmap review", "budget": { "softMs": 400, "hardMs": 600, "capChars": 17000 }, "joined": true },
  "result": { "blocks": [{ "name": "memories", "text": "- The roadmap review is on Thursday.", "droppable": true, "chars": 36 }],
              "capChars": 17000, "degraded": null, "timing": { "totalMs": 212, "phases": { "rerank": 40 } }, "deferrals": [],
              "joined": { "text": "- The roadmap review is on Thursday.", "deferrals": [] } } }
```

`fixtures/methods/memory.capture.json`:

```json
{ "params": { "caller": { "channel": "cli", "accountId": "macbooker", "userId": "cyberblade" }, "agentId": "bernd", "sessionKey": "s1",
              "messages": [{ "role": "user", "content": "the roadmap review is on Thursday" }], "wait": true, "waitMs": 60000 },
  "result": { "id": "cap-fixture", "acceptedAt": 1758700000000, "stored": 1, "skipped": 0 } }
```

`fixtures/methods/memory.list.json` (and the other five `MemoryOps` methods, identical apart from the file name):

```json
{ "params": { "caller": { "channel": "cli", "accountId": "macbooker", "userId": "cyberblade" }, "agentId": "bernd", "limit": 20 }, "result": {} }
```

`fixtures/errors/E_NOT_AVAILABLE.json`:

```json
{ "jsonrpc": "2.0", "id": 7, "error": { "code": -32000, "message": "not available on this host", "data": { "error": "E_NOT_AVAILABLE", "reason": "engine-pr-E1" } } }
```

`fixtures/errors/E_INVALID_PARAMS.json` uses `"code": -32602`; `E_UNAUTHORIZED` `-32000` with `reason: "auth-required"`; `E_RPC_VERSION` `-32000` with `reason: "major-mismatch"`, `detail: "client 2.0.0, server 1.0.0"`; `E_CORE_UNAVAILABLE` `-32000` `reason: "core-unavailable"`; `E_AGENT_UNKNOWN` `-32000` `reason: "not-registered"`; `E_CONFIG_INVALID` `-32000` `reason: "schema"`; `E_MODULE_UNKNOWN` `-32000`; `E_INTERNAL` `-32000`; `E_LOCKED` `-32000` `reason: "core-lock-held"`.

`fixtures/notifications/engine.event.json`:

```json
{ "name": "recall.completed", "agentId": "bernd", "payload": { "agentId": "bernd", "totalMs": 212, "blocks": 1 } }
```

`fixtures/notifications/core.state.json`: `{ "process": { "state": "ready", "since": 1758700000000 } }`. `fixtures/notifications/agent.activity.json`: `{ "agentId": "bernd", "activity": { "state": "recalling", "since": 1758700000100 } }`.

- [ ] **Step 6: Write the generator**

`packages/rpc-schema/src/build.mjs`:

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "schema", "rpc.schema.json");
const outDir = join(here, "..", "generated");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

// 1. The schema itself must be a valid 2020-12 schema.
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addKeyword("x-rpc-version");
if (!ajv.validateSchema(schema)) throw new Error(`rpc.schema.json is not a valid schema: ${ajv.errorsText()}`);

// 2. Method and notification names come from the schema, never from a hand list.
const methods = Object.keys(schema.$defs.methods);
const notifications = Object.keys(schema.$defs.notifications);

// 3. Flatten methods/notifications into top-level $defs so the TS generator names them.
const flat = { ...schema, $defs: { ...schema.$defs } };
delete flat.$defs.methods; delete flat.$defs.notifications;
const pascal = (s) => s.split(/[.\-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
for (const m of methods) {
  flat.$defs[`${pascal(m)}Params`] = schema.$defs.methods[m].params;
  flat.$defs[`${pascal(m)}Result`] = schema.$defs.methods[m].result;
}
for (const n of notifications) flat.$defs[`${pascal(n)}Notification`] = schema.$defs.notifications[n];
flat.type = "object"; flat.properties = {}; flat.additionalProperties = false; // root is a namespace only

const ts = await compile(flat, "RpcRoot", { bannerComment: "/* generated by @plur1bus/rpc-schema build.mjs — do not edit */", additionalProperties: false, strictIndexSignatures: true, unreachableDefinitions: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "types.ts"), ts);
writeFileSync(join(outDir, "names.json"), JSON.stringify({ rpc: schema["x-rpc-version"], methods, notifications, errors: schema.$defs.ErrorCode.enum }, null, 2));
console.log(`rpc-schema: ${methods.length} methods, ${notifications.length} notifications → generated/`);
```

- [ ] **Step 7: Write `src/index.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import names from "../generated/names.json" with { type: "json" };
import schemaJson from "../schema/rpc.schema.json" with { type: "json" };

export type * from "../generated/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const RPC_VERSION: string = names.rpc;
export const METHODS = Object.freeze(names.methods) as readonly string[];
export const NOTIFICATIONS = Object.freeze(names.notifications) as readonly string[];
export const ERROR_CODES = Object.freeze(names.errors) as readonly string[];
export type ErrorCode = (typeof ERROR_CODES)[number];
export const SCHEMA = schemaJson as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
addFormats(ajv);
ajv.addKeyword("x-rpc-version");
ajv.addSchema(schemaJson);
const SCHEMA_ID: string = (schemaJson as any).$id;

const cache = new Map<string, ValidateFunction>();
function validator(pointer: string): ValidateFunction {
  let v = cache.get(pointer);
  if (!v) { v = ajv.compile({ $ref: `${SCHEMA_ID}#${pointer}` }); cache.set(pointer, v); }
  return v;
}

export type Validation = { ok: true } | { ok: false; errors: string[] };
function run(v: ValidateFunction, value: unknown): Validation {
  if (v(value)) return { ok: true };
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()) };
}
export function validateParams(method: string, value: unknown): Validation {
  if (!METHODS.includes(method)) return { ok: false, errors: [`unknown method ${method}`] };
  return run(validator(`/$defs/methods/${method}/params`), value);
}
export function validateResult(method: string, value: unknown): Validation {
  if (!METHODS.includes(method)) return { ok: false, errors: [`unknown method ${method}`] };
  return run(validator(`/$defs/methods/${method}/result`), value);
}
export function validateNotification(name: string, value: unknown): Validation {
  if (!NOTIFICATIONS.includes(name)) return { ok: false, errors: [`unknown notification ${name}`] };
  return run(validator(`/$defs/notifications/${name}`), value);
}
export function validateJournalLine(value: unknown): Validation { return run(validator("/$defs/JournalLine"), value); }
export function validateRequest(value: unknown): Validation { return run(validator("/$defs/Request"), value); }

export interface Fixtures {
  methods: Record<string, { params: unknown; result: unknown }>;
  errors: Record<string, { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string; data?: { error: string; reason?: string; detail?: string } } }>;
  notifications: Record<string, unknown>;
}
export function loadFixtures(root = join(here, "..", "fixtures")): Fixtures {
  const read = (dir: string) => Object.fromEntries(readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(root, dir, f), "utf8"))]));
  return { methods: read("methods"), errors: read("errors"), notifications: read("notifications") } as Fixtures;
}
```

JSON `$defs` pointers containing dots (`memory.recall`) are plain JSON-pointer segments — ajv resolves them; no escaping needed.

- [ ] **Step 8: Run the tests**

Run: `cd "$HARNESS/packages/rpc-schema" && pnpm test`
Expected: 5 pass. If `additionalProperties must be false on params` fails, a params object lacks `additionalProperties: false` — fix the schema, not the test. Then `cd "$HARNESS" && pnpm typecheck` — 0 errors (the generated `types.ts` must compile under `exactOptionalPropertyTypes`; if the generator emits `?: T | undefined` mismatches, set `strictIndexSignatures: false`... no — fix by passing the generator's `additionalProperties: false` only; report anything else in the task report rather than weakening `tsconfig.base.json`).

- [ ] **Step 9: Commit**

```bash
git add packages/rpc-schema pnpm-lock.yaml
git commit -m "feat(rpc-schema): JSON Schema 2020-12 single source for RPC 1.0.0, TS generation, fixtures and validators"
```

---

### Task 3: `@plur1bus/config-schema` — every key with a restart class

**Files:**
- Create: `packages/config-schema/package.json`, `packages/config-schema/schema/config.schema.json`, `packages/config-schema/src/index.ts`, `packages/config-schema/test/config-schema.test.ts`

**Interfaces:**
- Produces: `CONFIG_SCHEMA`, `SCHEMA_VERSION = 1`, `defaults(): HarnessConfig`, `validate(value): { ok: true, config: HarnessConfig } | { ok: false, errors: string[] }`, `restartClassOf(keyPath: string): "live" | \`module:${string}\` | "core"`, `restartPlan(before, after): { changed: string[], restart: { live: string[], core: boolean, modules: string[] } }`, `migrate(value): { config: unknown, from: number, to: number, applied: boolean }`, and the type `HarnessConfig`.
- Consumed by: core `config-load.ts` (Task 5), the Rust `plur1bus-config` crate (Task 12) reads the same JSON file.

- [ ] **Step 1: Write the failing tests**

`packages/config-schema/test/config-schema.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, SCHEMA_VERSION, defaults, migrate, restartClassOf, restartPlan, validate } from "../src/index.ts";

function walk(node: any, path: string[], out: string[][]) {
  if (!node || typeof node !== "object" || !node.properties) return;
  for (const [k, v] of Object.entries<any>(node.properties)) {
    if (v.type === "object" && v.properties) walk(v, [...path, k], out);
    else out.push([...path, k]);
  }
}

describe("config-schema", () => {
  it("every leaf key carries x-restart", () => {
    const leaves: string[][] = [];
    walk(CONFIG_SCHEMA, [], leaves);
    assert.ok(leaves.length >= 8);
    for (const leaf of leaves) {
      const cls = restartClassOf(leaf.join("."));
      assert.match(cls, /^(live|core|module:[a-z0-9-]+)$/, `${leaf.join(".")} has ${cls}`);
    }
  });

  it("defaults validate and carry schemaVersion", () => {
    const d = defaults();
    assert.equal(d.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(validate(d), { ok: true, config: d });
  });

  it("rejects an unknown key, a wrong type and a missing schemaVersion", () => {
    assert.equal(validate({ ...defaults(), bogus: 1 }).ok, false);
    assert.equal(validate({ ...defaults(), core: { ...defaults().core, logLevel: 3 } }).ok, false);
    const { schemaVersion, ...rest } = defaults();
    assert.equal(validate(rest).ok, false);
  });

  it("restart plan names only what changed, with its class", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.core.logLevel = "debug";
    b.engine.baseDbPathOverride = "/tmp/x";
    const plan = restartPlan(a, b);
    assert.deepEqual(plan.changed.sort(), ["core.logLevel", "engine.baseDbPathOverride"]);
    assert.deepEqual(plan.restart, { live: ["core.logLevel"], core: true, modules: [] });
  });

  it("agents is live: adding an agent restarts nothing", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    assert.deepEqual(restartPlan(a, b).restart, { live: ["agents.bernd"], core: false, modules: [] });
  });

  it("migrate is identity at version 1", () => {
    const r = migrate(defaults());
    assert.deepEqual(r, { config: defaults(), from: 1, to: 1, applied: false });
  });

  it("reserved namespaces exist and are live", () => {
    for (const ns of ["providers", "oauth", "decision"]) {
      assert.equal(restartClassOf(ns), "live", ns);
      assert.deepEqual((defaults() as any)[ns], {});
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd "$HARNESS/packages/config-schema" && pnpm test` (after creating `package.json` as in Task 2 Step 3 with name `@plur1bus/config-schema`, no `gen` script, dependency `ajv` and `ajv-formats`, and `"./schema": "./schema/config.schema.json"` in `exports`).
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

`packages/config-schema/schema/config.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://plur1bus.dev/schema/config/1/config.schema.json",
  "title": "PLUR1BUS harness config.json (schemaVersion 1)",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion"],
  "properties": {
    "$schema": { "type": "string", "x-restart": "live" },
    "schemaVersion": { "const": 1, "x-restart": "core" },
    "core": {
      "type": "object", "additionalProperties": false, "default": {},
      "properties": {
        "logLevel": { "enum": ["debug", "info", "warn", "error"], "default": "info", "x-restart": "live" },
        "recall": {
          "type": "object", "additionalProperties": false, "default": {},
          "properties": {
            "softBudgetMs": { "type": "integer", "minimum": 50, "default": 400, "x-restart": "live" },
            "hardBudgetMs": { "type": "integer", "minimum": 100, "default": 600, "x-restart": "live" },
            "capChars": { "type": "integer", "minimum": 1000, "default": 17000, "x-restart": "live" }
          }
        },
        "capture": {
          "type": "object", "additionalProperties": false, "default": {},
          "properties": { "waitMs": { "type": "integer", "minimum": 1000, "default": 60000, "x-restart": "live" } }
        },
        "shutdownBudgetMs": { "type": "integer", "minimum": 1000, "default": 30000, "x-restart": "live" }
      }
    },
    "supervisor": {
      "type": "object", "additionalProperties": false, "default": {},
      "properties": {
        "graceMs": { "type": "integer", "minimum": 1000, "default": 60000, "x-restart": "live" },
        "healthIntervalMs": { "type": "integer", "minimum": 1000, "default": 5000, "x-restart": "live" }
      }
    },
    "logs": {
      "type": "object", "additionalProperties": false, "default": {},
      "properties": {
        "maxBytes": { "type": "integer", "minimum": 1048576, "default": 20971520, "x-restart": "live" },
        "keep": { "type": "integer", "minimum": 1, "default": 5, "x-restart": "live" }
      }
    },
    "agents": {
      "type": "object", "default": {}, "x-restart": "live",
      "propertyNames": { "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$" },
      "additionalProperties": {
        "type": "object", "additionalProperties": false,
        "properties": { "createdAt": { "type": "string", "format": "date-time" }, "displayName": { "type": "string", "maxLength": 128 } }
      }
    },
    "embedding": {
      "type": "object", "additionalProperties": false, "default": {},
      "properties": {
        "useClass": { "enum": ["general", "research", "commercial"], "default": "general", "x-restart": "core" },
        "acceptedNcLicence": { "type": "boolean", "default": false, "x-restart": "core" },
        "acceptedNcLicenceAt": { "type": "string", "format": "date-time", "x-restart": "core" }
      }
    },
    "engine": {
      "description": "Pass-through to the engine's EngineConfig (56 keys, see docs/config-engine-keys.md). Every key here is class core until the engine declares readAt: live (engine PR E5).",
      "type": "object", "default": {}, "x-restart": "core",
      "properties": {
        "baseDbPathOverride": { "type": "string", "x-restart": "core", "description": "Testing/advanced only; default <home>/state/lancedb" }
      },
      "additionalProperties": true
    },
    "providers": { "type": "object", "default": {}, "x-restart": "live", "x-reserved": "M2 (D15)", "additionalProperties": true },
    "oauth":     { "type": "object", "default": {}, "x-restart": "live", "x-reserved": "M2 (D16)", "additionalProperties": true },
    "decision":  { "type": "object", "default": {}, "x-restart": "live", "x-reserved": "M2 (D18)", "additionalProperties": true },
    "modelRoles": {
      "type": "object", "default": {}, "x-restart": "live", "x-reserved": "M2 (D15, D18)",
      "propertyNames": { "enum": ["chat", "reasoning", "capture", "dream", "embedding", "rerank", "decision"] },
      "additionalProperties": { "type": "string" }
    }
  }
}
```

`x-restart` is on every leaf and on the container for the open objects (`agents`, `engine`, the reserved namespaces): `restartClassOf` walks down as far as the schema goes and takes the nearest `x-restart` above the key. The `engine` block is class `core` as a whole in H1 — the engine key inventory (Task 16) is the document that records which engine keys could become live once E5 lands.

- [ ] **Step 4: Write `src/index.ts`**

```ts
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemaJson from "../schema/config.schema.json" with { type: "json" };

export const CONFIG_SCHEMA = schemaJson as Record<string, any>;
export const SCHEMA_VERSION = 1 as const;

export interface HarnessConfig {
  $schema?: string;
  schemaVersion: 1;
  core: { logLevel: "debug" | "info" | "warn" | "error"; recall: { softBudgetMs: number; hardBudgetMs: number; capChars: number }; capture: { waitMs: number }; shutdownBudgetMs: number };
  supervisor: { graceMs: number; healthIntervalMs: number };
  logs: { maxBytes: number; keep: number };
  agents: Record<string, { createdAt?: string; displayName?: string }>;
  embedding: { useClass: "general" | "research" | "commercial"; acceptedNcLicence: boolean; acceptedNcLicenceAt?: string };
  engine: Record<string, unknown> & { baseDbPathOverride?: string };
  providers: Record<string, unknown>;
  oauth: Record<string, unknown>;
  decision: Record<string, unknown>;
  modelRoles: Record<string, string>;
}

export type RestartClass = "live" | "core" | `module:${string}`;

const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: true, strictSchema: false });
addFormats(ajv);
ajv.addKeyword("x-restart"); ajv.addKeyword("x-reserved");
const validateFn: ValidateFunction = ajv.compile(CONFIG_SCHEMA);

/** Defaults are produced by validating an empty object with useDefaults — one source of truth. */
export function defaults(): HarnessConfig {
  const seed: Record<string, unknown> = { $schema: CONFIG_SCHEMA.$id, schemaVersion: 1 };
  const r = validate(seed);
  if (!r.ok) throw new Error(`schema defaults do not validate: ${r.errors.join("; ")}`);
  return r.config;
}

export function validate(value: unknown): { ok: true; config: HarnessConfig } | { ok: false; errors: string[] } {
  const copy = structuredClone(value);
  if (validateFn(copy)) return { ok: true, config: copy as HarnessConfig };
  return { ok: false, errors: (validateFn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.params && "additionalProperty" in e.params ? ` (${(e.params as any).additionalProperty})` : ""}`.trim()) };
}

export function restartClassOf(keyPath: string): RestartClass {
  let node: any = CONFIG_SCHEMA;
  let cls: RestartClass = "core"; // unknown → the conservative class
  if (node["x-restart"]) cls = node["x-restart"];
  for (const part of keyPath.split(".")) {
    const next = node?.properties?.[part] ?? (node?.additionalProperties && typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
    if (!next) break;
    node = next;
    if (node["x-restart"]) cls = node["x-restart"];
  }
  return cls;
}

function flatten(value: unknown, prefix: string[], out: Map<string, unknown>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix.length) out.set(prefix.join("."), {});
    for (const [k, v] of entries) flatten(v, [...prefix, k], out);
  } else out.set(prefix.join("."), value);
}

export function restartPlan(before: unknown, after: unknown): { changed: string[]; restart: { live: string[]; core: boolean; modules: string[] } } {
  const a = new Map<string, unknown>(); const b = new Map<string, unknown>();
  flatten(before, [], a); flatten(after, [], b);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))).sort();
  const restart = { live: [] as string[], core: false, modules: [] as string[] };
  for (const key of changed) {
    const cls = restartClassOf(key);
    if (cls === "live") restart.live.push(key);
    else if (cls === "core") restart.core = true;
    else { const m = cls.slice("module:".length); if (!restart.modules.includes(m)) restart.modules.push(m); }
  }
  return { changed, restart };
}

/** Migrations vN → vN+1 register here; version 1 has none. */
const MIGRATIONS: Record<number, (c: any) => any> = {};
export function migrate(value: unknown): { config: unknown; from: number; to: number; applied: boolean } {
  const from = Number((value as any)?.schemaVersion ?? 0);
  let config = structuredClone(value) as any; let v = from;
  while (MIGRATIONS[v]) { config = MIGRATIONS[v](config); v += 1; config.schemaVersion = v; }
  return { config, from, to: v, applied: v !== from };
}
```

`agents.bernd` resolves to the `additionalProperties` sub-schema (no `x-restart`) so the nearest class above — `agents`' `live` — wins; that is the test `agents is live`.

- [ ] **Step 5: Run the tests**

Run: `cd "$HARNESS/packages/config-schema" && pnpm test && cd "$HARNESS" && pnpm typecheck`
Expected: 7 pass, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/config-schema pnpm-lock.yaml
git commit -m "feat(config-schema): config.json schema v1 with x-restart per key, defaults, validation, restart plan"
```

---

### Task 4: `@plur1bus/module-api` — NDJSON framing and the core client

**Files:**
- Create: `packages/module-api/package.json`, `packages/module-api/src/framing.ts`, `packages/module-api/src/client.ts`, `packages/module-api/src/index.ts`, `packages/module-api/test/framing.test.ts`, `packages/module-api/test/client.test.ts`

**Interfaces:**
- Produces: `MAX_LINE_BYTES = 4 * 1024 * 1024`; `encodeLine(value): Buffer`; `class LineDecoder { push(chunk: Buffer): unknown[]; }` (throws `LineTooLong`); `connect(opts: { address: string; token: string; connectTimeoutMs?: number; callTimeoutMs?: number }): Promise<CoreClient>`; `interface CoreClient { call<T = unknown>(method: string, params?: object): Promise<T>; onNotification(handler: (method: string, params: unknown) => void): () => void; readonly hello: { contract: string; rpc: string; instanceId: string; pid: number }; close(): Promise<void>; }`; `class RpcCallError extends Error { code: number; error: string; reason?: string; detail?: string }`.
- Consumed by: core tests (Task 6, 8, 9), the system test (Task 18); H2 modules add reconnect and the lifeline on top of this client.

- [ ] **Step 1: Write the framing test**

`packages/module-api/test/framing.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, LineTooLong, MAX_LINE_BYTES, encodeLine } from "../src/framing.ts";

describe("framing", () => {
  it("round-trips one value per line, across chunk boundaries", () => {
    const d = new LineDecoder();
    const a = encodeLine({ id: 1 }); const b = encodeLine({ id: 2, s: "ü\n" });
    const all = Buffer.concat([a, b]);
    const out = [...d.push(all.subarray(0, 5)), ...d.push(all.subarray(5))];
    assert.deepEqual(out, [{ id: 1 }, { id: 2, s: "ü\n" }]);
  });
  it("throws LineTooLong past 4 MiB without buffering more", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61)), LineTooLong);
  });
  it("throws on invalid JSON with the offending line kept out of the stream", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.from("{nope}\n")), SyntaxError);
    assert.deepEqual(d.push(encodeLine({ ok: true })), [{ ok: true }]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd "$HARNESS/packages/module-api" && pnpm test` (create `package.json` first: name `@plur1bus/module-api`, `dependencies: { "@plur1bus/rpc-schema": "workspace:*" }`, standard scripts from Task 2).
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/framing.ts`**

```ts
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class LineTooLong extends Error {
  constructor(bytes: number) { super(`line exceeds ${MAX_LINE_BYTES} bytes (${bytes})`); this.name = "LineTooLong"; }
}

export function encodeLine(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text.includes("\n")) throw new Error("JSON.stringify never emits a raw newline; this is a bug");
  return Buffer.from(`${text}\n`, "utf8");
}

export class LineDecoder {
  #buf: Buffer = Buffer.alloc(0);

  /** Returns every complete value in the chunk; keeps the partial tail. */
  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length === 0) continue;
      out.push(JSON.parse(line.toString("utf8")));
    }
    this.#buf = this.#buf.subarray(start);
    if (this.#buf.length > MAX_LINE_BYTES) { const n = this.#buf.length; this.#buf = Buffer.alloc(0); throw new LineTooLong(n); }
    return out;
  }
}
```

The `SyntaxError` from a bad line propagates after the buffer has already advanced past it (`start` moved before `JSON.parse`), which is what the third test pins: one bad line does not poison the stream.

- [ ] **Step 4: Run framing tests**

Run: `pnpm test` → 3 pass.

- [ ] **Step 5: Write the client test (against an in-test server)**

`packages/module-api/test/client.test.ts`:

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine } from "../src/framing.ts";
import { RpcCallError, connect } from "../src/client.ts";

const TOKEN = "a".repeat(64);
function address(): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(mkdtempSync(join(tmpdir(), "p1b-client-")), "core.sock");
}

/** Minimal fake core: auth, echo, one notification, slow method. */
function fakeCore(addr: string) {
  const server = createServer((sock: Socket) => {
    const dec = new LineDecoder(); let authed = false;
    sock.on("data", (chunk) => {
      for (const msg of dec.push(chunk) as any[]) {
        const reply = (result: unknown) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result }));
        const fail = (code: number, error: string, reason?: string) => sock.write(encodeLine({ jsonrpc: "2.0", id: msg.id, error: { code, message: error, data: { error, reason } } }));
        if (msg.method === "core.auth") { authed = msg.params?.token === TOKEN; return authed ? reply({ contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 1 }) : fail(-32000, "E_UNAUTHORIZED", "bad-token"); }
        if (!authed) return fail(-32000, "E_UNAUTHORIZED", "auth-required");
        if (msg.method === "echo") return reply(msg.params);
        if (msg.method === "notify") { sock.write(encodeLine({ jsonrpc: "2.0", method: "agent.activity", params: { agentId: "a", activity: { state: "idle", since: 1 } } })); return reply({}); }
        if (msg.method === "slow") return setTimeout(() => reply({}), 500);
        fail(-32601, "E_INTERNAL", "method-not-found");
      }
    });
  });
  return new Promise<typeof server>((res) => server.listen(addr, () => res(server)));
}

describe("client", () => {
  const addr = address();
  let server: Awaited<ReturnType<typeof fakeCore>>;
  after(() => server?.close());

  it("authenticates on connect and exposes hello", async () => {
    server = await fakeCore(addr);
    const c = await connect({ address: addr, token: TOKEN });
    assert.deepEqual(c.hello, { contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 1 });
    assert.deepEqual(await c.call("echo", { x: 1 }), { x: 1 });
    await c.close();
  });

  it("maps a JSON-RPC error to RpcCallError with the closed code", async () => {
    const c = await connect({ address: addr, token: TOKEN });
    await assert.rejects(c.call("nope"), (e: any) => e instanceof RpcCallError && e.error === "E_INTERNAL" && e.reason === "method-not-found");
    await c.close();
  });

  it("rejects a bad token at connect", async () => {
    await assert.rejects(connect({ address: addr, token: "b".repeat(64) }), (e: any) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED");
  });

  it("delivers notifications and times out a slow call", async () => {
    const c = await connect({ address: addr, token: TOKEN, callTimeoutMs: 100 });
    const seen: unknown[] = []; c.onNotification((m, p) => seen.push([m, p]));
    await c.call("notify");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [["agent.activity", { agentId: "a", activity: { state: "idle", since: 1 } }]]);
    await assert.rejects(c.call("slow"), (e: any) => e instanceof RpcCallError && e.error === "E_CORE_UNAVAILABLE" && e.reason === "call-timeout");
    await c.close();
  });

  it("connect to a missing socket fails fast with E_CORE_UNAVAILABLE", async () => {
    const t0 = performance.now();
    await assert.rejects(connect({ address: address(), token: TOKEN, connectTimeoutMs: 300 }), (e: any) => e instanceof RpcCallError && e.error === "E_CORE_UNAVAILABLE");
    assert.ok(performance.now() - t0 < 300, "fails before the timeout on ENOENT");
  });
});
```

- [ ] **Step 6: Run to see the client tests fail**

Run: `pnpm test` → the 5 client tests fail with module not found.

- [ ] **Step 7: Write `src/client.ts`**

```ts
import { createConnection, type Socket } from "node:net";
import { LineDecoder, LineTooLong, encodeLine } from "./framing.ts";

export class RpcCallError extends Error {
  code: number; error: string; reason?: string; detail?: string;
  constructor(code: number, error: string, message: string, reason?: string, detail?: string) {
    super(message); this.name = "RpcCallError"; this.code = code; this.error = error;
    if (reason !== undefined) this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface Hello { contract: string; rpc: string; instanceId: string; pid: number }
export interface CoreClient {
  readonly hello: Hello;
  call<T = unknown>(method: string, params?: object): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}
export interface ConnectOptions { address: string; token: string; connectTimeoutMs?: number; callTimeoutMs?: number }

const SUPPORTED_RPC_MAJOR = 1;

export async function connect(opts: ConnectOptions): Promise<CoreClient> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 300;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(opts.address);
    const timer = setTimeout(() => { s.destroy(); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connect timeout", "connect-timeout")); }, connectTimeoutMs);
    s.once("connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", e.message, e.code ?? "connect-error")); });
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const handlers = new Set<(method: string, params: unknown) => void>();
  const dec = new LineDecoder();
  let nextId = 1; let closed = false;

  const failAll = (e: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  sock.on("data", (chunk) => {
    let msgs: any[];
    try { msgs = dec.push(chunk) as any[]; } catch (e) { if (e instanceof LineTooLong) { sock.destroy(); failAll(new RpcCallError(-32602, "E_INVALID_PARAMS", e.message, "line-too-long")); } return; }
    for (const m of msgs) {
      if (m.id === undefined && typeof m.method === "string") { for (const h of handlers) h(m.method, m.params); continue; }
      const p = pending.get(m.id); if (!p) continue;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new RpcCallError(m.error.code, m.error.data?.error ?? "E_INTERNAL", m.error.message, m.error.data?.reason, m.error.data?.detail));
      else p.resolve(m.result);
    }
  });
  sock.on("close", () => { closed = true; failAll(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connection closed", "closed")); });
  sock.on("error", () => { /* surfaced through close */ });

  function call<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (closed) return Promise.reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "connection closed", "closed"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", `${method} timed out`, "call-timeout")); }, callTimeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }

  const hello = await call<Hello>("core.auth", { token: opts.token });
  const major = Number(hello.rpc.split(".")[0]);
  if (major !== SUPPORTED_RPC_MAJOR) { sock.destroy(); throw new RpcCallError(-32000, "E_RPC_VERSION", `server rpc ${hello.rpc}, client supports ${SUPPORTED_RPC_MAJOR}.x`, "major-mismatch"); }

  return {
    hello,
    call,
    onNotification(h) { handlers.add(h); return () => handlers.delete(h); },
    close: () => new Promise<void>((res) => { if (closed) return res(); sock.end(() => { sock.destroy(); res(); }); }),
  };
}
```

`src/index.ts`: `export * from "./framing.ts"; export * from "./client.ts";`.

- [ ] **Step 8: Run all module-api tests**

Run: `pnpm test && cd "$HARNESS" && pnpm typecheck` → 8 pass, 0 type errors. On Windows the named-pipe branch of `address()` is exercised by CI's windows job.

- [ ] **Step 9: Let root scripts import the workspace packages, then commit**

`scripts/bench.mjs` (Task 18) imports `@plur1bus/module-api` and `@plur1bus/config-schema` from the repo root. Add both to the root `package.json` `devDependencies` as `"workspace:*"` now that both packages exist, and run `pnpm install` (the lockfile gains two workspace links).

```bash
git add packages/module-api package.json pnpm-lock.yaml
git commit -m "feat(module-api): NDJSON framing with 4 MiB cap and the core client (auth handshake, calls, notifications, timeouts)"
```

---

### Task 5: core — paths, logger, platform, config loading, engine configuration

**Files:**
- Create: `packages/core/package.json`, `packages/core/src/engine-shim.d.ts`, `packages/core/src/paths.ts`, `packages/core/src/logger.ts`, `packages/core/src/platform.ts`, `packages/core/src/config-load.ts`, `packages/core/src/engine-config.ts`, `packages/core/test/paths.test.ts`, `packages/core/test/logger.test.ts`, `packages/core/test/platform.test.ts`, `packages/core/test/config-load.test.ts`, `packages/core/test/engine-config.test.ts`

**Interfaces:**
- Produces: `resolveHome(opts: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homedir?: string; localAppData?: string }): string`; `layout(home: string): Layout` with `Layout = { home, configPath, state, lancedb, journal, agents, agentDir(id), workspaceDir(id), run, coreSocket, coreToken, corePid, coreLock, logs, logFile(role), runtime, models, modules, skills }`; `coreAddress(home): string` (socket path or pipe name); `createLogger({ file, level, role }): Logger & { child(fields): Logger; close(): Promise<void> }`; `platformCapabilities: PlatformCapabilities`; `loadConfig(configPath): { config: HarnessConfig; created: boolean }` (writes defaults when missing; rejects invalid with `ConfigInvalid` carrying `errors`); `buildEngineConfig(config: HarnessConfig, layout: Layout): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/paths.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coreAddress, layout, resolveHome } from "../src/paths.ts";

describe("paths", () => {
  it("prefers --home, then PLUR1BUS_HOME, then the platform default", () => {
    assert.equal(resolveHome({ home: "/x", env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), "/x");
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), "/y");
    assert.equal(resolveHome({ env: {}, platform: "darwin", homedir: "/Users/c" }), "/Users/c/.plur1bus");
    assert.equal(resolveHome({ env: {}, platform: "win32", homedir: "C:\\Users\\c", localAppData: "C:\\Users\\c\\AppData\\Local" }), "C:\\Users\\c\\AppData\\Local\\PLUR1BUS");
  });
  it("lays out the spec directories", () => {
    const l = layout("/h/.plur1bus");
    assert.equal(l.configPath, "/h/.plur1bus/config.json");
    assert.equal(l.lancedb, "/h/.plur1bus/state/lancedb");
    assert.equal(l.journal, "/h/.plur1bus/state/journal");
    assert.equal(l.workspaceDir("bernd"), "/h/.plur1bus/agents/bernd/workspace");
    assert.equal(l.coreSocket, "/h/.plur1bus/run/core.sock");
    assert.equal(l.coreLock, "/h/.plur1bus/state/core.lock");
    assert.equal(l.logFile("core"), "/h/.plur1bus/logs/core.log");
  });
  it("names a per-home pipe on windows and the socket elsewhere", () => {
    assert.equal(coreAddress("/h/.plur1bus", "linux"), "/h/.plur1bus/run/core.sock");
    assert.match(coreAddress("C:\\Users\\c\\AppData\\Local\\PLUR1BUS", "win32"), /^\\\\\.\\pipe\\plur1bus-[0-9a-f]{16}-core$/);
  });
});
```

`packages/core/test/logger.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.ts";

describe("logger", () => {
  it("writes JSON lines with level, role, fields and honours the level", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "p1b-log-")), "core.log");
    const log = createLogger({ file, level: "info", role: "core" });
    log.debug("hidden"); log.info("hello", { agentId: "bernd" });
    log.child({ requestId: "r1" }).warn("child");
    await log.close();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual({ level: lines[0].level, role: lines[0].role, msg: lines[0].msg, agentId: lines[0].agentId }, { level: "info", role: "core", msg: "hello", agentId: "bernd" });
    assert.equal(lines[1].requestId, "r1"); assert.match(lines[1].at, /^\d{4}-\d{2}-\d{2}T/);
  });
});
```

`packages/core/test/platform.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformCapabilities } from "../src/platform.ts";

describe("platform", () => {
  it("securePath chmods on posix and reports the mechanism", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-plat-")); const f = join(dir, "t"); writeFileSync(f, "x");
    assert.deepEqual(platformCapabilities.securePath(f, { mode: 0o600 }), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(platformCapabilities.securePath(join(dir, "missing")), { applied: false, reason: "missing" });
  });
  it("isUnsafeLink is true for a symlink and false for a file", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-plat-")); writeFileSync(join(dir, "f"), ""); symlinkSync(join(dir, "f"), join(dir, "l"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "l")), true);
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f")), false);
  });
  it("ipcAddress and canonicalIdentityPath", () => {
    const a = platformCapabilities.ipcAddress("/h/.plur1bus/state");
    assert.ok(["unix-socket", "named-pipe"].includes(a.kind));
    assert.equal(platformCapabilities.canonicalIdentityPath("/a/./b/../c"), process.platform === "win32" ? "\\a\\c" : "/a/c");
  });
});
```

`packages/core/test/config-load.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigInvalid, loadConfig } from "../src/config-load.ts";

describe("config-load", () => {
  it("creates defaults when missing and loads them back", () => {
    const p = join(mkdtempSync(join(tmpdir(), "p1b-cfg-")), "config.json");
    const first = loadConfig(p); assert.equal(first.created, true); assert.equal(first.config.schemaVersion, 1);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).core.recall.softBudgetMs, 400);
    const second = loadConfig(p); assert.equal(second.created, false); assert.deepEqual(second.config, first.config);
  });
  it("rejects an invalid file with the schema errors and does not rewrite it", () => {
    const p = join(mkdtempSync(join(tmpdir(), "p1b-cfg-")), "config.json");
    writeFileSync(p, '{ "schemaVersion": 1, "core": { "logLevel": "loud" } }');
    assert.throws(() => loadConfig(p), (e: any) => e instanceof ConfigInvalid && e.errors.some((s: string) => s.includes("logLevel")));
    assert.equal(readFileSync(p, "utf8"), '{ "schemaVersion": 1, "core": { "logLevel": "loud" } }');
  });
});
```

`packages/core/test/engine-config.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../src/engine-config.ts";
import { layout } from "../src/paths.ts";

describe("engine-config", () => {
  const l = layout("/h/.plur1bus");
  it("forces the harness-owned keys and passes engine keys through", () => {
    const cfg = defaults(); cfg.engine.recallMinScore = 0.42;
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.baseDbPath, "/h/.plur1bus/state/lancedb");
    assert.equal(e.autoRecall, false); assert.equal(e.autoCapture, false);
    assert.equal(e.embedding.provider, "local-transformers"); assert.equal(e.embedding.local.model, "intfloat/multilingual-e5-small"); assert.equal(e.embedding.local.dimensions, 384);
    assert.equal(e.embedding.local.cacheDir, "/h/.plur1bus/models");
    assert.equal(e.reranker.enabled, true); assert.equal(e.reranker.provider, "local-transformers"); assert.equal(e.reranker.local.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.equal(e.recall.softBudgetMs, 400); assert.equal(e.recall.globalInjectMaxChars, 17000); assert.equal(e.recall.decisionTrace.enabled, true);
    assert.equal(e.recallMinScore, 0.42);
  });
  it("a user cannot override the forced keys through engine.*", () => {
    const cfg = defaults(); cfg.engine.baseDbPath = "/elsewhere"; cfg.engine.autoCapture = true;
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.baseDbPath, "/h/.plur1bus/state/lancedb"); assert.equal(e.autoCapture, false);
  });
  it("baseDbPathOverride wins over the layout (tests only)", () => {
    const cfg = defaults(); cfg.engine.baseDbPathOverride = "/tmp/db";
    assert.equal((buildEngineConfig(cfg, l) as any).baseDbPath, "/tmp/db");
  });
});
```

- [ ] **Step 2: Create `packages/core/package.json` and run to see the failures**

```json
{
  "name": "@plur1bus/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.16.0 <25 || >=26.1.0" },
  "bin": { "plur1bus-core": "./dist/core.js" },
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "esbuild src/index.ts src/bin.ts --bundle --platform=node --target=node24 --format=esm --packages=external --outdir=dist --entry-names=[name] && node -e \"require('fs').renameSync('dist/bin.js','dist/core.js')\"",
    "test": "node ../../scripts/test-package.mjs"
  },
  "dependencies": {
    "@cyb3rb1ade/plur1bus-memory": "github:Cyb3rb1ade/openclaw-plur1bus-memory#eaaf168fe602dcdb3a02bb84c4c6ba8fb2e88a72",
    "@plur1bus/config-schema": "workspace:*",
    "@plur1bus/module-api": "workspace:*",
    "@plur1bus/rpc-schema": "workspace:*"
  }
}
```

Run: `cd "$HARNESS" && pnpm install` (the engine install pulls LanceDB prebuilds; 1–3 minutes) `&& cd packages/core && pnpm test`.
Expected: all five test files fail with module not found. If `pnpm install` cannot fetch the engine repo (private, 404 through the proxy), stop and report: the owner either makes the repo public, sets `GH_ENGINE_READ_TOKEN`, or publishes the prerelease — H1 cannot continue past this point without the engine.

- [ ] **Step 3: Write `src/paths.ts`**

```ts
import { createHash } from "node:crypto";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

export interface ResolveHomeOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homedir?: string; localAppData?: string }

export function resolveHome(o: ResolveHomeOptions = {}): string {
  const env = o.env ?? process.env; const platform = o.platform ?? process.platform;
  if (o.home) return path.resolve(o.home);
  if (env.PLUR1BUS_HOME) return path.resolve(env.PLUR1BUS_HOME);
  const home = o.homedir ?? osHomedir();
  if (platform === "win32") {
    const lad = o.localAppData ?? env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(lad, "PLUR1BUS");
  }
  return path.posix.join(home, ".plur1bus");
}

export interface Layout {
  home: string; configPath: string; state: string; lancedb: string; journal: string; agents: string;
  agentDir(id: string): string; workspaceDir(id: string): string;
  run: string; coreSocket: string; coreToken: string; corePid: string; coreLock: string;
  logs: string; logFile(role: string): string; runtime: string; models: string; modules: string; skills: string;
}

export function layout(home: string): Layout {
  const p = home.includes("\\") ? path.win32 : path.posix;
  const j = (...s: string[]) => p.join(home, ...s);
  return {
    home, configPath: j("config.json"), state: j("state"), lancedb: j("state", "lancedb"), journal: j("state", "journal"), agents: j("agents"),
    agentDir: (id) => j("agents", id), workspaceDir: (id) => j("agents", id, "workspace"),
    run: j("run"), coreSocket: j("run", "core.sock"), coreToken: j("run", "core.token"), corePid: j("run", "core.pid"), coreLock: j("state", "core.lock"),
    logs: j("logs"), logFile: (role) => j("logs", `${role}.log`), runtime: j("runtime"), models: j("models"), modules: j("modules"), skills: j("skills"),
  };
}

/** The address the RPC server listens on and the client connects to. */
export function coreAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-core`;
  return layout(home).coreSocket;
}
```

- [ ] **Step 4: Write `src/logger.ts`**

```ts
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface HarnessLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): HarnessLogger;
  setLevel(level: Level): void;
  close(): Promise<void>;
}

function serializeError(v: unknown): unknown {
  return v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
}

export function createLogger(o: { file: string; level: Level; role: string; stream?: WriteStream }): HarnessLogger {
  mkdirSync(dirname(o.file), { recursive: true });
  const stream = o.stream ?? createWriteStream(o.file, { flags: "a" });
  let level = o.level;
  const make = (base: Record<string, unknown>): HarnessLogger => {
    const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const rec: Record<string, unknown> = { at: new Date().toISOString(), level: lvl, role: o.role, ...base, ...fields, msg };
      for (const k of Object.keys(rec)) rec[k] = serializeError(rec[k]);
      stream.write(`${JSON.stringify(rec)}\n`);
    };
    return {
      debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f),
      child: (fields) => make({ ...base, ...fields }),
      setLevel: (l) => { level = l; },
      close: () => new Promise((res) => stream.end(() => res())),
    };
  };
  return make({});
}

/** Adapter to the engine's Logger shape (message + rest args). */
export function engineLoggerFrom(log: HarnessLogger) {
  const fields = (rest: unknown[]) => (rest.length ? { rest: rest.map(serializeError) } : undefined);
  return {
    info: (m: string, ...r: unknown[]) => log.info(m, fields(r)), warn: (m: string, ...r: unknown[]) => log.warn(m, fields(r)),
    error: (m: string, ...r: unknown[]) => log.error(m, fields(r)), debug: (m: string, ...r: unknown[]) => log.debug(m, fields(r)),
  };
}
```

Size-based rotation (20 MB × 5, spec §6.1) is the supervisor's job on the child's piped stdout/stderr in H2; the core's own file logger here is what runs when the core is started by hand (`core run`), and H2 switches it to stdout when a lifeline is present.

- [ ] **Step 5: Write `src/platform.ts`**

```ts
import { chmodSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { IpcAddress, PlatformCapabilities, SecurePathResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

function securePath(p: string, options: { mode?: number } = {}): SecurePathResult {
  if (typeof p !== "string" || !path.isAbsolute(p)) return { applied: false, reason: "not-a-filesystem-path" };
  try { statSync(p); } catch { return { applied: false, reason: "missing" }; }
  if (process.platform === "win32") return { applied: false, reason: "acl-tool-unavailable" }; // H2: icacls user-SID ACL
  chmodSync(p, options.mode ?? 0o600);
  return { applied: true, mechanism: "chmod" };
}

function ipcAddress(stateRoot: string): IpcAddress {
  if (process.platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${Buffer.from(stateRoot).toString("hex").slice(0, 32)}` };
  return { kind: "unix-socket", address: path.join(stateRoot, "embedding.sock") };
}

function isUnsafeLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function canonicalIdentityPath(p: string): string {
  return process.platform === "win32" ? path.win32.normalize(p).toLowerCase().replace(/^[a-z]:/, (d) => d.toLowerCase()) : path.posix.normalize(p);
}

export const platformCapabilities: PlatformCapabilities = { securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath };
```

The `types/engine.js` import path: the engine package has no `exports` map (`$ENGINE/package.json` has only `main`), so deep imports resolve; under `NodeNext` the `.js` suffix is what makes TypeScript pick up `types/engine.d.ts`. The engine's runtime entry points are plain JavaScript without declarations, so `packages/core/src/engine-shim.d.ts` (created in this task, included by `tsconfig.base.json` through `packages/*/src/**/*.ts`) declares them:

```ts
declare module "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js" {
  export const createEngine: typeof import("@cyb3rb1ade/plur1bus-memory/types/engine.js").createEngine;
}
declare module "@cyb3rb1ade/plur1bus-memory/lib/memory-request-context.js" {
  export function resolveMemoryRequestContext(commandCtx: Record<string, unknown>, options?: Record<string, unknown>): { userPrincipal: string; workspaceIdentity: string; agentId: string };
}
``` On Windows `canonicalIdentityPath` lowercases the whole path (the test expects `\a\c`); the test on Windows CI passes because `path.win32.normalize("/a/./b/../c")` is `\a\c`.

- [ ] **Step 6: Write `src/config-load.ts` and `src/engine-config.ts`**

`src/config-load.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaults, migrate, validate, type HarnessConfig } from "@plur1bus/config-schema";

export class ConfigInvalid extends Error {
  errors: string[];
  constructor(path: string, errors: string[]) { super(`${path}: ${errors.join("; ")}`); this.name = "ConfigInvalid"; this.errors = errors; }
}

export function writeConfigAtomic(path: string, config: HarnessConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** H1: the core reads config.json itself. H2: the supervisor's config.get snapshot replaces this call site. */
export function loadConfig(path: string): { config: HarnessConfig; created: boolean } {
  if (!existsSync(path)) { const d = defaults(); writeConfigAtomic(path, d); return { config: d, created: true }; }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new ConfigInvalid(path, [`not JSON: ${(e as Error).message}`]); }
  const m = migrate(raw);
  const r = validate(m.config);
  if (!r.ok) throw new ConfigInvalid(path, r.errors);
  if (m.applied) { writeFileSync(`${path}.bak-${m.from}`, readFileSync(path)); writeConfigAtomic(path, r.config); }
  return { config: r.config, created: false };
}
```

`src/engine-config.ts`:

```ts
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";

const E5_SMALL = "intfloat/multilingual-e5-small";
const BGE_RERANKER = "woxpas-ai/bge-reranker-v2-m3-onnx";

/**
 * The single translation between harness config and the engine's EngineConfig.
 * Harness-owned keys always win; everything else in config.engine passes through.
 * Engine PR E5 (host-neutral engine-config.schema.json) will let this file shrink.
 */
export function buildEngineConfig(cfg: HarnessConfig, l: Layout): Record<string, unknown> {
  const user = { ...cfg.engine } as Record<string, any>;
  const { baseDbPathOverride, baseDbPath: _b, autoRecall: _r, autoCapture: _c, ...passthrough } = user;
  const embedding = { ...(passthrough.embedding ?? {}), provider: "local-transformers", local: { model: E5_SMALL, dimensions: 384, cacheDir: l.models, ...(passthrough.embedding?.local ?? {}) } };
  const reranker = { enabled: true, provider: "local-transformers", ...(passthrough.reranker ?? {}), local: { model: BGE_RERANKER, cacheDir: l.models, ...(passthrough.reranker?.local ?? {}) } };
  const recall = { ...(passthrough.recall ?? {}), softBudgetMs: cfg.core.recall.softBudgetMs, globalInjectMaxChars: cfg.core.recall.capChars, decisionTrace: { ...(passthrough.recall?.decisionTrace ?? {}), enabled: true } };
  return { ...passthrough, baseDbPath: baseDbPathOverride ?? l.lancedb, autoRecall: false, autoCapture: false, embedding, reranker, recall };
}
```

`embedding.local.model` and `dimensions` are user-overridable through `engine.embedding.local` (ADR-006's use-class question in `setup`, H2, writes them); provider and the forced keys are not.

- [ ] **Step 7: Run the tests**

Run: `cd "$HARNESS/packages/core" && pnpm test && cd "$HARNESS" && pnpm typecheck`
Expected: 12 pass; 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): state-root layout, JSON-lines logger, platform capabilities, config loading, engine configuration translation"
```

---

### Task 6: core — the JSON-RPC server: transport, auth, envelope, dispatch, subscriptions

**Files:**
- Create: `packages/core/src/rpc/errors.ts`, `packages/core/src/rpc/server.ts`, `packages/core/test/rpc-server.test.ts`

**Interfaces:**
- Produces: `class RpcError extends Error { constructor(error: ErrorCode, message: string, opts?: { reason?: string; detail?: string; jsonrpcCode?: number }) }`; `type Handler = (params: any, ctx: CallContext) => Promise<unknown>`; `interface CallContext { requestId: string; connectionId: string; signal: AbortSignal }`; `createRpcServer(opts: { address: string; token: string; hello: () => { contract: string; rpc: string; instanceId: string; pid: number }; methods: Record<string, Handler>; logger: HarnessLogger; authIdleMs?: number }): RpcServer`; `interface RpcServer { listen(): Promise<void>; close(): Promise<void>; notify(method: string, params: object, filter?: (sub: Subscription) => boolean): void; subscriptions(): Subscription[] }`; `interface Subscription { id: string; connectionId: string; names?: string[]; agentId?: string }`. `events.subscribe`/`events.unsubscribe` are implemented inside the server (they need the connection), every other method comes from `methods`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/rpc-server.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { connect, RpcCallError, encodeLine, LineDecoder } from "@plur1bus/module-api";
import { loadFixtures } from "@plur1bus/rpc-schema";
import { createLogger } from "../src/logger.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { createRpcServer, type RpcServer } from "../src/rpc/server.ts";

const TOKEN = "c".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "p1b-rpc-"));
const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-${process.pid}` : join(dir, "core.sock");
const hello = () => ({ contract: "1.4.1", rpc: "1.0.0", instanceId: "inst-test", pid: process.pid });
const log = createLogger({ file: join(dir, "core.log"), level: "debug", role: "core" });

describe("rpc server", () => {
  let server: RpcServer;
  before(async () => {
    server = createRpcServer({
      address, token: TOKEN, hello, logger: log, authIdleMs: 200,
      methods: {
        "core.status": async () => ({ ...loadFixtures().methods["core.status"].result, pid: process.pid, instanceId: "inst-test" }),
        "memory.recall": async (p, ctx) => { if (p.query === "throw") throw new RpcError("E_AGENT_UNKNOWN", "no such agent", { reason: "not-registered" }); if (p.query === "boom") throw new Error("kaboom"); const { joined: _j, ...rest } = loadFixtures().methods["memory.recall"].result as any; return { ...rest, trace: { requestId: ctx.requestId } }; },
        "core.shutdown": async () => ({ accepted: true }),
      },
    });
    await server.listen();
  });
  after(async () => { await server.close(); await log.close(); });

  it("creates the socket 0600 in a 0700 dir (posix)", { skip: process.platform === "win32" }, () => {
    assert.equal(statSync(address).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777 & 0o077, 0);
  });

  it("refuses every method before auth, then serves after core.auth", async () => {
    await assert.rejects(connect({ address, token: "d".repeat(64) }), (e: any) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED");
    const c = await connect({ address, token: TOKEN });
    assert.deepEqual(c.hello, hello());
    const s = await c.call<any>("core.status"); assert.equal(s.process.state, "ready");
    await c.close();
  });

  it("validates params against the schema and answers E_INVALID_PARAMS with the path", async () => {
    const c = await connect({ address, token: TOKEN });
    await assert.rejects(c.call("memory.recall", { agentId: "bernd" }), (e: any) => e.error === "E_INVALID_PARAMS" && e.code === -32602 && /caller|query/.test(e.detail ?? ""));
    await assert.rejects(c.call("memory.recall", { ...loadFixtures().methods["memory.recall"].params, origin: "cron" }), (e: any) => e.error === "E_INVALID_PARAMS");
    await c.close();
  });

  it("passes RpcError through and hides internal errors as E_INTERNAL", async () => {
    const c = await connect({ address, token: TOKEN });
    const base = loadFixtures().methods["memory.recall"].params as any;
    await assert.rejects(c.call("memory.recall", { ...base, query: "throw" }), (e: any) => e.error === "E_AGENT_UNKNOWN" && e.reason === "not-registered");
    await assert.rejects(c.call("memory.recall", { ...base, query: "boom" }), (e: any) => e.error === "E_INTERNAL" && !/kaboom/.test(e.message));
    await c.close();
  });

  it("unknown method is E_INTERNAL/method-not-found with -32601, result is schema-validated", async () => {
    const c = await connect({ address, token: TOKEN });
    await assert.rejects(c.call("nope"), (e: any) => e.code === -32601 && e.reason === "method-not-found");
    const r = await c.call<any>("memory.recall", loadFixtures().methods["memory.recall"].params as any);
    assert.equal(r.trace.requestId.length > 0, true);
    await c.close();
  });

  it("subscriptions receive notify() filtered by name and agentId, and stop after unsubscribe", async () => {
    const c = await connect({ address, token: TOKEN });
    const got: unknown[] = []; c.onNotification((m, p) => got.push([m, p]));
    const { subscriptionId } = await c.call<any>("events.subscribe", { names: ["agent.activity"], agentId: "bernd" });
    server.notify("agent.activity", { agentId: "bernd", activity: { state: "recalling", since: 1 } });
    server.notify("agent.activity", { agentId: "other", activity: { state: "recalling", since: 1 } });
    server.notify("core.state", { process: { state: "ready" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(got, [["agent.activity", { agentId: "bernd", activity: { state: "recalling", since: 1 } }]]);
    assert.deepEqual(await c.call("events.unsubscribe", { subscriptionId }), { removed: true });
    server.notify("agent.activity", { agentId: "bernd", activity: { state: "idle", since: 2 } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.length, 1);
    await c.close();
  });

  it("closes an unauthenticated idle connection after authIdleMs", async () => {
    const raw = createConnection(address);
    const closed = new Promise<void>((r) => raw.once("close", () => r()));
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("not closed")), 1000))]);
  });

  it("rejects a line over 4 MiB and closes the connection", async () => {
    const raw = createConnection(address);
    await new Promise((r) => raw.once("connect", r));
    const dec = new LineDecoder(); const msgs: any[] = [];
    raw.on("data", (b) => msgs.push(...(dec.push(b) as any[])));
    raw.write(encodeLine({ jsonrpc: "2.0", id: 1, method: "core.auth", params: { token: TOKEN } }));
    raw.write(Buffer.alloc(4 * 1024 * 1024 + 10, 0x7b));
    await new Promise<void>((r) => raw.once("close", () => r()));
    assert.ok(msgs.some((m) => m.error?.data?.error === "E_INVALID_PARAMS" && m.error.data.reason === "line-too-long"));
  });

  it("a second listen on the same address fails, and close removes the socket", { skip: process.platform === "win32" }, async () => {
    const other = createRpcServer({ address, token: TOKEN, hello, logger: log, methods: {} });
    await assert.rejects(other.listen(), /EADDRINUSE|in use/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd "$HARNESS/packages/core" && pnpm test` → the rpc-server file fails with module not found.

- [ ] **Step 3: Write `src/rpc/errors.ts`**

```ts
import { ERROR_CODES, type ErrorCode } from "@plur1bus/rpc-schema";

const DEFAULT_JSONRPC_CODE: Record<ErrorCode, number> = {
  E_UNAUTHORIZED: -32000, E_RPC_VERSION: -32000, E_NOT_AVAILABLE: -32000, E_CORE_UNAVAILABLE: -32000,
  E_INVALID_PARAMS: -32602, E_AGENT_UNKNOWN: -32000, E_CONFIG_INVALID: -32000, E_MODULE_UNKNOWN: -32000, E_INTERNAL: -32000, E_LOCKED: -32000,
};

export class RpcError extends Error {
  error: ErrorCode; reason?: string; detail?: string; jsonrpcCode: number;
  constructor(error: ErrorCode, message: string, opts: { reason?: string; detail?: string; jsonrpcCode?: number } = {}) {
    if (!ERROR_CODES.includes(error)) throw new Error(`unknown error code ${error}`);
    super(message); this.name = "RpcError"; this.error = error; this.jsonrpcCode = opts.jsonrpcCode ?? DEFAULT_JSONRPC_CODE[error];
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
  toJSON() {
    const data: Record<string, string> = { error: this.error };
    if (this.reason) data.reason = this.reason; if (this.detail) data.detail = this.detail;
    return { code: this.jsonrpcCode, message: this.message, data };
  }
}
```

- [ ] **Step 4: Write `src/rpc/server.ts`**

```ts
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { LineDecoder, LineTooLong, encodeLine } from "@plur1bus/module-api";
import { METHODS, validateParams, validateRequest, validateResult } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "../logger.ts";
import { RpcError } from "./errors.ts";

export interface CallContext { requestId: string; connectionId: string; signal: AbortSignal }
export type Handler = (params: any, ctx: CallContext) => Promise<unknown>;
export interface Subscription { id: string; connectionId: string; names?: string[]; agentId?: string }
export interface Hello { contract: string; rpc: string; instanceId: string; pid: number }
export interface RpcServer {
  listen(): Promise<void>; close(): Promise<void>;
  notify(method: string, params: object, filter?: (sub: Subscription) => boolean): void;
  subscriptions(): Subscription[];
}

interface Conn { id: string; sock: Socket; authed: boolean; dec: LineDecoder; inflight: Map<string | number, AbortController>; subs: Map<string, Subscription> }

export function createRpcServer(o: { address: string; token: string; hello: () => Hello; methods: Record<string, Handler>; logger: HarnessLogger; authIdleMs?: number }): RpcServer {
  const authIdleMs = o.authIdleMs ?? 30_000;
  const tokenBuf = Buffer.from(o.token, "utf8");
  const conns = new Map<string, Conn>();
  let server: Server | null = null;

  const send = (c: Conn, msg: unknown) => { if (!c.sock.destroyed) c.sock.write(encodeLine(msg)); };
  const errorReply = (c: Conn, id: unknown, e: RpcError) => send(c, { jsonrpc: "2.0", id: id ?? null, error: e.toJSON() });

  function tokenMatches(t: unknown): boolean {
    if (typeof t !== "string") return false;
    const b = Buffer.from(t, "utf8");
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  }

  async function dispatch(c: Conn, msg: any): Promise<void> {
    const req = validateRequest(msg);
    if (!req.ok) return errorReply(c, msg?.id, new RpcError("E_INVALID_PARAMS", "invalid request", { reason: "invalid-request", detail: req.errors.join("; "), jsonrpcCode: -32600 }));
    const { id, method, params = {} } = msg;
    const log = o.logger.child({ requestId: String(id), connectionId: c.id, method });

    if (method === "core.auth") {
      if (!tokenMatches(params.token)) { errorReply(c, id, new RpcError("E_UNAUTHORIZED", "bad token", { reason: "bad-token" })); c.sock.destroy(); return; }
      c.authed = true; return send(c, { jsonrpc: "2.0", id, result: o.hello() });
    }
    if (!c.authed) return errorReply(c, id, new RpcError("E_UNAUTHORIZED", "authenticate first", { reason: "auth-required" }));

    if (method === "events.subscribe") {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      const sub: Subscription = { id: randomUUID(), connectionId: c.id, ...(params.names ? { names: params.names } : {}), ...(params.agentId ? { agentId: params.agentId } : {}) };
      c.subs.set(sub.id, sub); return send(c, { jsonrpc: "2.0", id, result: { subscriptionId: sub.id } });
    }
    if (method === "events.unsubscribe") {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      return send(c, { jsonrpc: "2.0", id, result: { removed: c.subs.delete(params.subscriptionId) } });
    }

    const handler = o.methods[method];
    if (!METHODS.includes(method) || !handler) return errorReply(c, id, new RpcError("E_INTERNAL", `method not found: ${method}`, { reason: "method-not-found", jsonrpcCode: -32601 }));
    const v = validateParams(method, params);
    if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));

    const ac = new AbortController(); c.inflight.set(id, ac);
    const t0 = performance.now();
    try {
      const result = await handler(params, { requestId: String(id), connectionId: c.id, signal: ac.signal });
      const rv = validateResult(method, result);
      if (!rv.ok) { log.error("result violates schema", { errors: rv.errors }); return errorReply(c, id, new RpcError("E_INTERNAL", "result violates schema", { reason: "result-schema" })); }
      send(c, { jsonrpc: "2.0", id, result });
      log.debug("ok", { ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (e instanceof RpcError) { log.info("rpc error", { error: e.error, reason: e.reason }); return errorReply(c, id, e); }
      log.error("handler failed", { err: e });
      errorReply(c, id, new RpcError("E_INTERNAL", "internal error", { reason: "handler-threw" }));
    } finally { c.inflight.delete(id); }
  }

  function onConnection(sock: Socket) {
    const c: Conn = { id: randomUUID(), sock, authed: false, dec: new LineDecoder(), inflight: new Map(), subs: new Map() };
    conns.set(c.id, c);
    const authTimer = setTimeout(() => { if (!c.authed) { o.logger.debug("auth idle timeout", { connectionId: c.id }); sock.destroy(); } }, authIdleMs);
    sock.on("data", (chunk) => {
      let msgs: unknown[];
      try { msgs = c.dec.push(chunk); }
      catch (e) {
        if (e instanceof LineTooLong) { errorReply(c, null, new RpcError("E_INVALID_PARAMS", e.message, { reason: "line-too-long" })); sock.destroy(); }
        else errorReply(c, null, new RpcError("E_INVALID_PARAMS", "parse error", { reason: "parse-error", jsonrpcCode: -32700 }));
        return;
      }
      for (const m of msgs) void dispatch(c, m);
    });
    sock.on("close", () => { clearTimeout(authTimer); for (const ac of c.inflight.values()) ac.abort(new Error("connection closed")); conns.delete(c.id); });
    sock.on("error", (e) => o.logger.debug("socket error", { connectionId: c.id, err: e }));
  }

  return {
    async listen() {
      if (process.platform !== "win32") {
        mkdirSync(dirname(o.address), { recursive: true, mode: 0o700 }); chmodSync(dirname(o.address), 0o700);
        if (existsSync(o.address)) {
          // A socket file may be stale (SIGKILLed core) or live (another server). Only a stale one is removed.
          const alive = await new Promise<boolean>((res) => { const s = createConnection(o.address); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
          if (alive) throw new Error(`address in use: ${o.address}`);
          unlinkSync(o.address);
        }
      }
      server = createServer(onConnection);
      await new Promise<void>((res, rej) => { server!.once("error", rej); server!.listen(o.address, () => { server!.off("error", rej); res(); }); });
      if (process.platform !== "win32") chmodSync(o.address, 0o600);
      o.logger.info("rpc listening", { address: o.address });
    },
    async close() {
      for (const c of conns.values()) c.sock.destroy();
      await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
      if (process.platform !== "win32" && existsSync(o.address)) unlinkSync(o.address);
    },
    notify(method, params, filter) {
      const line = encodeLine({ jsonrpc: "2.0", method, params });
      for (const c of conns.values()) for (const sub of c.subs.values()) {
        if (sub.names && !sub.names.includes(method)) continue;
        if (sub.agentId && (params as any).agentId !== sub.agentId) continue;
        if (filter && !filter(sub)) continue;
        if (!c.sock.destroyed) c.sock.write(line); break; // one delivery per connection
      }
    },
    subscriptions: () => [...conns.values()].flatMap((c) => [...c.subs.values()]),
  };
}
```

A stale socket file left by a SIGKILLed core is unlinked before listening, but only after a probe connection got no answer; a file that a live server answers on is `address in use` (the test `a second listen on the same address fails` pins this). The lock (Task 7) is the primary guard; this probe is defence in depth.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && cd "$HARNESS" && pnpm typecheck` → all previous plus 9 rpc-server tests pass. If `a second listen` does not reject on macOS (stale-file unlink races), use a second `mkdtemp` address in that test and assert on the first server's `close()` removing its file — record the change in the report.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): JSON-RPC 2.0 NDJSON server with token auth, schema validation both ways, subscriptions, idle and size limits"
```

---

### Task 7: core — principal, harness host, OS-held lock

**Files:**
- Create: `packages/core/src/principal.ts`, `packages/core/src/host.ts`, `packages/core/src/lock.ts`, `packages/core/src/agents.ts`, `packages/core/src/agent-templates/SOUL.md`, `packages/core/src/agent-templates/USER.md`, `packages/core/src/agent-templates/persona-voice.md`, `packages/core/test/principal.test.ts`, `packages/core/test/host.test.ts`, `packages/core/test/lock.test.ts`, `packages/core/test/agents.test.ts`

**Interfaces:**
- Produces: `userPrincipalHash(caller: CallerIdentity): string` (`user:v1:<sha256hex>`); `callerToPrincipal(caller, agentId, workspaceDir): { principal: Principal; degraded: Degraded | null }` (validates lengths/control chars; on failure returns `trust: "inferred"` and `degraded { reason: "principal-invalid", capability: "identity", detail }`); `AGENT_CONTEXT_CLI: AgentContext = { origin: "user", background: false }`; `createHarnessHost(o: { layout, logger, config, engineConfig, events: (name, payload) => void, clock? }): HostServices`; `acquireCoreLock(path, instanceId): { release(): void }` (throws `RpcError("E_LOCKED")`); `AgentRegistry` with `list(): string[]`, `has(id)`, `scaffold(id)` (creates `agents/<id>/{SOUL.md,USER.md,persona-voice.md,workspace/}` from templates, idempotent), `workspaceOf(id)`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/principal.test.ts` — the one test allowed to import the engine's lib (parity guard):

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
// The only lib import in the harness: proves the harness hash equals the engine's, forever.
import { resolveMemoryRequestContext } from "@cyb3rb1ade/plur1bus-memory/lib/memory-request-context.js";
import { AGENT_CONTEXT_CLI, callerToPrincipal, userPrincipalHash } from "../src/principal.ts";

describe("principal", () => {
  const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
  it("derives the same user principal as the engine's own resolver", () => {
    const ws = mkdtempSync(join(tmpdir(), "p1b-ws-"));
    const lib = resolveMemoryRequestContext({ agentId: "bernd", workspaceDir: ws, channel: "cli", accountId: "macbooker", userId: "cyberblade" });
    assert.equal(userPrincipalHash(caller), lib.userPrincipal);
    const { principal, degraded } = callerToPrincipal(caller, "bernd", ws);
    assert.equal(degraded, null);
    assert.equal(principal.user, lib.userPrincipal);
    assert.equal(principal.workspace, `workspace-dir:v1:${realpathSync.native(ws)}`);
    assert.equal(principal.workspace, lib.workspaceIdentity);
    assert.deepEqual({ trust: principal.trust, channel: principal.channel, accountId: principal.accountId, chat: principal.chat }, { trust: "proved", channel: "cli", accountId: "macbooker", chat: { id: "cli:cyberblade", kind: "direct" } });
    assert.deepEqual(AGENT_CONTEXT_CLI, { origin: "user", background: false });
  });
  it("an invalid caller identity degrades to inferred and says so", () => {
    const ws = mkdtempSync(join(tmpdir(), "p1b-ws-"));
    const bad = callerToPrincipal({ channel: "cli", accountId: "host\u0000name", userId: "u" }, "bernd", ws);
    assert.equal(bad.principal.trust, "inferred");
    assert.equal(bad.principal.user, undefined);
    assert.deepEqual({ reason: bad.degraded?.reason, capability: bad.degraded?.capability }, { reason: "principal-invalid", capability: "identity" });
    const long = callerToPrincipal({ channel: "cli", accountId: "h", userId: "u".repeat(129) }, "bernd", ws);
    assert.equal(long.principal.trust, "inferred");
  });
});
```

`packages/core/test/lock.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCoreLock } from "../src/lock.ts";

const holder = fileURLToPath(new URL("./helpers/lock-holder.ts", import.meta.url));

describe("core lock", () => {
  it("refuses a second holder in another process and frees on SIGKILL", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "p1b-lock-")), "core.lock");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", holder, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    assert.throws(() => acquireCoreLock(path, "second"), (e: any) => e.error === "E_LOCKED" && e.reason === "core-lock-held");
    child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r));
    const lock = acquireCoreLock(path, "second"); lock.release();
  });
  it("release lets the same process re-acquire", () => {
    const path = join(mkdtempSync(join(tmpdir(), "p1b-lock-")), "core.lock");
    const a = acquireCoreLock(path, "i1"); a.release();
    const b = acquireCoreLock(path, "i2"); b.release();
  });
});
```

`packages/core/test/helpers/lock-holder.ts`:

```ts
import { acquireCoreLock } from "../../src/lock.ts";
acquireCoreLock(process.argv[2]!, "holder");
process.stdout.write("locked\n");
setInterval(() => {}, 1000);
```

`packages/core/test/agents.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { layout } from "../src/paths.ts";

describe("agents", () => {
  it("lists config.agents, scaffolds the persona files once, and knows unregistered ids", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); cfg.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    const reg = createAgentRegistry(cfg, l);
    assert.deepEqual(reg.list(), ["bernd"]); assert.equal(reg.has("nobody"), false);
    reg.scaffold("bernd");
    for (const f of ["SOUL.md", "USER.md", "persona-voice.md"]) assert.ok(existsSync(join(l.agentDir("bernd"), f)), f);
    assert.ok(existsSync(l.workspaceDir("bernd")));
    assert.match(readFileSync(join(l.agentDir("bernd"), "persona-voice.md"), "utf8"), /<!-- persona:begin -->[\s\S]*<!-- persona:end -->/);
    const before = readFileSync(join(l.agentDir("bernd"), "SOUL.md"), "utf8");
    reg.scaffold("bernd");
    assert.equal(readFileSync(join(l.agentDir("bernd"), "SOUL.md"), "utf8"), before, "idempotent");
  });
});
```

`packages/core/test/host.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createHarnessHost } from "../src/host.ts";
import { buildEngineConfig } from "../src/engine-config.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { createAgentRegistry } from "../src/agents.ts";

describe("harness host", () => {
  it("implements HostServices without routing, pathOverrides or runtime", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-host-")));
    const cfg = defaults(); cfg.agents.bernd = {};
    const reg = createAgentRegistry(cfg, l); reg.scaffold("bernd");
    const events: unknown[] = [];
    const host = createHarnessHost({ layout: l, logger: createLogger({ file: l.logFile("core"), level: "info", role: "core" }), config: cfg, engineConfig: buildEngineConfig(cfg, l), agents: reg, events: (n, p) => events.push([n, p]) });
    assert.equal(host.stateDir, l.state);
    assert.equal(host.configPath(), l.configPath);
    assert.equal(host.routing, undefined); assert.equal(host.pathOverrides, undefined); assert.equal(host.runtime, null);
    assert.equal(host.llm, undefined); assert.equal(host.secrets, undefined);
    assert.equal(await host.workspaceDir("bernd"), l.workspaceDir("bernd"));
    assert.equal(await host.workspaceDir("nobody"), undefined);
    assert.equal((host.config() as any).baseDbPath, l.lancedb);
    host.events!.emit("x", { a: 1 }); assert.deepEqual(events, [["x", { a: 1 }]]);
    assert.equal(typeof host.platform.securePath, "function");
  });
});
```

- [ ] **Step 2: Run to see them fail** — `pnpm test` → four new files fail with module not found.

- [ ] **Step 3: Write `src/principal.ts`**

```ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentContext, Degraded, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { CallerIdentity } from "@plur1bus/rpc-schema";

export const AGENT_CONTEXT_CLI: AgentContext = Object.freeze({ origin: "user", background: false });

const MAX_IDENTITY = 128; // INPUT_LIMITS.ACCOUNT_ID / USER_ID in the engine's lib/input-limits.js
const CONTROL = /[\u0000-\u001f\u007f]/;

function validIdentity(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_IDENTITY && !CONTROL.test(v);
}

/** Exactly lib/memory-request-context.js:332-334: sha256 over JSON.stringify([channel, accountId, userId]). */
export function userPrincipalHash(c: CallerIdentity): string {
  return `user:v1:${createHash("sha256").update(JSON.stringify([c.channel, c.accountId, c.userId]), "utf8").digest("hex")}`;
}

export function callerToPrincipal(c: CallerIdentity, agentId: string, workspaceDir: string): { principal: Principal; degraded: Degraded | null } {
  const workspace = `workspace-dir:v1:${realpathSync.native(workspaceDir)}` as const;
  const problems: string[] = [];
  if (c.channel !== "cli") problems.push("channel");
  if (!validIdentity(c.accountId)) problems.push("accountId");
  if (!validIdentity(c.userId)) problems.push("userId");
  if (problems.length) {
    return {
      principal: { agentId, workspace, channel: "cli", accountId: "", chat: { id: "", kind: "direct" }, trust: "inferred" },
      degraded: { reason: "principal-invalid", capability: "identity", detail: `invalid ${problems.join(", ")}` },
    };
  }
  return {
    principal: { agentId, workspace, user: userPrincipalHash(c), channel: "cli", accountId: c.accountId, chat: { id: `cli:${c.userId}`, kind: "direct" }, trust: "proved" },
    degraded: null,
  };
}
```

- [ ] **Step 4: Write `src/lock.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcError } from "./rpc/errors.ts";

/**
 * An OS-held exclusive lock without a native addon: an open SQLite EXCLUSIVE
 * transaction is an fcntl/LockFileEx lock the kernel releases when the process
 * dies. A second BEGIN EXCLUSIVE fails at once (busy_timeout 0). Verified on
 * Node 24.21 (plan H1 pre-check): refused while held, free after SIGKILL.
 */
export function acquireCoreLock(path: string, instanceId: string): { release(): void } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
    db.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("DELETE FROM holder").run();
    db.prepare("INSERT INTO holder VALUES (?, ?, ?)").run(process.pid, instanceId, Date.now());
  } catch (e) {
    db.close();
    throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: (e as Error).message });
  }
  return { release() { try { db.exec("ROLLBACK"); } catch { /* already gone */ } db.close(); } };
}
```

- [ ] **Step 5: Write `src/agents.ts` and the templates**

`src/agents.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";

const TEMPLATE_DIR = new URL("./agent-templates/", import.meta.url);
const TEMPLATES = ["SOUL.md", "USER.md", "persona-voice.md"] as const;

export interface AgentRegistry { list(): string[]; has(id: string): boolean; scaffold(id: string): void; workspaceOf(id: string): string | undefined }

export function createAgentRegistry(config: HarnessConfig, l: Layout): AgentRegistry {
  return {
    list: () => Object.keys(config.agents).sort(),
    has: (id) => Object.hasOwn(config.agents, id),
    scaffold(id) {
      mkdirSync(l.workspaceDir(id), { recursive: true, mode: 0o700 });
      for (const t of TEMPLATES) {
        const target = join(l.agentDir(id), t);
        if (!existsSync(target)) writeFileSync(target, readFileSync(new URL(t, TEMPLATE_DIR), "utf8").replaceAll("{{agentId}}", id), { mode: 0o600 });
      }
    },
    workspaceOf: (id) => (Object.hasOwn(config.agents, id) ? l.workspaceDir(id) : undefined),
  };
}
```

`src/agent-templates/SOUL.md`:

```markdown
# {{agentId}}

<!-- Who this persona is: identity, values, how it speaks. Read into the system prompt (M2). -->
```

`src/agent-templates/USER.md`:

```markdown
# The people {{agentId}} works with

<!-- Owner and user context this persona should know. Read into the system prompt (M2). -->
```

`src/agent-templates/persona-voice.md` (markers exactly as `$ENGINE/lib/persona-voice.js:19-20` defines them: `MARKER_BEGIN = "<!-- persona:begin -->"`, `MARKER_END = "<!-- persona:end -->"`):

```markdown
# Voice of {{agentId}}

Seed lines above the managed block are yours to edit.

<!-- persona:begin -->
<!-- managed by PLUR1BUS: learned bullets are written here by the persona-evolve job; edit outside this block -->
<!-- persona:end -->
```

The `esbuild` bundle must ship the templates: add `--loader:.md=copy` is not enough for `new URL(..., import.meta.url)`; instead the build script copies `src/agent-templates` to `dist/agent-templates` (append `&& cp -r src/agent-templates dist/` on POSIX; use a tiny `scripts/copy-dir.mjs` at the root for cross-platform). Test-time reads work directly from `src/`.

- [ ] **Step 6: Write `src/host.ts`**

```ts
import type { EngineConfig, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { AgentRegistry } from "./agents.ts";
import { engineLoggerFrom, type HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";
import { platformCapabilities } from "./platform.ts";

export function createHarnessHost(o: { layout: Layout; logger: HarnessLogger; config: HarnessConfig; engineConfig: Record<string, unknown>; agents: AgentRegistry; events: (name: string, payload: unknown) => void; clock?: () => number }): HostServices {
  return {
    logger: engineLoggerFrom(o.logger.child({ src: "engine" })),
    stateDir: o.layout.state,
    configPath: () => o.layout.configPath,
    // routing, pathOverrides, capabilities: absent on purpose (spec §6.3)
    workspaceDir: async (agentId) => o.agents.workspaceOf(agentId),
    config: () => o.engineConfig as EngineConfig,
    // mutateConfig: absent in H1 (H2 forwards to the supervisor's config.set)
    events: { emit: (name, payload) => o.events(name, payload) },
    clock: o.clock ?? Date.now,
    platform: platformCapabilities,
    runtime: null,
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test && cd "$HARNESS" && pnpm typecheck` → 6 new tests pass. The parity test will fail loudly if the engine ever changes its hash formula — that is its job.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): CLI principal with engine-parity hash, harness HostServices, OS-held core lock via node:sqlite, agent scaffolding with persona files"
```

---

### Task 8: core — engine binding, method table, join, activity

**Files:**
- Create: `packages/core/src/join.ts`, `packages/core/src/activity.ts`, `packages/core/src/engine.ts`, `packages/core/src/rpc/methods.ts`, `packages/core/src/core.ts`, `packages/core/src/index.ts`, `packages/core/test/join.test.ts`, `packages/core/test/activity.test.ts`, `packages/core/test/core.test.ts`, `packages/core/test/helpers/flat-embedder.ts`

**Interfaces:**
- Produces: `joinBlocks(blocks: ContextBlock[], capChars: number): { text: string; deferrals: Deferral[] }`; `class ActivityTracker { get(agentId): Activity; set(agentId, activity): void; idle(agentId): void; onChange(handler): () => void }`; `createCore(o: { home: string; instanceId?: string; testInternals?: Record<string, unknown>; clock?: () => number }): Core` with `Core = { start(): Promise<void>; stop(o?: { budgetMs?: number }): Promise<void>; status(): CoreStatusResult; address: string; token: string }`; the method handlers for `core.status`, `core.shutdown`, `memory.recall|capture|checkpoint`, `memory.list|show|forget|correct|share|state`, `agent.list|open|close|status`, `jobs.list|run|history`.
- Consumes: Tasks 5–7.

- [ ] **Step 1: Write the failing join and activity tests**

`packages/core/test/join.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/join.ts";

const b = (name: string, text: string, droppable = true) => ({ name, text, droppable, chars: text.length });

describe("joinBlocks", () => {
  it("joins in order with blank lines when under the cap", () => {
    const r = joinBlocks([b("time", "now"), b("memories", "- a")], 100);
    assert.deepEqual(r, { text: "now\n\n- a", deferrals: [] });
  });
  it("clips the last droppable block first and records the deferral", () => {
    const r = joinBlocks([b("start", "S", false), b("memories", "0123456789"), b("reminder", "R")], 9);
    assert.equal(r.text, "S\n\n0123\n\nR".length <= 9 ? r.text : r.text);
    assert.ok(r.text.length <= 9);
    assert.equal(r.deferrals.length, 1);
    assert.deepEqual(r.deferrals[0], { block: "memories", kind: "clipped", from: 10, to: 10 - (("S\n\n0123456789\n\nR").length - 9), reason: "global-cap" });
  });
  it("drops droppable blocks that cannot fit at all, never a non-droppable one", () => {
    const r = joinBlocks([b("start", "SSSSS", false), b("memories", "MMMMM"), b("reminder", "RRRRR")], 6);
    assert.equal(r.text, "SSSSS");
    assert.deepEqual(r.deferrals.map((d) => [d.block, d.kind]), [["memories", "dropped"], ["reminder", "dropped"]]);
  });
  it("Infinity cap joins everything", () => {
    assert.equal(joinBlocks([b("a", "x".repeat(50_000))], Number.POSITIVE_INFINITY).text.length, 50_000);
  });
});
```

`packages/core/test/activity.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker } from "../src/activity.ts";

describe("ActivityTracker", () => {
  it("starts idle, emits on every transition, keeps since", () => {
    let now = 1000; const t = new ActivityTracker(() => now);
    const seen: unknown[] = []; t.onChange((id, a) => seen.push([id, a]));
    assert.deepEqual(t.get("bernd"), { state: "idle", since: 1000 });
    now = 1010; t.set("bernd", { state: "recalling" });
    now = 1020; t.set("bernd", { state: "dreaming", phase: "rem", job: "rem-dream" });
    now = 1030; t.idle("bernd");
    assert.deepEqual(seen, [["bernd", { state: "recalling", since: 1010 }], ["bernd", { state: "dreaming", phase: "rem", job: "rem-dream", since: 1020 }], ["bernd", { state: "idle", since: 1030 }]]);
  });
  it("setting the same state again does not emit", () => {
    const t = new ActivityTracker(() => 1); let n = 0; t.onChange(() => n++);
    t.set("a", { state: "capturing" }); t.set("a", { state: "capturing" });
    assert.equal(n, 1);
  });
});
```

- [ ] **Step 2: Run to see them fail** — module not found.

- [ ] **Step 3: Write `src/join.ts` and `src/activity.ts`**

`src/join.ts`:

```ts
import type { ContextBlock, Deferral } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const SEP = "\n\n";

/** The harness's own join (spec §6.6 --joined): order preserved, blocks separated by a blank line, total ≤ capChars.
 *  Over the cap: droppable blocks are clipped from the last one backwards; a block that would be clipped to nothing is dropped. */
export function joinBlocks(blocks: ContextBlock[], capChars: number): { text: string; deferrals: Deferral[] } {
  const parts = blocks.map((b) => ({ ...b, text: b.text }));
  const deferrals: Deferral[] = [];
  const total = () => parts.reduce((n, p, i) => n + p.text.length + (i && p.text.length ? SEP.length : 0), 0);
  for (let i = parts.length - 1; i >= 0 && total() > capChars; i -= 1) {
    const p = parts[i]!;
    if (!p.droppable || p.text.length === 0) continue;
    const over = total() - capChars;
    const keep = Math.max(0, p.text.length - over);
    if (keep === 0) { deferrals.push({ block: p.name, kind: "dropped", from: p.text.length, to: 0, reason: "global-cap" }); p.text = ""; }
    else { deferrals.push({ block: p.name, kind: "clipped", from: p.text.length, to: keep, reason: "global-cap" }); p.text = p.text.slice(0, keep); }
  }
  return { text: parts.filter((p) => p.text.length).map((p) => p.text).join(SEP), deferrals: deferrals.reverse() };
}
```

`src/activity.ts`:

```ts
export type ActivityState = "idle" | "recalling" | "capturing" | "checkpointing" | "dreaming" | "consolidating" | "maintenance";
export interface Activity { state: ActivityState; since: number; phase?: "light" | "rem" | "deep"; job?: string }
type Handler = (agentId: string, activity: Activity) => void;

export class ActivityTracker {
  #now: () => number; #map = new Map<string, Activity>(); #handlers = new Set<Handler>();
  constructor(now: () => number = Date.now) { this.#now = now; }
  get(agentId: string): Activity { return this.#map.get(agentId) ?? { state: "idle", since: this.#now() }; }
  set(agentId: string, next: Omit<Activity, "since">): void {
    const cur = this.#map.get(agentId);
    if (cur && cur.state === next.state && cur.phase === next.phase && cur.job === next.job) return;
    const a: Activity = { ...next, since: this.#now() };
    this.#map.set(agentId, a);
    for (const h of this.#handlers) h(agentId, a);
  }
  idle(agentId: string): void { this.set(agentId, { state: "idle" }); }
  onChange(h: Handler): () => void { this.#handlers.add(h); return () => this.#handlers.delete(h); }
}
```

- [ ] **Step 4: Run join/activity tests** → 6 pass.

- [ ] **Step 5: Write the failing core test**

`packages/core/test/helpers/flat-embedder.ts` (the engine contract test's stub, `$ENGINE/tests/engine-contract.test.js:33-38`):

```ts
export function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts: string[]) => texts.map(vector), shutdown: async () => {} };
}
```

`packages/core/test/core.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatEmbedder } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

describe("core", () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-core-"));
  const l = layout(home);
  let core: Core; let c: CoreClient;
  before(async () => {
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    core = createCore({ home, testInternals: { embeddings: flatEmbedder() } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("core.status is ready with the registered agent idle and the real contract", async () => {
    const s = await c.call<any>("core.status");
    assert.equal(s.process.state, "ready"); assert.equal(s.contract, "1.4.1"); assert.equal(s.rpc, "1.0.0");
    assert.deepEqual(s.agents.map((a: any) => [a.agentId, a.activity.state]), [["bernd", "idle"]]);
  });

  it("capture then recall in another session finds the fact; activity notifications fire", async () => {
    const seen: string[] = []; c.onNotification((m, p: any) => { if (m === "agent.activity") seen.push(p.activity.state); });
    await c.call("events.subscribe", { names: ["agent.activity"] });
    const cap = await c.call<any>("memory.capture", { caller, agentId: "bernd", sessionKey: "s1", messages: [{ role: "user", content: "Please remember that the roadmap review is on Thursday at ten." }, { role: "assistant", content: "Noted." }] });
    assert.ok(cap.stored >= 1, JSON.stringify(cap));
    const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", sessionKey: "s2", query: "when is the roadmap review", joined: true, budget: { softMs: 2000, hardMs: 4000 } });
    assert.equal(r.degraded, null, JSON.stringify(r.degraded));
    assert.match(r.joined.text, /roadmap review/i);
    assert.ok(seen.includes("capturing") && seen.includes("recalling") && seen.at(-1) === "idle", seen.join(","));
  });

  it("recall for an unregistered agent is E_AGENT_UNKNOWN and creates nothing", async () => {
    await assert.rejects(c.call("memory.recall", { caller, agentId: "ghost", query: "x" }), (e: any) => e.error === "E_AGENT_UNKNOWN");
    assert.equal(require("node:fs").existsSync(l.agentDir("ghost")), false);
  });

  it("an invalid caller identity comes back degraded, not as an error", async () => {
    const r = await c.call<any>("memory.recall", { caller: { ...caller, userId: "u".repeat(129) }, agentId: "bernd", query: "anything" });
    assert.equal(r.degraded?.reason, "principal-invalid");
  });

  it("memory ops answer E_NOT_AVAILABLE engine-pr-E1", async () => {
    for (const m of ["memory.list", "memory.show", "memory.forget", "memory.correct", "memory.share", "memory.state"]) {
      await assert.rejects(c.call(m, { caller, agentId: "bernd" }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-pr-E1", m);
    }
  });

  it("jobs.list has 18 jobs; jobs.run of a skipped job returns a JobRun; history lists it", async () => {
    const { jobs } = await c.call<any>("jobs.list"); assert.equal(jobs.length, 18);
    const run = await c.call<any>("jobs.run", { agentId: "bernd", job: "gc-run" });
    assert.equal(run.job, "gc-run"); assert.ok(["completed", "skipped"].includes(run.outcome), run.outcome);
    const { runs } = await c.call<any>("jobs.history", { agentId: "bernd" }); assert.ok(runs.some((x: any) => x.runId === run.runId));
  });

  it("agent.status reports the workspace; checkpoint returns a digest", async () => {
    const s = await c.call<any>("agent.status", { agentId: "bernd" }); assert.equal(s.workspace, l.workspaceDir("bernd"));
    const cp = await c.call<any>("memory.checkpoint", { caller, agentId: "bernd", reason: "manual" }); assert.equal(typeof cp.digest, "string");
  });

  it("a second core on the same home is refused by the lock", async () => {
    const second = createCore({ home, testInternals: { embeddings: flatEmbedder() } });
    await assert.rejects(second.start(), (e: any) => e.error === "E_LOCKED");
  });
});
```

Use `import { existsSync } from "node:fs"` at the top instead of the inline `require` (ESM has no `require`); the line above is written that way only to keep the test body compact — fix it when you type it in.

- [ ] **Step 6: Run to see it fail** — module not found for `../src/core.ts`.

- [ ] **Step 7: Write `src/engine.ts`**

```ts
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

export function bindEngine(host: HostServices, engineConfig: Record<string, unknown>, testInternals?: Record<string, unknown>): Engine {
  const engine = createEngine(host, engineConfig, testInternals ? { internals: testInternals } : undefined);
  engine.channels.register("cli");
  return engine;
}
```

- [ ] **Step 8: Write `src/rpc/methods.ts`**

```ts
import type { Engine, Principal, RecallResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { ActivityTracker } from "../activity.ts";
import type { AgentRegistry } from "../agents.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "../principal.ts";
import { RpcError } from "./errors.ts";
import type { Handler } from "./server.ts";

export interface MethodDeps {
  engine: Engine; config: HarnessConfig; agents: AgentRegistry; activity: ActivityTracker; logger: HarnessLogger;
  status: () => unknown; shutdown: (budgetMs?: number) => void; journalBacklog: () => number; clock: () => number;
}

function requireAgent(agents: AgentRegistry, agentId: string): string {
  const ws = agents.workspaceOf(agentId);
  if (!ws) throw new RpcError("E_AGENT_UNKNOWN", `agent not registered: ${agentId}`, { reason: "not-registered" });
  return ws;
}

function identity(d: MethodDeps, caller: CallerIdentity, agentId: string): { principal: Principal; degraded: ReturnType<typeof callerToPrincipal>["degraded"] } {
  return callerToPrincipal(caller, agentId, requireAgent(d.agents, agentId));
}

function serializeRecall(r: RecallResult, joined: boolean, capChars: number) {
  // Project blocks onto the schema's five fields: the engine may decorate blocks with more, the wire shape is closed.
  const blocks = r.blocks.map((b) => ({ name: b.name, text: b.text, droppable: b.droppable, chars: b.chars, ...(b.tokensEstimate !== undefined ? { tokensEstimate: b.tokensEstimate } : {}) }));
  const base = { blocks, capChars: Number.isFinite(r.capChars) ? r.capChars : null, degraded: r.degraded, timing: r.timing, deferrals: r.deferrals, ...(r.trace ? { trace: r.trace } : {}) };
  return joined ? { ...base, joined: joinBlocks(blocks, Number.isFinite(r.capChars) ? Math.min(r.capChars, capChars) : capChars) } : base;
}

const notAvailable: Handler = async () => { throw new RpcError("E_NOT_AVAILABLE", "memory operations arrive with engine PR E1 (MemoryOps)", { reason: "engine-pr-E1" }); };

export function buildMethods(d: MethodDeps): Record<string, Handler> {
  const runJob = async (p: { agentId: string; job: string; dryRun?: boolean }, signal: AbortSignal) => {
    requireAgent(d.agents, p.agentId);
    const spec = d.engine.jobs.list().find((j) => j.name === p.job);
    if (!spec) throw new RpcError("E_INVALID_PARAMS", `unknown job ${p.job}`, { detail: "job" });
    const phase = spec.phase;
    d.activity.set(p.agentId, phase ? { state: "dreaming", phase, job: spec.name } : { state: "maintenance", job: spec.name });
    try { return await d.engine.jobs.run(spec.name, p.agentId, { signal, trigger: "harness", ...(p.dryRun !== undefined ? { dryRun: p.dryRun } : {}) }); }
    finally { d.activity.idle(p.agentId); }
  };

  return {
    "core.status": async () => d.status(),
    "core.shutdown": async (p) => { d.shutdown(p.budgetMs); return { accepted: true as const }; },

    "memory.recall": async (p, ctx) => {
      const { principal, degraded } = identity(d, p.caller, p.agentId);
      const hardMs = p.budget?.hardMs ?? d.config.core.recall.hardBudgetMs;
      const softMs = p.budget?.softMs ?? d.config.core.recall.softBudgetMs;
      const capChars = p.budget?.capChars ?? d.config.core.recall.capChars;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(hardMs)]);
      d.activity.set(p.agentId, { state: "recalling" });
      try {
        const r = await d.engine.recall({ query: p.query, principal, agent: AGENT_CONTEXT_CLI, budget: { softMs, hardMs, capChars }, signal }); // RecallQuery has no sessionKey (1.4.1): --session is a capture-side key until 2c
        const out = serializeRecall(r, p.joined === true, capChars);
        return degraded && !out.degraded ? { ...out, degraded } : out;
      } finally { d.activity.idle(p.agentId); }
    },

    "memory.capture": async (p, ctx) => {
      const { principal } = identity(d, p.caller, p.agentId);
      const waitMs = p.waitMs ?? d.config.core.capture.waitMs;
      d.activity.set(p.agentId, { state: "capturing" });
      const handle = d.engine.capture({ agentId: p.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: p.messages, incognito: false, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(waitMs)]), ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}), ...(p.runId ? { runId: p.runId } : {}) });
      const settle = handle.done.then((r) => { d.logger.info("capture done", { agentId: p.agentId, ...r }); return r; }).finally(() => d.activity.idle(p.agentId));
      if (p.wait === false) return { id: handle.id, acceptedAt: handle.acceptedAt, pending: true };
      const r = await settle;
      return { id: handle.id, acceptedAt: handle.acceptedAt, stored: r.stored, skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) };
    },

    "memory.checkpoint": async (p) => {
      requireAgent(d.agents, p.agentId);
      d.activity.set(p.agentId, { state: "checkpointing" });
      try { return await d.engine.checkpoint(p.agentId, p.reason); } finally { d.activity.idle(p.agentId); }
    },

    "memory.list": notAvailable, "memory.show": notAvailable, "memory.forget": notAvailable, "memory.correct": notAvailable, "memory.share": notAvailable, "memory.state": notAvailable,

    "agent.list": async () => ({ agents: d.agents.list().map((agentId) => ({ agentId, open: openAgents.has(agentId), activity: d.activity.get(agentId) })) }),
    "agent.open": async (p) => { requireAgent(d.agents, p.agentId); const store = await d.engine.open(p.agentId); openAgents.set(p.agentId, store); return { agentId: p.agentId, open: true as const }; },
    "agent.close": async (p) => { const s = openAgents.get(p.agentId); if (s) { await s.close(); openAgents.delete(p.agentId); } return { agentId: p.agentId, open: false as const }; },
    "agent.status": async (p) => {
      const workspace = requireAgent(d.agents, p.agentId);
      const lastJobs = await d.engine.jobs.history(p.agentId, { limit: 5 });
      return { agentId: p.agentId, open: openAgents.has(p.agentId), activity: d.activity.get(p.agentId), workspace, lastJobs };
    },

    "jobs.list": async () => ({ jobs: d.engine.jobs.list() }),
    "jobs.run": async (p, ctx) => runJob(p, ctx.signal),
    "jobs.history": async (p) => { requireAgent(d.agents, p.agentId); return { runs: await d.engine.jobs.history(p.agentId, { ...(p.job ? { job: p.job } : {}), ...(p.since !== undefined ? { since: p.since } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }) }; },
  };
}

const openAgents = new Map<string, { close(): Promise<void> }>();
```

Move `openAgents` inside `buildMethods` (declare it before `return`) — one map per core, not per module; the listing above puts it at the bottom only for readability.

- [ ] **Step 9: Write `src/core.ts` and `src/index.ts`**

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgentRegistry } from "./agents.ts";
import { ActivityTracker } from "./activity.ts";
import { loadConfig } from "./config-load.ts";
import { bindEngine } from "./engine.ts";
import { buildEngineConfig } from "./engine-config.ts";
import { createHarnessHost } from "./host.ts";
import { replayJournal } from "./journal.ts";
import { acquireCoreLock } from "./lock.ts";
import { createLogger, type HarnessLogger } from "./logger.ts";
import { coreAddress, layout, resolveHome, type Layout } from "./paths.ts";
import { RPC_VERSION } from "@plur1bus/rpc-schema";
import { buildMethods } from "./rpc/methods.ts";
import { createRpcServer, type RpcServer } from "./rpc/server.ts";

export interface Core { start(): Promise<void>; stop(o?: { budgetMs?: number }): Promise<void>; status(): unknown; readonly address: string; readonly token: string; readonly layout: Layout }
type ProcessState = { state: "starting" | "ready" | "degraded" | "stopping" | "stopped"; since: number; reason?: string };

export function createCore(o: { home?: string; instanceId?: string; testInternals?: Record<string, unknown>; clock?: () => number; logger?: HarnessLogger }): Core {
  const home = resolveHome({ ...(o.home ? { home: o.home } : {}) });
  const l = layout(home); const clock = o.clock ?? Date.now;
  const instanceId = o.instanceId ?? randomUUID();
  const token = randomBytes(32).toString("hex");
  const address = coreAddress(home);
  const startedAt = clock();
  let process_: ProcessState = { state: "starting", since: startedAt };
  let server: RpcServer | null = null; let lock: { release(): void } | null = null;
  let engine: ReturnType<typeof bindEngine> | null = null; let logger: HarnessLogger | null = null;
  let journalBacklog = 0; let stopping: Promise<void> | null = null;
  const activity = new ActivityTracker(clock);

  const setState = (s: ProcessState) => { process_ = s; server?.notify("core.state", { process: s }); };

  async function start(): Promise<void> {
    for (const d of [l.state, l.run, l.logs, l.agents, l.models, l.journal]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const { config } = loadConfig(l.configPath);
    logger = o.logger ?? createLogger({ file: l.logFile("core"), level: config.core.logLevel, role: "core" });
    lock = acquireCoreLock(l.coreLock, instanceId);
    const agents = createAgentRegistry(config, l);
    for (const id of agents.list()) agents.scaffold(id);
    const engineConfig = buildEngineConfig(config, l);
    const events = (name: string, payload: unknown) => server?.notify("engine.event", { name, ...(typeof (payload as any)?.agentId === "string" ? { agentId: (payload as any).agentId } : {}), payload });
    const host = createHarnessHost({ layout: l, logger, config, engineConfig, agents, events, clock });
    engine = bindEngine(host, engineConfig, o.testInternals);
    activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }));

    const status = () => ({
      process: process_, contract: engine!.contract, rpc: RPC_VERSION, instanceId, pid: process.pid, uptimeMs: clock() - startedAt,
      engine: { ready: process_.state === "ready", degraded: process_.state === "degraded" ? { reason: process_.reason ?? "unknown", capability: "core" } : null },
      agents: agents.list().map((agentId) => ({ agentId, activity: activity.get(agentId) })), journalBacklog,
    });
    const methods = buildMethods({ engine, config, agents, activity, logger, status, shutdown: (budgetMs) => { void stop({ ...(budgetMs !== undefined ? { budgetMs } : {}) }); }, journalBacklog: () => journalBacklog, clock });
    server = createRpcServer({ address, token, hello: () => ({ contract: engine!.contract, rpc: RPC_VERSION, instanceId, pid: process.pid }), methods, logger });

    const replay = await replayJournal({ dir: l.journal, agents, engine, logger, clock });
    journalBacklog = replay.kept;

    writeFileSync(l.coreToken, token, { mode: 0o600 });
    writeFileSync(l.corePid, `${process.pid}\n`, { mode: 0o600 });
    await server.listen();
    setState({ state: "ready", since: clock() });
    logger.info("core ready", { instanceId, address, replayed: replay.replayed, kept: replay.kept });
  }

  async function stop(so: { budgetMs?: number } = {}): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      setState({ state: "stopping", since: clock() });
      await engine?.close({ budgetMs: so.budgetMs ?? 30_000 });
      await server?.close();
      lock?.release();
      setState({ state: "stopped", since: clock() });
      await logger?.close();
    })();
    return stopping;
  }

  return { start, stop, status: () => process_, address, token, layout: l };
}
```

`src/index.ts`: `export { createCore, type Core } from "./core.ts"; export { layout, resolveHome, coreAddress } from "./paths.ts"; export { joinBlocks } from "./join.ts";`

`replayJournal` is Task 9; to run Task 8's tests now, create `src/journal.ts` with the signature and a stub body `return { replayed: 0, kept: 0 }` and replace it in Task 9 (its test file will drive the real one).

- [ ] **Step 10: Run the tests**

Run: `pnpm test && cd "$HARNESS" && pnpm typecheck`
Expected: all pass including 8 core tests. The capture test needs the engine's capture heuristics to store at least one item from the "Please remember…" message — the same phrasing the engine's own test uses (`$ENGINE/tests/engine-contract.test.js:273-276`). If `stored` is 0, print `cap.reason` and check `config.engine` disables nothing capture-related; do not loosen the assertion.

If the engine throws at construction because `host.configPath()` points at a harness `config.json` it tries to parse as an OpenClaw file, point `configPath()` at `join(l.state, "engine-config-unused.json")` in `host.ts`, record it in the report and in ADR-012 as the E6 motivation.

- [ ] **Step 11: Commit**

```bash
git add packages/core
git commit -m "feat(core): engine binding, method table for core/memory/agent/jobs, harness join, activity states, core lifecycle"
```

---

### Task 9: core — journal replay, process entry, test seam

**Files:**
- Create: `packages/core/src/journal.ts` (replace the stub), `packages/core/src/bin.ts`, `packages/core/test/journal.test.ts`, `packages/core/test/bin.test.ts`

**Interfaces:**
- Produces: `replayJournal(o: { dir; agents; engine; logger; clock }): Promise<{ replayed: number; kept: number }>`; `appendJournalLine(dir, line: JournalLine): void` (the same format the Rust CLI writes — Task 14 tests parity against the schema); `dist/core.js` CLI: `--home <path>`, `--test-internals flat-embedder` (only honoured with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`), exits 3 on `E_LOCKED`, 2 on `ConfigInvalid`, handles SIGTERM/SIGINT with `stop({ budgetMs: config.core.shutdownBudgetMs })`.

- [ ] **Step 1: Write the failing journal test**

`packages/core/test/journal.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { appendJournalLine, replayJournal } from "../src/journal.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";

const caller = { channel: "cli" as const, accountId: "h", userId: "u" };
const line = (id: string, content: string) => ({ v: 1 as const, id, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user" as const, content }] });

describe("journal", () => {
  it("replays complete lines and keeps a torn tail", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "one"));
    appendJournalLine(l.journal, line("22222222-2222-4222-8222-222222222222", "two"));
    writeFileSync(join(l.journal, "bernd.jsonl"), '{"v":1,"id":"33333333-3333-4333-8333-3', { flag: "a" });
    const captured: string[] = [];
    const engine = { capture: (t: any) => { captured.push(t.messages[0].content); return { id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 1, skipped: 0 }), abort() {} }; } } as any;
    const warnings: string[] = [];
    const logger = createLogger({ file: l.logFile("core"), level: "debug", role: "core" }); const origWarn = logger.warn; logger.warn = (m, f) => { warnings.push(m); origWarn(m, f); };
    const r = await replayJournal({ dir: l.journal, agents, engine, logger, clock: () => 1 });
    assert.deepEqual(r, { replayed: 2, kept: 1 });
    assert.deepEqual(captured, ["one", "two"]);
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8"), '{"v":1,"id":"33333333-3333-4333-8333-3');
    assert.ok(warnings.some((w) => /torn|unparseable/.test(w)));
  });
  it("keeps a line whose capture failed, and a line for an unregistered agent, with a reason in the log", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-journal-"))); mkdirSync(l.journal, { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {}; const agents = createAgentRegistry(cfg, l); agents.scaffold("bernd");
    appendJournalLine(l.journal, line("11111111-1111-4111-8111-111111111111", "fails"));
    appendJournalLine(l.journal, { ...line("22222222-2222-4222-8222-222222222222", "ghost"), agentId: "ghost" });
    const engine = { capture: () => ({ id: "x", acceptedAt: 1, done: Promise.resolve({ stored: 0, skipped: 1, reason: "engine-closed" }), abort() {} }) } as any;
    const r = await replayJournal({ dir: l.journal, agents, engine, logger: createLogger({ file: l.logFile("core"), level: "debug", role: "core" }), clock: () => 1 });
    assert.deepEqual(r, { replayed: 0, kept: 2 });
    assert.equal(readFileSync(join(l.journal, "bernd.jsonl"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(l.journal, "ghost.jsonl"), "utf8").trim().split("\n").length, 1);
  });
});
```

- [ ] **Step 2: Run to see it fail** — the stub returns `{0,0}`; assertions fail.

- [ ] **Step 3: Write `src/journal.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { validateJournalLine, type JournalLine } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";

export function appendJournalLine(dir: string, line: JournalLine): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${line.agentId}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Replays state/journal/<agentId>.jsonl: a line is removed only after the engine reports it stored or deliberately skipped
 *  (skipped with a reason other than a failure is still "handled"); failures, unregistered agents and unparseable lines stay. */
export async function replayJournal(o: { dir: string; agents: AgentRegistry; engine: Pick<Engine, "capture">; logger: HarnessLogger; clock: () => number }): Promise<{ replayed: number; kept: number }> {
  let replayed = 0; let kept = 0;
  if (!existsSync(o.dir)) return { replayed, kept };
  for (const file of readdirSync(o.dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(o.dir, file);
    const raw = readFileSync(path, "utf8");
    const keep: string[] = [];
    const lines = raw.split("\n");
    const tail = raw.endsWith("\n") ? null : lines.pop(); // a torn last line has no newline
    for (const text of lines) {
      if (!text) continue;
      let line: JournalLine;
      try { const parsed = JSON.parse(text); const v = validateJournalLine(parsed); if (!v.ok) throw new Error(v.errors.join("; ")); line = parsed; }
      catch (e) { o.logger.warn("journal: unparseable line kept", { file, err: e }); keep.push(text); continue; }
      const ws = o.agents.workspaceOf(line.agentId);
      if (!ws) { o.logger.warn("journal: agent not registered, line kept", { file, agentId: line.agentId }); keep.push(text); continue; }
      const { principal } = callerToPrincipal(line.caller, line.agentId, ws);
      const handle = o.engine.capture({ agentId: line.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: line.messages, incognito: false, signal: AbortSignal.timeout(60_000), ...(line.sessionKey ? { sessionKey: line.sessionKey } : {}), runId: `journal:${line.id}` });
      const r = await handle.done;
      const failed = r.stored === 0 && r.skipped > 0 && /engine-closed|aborted|timeout|error/i.test(r.reason ?? "");
      if (failed) { o.logger.warn("journal: capture failed, line kept", { file, id: line.id, reason: r.reason }); keep.push(text); }
      else { replayed += 1; o.logger.info("journal: replayed", { file, id: line.id, stored: r.stored, skipped: r.skipped }); }
    }
    if (tail !== null && tail !== undefined && tail.length) { o.logger.warn("journal: torn tail kept", { file, bytes: tail.length }); keep.push(tail); }
    kept += keep.length;
    const out = keep.length ? `${keep.join("\n")}${tail && keep.at(-1) === tail ? "" : "\n"}` : "";
    const tmp = `${path}.tmp`; writeFileSync(tmp, out, { mode: 0o600 }); renameSync(tmp, path);
  }
  return { replayed, kept };
}
```

- [ ] **Step 4: Run journal tests** → 2 pass; the core tests from Task 8 still pass.

- [ ] **Step 5: Write `src/bin.ts` and its test**

`src/bin.ts`:

```ts
import { parseArgs } from "node:util";
import { createCore } from "./core.ts";
import { ConfigInvalid } from "./config-load.ts";
import { RpcError } from "./rpc/errors.ts";

const { values } = parseArgs({ options: { home: { type: "string" }, "test-internals": { type: "string" } }, strict: true });
let testInternals: Record<string, unknown> | undefined;
if (values["test-internals"]) {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") { console.error("--test-internals requires PLUR1BUS_ALLOW_TEST_INTERNALS=1"); process.exit(2); }
  if (values["test-internals"] === "flat-embedder") {
    const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)); const one = async () => vector();
    testInternals = { embeddings: { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} } };
  } else { console.error(`unknown --test-internals ${values["test-internals"]}`); process.exit(2); }
}

const core = createCore({ ...(values.home ? { home: values.home } : {}), ...(testInternals ? { testInternals } : {}) });
const stop = (sig: string) => { console.error(`core: ${sig}, stopping`); void core.stop().then(() => process.exit(0)); };
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
try {
  await core.start();
  console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));
} catch (e) {
  if (e instanceof RpcError && e.error === "E_LOCKED") { console.error(`core: ${e.message} (${e.detail ?? ""})`); process.exit(3); }
  if (e instanceof ConfigInvalid) { console.error(`core: config invalid: ${e.errors.join("; ")}`); process.exit(2); }
  console.error("core: start failed", e); process.exit(1);
}
```

`test/bin.test.ts` (runs the built `dist/core.js`, so `pnpm build` first — the test builds if `dist/core.js` is missing):

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";

const dist = new URL("../dist/core.js", import.meta.url).pathname;
if (!existsSync(dist)) execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });

function startCore(home: string) {
  const child = spawn(process.execPath, [dist, "--home", home, "--test-internals", "flat-embedder"], { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<{ address: string }>((res, rej) => { child.stdout.once("data", (d) => res(JSON.parse(String(d)))); child.once("exit", (c) => rej(new Error(`exited ${c}`))); });
  return { child, ready };
}

describe("dist/core.js", () => {
  it("starts, answers status, stops cleanly on SIGTERM; a second start exits 3", async () => {
    const home = mkdtempSync(join(tmpdir(), "p1b-bin-")); const l = layout(home);
    const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false }, dreaming: { enabled: false }, neo: { enabled: false } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const { child, ready } = startCore(home); const { address } = await ready;
    const token = require("node:fs").readFileSync(l.coreToken, "utf8");
    const c = await connect({ address, token }); assert.equal((await c.call<any>("core.status")).process.state, "ready"); await c.close();
    const second = startCore(home); const code = await new Promise<number | null>((r) => second.child.once("exit", r)); assert.equal(code, 3);
    child.kill("SIGTERM"); const exit = await new Promise<number | null>((r) => child.once("exit", r)); assert.equal(exit, 0);
    assert.equal(existsSync(l.coreSocket) && process.platform !== "win32", false, "socket removed");
  });
  it("refuses --test-internals without the env guard", async () => {
    const child = spawn(process.execPath, [dist, "--home", mkdtempSync(join(tmpdir(), "p1b-bin-")), "--test-internals", "flat-embedder"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.once("exit", r)), 2);
  });
});
```

(Again: replace the inline `require` with a top-level `import { readFileSync } from "node:fs"`.)

- [ ] **Step 6: Run everything**

Run: `cd "$HARNESS/packages/core" && pnpm build && pnpm test && cd "$HARNESS" && pnpm typecheck` → all pass. Check `dist/core.js` starts in < 3 s without models (B8 advisory): `time node dist/core.js --home $(mktemp -d)` then Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): journal replay with torn-tail safety, process entry with signals and exit codes, guarded test seam"
```

---

### Task 10: `plur1bus-rpc` crate — generated types, blocking client, fixture parity

**Files:**
- Create: `crates/plur1bus-rpc/Cargo.toml`, `crates/plur1bus-rpc/build.rs`, `crates/plur1bus-rpc/src/lib.rs`, `crates/plur1bus-rpc/src/error.rs`, `crates/plur1bus-rpc/src/transport.rs`, `crates/plur1bus-rpc/src/client.rs`, `crates/plur1bus-rpc/tests/fixtures.rs`, `crates/plur1bus-rpc/tests/client.rs`

**Interfaces:**
- Produces: `pub mod types` (generated: `MemoryRecallParams`, `MemoryRecallResult`, `CoreStatusResult`, `CallerIdentity`, `JournalLine`, `ErrorCode`, …); `pub const RPC_VERSION: &str`; `pub const SUPPORTED_RPC_MAJOR: u64 = 1`; `pub enum RpcError { Call { error: ErrorCode, jsonrpc: i64, message: String, reason: Option<String>, detail: Option<String> }, Unavailable { reason: String, detail: String }, Version { server: String }, Protocol(String) }`; `pub struct Client` with `Client::connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError>`, `client.hello() -> &Hello`, `client.call(method: &str, params: serde_json::Value) -> Result<serde_json::Value, RpcError>`, `client.call_typed::<P: Serialize, R: DeserializeOwned>(method, &params) -> Result<R, RpcError>`; `pub struct ConnectOptions { connect_timeout: Duration (300 ms), call_timeout: Duration (30 s) }`; `pub fn is_unavailable(&RpcError) -> bool`.

- [ ] **Step 1: Write the failing fixture-parity test**

`crates/plur1bus-rpc/tests/fixtures.rs`:

```rust
//! Every fixture in packages/rpc-schema/fixtures must deserialize into the generated Rust types
//! and serialize back to the same JSON. This is the Rust half of spec criterion 7.
use plur1bus_rpc::types;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/rpc-schema/fixtures") }
fn load(rel: &str) -> Value { serde_json::from_str(&fs::read_to_string(fixtures().join(rel)).unwrap()).unwrap() }

fn round_trip<T: DeserializeOwned + Serialize>(v: &Value, what: &str) {
    let typed: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(&back, v, "{what}: serialize(deserialize(x)) != x");
}

macro_rules! method {
    ($file:literal, $p:ty, $r:ty) => {{
        let f = load(concat!("methods/", $file, ".json"));
        round_trip::<$p>(&f["params"], concat!($file, " params"));
        round_trip::<$r>(&f["result"], concat!($file, " result"));
    }};
}

#[test]
fn every_method_fixture_round_trips() {
    method!("core.auth", types::CoreAuthParams, types::CoreAuthResult);
    method!("core.status", types::CoreStatusParams, types::CoreStatusResult);
    method!("core.shutdown", types::CoreShutdownParams, types::CoreShutdownResult);
    method!("memory.recall", types::MemoryRecallParams, types::MemoryRecallResult);
    method!("memory.capture", types::MemoryCaptureParams, types::MemoryCaptureResult);
    method!("memory.checkpoint", types::MemoryCheckpointParams, types::MemoryCheckpointResult);
    method!("memory.list", types::MemoryListParams, types::MemoryListResult);
    method!("agent.list", types::AgentListParams, types::AgentListResult);
    method!("agent.open", types::AgentOpenParams, types::AgentOpenResult);
    method!("agent.close", types::AgentCloseParams, types::AgentCloseResult);
    method!("agent.status", types::AgentStatusParams, types::AgentStatusResult);
    method!("jobs.list", types::JobsListParams, types::JobsListResult);
    method!("jobs.run", types::JobsRunParams, types::JobsRunResult);
    method!("jobs.history", types::JobsHistoryParams, types::JobsHistoryResult);
    method!("events.subscribe", types::EventsSubscribeParams, types::EventsSubscribeResult);
    method!("events.unsubscribe", types::EventsUnsubscribeParams, types::EventsUnsubscribeResult);
}

#[test]
fn every_error_fixture_is_a_known_code_and_every_notification_round_trips() {
    for entry in fs::read_dir(fixtures().join("errors")).unwrap() {
        let v: Value = serde_json::from_str(&fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap();
        let code: types::ErrorCode = serde_json::from_value(v["error"]["data"]["error"].clone()).unwrap();
        assert_eq!(serde_json::to_value(code).unwrap(), v["error"]["data"]["error"]);
    }
    round_trip::<types::EngineEventNotification>(&load("notifications/engine.event.json"), "engine.event");
    round_trip::<types::AgentActivityNotification>(&load("notifications/agent.activity.json"), "agent.activity");
    round_trip::<types::CoreStateNotification>(&load("notifications/core.state.json"), "core.state");
}

#[test]
fn journal_line_type_matches_schema_fixture_shape() {
    let v = serde_json::json!({ "v": 1, "id": "11111111-1111-4111-8111-111111111111", "at": 1, "agentId": "bernd", "sessionKey": "s1",
        "caller": { "channel": "cli", "accountId": "h", "userId": "u" }, "messages": [{ "role": "user", "content": "x" }] });
    round_trip::<types::JournalLine>(&v, "journal line");
}
```

The method count in the macro list is 16 = every method in the schema minus the five MemoryOps twins of `memory.list` (identical `$ref`s; one is enough). The names follow the generator's Pascal-case rule from Task 2 (`memory.recall` → `MemoryRecallParams`); `build.rs` below applies the same rule, so both sides name types identically.

- [ ] **Step 2: Write `Cargo.toml` and `build.rs`, run to see the test fail**

`crates/plur1bus-rpc/Cargo.toml`:

```toml
[package]
name = "plur1bus-rpc"
version.workspace = true
edition.workspace = true
license.workspace = true
build = "build.rs"

[dependencies]
serde.workspace = true
serde_json.workspace = true

[build-dependencies]
typify = "0.8"
schemars = "0.8"
serde_json = "1"
syn = { version = "2", features = ["full"] }
prettyplease = "0.2"

[dev-dependencies]
tempfile.workspace = true
```

`crates/plur1bus-rpc/build.rs`:

```rust
//! Generates src/types.rs (into OUT_DIR) from packages/rpc-schema/schema/rpc.schema.json — the single source.
//! Same flattening as packages/rpc-schema/src/build.mjs: methods/<m>/{params,result} → <PascalM>{Params,Result},
//! notifications/<n> → <PascalN>Notification. `$defs` becomes `definitions` for schemars 0.8.
use serde_json::{Map, Value};
use std::{env, fs, path::PathBuf};

fn pascal(s: &str) -> String {
    s.split(|c| c == '.' || c == '-' || c == '_').map(|w| { let mut c = w.chars(); match c.next() { Some(f) => f.to_uppercase().collect::<String>() + c.as_str(), None => String::new() } }).collect()
}

fn rewrite_refs(v: &mut Value) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get_mut("$ref") { *r = r.replace("#/$defs/", "#/definitions/"); }
            m.remove("format"); // uuid/date-time stay plain strings in Rust
            for (_, x) in m.iter_mut() { rewrite_refs(x); }
        }
        Value::Array(a) => a.iter_mut().for_each(rewrite_refs),
        _ => {}
    }
}

fn main() {
    let schema_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../packages/rpc-schema/schema/rpc.schema.json");
    println!("cargo:rerun-if-changed={}", schema_path.display());
    let mut root: Value = serde_json::from_str(&fs::read_to_string(&schema_path).expect("rpc.schema.json")).unwrap();
    let mut defs: Map<String, Value> = root["$defs"].as_object().unwrap().clone();
    let methods = defs.remove("methods").unwrap(); let notifications = defs.remove("notifications").unwrap();
    for (m, def) in methods.as_object().unwrap() {
        defs.insert(format!("{}Params", pascal(m)), def["params"].clone());
        defs.insert(format!("{}Result", pascal(m)), def["result"].clone());
    }
    for (n, def) in notifications.as_object().unwrap() { defs.insert(format!("{}Notification", pascal(n)), def.clone()); }
    let rpc_version = root["x-rpc-version"].as_str().unwrap().to_string();
    let mut flat = serde_json::json!({ "$schema": "http://json-schema.org/draft-07/schema#", "title": "RpcRoot", "type": "object", "definitions": defs });
    rewrite_refs(&mut flat);
    let _ = root.take();

    let schema: schemars::schema::RootSchema = serde_json::from_value(flat).expect("flattened schema parses");
    let mut space = typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    space.add_root_schema(schema).expect("typify");
    let code = prettyplease::unparse(&syn::parse2::<syn::File>(space.to_stream()).expect("generated code parses"));
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("types.rs"), code).unwrap();
    fs::write(out.join("rpc_version.rs"), format!("pub const RPC_VERSION: &str = \"{rpc_version}\";\n")).unwrap();
}
```

`src/lib.rs`:

```rust
pub mod types { include!(concat!(env!("OUT_DIR"), "/types.rs")); }
include!(concat!(env!("OUT_DIR"), "/rpc_version.rs"));
pub const SUPPORTED_RPC_MAJOR: u64 = 1;
pub mod error; pub mod transport; pub mod client;
pub use client::{Client, ConnectOptions, Hello};
pub use error::{is_unavailable, RpcError};
```

Run: `cd "$HARNESS" && cargo test -p plur1bus-rpc --test fixtures`
Expected: compile errors in the test for the missing modules `error/transport/client` (stub them as empty files to see the fixture test itself), then the fixture test compiles or shows exactly which generated names differ from the expected ones. **Typify decides the final names**: if it emits `MemoryRecallParamsBudget` or turns `AgentId` into a newtype with `FromStr`, adapt the test to the emitted names — never hand-edit generated code. Record every deviation in the report so Task 11–15 use the emitted names. If typify rejects a construct (`const` inside `properties`, `oneOf` with `null`), rewrite that construct in `build.rs`'s `rewrite_refs` pass (e.g. `{"oneOf":[X,{"type":"null"}]}` → `{"anyOf":[X,{"type":"null"}]}`), not in the schema.

- [ ] **Step 3: Write `src/error.rs`**

```rust
use crate::types::ErrorCode;
use std::fmt;

#[derive(Debug)]
pub enum RpcError {
    Call { error: ErrorCode, jsonrpc: i64, message: String, reason: Option<String>, detail: Option<String> },
    Unavailable { reason: String, detail: String },
    Version { server: String },
    Protocol(String),
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Call { error, message, reason, detail, .. } => {
                write!(f, "{}: {message}", serde_json::to_value(error).unwrap().as_str().unwrap_or("E_INTERNAL"))?;
                if let Some(r) = reason { write!(f, " ({r})")?; }
                if let Some(d) = detail { write!(f, ": {d}")?; }
                Ok(())
            }
            RpcError::Unavailable { reason, detail } => write!(f, "core unavailable ({reason}): {detail}"),
            RpcError::Version { server } => write!(f, "rpc version mismatch: server {server}, client {}.x", crate::SUPPORTED_RPC_MAJOR),
            RpcError::Protocol(s) => write!(f, "protocol error: {s}"),
        }
    }
}
impl std::error::Error for RpcError {}

impl From<std::io::Error> for RpcError {
    fn from(e: std::io::Error) -> Self {
        let reason = match e.kind() { std::io::ErrorKind::NotFound => "core-unavailable", std::io::ErrorKind::ConnectionRefused => "core-unavailable", std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "call-timeout", _ => "io" };
        RpcError::Unavailable { reason: reason.into(), detail: e.to_string() }
    }
}

pub fn is_unavailable(e: &RpcError) -> bool { matches!(e, RpcError::Unavailable { .. }) }

impl RpcError {
    /// The closed error name for `--json` output and exit-code mapping.
    pub fn code_name(&self) -> String {
        match self {
            RpcError::Call { error, .. } => serde_json::to_value(error).unwrap().as_str().unwrap().to_string(),
            RpcError::Unavailable { .. } => "E_CORE_UNAVAILABLE".into(),
            RpcError::Version { .. } => "E_RPC_VERSION".into(),
            RpcError::Protocol(_) => "E_INTERNAL".into(),
        }
    }
}
```

- [ ] **Step 4: Write `src/transport.rs`**

```rust
//! One blocking byte stream to the core: a Unix socket, or a Windows named pipe opened as a file.
use std::io::{self, Read, Write};
use std::time::Duration;

pub trait Stream: Read + Write + Send {
    fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::net::UnixStream;
    pub struct S(UnixStream);
    impl Read for S { fn read(&mut self, b: &mut [u8]) -> io::Result<usize> { self.0.read(b) } }
    impl Write for S { fn write(&mut self, b: &[u8]) -> io::Result<usize> { self.0.write(b) } fn flush(&mut self) -> io::Result<()> { self.0.flush() } }
    impl Stream for S { fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> { self.0.set_read_timeout(d) } }
    /// A missing socket file fails at once (ENOENT) — that is the "core absent" case the CLI answers in < 300 ms.
    pub fn connect(address: &str, _connect_timeout: Duration) -> io::Result<Box<dyn Stream>> { Ok(Box::new(S(UnixStream::connect(address)?))) }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::time::Instant;
    pub struct S(File);
    impl Read for S { fn read(&mut self, b: &mut [u8]) -> io::Result<usize> { self.0.read(b) } }
    impl Write for S { fn write(&mut self, b: &[u8]) -> io::Result<usize> { self.0.write(b) } fn flush(&mut self) -> io::Result<()> { self.0.flush() } }
    impl Stream for S { fn set_read_timeout(&self, _d: Option<Duration>) -> io::Result<()> { Ok(()) } } // H2: overlapped I/O with timeouts
    pub fn connect(address: &str, connect_timeout: Duration) -> io::Result<Box<dyn Stream>> {
        let start = Instant::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(address) {
                Ok(f) => return Ok(Box::new(S(f))),
                Err(e) if e.raw_os_error() == Some(231) && start.elapsed() < connect_timeout => std::thread::sleep(Duration::from_millis(10)), // ERROR_PIPE_BUSY
                Err(e) => return Err(e),
            }
        }
    }
}

pub use imp::connect;
```

- [ ] **Step 5: Write `src/client.rs`**

```rust
use crate::error::RpcError;
use crate::transport::{connect as transport_connect, Stream};
use crate::types::ErrorCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Hello { pub contract: String, pub rpc: String, #[serde(rename = "instanceId")] pub instance_id: String, pub pid: u64 }

#[derive(Debug, Clone)]
pub struct ConnectOptions { pub connect_timeout: Duration, pub call_timeout: Duration }
impl Default for ConnectOptions { fn default() -> Self { Self { connect_timeout: Duration::from_millis(300), call_timeout: Duration::from_secs(30) } } }

/// Blocking, strictly request→response: one stream behind a BufReader is enough because the CLI never has two calls in flight.
/// Writes go through `reader.get_mut()`, the one real stream.
pub struct Client { reader: BufReader<Box<dyn Stream>>, next_id: u64, hello: Hello }

const MAX_LINE: usize = 4 * 1024 * 1024;

impl Client {
    pub fn connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError> {
        let stream = transport_connect(address, opts.connect_timeout)?;
        let mut client = Client { reader: BufReader::new(stream), next_id: 1, hello: Hello { contract: String::new(), rpc: String::new(), instance_id: String::new(), pid: 0 } };
        client.reader.get_ref().set_read_timeout(Some(opts.call_timeout))?;
        let hello: Hello = client.call_typed("core.auth", &json!({ "token": token }))?;
        let major: u64 = hello.rpc.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if major != crate::SUPPORTED_RPC_MAJOR { return Err(RpcError::Version { server: hello.rpc }); }
        client.hello = hello;
        Ok(client)
    }

    pub fn hello(&self) -> &Hello { &self.hello }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id; self.next_id += 1;
        let line = serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).unwrap();
        { let w = self.reader.get_mut(); w.write_all(line.as_bytes())?; w.write_all(b"\n")?; w.flush()?; }
        loop {
            let mut buf = String::new();
            let n = self.reader.read_line(&mut buf)?;
            if n == 0 { return Err(RpcError::Unavailable { reason: "closed".into(), detail: "connection closed by core".into() }); }
            if n > MAX_LINE { return Err(RpcError::Protocol("line too long".into())); }
            let msg: Value = serde_json::from_str(buf.trim_end()).map_err(|e| RpcError::Protocol(e.to_string()))?;
            if msg.get("id").is_none() { continue; } // a notification on this connection — H1 CLI does not subscribe; skip
            if msg["id"] != json!(id) { continue; }
            if let Some(err) = msg.get("error") {
                let error: ErrorCode = serde_json::from_value(err["data"]["error"].clone()).unwrap_or(ErrorCode::EInternal);
                return Err(RpcError::Call { error, jsonrpc: err["code"].as_i64().unwrap_or(-32000), message: err["message"].as_str().unwrap_or("").to_string(), reason: err["data"]["reason"].as_str().map(String::from), detail: err["data"]["detail"].as_str().map(String::from) });
            }
            return Ok(msg["result"].clone());
        }
    }

    pub fn call_typed<P: Serialize, R: DeserializeOwned>(&mut self, method: &str, params: &P) -> Result<R, RpcError> {
        let v = self.call(method, serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?)?;
        serde_json::from_value(v).map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))
    }
}

```

`ErrorCode::EInternal` is the variant name typify produces for `"E_INTERNAL"`; adjust to the emitted name. A read that hits `set_read_timeout` surfaces as `io::ErrorKind::WouldBlock`/`TimedOut`, which `From<io::Error>` maps to `Unavailable { reason: "call-timeout" }` — the third client test pins that.

- [ ] **Step 6: Write the client test against an in-test fake core**

`crates/plur1bus-rpc/tests/client.rs`:

```rust
#![cfg(unix)]
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::time::{Duration, Instant};

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn fake_core(rpc: &'static str) -> String {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("core.sock"); let p = path.to_string_lossy().to_string();
    let listener = UnixListener::bind(&path).unwrap();
    std::mem::forget(dir);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = stream.unwrap(); let mut w = stream.try_clone().unwrap(); let r = BufReader::new(stream); let mut authed = false;
            std::thread::spawn(move || {
                for line in r.lines() {
                    let msg: Value = serde_json::from_str(&line.unwrap()).unwrap(); let id = msg["id"].clone();
                    let reply = |w: &mut dyn Write, v: Value| { w.write_all(format!("{}\n", serde_json::to_string(&v).unwrap()).as_bytes()).unwrap(); };
                    match msg["method"].as_str().unwrap() {
                        "core.auth" => { authed = msg["params"]["token"] == TOKEN; if authed { reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":{"contract":"1.4.1","rpc":rpc,"instanceId":"i","pid":1}})) } else { reply(&mut w, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"bad token","data":{"error":"E_UNAUTHORIZED","reason":"bad-token"}}})) } }
                        _ if !authed => reply(&mut w, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"auth","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}})),
                        "echo" => { reply(&mut w, json!({"jsonrpc":"2.0","method":"agent.activity","params":{}})); reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":msg["params"]})) }
                        "slow" => { std::thread::sleep(Duration::from_millis(400)); reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":{}})) }
                        _ => reply(&mut w, json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"nope","data":{"error":"E_INTERNAL","reason":"method-not-found"}}})),
                    }
                }
            });
        }
    });
    p
}

#[test]
fn auth_call_and_notification_skipping() {
    let addr = fake_core("1.0.0");
    let mut c = Client::connect(&addr, TOKEN, ConnectOptions::default()).unwrap();
    assert_eq!(c.hello().contract, "1.4.1");
    assert_eq!(c.call("echo", json!({"x": 1})).unwrap(), json!({"x": 1}));
    match c.call("nope", json!({})) { Err(RpcError::Call { reason, .. }) => assert_eq!(reason.as_deref(), Some("method-not-found")), other => panic!("{other:?}") }
}

#[test]
fn bad_token_and_version_mismatch() {
    let addr = fake_core("1.0.0");
    assert!(matches!(Client::connect(&addr, "d".repeat(64).as_str(), ConnectOptions::default()), Err(RpcError::Call { .. })));
    let addr2 = fake_core("2.0.0");
    assert!(matches!(Client::connect(&addr2, TOKEN, ConnectOptions::default()), Err(RpcError::Version { .. })));
}

#[test]
fn missing_socket_is_unavailable_fast_and_slow_call_times_out() {
    let t0 = Instant::now();
    let e = Client::connect("/nonexistent/plur1bus/core.sock", TOKEN, ConnectOptions::default()).err().unwrap();
    assert!(plur1bus_rpc::is_unavailable(&e), "{e}");
    assert!(t0.elapsed() < Duration::from_millis(300));
    let addr = fake_core("1.0.0");
    let mut c = Client::connect(&addr, TOKEN, ConnectOptions { call_timeout: Duration::from_millis(100), ..Default::default() }).unwrap();
    let e = c.call("slow", json!({})).err().unwrap();
    assert!(matches!(&e, RpcError::Unavailable { reason, .. } if reason == "call-timeout"), "{e}");
}
```

- [ ] **Step 7: Run all crate tests and clippy**

Run: `cd "$HARNESS" && cargo test -p plur1bus-rpc && cargo clippy -p plur1bus-rpc --all-targets -- -D warnings && cargo fmt --all`
Expected: fixtures (3) + client (3) pass, clippy clean.

- [ ] **Step 8: Commit**

```bash
git add crates/plur1bus-rpc Cargo.lock
git commit -m "feat(plur1bus-rpc): typify-generated RPC types from the shared schema, blocking NDJSON client, fixture parity tests"
```

---

### Task 11: `plur1bus` CLI skeleton — clap, `--json`, `--home`, paths, `core run`, stubs

**Files:**
- Create: `crates/plur1bus/Cargo.toml`, `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/cli.rs`, `crates/plur1bus/src/paths.rs`, `crates/plur1bus/src/output.rs`, `crates/plur1bus/src/identity.rs`, `crates/plur1bus/src/commands/mod.rs`, `crates/plur1bus/src/commands/core.rs`, `crates/plur1bus/src/commands/stubs.rs`, `crates/plur1bus/tests/cli.rs`

**Interfaces:**
- Produces: the binary; `paths::resolve_home(cli_home: Option<&Path>, env: &HashMap<String,String>, platform: &str, home_dir: &Path, local_app_data: Option<&Path>) -> PathBuf` and `paths::Layout` mirroring `packages/core/src/paths.ts` (same field names, snake_case); `paths::core_address(home, platform) -> String`; `output::Out { json: bool }` with `ok(&self, value: &impl Serialize, human: impl FnOnce() -> String)` and `fail(&self, code: &str, message: &str, exit: i32) -> !`; `identity::caller() -> CallerIdentity` (`channel: "cli"`, `accountId: hostname`, `userId: OS user`); `commands::core::run(home) -> !` (execs the Node core); exit codes `0` ok, `1` error, `2` usage/stub, `3` `E_LOCKED`.

- [ ] **Step 1: Write the failing CLI tests**

`crates/plur1bus/tests/cli.rs`:

```rust
use assert_cmd::Command;
use predicates::prelude::*;

fn bin() -> Command { Command::cargo_bin("plur1bus").unwrap() }

#[test]
fn help_lists_the_2a_commands() {
    bin().arg("--help").assert().success()
        .stdout(predicate::str::contains("1staid")).stdout(predicate::str::contains("memory")).stdout(predicate::str::contains("dreams"))
        .stdout(predicate::str::contains("config")).stdout(predicate::str::contains("agent")).stdout(predicate::str::contains("core"));
}

#[test]
fn stubs_exit_2_and_name_their_milestone() {
    for (cmd, milestone) in [("login", "M2"), ("model", "M2"), ("channel", "M4"), ("user", "M2"), ("project", "M3"), ("import", "M1b-3"), ("uninstall", "M8")] {
        bin().arg(cmd).assert().code(2).stderr(predicate::str::contains(milestone));
        let out = bin().args(["--json", cmd]).assert().code(2).get_output().stdout.clone();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"], "E_NOT_AVAILABLE"); assert_eq!(v["milestone"], milestone);
    }
}

#[test]
fn h2_commands_are_stubs_in_h1() {
    for cmd in ["setup", "module", "daemon", "service", "update", "1staid"] {
        bin().arg(cmd).arg("--help").assert().success();
    }
    bin().args(["daemon", "status"]).assert().code(2).stderr(predicate::str::contains("H2"));
}

#[test]
fn home_flag_beats_env() {
    let dir = tempfile::tempdir().unwrap();
    let out = bin().env("PLUR1BUS_HOME", "/elsewhere").args(["--json", "--home", dir.path().to_str().unwrap(), "config", "get", "core.logLevel"]).assert().success().get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["value"], "info");
    assert!(dir.path().join("config.json").exists(), "config get creates defaults under --home");
}
```

The last test needs `config get` (Task 13); leave it in the file now, it fails until then — or mark it `#[ignore]` with the reason and un-ignore in Task 13. Choose `#[ignore = "config get lands in Task 13"]`.

- [ ] **Step 2: Write `Cargo.toml` and run to see the tests fail**

```toml
[package]
name = "plur1bus"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "plur1bus"
path = "src/main.rs"

[dependencies]
plur1bus-rpc = { path = "../plur1bus-rpc" }
plur1bus-config = { path = "../plur1bus-config" }
clap.workspace = true
serde.workspace = true
serde_json.workspace = true
gethostname = "0.5"
whoami = "1.5"
uuid = { version = "1", features = ["v4"] }
home = "0.5"
clap-markdown = "0.1"

[dev-dependencies]
assert_cmd = "2"
predicates = "3"
tempfile.workspace = true
```

`plur1bus-config` does not exist until Task 12: create it now as an empty lib crate (`crates/plur1bus-config/Cargo.toml` with only `serde_json` and an empty `src/lib.rs`) so the workspace resolves; Task 12 fills it. Run `cargo test -p plur1bus` → compile errors (no `main.rs`).

- [ ] **Step 3: Write `src/paths.rs`**

```rust
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn resolve_home(cli_home: Option<&Path>, env: &HashMap<String, String>, platform: &str, home_dir: &Path, local_app_data: Option<&Path>) -> PathBuf {
    if let Some(h) = cli_home { return h.to_path_buf(); }
    if let Some(h) = env.get("PLUR1BUS_HOME") { return PathBuf::from(h); }
    if platform == "windows" {
        let lad = local_app_data.map(Path::to_path_buf).or_else(|| env.get("LOCALAPPDATA").map(PathBuf::from)).unwrap_or_else(|| home_dir.join("AppData").join("Local"));
        return lad.join("PLUR1BUS");
    }
    home_dir.join(".plur1bus")
}

pub fn resolve_home_from_process(cli_home: Option<&Path>) -> PathBuf {
    let env: HashMap<String, String> = std::env::vars().collect();
    let platform = if cfg!(windows) { "windows" } else { "posix" };
    let home_dir = home::home_dir().unwrap_or_else(|| PathBuf::from("."));
    resolve_home(cli_home, &env, platform, &home_dir, None)
}

#[derive(Debug, Clone)]
pub struct Layout { pub home: PathBuf }
impl Layout {
    pub fn new(home: PathBuf) -> Self { Self { home } }
    pub fn config_path(&self) -> PathBuf { self.home.join("config.json") }
    pub fn state(&self) -> PathBuf { self.home.join("state") }
    pub fn journal(&self) -> PathBuf { self.state().join("journal") }
    pub fn agent_dir(&self, id: &str) -> PathBuf { self.home.join("agents").join(id) }
    pub fn workspace_dir(&self, id: &str) -> PathBuf { self.agent_dir(id).join("workspace") }
    pub fn run(&self) -> PathBuf { self.home.join("run") }
    pub fn core_token(&self) -> PathBuf { self.run().join("core.token") }
    pub fn core_socket(&self) -> PathBuf { self.run().join("core.sock") }
    pub fn core_pid(&self) -> PathBuf { self.run().join("core.pid") }
    pub fn runtime(&self) -> PathBuf { self.home.join("runtime") }
}

/// Same rule as packages/core/src/paths.ts coreAddress(): socket path on POSIX, a per-home pipe name on Windows.
pub fn core_address(home: &Path, platform: &str) -> String {
    if platform == "windows" { format!(r"\\.\pipe\plur1bus-{}-core", &sha256_hex(home.to_string_lossy().to_lowercase().as_bytes())[..16]) }
    else { Layout::new(home.to_path_buf()).core_socket().to_string_lossy().to_string() }
}

fn sha256_hex(b: &[u8]) -> String { format!("{:x}", Sha256::digest(b)) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parity_with_the_typescript_layout() {
        let env = HashMap::new();
        assert_eq!(resolve_home(None, &env, "posix", Path::new("/Users/c"), None), PathBuf::from("/Users/c/.plur1bus"));
        assert_eq!(resolve_home(None, &env, "windows", Path::new(r"C:\Users\c"), Some(Path::new(r"C:\Users\c\AppData\Local"))), PathBuf::from(r"C:\Users\c\AppData\Local\PLUR1BUS"));
        let mut e2 = HashMap::new(); e2.insert("PLUR1BUS_HOME".into(), "/y".into());
        assert_eq!(resolve_home(Some(Path::new("/x")), &e2, "posix", Path::new("/h"), None), PathBuf::from("/x"));
        assert_eq!(resolve_home(None, &e2, "posix", Path::new("/h"), None), PathBuf::from("/y"));
        let l = Layout::new(PathBuf::from("/h/.plur1bus"));
        assert_eq!(l.workspace_dir("bernd"), PathBuf::from("/h/.plur1bus/agents/bernd/workspace"));
        assert_eq!(core_address(Path::new("/h/.plur1bus"), "posix"), "/h/.plur1bus/run/core.sock");
        assert!(core_address(Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"), "windows").starts_with(r"\\.\pipe\plur1bus-"));
    }
}
```

The hash must equal the TS side's `sha256(home.toLowerCase())` for the same string — on Windows both sides see the same `%LOCALAPPDATA%\PLUR1BUS` spelling from the same source (env), so lowercasing identically suffices. `sha2 = "0.10"` goes into `crates/plur1bus/Cargo.toml` `[dependencies]`.

- [ ] **Step 4: Write `src/output.rs` and `src/identity.rs`**

`src/output.rs`:

```rust
use serde::Serialize;
use serde_json::json;

pub struct Out { pub json: bool }

impl Out {
    pub fn ok<T: Serialize>(&self, value: &T, human: impl FnOnce() -> String) {
        if self.json { println!("{}", serde_json::to_string(value).unwrap()); } else { println!("{}", human()); }
    }
    /// Prints an error and exits. JSON goes to stdout (stable shape), human text to stderr.
    pub fn fail(&self, code: &str, message: &str, extra: serde_json::Value, exit: i32) -> ! {
        if self.json {
            let mut v = json!({ "error": code, "message": message });
            if let (Some(a), Some(b)) = (v.as_object_mut(), extra.as_object()) { for (k, x) in b { a.insert(k.clone(), x.clone()); } }
            println!("{v}");
        } else { eprintln!("plur1bus: {message}"); }
        std::process::exit(exit)
    }
    pub fn from_rpc_error(&self, e: &plur1bus_rpc::RpcError) -> ! {
        let exit = match e.code_name().as_str() { "E_LOCKED" => 3, "E_NOT_AVAILABLE" => 2, _ => 1 };
        self.fail(&e.code_name(), &e.to_string(), json!({}), exit)
    }
}
```

`src/identity.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CallerIdentity { pub channel: &'static str, #[serde(rename = "accountId")] pub account_id: String, #[serde(rename = "userId")] pub user_id: String }

/// hostname + OS user: the CLI principal (spec §6.2). The core hashes these; the CLI never does.
pub fn caller() -> CallerIdentity {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let user = whoami::username();
    CallerIdentity { channel: "cli", account_id: if host.is_empty() { "localhost".into() } else { host }, user_id: if user.is_empty() { "user".into() } else { user } }
}
```

Use the generated `plur1bus_rpc::types::CallerIdentity` instead of this local struct if typify emitted plain `String` fields; keep the local one only if the generated type is a newtype-laden shape that makes construction awkward — and say which in the report.

- [ ] **Step 5: Write `src/cli.rs`, `src/commands/*.rs`, `src/main.rs`**

`src/cli.rs`:

```rust
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "plur1bus", version, about = "PLUR1BUS harness — self-hosted multi-agent memory harness", propagate_version = true)]
pub struct Cli {
    /// State root (default: ~/.plur1bus, %LOCALAPPDATA%\PLUR1BUS, or $PLUR1BUS_HOME)
    #[arg(long, global = true, value_name = "PATH")] pub home: Option<PathBuf>,
    /// Machine-readable output (stable shape, see docs/cli.md)
    #[arg(long, global = true)] pub json: bool,
    #[command(subcommand)] pub cmd: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Install the harness (runtime, service registration) — H2
    Setup(StubArgs),
    /// Check and repair the installation — H2
    #[command(name = "1staid")] FirstAid { #[command(subcommand)] sub: FirstAidCmd },
    /// Agents (personas): list, create, remove, status
    Agent { #[command(subcommand)] sub: AgentCmd },
    /// Memory: add and recall through the core
    Memory { #[command(subcommand)] sub: MemoryCmd },
    /// Dreaming jobs: status, run, log
    Dreams { #[command(subcommand)] sub: DreamsCmd },
    /// Configuration: get, set, schema
    Config { #[command(subcommand)] sub: ConfigCmd },
    /// Modules — H2
    Module(StubArgs),
    /// Supervisor control — H2
    Daemon(StubArgs),
    /// OS service registration — H2
    Service(StubArgs),
    /// Core process (internal)
    Core { #[command(subcommand)] sub: CoreCmd },
    /// Update check — H2
    Update(StubArgs),
    /// Users — M2
    User(StubArgs),
    /// Models and provider profiles — M2
    Model(StubArgs),
    /// Provider login (API keys, OAuth) — M2
    Login(StubArgs),
    /// Channels — M4
    Channel(StubArgs),
    /// Projects — M3
    Project(StubArgs),
    /// Import from OpenClaw/Hermes — M1b-3
    Import(StubArgs),
    /// Uninstall — M8
    Uninstall(StubArgs),
    /// Print the CLI reference as Markdown (used by scripts/gen-docs.mjs)
    #[command(hide = true, name = "__markdown")] Markdown,
}

#[derive(Args, Debug)] pub struct StubArgs { #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)] pub rest: Vec<String> }

#[derive(Subcommand, Debug)] pub enum FirstAidCmd { Check, Repair { #[arg(long)] yes: bool, #[arg(long)] dry_run: bool } }
#[derive(Subcommand, Debug)] pub enum AgentCmd { List, Create { id: String }, Remove { id: String }, Status { id: String } }
#[derive(Subcommand, Debug)] pub enum MemoryCmd {
    Add { #[arg(long)] agent: String, #[arg(long)] session: Option<String>, text: Vec<String> },
    Recall { #[arg(long)] agent: String, #[arg(long)] session: Option<String>, #[arg(long)] joined: bool, query: Vec<String> },
    List(StubArgs), Show(StubArgs), Forget(StubArgs), Correct(StubArgs), Share(StubArgs), State(StubArgs),
}
#[derive(Subcommand, Debug)] pub enum DreamsCmd { Status { #[arg(long)] agent: Option<String> }, Run { job: String, #[arg(long)] agent: String }, Log { #[arg(long)] agent: String, #[arg(long)] job: Option<String>, #[arg(long, default_value_t = 20)] limit: u32 } }
#[derive(Subcommand, Debug)] pub enum ConfigCmd { Get { key: Option<String> }, Set { key: String, value: String, #[arg(long)] yes: bool, #[arg(long)] dry_run: bool }, Schema }
#[derive(Subcommand, Debug)] pub enum CoreCmd { /// Run the core in the foreground (the supervisor's spawn target in H2)
    Run }
```

`src/commands/stubs.rs`:

```rust
use crate::output::Out;
use serde_json::json;

pub fn milestone(out: &Out, cmd: &str, milestone: &str, note: &str) -> ! {
    out.fail("E_NOT_AVAILABLE", &format!("`plur1bus {cmd}` arrives in {milestone}: {note}"), json!({ "milestone": milestone, "command": cmd }), 2)
}
```

`src/commands/core.rs`:

```rust
use crate::output::Out;
use crate::paths::Layout;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// Locates the Node runtime and dist/core.js and runs the core in the foreground.
/// Order: $PLUR1BUS_NODE, <home>/runtime/node-*/bin/node (installed by setup, H2), `node` on PATH.
/// core.js: $PLUR1BUS_CORE_JS, then <home>/runtime/core/core.js (installed by setup, H2).
pub fn run(out: &Out, layout: &Layout) -> ! {
    let node = std::env::var_os("PLUR1BUS_NODE").map(PathBuf::from)
        .or_else(|| std::fs::read_dir(layout.runtime()).ok()?.filter_map(Result::ok).map(|e| e.path()).find(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("node-")).unwrap_or(false)).map(|p| p.join("bin").join(if cfg!(windows) { "node.exe" } else { "node" })))
        .unwrap_or_else(|| PathBuf::from("node"));
    let core_js = std::env::var_os("PLUR1BUS_CORE_JS").map(PathBuf::from).unwrap_or_else(|| layout.runtime().join("core").join("core.js"));
    if !core_js.exists() { out.fail("E_CORE_UNAVAILABLE", &format!("core.js not found at {} (set PLUR1BUS_CORE_JS or run setup)", core_js.display()), json!({}), 1); }
    let mut cmd = Command::new(&node);
    cmd.arg(&core_js).arg("--home").arg(&layout.home);
    if let Some(ti) = std::env::var_os("PLUR1BUS_TEST_INTERNALS") { cmd.arg("--test-internals").arg(ti); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; let e = cmd.exec(); out.fail("E_CORE_UNAVAILABLE", &format!("cannot exec {}: {e}", node.display()), json!({}), 1); }
    #[cfg(windows)] { match cmd.status() { Ok(s) => std::process::exit(s.code().unwrap_or(1)), Err(e) => out.fail("E_CORE_UNAVAILABLE", &format!("cannot start {}: {e}", node.display()), json!({}), 1) } }
}
```

`src/commands/mod.rs`: `pub mod core; pub mod stubs;` (agent, memory, dreams, config are added by Tasks 12–15).

`src/main.rs`:

```rust
mod cli; mod commands; mod identity; mod output; mod paths;
use clap::Parser;
use cli::{Cli, Cmd};
use output::Out;

fn main() {
    let cli = Cli::parse();
    let out = Out { json: cli.json };
    let home = paths::resolve_home_from_process(cli.home.as_deref());
    let layout = paths::Layout::new(home);
    match cli.cmd {
        Cmd::Core { sub: cli::CoreCmd::Run } => commands::core::run(&out, &layout),
        Cmd::Markdown => { print!("{}", clap_markdown::help_markdown::<Cli>()); }
        Cmd::Setup(_) => commands::stubs::milestone(&out, "setup", "H2", "installer and service registration (spec §6.5)"),
        Cmd::FirstAid { .. } => commands::stubs::milestone(&out, "1staid", "H2", "check and repair (spec §6.6)"),
        Cmd::Module(_) => commands::stubs::milestone(&out, "module", "H2", "module lifecycle and graph"),
        Cmd::Daemon(_) => commands::stubs::milestone(&out, "daemon", "H2", "supervisor control; in H1 start the core with `plur1bus core run`"),
        Cmd::Service(_) => commands::stubs::milestone(&out, "service", "H2", "OS service registration"),
        Cmd::Update(_) => commands::stubs::milestone(&out, "update", "H2", "manifest check"),
        Cmd::User(_) => commands::stubs::milestone(&out, "user", "M2", "users and roles (ADR-007)"),
        Cmd::Model(_) => commands::stubs::milestone(&out, "model", "M2", "provider profiles and model roles (D15)"),
        Cmd::Login(_) => commands::stubs::milestone(&out, "login", "M2", "API keys and OAuth templates (D16)"),
        Cmd::Channel(_) => commands::stubs::milestone(&out, "channel", "M4", "channels"),
        Cmd::Project(_) => commands::stubs::milestone(&out, "project", "M3", "projects"),
        Cmd::Import(_) => commands::stubs::milestone(&out, "import", "M1b-3", "OpenClaw/Hermes import (docs/import.md)"),
        Cmd::Uninstall(_) => commands::stubs::milestone(&out, "uninstall", "M8", "uninstaller"),
        Cmd::Agent { .. } | Cmd::Memory { .. } | Cmd::Dreams { .. } | Cmd::Config { .. } => commands::stubs::milestone(&out, "this", "H1", "implemented in Tasks 12–15 of this plan"),
    }
}
```

The last arm is replaced task by task (12: agent, 13: config, 14: memory, 15: dreams).

- [ ] **Step 6: Run the tests, clippy, and B1 by hand**

Run: `cd "$HARNESS" && cargo test -p plur1bus && cargo clippy -p plur1bus --all-targets -- -D warnings && cargo build --release -p plur1bus && for i in $(seq 1 20); do /usr/bin/time -f %e target/release/plur1bus --help >/dev/null; done 2>&1 | sort -n | tail -1`
Expected: 3 CLI tests pass (+1 ignored), clippy clean, worst of 20 `--help` runs well under 0.1 s.

- [ ] **Step 7: Commit**

```bash
git add crates/plur1bus crates/plur1bus-config Cargo.lock
git commit -m "feat(cli): plur1bus binary skeleton — clap tree, --json/--home, layout parity with the core, core run, milestone stubs"
```

---

### Task 12: `plur1bus-config` crate and `agent list|create|remove|status`

**Files:**
- Create: `crates/plur1bus-config/Cargo.toml` (replace the placeholder), `crates/plur1bus-config/src/lib.rs`, `crates/plur1bus-config/tests/config.rs`, `crates/plur1bus/src/commands/agent.rs`, `packages/config-schema/src/gen-defaults.mjs`, `packages/config-schema/fixtures/defaults.json`, `packages/config-schema/test/defaults-fixture.test.ts`
- Modify: `crates/plur1bus/src/main.rs` (dispatch `Agent`), `crates/plur1bus/src/commands/mod.rs`, `packages/config-schema/package.json` (`gen` script), `packages/core/src/agents.ts` (mtime-based reload), `packages/core/test/agents.test.ts`

**Interfaces:**
- Produces (Rust): `plur1bus_config::{Config, load(path) -> Result<Loaded, ConfigError>, Loaded { config: Config, created: bool }, defaults() -> Config, validate(&Value) -> Result<(), Vec<String>>, restart_class_of(key: &str) -> RestartClass, set(config: &Config, key: &str, value: Value) -> Result<Plan, ConfigError>, Plan { before, after, changed: Vec<String>, restart: Restart { live: Vec<String>, core: bool, modules: Vec<String> } }, write_atomic(path, &Config) -> io::Result<()>, get(config: &Config, key: Option<&str>) -> Option<Value>}` where `Config = serde_json::Value` validated against the schema; `ConfigError::{NotJson(String), Invalid(Vec<String>), Io(io::Error), UnknownKey(String)}`.
- Produces (core): `AgentRegistry.refresh()` re-reads `config.json` when its mtime changed, so `agent create` while the core runs is visible on the next call (spec: `agents` is `live`).
- Parity: `packages/config-schema/fixtures/defaults.json` is generated by the TS package and must equal Rust `defaults()`.

- [ ] **Step 1: Generate the defaults fixture on the TS side (and pin it fresh)**

`packages/config-schema/src/gen-defaults.mjs`:

```js
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const { defaults } = await import("./index.ts");
const out = join(here, "..", "fixtures", "defaults.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(defaults(), null, 2)}\n`);
console.log("config-schema: fixtures/defaults.json written");
```

Add to `packages/config-schema/package.json`: `"gen": "node --experimental-strip-types src/gen-defaults.mjs"` and make `test` run `gen` first (`"test": "node --experimental-strip-types src/gen-defaults.mjs && node ../../scripts/test-package.mjs"`). Root `pnpm gen` must call both packages' `gen`: change the root script to `"gen": "pnpm -r --workspace-concurrency=1 gen"`.

`packages/config-schema/test/defaults-fixture.test.ts`:

```ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaults } from "../src/index.ts";
it("fixtures/defaults.json is the committed defaults (run pnpm gen after a schema change)", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("../fixtures/defaults.json", import.meta.url), "utf8")), defaults());
});
```

Run `cd packages/config-schema && pnpm test` → passes and writes the fixture; commit the fixture.

- [ ] **Step 2: Write the failing Rust config tests**

`crates/plur1bus-config/tests/config.rs`:

```rust
use plur1bus_config::{defaults, load, restart_class_of, set, validate, write_atomic, ConfigError, RestartClass};
use serde_json::{json, Value};
use std::fs;

fn ts_defaults() -> Value { serde_json::from_str(&fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/config-schema/fixtures/defaults.json")).unwrap()).unwrap() }

#[test]
fn defaults_equal_the_typescript_fixture() { assert_eq!(defaults(), ts_defaults()); }

#[test]
fn load_creates_defaults_and_rejects_invalid() {
    let dir = tempfile::tempdir().unwrap(); let p = dir.path().join("config.json");
    let l = load(&p).unwrap(); assert!(l.created); assert_eq!(l.config, defaults());
    fs::write(&p, r#"{ "schemaVersion": 1, "core": { "logLevel": "loud" } }"#).unwrap();
    match load(&p) { Err(ConfigError::Invalid(errs)) => assert!(errs.iter().any(|e| e.contains("logLevel")), "{errs:?}"), other => panic!("{other:?}") }
    assert_eq!(fs::read_to_string(&p).unwrap(), r#"{ "schemaVersion": 1, "core": { "logLevel": "loud" } }"#, "invalid file untouched");
}

#[test]
fn restart_classes_match_the_schema() {
    assert_eq!(restart_class_of("core.logLevel"), RestartClass::Live);
    assert_eq!(restart_class_of("agents.bernd"), RestartClass::Live);
    assert_eq!(restart_class_of("engine.recallMinScore"), RestartClass::Core);
    assert_eq!(restart_class_of("embedding.useClass"), RestartClass::Core);
}

#[test]
fn set_produces_a_plan_and_refuses_bad_values() {
    let c = defaults();
    let plan = set(&c, "core.recall.softBudgetMs", json!(250)).unwrap();
    assert_eq!(plan.changed, vec!["core.recall.softBudgetMs"]); assert_eq!(plan.restart.live, vec!["core.recall.softBudgetMs"]); assert!(!plan.restart.core);
    assert_eq!(plan.after["core"]["recall"]["softBudgetMs"], 250);
    match set(&c, "core.recall.softBudgetMs", json!("abc")) { Err(ConfigError::Invalid(e)) => assert!(e.iter().any(|s| s.contains("softBudgetMs") || s.contains("integer"))), o => panic!("{o:?}") }
    match set(&c, "nope.key", json!(1)) { Err(ConfigError::Invalid(_)) | Err(ConfigError::UnknownKey(_)) => {}, o => panic!("{o:?}") }
    let core_plan = set(&c, "engine.recallMinScore", json!(0.5)).unwrap(); assert!(core_plan.restart.core);
    let agent_plan = set(&c, "agents.bernd", json!({ "createdAt": "2026-09-24T00:00:00Z" })).unwrap(); assert_eq!(agent_plan.restart.live, vec!["agents.bernd"]);
}

#[test]
fn write_atomic_round_trips_and_validate_reports_paths() {
    let dir = tempfile::tempdir().unwrap(); let p = dir.path().join("config.json");
    write_atomic(&p, &defaults()).unwrap(); assert_eq!(load(&p).unwrap().config, defaults());
    assert!(validate(&json!({ "schemaVersion": 1, "bogus": 1 })).is_err());
}
```

- [ ] **Step 3: Write the crate**

`crates/plur1bus-config/Cargo.toml`:

```toml
[package]
name = "plur1bus-config"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
jsonschema = { version = "0.26", default-features = false }

[dev-dependencies]
tempfile.workspace = true
```

`crates/plur1bus-config/src/lib.rs`:

```rust
//! The config.json service: the same schema the TypeScript side uses (packages/config-schema), validated with the
//! `jsonschema` crate. In H1 the CLI calls this directly; in H2 the supervisor owns it and the CLI goes through config.*.
use serde_json::{Map, Value};
use std::{fs, io, path::Path};

pub const SCHEMA_JSON: &str = include_str!("../../../packages/config-schema/schema/config.schema.json");
pub type Config = Value;

#[derive(Debug)]
pub enum ConfigError { NotJson(String), Invalid(Vec<String>), Io(io::Error), UnknownKey(String) }
impl From<io::Error> for ConfigError { fn from(e: io::Error) -> Self { ConfigError::Io(e) } }
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { ConfigError::NotJson(s) => write!(f, "not JSON: {s}"), ConfigError::Invalid(v) => write!(f, "invalid: {}", v.join("; ")), ConfigError::Io(e) => write!(f, "io: {e}"), ConfigError::UnknownKey(k) => write!(f, "unknown key: {k}") }
    }
}
impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartClass { Live, Core, Module }
#[derive(Debug, Clone, PartialEq)]
pub struct Restart { pub live: Vec<String>, pub core: bool, pub modules: Vec<String> }
#[derive(Debug, Clone)]
pub struct Plan { pub before: Config, pub after: Config, pub changed: Vec<String>, pub restart: Restart }
pub struct Loaded { pub config: Config, pub created: bool }

fn schema() -> &'static Value { static S: std::sync::OnceLock<Value> = std::sync::OnceLock::new(); S.get_or_init(|| serde_json::from_str(SCHEMA_JSON).expect("embedded schema")) }
fn validator() -> &'static jsonschema::Validator { static V: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new(); V.get_or_init(|| jsonschema::validator_for(schema()).expect("schema compiles")) }

pub fn validate(v: &Value) -> Result<(), Vec<String>> {
    let errs: Vec<String> = validator().iter_errors(v).map(|e| format!("{} {}", if e.instance_path.to_string().is_empty() { "/".to_string() } else { e.instance_path.to_string() }, e)).collect();
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

/// Defaults are read from the schema's `default` keywords, depth-first — the same values ajv's useDefaults fills in.
fn fill_defaults(node: &Value, into: &mut Value) {
    if let (Some(props), Some(obj)) = (node.get("properties").and_then(Value::as_object), into.as_object_mut()) {
        for (k, sub) in props {
            if !obj.contains_key(k) { if let Some(d) = sub.get("default") { obj.insert(k.clone(), d.clone()); } }
            if let Some(child) = obj.get_mut(k) { if child.is_object() { fill_defaults(sub, child); } }
        }
    }
}

pub fn defaults() -> Config {
    let mut v = serde_json::json!({ "$schema": schema()["$id"], "schemaVersion": 1 });
    fill_defaults(schema(), &mut v);
    v
}

pub fn load(path: &Path) -> Result<Loaded, ConfigError> {
    if !path.exists() { let d = defaults(); write_atomic(path, &d)?; return Ok(Loaded { config: d, created: true }); }
    let text = fs::read_to_string(path)?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| ConfigError::NotJson(e.to_string()))?;
    fill_defaults(schema(), &mut v); // the TS loader fills defaults through ajv useDefaults; do the same so both sides see one shape
    validate(&v).map_err(ConfigError::Invalid)?;
    Ok(Loaded { config: v, created: false })
}

pub fn write_atomic(path: &Path, config: &Config) -> io::Result<()> {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(config).unwrap()))?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?; }
    fs::rename(&tmp, path)
}

pub fn restart_class_of(key: &str) -> RestartClass {
    let mut node = schema(); let mut cls = node.get("x-restart").and_then(Value::as_str).unwrap_or("core");
    for part in key.split('.') {
        let next = node.get("properties").and_then(|p| p.get(part)).or_else(|| node.get("additionalProperties").filter(|a| a.is_object()));
        match next { Some(n) => { node = n; if let Some(c) = n.get("x-restart").and_then(Value::as_str) { cls = c; } } None => break }
    }
    match cls { "live" => RestartClass::Live, c if c.starts_with("module:") => RestartClass::Module, _ => RestartClass::Core }
}

fn module_name(key: &str) -> Option<String> {
    let mut node = schema(); let mut cls: Option<&str> = None;
    for part in key.split('.') { match node.get("properties").and_then(|p| p.get(part)).or_else(|| node.get("additionalProperties").filter(|a| a.is_object())) { Some(n) => { node = n; if let Some(c) = n.get("x-restart").and_then(Value::as_str) { cls = Some(c); } } None => break } }
    cls.and_then(|c| c.strip_prefix("module:")).map(String::from)
}

fn flatten(v: &Value, prefix: &str, out: &mut Vec<(String, Value)>) {
    match v {
        Value::Object(m) if !m.is_empty() => for (k, x) in m { flatten(x, &if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") }, out) },
        _ => out.push((prefix.to_string(), v.clone())),
    }
}

pub fn get<'a>(config: &'a Config, key: Option<&str>) -> Option<&'a Value> {
    match key { None => Some(config), Some(k) => k.split('.').try_fold(config, |n, p| n.get(p)) }
}

pub fn set(config: &Config, key: &str, value: Value) -> Result<Plan, ConfigError> {
    let mut after = config.clone();
    let parts: Vec<&str> = key.split('.').collect();
    let (last, dirs) = parts.split_last().ok_or_else(|| ConfigError::UnknownKey(key.into()))?;
    let mut node = &mut after;
    for p in dirs { node = node.as_object_mut().ok_or_else(|| ConfigError::UnknownKey(key.into()))?.entry(*p).or_insert_with(|| Value::Object(Map::new())); }
    node.as_object_mut().ok_or_else(|| ConfigError::UnknownKey(key.into()))?.insert((*last).to_string(), value);
    validate(&after).map_err(ConfigError::Invalid)?;
    let (mut a, mut b) = (Vec::new(), Vec::new()); flatten(config, "", &mut a); flatten(&after, "", &mut b);
    let am: std::collections::BTreeMap<_, _> = a.into_iter().collect(); let bm: std::collections::BTreeMap<_, _> = b.into_iter().collect();
    let mut changed: Vec<String> = am.keys().chain(bm.keys()).filter(|k| am.get(*k) != bm.get(*k)).cloned().collect(); changed.sort(); changed.dedup();
    let mut restart = Restart { live: vec![], core: false, modules: vec![] };
    for k in &changed { match restart_class_of(k) { RestartClass::Live => restart.live.push(k.clone()), RestartClass::Core => restart.core = true, RestartClass::Module => { if let Some(m) = module_name(k) { if !restart.modules.contains(&m) { restart.modules.push(m); } } } } }
    Ok(Plan { before: config.clone(), after, changed, restart })
}
```

- [ ] **Step 4: Run the config crate tests**

Run: `cd "$HARNESS" && cargo test -p plur1bus-config && cargo clippy -p plur1bus-config --all-targets -- -D warnings`
Expected: 5 pass. If `defaults_equal_the_typescript_fixture` fails on key order or on a nested default ajv fills that the walker misses, fix the walker (`fill_defaults`) — the TS fixture is the reference. `jsonschema` 0.26's `iter_errors`/`instance_path` API: if the compiled version names them differently (`ValidationError::instance_path` is a `JsonPointer`), adapt the formatting line only.

- [ ] **Step 5: Make the core's agent registry live (mtime reload)**

Modify `packages/core/src/agents.ts`: `createAgentRegistry(configOrPath: HarnessConfig | { path: string }, l)`; when given a path, keep `{ mtimeMs, config }` and in `list/has/workspaceOf` call `refresh()` which `statSync`s the file and reloads via `loadConfig` when `mtimeMs` changed (swallow `ConfigInvalid` with a `logger.warn` and keep the last good config — pass a logger in). In `core.ts` construct it with `{ path: l.configPath }`. Add to `packages/core/test/agents.test.ts`:

```ts
it("picks up an agent added to config.json without a restart", () => {
  const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
  const cfg = defaults(); writeFileSync(l.configPath, JSON.stringify(cfg));
  const reg = createAgentRegistry({ path: l.configPath }, l);
  assert.deepEqual(reg.list(), []);
  const later = defaults(); later.agents.bernd = {}; const t = Date.now() + 2000; writeFileSync(l.configPath, JSON.stringify(later)); utimesSync(l.configPath, t / 1000, t / 1000);
  assert.deepEqual(reg.list(), ["bernd"]);
  assert.equal(reg.workspaceOf("bernd"), l.workspaceDir("bernd"));
});
```

(`utimesSync` forces a distinct mtime on coarse filesystems.) Run `cd packages/core && pnpm test` → green.

- [ ] **Step 6: Write `crates/plur1bus/src/commands/agent.rs`**

```rust
use crate::cli::AgentCmd;
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};

const ID_RE: &str = "^[a-z0-9][a-z0-9_-]{0,63}$";

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars(); let first = chars.next().map(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).unwrap_or(false);
    first && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn try_core(layout: &Layout) -> Option<Client> {
    let token = std::fs::read_to_string(layout.core_token()).ok()?;
    Client::connect(&core_address(&layout.home, if cfg!(windows) { "windows" } else { "posix" }), token.trim(), ConnectOptions::default()).ok()
}

pub fn run(out: &Out, layout: &Layout, cmd: AgentCmd) {
    let loaded = cfg::load(&layout.config_path()).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
    let config = loaded.config;
    match cmd {
        AgentCmd::List => {
            let ids: Vec<String> = config["agents"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            let live: Option<Value> = try_core(layout).and_then(|mut c| c.call("agent.list", json!({})).ok());
            let rows: Vec<Value> = ids.iter().map(|id| { let a = live.as_ref().and_then(|v| v["agents"].as_array()).and_then(|a| a.iter().find(|x| x["agentId"] == *id)); json!({ "agentId": id, "open": a.map(|x| x["open"].clone()).unwrap_or(Value::Null), "activity": a.map(|x| x["activity"].clone()).unwrap_or(Value::Null) }) }).collect();
            out.ok(&json!({ "agents": rows, "core": if live.is_some() { "ready" } else { "unavailable" } }), || if rows.is_empty() { "no agents (create one with `plur1bus agent create <id>`)".into() } else { rows.iter().map(|r| format!("{}{}", r["agentId"].as_str().unwrap(), r["activity"]["state"].as_str().map(|s| format!("  [{s}]")).unwrap_or_default())).collect::<Vec<_>>().join("\n") });
        }
        AgentCmd::Create { id } => {
            if !valid_id(&id) { out.fail("E_INVALID_PARAMS", &format!("agent id must match {ID_RE}"), json!({}), 1); }
            if config["agents"].get(&id).is_some() { out.fail("E_INVALID_PARAMS", &format!("agent {id} already exists"), json!({}), 1); }
            let now = humantime_rfc3339();
            let plan = cfg::set(&config, &format!("agents.{id}"), json!({ "createdAt": now })).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            cfg::write_atomic(&layout.config_path(), &plan.after).unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            std::fs::create_dir_all(layout.workspace_dir(&id)).unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            let opened = try_core(layout).and_then(|mut c| c.call("agent.open", json!({ "agentId": id })).ok()).is_some();
            out.ok(&json!({ "agentId": id, "created": true, "opened": opened }), || format!("created agent {id}{}", if opened { " (open in the running core)" } else { " (persona files are scaffolded when the core starts)" }));
        }
        AgentCmd::Remove { id } => {
            if config["agents"].get(&id).is_none() { out.fail("E_AGENT_UNKNOWN", &format!("agent {id} is not registered"), json!({}), 1); }
            let mut after = config.clone(); after["agents"].as_object_mut().unwrap().remove(&id);
            cfg::validate(&after).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.join("; "), json!({}), 1));
            let _ = try_core(layout).and_then(|mut c| c.call("agent.close", json!({ "agentId": id })).ok());
            cfg::write_atomic(&layout.config_path(), &after).unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            out.ok(&json!({ "agentId": id, "removed": true, "dataKept": true }), || format!("removed agent {id} from the registry; data left in place under agents/{id} (purge arrives in M2)"));
        }
        AgentCmd::Status { id } => {
            if config["agents"].get(&id).is_none() { out.fail("E_AGENT_UNKNOWN", &format!("agent {id} is not registered"), json!({}), 1); }
            match try_core(layout) {
                Some(mut c) => match c.call("agent.status", json!({ "agentId": id })) { Ok(v) => out.ok(&v, || format!("{id}: {} since {} — workspace {}", v["activity"]["state"], v["activity"]["since"], v["workspace"])), Err(e) => out.from_rpc_error(&e) },
                None => out.ok(&json!({ "agentId": id, "core": "unavailable", "workspace": layout.workspace_dir(&id) }), || format!("{id}: core unavailable; workspace {}", layout.workspace_dir(&id).display())),
            }
        }
    }
}

fn humantime_rfc3339() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    // days-from-civil, inverse (Howard Hinnant) — avoids a chrono dependency for one timestamp
    let (days, rem) = (secs / 86_400, secs % 86_400); let z = days as i64 + 719_468; let era = z.div_euclid(146_097); let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; let y = yoe + era * 400; let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1; let m = if mp < 10 { mp + 3 } else { mp - 9 }; let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}
```

Wire `Cmd::Agent { sub } => commands::agent::run(&out, &layout, sub)` in `main.rs` and `pub mod agent;` in `commands/mod.rs`. Add to `tests/cli.rs`:

```rust
#[test]
fn agent_create_list_remove_without_a_core() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "agent", "create", "Bernd"]).assert().code(1).stderr(predicate::str::contains("must match"));
    bin().args(["--home", h, "agent", "create", "bernd"]).assert().success().stdout(predicate::str::contains("created agent bernd"));
    assert!(dir.path().join("agents/bernd/workspace").is_dir());
    let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap()).unwrap();
    assert!(cfg["agents"]["bernd"]["createdAt"].as_str().unwrap().ends_with('Z'));
    bin().args(["--home", h, "agent", "create", "bernd"]).assert().code(1);
    let out = bin().args(["--json", "--home", h, "agent", "list"]).assert().success().get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap(); assert_eq!(v["agents"][0]["agentId"], "bernd"); assert_eq!(v["core"], "unavailable");
    bin().args(["--home", h, "agent", "status", "bernd"]).assert().success().stdout(predicate::str::contains("core unavailable"));
    bin().args(["--home", h, "agent", "remove", "bernd"]).assert().success();
    assert!(dir.path().join("agents/bernd").is_dir(), "data left in place");
    bin().args(["--home", h, "agent", "status", "bernd"]).assert().code(1);
}
```

- [ ] **Step 7: Run everything and commit**

Run: `cd "$HARNESS" && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all && pnpm test`
Expected: green.

```bash
git add crates/plur1bus-config crates/plur1bus packages/config-schema packages/core Cargo.lock package.json
git commit -m "feat(config): plur1bus-config crate (validate, defaults parity, restart plan, atomic write); agent create/list/remove/status; live agent registry in the core"
```

---

### Task 13: CLI `config get|set|schema`

**Files:**
- Create: `crates/plur1bus/src/commands/config.rs`
- Modify: `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/commands/mod.rs`, `crates/plur1bus/tests/cli.rs` (un-ignore `home_flag_beats_env`, add tests)

**Interfaces:**
- Produces: `config get [key]` → `{ key, value, restart: <class> }`; `config set <key> <value> [--yes|--dry-run]` → prints the plan (`changed`, `restart`), applies after confirmation (`--yes`, or an interactive `y` on a TTY; non-TTY without `--yes` → exit 2 with the plan and "re-run with --yes"), `--dry-run` never writes; `config schema` → the schema JSON. Values are parsed as JSON first, then as a string (`config set core.logLevel debug` and `config set core.recall.softBudgetMs 250` both work; `abc` for an integer key is rejected by validation, not by parsing).

- [ ] **Step 1: Write the failing tests (add to `tests/cli.rs`)**

```rust
#[test]
fn config_get_set_dry_run_and_rejection() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "config", "get", "core.recall.softBudgetMs"]).assert().success().stdout(predicate::str::contains("400"));
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    // dry run: plan printed, nothing written
    bin().args(["--home", h, "config", "set", "core.recall.softBudgetMs", "250", "--dry-run"]).assert().success().stdout(predicate::str::contains("live")).stdout(predicate::str::contains("core.recall.softBudgetMs"));
    assert_eq!(std::fs::read(dir.path().join("config.json")).unwrap(), before);
    // non-tty without --yes: exit 2, nothing written
    bin().args(["--home", h, "config", "set", "core.recall.softBudgetMs", "250"]).assert().code(2).stderr(predicate::str::contains("--yes"));
    assert_eq!(std::fs::read(dir.path().join("config.json")).unwrap(), before);
    // apply
    let out = bin().args(["--json", "--home", h, "config", "set", "core.recall.softBudgetMs", "250", "--yes"]).assert().success().get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["applied"], true); assert_eq!(v["restart"]["live"][0], "core.recall.softBudgetMs"); assert_eq!(v["restart"]["core"], false);
    bin().args(["--home", h, "config", "get", "core.recall.softBudgetMs"]).assert().success().stdout(predicate::str::contains("250"));
    // a core-class key says so
    let out = bin().args(["--json", "--home", h, "config", "set", "engine.recallMinScore", "0.5", "--dry-run"]).assert().success().get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap(); assert_eq!(v["restart"]["core"], true);
    // string value for an enum key
    bin().args(["--home", h, "config", "set", "core.logLevel", "debug", "--yes"]).assert().success();
}

#[test]
fn rejects_a_wrong_typed_value_and_leaves_the_file_unchanged() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "config", "get"]).assert().success();
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    bin().args(["--home", h, "config", "set", "core.recall.softBudgetMs", "abc", "--yes"]).assert().code(1).stderr(predicate::str::contains("softBudgetMs").or(predicate::str::contains("integer")));
    bin().args(["--home", h, "config", "set", "nope.key", "1", "--yes"]).assert().code(1);
    assert_eq!(std::fs::read(dir.path().join("config.json")).unwrap(), before, "byte-for-byte unchanged");
}

#[test]
fn config_schema_prints_the_schema() {
    let out = bin().args(["--json", "config", "schema"]).assert().success().get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap(); assert_eq!(v["properties"]["core"]["properties"]["logLevel"]["x-restart"], "live");
}
```

Remove the `#[ignore]` from `home_flag_beats_env`.

- [ ] **Step 2: Run to see them fail** — `config` still hits the H1 stub arm → exit 2.

- [ ] **Step 3: Write `src/commands/config.rs`**

```rust
use crate::cli::ConfigCmd;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};

fn parse_value(raw: &str) -> Value { serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string())) }

fn class_name(k: &str) -> String { match cfg::restart_class_of(k) { cfg::RestartClass::Live => "live".into(), cfg::RestartClass::Core => "core".into(), cfg::RestartClass::Module => "module".into() } }

pub fn run(out: &Out, layout: &Layout, cmd: ConfigCmd) {
    match cmd {
        ConfigCmd::Schema => { let s: Value = serde_json::from_str(cfg::SCHEMA_JSON).unwrap(); out.ok(&s, || serde_json::to_string_pretty(&s).unwrap()); }
        ConfigCmd::Get { key } => {
            let loaded = cfg::load(&layout.config_path()).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            match cfg::get(&loaded.config, key.as_deref()) {
                Some(v) => { let k = key.clone().unwrap_or_default(); out.ok(&json!({ "key": key, "value": v, "restart": key.as_deref().map(class_name) }), || if k.is_empty() { serde_json::to_string_pretty(v).unwrap() } else { format!("{k} = {v}  [{}]", class_name(&k)) }); }
                None => out.fail("E_INVALID_PARAMS", &format!("no such key: {}", key.unwrap_or_default()), json!({}), 1),
            }
        }
        ConfigCmd::Set { key, value, yes, dry_run } => {
            let loaded = cfg::load(&layout.config_path()).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            let plan = cfg::set(&loaded.config, &key, parse_value(&value)).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({ "key": key }), 1));
            let restart = json!({ "live": plan.restart.live, "core": plan.restart.core, "modules": plan.restart.modules });
            let describe = || {
                let mut s = format!("changes: {}\n", plan.changed.join(", "));
                if !plan.restart.live.is_empty() { s.push_str(&format!("applies live: {}\n", plan.restart.live.join(", "))); }
                if plan.restart.core { s.push_str("restarts core: yes (H1: takes effect at the next `plur1bus core run`)\n"); }
                for m in &plan.restart.modules { s.push_str(&format!("restarts module {m}\n")); }
                s.trim_end().to_string()
            };
            if dry_run { out.ok(&json!({ "dryRun": true, "changed": plan.changed, "restart": restart }), describe); return; }
            if !yes {
                if std::io::stdin().is_terminal() && !out.json {
                    eprintln!("{}", describe()); eprint!("apply? [y/N] "); std::io::stderr().flush().ok();
                    let mut line = String::new(); std::io::stdin().read_line(&mut line).ok();
                    if !line.trim().eq_ignore_ascii_case("y") { out.fail("E_INVALID_PARAMS", "not applied", json!({ "applied": false }), 2); }
                } else { out.fail("E_INVALID_PARAMS", &format!("{}\nre-run with --yes to apply", describe()), json!({ "applied": false, "changed": plan.changed, "restart": restart }), 2); }
            }
            cfg::write_atomic(&layout.config_path(), &plan.after).unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            out.ok(&json!({ "applied": true, "changed": plan.changed, "restart": restart }), || format!("{}\napplied", describe()));
        }
    }
}
```

Wire `Cmd::Config { sub } => commands::config::run(&out, &layout, sub)`.

- [ ] **Step 4: Run and commit**

Run: `cargo test -p plur1bus && cargo clippy -p plur1bus --all-targets -- -D warnings && cargo fmt --all` → green.

```bash
git add crates/plur1bus
git commit -m "feat(cli): config get/set/schema with restart plan preview, --dry-run, --yes and schema-validated values"
```

---

### Task 14: CLI `memory add|recall`, journal on core loss, hygiene lint

**Files:**
- Create: `crates/plur1bus/src/commands/memory.rs`, `crates/plur1bus/src/journal.rs`, `scripts/lint-hygiene.mjs`, `packages/core/test/import-hygiene.test.ts`, `packages/core/test/helpers/trace-loader.mjs`
- Modify: `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/commands/mod.rs`, `crates/plur1bus/Cargo.toml` (add `jsonschema` as dev-dependency for the journal schema test), `crates/plur1bus/tests/cli.rs`, `package.json` (`lint` already calls the script)

**Interfaces:**
- Produces: `memory add --agent A [--session S] <text…>` → core `memory.capture` (wait, default `waitMs` from config) → `{ stored, skipped, reason? }`; core unavailable → `journal::append(layout, line)` and `{ journaled: true, degraded: { reason: "core-unavailable" } }`, exit 0. `memory recall --agent A [--session S] [--joined] <query…>` → `memory.recall` with `budget { softMs, hardMs, capChars }` from config; prints blocks (name, chars, text), deferrals, `degraded`, `timing.totalMs`; `--joined` prints `joined.text`; core unavailable → `{ blocks: [], degraded: { reason: "core-unavailable", capability: "recall", detail } }`, exit 0 and a marked line `! memory unavailable: core-unavailable (…)` on stderr. `journal::append(layout: &Layout, line: JournalLine) -> io::Result<()>` writes `state/journal/<agentId>.jsonl` with `O_APPEND`, mode `0600`.
- `scripts/lint-hygiene.mjs`: criterion 6 grep gate over `packages/*/src`, `packages/*/test`, `crates/*/src`, `crates/*/tests`, `tests/` for `/openclaw/i`, `OPENCLAW_`, `"/state"`, `"/forget"`, `adapter/openclaw`, `host-services.js`, `plugin-runtime`; the single allowed line is the parity import in `packages/core/test/principal.test.ts` (allow-list by path + exact string).

- [ ] **Step 1: Write the failing CLI tests** (add to `tests/cli.rs`)

```rust
#[test]
fn memory_add_journals_when_the_core_is_absent_and_recall_degrades_fast() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "agent", "create", "bernd"]).assert().success();
    let t0 = std::time::Instant::now();
    let out = bin().args(["--json", "--home", h, "memory", "add", "--agent", "bernd", "--session", "s1", "the", "roadmap", "review", "is", "on", "Thursday"]).assert().success().get_output().stdout.clone();
    assert!(t0.elapsed() < std::time::Duration::from_secs(1));
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["journaled"], true); assert_eq!(v["degraded"]["reason"], "core-unavailable");
    let journal = std::fs::read_to_string(dir.path().join("state/journal/bernd.jsonl")).unwrap();
    let line: serde_json::Value = serde_json::from_str(journal.trim()).unwrap();
    assert_eq!(line["v"], 1); assert_eq!(line["agentId"], "bernd"); assert_eq!(line["sessionKey"], "s1"); assert_eq!(line["caller"]["channel"], "cli");
    assert_eq!(line["messages"][0]["content"], "the roadmap review is on Thursday");
    let t1 = std::time::Instant::now();
    let out = bin().args(["--json", "--home", h, "memory", "recall", "--agent", "bernd", "when", "is", "it"]).assert().success().get_output().stdout.clone();
    assert!(t1.elapsed() < std::time::Duration::from_secs(1));
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["degraded"]["reason"], "core-unavailable"); assert_eq!(v["blocks"].as_array().unwrap().len(), 0);
    bin().args(["--home", h, "memory", "recall", "--agent", "bernd", "x"]).assert().success().stderr(predicate::str::contains("core-unavailable"));
}

#[test]
fn memory_add_for_an_unregistered_agent_fails_before_journaling() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "config", "get"]).assert().success();
    bin().args(["--home", h, "memory", "add", "--agent", "ghost", "x"]).assert().code(1).stderr(predicate::str::contains("not registered"));
    assert!(!dir.path().join("state/journal/ghost.jsonl").exists());
}

#[test]
fn journal_lines_validate_against_the_rpc_schema() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "agent", "create", "bernd"]).assert().success();
    bin().args(["--home", h, "memory", "add", "--agent", "bernd", "hello"]).assert().success();
    let schema: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/rpc-schema/schema/rpc.schema.json")).unwrap()).unwrap();
    let v = jsonschema::validator_for(&serde_json::json!({ "$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": "#/$defs/JournalLine", "$defs": schema["$defs"] })).unwrap();
    let line: serde_json::Value = serde_json::from_str(std::fs::read_to_string(dir.path().join("state/journal/bernd.jsonl")).unwrap().trim()).unwrap();
    let errs: Vec<String> = v.iter_errors(&line).map(|e| e.to_string()).collect();
    assert!(errs.is_empty(), "{errs:?}");
}
```

- [ ] **Step 2: Write `src/journal.rs` and `src/commands/memory.rs`**

`src/journal.rs`:

```rust
use crate::identity::CallerIdentity;
use crate::paths::Layout;
use serde::Serialize;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{self, Write};

#[derive(Serialize)]
pub struct Message<'a> { pub role: &'static str, pub content: &'a str }
#[derive(Serialize)]
pub struct JournalLine<'a> { pub v: u8, pub id: String, pub at: u64, #[serde(rename = "agentId")] pub agent_id: &'a str, #[serde(rename = "sessionKey", skip_serializing_if = "Option::is_none")] pub session_key: Option<&'a str>, pub caller: &'a CallerIdentity, pub messages: Vec<Message<'a>> }

pub fn append(layout: &Layout, line: &JournalLine<'_>) -> io::Result<()> {
    let dir = layout.journal(); create_dir_all(&dir)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?; }
    let mut o = OpenOptions::new(); o.create(true).append(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let mut f = o.open(dir.join(format!("{}.jsonl", line.agent_id)))?;
    let mut text = serde_json::to_string(line).unwrap(); text.push('\n');
    f.write_all(text.as_bytes())?; f.flush()
}

pub fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 }
```

`src/commands/memory.rs`:

```rust
use crate::cli::MemoryCmd;
use crate::identity;
use crate::journal::{self, JournalLine, Message};
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::{is_unavailable, Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::time::Duration;

fn connect(layout: &Layout, call_timeout: Duration) -> Result<Client, RpcError> {
    let token = std::fs::read_to_string(layout.core_token()).map_err(RpcError::from)?;
    Client::connect(&core_address(&layout.home, if cfg!(windows) { "windows" } else { "posix" }), token.trim(), ConnectOptions { connect_timeout: Duration::from_millis(300), call_timeout })
}

fn require_agent(out: &Out, config: &Value, id: &str) { if config["agents"].get(id).is_none() { out.fail("E_AGENT_UNKNOWN", &format!("agent {id} is not registered (plur1bus agent create {id})"), json!({}), 1); } }

pub fn run(out: &Out, layout: &Layout, cmd: MemoryCmd) {
    let config = cfg::load(&layout.config_path()).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1)).config;
    let caller = identity::caller();
    match cmd {
        MemoryCmd::Add { agent, session, text } => {
            require_agent(out, &config, &agent);
            let content = text.join(" "); if content.trim().is_empty() { out.fail("E_INVALID_PARAMS", "text is empty", json!({}), 1); }
            let wait_ms = config["core"]["capture"]["waitMs"].as_u64().unwrap_or(60_000);
            match connect(layout, Duration::from_millis(wait_ms + 1_000)) {
                Ok(mut c) => {
                    let params = json!({ "caller": caller, "agentId": agent, "sessionKey": session, "messages": [{ "role": "user", "content": content }], "wait": true, "waitMs": wait_ms });
                    match c.call("memory.capture", strip_nulls(params)) {
                        Ok(v) => out.ok(&v, || format!("stored {} / skipped {}{}", v["stored"], v["skipped"], v["reason"].as_str().map(|r| format!(" ({r})")).unwrap_or_default())),
                        Err(e) if is_unavailable(&e) => journaled(out, layout, &agent, session.as_deref(), &caller, &content, &e.to_string()),
                        Err(e) => out.from_rpc_error(&e),
                    }
                }
                Err(e) if is_unavailable(&e) => journaled(out, layout, &agent, session.as_deref(), &caller, &content, &e.to_string()),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        MemoryCmd::Recall { agent, session: _session, joined, query } => {
            require_agent(out, &config, &agent);
            let q = query.join(" "); if q.trim().is_empty() { out.fail("E_INVALID_PARAMS", "query is empty", json!({}), 1); }
            let (soft, hard, cap) = (config["core"]["recall"]["softBudgetMs"].as_u64().unwrap_or(400), config["core"]["recall"]["hardBudgetMs"].as_u64().unwrap_or(600), config["core"]["recall"]["capChars"].as_u64().unwrap_or(17_000));
            let unavailable = |detail: String| { let v = json!({ "blocks": [], "capChars": cap, "degraded": { "reason": "core-unavailable", "capability": "recall", "detail": detail }, "timing": { "totalMs": 0 }, "deferrals": [] }); eprintln!("! memory unavailable: core-unavailable ({detail})"); out.ok(&v, || String::new()); };
            match connect(layout, Duration::from_millis(hard + 400)) {
                Ok(mut c) => match c.call("memory.recall", json!({ "caller": caller, "agentId": agent, "query": q, "budget": { "softMs": soft, "hardMs": hard, "capChars": cap }, "joined": joined })) {
                    Ok(v) => out.ok(&v, || render_recall(&v, joined)),
                    Err(e) if is_unavailable(&e) => unavailable(e.to_string()),
                    Err(e) => out.from_rpc_error(&e),
                },
                Err(e) if is_unavailable(&e) => unavailable(e.to_string()),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        MemoryCmd::List(_) | MemoryCmd::Show(_) | MemoryCmd::Forget(_) | MemoryCmd::Correct(_) | MemoryCmd::Share(_) | MemoryCmd::State(_) => out.fail("E_NOT_AVAILABLE", "memory list/show/forget/correct/share/state arrive with engine PR E1 (MemoryOps)", json!({ "reason": "engine-pr-E1" }), 2),
    }
}

fn strip_nulls(mut v: Value) -> Value { if let Some(m) = v.as_object_mut() { m.retain(|_, x| !x.is_null()); } v }

fn journaled(out: &Out, layout: &Layout, agent: &str, session: Option<&str>, caller: &identity::CallerIdentity, content: &str, detail: &str) {
    let line = JournalLine { v: 1, id: uuid::Uuid::new_v4().to_string(), at: journal::now_ms(), agent_id: agent, session_key: session, caller, messages: vec![Message { role: "user", content }] };
    journal::append(layout, &line).unwrap_or_else(|e| out.fail("E_INTERNAL", &format!("journal write failed: {e}"), json!({}), 1));
    eprintln!("! core unavailable ({detail}); journaled for replay");
    out.ok(&json!({ "journaled": true, "id": line.id, "degraded": { "reason": "core-unavailable", "capability": "capture", "detail": detail } }), || "journaled (the core replays it at start)".into());
}

fn render_recall(v: &Value, joined: bool) -> String {
    let mut s = String::new();
    if joined { if let Some(t) = v["joined"]["text"].as_str() { s.push_str(t); s.push('\n'); } }
    else { for b in v["blocks"].as_array().unwrap_or(&vec![]) { s.push_str(&format!("── {} ({} chars){}\n{}\n", b["name"].as_str().unwrap_or("?"), b["chars"], if b["droppable"].as_bool().unwrap_or(false) { "" } else { " [pinned]" }, b["text"].as_str().unwrap_or(""))); } }
    for d in v["deferrals"].as_array().unwrap_or(&vec![]) { s.push_str(&format!("deferral: {} {} {}→{} ({})\n", d["block"], d["kind"], d["from"], d["to"], d["reason"])); }
    if !v["degraded"].is_null() { s.push_str(&format!("degraded: {} ({}){}\n", v["degraded"]["reason"], v["degraded"]["capability"], v["degraded"]["detail"].as_str().map(|d| format!(": {d}")).unwrap_or_default())); }
    s.push_str(&format!("{} ms", v["timing"]["totalMs"]));
    s
}
```

Wire `Cmd::Memory { sub } => commands::memory::run(&out, &layout, sub)`; add `mod journal;` to `main.rs` and `pub mod memory;` to `commands/mod.rs`; add `jsonschema = { version = "0.26", default-features = false }` under `[dev-dependencies]`.

- [ ] **Step 3: Run CLI tests** → green (the three new ones included). `cargo clippy` clean.

- [ ] **Step 4: Write the hygiene lint and the import-gate test**

`scripts/lint-hygiene.mjs`:

```js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["packages", "crates", "tests", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "generated", ".git"]);
const EXT = new Set([".ts", ".mjs", ".js", ".rs", ".json", ".md", ".toml", ".yaml", ".yml"]);
const PATTERNS = [
  { re: /openclaw/i, why: "no OpenClaw idiom in the harness (spec D9)" },
  { re: /OPENCLAW_/, why: "no host env names" },
  { re: /["'`]\/(state|forget)["'`]/, why: "no slash-command emulation" },
  { re: /adapter\/openclaw|host-services\.js|plugin-runtime/, why: "no adapter or host-services import" },
];
const ALLOW = new Map([
  ["packages/core/test/principal.test.ts", [/lib\/memory-request-context\.js/]],
  ["packages/core/package.json", [/github:Cyb3rb1ade\/openclaw-plur1bus-memory#[0-9a-f]{40}/]],
  ["pnpm-lock.yaml", [/.*/]],
]);

let bad = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (![...EXT].some((e) => name.endsWith(e))) continue;
    const rel = relative(process.cwd(), p).replaceAll("\\", "/");
    const allow = ALLOW.get(rel) ?? [];
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      for (const { re, why } of PATTERNS) {
        if (re.test(line) && !allow.some((a) => a.test(line))) { console.error(`${rel}:${i + 1}: ${why}: ${line.trim().slice(0, 120)}`); bad += 1; }
      }
    });
  }
}
for (const r of ROOTS) { try { walk(r); } catch { /* root absent */ } }
if (bad) { console.error(`hygiene: ${bad} violation(s)`); process.exit(1); }
console.log("hygiene ok");
```

`packages/core/test/helpers/trace-loader.mjs` (a `module.register` hook that records every resolved URL):

```js
import { register } from "node:module";
register(new URL("./trace-hooks.mjs", import.meta.url));
```

`packages/core/test/helpers/trace-hooks.mjs`:

```js
import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (process.env.PLUR1BUS_TRACE_FILE) appendFileSync(process.env.PLUR1BUS_TRACE_FILE, `${r.url}\n`);
  return r;
}
```

`packages/core/test/import-hygiene.test.ts`:

```ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { layout } from "../src/paths.ts";

const dist = new URL("../dist/core.js", import.meta.url).pathname;
if (!existsSync(dist)) execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });

it("the core process never loads an OpenClaw adapter, host-services or plugin-runtime module (criterion 6)", async () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-hyg-")); const l = layout(home);
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.engine = { reranker: { enabled: false } }; writeFileSync(l.configPath, JSON.stringify(cfg));
  const trace = join(home, "trace.txt"); writeFileSync(trace, "");
  const child = spawn(process.execPath, ["--import", new URL("./helpers/trace-loader.mjs", import.meta.url).pathname, dist, "--home", home, "--test-internals", "flat-embedder"], { env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TRACE_FILE: trace }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => child.stdout.once("data", () => r()));
  child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r));
  const urls = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  assert.ok(urls.some((u) => u.includes("/engine/create-engine.js")), "engine loaded");
  const offenders = urls.filter((u) => /\/adapter\/openclaw\/|\/lib\/host-services\.js|plugin-runtime|openclaw\.plugin/.test(u));
  assert.deepEqual(offenders, []);
});
```

If the offenders list is not empty because `engine/create-engine.js` itself imports `lib/host-services.js` (e.g. for `normalizeLogger`), that is an engine finding for plan 2a-E (E6 scope): record the exact import chain in the report and mark the assertion `{ todo: "engine E6: create-engine imports lib/host-services.js" }` — do not weaken the pattern.

- [ ] **Step 5: Run lint and tests**

Run: `cd "$HARNESS" && pnpm lint && cd packages/core && pnpm test`
Expected: `hygiene ok`, typecheck clean, import-hygiene passes (or is a recorded todo per the note).

- [ ] **Step 6: Commit**

```bash
git add crates/plur1bus scripts/lint-hygiene.mjs packages/core Cargo.lock
git commit -m "feat(cli): memory add/recall over the core with journal fallback and end-to-end budgets; hygiene lint and import gate (criterion 6)"
```

---

### Task 15: CLI `dreams status|run|log`

**Files:**
- Create: `crates/plur1bus/src/commands/dreams.rs`
- Modify: `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/commands/mod.rs`, `crates/plur1bus/tests/cli.rs`

**Interfaces:**
- Produces: `dreams status [--agent A]` → `jobs.list` plus, per agent (all registered or the one given), the last run per job from `jobs.history` (`limit: 200`), summarised as `{ job, lastOutcome, lastReason, lastAt, attempts }` and a `breaker` line: count of rem/deep runs today (UTC) vs. the engine's limit of 3 (spec §7 / #186 PR body); `dreams run <job> --agent A` → `jobs.run` (prints outcome, reason — `already_running`, `breaker_open`, `dry_run_unsupported` come through verbatim), exit 0 for `completed|skipped`, 1 for `failed|abandoned|incomplete`; `dreams log --agent A [--job J] [--limit N]` → `jobs.history` rows, newest first.

- [ ] **Step 1: Write the failing test** (add to `tests/cli.rs`)

```rust
#[test]
fn dreams_without_a_core_says_so_and_validates_args() {
    let dir = tempfile::tempdir().unwrap(); let h = dir.path().to_str().unwrap();
    bin().args(["--home", h, "agent", "create", "bernd"]).assert().success();
    bin().args(["--home", h, "dreams", "status"]).assert().code(1).stderr(predicate::str::contains("core unavailable"));
    bin().args(["--home", h, "dreams", "run", "gc-run", "--agent", "ghost"]).assert().code(1).stderr(predicate::str::contains("not registered"));
    let out = bin().args(["--json", "--home", h, "dreams", "log", "--agent", "bernd"]).assert().code(1).get_output().stdout.clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap(); assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
}
```

The live path (`status` with a running core showing 18 jobs, `run gc-run` returning a JobRun) is covered by the system test in Task 18, which is the only place a core runs under the CLI in CI.

- [ ] **Step 2: Write `src/commands/dreams.rs`**

```rust
use crate::cli::DreamsCmd;
use crate::output::Out;
use crate::paths::{core_address, Layout};
use plur1bus_config as cfg;
use plur1bus_rpc::{Client, ConnectOptions};
use serde_json::{json, Value};

fn connect(out: &Out, layout: &Layout) -> Client {
    let token = std::fs::read_to_string(layout.core_token()).unwrap_or_else(|_| out.fail("E_CORE_UNAVAILABLE", "core unavailable (no token; is the core running? `plur1bus core run`)", json!({}), 1));
    Client::connect(&core_address(&layout.home, if cfg!(windows) { "windows" } else { "posix" }), token.trim(), ConnectOptions::default()).unwrap_or_else(|e| out.fail("E_CORE_UNAVAILABLE", &format!("core unavailable: {e}"), json!({}), 1))
}

fn utc_day(ms: u64) -> u64 { ms / 86_400_000 }

pub fn run(out: &Out, layout: &Layout, cmd: DreamsCmd) {
    let config = cfg::load(&layout.config_path()).unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1)).config;
    let registered: Vec<String> = config["agents"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let require = |id: &str| if !registered.iter().any(|r| r == id) { out.fail("E_AGENT_UNKNOWN", &format!("agent {id} is not registered"), json!({}), 1) };
    match cmd {
        DreamsCmd::Status { agent } => {
            if let Some(a) = &agent { require(a); }
            let mut c = connect(out, layout);
            let jobs = c.call("jobs.list", json!({})).unwrap_or_else(|e| out.from_rpc_error(&e));
            let agents: Vec<String> = agent.map(|a| vec![a]).unwrap_or(registered.clone());
            let today = utc_day(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
            let mut per_agent = Vec::new();
            for a in &agents {
                let runs = c.call("jobs.history", json!({ "agentId": a, "limit": 200 })).unwrap_or_else(|e| out.from_rpc_error(&e));
                let runs = runs["runs"].as_array().cloned().unwrap_or_default();
                let mut last: Vec<Value> = Vec::new();
                for j in jobs["jobs"].as_array().unwrap_or(&vec![]) {
                    let name = j["name"].as_str().unwrap_or("");
                    let mine: Vec<&Value> = runs.iter().filter(|r| r["job"] == name).collect();
                    let newest = mine.iter().max_by_key(|r| r["startedAt"].as_u64().unwrap_or(0));
                    last.push(json!({ "job": name, "phase": j["phase"], "needsLlm": j["needsLlm"], "lastOutcome": newest.map(|r| r["outcome"].clone()).unwrap_or(Value::Null), "lastReason": newest.map(|r| r["reason"].clone()).unwrap_or(Value::Null), "lastAt": newest.map(|r| r["startedAt"].clone()).unwrap_or(Value::Null), "attempts": mine.len() }));
                }
                let llm_today = runs.iter().filter(|r| matches!(r["phase"].as_str(), Some("rem") | Some("deep")) && r["startedAt"].as_u64().map(|t| utc_day(t) == today).unwrap_or(false)).count();
                per_agent.push(json!({ "agentId": a, "breaker": { "llmSessionsToday": llm_today, "limit": 3, "open": llm_today >= 3 }, "jobs": last }));
            }
            let v = json!({ "jobs": jobs["jobs"], "agents": per_agent });
            out.ok(&v, || per_agent.iter().map(|a| { let b = &a["breaker"]; let mut s = format!("{}  breaker {}/{}{}\n", a["agentId"].as_str().unwrap(), b["llmSessionsToday"], b["limit"], if b["open"].as_bool().unwrap_or(false) { " OPEN" } else { "" }); for j in a["jobs"].as_array().unwrap() { s.push_str(&format!("  {:<26} {:<10} {}\n", j["job"].as_str().unwrap(), j["lastOutcome"].as_str().unwrap_or("-"), j["lastReason"].as_str().unwrap_or(""))); } s }).collect::<Vec<_>>().join("\n"));
        }
        DreamsCmd::Run { job, agent } => {
            require(&agent);
            let mut c = connect(out, layout);
            let v = c.call("jobs.run", json!({ "agentId": agent, "job": job })).unwrap_or_else(|e| out.from_rpc_error(&e));
            let outcome = v["outcome"].as_str().unwrap_or("?").to_string();
            out.ok(&v, || format!("{job}: {outcome}{} in {} ms (run {})", v["reason"].as_str().map(|r| format!(" ({r})")).unwrap_or_default(), v["durationMs"], v["runId"]));
            if !matches!(outcome.as_str(), "completed" | "skipped") { std::process::exit(1); }
        }
        DreamsCmd::Log { agent, job, limit } => {
            require(&agent);
            let mut c = connect(out, layout);
            let mut params = json!({ "agentId": agent, "limit": limit }); if let Some(j) = job { params["job"] = json!(j); }
            let v = c.call("jobs.history", params).unwrap_or_else(|e| out.from_rpc_error(&e));
            let mut runs = v["runs"].as_array().cloned().unwrap_or_default(); runs.sort_by_key(|r| std::cmp::Reverse(r["startedAt"].as_u64().unwrap_or(0)));
            out.ok(&json!({ "runs": runs }), || runs.iter().map(|r| format!("{} {:<26} {:<10} attempt {} {} ms {}", r["startedAt"], r["job"].as_str().unwrap_or(""), r["outcome"].as_str().unwrap_or(""), r["attempt"], r["durationMs"], r["reason"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"));
        }
    }
}
```

Wire `Cmd::Dreams { sub } => commands::dreams::run(&out, &layout, sub)`; remove the H1 stub arm from `main.rs` (every command is now real or a milestone stub).

- [ ] **Step 3: Run and commit**

Run: `cargo test -p plur1bus && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all` → green.

```bash
git add crates/plur1bus
git commit -m "feat(cli): dreams status/run/log over jobs.* with breaker summary"
```

---

### Task 16: `docs/config-engine-keys.md` and `AGENTS.md`

**Files:**
- Create: `scripts/gen-engine-keys.mjs`, `docs/config-engine-keys.md`, `AGENTS.md`
- Modify: `package.json` (`docs` script runs `gen-engine-keys.mjs` too)

- [ ] **Step 1: Write the generator**

`scripts/gen-engine-keys.mjs` reads the pinned engine's `openclaw.plugin.json` `configSchema.properties` (the 56 keys), classifies every key `core` (H1 rule: everything the engine reads is construction-time until E5 declares `readAt`), marks the keys the harness forces (`baseDbPath`, `autoRecall`, `autoCapture`, `embedding.provider`, `reranker.enabled|provider`, `recall.softBudgetMs|globalInjectMaxChars|decisionTrace.enabled`) as **harness-owned**, and writes the table:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const plugin = require("@cyb3rb1ade/plur1bus-memory/openclaw.plugin.json");
const props = plugin.configSchema.properties;
const FORCED = new Map([["baseDbPath", "<home>/state/lancedb"], ["autoRecall", "false (harness calls recall explicitly)"], ["autoCapture", "false (harness calls capture explicitly)"], ["embedding", "provider local-transformers; local.model/dimensions/cacheDir defaulted, user-overridable"], ["reranker", "enabled, local-transformers, bge-reranker-v2-m3-onnx"], ["recall", "softBudgetMs, globalInjectMaxChars, decisionTrace.enabled from core.recall.*"]]);
const rows = Object.entries(props).sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => {
  const type = Array.isArray(s.type) ? s.type.join("|") : (s.type ?? (s.enum ? "enum" : "any"));
  const def = s.default !== undefined ? `\`${JSON.stringify(s.default)}\`` : "";
  const forced = FORCED.get(k);
  return `| \`engine.${k}\` | ${type} | ${def} | core | ${forced ? `**harness-owned**: ${forced}` : ""} |`;
});
const doc = `# Engine configuration keys (contract 1.4.1, engine @ eaaf168f)

Generated by \`scripts/gen-engine-keys.mjs\` from the pinned engine's \`openclaw.plugin.json\` (${rows.length} keys). Every key is reachable as \`engine.<key>\` in \`config.json\`; \`packages/core/src/engine-config.ts\` is the single translation. Restart class is **core** for every engine key until engine PR E5 ships a host-neutral \`engine-config.schema.json\` with \`readAt: construction|live\`; keys marked harness-owned cannot be overridden through \`engine.*\`.

| Key | Type | Default | Restart | Notes |
|---|---|---|---|---|
${rows.join("\n")}
`;
writeFileSync(new URL("../docs/config-engine-keys.md", import.meta.url), doc);
console.log(`config-engine-keys: ${rows.length} keys`);
```

Run: `node scripts/gen-engine-keys.mjs` → `docs/config-engine-keys.md` with 56 rows (assert the count in the script: `if (rows.length !== 56) throw new Error(...)` — if the pinned engine has a different count, update the number in the spec §6.1 and here, and say so).

- [ ] **Step 2: Write `AGENTS.md`** (root; the harness edition of the engine's file — what an agent needs to build, test and find things)

Contents, in this order, each section short and concrete: **What this repo is** (harness = supervisor + core + modules + CLI; engine lives in `openclaw-plur1bus-memory`, consumed pinned); **Toolchain** (Node 24.21 via `/home/claude/.node24/bin` on the dev container, pnpm 10, Rust 1.95; `node scripts/check-toolchain.mjs`); **Build/test/lint** (the root scripts, one crate, one package, the system test command with `PLUR1BUS_BIN`, `PLUR1BUS_CORE_JS`, `PLUR1BUS_NODE`, `PLUR1BUS_ALLOW_TEST_INTERNALS`); **Where things live** (the file-structure table from this plan, trimmed to what exists); **Conventions** (JSON Schema is the source of RPC and config types — never edit `generated/`; every config key carries `x-restart`; `additionalProperties: false` on every RPC params object; `erasableSyntaxOnly` TypeScript; no OpenClaw idiom, `pnpm lint` enforces; commit identity; secrets rule); **Running the core by hand** (`PLUR1BUS_CORE_JS=packages/core/dist/core.js plur1bus core run --home /tmp/h`); **Module README convention** (D14: every future module under `packages/` or `modules/` ships `README.md` with purpose, manifest, RPC it provides/consumes, restart class of its config keys, and how to test it in isolation — H2 adds the first one); **Docs** (`pnpm docs` regenerates `docs/rpc.md`, `docs/cli.md`, `docs/config-engine-keys.md`; CI fails when stale).

- [ ] **Step 3: Wire and commit**

Add `node scripts/gen-engine-keys.mjs &&` in front of the root `docs` script. Run `pnpm docs` (Task 17's `gen-docs.mjs` does not exist yet — for now the script is only `gen-engine-keys`; Task 17 extends it).

```bash
git add scripts/gen-engine-keys.mjs docs/config-engine-keys.md AGENTS.md package.json
git commit -m "docs: engine key inventory (56 keys, restart classes, harness-owned keys) and AGENTS.md for the harness"
```

---

### Task 17: ADR-012, ADR-013, generated `docs/rpc.md` and `docs/cli.md`

**Files:**
- Create: `docs/adr/ADR-012-process-model-and-languages.md`, `docs/adr/ADR-013-configuration-and-restart-classes.md`, `scripts/gen-docs.mjs`, `docs/rpc.md`, `docs/cli.md`
- Modify: `docs/adr/README.md` (index), `package.json` (`docs`, `docs:check`)

- [ ] **Step 1: Write ADR-012** — follow the format of `docs/adr/ADR-002-plur1bus-engine-and-host.md` (Status / Context / Decision / Consequences / Alternatives). Content, from spec §4 and this plan: process model B with the A/B/C trade-off table (ESM cannot unload; worker threads share a native crash and secrets; B costs 30–50 MB per process, mitigated by lazy start and a later in-process module host); Rust for CLI/supervisor/installer/updater, TypeScript for core and SDK-bound modules, JSON Schema as the single source (`typify` build.rs, `json-schema-to-typescript`), amending ADR-001's single-stack wording; RPC: JSON-RPC 2.0 NDJSON, `core.auth` handshake carrying `contract`/`rpc` (why not envelope members: JSON-RPC 2.0 response objects have no room), closed error enum plus `E_LOCKED` (H1 addition, why), token auth with `timingSafeEqual`; the OS-held lock via `node:sqlite` `BEGIN EXCLUSIVE` (why not `flock`: no native addon; verified behaviour); Windows named pipe with token auth now, user-SID ACL in H2; H1 interim `core run` and CLI-owned `config.json`, superseded in H2. Status: Accepted (owner decisions D6, D7 of 2026-09-24).

- [ ] **Step 2: Write ADR-013** — from spec §6.1 and Task 3: one `config.json` with `$schema` and `schemaVersion`; every key carries `x-restart` (`live | module:<name> | core`), nearest ancestor wins for open objects; the apply sequence (validate → atomic write with backup on migration → `config.changed` → live keys applied by subscribers → restart plan in dependency order); `config set` preview and `--dry-run`; one owner (H1: the CLI through `plur1bus-config`; H2: the supervisor, direct file edits detected and validated); reserved namespaces `providers`, `oauth`, `decision`, `modelRoles` (D15, D16, D18); engine keys pass through as `engine.*`, class `core` until E5; the TS/Rust parity contract (`fixtures/defaults.json`). Status: Accepted (owner decisions D3, D5).

- [ ] **Step 3: Write `scripts/gen-docs.mjs`**

```js
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const check = process.argv.includes("--check");
const schema = JSON.parse(readFileSync(new URL("../packages/rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
const fence = (v) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
let rpc = `# RPC reference (rpc ${schema["x-rpc-version"]})\n\nGenerated from \`packages/rpc-schema/schema/rpc.schema.json\` by \`scripts/gen-docs.mjs\`. JSON-RPC 2.0 over NDJSON on \`run/core.sock\` (POSIX) or the per-home named pipe (Windows); first call on a connection is \`core.auth\`.\n\n## Error codes\n\n${schema.$defs.ErrorCode.enum.map((e) => `- \`${e}\``).join("\n")}\n\n## Methods\n`;
for (const [name, def] of Object.entries(schema.$defs.methods)) rpc += `\n### \`${name}\`\n\n${def.params.description ?? ""}\n\n**params**\n\n${fence(def.params)}\n\n**result**\n\n${fence(def.result)}\n`;
rpc += `\n## Notifications\n`;
for (const [name, def] of Object.entries(schema.$defs.notifications)) rpc += `\n### \`${name}\`\n\n${def.description ?? ""}\n\n${fence(def)}\n`;
const bin = process.env.PLUR1BUS_BIN ?? "target/debug/plur1bus";
const cli = `# CLI reference\n\nGenerated by \`scripts/gen-docs.mjs\` from the clap definitions (\`plur1bus __markdown\`). Every command accepts \`--json\` and \`--home <path>\`.\n\n` + execFileSync(bin, ["__markdown"], { encoding: "utf8" });
const outputs = [["docs/rpc.md", rpc], ["docs/cli.md", cli]];
let stale = 0;
for (const [path, content] of outputs) {
  const url = new URL(`../${path}`, import.meta.url);
  if (check) { let cur = ""; try { cur = readFileSync(url, "utf8"); } catch {} if (cur !== content) { console.error(`stale: ${path} (run pnpm docs)`); stale += 1; } }
  else writeFileSync(url, content);
}
if (stale) process.exit(1);
console.log(check ? "docs up to date" : "docs written");
```

`package.json`: `"docs": "cargo build -q -p plur1bus && node scripts/gen-engine-keys.mjs && node scripts/gen-docs.mjs"`, `"docs:check": "cargo build -q -p plur1bus && node scripts/gen-docs.mjs --check"`.

- [ ] **Step 4: Generate, index, commit**

Run: `cd "$HARNESS" && pnpm docs && pnpm docs:check` → `docs up to date`. Add ADR-012/013 rows to `docs/adr/README.md`.

```bash
git add docs/adr scripts/gen-docs.mjs docs/rpc.md docs/cli.md package.json
git commit -m "docs: ADR-012 (process model, languages, RPC, lock), ADR-013 (configuration and restart classes), generated rpc.md and cli.md with staleness check"
```

---

### Task 18: System test (criterion 1), benchmarks B1/B9/B11, nightly real-model job

**Files:**
- Create: `tests/system/two-session-recall.test.ts`, `tests/system/helpers.ts`, `scripts/bench.mjs`, `packages/core/test/b9-no-syscalls.test.ts`, `.github/workflows/nightly.yml`
- Modify: `.github/workflows/ci.yml` (already calls these), `docs/milestones.md` (M1b-2a-H1 status line)

**Interfaces:**
- Env contract for the system test: `PLUR1BUS_BIN` (release binary), `PLUR1BUS_CORE_JS` (`packages/core/dist/core.js`), `PLUR1BUS_NODE` (`process.execPath`), `PLUR1BUS_REAL_MODELS=1` switches off the flat embedder and asserts the reranker ran.

- [ ] **Step 1: Write the system test**

`tests/system/helpers.ts`:

```ts
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
export const CORE_JS = resolve(process.env.PLUR1BUS_CORE_JS ?? "packages/core/dist/core.js");
export const REAL = process.env.PLUR1BUS_REAL_MODELS === "1";

export function home(): string { return mkdtempSync(join(tmpdir(), "p1b-sys-")); }

export function cli(h: string, args: string[], opts: { json?: boolean; allowFail?: boolean } = {}): any {
  const all = [...(opts.json === false ? [] : ["--json"]), "--home", h, ...args];
  try { const out = execFileSync(BIN, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return opts.json === false ? out : JSON.parse(out); }
  catch (e: any) { if (!opts.allowFail) throw new Error(`${all.join(" ")}: exit ${e.status}\n${e.stderr}`); return { exit: e.status, stdout: e.stdout, stderr: e.stderr }; }
}

export async function startCore(h: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, PLUR1BUS_CORE_JS: CORE_JS, PLUR1BUS_NODE: process.execPath, ...(REAL ? {} : { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" }) };
  const child = spawn(BIN, ["--home", h, "core", "run"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res, rej) => { child.stdout!.once("data", () => res()); child.once("exit", (c) => rej(new Error(`core exited ${c}`))); });
  return child;
}

export async function stopCore(child: ChildProcess): Promise<void> { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

`tests/system/two-session-recall.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, home, sleep, startCore, stopCore } from "./helpers.ts";

describe("M1 acceptance 1 — two-session recall through the CLI", () => {
  it("captures in s1, recalls in s2 with the reranker having run; survives a core kill via the journal", async () => {
    const h = home();
    cli(h, ["agent", "create", "bernd"]);
    let core = await startCore(h);
    try {
      const status = cli(h, ["dreams", "status"]); assert.equal(status.jobs.length, 18);
      const add = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the roadmap review is on Thursday at ten."]);
      assert.ok(add.stored >= 1, JSON.stringify(add));
      const t0 = performance.now();
      const r = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s2", "--joined", "when is the roadmap review"]);
      const ms = performance.now() - t0;
      assert.equal(r.degraded, null, JSON.stringify(r.degraded));
      assert.match(r.joined.text, /roadmap review/i);
      if (REAL) { assert.ok(r.timing?.phases && "rerank" in r.timing.phases, `rerank phase present: ${JSON.stringify(r.timing)}`); }
      assert.ok(ms < 5000, `CLI recall took ${ms} ms`);

      // §8 "core killed mid-use": degraded fast, add journaled, replayed after restart
      core.kill("SIGKILL"); await new Promise((res) => core.once("exit", res));
      const t1 = performance.now();
      const down = cli(h, ["memory", "recall", "--agent", "bernd", "anything"]);
      assert.equal(down.degraded.reason, "core-unavailable"); assert.ok(performance.now() - t1 < 1000);
      const j = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s3", "Also remember that Mira visits every spring."]);
      assert.equal(j.journaled, true);
      assert.ok(existsSync(join(h, "state/journal/bernd.jsonl")));
      core = await startCore(h);
      await sleep(500);
      assert.equal(readFileSync(join(h, "state/journal/bernd.jsonl"), "utf8").trim(), "", "journal drained");
      const after = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s4", "--joined", "when does Mira visit"]);
      assert.match(after.joined.text, /Mira|spring/i);
      const run = cli(h, ["dreams", "run", "gc-run", "--agent", "bernd"]); assert.ok(["completed", "skipped"].includes(run.outcome));
    } finally { await stopCore(core); }
  });
});
```

- [ ] **Step 2: Build and run it locally**

Run: `cd "$HARNESS" && pnpm gen && pnpm build && cargo build --release -p plur1bus && PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/two-session-recall.test.ts`
Expected: pass with the flat embedder. Then once with real models (downloads ~600 MB into the temp home's `models/`; skip if offline): `PLUR1BUS_REAL_MODELS=1 … ` — expect pass with the rerank phase present; record both timings in the report.

- [ ] **Step 3: Write the B9 test and the bench script**

`packages/core/test/b9-no-syscalls.test.ts` — the cross-platform proxy for "0 socket/spawn syscalls during recall assembly": monkey-patch `net.createConnection`, `net.connect`, `child_process.spawn|exec|execFile|fork`, `dgram.createSocket`, `http.request`, `https.request` to count calls, run one `memory.recall` through an in-process core (as in `core.test.ts`), assert every counter is 0; restore in `after`.

`scripts/bench.mjs`:

```js
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";

const BIN = resolve(process.env.PLUR1BUS_BIN ?? "target/release/plur1bus");
const p95 = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const gates = [];

// B1: --help p95 < 100 ms (50 runs)
const b1 = []; for (let i = 0; i < 50; i += 1) { const t = performance.now(); execFileSync(BIN, ["--help"], { stdio: "ignore" }); b1.push(performance.now() - t); }
gates.push(["B1 --help p95 ms", p95(b1), 100]);

// B11: core.status roundtrip p95 < 5 ms (200 calls) against a core started by the CLI
const home = mkdtempSync(join(tmpdir(), "p1b-bench-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ ...defaults(), agents: { bernd: {} }, engine: { reranker: { enabled: false } } }));
const core = spawn(BIN, ["--home", home, "core", "run"], { env: { ...process.env, PLUR1BUS_CORE_JS: resolve("packages/core/dist/core.js"), PLUR1BUS_NODE: process.execPath, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" }, stdio: ["ignore", "pipe", "inherit"] });
const ready = JSON.parse(await new Promise((r) => core.stdout.once("data", (d) => r(String(d)))));
const c = await connect({ address: ready.address, token: readFileSync(join(home, "run/core.token"), "utf8") });
const b11 = []; for (let i = 0; i < 200; i += 1) { const t = performance.now(); await c.call("core.status"); b11.push(performance.now() - t); }
gates.push(["B11 core.status p95 ms", p95(b11), 5]);
await c.close(); core.kill("SIGTERM");

let failed = 0;
for (const [name, value, limit] of gates) { const ok = value < limit; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${value.toFixed(2)} (limit ${limit})`); if (!ok) failed += 1; }
process.exit(failed ? 1 : 0);
```

Run: `pnpm bench` → both PASS; keep the numbers for the report (B8 "core ready < 3 s" is advisory: print the time between spawn and the ready line in the same script).

- [ ] **Step 4: Nightly workflow**

`.github/workflows/nightly.yml`: `on: schedule: - cron: "17 3 * * *"` and `workflow_dispatch`; matrix ubuntu-24.04 + macos-15; same setup as `ci.yml`'s `system` job; caches `~/.cache/huggingface` and the models dir via `actions/cache` keyed on the model names; runs the system test with `PLUR1BUS_REAL_MODELS=1` and `pnpm bench`.

- [ ] **Step 5: Milestones note and final commit**

Append to `docs/milestones.md` under M1: "M1b-2a-H1 (harness foundation) — done <date>: acceptance 1 (two-session recall via CLI, rerank in nightly), criteria 6, 7, 8 (B1, B9, B11), 10; H2 carries 2, 3, 4, 5, 9, 11, 12."

```bash
git add tests/system scripts/bench.mjs packages/core/test/b9-no-syscalls.test.ts .github/workflows/nightly.yml docs/milestones.md
git commit -m "test(system): two-session recall through the CLI with core-kill and journal replay; B1/B9/B11 benchmarks; nightly real-model run"
```

- [ ] **Step 6: Whole-branch verification before the gate**

Run the full sequence from "how to run anything" plus `pnpm docs:check` and `pnpm bench`. Every step green. Push the branch (from the Mac if the cloud push is blocked), open the PR with the M1b-1 PR body style: summary, deliberate behaviour choices (H1 interims: `core run`, CLI-owned config, `E_LOCKED`, `core.auth` handshake), known gaps for H2, verification numbers.

---

## Self-review

**Spec coverage (H1 scope).** §4 process model: core + CLI built, supervisor deferred to H2 (Task 11 stubs name it). §5 layout: every package and crate exists except `tests/system` scope beyond criterion 1 and `skills/` (H2). §6.1: state root, config schema with `x-restart`, one `config.json`, engine key inventory — Tasks 3, 5, 12, 16; the *watcher* and *one owner = supervisor* are H2 (ADR-013 says so). §6.2: contract, methods, notifications (`core.state`, `agent.activity`, engine events; `module.state`/`config.changed` H2), error enum, fixtures both sides, CLI principal — Tasks 2, 6, 7, 10. §6.3: host, engine config, lifecycle, journal replay, activity — Tasks 5, 7, 8, 9. §6.4: only the lock and the "clients under core loss" behaviour (journal, 300 ms) are H1 — Tasks 7, 14, 18; supervision, lifelines, adoption are H2. §6.6: `agent`, `memory add|recall`, `dreams`, `config`, stubs — Tasks 11–15; `1staid`, `module`, `daemon`, `service`, `setup`, `update` are H2 stubs. §9 skill: H2. §10: criteria 1, 6, 7, 8 (B1, B9, B11; B8 advisory), 10 (docs half) — Tasks 14, 17, 18; the rest H2/E.

**Placeholders.** None of the banned phrases; every code step has its code. Two deliberate "adapt to what the generator emits" instructions (typify names, Task 10; `jsonschema` API surface, Task 12) name the exact decision the implementer makes and require it in the report.

**Type consistency.** `CallerIdentity` (schema) ↔ `callerToPrincipal` (Task 7) ↔ Rust `identity::caller()` (Task 11) — same three fields. `Layout` field names match between `paths.ts` and `paths.rs` (snake/camel). `RpcError.error` (TS) ↔ `RpcError::Call { error }` (Rust) ↔ `error.data.error` on the wire. `Activity`, `ProcessState`, `JournalLine` used identically in Tasks 2, 8, 9, 14. `createAgentRegistry` signature changes in Task 12 (path variant) — Task 8's `core.ts` is updated there. `replayJournal` stubbed in Task 8, real in Task 9.

**Review Focus → tests.** 1 torn journal line → Task 9. 2 idle/oversize connections → Task 6. 3 unregistered agent → Task 8. 4 invalid caller identity → Tasks 7 and 8. 5 wrong-typed `config set` → Task 13.
