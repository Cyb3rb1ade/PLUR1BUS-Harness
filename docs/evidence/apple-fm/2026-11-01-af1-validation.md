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
  it supports health/model variants, JSON/SSE chat, tool/schema answers, missing usage/DONE, overflow,
  hangs and controlled disconnects.

Public contracts, limits, composition example and follow-up ownership are documented in the
[Providers README](../../../packages/providers/README.md). Design:
[D122](../../superpowers/specs/2026-10-31-apple-foundation-models-design.md).
The AF0 inputs are the [corrected full receipt](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/171e5aceac0f54864c9a3f69b57089336720d658/docs/evidence/apple-fm/2026-11-01-probe-final.md) and
[additional native review run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/171e5aceac0f54864c9a3f69b57089336720d658/docs/evidence/apple-fm/2026-11-01-probe-review.md),
both fixed to the pushed AF0 review head. Streaming overflow is HTTP 200 SSE with an assistant-role chunk,
then the transcript-size error and no `[DONE]`; non-streaming overflow is HTTP 500 JSON. The reusable fake
now exposes that role-then-error case, and both adapter APIs preserve `context_overflow` and release capacity.
The accepted 5056 server-prompt-token lower bound refutes 4096 as the hardware window; the 4096 catalog/guard
policy remains conservative. Native lifecycle observations establish only their ten-second intervals.

## Verification

Host: macOS arm64, Node `v24.21.0`, pnpm `10.28.0`, Cargo `1.95.0`.
Long-running checks wrote logs outside the repository. The D2 follow-up reruns Providers, lint and documentation checks.

| Command | Result |
|---|---|
| `node scripts/check-toolchain.mjs` | Passed |
| `pnpm test:prep` | Passed; frozen dependencies, generation, builds, private pinned Engine resolution |
| `pnpm exec tsc -p tsconfig.base.json --noEmit` | Passed on final implementation |
| `pnpm --filter @plur1bus/providers test` | 753 passed; 0 failed/cancelled/skipped/TODO |
| `pnpm lint` | Passed |
| `pnpm docs:check` | Passed |
| `cargo fmt --all -- --check` | Passed; Rust implementation unchanged |
| `git diff --check` | Passed |

The 50 AF1 regression cases are included in the full Providers run. Test-first failures included SSE
being parsed as JSON, missing managed transport/adapter/probe behavior, malformed neutral messages,
private text retained in native/guard construction errors, mutable URL re-interpretation, an invalid HTTP
status escaping its response event, typed transport aborts masking deadlines, and native overflow inside
SSE being classified as retryable overload. Each was observed failing before its corresponding fix. The additional
role-then-error/no-DONE regression first failed with a missing expected rejection before implementing its fake-server mode;
the production adapter already handled this newly measured native shape.

The socket tests observe real connections and request bytes. A forwarding spy on `net.Socket.connect`
confirmed a fresh Unix path for both successful requests and a missing-socket failure, without a TCP
attempt. Model refusals leave zero guard calls and zero bytes written. Body caps cover health/models/chat,
exactly one MiB requests, UTF-8 byte accounting and streamed overflow. Tests also cover caller cancellation
while a guard or request-body reader is pending, uncooperative cancellation hooks, early stream exit,
headers/idle deadlines, mid-stream disconnect and capacity release.

No existing test was weakened, disabled or newly marked TODO. POSIX socket cases declare their native
platform requirement; Windows runs the explicit platform-refusal tests, and common SSE completion tests
remain portable. Windows refusal was also exercised with injected host facts on this Mac. No native
Windows/Linux run is claimed. Follow-up verification covers the complete Providers package and the shared
lint/documentation checks. CI was not polled.

## Remaining package boundaries

AF2 owns the real filesystem guard, Layout resolution, Core composition, discovery reconciliation,
privacy/catalog/role policy, the context fit guard and transport counters. AF3 owns binary/platform/licence
preconditions, production directories and supervisor lifecycle. AF4/AF5 retain their separate node and
German-gate acceptance. AF1 alone does not enable an Apple provider in the product and this fake-server
run establishes no real-model quality, native sidecar or licence acceptance.

No real `fm`, `sudo` or licence command ran for AF1. No dependency, Engine pin, lockfile, schema, Rust source,
D123/SB package, personal Harness configuration or global Apple Intelligence setting was changed.
