# Shared compute in the owner's cluster — design

**Status:** Owner decisions of 2026-10-31 (PR #825): Q1–Q10 decided as recommended (§16); phase 1, specification and
plan, no product code · **Date:** 2026-10-29 (amended 2026-10-31: decisions; language path B of D120) ·
**Owner:** Christian (Cyb3rb1ade) · **Track:** D (desktop) with core and engine parts ·
**Register entry:** **D119** (decided 2026-10-31; generalises D51 b; extends DS17, DS26, ADR-006, D116) · **Companion:**
[`2026-10-29-primary-client-role-switch-design.md`](2026-10-29-primary-client-role-switch-design.md) (D118, roles and
fencing) · **Plan:** [`2026-10-29-primary-client-role-switch.md`](../plans/2026-10-29-primary-client-role-switch.md)
(WP group SC)

**Owner requirement (2026-10-29, paraphrased from German).** All compute inside one owner's cluster — the primary
server plus attached clients and devices — can be shared. Example: everything runs locally with EmbeddingGemma 2; the
Linux VPS primary has only a CPU and could embed, but slowly. Embedding work waits until the MacBook (Apple Silicon) is
online in the cluster and is computed there; only when the MacBook has been out of contact for more than about an hour
does the VPS compute on its CPU. In general any compute (embeddings, re-embedding, captioning, reranker, ASR/TTS, local
LLM inference, media generation) can be placed on the best available node. **Second addendum (owner, on MLX):** build on
D51, DS26, D34, D112 and the logging spec's `mlx/<model>` ids; MLX is fine for output-only work, while index-bound
embeddings stay on the same in-core ONNX model everywhere unless a measured tolerance gate admits an accelerated backend.

**Inputs read** (`origin/main` @ `699439979c`): core register rows **D51** (VPS → MacBook local models; the
`plur1bus node` bridge, provider `node:<device>/<model>`, live health, fallback policy, never silently to cloud),
**D35** (device pairing, per-device tokens and scopes), **D34** (Kev on MLX as optional decision backend), **D28**
(one engine owner per store), **D112** (discovery scanners for mlx-lm and oMLX at `/v1/models`) in
[`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md); desktop spec rows
**DS17** (host bridge over the D51 b protocol, named capabilities) and **DS26** (large models native on macOS, ONNX
embedding/reranker/decision models CPU-sized in-core everywhere) in
[`2026-09-27-desktop-app-design.md`](2026-09-27-desktop-app-design.md); [ADR-006](../../adr/ADR-006-embedding-and-reranking.md)
(embedding identity rules 1–8, the EmbeddingGemma 2 pins: q8, 768, revision `daa72c51…`, 740M = 270M text + 170M
vision + 300M audio); [ADR-012](../../adr/ADR-012-process-model-and-languages.md) (supervised modules); the Rust engine
contract (`crates/plur1bus-engine/src/contract/embedding.rs` `EmbeddingService`, schema `VectorSpaceIdentity` with
provider, model, revision, dimension, normalization, prefixScheme, instruction, dtype, artifacts, tokenCap, pooling;
`EmbeddingIdentity.fingerprintId`); [`docs/media-search.md`](../../media-search.md) (separate media index,
`google/embeddinggemma-2`, backfill job, fingerprint in `state/media-search.json`);
[`docs/embedding-migration.md`](../../embedding-migration.md); `packages/core/src/privacy/local-only.ts`;
D116 ([`2026-10-20-memory-tree-relationships-design.md`](2026-10-20-memory-tree-relationships-design.md) §9);
D114 §7.3 leases; the logging spec's model id table
([`2026-10-01-logging-and-diagnostics-design.md`](2026-10-01-logging-and-diagnostics-design.md));
[`docs/desktop.md`](../../desktop.md) (host bridge: bundled-only, frames ≤ 64 KiB). The media-embeddings plan that the
owner cites (full 740M variant as default for the media index) is a project document outside this repository.
**Amended 2026-10-31:** the D120 design (open PR #833, branch `docs/harness-hygiene-coding-aci`, §3 decision 3, §12,
proposed ADR-019) sets **language path B**: every new component is Rust from its first version, runs as a supervised
process (first in the one module process `plur1bus-tools`) and is called by the TypeScript core over the harness RPC;
existing TypeScript code that is not a new component stays TypeScript until its Phase 4 step; the web SPA stays
TypeScript. SC12 applies it here.

## 1. Goal and non-goals

**Goal.** The primary keeps every decision and every write. Nodes of the same owner offer **compute**; the primary
places each job on the best available node by a per-class policy, and computes itself when no suitable node has been
in contact for too long. Index-bound results (vectors) stay consistent across nodes by fingerprint.

**Non-goals.**

- **No second worker protocol.** A compute node is the D51 b node: same pairing (D35), same scopes model, same
  authenticated WebSocket channel as DS17's host bridge. This spec adds a capability and methods to it.
- No compute across owners (D114 peers) in v1 (§11, Q7).
- No writes on nodes: no memory writes, channels, schedules or decisions (D28 one engine owner per store holds).
- No inbound port on any node; nodes dial out.
- No container for a Mac runtime (DS26); no MLX inside the harness core.
- No change to `llm.chat` routing beyond what D51 already specifies (`node:<device>/<model>` providers).

## 2. Decisions at a glance

| # | Topic | Decision (owner questions decided 2026-10-31) | Main alternative, why not |
|---|---|---|---|
| SC1 | Channel | **D51 b node bridge** over the M3 WebSocket as a paired device; new device scope `compute.serve`; carriers: the desktop app's Rust bridge (also through D113's SSH tunnel) and `plur1bus node` (CLI) (§4.3) | A separate worker daemon/protocol: duplicates pairing, revocation, transport and health. |
| SC2 | Control vs compute | Only `primary`/`standalone` run the queue and commit results; nodes compute and return (§4.1) | Nodes writing vectors into a replicated store: two engine owners per store (D28). |
| SC3 | Placement | Per **job class**: latency class, consistency class, preferred node class, **maximum deferral measured as node absence** (default 1 h), job age cap (24 h) (§5) | Global "offload on/off": cannot express "query embeddings now, ingestion later". |
| SC4 | Pending items | Deferred items carry `embedding: pending`; recall finds them by FTS only; backlog in `compute.status`, `1staid`, tray (§5.4) | Blocking capture until embedded: captures fail while the Mac sleeps. |
| SC5 | Runtimes | **Output-only** classes (chat, ASR/TTS, generation, captioning, Kev decisions) may use MLX/Metal on the Mac through the node at once; **index-bound** classes (embeddings, reranker) use the **same in-core ONNX model on every node** in v1 (§6) | MLX everywhere: vectors from different runtimes drift; an EmbeddingGemma 2 MLX port is unverified. |
| SC6 | Fingerprint | Index fingerprint pins model, revision, encoders (variant), dtype, dimension, prefix scheme, normalisation, pooling, token cap, **runtime family and precision**; producers state theirs; mismatch rejected (§7) | Model name only: CPU vs CoreML fp16 vectors would mix silently. |
| SC7 | Accelerated backends | Allowed into an existing index only with an **equivalence certificate** from a measured tolerance gate (calibration set, cosine thresholds, recall@k parity) per model, variant and backend; otherwise their own fingerprint (separate index) or no participation (§7.4) | Trust the vendor's "near-lossless" claim: ADR-006 rule 6 already demands a probe. |
| SC8 | Protocol | **Pull**: `compute.lease` long-poll over the node's outbound connection; leases 120 s / heartbeat 30 s (D114 numbers); idempotent results keyed by job, item, content hash and fingerprint; at-least-once with dedup (§8) | Push from the primary: no back-pressure, needs the primary to know node capacity. |
| SC9 | Node conditions | AC power only by default; thermal back-off; idle and in-call detection where available; quiet hours; concurrency cap 1; *Pause sharing* in the tray (§9) | Always on: drains a laptop and heats it during calls. |
| SC10 | Privacy | `privacy.localOnly` = **inside the owner's cluster** (same rule as D118 Q7); D116: other persons' `privat` and (by default) `vertraulich` items never leave the primary (§10, Q5) | Ship everything: the owner's laptop would see other household members' private memories. |
| SC11 | Identity and licences | Node = paired device enrolled by the **Owner** (humanOnly, T3); NC model licences confirmed **per device** (§10.3) | Implicit enrolment of every paired device: a phone paired for the UI would receive jobs. |
| SC12 | Language (D120 path B, carried over 2026-10-31) | The queue, placement, privacy filter, fingerprint verification, certificates and the worker methods are a **new component in Rust** (`crates/plur1bus-compute`), hosted in D120's supervised `plur1bus-tools` module process and called by the TypeScript core over the harness RPC (`x-server: "tools"`); the core keeps only wiring in existing modules (enqueue hooks, `local-only.ts`, the device grant, API routing); the web SPA stays TypeScript | A TypeScript `packages/core/src/compute/`: a new component in the core that Phase 4 would have to port again (ADR-019 proposal in D120). |

## 3. What exists

| Piece | Status | Use here |
|---|---|---|
| D51 b `plur1bus node`: outbound, paired, announces models, provider `node:<device>/<model>`, live health, fallback (another role / queue / refuse for local-only), never silent cloud fallback, inference as harness RPC over the D35 channel with an OpenAI-compatible request shape | specified, not built | the node, generalised to non-chat classes |
| DS17 host bridge: the app dials the harness with its device token over the same protocol; capabilities `host.localModel`, `host.notify`, `host.filePick`, `host.computerUse`, `host.keyUnlock`; per-capability grant; built for the bundled connection only, frames ≤ 64 KiB | partly built (bundled) | the desktop carrier |
| DS26: on macOS large models run natively (Ollama, LM Studio, MLX); ONNX embedding/reranker/decision models stay CPU-sized in-core (onnxruntime-node, transformers.js) everywhere | decided | runtime rule (§6) |
| D34: Kev on MLX as optional decision backend, supervised Python module | decided, spike-gated | output-only class `decision` |
| D112: discovery for LM Studio, mlx-lm, oMLX at `/v1/models` | decided | node model advertisement |
| ADR-006: identity, never mix spaces, compatibility probe with reference vectors (rule 6), outage → journal and embed later, recall degrades to FTS (rule 8), embed 15 s / rerank 5 s | decided | §5.4, §7 |
| Engine contract: `EmbeddingService::{embed, rerank, probe, identities, serve}`, `VectorSpaceIdentity`, `fingerprintId` | Rust engine contract on `main` | fingerprint fields (§7.1); compute-only use (U3) |
| Media index: separate space, `google/embeddinggemma-2`, backfill job with pause/resume and fingerprint tracking | harness side built, engine 1.19 gated | class `embed.media` |
| `privacy.localOnly`, `localEndpoints` | built | §10.1 |

## 4. Roles, nodes and the channel

### 4.1 Control roles and compute roles

| Node role (D118) | Runs the queue | Computes | Commits results |
|---|---|---|---|
| `standalone`, `primary` | yes | yes (local fallback and interactive) | yes |
| `client` | no | yes, when enrolled as a compute node | **no** |
| `handing-over`, `pending`, `fenced` | no (queue paused, leases not renewed) | no | no |

A node never writes memory, runs channels or schedules anything (D118 §4.4 holds on every client). Its results are
inputs to the primary's engine, which verifies and writes them (§7.3).

### 4.2 Capability advertisement

Sent in `compute.hello` and refreshed on change (at most every 30 s), schema `plur1bus.compute-node/1`:

```text
{ nodeId, nodeKeyFingerprint, clusterId, epochSeen,
  accelerators: [ { kind: cpu | metal | ane | cuda | rocm, name, memoryBytes? } ],
  runtimes: [ { family: onnx-cpu | onnx-coreml | onnx-cuda | mlx | llamacpp | ollama | lmstudio, version, precisions[] } ],
  models: [ { id, revision, encoders?, dtype, artifactsSha256[], licenceConfirmed, classes[], producerFingerprints[] } ],
  ramBytes: { total, free }, power: { source: ac | battery | unknown, batteryPercent?, lowPowerMode? },
  thermal: nominal | fair | serious | critical | unknown, userIdleSec?, inCall?: boolean,
  limits: { classes[], maxConcurrent, quietHours?, onBattery, paused, pausedUntilMs? } }
```

The primary treats every field as a claim (§13). Local model servers are found by the node's own D112 scanners
(LM Studio, mlx-lm, oMLX, Ollama) and announced as D51 b providers; in-core ONNX models are announced from the node's
engine identities (`EmbeddingService::identities`).

### 4.3 The channel

- **Pairing and identity:** a node is a D35 paired device of kind `desktop` (the app) or `node` (headless,
  `plur1bus node`), with the D118 node key fingerprint bound at enrolment. Its device grant names `compute.serve` and
  the allowed classes; the Owner adds the grant (§10.3).
- **Desktop carrier:** the app's Rust bridge (DS17, `bridge.rs`) dials the primary over the connection it already has —
  D113's in-process SSH tunnel (`direct-tcpip` to the server's loopback API) or a `tailnet`/`network` connection — and
  relays compute requests to the bundled harness's core over its local socket. This extends DS17 from "bundled only" to
  "the owner's own primary"; the bridge stays requests-only, no ambient power.
- **CLI carrier:** `plur1bus node run` (D51 b, same binary, bridge mode) for headless nodes (a Linux box with a GPU). It
  reaches primaries published on `tailnet` or `network`; an SSH-only primary needs the person's own `ssh -L` forward
  (documented, not managed; Q9).
- **Epoch:** every message carries the D118 epoch; a node that sees a higher epoch reconnects to the new primary, a
  primary that is fenced stops leasing (D118 §4.6).

## 5. Job classes and placement

### 5.1 Classes

| Class | Typical producer | Latency | Consistency | Preferred node | Max deferral | When it cannot defer |
|---|---|---|---|---|---|---|
| `embed.query` | recall during a turn | interactive (≤ 15 s, ADR-006) | index-bound | primary | 0 | primary |
| `rerank` | recall | interactive (≤ 5 s) | index-bound (thresholds per reranker) | primary | 0 | primary; vector ranking on timeout (ADR-006) |
| `embed.passage` | capture, import, journal replay | batch | index-bound | `accelerated` | node absence 1 h | primary CPU |
| `embed.media` | media backfill and new media (EmbeddingGemma 2 with vision/audio encoders, 740M) | batch | index-bound (media index) | `accelerated` | node absence 1 h | primary CPU |
| `embed.reembed` | `memory reembed` / media reindex migration | batch | index-bound (new generation) | `accelerated` | **wait** (Q8) | — (old generation keeps serving recall) |
| `caption` | media caption pipeline | batch | output-only | `accelerated` | node absence 1 h | primary, or caption source fallback |
| `asr` | voice turn / file transcription | interactive / batch | output-only | node with the model if online, else primary | 0 / 1 h | primary |
| `tts` | voice reply | interactive | output-only | primary or a low-RTT node | 0 | primary |
| `decision` | D34 backends (`noul`, `choice`, `score`) | interactive | output-only, backend-calibrated | as `decision.backend` says (Laya in-core; Kev on an MLX node) | 0 | Laya on the primary |
| `media.generate` | ADR-017 local generation | batch | output-only | `accelerated` with the model | per job (default 1 h) | primary if it has the model, else wait or refuse |
| `llm.chat` | turns | interactive | output-only | **not queued**: D51 b provider routing (`node:<device>/<model>`) with D51's fallback policy | — | D51 |

`accelerated` = a node advertising `metal`, `ane`, `cuda` or `rocm` with the job's model; the Owner may name nodes
explicitly per class (`compute.classes.<class>.preferNodes`).

### 5.2 Placement

1. **Eligible nodes** for a job: enrolled, attachment lease live (D118 §4.8), conditions allow the class (§9), the class
   is in the node's grant and limits, the model is present and licence-confirmed (§10.4), the producer fingerprint is
   acceptable for an index-bound job (§7), and the privacy filter passes (§10.2).
2. **Interactive** jobs run on the primary when it has the model. Output-only interactive jobs (`asr`, `tts`,
   `decision` on Kev) may go to an eligible node whose measured round trip is ≤ `compute.interactiveMaxRttMs`
   (default 30 ms); index-bound interactive jobs stay on the primary in v1 (Q4), because the primary holds the
   reference model and a query vector must match the index exactly.
3. **Batch** jobs go to an eligible node of the preferred class when one is online. Otherwise the job **defers** while
   any node of the preferred class has been in contact within `maxDeferMs` (default **1 h**, the owner's number). It
   falls back to the primary when (a) no such node has been in contact for `maxDeferMs`, (b) the job is older than
   `maxAgeMs` (default **24 h**, Q2), or (c) the class says `fallback: primary-now`.
4. **Primary fallback** runs at low priority within `compute.primaryCpuShare` (default 50 % of the core limit of
   [`2026-10-24-cpu-core-limit-design.md`](2026-10-24-cpu-core-limit-design.md)) so turns stay responsive.
5. **A node returns** while the primary works through a backlog: the primary takes no new local batches of that class
   and leases the rest to the node; batches already running locally finish.

### 5.3 Queue

On the primary in the Rust compute component (SC12), durable in `state/compute.sqlite` (private, single writer: the
`plur1bus-tools` process; added to the backup allow-list by RS3 so a promote moves it, D118 §5.3). The TypeScript core
enqueues through `x-server: "tools"` RPC methods from its existing capture, import, media and migration paths and
receives verified results back for the engine. One row per job: id, class, fingerprint, items (ids and content hashes, never
content), state, attempts, lease holder and expiry, created and last-contact times. States:
`queued → leased → done`, `leased → queued` (lease expired, released, node fenced), `queued|leased → cancelled`,
`queued → deferred → queued` (node returns or deferral ends), `leased → failed` after `compute.maxAttempts` (3) with
the last reason. The queue is paused outside writer roles.

### 5.4 Pending state, recall and backlog

- An item whose embedding is deferred is stored with its text, FTS-indexed and marked `embedding: pending` (ADR-006
  rule 8: capture journals and embeds later; recall degrades to lexical). Recall finds it through FTS/BM25 only; the
  recall explain view and `memory show` say *embedding pending (waiting for <node class>)*. This needs an engine-side
  pending marker that accepts an externally computed vector later (U3).
- **Backlog surfaces:** `compute.status` (per class: count, oldest age, next eligible node, "runs on the primary from
  <time> if no node returns"), `1staid` row `compute.backlog`, the tray on the preferred node ("3 412 Einbettungen warten
  auf diesen Mac" / "3,412 embeddings waiting for this Mac"), and the primary's Settings → Compute page.

## 6. Runtimes

### 6.1 Output-only classes: MLX and Metal are fine now

Chat, ASR/TTS, generation, captioning and Kev decisions produce text or media, not vectors in a shared index. On a Mac
they may run on MLX/Metal immediately through the D51 b node: behind an existing local server (LM Studio's MLX engine,
mlx-lm, oMLX — found by D112's scanners) or as a **supervised module** under ADR-012 (Kev is already planned that way,
D34). **Never in a container** (DS26). Model ids follow the logging spec: `mlx/<model>`, `ollama/<model>`,
`llamacpp/<model>`, `transformers/<model>` (in-core ONNX).

### 6.2 Index-bound classes: the same in-core ONNX model everywhere

Embeddings and reranking feed a shared index or calibrated thresholds. The v1 default on **every** node is the same
in-core ONNX model the primary uses (onnxruntime-node / transformers.js, DS26), with the pinned artefacts (ADR-006
SHA-256 pins) and the pinned dtype (`q8` for EmbeddingGemma 2). On a Mac that means ONNX on the CPU; the **CoreML
execution provider** is optional and only after the gate. An accelerated backend — CoreML EP in fp16, or an MLX port
such as mlx-embeddings — may write into the same index only after a measured tolerance gate (§7.4). Otherwise it gets
its own fingerprint (a separate index the Owner creates deliberately) or does not take index-bound jobs. Whether an MLX
port of EmbeddingGemma 2 exists at all is **unverified**; community MLX ports exist for the first-generation
EmbeddingGemma (300M) (U1).

### 6.3 Spike

Before SC6/SC7 are built: measure ONNX CPU vs CoreML EP vs MLX on Apple Silicon against ONNX CPU on the VPS, for the
text model (270M, q8) and the full media model (740M), on a fixed corpus: items per second, RAM, cosine to the
reference (min, mean, p01), recall@10 parity on a benchmark query set, and cross-architecture CPU drift (arm64 vs
x64). Output: the certificate thresholds and a go/no-go for CoreML EP and MLX in v1 (plan SC-S).

## 7. Vector consistency

### 7.1 Fingerprint

The **index fingerprint** F is the engine's `VectorSpaceIdentity` (provider, model, revision, dimension, normalization,
prefixScheme, instruction, dtype, artifacts, tokenCap, pooling) extended by three fields, hashed into the engine's
`fingerprintId` (`embedding:v1:sha256:<hex>`, ADR-006 "Embedding-owner IPC"):

| New field | Values | Why |
|---|---|---|
| `encoders` | `text` (270M) or `text+vision+audio` (740M) for EmbeddingGemma 2 | the media index uses the full checkpoint; the text index the text-only load (ADR-006 "Selective Encoder Loading") |
| `runtimeFamily` | `onnx-cpu`, `onnx-coreml`, `onnx-cuda`, `mlx`, … | different kernels, different numerics |
| `precision` | the effective compute precision: `q8`, `fp16`, `bf16`, `fp32` | CoreML may compute a `q8` graph in fp16 |

**Compatibility with existing stores:** an identity without the new fields reads as `runtimeFamily: onnx-cpu`,
`precision: <dtype>`, `encoders: text` — exactly what every existing store was built with — so no store changes its
fingerprint and nothing re-embeds. The engine contract gains the fields additively (engine-side work, plan SC2).

### 7.2 Producer check on the node

Before it computes, a node derives its **producer fingerprint** P from what it actually loaded: artefact SHA-256s
against the pins, revision, encoders, dtype, the execution provider in use and its precision. It accepts an
index-bound job only if `P == F` or it holds a valid equivalence certificate for (F, P) (§7.4); otherwise it releases
the job with `compute-fingerprint-mismatch`, and the primary stops offering F to it until its advertisement changes.

### 7.3 Results and verification on the primary

Each result carries `{ jobId, itemId, contentHash, F, P, certificateId?, vector }`. The primary commits it only if:
`F` is the job's fingerprint; `P == F` or the certificate is valid and unexpired; the dimension matches; the vector is
finite and L2-normalised within 1 ± 1e-3; `contentHash` equals the item's current content hash (else `stale`). It
also **spot-checks**: for one random item in every `compute.verifySampleEvery` (default 50) batches it embeds the item
itself and requires cosine ≥ the certificate's (or the default) threshold; a failure rejects the batch, audits
`compute.result.rejected reason=spot-check`, and suspends the node's index-bound eligibility until the Owner reviews it.
Any mismatch is rejected; nothing is "close enough" without a certificate.

### 7.4 Equivalence certificates (the tolerance gate)

`plur1bus compute certify --node <id> --fingerprint <F> [--backend <family>/<precision>]` runs on the primary:

1. The node embeds the **calibration set** with P: the release's fixed probe set (texts; for media also images and
   audio clips) plus a sample of the store's own items with the reference vectors ADR-006 rule 6 keeps per generation.
2. The primary compares against F: **min cosine ≥ τ_min** and **mean ≥ τ_mean** (defaults 0.999 / 0.9995 until the
   spike sets them, §6.3), and **recall@10 parity** on the store's benchmark queries (ADR-006 "Benchmark"): the
   difference must stay within `Δmax` (default 0.5 points).
3. Pass → a certificate `{ id, F, P, node, runtime versions, thresholds, measurements, issuedAt }` stored on the
   primary and audited. It expires when any part of F or P changes (runtime update, model update, driver change the
   node reports) and is re-run on demand.
4. Fail → P may only serve a **separate index** with its own fingerprint (the Owner creates it deliberately), or no
   index-bound jobs.

**Drift rule (decided 2026-10-31, Q3):** identical runtime family and precision is the default; any accelerated backend
needs a certificate. Two `onnx-cpu`/`q8` producers on different CPU architectures count as identical (the identity has
no CPU field today); the spike measures arm64 vs x64 drift, and if it exceeds τ_min the CPU architecture joins the
fingerprint (U2).

## 8. Job protocol

### 8.1 Methods (node → primary over the bridge, scope `compute.serve`)

The Harness API authenticates the device and routes these methods to the Rust compute component in `plur1bus-tools`
(`x-server: "tools"`, SC12); the TypeScript API only adds the routes to its existing allow-list.

| Method | Purpose |
|---|---|
| `compute.hello` | capability advertisement (§4.2); answer: cluster, epoch, the fingerprints and classes the primary wants from this node, policy limits; refused for a foreign cluster or a lower epoch |
| `compute.lease { classes[], capacity: { jobs, items }, waitMs ≤ 25000 }` | long-poll for work; answer: up to `capacity` jobs with items (text inline, media as blob refs), each with `leaseExpiresAtMs` |
| `compute.heartbeat { jobIds[], progress? }` | every 30 s; extends each lease to now + 120 s; answer lists `cancelled` job or item ids |
| `compute.complete { jobId, part, parts, results[] }` | results in chunks; answer: `accepted[]`, `duplicate[]`, `rejected[{ itemId, reason }]` |
| `compute.fail { jobId, reason, retryable }` / `compute.release { jobId }` | give work back (error, pause, condition change) |
| `GET /api/v1/compute/blobs/<jobId>/<sha256>` | media payload with range support, device bearer, bound to a live lease |

Interactive output-only work on a node (`asr`, `tts`, Kev `decision`) uses the D51 b request relay (primary → node
request over the same socket), not the lease queue, with the class deadline and an immediate primary fallback.

### 8.2 Leases

TTL 120 s, heartbeat 30 s (`compute.leaseTtlMs`, `compute.heartbeatMs`; D114 Q9 numbers). An expired lease returns
the job to `queued` (attempt + 1). A node that misses its attachment lease (D118 §4.8) loses all its job leases at once.

### 8.3 Idempotency and delivery

- Result key: `(jobId, itemId, contentHash, F)`. The primary commits each key at most once; a second valid result is
  `duplicate` and discarded. Delivery is **at least once**: a job can be computed twice after a lease expiry; only one
  result is committed.
- Content changed or item deleted since the lease → `stale` / `cancelled`; a late result never resurrects a deleted
  item (the media-search rule "a deleted medium does not come back").
- Partial batches: a node may complete a subset and release the rest; released items return to `queued`.

### 8.4 Limits and back-pressure

| Limit | Default |
|---|---|
| Items per job | 256 (embeddings), 1 (media segment, generation) |
| Message size | 8 MiB per `compute.complete` part; the bridge's 64 KiB frame bound gets a chunked binary frame type for compute (U5) |
| Text per item | the model's token cap as the engine truncates (512 for EmbeddingGemma 2 by default); the content hash covers the truncated input |
| Media blob | 64 MiB per segment (video split by `memory.mediaEmbedding.video.segmentSec`) |
| Outstanding leases per node | `compute.maxLeasesPerNode` = 2 |
| Queue size | `compute.maxQueuedItems` = 1 000 000; beyond it producers fall back to the primary at once |

The node declares capacity per lease; the primary never pushes queued work. Thermal or power changes shrink the next
lease (§9).

### 8.5 Cancellation

The primary cancels a job (item forgotten, store migration aborted, fingerprint switched, class paused, primary leaving
its writer role) by marking it; the next heartbeat tells the node; the node stops at the next batch boundary and
releases. A node that disappears simply lets its leases expire.

## 9. Node conditions

| Condition | Default | Effect |
|---|---|---|
| Power | AC only (`compute.node.onBattery = false`); if enabled: battery ≥ 50 %, never in Low Power Mode | pause on battery |
| Thermal | `fair` → half capacity; `serious`/`critical` → pause | resume at `nominal`/`fair` after 5 min |
| User idle | heavy classes (`embed.media`, `embed.reembed`, `media.generate`) only after 2 min idle; light classes always | where the OS reports idle time (U6) |
| In a call | microphone or camera in use → pause all classes | where detectable (U6) |
| Quiet hours | none | optional window per node |
| Concurrency | 1 job at a time | per node |
| *Pause sharing* | tray and `plur1bus compute pause [--for 1h|--until tomorrow]` | releases leases; the primary defers to the deferral rule |

Conditions are decided **on the node** (its own facts, its own limits) and reported in its advertisement; the primary
respects them and never overrides a pause.

## 10. Privacy and RBAC

### 10.1 `privacy.localOnly`

**Local means inside the owner's cluster** (decided 2026-10-31, D118 Q7): the primary's loopback, origins in
`privacy.localEndpoints`, and enrolled nodes of this cluster reached over the node bridge through the authenticated
tunnel (SSH `direct-tcpip` or `tailnet`/`network` TLS). Never a third party or a cloud API. `local-only.ts` gains the
node rule; a job for a local-only agent or shared store goes only to such nodes, else waits or refuses (D51's rule:
never silently to cloud).

### 10.2 D116 confidentiality in multi-user households

Jobs carry each item's relationship owner and level (the engine has both, D116 T3/T8). Default filter before shipping
to a node (Q5):

| Item | To a node of the Owner |
|---|---|
| The Owner's own entries, any level | allowed |
| Another person's `teilbar` entries | allowed |
| Another person's `vertraulich` entries | **primary only** unless `compute.privacy.foreignConfidential = "nodes"` |
| Another person's `privat` entries | **never**; computed on the primary |

Reason: embedding is not a prompt, but the text transits the owner's personal device, which other household members
cannot vet, and D116 promises that foreign `privat` entries never reach another person. Withheld items are counted
(`compute.privacy.withheld`) and computed on the primary under the normal fallback.

### 10.3 Node identity and enrolment

- A node is a **paired device** (D35) with the D118 node key fingerprint bound. Enrolment adds `compute.serve` and the
  allowed classes to its grant: **Owner only**, `humanOnly`, surface T3 (desktop app, CLI with TTY, web with step-up).
  A device paired only for the UI (a phone) never receives jobs.
- The worker principal is the device (kind `device`, not person, not agent); it can call only the `compute.*` worker
  methods and the blob route. `device revoke` ends its leases at once.

### 10.4 Model licences per device

A model under a non-commercial licence (Jina v3/v5 and others, ADR-006) needs `licence.accept-nc` **on each node**,
confirmed by the Owner on that device (`plur1bus model licence confirm` there, or the app), audited with the device id;
the primary never assigns NC jobs to a node without it. EmbeddingGemma 2 (Apache-2.0) needs no confirmation.

## 11. Scope boundary

Compute sharing **across owners** (a household member's own instance, a D114 peer) is **out of scope for v1** (Q7).
It needs budgets, approvals and cost attribution between owners, which D114 §7.2/§8.3 define for agent work; a later
"compute as a service" offer can reuse those rules. Inside one owner's cluster nothing is billed and no approval is
asked per job.

## 12. Surfaces

### 12.1 CLI

| Command | Where | Notes |
|---|---|---|
| `plur1bus compute status [--json]` | any node | primary: queue per class, backlog, fallbacks; node: own state, leases, pause; schema `compute.status/1` |
| `plur1bus compute nodes [--json]` | primary | enrolled nodes, liveness, capabilities, certificates |
| `plur1bus compute jobs [--class C] [--state S] [--json]` | primary | ids, classes, states, ages; never content |
| `plur1bus compute node enroll <device> --classes …` / `remove <device>` / `limits <device> …` | primary | Owner, TTY or `--yes` |
| `plur1bus compute certify --node <id> --fingerprint <F> [--backend …]` | primary | §7.4 |
| `plur1bus compute pause [--for 1h|--until tomorrow]` / `resume` | node | local authority |
| `plur1bus node run [--primary <origin>]` / `node status` | headless node | the D51 b CLI carrier |

Job-class policy is configuration: `plur1bus config set compute.classes.embed.passage.maxDeferMs 3600000`.

### 12.2 RPC and RBAC

| Method | Action | Allowed |
|---|---|---|
| `compute.status`, `compute.nodes.list`, `compute.jobs.list` | `compute.read` | Owner, Admin, Operator (people) |
| `compute.node.enroll`, `compute.node.remove`, `compute.node.limits.set`, `compute.certify` | `compute.manage` | **Owner only**, `humanOnly`, T3 |
| `compute.pause`, `compute.resume` (node-local) | `compute.node.control` | the node's local Owner session (CLI/app on that node) |
| `compute.hello`, `compute.lease`, `compute.heartbeat`, `compute.complete`, `compute.fail`, `compute.release`, blob route | device scope `compute.serve` | enrolled node devices only; refused to persons, agents, WebMCP and the MCP server |

`compute.status` joins the web's read methods; management is web-visible only with step-up (T3) in v1. The whole
`compute.*` family is on WebMCP's forbidden list.

### 12.3 Configuration keys

| Key | Type | Default | `x-restart` | Meaning |
|---|---|---|---|---|
| `compute.enabled` | boolean | `false` | `core` | queue and node methods on |
| `compute.classes.<class>.preferred` | string | §5.1 | `live` | `primary`, `accelerated`, `any`, or node ids |
| `compute.classes.<class>.maxDeferMs` | integer | `3600000` (batch), `0` (interactive) | `live` | node-absence deferral |
| `compute.classes.<class>.maxAgeMs` | integer | `86400000` | `live` | job age cap |
| `compute.classes.embed.reembed.fallback` | string | `wait` | `live` | `wait` or `primary` (Q8) |
| `compute.interactiveMaxRttMs` | integer | `30` | `live` | §5.2 |
| `compute.primaryCpuShare` | number | `0.5` | `live` | §5.2 step 4 |
| `compute.leaseTtlMs` / `compute.heartbeatMs` | integer | `120000` / `30000` | `live` | §8.2 |
| `compute.verifySampleEvery` | integer | `50` | `live` | §7.3 |
| `compute.privacy.foreignConfidential` | string | `primary` | `live` | `primary` or `nodes` (§10.2) |
| `compute.node.onBattery` / `compute.node.minBatteryPercent` | boolean / integer | `false` / `50` | `live` | node-local (§9) |

Enrolments, certificates and the queue are **state**, not configuration.

### 12.4 `1staid check` rows

`compute.backlog` (warn when the oldest pending item is older than its class's `maxDeferMs` + 1 h; info otherwise),
`compute.nodes` (enrolled, live, paused, suspended), `compute.fingerprint` (fail when an index has items committed under
an unexpected producer), `compute.equivalence` (certificates expired or failed), `compute.privacy` (withheld counts,
local-only conflicts), `compute.primary-fallback` (info while the primary computes deferred work).

### 12.5 Tray and desktop

On a node: header suffix „· Rechenhilfe: 2 Jobs“ / "· Sharing compute: 2 jobs", „· Rechenhilfe pausiert“ /
"· Sharing paused"; menu items *Pause sharing* (1 h, until tomorrow, until resumed) and *Resume sharing*. No new badge.
On the primary's connection: the backlog line from §5.4. Settings → Compute: enrolled nodes, per-class policy,
certificates.

### 12.6 Audit

`compute.node.enrolled|removed|limits.changed|suspended`, `compute.paused|resumed` (node), `compute.certificate.issued|
failed|expired`, `compute.result.rejected` (reason, counts), `compute.fallback.primary` (class, backlog size),
`compute.privacy.withheld` (counts per level). Never item content, vectors or media.

## 13. Threat model

| Threat | Protection | Residual risk |
|---|---|---|
| A node returns wrong vectors (bug, tampering) | fingerprint and certificate checks, norm and dimension checks, primary spot checks, suspension, audit | wrong vectors between two spot checks on a compromised Owner device |
| A node lies about its capabilities or conditions | conditions only make it *do less*; fingerprints are checked on results, not trusted from the advertisement | a node that claims a model it lacks fails its jobs and loses eligibility |
| Content leaves the owner's control | enrolled Owner devices only, authenticated tunnel, D116 filter, no third party | content in memory on the Owner's laptop |
| An agent or WebMCP enrols a node | `humanOnly`, Owner, T3, forbidden for agents/WebMCP/MCP | — |
| Replay or duplicate results | idempotent result key, content hash, lease binding | — |
| A fenced primary keeps leasing | epoch on every message; nodes follow the higher epoch | jobs of the fenced primary computed in vain |
| Resource abuse on the laptop | AC-only default, thermal back-off, pause, concurrency cap, idle and in-call rules | unknown OS signals on some platforms (U6) |

## 14. Failure classification

| Reason | Class | Behaviour |
|---|---|---|
| `compute-fingerprint-mismatch` | node refuses | job released; node not offered F until its advertisement changes |
| `compute-certificate-expired` | node or primary refuses | job released; `1staid` warns; re-certify |
| `compute-result-invalid` (dimension, norm, NaN) | primary rejects | item back to `queued`; node attempt counted |
| `compute-spot-check-failed` | primary rejects the batch | node suspended for index-bound work; Owner review |
| `compute-stale` / `compute-cancelled` | primary discards | nothing committed |
| `compute-lease-expired` | queue | job requeued, attempt + 1, `failed` after 3 |
| `compute-node-paused` / `compute-conditions` | node releases | deferral rule applies |
| `compute-privacy-withheld` | primary | computed on the primary |
| `compute-no-node` (deferral over) | primary | primary fallback, audited once per episode |

## 15. Test strategy

- **Unit (no network):** queue state machine and placement table with an injected clock (deferral by node absence,
  age cap, `wait` for re-embedding, return of a node mid-backlog); producer/index fingerprint comparison and
  certificate validity/expiry; result verification (dimension, norm, NaN, stale, duplicate); D116 filter table;
  node-conditions table; capability advertisement schema (closed, size-capped).
- **Two-instance harness** (loopback): a primary and a fake node over the real bridge WebSocket; lease expiry and
  redelivery with one commit; cancellation mid-batch; partial completion; a node that returns perturbed vectors is
  caught by the spot check and suspended; a fenced primary stops leasing and the node follows the higher epoch.
- **Engine integration:** pending marker, FTS-only recall of pending items, external vector commit under F (after the
  engine contract extension).
- **Privacy:** a household fixture (Owner, Eva) with all levels; foreign `privat` never appears in any node payload,
  log or audit line.
- **Spike (SC-S):** the measurements of §6.3 on the owner's MacBook and the VPS/Ubuntu VM; results in a status doc.
- **Real run (owner worksheet):** VPS primary with a backlog, MacBook offline > 1 h → primary fallback; MacBook back →
  backlog moves to the Mac.

## 16. Owner decisions (decided 2026-10-31)

The owner decided every question as recommended on 2026-10-31 (PR #825). The answers are binding for the plan.

| # | Question | Decision |
|---|---|---|
| Q1 | Register as D119, separate from D118? | **Decided 2026-10-31:** Yes (see D118 Q1). |
| Q2 | Besides the 1 h node-absence rule, a job age cap after which the primary computes even if the node keeps flapping? | **Decided 2026-10-31:** **Yes, 24 h.** |
| Q3 | Precision rule: identical precision required, or a measured tolerance gate? | **Decided 2026-10-31:** **Identical runtime family and precision by default; accelerated backends only with an equivalence certificate** (calibration set, cosine thresholds, recall@10 parity) per model, variant and backend. |
| Q4 | Index-bound interactive jobs (query embeddings) on a low-RTT node? | **Decided 2026-10-31:** **Primary only in v1**; output-only interactive work may use a node. |
| Q5 | D116: may other persons' memories be embedded on the owner's MacBook? | **Decided 2026-10-31:** Own entries and foreign `teilbar`: yes. Foreign `vertraulich`: **primary only by default** (switchable). Foreign `privat`: **never**. |
| Q6 | Compute on battery? | **Decided 2026-10-31:** **AC only by default**; opt-in with a 50 % floor. |
| Q7 | Compute across owners (D114)? | **Decided 2026-10-31:** **Out of scope for v1**; later through D114's budget and approval rules. |
| Q8 | Re-embedding migrations without a node: fall back to the primary after 1 h, or wait? | **Decided 2026-10-31:** **Wait** by default: the old generation keeps serving recall during a migration (ADR-006 rule 2), so nothing degrades; a VPS CPU re-embed of a large store can take days. |
| Q9 | CLI-only nodes and SSH-only primaries? | **Decided 2026-10-31:** v1: the desktop carrier works through the SSH tunnel; `plur1bus node run` needs `tailnet` or `network`, or the person's own `ssh -L`. |
| Q10 | Spot-check rate on the primary? | **Decided 2026-10-31:** **1 in 50 batches**; raise for a suspended node's re-admission. |

## 17. Unknowns (not verified in the repository)

| # | Unknown | Why it matters | How to settle |
|---|---|---|---|
| U1 | Whether any MLX port of EmbeddingGemma 2 exists (community MLX ports exist for the first-generation EmbeddingGemma 300M, per the owner's note; not verified here) | MLX for index-bound jobs | spike SC-S |
| U2 | Numeric drift: ONNX CPU arm64 vs x64, CoreML EP fp16 vs CPU q8, MLX bf16/fp16 vs CPU | certificate thresholds; whether CPU arch joins the fingerprint | spike SC-S |
| U3 | Whether the engine (Node package or Rust rewrite) has a per-item "embedding pending" state, accepts an externally computed vector under a fingerprint, and can run `embed()` without opening stores (compute-only) | the whole deferral path; client nodes that never touch frozen stores | engine contract review; extension in the engine repo (plan SC2) |
| U4 | Whether the onnxruntime-node prebuild in the core ships the CoreML EP on darwin-arm64 | optional CoreML path | check the pinned prebuild in SC-S |
| U5 | The bridge's 64 KiB frame bound and a chunked binary frame type for compute payloads | batch sizes | DS17 bridge code review in SC3 |
| U6 | Which power, thermal, idle and in-call signals the desktop app can read on macOS, Windows and Linux without new plugins or entitlements | node conditions | per-OS probe in SC5 |
| U7 | RAM and throughput of the 740M media model on the VPS CPU and on Apple Silicon | deferral defaults, queue sizes | spike SC-S |
| U8 | The media-embeddings plan's exact default (full 740M for the media index) lives outside this repository | class `embed.media` fingerprint (`encoders`) | read the project document when SC2 starts |
| U9 | How D51 b's request relay and DS17's bridge share one socket per device today (DS17 is built for the bundled connection only) | one channel for chat, host capabilities and compute | SC3 design check against `bridge.rs` |
