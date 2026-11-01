# D122 AF1 / PS10 validation — 2026-11-01

Controller ruling: `controller-rulings-2026-11-01-pm.md` §D. Independent branch
`codex/ps10-af1-apple-fm`, created directly from `main` at
`df5254598fc484870194efb2caa3cedf8f187e09`; AF0 remains in separately reviewed PR #865.

## Delivered contract

- Managed Unix HTTP transport on one layout-resolved `apple-fm` descriptor, an injected filesystem guard,
  two-second positive verification cache, fixed origin/endpoints/headers, bounded request/response bodies,
  no redirects, no DNS/TCP/proxy fallback, and owned abort/cancellation cleanup.
- Keyless local chat adapter accepting only exact model id `system` before guard or I/O. Image parts and
  reasoning directives are refused. Tools, forced choice, parallel-tool flag and JSON Schema preserve the
  existing chat wire encoding. Inference capacity is one per adapter; busy calls receive a non-retryable
  availability refusal without a hidden queue. Probes remain independent.
- `complete()` consumes SSE by response Content-Type through the same parser as `stream()`, preserving
  limits, usage, tool repair, partial results and truncation errors. A transport abort caused by an adapter
  deadline retains the correct timeout classification.
- Unix mode uses `max_completion_tokens` from AF0's observation. The native transcript/context-size error
  maps to non-retryable `invalid_request` / `context_overflow`, including the same error inside SSE.
- One bounded health/models probe returns only `system`. Unknown/malformed health, an unavailable system
  model, a missing system model, guard failure and deadline expiry all fail closed.
- A reusable synthetic fake fm boundary deliberately creates its socket 0755 under a 0700 test directory;
  it supports health/model variants, always-SSE chat, tool/schema answers, missing usage/DONE, overflow,
  hangs and controlled disconnects.

Public contracts, limits, composition example and follow-up ownership are documented in the
[Providers README](../../../packages/providers/README.md). Design:
[D122](../../superpowers/specs/2026-10-31-apple-foundation-models-design.md).
The AF0 input is the [immutable native receipt](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/7e2d0f8640981f8cfadf59134d14d86fb7ef2c28/docs/evidence/apple-fm/2026-11-01-probe-final.md).

## Verification

Host: macOS arm64, Node `v24.21.0`, pnpm `10.28.0`, Cargo `1.95.0`.
Local long-running checks wrote logs under `/private/tmp/ps10-af1-checks-20261101/`.

| Command | Result |
|---|---|
| `node scripts/check-toolchain.mjs` | Passed |
| `pnpm test:prep` | Passed; frozen dependencies, generation, builds, private pinned Engine resolution |
| `pnpm exec tsc -p tsconfig.base.json --noEmit` | Passed on final implementation |
| `pnpm --filter @plur1bus/providers test` | 752 passed; 0 failed/cancelled/skipped/TODO |
| `pnpm --filter @plur1bus/core test` | 11,329 tests: 11,295 passed, 0 failed/cancelled, 22 existing skips, 12 existing TODOs |
| `pnpm lint` | Passed; 163 script tests passed, 0 failed, 3 existing Laya TODOs |
| `pnpm docs:check` | Passed |
| `cargo fmt --all -- --check` | Passed; Rust implementation unchanged |
| `git diff --check` | Passed |

The 49 new regression cases are included in the full Providers run. Test-first failures included SSE
being parsed as JSON, missing managed transport/adapter/probe behavior, malformed neutral messages,
private text retained in native/guard construction errors, mutable URL re-interpretation, an invalid HTTP
status escaping its response event, typed transport aborts masking deadlines, and native overflow inside
SSE being classified as retryable overload. Each was observed failing before its corresponding fix.

The socket tests observe real connections and request bytes. A forwarding spy on `net.Socket.connect`
confirmed a fresh Unix path for both successful requests and a missing-socket failure, without a TCP
attempt. Model refusals leave zero guard calls and zero bytes written. Body caps cover health/models/chat,
exactly one MiB requests, UTF-8 byte accounting and streamed overflow. Tests also cover caller cancellation
while a guard or request-body reader is pending, uncooperative cancellation hooks, early stream exit,
headers/idle deadlines, mid-stream disconnect and capacity release.

No existing test was weakened, disabled or newly marked TODO. POSIX socket cases declare their native
platform requirement; Windows runs the explicit platform-refusal tests, and common SSE completion tests
remain portable. Windows refusal was also exercised with injected host facts on this Mac. No native
Windows/Linux run is claimed. Verification scope is the complete Providers package and its Core consumer
suite. CI was not polled.

## Existing TODO observations

These are unchanged runner observations, not failures introduced by AF1. Names below are quoted as test
names; any pin/version wording in them is not a new assertion about the installed Engine.

Core's 12 TODO cases:

- KNOWN GAP: native Windows directory-entry durability requires a host capability beyond portable Node fsync
- KNOWN-GAP: engine per-request allowedScopes and searchable provenance-only capture are absent on pin 6868b7b1; restrictive profiles suppress engine memory calls
- KNOWN GAP: engine embedding/reranker role probes require the Phase D host ports
- KNOWN GAP: real local Kev MLX inference supplies cold/cache latency and RSS
- KNOWN GAP: Kev German eligibility requires independently labelled paired native Accuracy/Brier evidence
- Controller pin 1.17.0: real high-importance capture → pending → system knowledge.update → KNOWLEDGE.md → recall
- KNOWN GAP: actual pinned Engine 1.19 exposes media API with Host Fetch before construction
- KNOWN GAP: production media reserves image/video units and leases secrets before cloud requests
- KNOWN GAP: real Harness image/audio indexing returns scoped image query and caption-memory recall
- KNOWN GAP: MediaIndexPort.remove and setCaption carry no scope, so the port cannot refuse a caller that does not own the medium
- KNOWN GAP C/D: settle reembed tokens and cost from actual provider usage after the approved Engine 1.15 host network port is wired (currently estimated)
- KNOWN GAP C/D: automatically schedule engine-only restart with restartPending and Web/CLI hint when a live privacy transition needs Engine hot reconfiguration

Lint's three Laya TODO cases:

- KNOWN GAP: production Laya service or module has public backend, bounded abort and role fallback evidence
- KNOWN GAP: independent labels cover the exact paired fixture hash before calibration admission
- KNOWN GAP: role comparison uses independently reviewed identical German/English cases

Core's 22 existing skipped tests:

- a verified peer that has no entry in the peer table is denied, not crashed
- tasks/resubscribe for an unknown task answers TaskNotFound as a JSON-RPC error
- a non-blocking start whose turn throws no-provider must not leave an unhandled rejection
- UNKLAR: a resource link without a name is rendered with a single space
- the Linux verifier uses a live cap and keeps running when it is off or the launcher is unavailable
- a verifier fork bomb is bounded by the cap and ends as a timeout
- the real securePath applies a user+SYSTEM DACL on win32
- native snapshot reports invalid UTF-8 names without confusing them with replacement characters
- refuses names a Windows or case-insensitive target cannot hold
- refuses files that differ only by case on a case-insensitive target
- names two skill folders of one root that differ only by case as a case collision, not a shadow
- live SearXNG answers a search with normalised results
- an unterminated over-long tail is not reported as a (corrupt) line, as the header says unterminated lines are never yielded
- a budget smaller than the first read still gives a continuation cursor when truncated
- gated live OpenAI model listing
- securePath applies an icacls grant on Windows
- a file created later in a secured directory inherits the owner-only grant
- special trees are refused on Linux (/proc aliases, /dev, /sys)
- a link into /proc inside the root is judged on its real target (outside the root)
- BUG: a non-string purpose is refused
- real backend: fork bombs stay inside their own caps while the user keeps starting processes
- live decision evaluation is opt-in and requires a separately supplied model port

The pre-existing suite `D109 paths: Windows (win32 only, run in the windows CI legs)` is also skipped on
this host; it is a suite observation in addition to the 22 skipped tests counted by the runner.

## Remaining package boundaries

AF2 owns the real filesystem guard, Layout resolution, Core composition, discovery reconciliation,
privacy/catalog/role policy, the context fit guard and transport counters. AF3 owns binary/platform/licence
preconditions, production directories and supervisor lifecycle. AF4/AF5 retain their separate node and
German-gate acceptance. AF1 alone does not enable an Apple provider in the product and this fake-server
run establishes no real-model quality, native sidecar or licence acceptance.

No real `fm`, `sudo` or licence command ran for AF1. No dependency, Engine pin, lockfile, schema, Rust source,
D123/SB package, personal Harness configuration or global Apple Intelligence setting was changed.
