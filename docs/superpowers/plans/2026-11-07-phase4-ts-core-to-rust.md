# Phase 4 before 0.1: the TypeScript harness core moves to Rust — implementation plan

**Goal.** Release 0.1, the first alpha, runs on a Rust core. Every non-UI TypeScript component of the harness core moves
to Rust subsystem by subsystem, through the RPC seams that exist today, with the system running after every package. No
big bang, no long dual life, and no TypeScript fixes on the way (owner decision D129, 2026-11-07).

**Decision basis.** D129 (2026-11-07): the Node engine (`openclaw-plur1bus-memory`) is frozen and its fixes go to
`crates/plur1bus-engine`; bugs and security issues in the TypeScript core are not fixed in TypeScript, the component is
ported and fixed in Rust; 0.1 ships on Rust, which pulls "Phase 4" (D120 design §12, the strangler order of §12.2) ahead
of 0.1; `packages/web` and `apps/desktop/ui` stay TypeScript; running work finishes (TK, PR #900; the learn pass, #895,
merged); D124 Q21 (c) ("Rust decides, TypeScript executes") stays valid; new core packages are planned in Rust. Further
inputs: D120 design `docs/superpowers/specs/2026-10-30-harness-hygiene-coding-aci-design.md` §5, §11.2, §12, §13; D124
design `docs/superpowers/specs/2026-11-01-parallel-agent-teams-design.md` §6.3; D123 plan
`docs/superpowers/plans/2026-10-31-containment-rust.md`; the Rust engine programme
`docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md` and `docs/superpowers/plans/rust-engine/README.md` (RE-00…RE-14);
ADR-012 (process model, languages), ADR-016 (API stability).

**Status.** Accepted 2026-11-07 (owner decision D131): Q1 = B; every other question of §6 as recommended; in addition, the D124 team shell PT-4b is written in Rust inside P4-50 (Q6). Recorded as [ADR-019](../../adr/ADR-019-rust-new-components-and-core-strangler.md). Written read-only against `origin/main` at the merge of PR #895 (`9df81fe9d1`, 2026-11-07). It
supersedes, in scope, the output the D120 plan gave its P4-spike ("`<date>-core-phase4-outline.md`"); the spike itself
is P4-01 below. The memory engine is the RE programme's: this plan references RE briefs and orders around them, it does
not re-plan them. Owner questions are in §6; until they are answered, every package assumes the recommendation.

**Constraints** (repository rules, unchanged).
- JSON Schema stays the single source of every cross-language type (`packages/rpc-schema/schema/rpc.schema.json`,
  `packages/config-schema/schema/config.schema.json`); every RPC addition has closed params, `x-server`,
  `x-stability: "experimental"`, `x-since`; no new error codes (new `reason` strings in `docs/errors.md`).
- Rust: `#![forbid(unsafe_code)]` in every new crate (unsafe stays confined to the crates that already carry it, such as
  D123's `plur1bus-sandbox`), `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`, the gate of
  `docs/dependency-policy.md` (licence allow-list, two-week release window), `scripts/lint-hygiene.mjs`.
- TDD (red test first), no network in tests, never skip, disable or quarantine a test.
- Every Rust package is done by a Claude agent, never Codex without an explicit owner exception (D120 plan, D124 §6.3).
- One branch and one ready PR per package; no CI polling (push, open the PR, report the number, stop); no force-push,
  rebase, amend or stash; commits carry the owner's identity; the controller merges (`CLAUDE.md`).

**How the numbers were made.** `git ls-files` plus `wc -l` at the base commit, raw lines (comments and blank lines
included). "src" = `.ts`/`.tsx` (or `.rs`) files outside test paths (`*.test.*`, `*.spec.*`, `test/`, `tests/`,
`__tests__`); "test" = the rest. Rust inline `#[cfg(test)]` modules count as src. Estimates: §5.4.

---

## 1. Starting point

### 1.1 Non-UI TypeScript packages

| Package | src files / lines | test files / lines | What it does | Runs in | Rust coverage today |
|---|---|---|---|---|---|
| `packages/core` | 794 / 99,994 | 1,060 / 144,672 | The core: RPC server, identity and RBAC, sessions and turns, tool dispatcher and policy, approvals, secrets, channels switchboard, MCP/ACP/A2A, collab and teams, jobs, voice, media, import (§1.2) | slot `core` (`node core.js`) and the Node entry points `acp.js`, `mcp.js`, `import.js`, `api.js`, `extension-source.js`, the secrets helper (build script in `packages/core/package.json`) | §1.2, last column |
| `packages/api` | 85 / 11,685 | 117 / 18,007 | Harness API: HTTP server, accounts, login, TOTP, OAuth authorization server, desktop pairing and step-up, `/rpc` proxy, `/events` SSE, uploads, `/mcp` and `/a2a` HTTP endpoints (deps `@modelcontextprotocol/sdk` 1.32.1, `@a2a-js/sdk` 1.3.0); route table → `docs/openapi.json` | slot `api` (`plur1bus-api`), RPC client of the core (`src/core-link.ts`) | client side only (`apps/desktop/src-tauri/src/client.rs`, `pair.rs`) |
| `packages/providers` | 53 / 6,356 | 63 / 9,495 | LLM wire formats (Anthropic, Gemini, Responses, chat completions), SSE, router, reasoning, cache profiles, local servers incl. D122 AF1's Unix-socket transport; **no runtime dependency** | core | cache-profile table read by the engine (`crates/plur1bus-engine/src/cache_profiles.rs`, vectors `packages/providers/fixtures/cache-profile-vectors.json`); token counter `crates/plur1bus-engine/src/tokens/` (RE-D20) |
| `packages/channels-*` (7) | 90 / 14,046 | 110 / 29,285 | Telegram 1,427 · Discord 2,116 · Slack 2,465 · Signal 1,844 · E-mail 3,043 · Matrix 2,933 (dep `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0) · Buzz 218 (dep `nostr-tools` 2.25.2); the other five have no runtime dependency | core (in-process libraries) | none |
| `packages/voice-providers` | 25 / 4,273 | 27 / 4,631 | Cloud STT, TTS and realtime over HTTP and WebSocket; local voice through lazily loaded `sherpa-onnx-node` (`src/local/engine.ts:2`) | core | none |
| `packages/remote-access` | 20 / 2,706 | 26 / 4,334 | Certificates, company CA, pairing codes and proofs, pinning, Tailscale exposure | api, core, desktop | `apps/desktop/src-tauri/src/pair.rs` (desktop side) |
| `packages/media` | 29 / 2,119 | 40 / 4,342 | Image and video adapter protocols, durable JobRunner, OutputStore, ffmpeg | core, channel adapters | none (the engine's `src/media/` is media *embedding*, a different concern) |
| `packages/documents` | 16 / 1,834 | 9 / 462 | D100 document system: Markdown → HTML → PDF through Chromium `Page.printToPDF`; `pagedjs` 0.4.3 runs inside Chromium | core | none |
| `packages/module-api` | 21 / 2,141 | 27 / 2,436 | The public module SDK (ADR-016 §1): RPC client and server, framing, trust, adoption, manifest, orphan watch | core, api, channels-buzz, channels-matrix | `crates/plur1bus-rpc` (client, server transports, ACL, trust, capabilities) |
| `packages/embedding-adapters` | 27 / 1,853 | 25 / 2,601 | Remote embedding and rerank adapters; "Not connected to core or the engine" (`packages/embedding-adapters/README.md`) | nowhere (unwired) | `crates/plur1bus-engine/src/embedding/` (RE-03) |
| `packages/config-schema` | 9 / 1,367 | 42 / 2,608 | Config schema plus TS helpers (policy, sensitive, disclosure, secret references) | build, core, web | `crates/plur1bus-config` (3,847) |
| `packages/remote-fs` | 7 / 731 | 7 / 550 | Read-only local and SFTP file access for import discovery | core, desktop | `crates/plur1bus-remote-fs` (SFTP worker, 1,204) |
| `packages/hostctl` | 10 / 655 | 21 / 2,748 | D106 local file, process, app and clipboard control tools | core | none |
| `packages/log-schema` | 1 / 310 | 6 / 402 | D111 log schema, TS side | core | `crates/plur1bus-log-schema` (mirror, 809) |
| `packages/rpc-schema` | 1 / 141 | 26 / 1,516 | RPC schema (RPC 1.23.0, 305 `$defs`), generator, 508 contract fixtures | build | `crates/plur1bus-rpc` (`typify` 0.8 in `build.rs`) |
| `packages/webmcp` | 6 / 700 | 4 / 934 | Browser-side WebMCP mapping, no Node or DOM imports | the web GUI (browser) | n/a, stays TypeScript (§2.2) |
| `packages/module-fixture` | 1 / 19 | 1 / 93 | Test fixture module | tests | n/a |
| **Total non-UI** | **1,195 / 150,930** | **1,611 / 229,116** | | | |

Out of scope (UI, D129): `packages/web` (389 src files / 46,428 lines), `apps/desktop/ui` (48 / 2,674).
Growth matters: the RE plan counted the core at 66,631 lines in 559 files (rewrite plan §2.3); it is 99,994 in 794 two
weeks later (+50 %). The D129 freeze stops that growth; this plan's sizes assume it does.

### 1.2 `packages/core/src` by module, grouped by the package that ports it

Test counts are files under `packages/core/test/<dir>/`; top-level test files are named where they matter.

| Area (→ package) | Modules, src lines | Tests | Rust coverage today |
|---|---|---|---|
| Process, RPC front door (→ P4-10) | `core.ts` 1,541; `rpc/methods.ts` 647; `engine/` 636 (`EngineClient`, `select.ts`, host methods); `bin.ts` 153; `warmup.ts` 167; `platform.ts` 150; `logger.ts` 113; `paths.ts` 91; `events-map.ts` 91; `engine-host-ports.ts` 92; `activity*.ts` 81; `host.ts` 53; `join.ts` 42; `principal.ts` 39; `lock.ts` 14; `capabilities.ts` 5 — ≈3,900 | `rpc/` 22; `core*.test.ts`, `rpc-server`, `lock`, `paths`, `platform*`, `principal`, `join`, `events-map*`, `activity*`, `warmup`, `bin*`, `engine-*` | `crates/plur1bus-rpc` server transports (`server_transport_{unix,windows}.rs`), ACL, trust, capabilities; the engine and tools processes already serve authenticated RPC in Rust; supervisor adoption and lifelines |
| Config, logs, doctor (→ P4-11) | `config-{load,source,warnings,disclosure}.ts` 580; `engine-config.ts` 122; `logs/` 1,972; `metrics/` 440; `doctor-report.ts` 144 — 3,258 | `logs/` 28, `metrics/` 9, `config-*`, `engine-config*`, `doctor-report` | `crates/plur1bus-config`; `crates/plur1bus-log-schema`; `crates/plur1bus/src/audit_redact.rs` ("the Rust side of `packages/core/src/logs/redact.ts`"); `config_redaction.rs` |
| Identity, RBAC (→ P4-12) | `identity/` 1,049; `rbac/` 1,070; `memory-exposure/` 459; `memory-sensitivity/` 452; `privacy/` 171 — 3,201 | 14 · 13 · 3 · 2 · 4 | `crates/plur1bus/src/privacy.rs` (local-only admission, cross-language vectors) |
| Secrets (→ P4-20) | `secrets/` 1,664; `extensions/` 603; `secrets-isolated-bin.ts` 10 — 2,277 | 35 · 8 | none |
| Policy, egress, audit, attestation (→ P4-21) | `policy/` 1,441; `audit/` 763; `attestation/` 338; `egress/` 311 — 2,853 | 20 · 16 · 8 · 7 | `crates/plur1bus/src/audit_chain.rs` ("offline Rust writers share the core's chain and SQLite OS byte-range lock"); `crates/plur1bus-attest` |
| Approvals and adjacent stores (→ P4-22) | `approvals/` 2,144; `grants/` 581; `inbox/` 388; `delivery/` 190; `channel-handoff/` 172 — 3,475 | 20 · 11 · 3 · 4 · 3 | none |
| Auth (→ P4-23) | `auth/` 1,221; `openai-auth/` 660 — 1,881 | 14 · 11 | none |
| Budgets (→ P4-24) | `budget/` 1,224; `licences/` 68 — 1,292 | 16 · 2 | none |
| Executors (→ P4-30, P4-31) | `tools/exec` 588; `tools/fs` 534; `tools/web` 3,190; `sidecars/` 491; `host-tools/` 1,711 — 6,514 (`tools/sandbox` 760 is D123's) | `tools/` 42 (shared with P4-43), `sidecars/` 3, `host-tools/` 31 | `crates/plur1bus-tools` (D120 H1-1 skeleton: `tools.hello`, `tools.health`) |
| Sessions (→ P4-40) | `session/` 4,112 (store 962, migrations 220, compaction, pruning, rewind, checkpoints, turn loop 311 → P4-43) | `session/` 38 | none |
| Prompt, tool-call runtime, decision (→ P4-42) | `prompt/` 874; `toolcall/` runtime 1,603 (of 5,478; the other 3,875 are `coding-bench*` and `turn-eval*` tooling → P4-91); `decision/` 528; `triage/` 150 | 14 · 42 · 12 · 5 | none |
| Turn engine (→ P4-43) | `tools/` top level 1,717 (`dispatcher.ts` 571, registry, repair, approval, memory, mcp-bridge, a2a-transport, collaboration); `composition/` 3,856 (`provider.ts` 869, `index.ts` 684); `agents/` 655; `agents.ts` 162; `tools-service/` 437; `session/turn-loop.ts` 311 | `tools/`, `integration/` 3, `agents/` 3, `architecture/` 1 (`single-gate.test.ts`, D120 T1-a), `engine-inline-post-turn` | `plur1bus-tools` ticket gate (D120 §11.2, planned) |
| Discovery (→ P4-44) | `discovery/` 3,113; `catalog/` 613 | 34 · 7 | none |
| Collaboration and teams (→ P4-50) | `collab/` 3,394; `coding/` 1,005; `external-turn/` 405; `federation/` 301 | 52 · 7 · 1 · 2 | D124 transition function in `plur1bus-tools` (TK, PR #900) |
| Jobs and memory-facing paths (→ P4-51, after RE-10) | `dreams/` 2,754 (learn pass `dreams/learn/` 1,267); `media-search/` 1,541; `embedding-migrate/` 1,350; `system-jobs/` 547; `user-jobs/` 452; `journal.ts` 372; `knowledge/` 273; `skill-mining/` 266; `memory-ops.ts` 180; `backup-ops.ts` 161; `restore-reapply.ts` 115; `admin-ops.ts` 112; `replay.ts` 71; `memory-curation.ts` 54 | 28 · 26 · 15 · 7 · 7 · … | engine side through RE-05…RE-10; `crates/plur1bus/src/backup/` |
| Voice (→ P4-52) | `voice/` 1,210 | 18 | none |
| Channels (→ P4-60…P4-67) | `channels/` 1,879 (router, switchboard, bindings) | 28 | none |
| Protocols (→ P4-70…P4-72) | `mcp/` 4,006; `a2a/` 2,429; `external-agents/` 1,589 (containment and launcher are D123's); `acp/` 1,059 | 37 · 25 · 26 · 17 | D123 `plur1bus-sandbox` (planned) |
| Import (→ P4-85) | `import/` 19,963 (103 files); `extension-source-*.ts` 184 | 109 + fixtures | `crates/plur1bus-ext` (extension manifests, mcpb and Claude formats), `crates/plur1bus-remote-fs` |
| RPC surfaces (move with their subsystem) | `rpc/*-surface.ts` and the rest of `rpc/` 2,891 | in `rpc/` 22 | — |

### 1.3 Rust crates today

| Crate | src files / lines | Role | Relevance for Phase 4 |
|---|---|---|---|
| `crates/plur1bus` | 230 / 104,423 | CLI, supervisor (`src/supervisor/`, 21,265), installer and updater, backup, audit chain writer, 1staid | Supervisor slots `core`, `tools`, `api`, `module` (`src/supervisor/state.rs:383-386`, `child.rs:76,101,150`); spawns Node entries by path (`commands/core.rs:64`, `acp.rs:21`, `mcp.rs:20`, `import.rs:30`, `ext/source_fetch.rs:22`) |
| `crates/plur1bus-engine` | 170 / 45,437 | Memory engine (RE programme): authenticated process server, Lance and SQLite stores, embeddings, recall, tokens, media embedding | Stays the memory process; `src/tokens/` is extracted into a shared crate by P4-03 (D120 §12.3) |
| `crates/plur1bus-tools` | 4 / 1,252 | D120 tools service: `tools.hello`, `tools.health`, core-only guard, `run/tools.sock` | Stays the low-privilege executor process (§2.1); grows with D120, D123, D124 |
| `crates/plur1bus-rpc` | 13 / 4,507 | Generated RPC types (`typify`), client, server transports, ACL, trust, capabilities filter (`src/capabilities.rs:28`) | The base of the Rust front door; gains a generated server dispatch trait (P4-03) |
| `crates/plur1bus-config` | 8 / 3,847 | Config validation, resolution, references, disclosure, sensitive keys | Reused by P4-11 |
| `crates/plur1bus-ext` | 24 / 6,379 | Extension packs: manifests, mcpb and Claude formats, verify, zip audit | Reused by P4-70 (extensions) and P4-85 (import) |
| `crates/plur1bus-containers` | 10 / 2,245 | Container sidecars (Docker, Apple container) | Unchanged |
| `crates/plur1bus-remote-fs` | 7 / 1,204 | SFTP worker process | Reused by P4-85 |
| `crates/plur1bus-attest` | 8 / 1,125 | OS attestation helper (Touch ID, Windows Hello, polkit), JSON over stdin/stdout | Reused by P4-21 |
| `crates/plur1bus-log-schema` | 1 / 809 | D111 log schema mirror | Reused by P4-11 |
| `apps/desktop/src-tauri` | 89 / 41,948 | Desktop shell (Tauri) | Unchanged; loses the Node payload in P4-90 |

### 1.4 The seams that exist today

| Seam | What crosses it | Evidence | Phase 4 use |
|---|---|---|---|
| `x-server: "core"` | 352 methods and their notifications (8 `stable`), served by the TS core on `run/core.sock` or the per-home pipe | schema at RPC 1.23.0 | The front door: the Rust core takes the socket and serves these methods natively or relays them (§2.4) |
| `x-server: "engine"` | 68 methods, core → engine through `EngineClient` (`packages/core/src/engine/client.ts`), chosen by `engine.implementation` (`engine/select.ts:9-12`; default `"node"`, `config.schema.json:2620`) | RE-08 | Unchanged; RE-11 removes the Node branch |
| `host.*` | 6 methods the core serves to the engine: `host.llm.complete`, `host.egress.decide`, `host.secret.get`, `host.workspaceDir`, `host.event`, `host.journalBacklog` (`x-server: "core"`, 1.7.0) | schema | Relayed first, native as their subsystems move (P4-21, P4-20, P4-41) |
| `x-server: "tools"` | `tools.hello`, `tools.health` (1.15.0); planned `tools.team.*` (TK), `tools.sandbox.*` (D123 SB-4), artifacts and ACI (D120 H1-2…C3) | `crates/plur1bus-tools/src/lib.rs`, `packages/core/src/tools-service/client.ts` | The executor seam; the Rust core becomes its caller in P4-43 |
| `x-server: "supervisor"`, `"module"` | 36 and 4 methods | schema | Unchanged; the supervisor gains the `core-legacy` slot for the transition |
| Node entry points chosen by the CLI | `core.js`, `acp.js`, `mcp.js`, `import.js`, `extension-source.js` | `crates/plur1bus/src/commands/*.rs` lines above | Each is replaced by a Rust subcommand without client changes |
| Helper processes | `secrets-isolated-bin` over Node IPC (`secrets/isolated-backend.ts:17`), `plur1bus-attest`, `plur1bus-remote-fs`, sandbox limits | as named | Kept as process boundaries, re-implemented or reused in Rust |
| HTTP API for the UIs | web → `/rpc`, `/events`, REST routes (`packages/web/src/api/routes.ts:5`); desktop WebView → Tauri → HTTP (`apps/desktop/src-tauri/src/client.rs:635,661`); the web imports generated RPC types (10 files, e.g. `packages/web/src/pages/chat/rpc-types.ts`) | `docs/api-surface.md` (generated from `packages/api/src/routes.ts`) | The UI contract (§2.3) |
| Contract fixtures | 508 files in `packages/rpc-schema/fixtures/` (methods, errors, notifications, capabilities per server), read by the TS server tests and the Rust client tests (`crates/plur1bus-rpc/tests/capabilities.rs:14`) | ADR-012 §2 | Parity gate G1 |
| System tests | 30 suites in `tests/system/`, the core started from `PLUR1BUS_CORE_JS` (`tests/system/helpers.ts:8,74`) | | Parity gate G2 with `PLUR1BUS_CORE_IMPL` |

### 1.5 Programme state Phase 4 orders around (at the base commit)

- **RE:** RE-00…RE-03 merged; RE-04 T0–T5 merged, T6 pending; RE-08 T1–T3 merged; RE-14 partial; RE-05, RE-06, RE-07,
  RE-09, RE-10, RE-11, RE-13 not started (status table of `rust-engine/README.md`, commit subjects on `main`). 0.1 needs
  RE-11 (Node engine retired) as much as it needs this plan.
- **D120:** H1-1 merged (crate, slot, client), T1-a merged (`packages/core/test/architecture/single-gate.test.ts`), the
  `plur1bus code` CLI and TUI present (`crates/plur1bus/src/commands/code/`); H1-2…H1-4, C1–C4, H3, H4 not on `main`
  (no artifact code in `crates/plur1bus-tools/src/`). Judged from file presence, not from a status ledger.
- **ADR-019** (decided text in D120 §13) is not yet a file: `docs/adr/` ends at ADR-017.
- **D123:** not started (`crates/plur1bus-sandbox` absent); it starts after #820.
- **D124:** TK open as PR #900; `tools.team.*` not on `main`.
- **D122:** AF1 and AF2 merged in TypeScript; AF3–AF5 planned (AF5 in TypeScript).

---

## 2. Target architecture for 0.1

### 2.1 Processes and what each owns

```text
 OS service manager
  └─ plur1bus supervise  (Rust, unchanged)
       ├─ engine       plur1bus-engine  Rust · memory only (RE programme)                 x-server "engine"
       ├─ core         plur1bus-core    Rust · NEW · the front door on run/core.sock       x-server "core"  (+ "bridge" while Phase 4 runs)
       ├─ tools        plur1bus-tools   Rust · low-privilege executor, no secrets          x-server "tools"
       ├─ api          plur1bus-api     Rust · NEW · HTTP for web and desktop              client of "core"
       ├─ core-legacy  node core.js     TypeScript · only during Phase 4, behind the front door; deleted by P4-90
       └─ sidecars, modules             apple-fm (AF3), SearXNG, third-party modules
 plur1bus <cmd> (Rust CLI) ──────────── run/core.sock ──► plur1bus-core
 web SPA (TypeScript) ── HTTPS ──► plur1bus-api ── run/core.sock ──► plur1bus-core
 desktop WebView (TypeScript) ── Tauri IPC ──► src-tauri (Rust) ── HTTP ──► plur1bus-api
```

| Process | Owns | Privilege | Why its own process |
|---|---|---|---|
| `plur1bus-core` (new crate `crates/plur1bus-core`, lib + bin) | `run/core.sock`/pipe, `run/core.token`, the core lock; every `x-server: "core"` method; identity, RBAC, sessions and turns, prompt builder, providers and their credentials, tool dispatcher, D109 policy, approvals, audit append, secrets and the redactor, budgets, channels switchboard and adapters, MCP/ACP/A2A, collab and the team shell (state store, outbox, action execution), jobs, discovery, voice broker, media jobs; the `host.*` callbacks for the engine | Holds secrets and all core stores | The core role of ADR-012, now in Rust |
| `plur1bus-tools` | Executors that touch files and processes on a dispatcher ticket: `exec`, `fs`, host tools and `hostctl`, sandbox (D123), artifacts, crushers and the coding ACI (D120), the pure team transition function and router (D124) | Granted roots and `state/artifacts/` only; **no secrets** (D120 §5 invariant kept) | Fault and privilege isolation (D120 §12.3); the T1 ticket stays a real cross-process check |
| `plur1bus-engine` | Memory (RE) | Its stores | Unchanged |
| `plur1bus-api` (new crate `crates/plur1bus-api`) | The network-exposed HTTP surface: API sessions, CSRF, rate limits, OAuth authorization server, desktop pairing, `/rpc` relay, `/events` SSE, static SPA | No provider credentials | It is the exposed process (LAN, Tailscale); keeping it out of the core keeps the secret boundary of ADR-012 §1 |

**Recommendation against D120 Q3's wording.** D120 §12.3 says `plur1bus-tools` "becomes the Rust core process (renamed
when step 3 moves sessions and turns into it)". This plan keeps them apart: a separate `plur1bus-core` keeps D120 §5's
"secrets never enter the new process" true, keeps the tools sandbox profile (granted roots only) meaningful, keeps the
C code of the tree-sitter grammars (C2, C3) out of the process that holds sessions and keys, and keeps the T1 ticket a
cross-process check. The cost is one small Rust process (no Node heap). Owner question Q2. The team transition function
is pure (D124 §6.3: no clock, no I/O, no secrets), so `plur1bus-core` links it as a library after P4-50 instead of paying
an RPC hop; `tools.team.next` stays served until TK's tests move.

**Crate layout.** `plur1bus-core` is one crate with modules (`server`, `relay`, `identity`, `rbac`, `secrets`,
`policy`, `approvals`, `sessions`, `prompt`, `turn`, `collab`, `jobs`, `voice`, `media`, `mcp`, `acp`, `a2a`, …).
Separate crates only where there is a second consumer or a heavy optional dependency: `plur1bus-store` (SQLite
conventions, shared with the engine where it fits), `plur1bus-tokens` (extracted from the engine, D120 §12.3),
`plur1bus-audit` (the chain writer moved out of `crates/plur1bus/src/audit_chain.rs` so CLI and core share it),
`plur1bus-providers` (wire formats; also used by the eval tooling), `plur1bus-channels` (one feature per adapter, so
`matrix-sdk-crypto` compiles only when the Matrix feature is on).

### 2.2 What stays TypeScript, and why

| Item | Decision | Reason |
|---|---|---|
| `packages/web`, `apps/desktop/ui` | TypeScript | D129 |
| `packages/webmcp` | TypeScript | Runs in the browser with the web GUI; no Node imports |
| TS types generated from the schemas (`packages/rpc-schema/src/build.mjs` → `generated/`; the TS helpers of `config-schema` the web uses) | TypeScript, build time only | The web needs them; the JSON schemas stay the single source |
| `packages/module-api` | TypeScript, as a published SDK | Public surface (ADR-016 §1) for third-party TS modules; the harness runtime stops using it after P4-80 (Q7) |
| Tests and tooling: `tests/system/` (black-box, drives binaries over RPC and HTTP), `scripts/` (docs, CI, release), the eval drivers (`toolcall/coding-bench*.ts`, `turn-eval*.ts`, 3,875 lines, moved to `scripts/eval/` by P4-91) | TypeScript | Not harness runtime; Node stays a build and test tool (D120 §12.1) |
| `pagedjs` inside `packages/documents` | JavaScript asset | It is a browser script injected into Chromium; the driver (CDP, Markdown, templates, checks) moves to Rust in P4-53 |
| Provider "SDK glue" | **Rust** | There is none: `packages/providers` has no runtime dependency; the wire formats are hand-written and port with recorded fixtures |
| MCP, A2A, Matrix, Nostr SDKs | **Rust** | MCP: `rmcp`, the official Rust SDK (D120 §12.5; age window checked in P4-01). A2A: hand-written against the schema like ACP. Matrix: `matrix-sdk-crypto` (the WASM package is this crate compiled). Nostr: a Rust crate if its licence passes `deny.toml`, otherwise the NIP-01 subset by hand |
| Apple Foundation Models (D122) | **Rust** | AD10 put AF1, AF2 and AF5 in TypeScript because they extended existing TypeScript packages, "no new component". D129 removes that reason. AF1 (Unix-socket transport, a few hundred lines) and AF2 (guard: the same `lstat`/uid/0700 checks as `packages/core/src/apple-fm/socket.ts`) port inside P4-41 and P4-43; AF5 (not started) is re-planned in Rust inside P4-42 (Q6) |
| Local ML bound to Node: local voice (`sherpa-onnx-node`) and local Florence-2 captions (transformers.js, `media-search/caption/local.ts:50-53`) | Not in 0.1 (recommended) | Cloud and remote providers cover both features in 0.1; the doctor row explains; P4-93 ports both onto `ort` (already in the engine, `load-dynamic`, RE-D3b) after 0.1 (Q5). The alternative, a Node sidecar, keeps Node in the runtime payload |

### 2.3 How the web UI and the desktop UI talk to a Rust core

- **The path does not change.** Neither UI talks to the core: the web calls the Harness API (`/rpc`, `/events`, REST
  routes), the desktop WebView calls its Tauri shell, which calls the API over HTTP. Replacing the core, and later the
  API, is invisible to both as long as three artefacts hold:
  1. **The RPC schema** (`packages/rpc-schema/schema/rpc.schema.json`). Rust types come from `typify` in
     `crates/plur1bus-rpc/build.rs` (ADR-012 §2), TypeScript types from `json-schema-to-typescript` for the web. P4-03
     adds to `build.rs` a generated server dispatch trait for every `x-server: "core"` method (method → params type →
     result type), so the Rust core cannot serve an undeclared method or return an undeclared shape, and it keeps ADR-012
     §2's rule that every result is validated before it is sent (`E_INTERNAL reason=result-schema`); P4-01 measures the
     validation cost on hot methods.
  2. **The notification schemas** (ADR-016 §6), delivered through `/events`: unchanged.
  3. **The HTTP route table.** Today it is TypeScript code (`packages/api/src/routes.ts`, rendered by
     `scripts/gen-openapi.mjs` into `docs/openapi.json` and `docs/api-surface.md`). P4-80a turns it into data
     (`packages/api/schema/routes.json`), read by the Rust router's `build.rs` and by `gen-openapi.mjs`; `pnpm docs:check`
     keeps the generated docs honest.
- **ADR-016 holds without exceptions.** No public method changes its `x-server`: the Rust process *is* the core, so
  every public method stays `"core"` whether it is served natively or relayed (§2.4). `core.auth`'s `capabilities` are
  built from the schema by `crates/plur1bus-rpc/src/capabilities.rs`; during the transition they list the union of the
  natively served and the relayed methods. Contract fixtures run against both implementations (gate G1).
- **The desktop shell** changes only in P4-90 (no Node payload in the bundle).

### 2.4 The strangler mechanism: front door, relay, bridge

1. **Front door (P4-10).** `plur1bus-core` takes `run/core.sock` or the pipe, `core.auth`, the core lock, the run files
   and adoption. The TypeScript core keeps running as `core-legacy` on `run/core-legacy.sock`, reachable only with a
   front-door credential. A method the Rust core does not serve yet is **relayed**: the front door authenticates the
   client, then forwards the call with the client's authenticated context (principal kind, identity, trust level) to
   the legacy core, which still runs its own RBAC guard. Notifications from the legacy core are re-published through
   the front door's `events.subscribe` fan-out (audience filter of ADR-012 §3 kept).
2. **Flip.** A package that ports a subsystem moves its methods from the relay set to the native set in the front
   door's method table. The schema does not change.
3. **Bridge.** Where remaining TypeScript needs a ported subsystem (the TS dispatcher needs the Rust policy evaluator,
   for example), it calls a `bridge.*` method on the front door: `x-server: "bridge"`, callable only by the
   `legacy-core` principal, `x-stability: "experimental"`, `x-deprecated` with `removeAfter` set to the 0.1 cut. The
   bottom-up order keeps the opposite direction (Rust → TypeScript) to one family, `legacy.tool.execute` (P4-43), for
   tool executors that are still TypeScript once the dispatcher is Rust; it is ticket-gated like D120 §11.2, with the
   ticket now minted by Rust.
4. **Ledger.** `docs/phase4/bridge.md` lists every `bridge.*` and `legacy.*` method with the package that removes it;
   P4-90 requires the list to be empty.

D120 §12.4 proposed client-side routing by capabilities ("when a method moves, only its `x-server` changes"). For the
transition this plan prefers the server-side relay: every client (CLI, API, desktop, Python client, module SDK) would
otherwise need multi-endpoint routing, and the RBAC guard would exist twice during the transition. Owner question Q3.

---

## 3. Work packages in dependency order

**Notation.** Size in agent days (calibration in §5.4); risk L/M/H. Each package names its TypeScript source, its Rust
target, the TypeScript tests that become parity vectors and how they run against Rust, its prerequisites, size and risk.
Every package ends with the three-PR switch-over of §4.4 (implement, flip, cut); "Executor" is a Claude agent for every
Rust package; the small TypeScript seam cuts and vector exporters inside a package are the controller's choice (Q12).

**Parity modes** (built by P4-02, used by every package):
- **V — vectors.** A pure-function TS test becomes a vector set: an exporter (`scripts/parity/export-<area>.ts`) runs the
  TS function over the test's inputs and writes `fixtures/parity/<area>/*.json`; Rust `#[test]`s read them. Recorded by
  the exporter, never edited by hand (the RE-R1 rule); after the cut the vectors stay as frozen Rust regression data.
- **T — transcripts.** An RPC-level TS test becomes a transcript: the recorder in the TS `RpcServer` (behind the existing
  `PLUR1BUS_ALLOW_TEST_INTERNALS=1` seam, fake clock and ids) writes request, response and notification lines; the
  runner replays them against the Rust core with normalisers for ids and timestamps.
- **S — system.** `tests/system/` runs with `PLUR1BUS_CORE_IMPL=ts|rust`; both legs green.
- **W — wire.** HTTP and WebSocket exchanges of the TS fake servers are recorded into fixtures and served by a small
  Rust fake server, so Rust tests never need Node.
- **B — stores.** The same `node:sqlite` file: TS writes, Rust reads and writes, TS reads again, at every schema
  version; after the cut, committed sample databases per version.

A TS test file that maps to none of V, T, S, W or B is listed in the package's PR with its reason (drop or covered
elsewhere); `MODULE-MAP.md` (P4-02) tracks it.

```text
 A  P4-00 decision record + freeze guard        P4-01 spike ─► P4-03 skeleton, shared crates
    P4-02 parity harness ─────────────────────────────────┬──┘
 B                                                         ▼
    P4-10 front door + relay ─► P4-11 config, logs ─► P4-12 identity, RBAC
 C  P4-12 ─► P4-20 secrets ─► P4-23 auth
     └─────► P4-21 policy, egress, audit ─► P4-22 approvals, grants, inbox      P4-24 budgets (after P4-12)
 D  P4-21 + P4-22 (+ D120 T1-b) ─► P4-30 exec, fs, web ─► P4-31 host tools
 E  P4-12 ─► P4-40 sessions        P4-03 ─► P4-41 providers (library first; flips after P4-20, P4-23) ─► P4-42 prompt, toolcall
    P4-22, P4-24, P4-30, P4-40, P4-41, P4-42 ─► P4-43 dispatcher + turn loop ─► P4-44 discovery (library may start after P4-41)
 F  P4-43 (+ TK merged, D123 SB-6) ─► P4-50 collab, teams
    P4-43 (+ RE-10 T1–T6 engine sides) ─► P4-51 jobs, memory forwards        P4-43 ─► P4-52 voice, P4-53 media, documents
 G  P4-03 ─► P4-60…P4-66 adapters (libraries, in parallel) ─► P4-67 switchboard flip (after P4-43, P4-22, P4-53)
 H  P4-43 ─► P4-70 MCP          P4-43 + D123 SB-6 ─► P4-71 ACP          P4-43 + P4-22 ─► P4-72 A2A
 I  P4-10 + P4-12 ─► P4-80a ─► P4-80b ─► P4-80c ─► P4-80d (after P4-70, P4-72)          (Q1: may stay TS for 0.1)
    P4-12 + P4-20 + P4-44 ─► P4-85 import                                                (Q1: may stay TS for 0.1)
 J  all flips + RE-11 ─► P4-90 legacy removal          P4-43 ─► P4-91 eval tooling relocation
```

Libraries can be written ahead of their flip (P4-41, P4-44, the channel adapters); a flip waits for its prerequisites.
That is what keeps two implementers busy without breaking the "runs at every step" rule.

### Track A — foundations

#### P4-00 — Decision record and the freeze guard (1 agent day; risk L)
- **Scope.** Write `docs/adr/ADR-019-rust-new-components-and-core-strangler.md` with the decided D120 §13 text plus an
  "Amendment D129" section (no TypeScript fixes; 0.1 on Rust; UI stays TypeScript; new core packages in Rust; Node engine
  frozen; supersedes ADR-019 (3), "changes to existing TypeScript code … stay TypeScript until their subsystem's Phase 4
  step"); if D120 WP0 lands first, only the amendment. ADR-012 amendment note; RE plan §6 RE-D9 row "superseded"; RE-12
  marked superseded (Q10); D129 in the register (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`
  §2); AGENTS.md rows for `packages/core` and the non-UI packages: "frozen (D129)". A CI script
  `scripts/ci/phase4-freeze.mjs` in `ci-gate`: a PR that changes `src/` of a non-UI TypeScript package must carry a
  commit trailer `Phase4: seam <WP> | cut <WP> | vectors <WP> | running-work <TK|LP> | generated`, otherwise it fails.
- **Source.** D120 §13, D129. **Target.** `docs/adr/`, `scripts/ci/phase4-freeze.mjs` (+ `.test.mjs`), `docs/ci.md`.
- **Parity.** n/a; the script gets node tests like `scripts/ci/gate.test.mjs`.
- **Prerequisites.** None.

#### P4-01 — Phase 4 spike (2 agent days; risk M)
- **Scope.** The D120 P4-spike, narrowed to what 0.1 needs. On a throwaway branch, for the five release targets: build,
  `cargo deny check`, binary size, cold start and idle RSS of a skeleton core. Candidates: `tokio` (already locked through
  the engine), `axum`/`hyper` for the API, `rmcp`, `matrix-sdk-crypto`, a Nostr crate, `keyring` (OS keychains, replaces
  `secrets/keyring-backend.ts`), streaming SSE on the workspace's one HTTP client policy
  (rustls, no native-tls, comment in `crates/plur1bus-engine/Cargo.toml`). Store compatibility: the SQLite that Node
  24.21's `node:sqlite` bundles against `rusqlite`'s bundled SQLite on the same files (FTS5 tokenizers, WAL, `user_version`,
  JSON functions). Result-validation cost (`jsonschema`, already a dependency) on the ten hottest methods.
- **Source.** D120 §12.5 table. **Target.** `docs/research/<date>-phase4-spike.md` and a re-estimate of §5.
- **Parity.** n/a. **Prerequisites.** None.

#### P4-02 — Core parity harness and module map (3.5 agent days; risk M)
- **Scope.** The five parity modes above: the transcript recorder and replayer (`tests/core-parity/`), the
  `PLUR1BUS_CORE_IMPL` switch in `tests/system/helpers.ts` (the `rust` leg starts `plur1bus-core` with `core-legacy`
  behind it), the exporter convention (`scripts/parity/`), the store round-trip helper, a Rust fake HTTP/WS server for W
  fixtures; a CI job `core-parity`, advisory until P4-10 flips and then a dependency of `ci-gate` (the promotion rule of
  `docs/ci.md`). `docs/superpowers/plans/phase4/MODULE-MAP.md`, generated by `scripts/parity/module-map.mjs`: every
  `src` file of `packages/core` and the other non-UI packages → package, disposition (port, fold, drop, engine,
  stays-TS), and every test file → parity mode (the RE MODULE-MAP pattern).
- **Source.** `tests/system/helpers.ts`, `packages/core/test/helpers/` (14 files), RE-09's runner design.
- **Target.** `tests/core-parity/`, `scripts/parity/`, `crates/plur1bus-core/tests/support/`.
- **Parity.** Self-test: record and replay the TS core against itself; every existing `tests/system` suite green on `ts`.
- **Prerequisites.** None (works against the TS core first).

#### P4-03 — Skeleton and shared crates (3 agent days; risk L)
- **Scope.** `crates/plur1bus-core` (lib + bin `plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]`);
  the generated server dispatch trait in `crates/plur1bus-rpc/build.rs`; `crates/plur1bus-store` (rusqlite, WAL,
  `BEGIN IMMEDIATE` single writer, `busy_timeout` 5 s, a migration runner that reads the TS stores' `user_version`);
  `crates/plur1bus-tokens` extracted from `crates/plur1bus-engine/src/tokens/` (engine depends on it, D120 §12.3);
  `crates/plur1bus-audit` moved out of `crates/plur1bus/src/audit_chain.rs`; canonical JSON and `actionHash`.
- **Parity.** V: canonical JSON and `actionHash` vectors exported from `packages/core/src/tools/dispatcher.ts` (the T1
  parity vectors D120 §11.2 already asks for); the token goldens `tests/engine-parity/goldens/tokens/` unchanged.
- **Prerequisites.** P4-01.

### Track B — the front door

#### P4-10 — Front door, relay, legacy demotion (7 agent days; risk H)
- **Scope.** `plur1bus-core` owns `run/core.sock` (0700 directory, 0600 socket, stale-socket probe) and the Windows pipe
  with an explicit SDDL like the supervisor's (`crates/plur1bus/src/supervisor/pipe_windows.rs`; this closes ADR-012
  deviation C2, the Node default pipe DACL), `run/core.token` (32 random bytes, constant-time compare), pid file, the core
  lock (same SQLite byte-range lock as `audit_chain.rs`), `core.auth|status|state|shutdown|adopt`, capabilities (union of
  native and relayed), `events.subscribe|unsubscribe` fan-out with audiences, the drain order of ADR-012 §3 (G17),
  16 MiB back-pressure, 4 MiB lines; the relay to `core-legacy` with the forwarded caller context; `bridge.hello`; the
  `host.*` callbacks relayed. Supervisor: the `core` slot spawns `plur1bus-core`; a `core-legacy` slot spawns `node core.js
  --behind-front-door` and is adopted under it. The TS core gets the seam to run behind the front door (trailer `seam P4-10`).
- **Source.** `packages/core/src/core.ts`, `bin.ts`, `lock.ts`, `paths.ts`, `platform.ts`, `principal.ts`, `join.ts`,
  `capabilities.ts`, `events-map.ts`, `activity*.ts`, `warmup.ts`, `logger.ts`, `rpc/methods.ts`, `engine/`; the server
  half of `packages/module-api` (`rpc-server.ts`, `framing.ts`, `trust.ts`, `control-server.ts`, `orphan-watch.ts`,
  `adoption.ts`) — ≈3,900 lines in the core plus ≈1,200 in module-api.
- **Target.** `crates/plur1bus-core/src/{server,relay,auth,lock,run_files,events,lifecycle}.rs`,
  `crates/plur1bus/src/supervisor/{child,state}.rs`.
- **Parity.** T: `packages/core/test/rpc/` (22 files), `rpc-server`, `core.test.ts`, `core-drain`, `core-run-acl`,
  `core-supervised`, `lock`, `paths`, `platform*`, `principal`, `join`, `events-map*`, `event-audience-sse`,
  `activity*`, `warmup`, `bin*`; G1 over the 508 contract fixtures; S: every `tests/system` suite on both legs, with
  `reconnect`, `kill-soak`, `config-restart`, `help-isolation`, `modules` and `redaction-everywhere` named in the PR.
  The Windows leg of these tests is gating for this package (see R4).
- **Prerequisites.** P4-02, P4-03.

#### P4-11 — Configuration, logs, doctor, metrics (4 agent days; risk M)
- **Scope.** Config load and watch, restart classes (ADR-013), disclosure, config warnings; the D111 log sink, query,
  redaction and secret matchers; metrics; the doctor report rows the core produces.
- **Source.** `config-{load,source,warnings,disclosure}.ts`, `engine-config.ts`, `logs/`, `metrics/`,
  `doctor-report.ts` — 3,258 lines.
- **Target.** `plur1bus-core/src/{config,logs,metrics,doctor}/`, reusing `plur1bus-config`, `plur1bus-log-schema` and the
  redaction of `crates/plur1bus/src/audit_redact.rs`.
- **Parity.** V: redaction and secret-form matchers, config fixtures (`packages/config-schema/fixtures/`); T: `logs.*`,
  `doctor` methods; tests `logs/` 28, `metrics/` 9, `config-*`, `engine-config*`, `doctor-report`; S `config-restart`.
- **Prerequisites.** P4-10.

#### P4-12 — Identity, RBAC, principals, memory exposure (5.5 agent days; risk H)
- **Scope.** Principals and identity linking, role presets and object rights (one writer, last-owner checks inside
  `BEGIN IMMEDIATE`), the RBAC guard and break-glass, memory exposure and sensitivity, local-only privacy. From here on a
  native method is authorized in Rust; the legacy core keeps re-checking relayed calls until the cut (defence in depth).
- **Source.** `identity/`, `rbac/`, `memory-exposure/`, `memory-sensitivity/`, `privacy/` — 3,201 lines, plus their
  `rpc/*-surface.ts`.
- **Target.** `plur1bus-core/src/{identity,rbac,exposure}/`.
- **Parity.** V: the RBAC decision table and exposure resolution; T: `identity.*`, `user.*`, `breakglass.*`; B: the
  identity store; tests `identity/` 14, `rbac/` 13, `privacy/` 4, `memory-exposure/` 3, `memory-sensitivity/` 2;
  S `identity`.
- **Prerequisites.** P4-10.

### Track C — the safety core (D120 §12.2 step 1, without the dispatcher)

The dispatcher itself moves with the turn loop (P4-43). Porting policy, approvals and audit first gives the safety
value D120 put first, while the TS dispatcher calls them through `bridge.*`, so no Rust code has to call TypeScript yet.

#### P4-20 — Secrets and the redactor (4 agent days; risk H)
- **Scope.** Secret backends (file, OS keychain, memory), secret references and leases, acquisition, audit, the isolated
  backend process (kept as a process boundary: `plur1bus-core secrets-helper` on an inherited pipe replaces
  `secrets-isolated-bin.ts`), the redactor for every outbound chunk, the A7 extension secret handling (revoking local MCP
  authority on a secret commit). `host.secret.get` becomes native. D120 §5's rule moves with it: the redactor runs in
  `plur1bus-core`, `plur1bus-tools` still sees only redacted bytes.
- **Source.** `secrets/` 1,664, `extensions/` 603, `secrets-isolated-bin.ts` — 2,277 lines.
- **Target.** `plur1bus-core/src/secrets/`, the `keyring` crate if P4-01 clears it.
- **Parity.** V: redaction and secret-form vectors (shared with P4-11); T: `secret.*`; tests `secrets/` 35,
  `extensions/` 8; S `secrets`, `redaction-everywhere`. Bridge: `bridge.secret.*` for TS consumers.
- **Prerequisites.** P4-12.

#### P4-21 — D109 policy, egress, audit append, attestation (4 agent days; risk H)
- **Scope.** The policy evaluator (pure, per-OS path canonicalisation, effects, headless mode), the egress gate and
  model-download policy, audit append through `plur1bus-audit`, OS attestation through `plur1bus-attest`.
  `host.egress.decide` becomes native.
- **Source.** `policy/` 1,441, `audit/` 763, `attestation/` 338, `egress/` 311 — 2,853 lines.
- **Target.** `plur1bus-core/src/{policy,egress,audit,attestation}/`.
- **Parity.** V: decision vectors per OS (differential, as D120 §12.2 step 1 asks), egress classification; T: `audit.*`,
  `egress.*`; tests `policy/` 20, `audit/` 16, `attestation/` 8, `egress/` 7, `b9-no-syscalls`. Bridge:
  `bridge.policy.decide`, `bridge.egress.decide`, `bridge.audit.append` for the TS dispatcher until P4-43.
- **Prerequisites.** P4-12, P4-03 (`plur1bus-audit`).

#### P4-22 — Approvals, grants, inbox, delivery, channel hand-off (5 agent days; risk H)
- **Scope.** The D109 approval service and store (chain, signing keys, integrity job, notifications, wire), grants,
  the inbox and its producers, delivery policy, channel hand-off.
- **Source.** `approvals/` 2,144, `grants/` 581, `inbox/` 388, `delivery/` 190, `channel-handoff/` 172 — 3,475 lines.
- **Target.** `plur1bus-core/src/{approvals,grants,inbox,delivery,handoff}/`.
- **Parity.** B: approvals, grants, inbox and hand-off databases; T: `approval.*`, `grant.*`, `inbox.*`, `delivery.*`;
  tests `approvals/` 20, `grants/` 11, `inbox/` 3, `delivery/` 4, `channel-handoff/` 3; S `admin`. Bridge:
  `bridge.approval.*` for the TS dispatcher.
- **Prerequisites.** P4-21.

#### P4-23 — Auth ladder, credential pool, OAuth clients (3.5 agent days; risk H)
- **Scope.** The provider auth ladder (ADC, env, profiles, refresh, pool), OpenAI sign-in (loopback, federated and
  workload identity), usage records.
- **Source.** `auth/` 1,221, `openai-auth/` 660 — 1,881 lines.
- **Target.** `plur1bus-core/src/auth/`.
- **Parity.** V: ladder decisions; W: token and refresh exchanges; T: `auth.*`; tests `auth/` 14, `openai-auth/` 11.
- **Prerequisites.** P4-20.

#### P4-24 — Budgets and usage (2.5 agent days; risk M)
- **Scope.** Call budgets, periods, retries, cache-read weight (RE-D29 setting), subagent caps, media budgets, peer
  budgets, the shared model-licence ledger.
- **Source.** `budget/` 1,224, `licences/` 68, `rpc/session-usage.ts` — ≈1,350 lines.
- **Target.** `plur1bus-core/src/budget/`.
- **Parity.** B: the budget store (`usage_event`); T: `budget.*`; tests `budget/` 16, `budget-rpc`, `licences/` 2.
- **Prerequisites.** P4-12.

### Track D — execution (D120 §12.2 step 2)

#### P4-30 — `exec`, `fs` and `web` tools (6.5 agent days; risk M)
- **Scope.** `exec.run` (allowlisted programs, no shell, stream caps) and the `fs` tools move into `plur1bus-tools` as
  executors behind the T1-b typestate gate (`UnverifiedAction` → `Gate::verify` → `ApprovedAction`, D120 §11.2); the
  `web.*` tools (fetch, robots, HTML extraction, IP classification against SSRF, search providers, the SearXNG router)
  run in `plur1bus-core` behind the egress gate. `tools/sandbox/` is D123's (SB-3 ports `seatbeltProfile()` and
  `backendArgv()` from `tools/sandbox/backends.ts`): referenced, not duplicated.
- **Source.** `tools/exec/` 588, `tools/fs/` 534, `tools/web/` 3,190, `sidecars/` 491 — 4,803 lines.
- **Target.** `crates/plur1bus-tools/src/{exec,fs}/`, `plur1bus-core/src/tools/web/`.
- **Parity.** V: `tools/web/ip.ts` classification, robots rules, HTML extraction goldens, exec argv and env filtering;
  W: fetch and search exchanges; tests: the exec, fs and web files of `tools/` (part of 42), `sidecars/` 3. The TS
  dispatcher calls `tools.exec.*` and `tools.fs.*` with tickets (the path D120 H1-4 described) until P4-43.
- **Prerequisites.** P4-21, P4-22, D120 T1-b (2 days, D120's package, not counted here).

#### P4-31 — Host tools and `hostctl` (3.5 agent days; risk M)
- **Scope.** D106 host tools (apps, clipboard, notify, packages, processes, system) and `packages/hostctl` (atomic file
  ops, process pool, search) as `plur1bus-tools` executors.
- **Source.** `host-tools/` 1,711, `packages/hostctl/src/` 655 — 2,366 lines.
- **Target.** `crates/plur1bus-tools/src/host/`.
- **Parity.** V: classification and deny-list vectors; tests `host-tools/` 31, `packages/hostctl/test/` 21 (fake
  policy, process and platform ports become Rust test doubles); the optional native Trash smoke stays opt-in.
- **Prerequisites.** P4-30.

### Track E — sessions and turns (D120 §12.2 step 3)

#### P4-40 — Session store and maintenance (5.5 agent days; risk H)
- **Scope.** The session store on the same file and schema (v9, WAL, single writer, FTS5 on messages and titles,
  append-only messages and events, `tool_visibility` overlays, `session_tool_offers`, `prompt_snapshots`), migrations,
  compaction, pruning, checkpoints and retention, rewind (and D120 H4's rewind with lesson if re-planned here, Q6),
  chat-model view, context fit. The flip moves the single writer atomically: before it, Rust reads; at it, Rust owns
  writes and the legacy core reads through `bridge.session.*`.
- **Source.** `session/` without `turn-loop.ts` — 3,801 lines.
- **Target.** `plur1bus-core/src/sessions/` on `plur1bus-store`.
- **Parity.** B: sample databases at v1…v9 opened, migrated and written by Rust, re-read by TS; T: `session.*`, `chat.*`
  (fork, history, search); tests `session/` 38; S `sessions`, `two-session-recall`.
- **Prerequisites.** P4-12, P4-03.

#### P4-41 — Providers and wire formats (8 agent days; risk M)
- **Scope.** `packages/providers` (Anthropic, Gemini, Responses, chat completions, SSE accumulation, reasoning, router,
  local servers, AF1's managed Unix-socket transport), the cache emitter (one writer of markers, TTLs and affinity keys,
  RE-D22), AF2's socket guard and composition. Written as a library from P4-03 on; flips after P4-20 and P4-23.
- **Source.** `packages/providers/src/` 6,356, `composition/cache-emit.ts` 181, `composition/apple-fm.ts` 94,
  `apple-fm/socket.ts` 48 — 6,679 lines.
- **Target.** `crates/plur1bus-providers` (lib), used by `plur1bus-core`.
- **Parity.** W: recorded exchanges for every wire format, including SSE edge cases (missing `[DONE]`, usage chunks,
  tool-call deltas) and the fake `fm serve`; V: the cache-profile vectors (`packages/providers/fixtures/`), request
  bodies byte-identical to TS (the B6 byte-identity gate D120 §12.2 step 3 names); tests `packages/providers/test/` 63,
  `model-routing/` 3. `host.llm.complete` becomes native.
- **Prerequisites.** P4-03 (library); P4-20, P4-23 (flip).

#### P4-42 — Prompt builder, tool-call runtime, decision service, triage (4.5 agent days; risk M)
- **Scope.** The four-zone prompt builder with zone and prefix hashes and frozen snapshots (ADR-010 §1), capability
  routing (top-K), the stable tool offer, skill tools, argument validation, model-facing tool errors, result capping;
  the decision service (System One, pruning, skills, tree adapter); triage. D122 AF5 (Apple FM decision backend) is
  re-planned here in Rust if Q6 is answered as recommended.
- **Source.** `prompt/` 874, `toolcall/` runtime 1,603, `decision/` 528, `triage/` 150 — 3,155 lines.
- **Target.** `plur1bus-core/src/{prompt,toolcall,decision,triage}/`.
- **Parity.** V: zone and prefix hashes, byte-identical rendered prompts per provider, stable-offer sequences; the
  `turn-eval` fixture corpus replayed over RPC against the Rust core (regression gate of `docs/turn-eval.md`); tests
  `prompt/` 14, `toolcall/` (runtime part of 42), `decision/` 12, `triage/` 5.
- **Prerequisites.** P4-41.

#### P4-43 — Dispatcher, registry, turn loop, provider loop, composition (10 agent days; risk H)
- **Scope.** The heart of the core: tool registry and dispatcher (resolve, validate, policy, approval, execute, result
  envelope), the turn loop and the provider loop, agent lifecycle admission, composition wiring, the tools-service
  client. The T1 gate now covers the whole path: tickets are minted by Rust and checked in-process for core-side
  executors and cross-process by `plur1bus-tools`. Executors still in TypeScript (MCP, A2A, collab and channel tools)
  are called through `legacy.tool.execute` with a ticket until their packages flip. D120 H3 steering (and H1-4's
  envelope) are re-planned here in Rust if Q6 is answered as recommended.
- **Source.** `tools/` top level 1,717, `composition/` without cache-emit and apple-fm 3,581, `agents/` 655, `agents.ts`
  162, `tools-service/` 437, `session/turn-loop.ts` 311 — 6,863 lines.
- **Target.** `plur1bus-core/src/{dispatch,turn,composition,agents}/`.
- **Parity.** T: chat and session turn transcripts with recorded provider fixtures; the D120 T1-a architecture test
  becomes a Rust `compile_fail` doctest plus a runtime test that every execution is preceded by a `policy.decision`
  audit record with the same `actionHash`; tests: the dispatcher part of `tools/` 42, `integration/` 3, `agents/` 3,
  `agents*.test.ts`, `engine-inline-post-turn`; S `turn-pipeline`, `model-switch`, `two-session-recall`, `sessions`;
  `turn-eval-live` against the H2 baseline under the D120 §6.4 delta rule.
- **Prerequisites.** P4-22, P4-24, P4-30, P4-40, P4-41, P4-42.

#### P4-44 — Model discovery and the extension catalogue (4.5 agent days; risk M)
- **Scope.** The model catalogue (one writer, atomic file, scanners, reconcile, roles, overrides, scheduler), the
  extension catalogue index and verification.
- **Source.** `discovery/` 3,113, `catalog/` 613 — 3,726 lines.
- **Target.** `plur1bus-core/src/{discovery,catalog}/`.
- **Parity.** W: scanner exchanges; V: reconcile results; T: `models.*`, `model.*`; tests `discovery/` 34, `catalog/` 7,
  `models-rpc`; S `model-discovery`.
- **Prerequisites.** P4-41 (library may start earlier).

### Track F — domain services

#### P4-50 — Collaboration, the coding surface and the team shell (9 agent days; risk H)
- **Scope.** The board, delegations and guardrails, hand-off, capacity, chat promotion, the D98 coding gate and verifier
  (through D123 SB-8's `tools.sandbox.run` verifier profile), the coding sessions behind `code.session.*`, external turns,
  the federation loan model, and the TK team shell from PR #900: event log, outbox, state versioning, action execution.
  D124 Q21 (c) holds in substance: Rust still decides (`tools.team.next`, pure, linked in-process), and the shell that
  executes is now Rust instead of TypeScript, exactly the "only the thin TS shell moves" case D124 §6.3 designed for.
  The D124 packages after TK (PT-4c onward) are written against this Rust shell (Q6).
- **Source.** `collab/` 3,394, `coding/` 1,005, `external-turn/` 405, `federation/` 301, plus TK's TypeScript shell —
  5,105 lines today plus an assumed ≈2,500 from TK (assumption: derived from PT-3a, PT-4b and PT-4c, 11.5 TypeScript
  agent days in the D124 plan; the real size is known when #900 merges). D131: PT-4b is not written in TypeScript; P4-50 writes the shell in Rust from the D124 spec §6.3 and TK's contract, and the estimate stays.
- **Target.** `plur1bus-core/src/{collab,coding,team}/`.
- **Parity.** B: the collab store (team tables of D124 §6.4 included); T: `project.*`, `collab.*`, `code.session.*`,
  `task.*`; TK's generated event-sequence tests replayed against the Rust shell (same events in, same persisted state
  and outbox out); tests `collab/` 52, `coding/` 7, `federation/` 2, `external-turn/` 1.
- **Prerequisites.** P4-43; TK merged; D123 SB-6 (for the verifier path).

#### P4-51 — Jobs and the memory-facing forwards (7 agent days; risk M)
- **Scope.** System and user jobs, the dream scheduler's trigger side (ADR-009: triggers stay in the core), the learn
  pass (#895; placement Q11), skill mining, the curated knowledge file, the media-search caption pipeline (cloud and
  remote captioners; local Florence-2 is P4-93), and the thin forwards that RE-10 creates: journal replay and backlog
  (T1), backup snapshot and restore re-apply (T2), the re-embedding driver (T3), the media-search index hook (T4), the
  dream ledger (T5), curation (T6). **Ordering rule with RE-10:** RE-10 owns the engine side of every move; when an
  RE-10 task lands after P4-10 has flipped, its core-side forward is written here in Rust (a `forward_to_engine` helper
  equal to RE-10's planned `forwardToEngine`: guard first, transport failure → `E_NOT_AVAILABLE
  reason=engine-unavailable`), not in TypeScript. The same rule applies to the core-side parts of RE-13 and RE-14 T4/T5.
- **Source.** `dreams/` 2,754, `media-search/` 1,541, `embedding-migrate/` 1,350, `system-jobs/` 547, `user-jobs/` 452,
  `journal.ts` 372, `knowledge/` 273, `skill-mining/` 266, `memory-ops.ts` 180, `backup-ops.ts` 161,
  `restore-reapply.ts` 115, `admin-ops.ts` 112, `replay.ts` 71, `memory-curation.ts` 54, `shared-memory.ts` 19,
  `media-output-store.ts` 26 — 8,293 lines before RE-10; an assumed ≈3,000 of them become engine code or disappear
  through RE-10.
- **Target.** `plur1bus-core/src/{jobs,dreams,learn,media_search,memory_forward}/`.
- **Parity.** T: `dreams.*`, `jobs.*`, `memory.*`, `admin.backup.*`, `admin.reembed.*`; tests `dreams/` 28 and the seven
  top-level `dreams-*.test.ts`, `media-search/` 26, `embedding-migrate/` 15, `system-jobs/` 7, `user-jobs/` 7,
  `knowledge/` 4, `skill-mining/` 3, `memory-ops*`, `backup-*`, `journal*`, `replay`, `restore-reapply*`;
  S `dreams`, `backup`, `portable-backup`, `reembed`, `memory-ops`.
- **Prerequisites.** P4-43; the engine sides of RE-10 T1–T6 for the forwards (a forward whose engine side is missing
  stays relayed to the legacy core until it exists).

#### P4-52 — Voice (7 agent days; risk M)
- **Scope.** The voice broker, routing, live and realtime sessions, barge-in, voice budgets, and the cloud providers of
  `packages/voice-providers` (HTTP and WebSocket); local `sherpa-onnx` voice is P4-93.
- **Source.** `voice/` 1,210, `packages/voice-providers/src/` without `local/` (1,211 lines, P4-93) — 4,272 of 5,483
  lines.
- **Target.** `plur1bus-core/src/voice/`.
- **Parity.** W: realtime WebSocket transcripts and HTTP STT/TTS exchanges; T: `voice.*`; tests `voice/` 18,
  `packages/voice-providers/test/` 27.
- **Prerequisites.** P4-43, P4-24.

#### P4-53 — Media jobs and documents (5.5 agent days; risk M)
- **Scope.** The media library (adapters, durable JobRunner, OutputStore, uploads, ffmpeg and ffprobe ports), the media
  RPC surface, and the D100 document renderer: Markdown → HTML, templates, tokens with the WCAG contrast check, the
  Chromium CDP driver for `Page.printToPDF`; `pagedjs` stays an injected browser asset.
- **Source.** `packages/media/src/` 2,119, `packages/documents/src/` 1,834, `rpc/media-surface.ts` 472 — 4,425 lines.
- **Target.** `plur1bus-core/src/{media,documents}/`.
- **Parity.** W: provider image and video exchanges; the `documents-golden` CI job's PDF goldens rendered by the Rust
  driver; T: `media.*`; tests `packages/media/test/` 40, `packages/documents/test/` 9.
- **Prerequisites.** P4-43.

### Track G — channels (D120 §12.2 step 4)

Adapters are ported as Rust libraries first, each proven against its own W fixtures, and the switchboard flips with all
adapters at once in P4-67. That avoids a second reverse bridge (Rust switchboard ↔ TypeScript adapters) and still keeps
every flip small, because each adapter is parity-proven before the flip.

| Package | Scope and source | Size | Risk | Parity |
|---|---|---|---|---|
| **P4-60** Telegram | `packages/channels-telegram/src/` 1,427 (Bot API long poll and webhooks, hand-written over the workspace HTTP client) | 2.5 | L | W; tests 12 |
| **P4-61** Discord | `packages/channels-discord/src/` 2,116 (gateway WebSocket, REST) | 3.5 | M | W; tests 16 |
| **P4-62** Slack | `packages/channels-slack/src/` 2,465 (Socket Mode, Web API) | 3.5 | M | W; tests 17 |
| **P4-63** Signal | `packages/channels-signal/src/` 1,844 (signal-cli over JSON-RPC, `rpc.ts`) | 3 | M | W; tests 21 |
| **P4-64** E-mail | `packages/channels-email/src/` 3,043 (hand-written IMAP, SMTP and MIME today: `imap.ts`, `smtp.ts`, `mime-parse.ts`, `mime-build.ts`; ported by hand; sender authentication checks in `packages/core/src/channels/email-auth-check.ts`) | 4.5 | M | W; tests 17 |
| **P4-65** Matrix | `packages/channels-matrix/src/` 2,933, end-to-end encryption through `matrix-sdk-crypto` instead of the WASM build | 5 | H | W; crypto-store round trip; tests 24 |
| **P4-66** Buzz | `packages/channels-buzz/src/` 218 (Nostr) | 1 | L | W; tests 3 |
| **P4-67** Switchboard flip | `channels/` 1,879 (router, per-chat serialisation and the 20-message queue, bindings, behaviour, loopback, rewind), `rpc/channel-surface.ts` 454, `composition/channel-uploads.ts`; flips the switchboard and all adapters | 3 | M | T: `channel.*`; tests `channels/` 28 |

Total track G: 26 agent days, 14,046 adapter lines plus ≈2,400 core lines. Prerequisites: P4-03 for the adapter
libraries (and P4-53's media library for uploads); P4-43, P4-22 and every adapter for P4-67.

### Track H — protocols (D120 §12.2 step 5)

#### P4-70 — MCP client and server (6 agent days; risk M)
- **Scope.** The MCP client registry (stdio and HTTP transports, auth interactions, OAuth sessions, interpreters), the
  MCP bridge tools, extension MCP servers with their secret environment, and the MCP server. `mcp.js` is replaced by
  `plur1bus-core mcp serve` (the CLI path in `crates/plur1bus/src/commands/mcp.rs:20` switches). On `rmcp` if P4-01
  clears it (D120 §12.5: younger than two weeks at its check; pin an older patch per policy).
- **Source.** `mcp/` 4,006, `mcp-bin.ts`, `tools/mcp-bridge.ts`, `composition/extensions.ts` — ≈4,400 lines.
- **Target.** `plur1bus-core/src/mcp/`.
- **Parity.** W: stdio and HTTP MCP sessions recorded against fixture servers; tests `mcp/` 37; S `mcp-server`,
  `extensions`. Removes the `legacy.tool.execute` use for MCP tools.
- **Prerequisites.** P4-43, P4-20.

#### P4-71 — ACP server, ACP client and external agents (4 agent days; risk M)
- **Scope.** The hand-written ACP server (`plur1bus acp serve`, coding mode, permissions, file changes) and client
  (#820), external-agent discovery, binding, card assignment, provisioning and git views; containment and the launcher
  are D123's and stay as D123 builds them. `acp.js` is replaced by `plur1bus-core acp serve`
  (`crates/plur1bus/src/commands/acp.rs:21`). D120 CLI-ACP is re-planned here (Q6).
- **Source.** `acp/` 1,059, `acp-bin.ts`, `external-agents/` without D123's part — ≈2,050 lines (assumption: D123
  removes ≈600 lines of spawn, kill and watchdog code).
- **Target.** `plur1bus-core/src/acp/`, `plur1bus-core/src/external_agents/`.
- **Parity.** T: ACP sessions over stdio (initialize, `session/new`, prompt, cancel, permission → D109); tests `acp/` 17,
  `acp-bin-entry`, `external-agents/` 26 (D123's four gate files `containment`, `red-team`, `hardlink`,
  `coding-worktree` stay byte-identical, as D123 requires); the M6-Pi verification re-run.
- **Prerequisites.** P4-43, D123 SB-6.

#### P4-72 — A2A client and server (4.5 agent days; risk M)
- **Scope.** Agent cards, the A2A endpoint handler, parts, events, peer client, peer store, approval preview, policy;
  hand-written against the A2A JSON schema (no official Rust SDK, D120 §12.5).
- **Source.** `a2a/` 2,429, `tools/a2a-transport.ts`, `rpc/a2a-peers.ts` — ≈2,800 lines.
- **Target.** `plur1bus-core/src/a2a/`.
- **Parity.** W: peer exchanges recorded against the `@a2a-js/sdk` fixture peer; tests `a2a/` 25; S `a2a`.
- **Prerequisites.** P4-43, P4-22.

### Track I — the Harness API (may stay TypeScript for 0.1, Q1)

The API is already a separate process and an RPC client of the core (`packages/api/src/core-link.ts`), so it is the one
large component that can stay TypeScript behind an existing seam at zero seam cost. Ported, it is four packages.

| Package | Scope | Source | Size | Risk |
|---|---|---|---|---|
| **P4-80a** Server core | Router generated from the new JSON route table, security headers, body limits, rate classes, static SPA, `/rpc` relay, `/events` SSE, WebSocket routes, core link and delegated link | `server.ts`, `routes.ts`, `headers.ts`, `rate-limit.ts`, `static.ts`, `rpc-route.ts`, `events-route.ts`, `chat-stream.ts`, `ws*.ts`, `core-link.ts`, `core-rpc.ts`, `delegated-link.ts`, `request-core.ts`, `errors.ts`, `openapi.ts` | 5 | M |
| **P4-80b** Accounts and OAuth | Login, password, TOTP, WebAuthn, challenges, sessions, invitations, bootstrap, tokens, owner token, OAuth authorization server, audit queue | `login.ts`, `password.ts`, `totp.ts`, `webauthn*.ts`, `challenge.ts`, `session.ts`, `account-*.ts`, `bootstrap.ts`, `tokens.ts`, `owner-token.ts`, `oauth/`, `audit*.ts` | 6 | H |
| **P4-80c** Desktop and remote access | Desktop attach, pairing, step-up, transport routes, remote certificates, trust envelope, company CA, pinning, Tailscale exposure | `desktop-*.ts`, `remote-*.ts`, `transport-routes.ts`, `net-bridge.ts`, `packages/remote-access/src/` 2,706 | 5 | H |
| **P4-80d** Uploads and protocol endpoints | Import and extension uploads, import maintenance events, chat and channel hand-off routes, `/mcp` and `/a2a` HTTP endpoints | `import-*.ts`, `extension-*.ts`, `chat-routes.ts`, `channel-handoff-routes.ts`, `protocol-routes.ts`, `mcp/`, `a2a/` | 3 | M |

Total 19 agent days for 14,391 lines (`packages/api/src/` 11,685 plus `packages/remote-access/src/` 2,706).
**Target.** `crates/plur1bus-api` (lib + bin `plur1bus-api`), the `api` slot unchanged. **Parity.** T over HTTP: request
and response pairs recorded from the TS API against a fake core; tests `packages/api/test/` 117 and
`packages/remote-access/test/` 26; S `desktop-attach`, `oauth`; the Linux `web-browser` shards (gating in `ci-gate`)
run the web against the Rust API; `apps/desktop/desktop-contract`. **Prerequisites.** P4-10, P4-12 (P4-80a…c);
P4-70 and P4-72 (P4-80d).

#### P4-85 — Import (22 agent days, range 18–28; risk M; may stay TypeScript for 0.1, Q1)
- **Scope.** The offline full import (detection, discovery identity, plans, sealed source plans, verified store
  transfer, held runtime, agent mutations, card sources, catalogue, extension import, prompts), SSH import through
  `plur1bus-remote-fs`, extension-source fetching. `import.js` and `extension-source.js` are replaced by native
  subcommands (`crates/plur1bus/src/commands/import.rs:30`, `ext/source_fetch.rs:22`); `crates/plur1bus-ext` already
  parses the extension formats.
- **Source.** `import/` 19,963 (103 files), `import-bin.ts`, `extension-source-{fetch,bin}.ts` 184,
  `packages/remote-fs/src/` 731 — 20,890 lines.
- **Target.** `crates/plur1bus/src/import/` (it runs offline, from the CLI, not in the core process) plus
  `plur1bus-core` for the live preview methods.
- **Parity.** V: mapper and plan outputs over the committed fixtures (`packages/core/test/fixtures/`, 261 files, the
  import part); tests `import/` 109; S `import`.
- **Prerequisites.** P4-12, P4-20, P4-44.

### Track J — the cut

#### P4-90 — Legacy removal (4 agent days; risk M)
- **Scope.** Delete the TypeScript core runtime (`packages/core/src/`, keeping only what MODULE-MAP marks stays-TS),
  the `core-legacy` slot, every `bridge.*` and `legacy.*` method (ledger empty), `PLUR1BUS_CORE_IMPL`, Node from the
  release payload, the container image and the desktop bundle (the reverse of the RE-D10 rule), the installer's Node
  handling (`crates/plur1bus/src/install/setup.rs:667,770`, `commands/firstaid_install.rs:178`),
  `engine.implementation` (with RE-11), `packages/embedding-adapters` (Q8); update AGENTS.md, `docs/architecture.md`,
  ADR-012's amendment note, the generated docs. If Q1 keeps the API or import in TypeScript, Node stays in the payload
  for exactly those entry points and P4-90 says so in the release notes.
- **Parity.** The full gate set of §4.3 on the final topology; `tests/system` on `rust` only.
- **Prerequisites.** Every flip of the chosen cut line; RE-11.

#### P4-91 — Eval tooling relocation (1.5 agent days; risk L)
- **Scope.** Move `toolcall/coding-bench*.ts` and `toolcall/turn-eval*.ts` (3,875 lines) to `scripts/eval/` as tooling
  that drives the Rust core over RPC; repoint the nightly `turn-eval-live` and the B1 benchmark jobs.
- **Parity.** The B1 and H2 baselines reproduce within their recorded tolerance.
- **Prerequisites.** P4-43.

#### P4-93 — Local ML on ONNX Runtime (6 agent days; risk H; after 0.1, not in the totals)
- **Scope.** Local voice on the `sherpa-onnx` crate or `ort` directly; local Florence-2 captions on `ort` with
  `tokenizers` pinned per RE-D19, sharing the engine's `load-dynamic` runtime (RE-D3b). D120 §12.5 U5 and U6.

---

## 4. Coexistence rules while both runtimes exist

### 4.1 The freeze (D129)

- **No TypeScript fixes** in `packages/core` or any non-UI package of §1.1. Allowed TypeScript changes, each named by
  the P4-00 commit trailer and checked by `scripts/ci/phase4-freeze.mjs`:
  - `seam <WP>`: the TypeScript side of a cut, i.e. a call into Rust through `bridge.*` or `tools.*` behind an unchanged
    TypeScript signature (the D123 SB-5 pattern), or running behind the front door;
  - `cut <WP>`: deleting code;
  - `vectors <WP>`: exporters and recorders, test-only;
  - `running-work <id>`: the work D129 names as running, TK (PR #900) and the learn pass (#895) and its listed
    follow-ups, finished as planned;
  - `generated`: regenerated code after a schema change.
- **New features** are planned in Rust inside the package that owns the subsystem, or after it (Q6 lists the D120, D124
  and D122 packages this re-targets). UI work in `packages/web` and `apps/desktop/ui` is unaffected.
- **The Node engine is frozen.** Engine fixes go to `crates/plur1bus-engine` through an RE brief; RE-12 (forward-port to
  the Node engine) is superseded (Q10). Core-side parts of RE-10, RE-13 and RE-14 are written in Rust once P4-10 has
  flipped (rule in P4-51).

### 4.2 Pull forward on defect

A bug or security issue found in TypeScript triggers the port of that component, not a fix.

1. **Record.** An entry in `docs/phase4/defects.md`: id (`P4D-n`), component, MODULE-MAP row, severity, owning package,
   reproduction.
2. **Pin it as a vector.** The failing test is written once, as a parity vector or transcript marked
   `expected-divergence: P4D-n`: the Rust side must pass it, the TS side is known to fail it. This is the only allowed
   divergence besides recorded owner decisions (the RE-R1 rule applied to Phase 4).
3. **Triage.**
   - *Security (any severity that the threat model rates exploitable) and data loss:* the owning package moves to the
     head of the queue; the next free implementer takes it. If its prerequisites are not met, a **slice** package is cut:
     only the component, served through `bridge.*` to the TypeScript caller, with the rest of its package unchanged in
     order. At most one pulled-forward package is in flight at a time (R6).
   - *Everything else:* the package keeps its place; the defect joins its acceptance.
4. **Contain without a TypeScript patch** while the port is under way: disable the feature by configuration, make the
   path fail closed, or delete it. The assumption behind this rule is that no production installation exists before
   0.1, the first alpha (Q9).
5. **Close** when the Rust package flips with the vector green; the entry records the PR.

### 4.3 Parity gates

A flip PR merges only with all applicable gates green, on Linux and macOS; the Windows leg is gating for P4-10, P4-20,
P4-30, P4-31 and P4-40 (pipes, keychains, process control, file locking), advisory elsewhere as `unit (windows-2025)` is
today.

| Gate | What | Source |
|---|---|---|
| G0 | Vector sets (V) of the package green in `cargo test` | P4-02 exporters |
| G1 | Transcripts (T) and the 508 contract fixtures replay identically against the Rust core | P4-02 runner |
| G2 | Every `tests/system` suite green on `PLUR1BUS_CORE_IMPL=rust` and still on `ts` | `tests/system/` |
| G3 | Store round trip (B) at every schema version the package owns | P4-02 helper |
| G4 | Budgets: cold start, p95 latency of the package's methods and idle RSS not worse than TypeScript (ADR-012 counts 30–50 MB per Node process); the turn path additionally under the D120 §6.4 delta rule against the H2 and B1 baselines | `turn-eval-live`, B1 |
| G5 | Security: `redaction-everywhere`, the red-team and containment suites, the D120 review-focus items that touch the package | `tests/system/`, D123 |
| G6 | `MODULE-MAP.md` rows of the package all have a Rust module, a fold target or a recorded drop; every TS test file of the package has a parity mode or a reason | P4-02 |

### 4.4 Switch-over and deletion

Each package lands as three PRs (the D123 SB-5/SB-6 pattern):

1. **Implement.** The Rust implementation with its vectors (G0) and, where the package can be exercised alone, G3.
   No runtime use.
2. **Flip.** The seam: the front door serves the methods natively, the TS side becomes a thin `bridge.*` client where
   it still has callers; a test-only switch `PLUR1BUS_P4_<PACKAGE>=ts|rust` exists only during this PR and the next;
   CI runs both values; default `rust` once G0–G6 are green.
3. **Cut.** Delete the TS implementation and its unit tests (their vectors and transcripts stay), the switch, the
   `bridge.*` methods that lost their last caller (ledger updated), the MODULE-MAP rows, the docs. The cut merges
   within five working days of the flip and before the next flip in the same track, so no subsystem lives twice for
   long (D120 §12.1: "no long dual life").

**Rollback.** Before the cut, a revert of the flip's default; after it, a normal `git revert` of the cut's merge commit
(no force-push). Rollback is a defect (§4.2), not a reason to patch TypeScript.

### 4.5 Schema and contract rules during the transition

- Public methods never change `x-server`; they stay `"core"` (§2.3).
- `bridge.*` and `legacy.*` methods: `x-server: "bridge"` (a sixth value, added by P4-10 with the schema tests that
  enforce server values), principal `legacy-core` only, `x-stability: "experimental"`, `x-deprecated` with
  `removeAfter` at the 0.1 cut, closed params, contract fixtures like any method; no new error codes, new reasons only.
- `tools.*` keeps D120's rule: only the core principal may call it; after P4-10 that principal is the Rust core.
- Capabilities: the front door lists native plus relayed methods; `features` stay as `CORE_FEATURES` defines them.

---

## 5. Release 0.1 cut line

### 5.1 Must be Rust for 0.1

- Supervisor, CLI, installer (already Rust).
- The engine (RE programme through RE-11: the Node engine retired, ADR-018).
- `plur1bus-core` with tracks A–F and H: front door; config, logs; identity, RBAC; secrets; policy, egress, audit;
  approvals; auth; budgets; sessions; providers; prompt and tool-call runtime; dispatcher and turn loop; discovery;
  collaboration and teams; jobs and memory forwards; voice; media and documents; MCP, ACP, A2A.
- `plur1bus-tools` with the executors of track D (plus D120's and D123's own packages as they land).
- Channels (track G): at least the adapters the 0.1 release notes promise; the recommendation is all seven (Q1).

### 5.2 May stay TypeScript behind a seam for 0.1, if the owner accepts (Q1)

| Component | Seam it would stay behind | Seam cost | Effect |
|---|---|---|---|
| Harness API (track I, 19 agent days) | Its own process, RPC client of the core (`packages/api/src/core-link.ts`), supervisor slot `api` | none | Node stays in the payload for `api.js` |
| Import (P4-85, 22 agent days) | An offline binary the CLI spawns (`crates/plur1bus/src/commands/import.rs:30`) | none | Node stays in the payload for `import.js` and `extension-source.js` |
| Secondary channel adapters, A2A, voice | None today: they are in-process libraries of the core | a module seam would have to be built (≈3 agent days each group) — cheaper to disable for 0.1 than to wrap | Variant C below disables them in 0.1 instead |

Not in 0.1 under any variant (recommended, Q5): local voice and local captions (P4-93 after 0.1).

### 5.3 Size

| Track | Packages | Agent days |
|---|---|---|
| A Foundations | P4-00…P4-03 | 9.5 |
| B Front door | P4-10…P4-12 | 16.5 |
| C Safety core | P4-20…P4-24 | 19 |
| D Execution | P4-30, P4-31 | 10 |
| E Sessions and turns | P4-40…P4-44 | 32.5 |
| F Domain services | P4-50…P4-53 | 28.5 |
| G Channels | P4-60…P4-67 | 26 |
| H Protocols | P4-70…P4-72 | 14.5 |
| I Harness API | P4-80a…d | 19 |
| Import | P4-85 | 22 |
| J Cut | P4-90, P4-91 | 5.5 |
| **Total** (41 packages) | | **203** (range 175–255) |

Not in the total: the RE programme's remaining briefs (RE-04 T6, RE-05, RE-06, RE-07, RE-08 rest, RE-09, RE-10, RE-11,
RE-13, RE-14 T4/T5; sized only relatively in the RE plan), D123 SB-1…SB-6 (9 agent days, its own plan), the Rust
packages of D120 (H1-2, H1-3, C1–C3, T1-b and the rest), TK's remaining work, P4-93 (6).

| Variant | Content | Agent days |
|---|---|---|
| **A — Node-free runtime** | Everything above | 203 |
| **B — Rust core, API and import stay TypeScript for 0.1** (recommended) | A minus track I and P4-85 | 162 |
| **C — B plus a narrower 0.1** | B minus Discord, Slack, Signal, E-mail, Matrix, Buzz (20.5), A2A (4.5) and voice (7), plus 1 day to gate them off cleanly | 131 |

### 5.4 Calibration and agent weeks

**Assumption.** The estimates average ≈700 TypeScript lines per agent day for a parity port that includes converting
the package's tests to vectors, transcripts or system runs: lower for security- and concurrency-heavy code (P4-10 ≈560
counting core lines only, P4-12 ≈580, channel adapters ≈610, P4-43 ≈690), higher for mapping-heavy code with good
fixtures (import ≈950, providers ≈830). Ported scope is ≈135,000 lines (the core minus eval tooling, D123's part,
RE-10's moves and the Node engine binding, ≈91,600; plus `api`, the channels, `providers`, `voice-providers` without
`local/`, `media`, `documents`, `remote-access`, `hostctl`, `remote-fs`, ≈43,200) over ≈188 port days. A port re-expresses tested behaviour, which is why the rate is
above the repo's estimates for new Rust work (D120: H1-1 3 days, C1 3 days). P4-01 re-estimates; after P4-10, P4-12
and P4-21 the controller compares actual with planned days, and a ratio above 1.3 re-baselines §5 and re-opens Q1.
The range (−14 % / +25 %) follows D120's habit of adding review rounds to the upper bound.

**Critical path** (dependencies only, libraries started early): P4-01 → P4-03 → P4-10 → P4-12 → P4-21 → P4-22 →
P4-30 → P4-43 → P4-50 → P4-90 ≈ 56 agent days ≈ 11 weeks. With two implementers the work, not the path, binds.

| Variant | 1 implementer | 2 implementers in parallel |
|---|---|---|
| A (203 days) | ≈41 agent weeks (35–51) | ≈22–23 weeks (19–28) |
| B (162 days) | ≈33 agent weeks (28–41) | ≈18 weeks (15–22) |
| C (131 days) | ≈26 agent weeks (23–33) | ≈15 weeks (13–18) |

Two-implementer figures are total ÷ 2 plus ≈10 % for coordination, controller reviews and merge order; they assume both
are Claude agents (all of Phase 4 is Rust, Q12) and that the RE programme runs on its own implementers. **0.1's date is
the later of this plan's cut (P4-90) and RE-11**; RE-05 and RE-06 are XL briefs that are not started.

### 5.5 What can start now, and the first package

P4-00, P4-01 and P4-02 have no prerequisite and can start in parallel today; P4-02 works against the TypeScript core
alone. **First Rust package: P4-03**, then **P4-10**. P4-10 carries the largest structural risk (authentication,
Windows pipes, adoption, relay) and everything else flips through it, so it is measured first (§5.4 recalibration).
The provider library (P4-41) and the channel adapter libraries (P4-60…P4-66) can be written by a second implementer
from P4-03 on, because they flip later.

---

## 6. Owner questions

**Decided 2026-11-07 (owner, D131): every question as recommended, Q1 = B.** The recommendations below are therefore binding.

1. **Q1 — The 0.1 cut line.** A (Node-free runtime, 203 days), B (Rust core; the Harness API and import stay
   TypeScript behind their existing process seams for 0.1, 162 days) or C (B plus Discord, Slack, Signal, E-mail,
   Matrix, Buzz, A2A and voice off in 0.1, 131 days). **Recommendation: B.** It keeps every feature, uses only seams
   that already exist (no new TypeScript), and moves 41 days after 0.1; Node stays in the 0.1 payload for `api.js`,
   `import.js` and `extension-source.js` only, and the release notes say so. Choose A if "0.1 on Rust" means no Node at
   runtime at all.
2. **Q2 — A separate `plur1bus-core` process** instead of growing `plur1bus-tools` into the core (amends D120 Q3 and
   §12.3). **Recommendation: separate** (§2.1): keeps D120 §5's secrets invariant, the tools sandbox profile and the T1
   cross-process check; costs one small Rust process.
3. **Q3 — Server-side front door and relay** instead of client-side capability routing (amends D120 §12.4 for the
   transition). **Recommendation: front door** (§2.4): no client changes, one RBAC guard, one socket and token.
4. **Q4 — A temporary sixth server value `x-server: "bridge"`** for `bridge.*` and `legacy.tool.execute`, callable only
   by the legacy core, deprecated from day one and removed by P4-90. **Recommendation: yes.**
5. **Q5 — Local ML out of 0.1.** Local voice (`sherpa-onnx-node`) and local Florence-2 captions (transformers.js) are not
   in 0.1; cloud and remote providers cover both; P4-93 ports them onto ONNX Runtime after 0.1. **Recommendation: yes.**
   The alternative, a Node ML sidecar, keeps Node in the runtime.
6. **Q6 — Re-target planned TypeScript work to Rust.** D129 names TK and the learn pass as running work; everything
   else planned in TypeScript for the core and not yet merged moves into the owning Phase 4 package, written in Rust:
   D120 H1-4 and H3-1 (→ P4-43), H3-2's core part (→ P4-43, P4-67), H4 (→ P4-40), C4 (→ P4-50), CLI-ACP (→ P4-71), the
   TypeScript parts of H2 (→ P4-42, P4-43); D124 PT-1, PT-4b (→ P4-50, decided 2026-11-07), PT-4c, PT-5, PT-5b, PT-6, PT-6b, PT-7, PT-8a, PT-8b, PT-10, PT-13
   (→ after P4-50, against the Rust shell); D122 AF5 (→ P4-42). UI packages (D124 PT-9a, web parts of H3-2) stay
   TypeScript; evaluation tooling (PT-2, PT-14, B1) stays TypeScript tooling. **Recommendation: yes**, and none of these
   starts in TypeScript in the meantime.
7. **Q7 — `packages/module-api`** stays a published TypeScript SDK for third-party modules (ADR-016 §1), with no
   harness-runtime use after P4-80 (or after 0.1 under Q1 = B); a Rust module SDK is a later, separate decision.
   **Recommendation: yes.**
8. **Q8 — Delete `packages/embedding-adapters`.** It is not wired to the core or the engine (its README), and RE-03
   covers remote embedding providers in Rust. **Recommendation: delete in P4-90**, after a check that every rerank
   provider it lists is either in RE-03 or recorded as dropped.
9. **Q9 — Defect containment before 0.1.** A TypeScript defect is contained only by configuration, fail-closed or
   deletion, never by a TypeScript patch (§4.2), on the assumption that no production installation exists before the
   first alpha. **Recommendation: yes.** If a production installation does exist, the owner names it and the rule gets
   one exception path: a security fix in TypeScript with the Rust port pulled forward in the same week.
10. **Q10 — RE-12 is superseded** (it forward-ports CP-5 and CP-7 to the Node engine, which D129 freezes); the
    Node-engine items of the 7.19 adoption and engine-pin plans (`2026-11-03-*`) go to Rust engine briefs only.
    **Recommendation: yes.**
11. **Q11 — Where the learn pass lives.** `dreams/learn/` (1,267 lines, #895) ports to the Rust core with the dream
    triggers (P4-51), or to the engine as an RE-10 extension. **Recommendation: the core**, like the dream scheduler's
    triggers (ADR-009); its store can follow RE-10 T5's ledger into the engine later if one memory-side ledger is wanted.
12. **Q12 — Executors.** The owner's rule "Rust by Claude agents, never Codex" now covers almost all of Phase 4.
    **Recommendation:** keep it for Rust; allow the controller's choice (Sonnet or Opus) for the TypeScript seam cuts,
    exporters and recorders inside a package. The two-implementer estimate assumes two Claude agents for Rust.

---

## 7. Risks and how the plan contains them

| # | Risk | Containment |
|---|---|---|
| R1 | **Scope and calendar.** 203 agent days is about 41 agent weeks for one implementer; 0.1 also waits for RE-05…RE-11 | Cut-line variants (Q1); libraries written ahead of their flips so two implementers stay busy; recalibration after P4-10, P4-12, P4-21 with a re-opened Q1 if the ratio exceeds 1.3; the RE programme on its own implementers |
| R2 | **Two runtimes at once**: the bridge grows, the TS core lingers | Bottom-up order (TS calls Rust, rarely the reverse); one reverse family only (`legacy.tool.execute`); the bridge ledger with a removal package per method; the cut within five working days of each flip; P4-90 requires an empty ledger |
| R3 | **Store compatibility**: `node:sqlite` and `rusqlite` disagree on SQLite version, FTS5 tokenizers, WAL or `user_version` | P4-01 measures it on the real files; gate G3 at every schema version; same file and schema, no migration in Phase 4; single-writer ownership moves atomically at a flip |
| R4 | **Security regressions at the front door** (token handling, pipe DACLs, principal forwarding, the relay as a confused deputy) | P4-10 and P4-12 are risk H with a security review; the legacy core keeps re-checking RBAC on relayed calls until the cut; Windows legs gating for those packages; the front door also closes ADR-012 deviation C2 (Node's default pipe DACL) |
| R5 | **Prompt drift**: a byte change in the rendered prompt costs provider cache hits and can change model behaviour | Byte-identical rendering vectors (B6) in P4-42; `turn-eval-live` and B1 under the D120 delta rule (G4) |
| R6 | **Pull-forward thrash**: defects keep reordering the plan | Severity threshold (§4.2); slice packages instead of whole-package jumps; at most one pulled package in flight |
| R7 | **Test port underestimated** (144,672 lines of core tests) | Tests are converted by mode (V, T, S, W, B), not line by line; G6 forces every test file into a mode or a recorded reason; MODULE-MAP makes the gap visible early |
| R8 | **Dependency policy** blocks a crate (two-week window, licence, advisories): `rmcp`, `matrix-sdk-crypto`, `axum`, `keyring`, a Nostr crate | P4-01 first; hand-written fallbacks exist for everything except Matrix crypto (which Q1 = C could leave off) |
| R9 | **Freeze pressure**: features wanted before 0.1 cannot go into TypeScript | Q6 re-targets them into named packages; the order puts the turn path (where most features land) in track E, early enough to take them |
| R10 | **Behaviour changes sneak in** ("while we are here") | Parity is the acceptance; the only divergences are recorded defects (`P4D-n`) and owner decisions, as RE-R1 does for the engine; ADR-016 governs every public shape |
| R11 | **The executor rule limits throughput** | Q12; libraries parallelise; TypeScript-side seam work can go to other executors |
| R12 | **RE-10 and Phase 4 touch the same core paths** | P4-51's ordering rule: RE-10 owns the engine side; a forward written after P4-10 is written in Rust; a forward without its engine side stays relayed |
| R13 | **TK lands as TypeScript after the freeze** and is then ported | Intended by D129; D124 §6.3 designed the shell to be thin; P4-50 replays TK's own event-sequence tests against the Rust shell |
