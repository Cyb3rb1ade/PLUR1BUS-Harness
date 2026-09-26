# ADR-001: Base architecture: TypeScript monorepo (Variant B) vs Hermes distribution (Variant A)

**Status:** Accepted (2026-09-22) · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D1, D5, D6, D9, D10 · `docs/phase0/auftrag-original-2026-09-21.md` §2.2 (K1–K4), §4, §10, §11, §12 · `docs/phase0/research/hermes-learnings-and-import.md` A2, A4, A5, A6, A10–A14 · `docs/phase0/research/plur1bus-host-contract.md` §1, §5, §9, §10 · `docs/phase0/research/plur1bus-crons-embedding-portability.md` §2, §4 · `docs/phase0/research/platform-binaries-and-startup.md` · `docs/phase0/research/protocols-channels-coding-clis.md` · `docs/phase0/research/harness-engineering-state-of-the-art.md` §4, §7 · `docs/phase0/research/verification-log.md` V1–V4

## Context

The original commission made **Variant A** the default (Hermes Agent pinned as a Python dependency, delta shipped as plugins) and named four kill criteria K1–K4 to be tested in Phase 0 (`auftrag-original-2026-09-21.md` §2.2). Decision **D1** reverses the default: Variant B — a single TypeScript monorepo, Node ≥ 24, pnpm, PLUR1BUS engine in-process — is the favourite, and A is now a counter-check. This ADR performs that counter-check with evidence and states the layout and process model for B.

What is actually being hosted decides most of this. PLUR1BUS is a **Node/JavaScript** codebase: ~13 496 lines in `index.js` plus ~79 734 lines under `lib/` at commit `89148f9` (`plur1bus-host-contract.md` §10 "Totals"). Its whole per-turn injection contract is one return value, `{ prependContext: string }`, capped at 17 000 chars (`index.js:13315-13325` @ `89148f9`, read directly; `plur1bus-host-contract.md` §2). Its embedding/rerank layer is Node-native (`@huggingface/transformers` / `onnxruntime-node`, `lib/providers/factory.js:9-27`). Under Variant A that Node engine would live *beside* a Python agent loop, not inside it, and the two would have to agree on identity, time budgets and prompt assembly across a process boundary.

Verified toolchain facts: `node:sqlite` with FTS5 + `bm25()` works on macOS arm64 / Node 26.8.2 and Linux x64 / Node 22.22.2 with no native add-on (V1, V2); the owner's machine runs node 26.8.2, pnpm 10.32.1, git 2.55.0 (V4). This removes `better-sqlite3` from the required native matrix for sessions and lexical search.

## Decision

**Adopt Variant B: one public TypeScript monorepo (`Cyb3rb1ade/PLUR1BUS-Harness`, MIT, D10), Node ≥ 24, pnpm workspaces, the PLUR1BUS engine consumed in-process inside a single resident core daemon, with the harness owning its own provider, auth, channel and protocol layers.** Variant A is rejected: it does not trip K1 outright, but it trips **K4 decisively** and **K3 on Windows arm64 and macOS arm64 Matrix E2EE**, and it buys outer layers that must be re-plumbed anyway at the price of a permanent Python+Node double stack around a Node engine. **Variant C is adopted as a zero-cost hedge, not as a fallback plan:** because D5 already makes an ACP *client* mandatory, a Hermes installation can be attached as an external ACP agent at any time without architectural change. No Hermes code, no Hermes dependency, no Hermes fork.

Process model, per §4 and D6: exactly **one resident core daemon per installation** (stores opened once, local embedding and reranker models loaded once, multi-tenant by `agentId`); the CLI is a **thin client** speaking JSON-RPC 2.0 over a Unix domain socket (POSIX) or named pipe (Windows) with a token and restrictive permissions; the **harness API is the only listening TCP surface**, loopback-bound by default.

## Options considered

### Option A: Hermes pinned as a Python dependency + Node core daemon + harness plugins

| Dimension | Assessment |
|---|---|
| Complexity | **High.** Two runtimes, two package managers, two type systems, two test harnesses, one IPC seam between the Python turn loop and the Node memory engine, and a bidirectional identity mapping (Hermes profile ⇄ PLUR1BUS `agentId` ⇄ harness principal). |
| Fit with brief D1–D11 | **Poor after D2.** D2 deletes the host shim and makes PLUR1BUS a host-neutral engine with the harness as its *native* host; A keeps the engine behind a foreign host's plugin ABC. D9 (embedding/rerank owned by the engine, in-process) forces the Node engine to stay resident anyway, so A never collapses to one runtime. |
| Cross-platform risk | **Highest.** Union of the Python wheel matrix and the Node native matrix on five targets. Matrix E2EE alone: Hermes uses `mautrix[encryption]==0.21.1` with `python-olm`/libolm (`pyproject.toml:225`, `plugins/platforms/matrix/adapter.py` @ `743ee72`; `protocols-channels-coding-clis.md` row "Matrix (what Hermes uses)"), i.e. a **native C library that must be built or shipped per target**, versus the Node path `matrix-js-sdk@42.4.0` + `@matrix-org/matrix-sdk-crypto-wasm@18.9.0`, a **single WASM blob identical on all six targets** (ibid.; `platform-binaries-and-startup.md` §Binaries, row `@matrix-org/matrix-sdk-crypto-nodejs`). |
| Maintenance burden | Lower for channels/providers *in theory* — Hermes maintains 22 platform adapters (`hermes-learnings-and-import.md` A5) and three wire modes (A2) upstream. In practice we re-plumb every one of them behind a harness API for RBAC (see K4), so the saving is partial. |
| Latency / token cost | Adds a process hop to every recall and every embed. Hermes's own measured cold-start surgery (PR #59332: AIAgent init 1.0–3.3 s → 0.36–0.64 s; CLI submit→dispatch ~4.3 s → ~0.9 s) shows how much of the budget a Python init path can consume (`harness-engineering-state-of-the-art.md` §4). D6's < 100 ms CLI target is unreachable through a Python entry point. |

**Pros:** upstream-maintained provider resolution with three wire modes, OAuth flows and credential pools, 22 channel adapters, cron with delivery, skills, plugin system, ACP both directions, Electron desktop app and Tauri installer (A2, A3, A5, A7, A9, A10, A12, A13, A14). A genuinely large amount of working code we would not write.
**Cons:** the memory engine we are building the product around is Node; A puts a Python host in front of it forever. Multiplexing is not real isolation (K2). The dashboard has no user model (K4). The double native matrix is the worst on our weakest targets (K3).

### Option B: Standalone TypeScript monorepo, PLUR1BUS engine in-process (recommended)

| Dimension | Assessment |
|---|---|
| Complexity | **Medium-high, but single-stack.** We write provider resolution, OAuth, four channels, MCP/ACP/A2A clients+servers, RBAC and a SPA. One language, one toolchain, one debugger, one CI matrix. |
| Fit with brief D1–D11 | **Direct.** D1 names it; D2/D3 are natural (the engine is a workspace dependency, not a plugin); D6 is achievable (single Node entry point, lazy imports, compile cache); D9 is native (`embed()`/`rerank()` are in-process calls, not IPC). |
| Cross-platform risk | **Medium and enumerable.** One matrix. Confirmed prebuilds on all six targets for `onnxruntime-node@1.30.0`, `@napi-rs/keyring@2.0.0`, `better-sqlite3@13.0.3`, `sharp`; `node:sqlite` ships inside Node. Two known gaps: `@lancedb/lancedb@0.39.0` publishes **no `darwin-x64` prebuild** (source build via Rust, or Rosetta — darwin-x64 is "best-effort" per §10 anyway), and `node-pty@1.1.0` **win32-arm64 is unverified** with forks (`node-pty-prebuilt-multiarch`, `@lydell/node-pty`) as documented fallbacks (`platform-binaries-and-startup.md` §Binaries, §Weakest target). |
| Maintenance burden | **Highest single risk of this option.** We own provider/OAuth/channel maintenance permanently, against a 2026 policy landscape that "has changed several times" (§6.3) — Anthropic subscription OAuth is **prohibited** for third-party harnesses, Gemini CLI (now Antigravity CLI `agy`, D40) OAuth is **prohibited**, OpenAI is **ambiguous**, xAI is **undocumented and 403-prone** (`providers-chat-auth-caching.md` §Subscription-login policy). Team of one plus agents. |
| Latency / token cost | **Best achievable.** Recall is an in-process function call inside the daemon, not an RPC; no Python interpreter on any path; the resident-core + thin-client shape is exactly what the cold-start evidence prescribes (Claude Agent SDK TS: 13.13/13.88/13.00 s per fresh-CLI query, ~75 % reusable overhead — `claude-agent-sdk-typescript#33`; codex-rs submit/event model — both via `harness-engineering-state-of-the-art.md` §4). |

**Pros:** the engine runs where it was written; one identity model end to end; full control of the six injection points and the prompt layout the caching rules in ADR-010 depend on; official MCP/ACP/A2A TypeScript SDKs; `node:sqlite`+FTS5 verified hands-on (V1, V2).
**Cons:** we write and keep alive the provider/auth/channel surface Hermes already has; native-module matrix is ours; a team of one must not also maintain a fork of anything.

### Option C: B now, Hermes attached as an external ACP agent if ever needed

| Dimension | Assessment |
|---|---|
| Complexity | **Zero incremental.** D5 already requires an ACP client for coding CLIs; Hermes documents ACP support on both the agent and the client side (`hermes-learnings-and-import.md` A12). |
| Fit with brief D1–D11 | Consistent with D5 and §8. Content from an external agent is data, not instructions (§7, §11). |
| Cross-platform risk | Isolated: the Python stack, if a user chooses to run one, lives in their Hermes install, not in ours. |
| Maintenance burden | One adapter, already being built. |
| Latency / token cost | Out-of-band by construction; never on our critical path. |

**Pros:** keeps Hermes's channels and providers reachable without importing its runtime; preserves an exit if a channel we cannot build turns out to matter.
**Cons:** none material — this is not a fallback for the core decision, only a bridge. It does **not** rescue Variant A: an ACP agent cannot host the PLUR1BUS engine.

## Kill-criteria evaluation for Variant A (K1–K4)

| # | Criterion (§2.2) | Evidence | Verdict |
|---|---|---|---|
| **K1** | PLUR1BUS operable as the fixed core under Hermes — recall before the API call with a time budget, non-blocking capture, pre-compress checkpoint, control of *all* injection points, command interception, model-free feature crons, LLM access for internal jobs, **Hermes's own memory loop switched off** — without touching the agent loop | The disable is real and clean: `get_builtin_memory_store_flags()` returns `(memory_enabled, user_profile_enabled)` from `config.memory` (`tools/memory_tool.py:229-232` @ `743ee72`, read directly), enforced at `agent/agent_init.py:1254-1289` and regression-tested (`hermes-learnings-and-import.md` A4). Exactly one external memory provider is permitted, enforced at `agent/memory_manager.py:326-336` (read directly). The `MemoryProvider` ABC lifecycle (`initialize → prefetch/queue_prefetch → tool dispatch → sync_turn → shutdown`, plus `on_pre_compress`, `on_session_end`, `on_memory_write`) maps onto PLUR1BUS's lifecycle. **But** Hermes injects memory as a **frozen snapshot into the system prompt at session start** that does not change mid-session (Hermes memory docs, via `harness-engineering-state-of-the-art.md` §2, §7), whereas PLUR1BUS delivers a *per-turn* `prependContext` block of up to 17 000 chars composed of six sub-blocks (`index.js:13315-13325` @ `89148f9`, read directly). Reconciling those two is a change to prompt assembly, i.e. to the loop. | **Amber — not a clean pass.** The memory-loop shutdown and the provider ABC are fine; the per-turn injection contract and the 50 ms reactivation race (`index.js:12967-12969`, read directly) are not obviously expressible without core changes. |
| **K2** | Agent management and agent-to-agent consultation buildable on profiles + multiplexing gateway + subagent API without invasive core changes | Profiles give real per-profile isolation via a context-local `HERMES_HOME` (`hermes_constants.py:18-42`; A6) and fail-closed secret scoping (`agent/secret_scope.py`; A6). Subagents return **bounded, immutable, idempotent results capped at 32 k characters** (A8) — a good contract. **But** Hermes's own documentation admits gateway multiplexing leaves the **tool registry, MCP discovery and terminal/sandbox environment process-global** despite being framed as profile isolation (A11, and the note's explicit "What NOT to copy" item 7). Per-agent tool allowlists and per-agent MCP servers — both required by §8 and §11 — therefore need core work, or one OS process per agent. | **Amber-red.** Achievable only as process-per-agent, which defeats §4's "exactly one core so stores and models are opened once". |
| **K3** | The Python+Node double stack cannot be made to run on a target platform (§10) | Node side, verified from the npm registry 2026-09-22: `@lancedb/lancedb@0.39.0` has **no darwin-x64 prebuild**; `node-pty@1.1.0` **win32-arm64 prebuild unconfirmed**, `install` is `node scripts/prebuild.js \|\| node-gyp rebuild`, i.e. the one genuine node-gyp/Python exposure in the whole matrix (`platform-binaries-and-startup.md` §Binaries, §Python-free check). Python side adds, for the mandatory Matrix channel (§8), `mautrix[encryption]==0.21.1` + native **libolm** (`hermes-agent/pyproject.toml:225`, `plugins/platforms/matrix/adapter.py` @ `743ee72`; `protocols-channels-coding-clis.md`), against a Node alternative that is pure WASM. Hermes's Windows support is **incident-driven**, with fixes referencing specific production bugs (`[WinError 5]` while the desktop app holds a lock, `hermes_constants.py:497,633`; a `bounded_probe_run` helper because `subprocess.run(timeout=…)` "can hang forever on Windows when a conhost.exe descendant holds duplicated pipe handles", `hermes_cli/subcommands/claw.py:106-109`, bug `#87134`) — A14. | **Red on Windows arm64, amber on macOS arm64.** Not "impossible", but A doubles the native surface on exactly the two targets where it is thinnest, and adds a C crypto library we can otherwise avoid entirely. |
| **K4** | Multi-user operation cannot be enforced — the Hermes API and dashboard can be neither placed behind a harness API with server-side RBAC nor replaced by our own SPA | **Decisive.** Hermes's dashboard authenticates with a **single process-wide shared session token**: `_SESSION_TOKEN = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_urlsafe(32)`, checked by `hmac.compare_digest(auth, f"Bearer {_SESSION_TOKEN}")` (`hermes_cli/web_server.py:315-322, 403-414` @ `743ee72`, read directly). There is **no user record, no role and therefore no server-side RBAC** — a grep for role/RBAC/permission predicates across `web/src` and the gateway returns nothing. Authorization in Hermes is per-platform channel allowlists (`<PLATFORM>_ALLOWED_USERS` / `_ALLOW_ALL_USERS`, `gateway/authz_mixin.py:32-38`, read directly) plus DM pairing — an *allowlist of chat identities*, not the Owner/Admin/Member model §5.1 and §9 require. §9 itself states the rule: "trägt (a) das nicht, ist (b) gesetzt" — if the dashboard route cannot carry RBAC, the own-SPA route is mandatory. | **Tripped.** With the SPA mandatory and every write path needing a harness-API gate anyway, Hermes's dashboard, its API server and a large part of its plugin surface become dead weight. |

**Conclusion:** K4 is tripped outright and K3 is tripped on Windows arm64. Per §2.2 ("trifft eines zu → ADR-001 mit Befund"), Variant A is rejected. K1 and K2 are recorded as amber rather than pass, and are the reason C is kept as a bridge rather than an alternative.

## Risks of Variant B, and how each is bounded

| Risk | Evidence | Mitigation |
|---|---|---|
| **We own provider and OAuth maintenance forever** | Three wire modes to implement (`chat_completions`, `codex_responses`, `anthropic_messages` — the shape Hermes proved, A2). Subscription-login policy is hostile and moving: Anthropic **prohibited**, Gemini CLI (now Antigravity CLI `agy`, D40) **prohibited**, OpenAI **ambiguous**, xAI **undocumented/403**, OpenRouter and Nous Portal **explicitly allowed** (`providers-chat-auth-caching.md` §Subscription-login policy, checked 2026-09-22) | Declarative auth profiles (data, not code) per §6.3; ship only `allowed` profiles; `restricted` opt-in with a visible risk notice; **route prohibited vendors through their official CLI as an external ACP agent** (D5, §6.3) instead of imitating their client. Contract tests per wire format against recorded fixtures (§11). |
| **Native-module matrix is ours** | darwin-x64 LanceDB gap; win32-arm64 node-pty gap; SEA has a known broken-hash-table bug for Linux-arm64 builds made inside Docker (`platform-binaries-and-startup.md` §Node runtime facts) | CI matrix over all five targets from M1 with the documented degradations: Rosetta/source-build for darwin-x64 LanceDB; `@lydell/node-pty` or spawn+pipe (no TTY) for win32-arm64; Matrix crypto via WASM everywhere; never build Linux-arm64 SEAs in Docker-on-arm64. |
| **Team of one plus agents** | D11 | Cut scope by milestone (§12: CLI first, GUI later), keep the toolset small (top-15 rule 7: MCP measured at 13.7k–18k tokens per server), and prefer one well-tested channel over four half-tested ones per milestone. The monorepo makes a feature deletable in one commit. |
| **We must not fork PLUR1BUS** | D3 | All engine changes are PRs to the PLUR1BUS repo (ADR-002); the harness carries **no divergent copy of memory logic** (§2.1). Pin the engine by version; a compatibility matrix lives in ADR-002. |

## Recommended monorepo layout (Variant B)

pnpm workspaces, Node ≥ 24, TypeScript strict. `packages/`:

| Package | Contents |
|---|---|
| `engine` | **Consumer only.** Pins `@cyb3rb1ade/plur1bus-engine` (the host-neutral package created in ADR-002) and adapts it to the harness's host interface. No memory logic of our own. |
| `core` | The resident daemon: turn loop (submit/event), prompt assembly, session store (`node:sqlite`+FTS5, V1/V2), scheduler (ADR-009), embed/rerank service surface (ADR-006), JSON-RPC server over UDS/named pipe. |
| `cli` | `plur1bus-harness` — a thin client over local IPC. Subcommands per §4: `setup, doctor, agent, user, model, login, channel, memory, project, import, service, update, uninstall`, plus `dreams` (ADR-009). |
| `api` | Harness API: the only externally reachable component. AuthN, **server-side RBAC**, audit, rate limits; carries REST/JSON-RPC, the MCP server endpoint and the A2A endpoints; serves the SPA. |
| `channels/*` | `telegram` (grammY), `discord` (discord.js), `matrix` (matrix-js-sdk + crypto-wasm), `buzz` (nostr-tools) — one package each, uniform adapter interface. |
| `providers/*` | `chat/*` (three wire formats), `embedding/*`, `rerank/*`, `auth/*` (declarative profiles). |
| `protocols/*` | `mcp` (client + server), `acp` (agent + client), `a2a` (server + client) on the official TypeScript SDKs (§8). |
| `ui` | The SPA in PLUR1BUS optics (ADR-004). |
| `importers` | `openclaw`, `hermes` (§4.2). |
| `distro` | `install.sh`, `install.ps1`, default config, branding, launchd/systemd-user/Windows-task units, optional Docker image. |

Shared: `packages/shared` (types, validation, logging with secret redaction), `tests/{unit,contract,e2e}`, `docs/`.

## Process model

- **Exactly one core daemon per installation**, multi-tenant by `agentId` (§4). Stores, local embedding and reranker models are opened/loaded once; ADR-006 owns the RAM budget and LRU unload.
- **CLI is a thin client.** JSON-RPC 2.0 over a Unix domain socket (`0o600`, directory `0o700`) or a Windows named pipe with an ACL restricted to the current user SID, plus a 32-byte token compared with `timingSafeEqual`. This is the shape PLUR1BUS's scoped-embedding IPC already uses (`lib/providers/scoped-embedding-ipc.js:143-163, 263-287, 376-390, 435` @ `89148f9`; `plur1bus-crons-embedding-portability.md` §2, §4) — reuse the envelope, replace the transport.
- **stdio** where a single parent process suffices (e.g. an ACP agent session), UDS/pipe otherwise.
- **No listening TCP port except the harness API**, loopback-bound by default; remote access via reverse proxy/VPN or built-in TLS (§9).
- **Fail-soft:** engine failure, timeout or crash never blocks a turn; supervisor with backoff, health check, visible status (§4.1, D2's degraded mode — detailed in ADR-002).

## Measurable targets (verified in CI from M1; measurement method in ADR-010)

| # | Target | Rationale / source |
|---|---|---|
| T1 | `plur1bus-harness --help` and other trivial paths: **p95 < 100 ms** cold, on macOS arm64 and Windows x64 | D6 |
| T2 | Warm core daemon: CLI submit → first provider byte dispatched **p95 < 300 ms**, excluding provider time | Hermes measured ~4.3 s → ~0.9 s for the same span after removing blocking probes (PR #59332, `harness-engineering-state-of-the-art.md` §4); a single-stack resident core should beat that |
| T3 | **Zero** network calls and **zero** subprocess spawns on the prompt-build path, asserted by a test that fails on any socket/spawn syscall during assembly | Top-15 rule 3, ibid. |
| T4 | Core daemon cold start to "ready to accept a turn": **< 3 s** without local models, **< 15 s** with the default local embedding model warmed in background (never blocking T2) | Contrast: fresh-CLI-per-query cost 13.0–13.9 s with ~75 % reusable overhead (`claude-agent-sdk-typescript#33`) |
| T5 | Recall inside its budget with fail-soft: hard deadline enforced, degraded result returned, **0 turns blocked** in a 1 000-turn soak with the engine killed at random | §4.1 fail-soft; PLUR1BUS today returns a cached recall or `undefined` on timeout (`index.js:13337-13346`) |
| T6 | CI green on all five targets (§10) for the §10 smoke E2E, from M1 | §10, §12 M8 |
| T7 | Exactly **one** resident core process per installation under the M1 smoke test; no second LanceDB/ONNX handle | §4 |

## Trade-off analysis

The decisive asymmetry is that Variant A's benefit is *code we do not write*, while its cost is *architecture we cannot change*. The code we would inherit — providers, OAuth, channels — is exactly the layer the brief expects to grow (new wire formats, new embedding/rerank adapters, per-agent tool allowlists), and it sits in a language the memory engine is not written in. The architecture we would inherit — one shared dashboard token, process-global tool registry, frozen session-start memory injection — contradicts three binding requirements (§5.1 roles, §8 per-agent MCP allowlists, D7's volatile-block placement) at once. Variant B inverts this: everything hard is hard *once*, in one language, and the engine sits where its author put it.

Against that, Variant B's maintenance exposure is real and is the single reason to keep C alive. The honest framing is that we are buying architectural coherence with recurring provider/channel maintenance, and mitigating the maintenance with milestone-scoped delivery and an ACP escape hatch that D5 pays for anyway.

## Consequences

- **Easier:** one language, one debugger, one CI matrix; the six injection points and the cache-stable prompt layout (ADR-010) are fully ours; `embed()`/`rerank()` are function calls, not IPC (D9); the D6 latency targets become reachable; RBAC is designed in rather than retrofitted; import from Hermes stays possible (`docs/import.md`) without depending on Hermes at runtime.
- **Harder:** we write and maintain provider resolution with three wire formats, the OAuth/device-code engine and credential pools, four channel adapters, and MCP/ACP/A2A in both directions. Matrix E2EE device verification is ours. Every provider policy change is our problem. Windows arm64 `node-pty` and darwin-x64 LanceDB need explicit, tested degradations. The first usable release is later than a Hermes-based one would be.
- **Revisit when:** (a) a mandatory channel proves unbuildable in Node within one milestone — then attach Hermes over ACP (Option C) for that channel only and record it in `UPSTREAM.md`-equivalent form; (b) Node's native-module story on Windows arm64 regresses such that T6 cannot be met; (c) an upstream PLUR1BUS decision makes the engine non-embeddable (would reopen ADR-002 first, not this ADR).

## Conflicts with the brief

**C1 — "No open TCP port except the harness API" is already violated by the engine on every non-Linux platform.**
*Finding:* PLUR1BUS's scoped-embedding owner election binds a **deterministic loopback TCP port** on every platform except Linux: `127.0.0.1 : 49152 + (sha256(dir)[0:4] % 16384)`, `exclusive: true` (`lib/providers/scoped-embedding-ipc.js:207-216`, read directly @ `89148f9`; claim listener at `:397-405`). Linux uses an abstract socket. On macOS — the owner's own platform — importing the engine as-is opens a TCP listener that is not the harness API.
*Source:* `lib/providers/scoped-embedding-ipc.js:207-216, 397-405` @ `89148f9` (read directly); `plur1bus-crons-embedding-portability.md` §2 "IPC ownership election", §4.
*Options:* (1) Because the harness runs **exactly one core daemon** (§4) that already owns the embedding service (D9), the cross-process owner election is unnecessary — run the embedding owner in-process and delete the claim listener on the harness path. (2) Keep the election but replace the non-Linux claim with a filesystem lock (macOS) and an exclusive named pipe (Windows). (3) Accept the loopback listener and document the exception.
*Recommended resolution:* **(1), with (2) as the PLUR1BUS-repo fallback.** The harness never needs the election; the PR to PLUR1BUS should make the transport pluggable so the OpenClaw plugin keeps a working cross-process path (named pipe on Windows) while the harness uses the in-process owner. Tracked as an action item in ADR-002.

**C2 — Node floor.** §2.2's Variant B text says Node ≥ 22.22; D1 says Node ≥ 24. D1 wins per the brief's precedence rule. Recorded only so the discrepancy is not re-litigated. No impact: V1/V2 confirm FTS5 on 22.22, 24-class and 26 builds alike.

## Open questions for the owner

1. **Q1 (§13 #1 — now answerable):** confirm that K4's failure (Hermes dashboard = one shared bearer token, no user model) is accepted as sufficient to close §13's "Variante A bestätigt?" with **B**. If yes, §12's milestones are re-cut for B in `docs/milestones.md`.
2. **Q2 (§13 #2):** macOS **x64** — mandatory or best-effort? It is the only target with no `@lancedb/lancedb` prebuild. Best-effort means Rosetta or a Rust source build; mandatory means we own that build in CI. Default per §13: best-effort.
3. **Q3:** Windows arm64 `node-pty` — if no prebuild materialises, is a **non-PTY (spawn+pipe) coding-CLI mode** an acceptable documented degradation on that target (D5 agents would lose TTY fidelity), or should win32-arm64 ship without external coding agents?
4. **Q4:** should the harness ship an **ACP attachment recipe for an existing Hermes installation** in v0.1.0 (Option C, ~1 adapter + docs), or is that deferred past v0.1.0?
5. **Q5:** the harness API is loopback-only by default. Do you want **built-in TLS + remote binding** in v0.1.0, or reverse-proxy-only with documentation (§9 allows both)?

## Action items

1. [ ] Record the K1–K4 verdicts and the Hermes dashboard-token finding in `docs/learnings-hermes-openclaw.md` so the counter-check is not repeated.
2. [ ] Re-cut §12's milestones for Variant B in `docs/milestones.md`, CLI-first, with T1–T7 as milestone exit criteria.
3. [ ] Open the PLUR1BUS issue for **C1** (pluggable embedding-owner transport; in-process owner for a single-daemon host) and link it from ADR-002's PR plan.
4. [ ] Stand up the CI matrix skeleton over the five targets with the three known degradations (darwin-x64 LanceDB, win32-arm64 node-pty, Matrix crypto via WASM) as explicit, named jobs — before any product code.
5. [ ] Re-verify the two runner facts flagged in `platform-binaries-and-startup.md` §CI runners before locking CI YAML: Windows-arm64 GA-vs-preview and private-repo availability; exact `macos-*` label spellings.
6. [ ] Add the T3 assertion (no socket/spawn during prompt build) as the first test in `tests/contract`, so the rule is enforced from the first commit rather than audited later.
7. [ ] Decide and document the engine pinning policy (version range + compatibility matrix) in ADR-002, and add a renovate-style job that opens a PR on each PLUR1BUS engine release.
