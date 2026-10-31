# Apple Foundation Models as a local model provider — design (D122)

**Status:** Proposed (phase 1: specification and plan, no product code); owner questions Q1–Q10 open (§8) · **Date:** 2026-10-31 · **Owner:** Christian (Cyb3rb1ade) · **Track:** providers and decision service, macOS only · **Register entry:** proposed **D122** (D117–D119 are taken by the media-verify, role-switch and shared-compute proposals, D120 by [`2026-10-30-harness-hygiene-coding-aci-design.md`](2026-10-30-harness-hygiene-coding-aci-design.md), D121 is planned by open PR #840 (Spec J); `D122` appears in no file of `origin/main` (`27ec7c4f0c`), of any remote branch or of any open PR body, checked 2026-10-31) · **Plan:** [`2026-10-31-apple-foundation-models.md`](../plans/2026-10-31-apple-foundation-models.md) · **Extends:** D112 (discovery), D34 and ADR-015 (decision service), D119 and D51 (node offer), `privacy.localOnly`; applies D120 language path B.

**Inputs read** (`origin/main` @ `27ec7c4f0c`): `packages/providers/src` (`local/types.ts`, `local/adapter.ts`, `local/probe.ts`, `local/guard.ts`, `request.ts`, `types.ts`, `client.ts`, `index.ts`); `packages/core/src/composition/http.ts` (`providerFetch`), `packages/core/src/platform.ts` (`ipcAddress`, `ensurePrivateDir`), `packages/core/src/privacy/local-only.ts`, `packages/core/src/discovery/` (`http.ts`, `types.ts`, `scanners/`), `packages/core/catalog/model-metadata.json`, `packages/config-schema/schema/config.schema.json`, `crates/plur1bus/src/supervisor/` (`state.rs` `RoleKind`, `child.rs`, `import_worker.rs`), `crates/plur1bus/src/commands/decision_notice.rs`, `crates/plur1bus/src/cli.rs` (`ModelCmd`); [`docs/egress.md`](../../egress.md), [`docs/privacy.md`](../../privacy.md), [`docs/decision-service.md`](../../decision-service.md), [ADR-012](../../adr/ADR-012-process-model-and-languages.md), [ADR-013](../../adr/ADR-013-configuration-and-restart-classes.md), [ADR-015](../../adr/ADR-015-decision-service.md), [ADR-016](../../adr/ADR-016-api-stability-and-versioning.md); [`2026-10-03-model-discovery-design.md`](2026-10-03-model-discovery-design.md) (D112), [`2026-10-29-shared-compute-design.md`](2026-10-29-shared-compute-design.md) (D119), core spec rows D34, D51 and §7.1 in [`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md); the Laya evidence in [`docs/evidence/decision/2026-10-21-linux-x64-candidates.md`](../../evidence/decision/2026-10-21-linux-x64-candidates.md); owner decisions of 2026-10-21 (decision model on Windows) and 2026-10-30/31 (D120, language path B).

## 1. Context

macOS 27 ships Apple's Foundation Models with a command line, `/usr/bin/fm`, and a Chat Completions server, `fm serve`. The owner wants it as an **optional local model provider**: on-device, no key, no network, on the Mac only.

| # | Fact | Source |
|---|---|---|
| F1 | `fm` subcommands: `chat`, `config`, `count-tokens`, `license`, `models`, `quota-usage`, `respond`, `schema`, `serve` (`available` is deprecated in favour of `models`). | spike; `fm --help` re-checked 2026-10-31 |
| F2 | Models: `system` (on-device, default; "AFM 3 Core Advanced" on the owner's Mac), `pcc` (Apple Foundation Model on **Private Cloud Compute: cloud**), `<model>` from a custom model provider (`fm serve --model-provider`). | `fm --help`, spike |
| F3 | `fm license --status` printed "Agreed to license FM1 version 1.1 on 31. Okt. 2026" (licence already agreed on the owner's Mac). Public docs: every `fm` command fails until `sudo fm license` is accepted once, system-wide; declining or not accepting exits **69** with a message on stderr. | spike; public docs (mac.install.guide, eclecticlight.co 2026-10-10) |
| F4 | `fm models` prints a human table (tick or cross per model) and exits 0 although `pcc` is unavailable ("Private Cloud Compute is not available in this context. Please use the Terminal app."). No JSON flag is shown. | re-checked 2026-10-31 |
| F5 | `fm serve` **with no flag listens on TCP**; `--socket <path>` selects a Unix domain socket. Endpoints `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (streaming and non-streaming). | `fm serve --help` |
| F6 | Over `--socket`: `/health` returns `status` and per-model `available` (+ `reason`); `/v1/models` lists `system` and `pcc` (owned_by Apple); German summarisation correct; 0.4–0.6 s for short prompts (server log "108→26 tokens · 556ms"); **tool calling works** (`tool_calls`, `finish_reason: "tool_calls"`); **`response_format: json_schema` works** (enum classification `{"category": "reminder"}`). | spike (one Mac, short prompts) |
| F7 | **Quirk:** the server streamed SSE chunks although the request did not set `stream: true`. Whether `stream: false` yields a plain JSON body is unverified (U1). | spike |
| F8 | `fm serve` created the socket as `srwxr-xr-x` (0755) in `/tmp`. `fm quota-usage`: "System: Not applicable (quota only applies to PCC)". | spike |
| F9 | About 3B parameters; **4,096-token context shared by instructions, prompt and answer**. Needs macOS 27, Apple Silicon, working Apple Intelligence (region and language limits, SIP on, no external boot volume); model download up to 14 GB (M3 or newer, at least 12 GB RAM). | public docs only, not verified here |

**What the repository has today.** `packages/providers` has the `chat_completions` adapter with a `fetch` seam, `createLocalChatAdapter` (loopback only, always `NO_AUTH`) and probe, monitor and guard for http(s) loopback servers, but **no Unix-socket transport** (no `socketPath`, `undici` or `unix:` in `src`). The core's `providerFetch` runs every provider call through the egress gate (`egress.decide`: scheme, port, host, SSRF ranges). `privacy/local-only.ts` classifies **by endpoint origin** (loopback, or listed in `privacy.localEndpoints`), never by model. D112 discovery is built (`openai-models` scanner, curated table with synthetic rows only, capability vocabulary `tools`, `vision`, `reasoning`, `audio_in`, `audio_out`, `structured_output`, `prompt_caching`). The supervisor's `RoleKind` is `Core | Api | Module`; restart backoff is 1, 2, 4 … 60 s with give-up after five exits (H3B-R26); `import_worker.rs` is the precedent for a supervisor-owned child that is not a module. CLI: `model list|scan|override`, `setup` with `decision_notice.rs`, `1staid check`, `config set`. Decision service: backends `role|laya|kev|jev|auto`; **no Laya candidate passes the German gate** (A: 46.7 % German against 65.0 % English; B multilingual 51.7 % against 65.0 %), so German `auto` selection stays locked.

## 2. Decisions at a glance

| # | Topic | Decision | Main alternative, why not |
|---|---|---|---|
| AD1 | Integration path | **`fm serve --socket` as a supervised sidecar** and the existing `chat_completions` adapter over a Unix socket; no Swift helper, no framework binding (§3.2) | A Swift helper linking FoundationModels: a new signed binary that duplicates what `fm serve` gives; kept only as the fallback if `fm serve` disappears. `fm respond` per call: process spawn per call, no streaming, no tools. |
| AD2 | Names | Provider id `apple-fm` (reserved), vendor `apple`, one model: `system` (shown as `apple-fm/system`). `pcc` and custom-provider ids are never registered (§3.6). | Registering `pcc` as a cloud provider: unavailable from daemon contexts and a second privacy surface (Q6). |
| AD3 | Transport | A **managed Unix-socket transport** in `packages/providers`: the profile names a managed socket id, never a path; not network egress, own guard (§3.3). | `fm serve --port` on loopback: opens a TCP port any local process can use and drags the egress gate (`allowLoopback`, `allowHosts`, `allowPorts`) in for no benefit. |
| AD4 | Placement | Socket in `run/apple-fm/` (mode 0700, owned by the user) under the harness home, **never `/tmp`**, because `fm` creates the socket 0755 (§3.3, §4). | `/tmp` or the `embedding.sock` fallback directory: the owner rule is no `/tmp`. |
| AD5 | Supervision | A **sidecar slot in the Rust supervisor** (`RoleKind::Sidecar`), always `fm serve --socket <path>`, never `--port`, `--host` or `--model-provider` (§3.4). | A module (ADR-012): `fm` is not a harness module and does not speak the lifeline protocol. Spawning from the core: the core would own a process the supervisor must reap. |
| AD6 | Licence and sudo | **The person alone accepts the licence, in Terminal.** The harness reads `fm license --status`, shows the exact command `sudo fm license`, never runs `sudo`, never runs `fm license`, never handles a password (§4). | Running the acceptance on the person's behalf: against the owner rule and Apple's terms. |
| AD7 | Locality | `system` is local by a **fixed table in code**; locality is decided per model, not per endpoint; the adapter refuses any other model id before I/O (§3.6). | Trusting the endpoint: the same socket serves `system` (local) and `pcc` (cloud). |
| AD8 | Roles | Allowed: `decision` (classification) and `summarize` (short inputs only), both behind a per-call fit guard; **refused**: `chat`, `reasoning`, `dream`, `capture`, because the system prompt plus tool schemas exceed 4,096 tokens (§3.7). | Warn only: a role that cannot fit would fail on every turn. |
| AD9 | Decision service | `apple-fm` is an **optional macOS backend, explicit-only**, and enters `auto` only after it passes the same German gate and beats Laya; **Laya stays the cross-platform default** (§3.8). | Adding it to `auto` now: the gate is unmeasured, the model changes with the OS. |
| AD10 | Language (D120 path B) | The provider adapter, transport, discovery, privacy and guard extend existing TypeScript packages, so **TypeScript**, justified: no new component, the Phase 4 port of `providers` carries the files along. The sidecar supervision is supervisor work, so **Rust**, executor Claude agent. | A Rust provider layer: it does not exist; building it for one provider would be a second provider stack. |

## 3. Architecture

```
 person (Terminal): sudo fm license          one time, system-wide, never run by the harness
 plur1bus supervise (Rust)                       appleFm.enabled = true, macOS >= 27, arm64
   └─ apple-fm slot: /usr/bin/fm serve --socket <home>/run/apple-fm/fm.sock     (run/apple-fm/ is 0700)
        ▲ GET /health every healthIntervalMs → daemon.status.children[apple-fm]
        │ HTTP over the Unix socket
 core (TypeScript): synthesized provider `apple-fm` ── managed-socket guard ── chat_completions adapter
   ├─ discovery: GET /v1/models → catalog (only `system`; `pcc` filtered)        (D112)
   ├─ router: roles decision, summarize only; fit guard; localOnly by model       (§3.6, §3.7)
   └─ node offer: advertises apple-fm/system to a primary                         (D119, §3.9)
```

### 3.1 Provider and model identity

The core **synthesizes** the provider `apple-fm` in composition while `appleFm.enabled` is true and the supervisor reports a slot: `{ vendor: "apple", wireFormat: "chat_completions", transport: "rest", socket: "managed:apple-fm", baseUrl: "http://apple-fm.invalid/v1" }`. It is not written into `providers.*` (ADR-013 §5: only the supervisor and the CLI write `config.json`), the id is reserved (`providers.apple-fm` in a file is `E_CONFIG_INVALID`, reason `reserved-provider-id`), and the person has no profile to hand-write. The host label `.invalid` never resolves (RFC 2606), so a bypass of the transport fails closed at DNS and at the egress gate. Credentials are always `NO_AUTH`; an Authorization, Cookie or Proxy-Authorization header on this provider is a `TypeError`, the same rule as for a loopback server in `local/adapter.ts`.

### 3.2 The adapter

`createChatCompletionsAdapter` is reused unchanged except for two things: the `fetch` seam receives the socket transport (§3.3), and `complete()` accepts an SSE body (F7): it reads `Content-Type`, and on `text/event-stream` consumes the stream parser and returns the final `done` result instead of failing in `JSON.parse`. The router uses `stream()`; the `complete()` change covers every other caller. Request limits on this wire: no image parts (`vision` is not a capability: `invalid_request` before I/O), no `reasoning` directive, tools and `json_schema` pass through. `includeUsage`, `allowMissingDone`, the token field name and `parallel_tool_calls` are set from AF0's findings (U4, U14); until then the fake server and the adapter assume the OpenAI shapes of F6 and tolerate a missing `[DONE]` after a `finish_reason`. Provider concurrency is capped at 1 until AF0 measures (U8).

### 3.3 Unix-socket transport, egress and SSRF classification

`packages/providers/src/local/unix.ts` (new) exports `createUnixFetch(socket, { guard })`, a `fetch` that connects to one managed socket with `node:http` and `socketPath` (no new dependency). The `guard` is a port supplied by the core (like `EgressPolicy`): it runs `verify()` before each connection (cached 2 s) and keeps filesystem policy out of the providers package.

**Classification.** A managed socket is **not network egress**: no DNS, no IP address, no port, no remote hop. `egress.decide` is not consulted, no `egress.status` counter moves (those count per-hop network decisions), and the SSRF ranges (private, loopback, link-local, metadata) have nothing to classify. Enabling Apple FM does **not** widen `egress.*`; a TCP loopback server would need `allowLoopback`, `allowHosts` and `allowPorts`. What a socket transport risks instead is a **confused deputy**, a request steered to some other local socket (a container runtime, an agent socket). Four rules close it:

1. **No path in configuration.** The profile names the managed id `apple-fm`; the core resolves it from `Layout` to `<home>/run/apple-fm/fm.sock` (the Rust and TypeScript layouts compute the same path, parity-tested like `coreAddress`).
2. **Guard per connection:** the parent directory opens with `O_NOFOLLOW | O_DIRECTORY`, belongs to the effective uid and has no group or other access; the socket file is of type socket and belongs to the same uid; the path is at most 103 bytes (`sun_path` on macOS). The helpers of `platform.ts` that guard `embedding.sock` (`ensurePrivateDir`, `requirePrivateDir`; module-private today) are exported for this. **No fallback directory**: a too-long path makes the provider `unavailable`, reason `socket-path-too-long`, and the doctor tells the person to use a shorter `PLUR1BUS_HOME` (Q9).
3. **Fixed request surface:** methods GET and POST; paths `/health`, `/v1/models`, `/v1/chat/completions`; host label `apple-fm.invalid`; request body at most 1 MiB; no redirects; connect timeout 2 s; `agent: false`.
4. **No fallback to TCP.** A failed guard makes the provider unavailable; nothing else is tried. `core.status.providers.apple-fm` carries `transport.unix` counters (`ok`, refused by reason), never paths or content.

### 3.4 Sidecar supervision (Rust, ADR-012)

New `crates/plur1bus/src/supervisor/apple_fm.rs` and `RoleKind::Sidecar` (ADR-012 §1: supervised child, backoff, give-up; `import_worker.rs`: owned process-tree teardown). `fm` does not read the harness lifeline, so the slot cannot use the module protocol.

- **Preconditions (pure, injected facts):** macOS 27 or newer (`sw_vers`), `arm64`, `/usr/bin/fm` is a regular file owned by root and not writable by group or other (absolute path, no `PATH` lookup). A failed precondition is a **state**, not an error: `skipped` (other OS) or `blocked` with a reason; no spawn, no backoff.
- **Licence precheck:** `fm license --status` (5 s bound, stdin closed). The licence counts as agreed only on exit 0 with stdout starting `Agreed`; a non-zero exit (69 on the other commands, U16 for `--status` itself) is `blocked: licence`, an exit 0 with unparsable text is `blocked: licence-unknown`. Either way no spawn loop; re-checked at most every 60 s and on `1staid check`. The harness never runs `fm license`.
- **Private directory:** `run/apple-fm/` is created 0700 and verified (real directory, our uid, no symlink) before every start; a stale socket is removed only if it is of type socket, ours, and nothing answers on it.
- **Spawn:** `/usr/bin/fm serve --socket <abs path>`, exact argv (a test asserts there is no `--port`, `--host` or `--model-provider` and that a plain `fm serve`, which opens TCP (F5), is never started); environment reduced to `HOME`, `LANG`, `PATH=/usr/bin:/bin` (no harness secret, `spawn_secrets.rs` is not used); cwd `run/apple-fm/`; stdin null; own process group; output to the rotating `logs/apple-fm.log`.
- **Health:** `GET /health` over the socket (minimal HTTP/1.0 client on `std`, 2 s bound, body at most 64 KiB) every `supervisor.healthIntervalMs`. States: `starting`, `ready` (`system.available`), `degraded` (`system.available: false`, reason text bounded to 200 characters, re-polled every 30 s), `crashed` (backoff 1 … 60 s, `gave-up` after five exits), `blocked`, `skipped`. Exposed as an additive `detail` on `daemon.status.children[]` (ADR-016, `x-since`); no new RPC method.
- **Stop and orphans:** SIGTERM to the group, grace at most 5 s, then SIGKILL, then unlink the socket. `run/apple-fm.pid` holds `<pid> <start time> <instance>`; after a supervisor crash the next start kills a leftover `fm` only if its executable is `/usr/bin/fm` and its argv carries our socket path (no adoption: no nonce is possible). Whether `fm serve` exits by itself when its parent dies is U7.
- **Start mode:** `always` while enabled (no on-demand RPC in v1; idle footprint is U9, Q10).

### 3.5 Discovery and catalog (D112)

`/v1/models` exists, so the provider is a scanner target: the synthesized profile uses `discovery: "openai-models"` through `createPinnedClient` with a `socketPath` option (no egress hop, same limits R11, same validation). The scanner for vendor `apple` **filters ids to the local table before reconcile**: `pcc` and anything else is dropped and reported as a new additive warning `filtered_by_policy`; it never reaches the catalog or a picker. Metadata: a new vendor section `apple` in `packages/core/catalog/model-metadata.json` (fixture `test/fixtures/model-ids/apple.json`):

```json
"apple": [ { "pattern": "^system$", "kind": "chat", "contextWindow": 4096, "capabilities": ["tools", "structured_output"] } ]
```

**Vocabulary note.** The capability vocabulary has no `json_schema` and no `streaming`: `response_format: json_schema` is the existing `structured_output`, and streaming is not a capability (every chat adapter streams; this server always does). The vocabulary stays unchanged. Scan cadence, backoff and catalog rules are D112's; a scan while the sidecar is `blocked` or `skipped` is `failed:network` with no catalog change (R6).

### 3.6 Privacy: `system` is local, `pcc` is cloud

- **By model, not endpoint.** `privacy/local-only.ts` gains `isLocalModel(provider, model)`: true only for a fixed table `{ "apple-fm": ["system"] }` on the synthesized provider. `isLocalEndpoint` keeps answering for http(s) origins; every chat and role enforcement point that today passes a base URL (`session/chat-models.ts`, the router build in composition; AF2 greps every `isLocalEndpoint` and `assertLocalEndpoint` call on a chat path) also asks the model rule. A model outside the table is **cloud or unknown, and fails closed**: refused under `privacy.localOnly` (`E_DENIED`, reason `local-only`) and, outside local-only, refused all the same by the adapter allowlist.
- **Allowlist in the adapter.** The provider's adapter accepts the model id `system` only; any other id (`pcc`, a custom-provider name) throws `invalid_request`, code `model_not_allowed`, **before any byte is written** (a spy on the socket proves it). Nobody can reach `pcc` by naming it in a role, a profile or a `config set`.
- **`pcc` is hidden by default** and not offered in v1 (Q6): not in the catalog (§3.5), not in pickers, not in `1staid`'s model rows (`apple-fm.models` reports it as "not offered"). It is also unavailable from daemon contexts (F4), which is why no feature may depend on it.
- **`localOnly` consistency:** `apple-fm/system` counts as local in `privacy.local-only` and in the doctor's `localOnlyFindings`; a node-served `apple-fm/system` counts as local under D119's cluster rule (§3.9).

### 3.7 Roles and the 4k context

| Role | `apple-fm/system` | Rule |
|---|---|---|
| `chat`, `reasoning` | refused | the system prompt and tool schemas alone exceed 4,096 tokens |
| `dream`, `capture` | refused | inputs are memory batches and whole turns |
| `decision` | allowed | classification prompts are small (D105 triage JSON, `choice` over a short list); per-call fit guard |
| `summarize` | allowed, short inputs | per-call fit guard; on overflow the role's documented fallback applies (deterministic digest), the harness never chunks to make it fit |
| `embedding`, `rerank` | n/a | chat models only (catalog kind `chat`) |

- **Static rule at assignment.** A model whose catalog `contextWindow` is below `MIN_CONTEXT_AGENT_ROLE` (16,384, a named constant) cannot be assigned to `chat`, `reasoning`, `dream`, `capture`, in `modelRoles` (`config set` and the web form), in a model profile, or as a chat's model: `chatModelOptions` lists it as `selectable: false` with the new `disabledReason: "context-too-small"` (next to `local-only` and `unavailable`). The refusal names the window and the floor.
- **Per-call fit guard** (`packages/core/src/session/context-fit.ts`, new): `bound(messages, tools) + reserve ≤ contextWindow`, with `reserve = maxTokens ?? 512`. `bound` comes from the engine's token counter (RE-D20, `crates/plur1bus-engine/src/tokens/`) in its `heuristic` method, which has no Apple family; until AF0 calibrates the ratio against `fm count-tokens` on the German and English fixtures the guard uses `ceil(UTF-16 length / 3)` (German tokenises worse than the engine's `/4` rule). `fm count-tokens` is authoritative but a process spawn: it serves AF0, the doctor and evals, **not** the hot path.
- **Overflow** is a typed refusal before I/O (`invalid_request`, code `context_overflow`, not retryable); the server's own overflow error, shape unknown (U4), maps to the same code. The consumer fallbacks of ADR-015 apply (rule triage, no pruning, deterministic digest).

### 3.8 Decision service (ADR-015, D34, owner decision of 2026-10-21)

- **Two ways in.** (a) `modelRoles.decision = "apple-fm/system"` works as soon as the provider exists, through the existing `role` path (default selection per ADR-015): JSON classification via the router, confidence `uncalibrated` (a role's self-report), privacy and locality as above, no gate. (b) `decision.backend: "apple-fm"` (a new additive enum value) is a **dedicated backend**: `noul`, `choice`, `score` become one `response_format: json_schema` call each (enum of option ids), confidence `uncalibrated` unless the server exposes log-probabilities (U15).
- **Selection.** `apple-fm` is **explicit-only** until it passes the §7.1 German gate (German accuracy at most 5 points below English, German Brier at most 0.05 above English, on the 60-item de/en set) and beats Laya on the same machine; then it may join `auto` in Kev's slot, after Jev and before Laya (ADR-015: a local backend only where its spike passed and beat Laya). Failing the gate leaves explicit selection available **with a diagnostic**, and `auto` never picks it for German (the Laya rule). **Laya stays the cross-platform default** (D34): Windows and Linux have no Apple FM, the Windows notice (Laya too slow on Windows CPUs; recommend a cloud decision model; `laya-multilingual` fp32 default, int8 opt-in) is unchanged.
- **Latency eligibility.** Measured 0.4–0.6 s for short prompts (F6) against ADR-015's budgets: routing 200, pruning 100, placement 200, zoom 150, compaction 200 ms, triage and skills 2,000 ms. The backend is attempted only for a deadline of at least `APPLE_FM_MIN_DEADLINE_MS` (placeholder 1,000 ms until AF0 measures p95 with a cold start); in practice **triage and skill selection**, not the hot paths, where Laya (the multilingual candidates measure about 40–160 ms warm p50 on CPU) stays the only fit. Classification and short summarisation are its roles.
- **The model changes with the OS.** The revision identity is the display name plus the macOS build (`sw_vers -buildVersion`). Gate evidence and any calibration are keyed by it; an OS update lapses `auto` eligibility until re-measured (ADR-015: a model revision change leaves eligibility unproven).
- **The gate may be unsatisfiable as written.** The gate script (`scripts/spikes/decision-laya-lib.mjs`) sums squared errors over all options, so a backend without probabilities has a one-hot Brier of 2 × its error rate and a Brier gap of 0.05 allows at most a 2.5-point accuracy gap, stricter than the 5-point accuracy clause (Q8). AF5 reuses that script.

### 3.9 Node offer (D119, D51)

A MacBook node with `appleFm.enabled`, a `ready` slot, the licence agreed **on that node** (`fm license --status` there; the primary never accepts anything) and a `compute.serve` grant that includes the class advertises `apple-fm/system` in `compute.hello.models`: classes `decision` and `llm.chat` (the latter routed as `node:<device>/apple-fm/system` under D51's fallback policy, never queued), `contextWindow: 4096`, revision = macOS build, a new runtime family `apple-fm` (additive in `plur1bus.compute-node/1`). `pcc` is never advertised. The primary applies **its own** fit guard and role refusals with the advertised window, so a node cannot make `apple-fm/system` the main chat model of a VPS primary either. Privacy: D119 SC10 reads `privacy.localOnly` as "inside the owner's cluster", so a node-served `apple-fm/system` is local; D116's rule (other persons' `privat` items never leave the primary) filters the job's bounded state as for any node job. The socket and `fm serve` stay on the node, the node bridge relays (D51 b); nothing listens on the network.

### 3.10 Configuration, doctor and CLI

- **Config (ADR-013), schema in `packages/config-schema`:** one new top-level namespace `appleFm` with `appleFm.enabled` (boolean, default `false`, `x-restart: live`, `x-tier: advanced`, `x-write-roles: [owner, admin]`, `x-audit: true`, like `privacy.localOnly`): the supervisor applies it through its live apply sequence (starts or stops the slot), not through a module restart. On a machine that cannot run it the key is accepted and ignored (one config can span a cluster) and the doctor row says `skipped`. Later: `decision.backend` gains `apple-fm` (AF5). There is **no key for the `fm` path** (a path in config would be code execution by config writers; a test seam exists only behind `PLUR1BUS_ALLOW_TEST_INTERNALS`). `docs/config.md` is regenerated by `pnpm docs:gen`.
- **Doctor and `1staid check` rows** (Rust, `skipped` off macOS): `apple-fm.platform` (macOS version, Apple Silicon), `apple-fm.cli` (`/usr/bin/fm` present, owner and mode), `apple-fm.license` (`fm license --status`; on exit 69 a `fail` with the repair text "Run this yourself in Terminal: `sudo fm license`", shown, never run), `apple-fm.intelligence` (Apple Intelligence state: derived from `/health` `system.available` and its bounded reason text, since no machine-readable state is known, U11), `apple-fm.models` (`fm models` availability; the parse is tolerant: a tick or cross on the `system` line, `unknown` when unparsable, F4), `apple-fm.sidecar` (slot state and health). D111 events use source kind `model`, id `apple-fm`; no prompt text.
- **CLI parity, nothing invented.** Existing commands carry it: `plur1bus config set appleFm.enabled true`, `plur1bus model list|scan --provider apple-fm`, `plur1bus 1staid check` (new rows), `plur1bus daemon status` (slot in `children`), `plur1bus setup` (a non-blocking macOS notice built like the Windows/Laya notice in `decision_notice.rs`: a pure function over injected OS facts, shown only on an eligible Mac, never enables anything). No new command, no change to the generated `docs/cli.md`. Web: `context-too-small` in `chatModelOptions` with de and en strings; the models page needs nothing new (D112 rides with M3).

## 4. Security

| Concern | Rule |
|---|---|
| Socket permissions | `fm` creates the socket 0755 (F8). The harness relies on the **directory**: `run/apple-fm/` is created 0700, owned by the user, verified without following symlinks before every start and on every connection (§3.3). `connect(2)` needs write permission on the socket file, so 0755 should not admit other users by itself, but the mode of a file `fm` creates is not ours to rely on (umask, a later `fm` version). Never `/tmp`, no fallback directory. |
| Same-user processes | Any process of the owner's account can use the on-device model, exactly as it can run `fm` itself; there is no per-caller authentication on `fm serve` (none documented). Agent tools must not reach it: `run/` is outside every agent root, so D109 defaults to approval or deny; a test asserts the policy decision for `run/apple-fm/fm.sock`. |
| No `sudo`, no passwords | The harness never runs `sudo`, never runs `fm license`, never asks for, receives or types a password; the agent never enters one. The licence is accepted by the person, in Terminal. The harness detects the state (`fm license --status`, exit 69 on other commands) and shows the exact command for the person to run. Apple's terms are linked, never accepted for the person; the link target is U3. |
| `pcc` is cloud | Never registered, never offered, never reachable by model id (§3.6); `--model-provider` is never passed, so custom-provider models cannot appear. It counts as cloud for `privacy.localOnly` if it is ever added (Q6). |
| No secrets | `NO_AUTH`; no key, token or lease for this provider; the sidecar environment is reduced (§3.4); nothing from the secret store crosses into `fm`. |
| No network surface | The sidecar is always started with `--socket`; a plain `fm serve` opens TCP (F5) and is never run; a test asserts the argv and that no TCP listener belongs to the slot. |
| Binary trust | Absolute path `/usr/bin/fm`, root-owned and not group- or world-writable, checked before each spawn; no `PATH` lookup, no configurable path. |
| Logs | `fm serve` output goes to `logs/apple-fm.log` (rotating). If it carries prompt text (U10) that file would leak into logs and bundles, so it is **excluded from `1staid bundle` and logged only as counts** until AF0 shows what the server writes. |
| Content | Prompts and answers are never written to harness logs, events or `core.status` by this feature; D111 redaction applies to everything the harness itself writes. |

## 5. Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Licence missing | `fm license --status` non-zero; any `fm` command exit 69 with stderr | Slot `blocked: licence`, **no spawn loop**; provider `unavailable` (reason `licence`); doctor `apple-fm.license` fail with the command for the person; roles fall back per ADR-015 |
| Apple Intelligence off, unsupported region or language, SIP off, external boot | `/health` `system.available: false` + bounded reason; `fm models` cross | Slot `degraded` (process stays, cheap), re-polled every 30 s; provider `unavailable` (reason `model-unavailable`); doctor shows the reason text; a later change heals without a restart |
| Model downloading (up to 14 GB) | the same (reason text unknown, U11) | Treated as `degraded`; no chat error, jobs fall back; the doctor says "model not ready" with the reason |
| Sidecar crash or hang | exit, or `/health` fails twice in a row | Backoff 1 … 60 s, `gave-up` after five exits (H3B-R26); the socket is removed; in-flight streams fail with kind `network`, `retryable: false`, code `unavailable` (the `guardLocalAdapter` pattern) so the router falls back instead of waiting; the monitor refreshes status before the next call |
| Supervisor crash | next supervisor start | `run/apple-fm.pid` check kills a leftover `fm` that is ours (executable and socket path match); then a normal start |
| 4k overflow | static: window below `MIN_CONTEXT_AGENT_ROLE`; per call: the fit guard; server: overflow error | Refusal at assignment; typed `context_overflow` before I/O; consumer fallback (rule triage, no pruning, deterministic digest) |
| Socket path longer than 103 bytes | guard, at start and at connect | Provider `unavailable` (`socket-path-too-long`), no `/tmp` fallback, doctor hint to shorten `PLUR1BUS_HOME` |
| Socket missing, wrong owner or directory mode | guard | `unavailable` (`socket-untrusted`); nothing is sent; the slot is restarted only through the normal state machine |
| Not macOS, macOS older than 27, Intel | preconditions | `skipped`; no spawn, no error; `appleFm.enabled` is kept in config; the doctor row says why |
| Server streams although `stream: false` | `Content-Type` | Handled by content type (§3.2), not by the request |
| `fm` missing, replaced or writable | binary check | `blocked: cli`; no spawn |

## 6. Test strategy

No test uses the network or a real `fm`; **no real `fm` in CI** (GitHub's macOS runners have neither macOS 27 nor Apple Intelligence). Fixtures are synthetic, written to the shapes of F6 with invented ids and text.

1. **Fake `fm serve` over a Unix socket** (`packages/providers/test/fixtures/fake-fm-serve.ts`, in a temp directory of mode 0700): `/health` variants (ready, `system.available: false` with a reason, `pcc` unavailable), `/v1/models` with `system` and `pcc`, chat completions that **always stream** (also for `stream: false`), a `[DONE]`-less variant, tool calls, `json_schema` answers, a usage chunk present or absent, an overflow error, a hang, a mid-stream disconnect. It creates the socket 0755 on purpose.
2. **Transport:** managed id only; a path in the profile is refused; symlinked parent, directory mode 0755 or 0770, socket owned by another uid (injected), a regular file instead of a socket, a path of 104 bytes, a redirect, a path outside the three, an Authorization header, an HTTP method other than GET and POST. No TCP socket is opened (a listener spy). On win32 the provider reports `unavailable(reason=platform)`, which is itself tested.
3. **Adapter:** SSE with `stream: false` returns the right `ChatResult`; tool calls and `json_schema` round-trip; image parts and a `reasoning` directive are refused before I/O; the model allowlist refuses `pcc` and an unknown id **with zero bytes written** to the socket.
4. **Privacy:** under `privacy.localOnly` `apple-fm/system` is allowed and a model named `pcc` is `E_DENIED` reason `local-only`; the scanner drops `pcc` (`filtered_by_policy`) and the catalog never contains it; the picker marks small-window models `context-too-small`; `modelRoles.chat = apple-fm/system` is refused with the window and floor in the message.
5. **Fit guard:** a request just inside and just over the bound for German and English text; overflow becomes `context_overflow` with zero I/O; the consumer fallbacks run (rule triage, deterministic digest).
6. **Discovery:** reconcile with a `system`-only list, a disappearing `system`, an empty list; table test for the `apple` pattern against `test/fixtures/model-ids/apple.json` (no duplicate pattern, anchored).
7. **Supervisor (Rust):** a **fake `fm` executable** emulates `license --status` (exit 0 and 69), `serve --socket` (binds 0755, answers `/health`, modes: crash, hang, ignore SIGTERM, leave a stale socket). Tests assert the exact argv (no `--port`, `--host`, `--model-provider`), the reduced environment, licence-blocked means no spawn, the 0700 directory and its repair or refusal, backoff and `gave-up`, pidfile cleanup of a leftover process that is ours and not of one that is not, the `daemon.status` detail, no TCP listener. Preconditions and doctor rows are table-driven over injected OS facts. Spawn paths are `cfg(unix)`; the pure logic runs on every CI target.
8. **Parity:** `Layout` socket path identical in Rust and TypeScript (fixture, as for `coreAddress`); generated docs and schema fixtures current.
9. **Live probe, manual only:** `scripts/spikes/apple-fm-probe.mjs` (AF0) and the German gate script (AF5) run on the owner's Mac behind `PLUR1BUS_APPLE_FM_LIVE=1`, never in CI; their receipts are committed as evidence. Neither script runs `sudo` or `fm license`.

## 7. Unknowns

| # | Unknown | Why it matters | Resolved by |
|---|---|---|---|
| U1 | Does `stream: false` give a plain JSON body, or does the server always stream? | the adapter must not assume either; `complete()` is made tolerant (§3.2) | AF0 |
| U2 | **Apple's licence terms for using model output** (commercial or other restrictions, redistribution, training of other models) are unknown. | whether output may feed memory, skills or exports, and whether a commercial use of the harness is affected | the owner reads the terms in Terminal (`fm license` shows them; not run in this work); the harness links them and never accepts |
| U3 | Where the Legal Notice and Terms can be linked (a stable URL) | the doctor and setup must "link them", and no URL may be invented | owner; until then the notice names the command only |
| U4 | `usage` in responses, `stream_options.include_usage` accepted, `[DONE]` terminator, the shape of overflow, unknown-model and unavailable errors, token field name | adapter options and error mapping (§3.2, §3.7) | AF0 |
| U5 | Is the window of "AFM 3 Core Advanced" really 4,096 tokens? Public docs say about 4,096 for the roughly 3B model | catalog value, role floor, fit guard | AF0 (`fm count-tokens`, overflow probe) |
| U6 | German quality and support at the owner's language and region settings | the §7.1 gate decides eligibility for `auto` | AF5 |
| U7 | Does `fm serve` exit when its parent dies or stdin closes? | orphan handling; the pidfile cleanup is the fallback | AF0 |
| U8 | Concurrent requests: queued, parallel or refused | provider concurrency cap (1 until measured) | AF0 |
| U9 | Idle RSS, cold-start latency, whether the model unloads when idle | `start: always` against on-demand (Q10); `APPLE_FM_MIN_DEADLINE_MS` | AF0 |
| U10 | What `fm serve` writes to stdout and stderr (prompt text?) | log and bundle policy (§4) | AF0 |
| U11 | A machine-readable Apple Intelligence state, and the reason texts for "downloading", "region", "disabled" | doctor rows pass bounded free text today | AF0 (record the texts) |
| U12 | `--socket` with a relative path, an existing stale file, a path near the limit | the harness always passes an absolute path and removes stale files itself | AF0 |
| U13 | Stability of the `fm` surface across 27.x updates (`available` is already deprecated) | argv and `/health` shape are pinned by tests; the doctor reports a missing subcommand | doctor, each OS update |
| U14 | Parallel and forced tool calls (`parallel_tool_calls`, `tool_choice`) | the adapter option set | AF0 |
| U15 | Log-probabilities in responses | calibrated confidence; the Brier clause (Q8) | AF0, AF5 |
| U16 | Exit code and text of `fm license --status` when the licence is **not** agreed (verified only for "agreed", exit 0) | the licence precheck (§3.4) and the doctor row | the fake covers both; the first run on a Mac without the licence |

## 8. Owner questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Register entry | D122 · wait for #840 and renumber | **D122**: free everywhere (main, all remote branches, open PR bodies); #840 plans D121 |
| Q2 | Integration path | `fm serve` sidecar · Swift helper linking FoundationModels · `fm respond` per call | **`fm serve --socket` sidecar**; a Swift helper only if `fm serve` disappears |
| Q3 | Default state | opt-in `appleFm.enabled = false` · auto-enable when preconditions pass | **Opt-in**: memory and battery cost are unmeasured (U9), the licence is the person's; `setup` shows a notice on an eligible Mac |
| Q4 | Which roles | `decision` and `summarize` guarded · `decision` only · also `chat` | **`decision` and `summarize` with the per-call guard**; refuse `chat`, `reasoning`, `dream`, `capture` |
| Q5 | A refused assignment | refuse · warn and allow | **Refuse** below the 16,384-token floor (it would fail on every turn); no warning-only mode |
| Q6 | `pcc` | never registered (hidden) · registered as cloud provider `apple-fm-pcc` | **Never in v1**: unavailable from daemon contexts, a second privacy surface; revisit only if a Terminal-context run is wanted |
| Q7 | Decision backend | explicit-only until the German gate, `auto` after gate and beating Laya · `auto` now · role path only | **Explicit-only, `auto` after the gate**; the `role` path works from day one |
| Q8 | Brier clause for a backend without probabilities | as written (one-hot, at most 2.5 points gap) · log-probabilities if exposed, else accuracy clause plus reported one-hot Brier and owner sign-off | **Measure with log-probabilities if the server exposes them; otherwise accuracy clause plus reported Brier and your sign-off**: your gate, your call |
| Q9 | Socket path longer than 103 bytes | unavailable with a doctor hint · per-user `/tmp` fallback as for `embedding.sock` | **Unavailable with a hint**: no `/tmp`, per your rule |
| Q10 | Start mode | always while enabled · on demand with idle stop | **Always** in v1 (no new RPC); revisit after AF0 measures the idle footprint |

No question blocks AF0 to AF3; AF4 waits for D119's node bridge, AF5 for Q7 and Q8.
