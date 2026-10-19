# PR #602 — Engine 1.15 host ports, completion A–D (2026-10-19)

Branch `codex/engine-115-wiring`. Current main was merged normally in `916462ada4`; no rebase, amend or force-push.
The separate controller pin remains `98dfe2f03363f6291daa9f85e473578770fb5c55` (contract 1.16 includes 1.15).
Neither `packages/core/package.json` nor `pnpm-lock.yaml` is changed by this follow-up. `memory.unimport` and import
source links remain the controller's existing implementation. No paid provider request was made.

## A — real-model release-smoke regression

The requested release build, workspace build and cold `two-session-recall.test.ts` reproduced `provider-failed`.
A preserved equivalent Core home exposed the cause in `logs/core.log`:
`embedding.probe: provider failed: huggingface.co is not in egress.allowHosts` (also the local reranker).
The Engine now correctly uses the host fetch port for weights; the ordinary default-deny policy had no model catalog
exception. Real artifact requests redirect from `huggingface.co` to `us.aws.cdn.hf.co`.

`egress.modelDownloads` is a live, named catalog policy, enabled by default with exactly those two hosts. Only
credential-free HTTPS GET/HEAD repository artifact reads qualify. Removing a host or disabling downloads remains
authoritative even if ordinary `egress.allowHosts` contains `*`. No arbitrary host, provider API, body, sensitive
header or URL query can opt itself into this exception. Each redirect retains Egress, allowed-port, SSRF and DNS-pin
checks. Harmless Accept/User-Agent/Range headers may accompany a redirected GET/HEAD; Authorization/API-key headers
and bodies are never redirected. Responses remain streamed, decoded, capped at 2 GiB and bounded by five minutes.
There is no global-fetch fallback. Local-only continues to refuse remote inference providers.

RED→GREEN regressions: `test/egress/model-downloads.test.ts` covers the named exception, disabling/removing a host,
wildcard non-bypass, private DNS, credential/provider/body exclusions. `test/engine-host-ports.test.ts` includes
`model GET redirect with harmless headers streams a large gzip/chunked response across hosts` (21 MiB decoded,
two loopback host spellings), separate stream cap/deadline/abort tests and GET/POST credential non-redirect assertions.
Port diagnostics log only safe host, code and class, including the actual denied redirect host, never signed URLs.

## B — real acceptance without a paid provider

Node 24.21.0; production pinned Engine, real local E5 embedder and BGE reranker; empty caches. Measurements below
are elapsed wall time from local runs, not claims about GitHub runners or owner reference hardware.

| Environment | Cold ready | Model warm after ready | Full two-session test | First recall wall / Engine |
|---|---:|---:|---:|---:|
| macOS arm64 | 667 ms | 19,068 ms | 24,408 ms | 116 / 99 ms |
| Linux amd64 Docker, emulated on the arm64 Mac | 2,577 ms | 35,959 ms | 55,265 ms | 948 / 864 ms |
| Linux arm64 Docker, native architecture | 754 ms | 17,286 ms | 22,561 ms | 210 / 205 ms |

All three executions of `tests/system/two-session-recall.test.ts` passed (one test each), including real reranking,
capture, cross-session recall, Core kill, journal replay and recall after restart. macOS used the requested command
with the strict default recall targets. Linux runs used the workflow's `PLUR1BUS_CI_RECALL_HARD_MS=3000`; emulated
amd64 exceeds the 400/600-ms reference targets and stays below that CI ceiling. arm64 also meets strict targets.
Linux images were built from the repository Dockerfile; amd64 additionally passed `scripts/container-smoke.sh`
(health, version, non-root/read-only filesystem, writable state, no image-metadata secrets, clean stop).

The cold macOS cache contained 10 files / **1,074,425,498 bytes**. The eight revision-pinned artifacts total
1,074,424,023 bytes; the extra 1,475 bytes are two root configuration copies. Principal weights:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| E5 `onnx/model.onnx` | 470,268,510 | `ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665` |
| BGE `onnx/model_quantized.onnx` | 569,986,762 | `1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3` |

E5 revision: `614241f622f53c4eeff9890bdc4f31cfecc418b3`; BGE revision:
`c44ebc43de724ae8816668bb44d2e728e17faa18`. A second cold Core was SIGKILLed after observing 8,711,197 bytes
in its in-flight E5 download; shutdown took 17 ms. A deliberately corrupted pinned E5 `config.json` was then placed
in that cache before restart. Hash validation rejected/replaced it; restart warmed both models in 20,972 ms
(22,028 ms total), and both weight hashes matched the table. The restored 655-byte E5 config hash was
`69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959`.

SIGKILL leaves two unpublished `.part-<old-pid>-<uuid>` files (8,776,733 and 1,405,908 bytes). They are not loaded
as models; successful restart publishes verified artifacts. Automatic orphan-part cleanup is not implemented by
the pinned Engine and is a remaining storage-cleanup follow-up, not a claim of an empty temporary cache.

Live denial acceptance: a running Core with `privacy.localOnly: true` successfully tested the real local embedder
(384 dimensions, 1,961 ms). Removing `us.aws.cdn.hf.co` from the target home's live model policy blocked the next
real redirected model request as `egress-denied`, host `us.aws.cdn.hf.co`. Restart with a fresh cache produced
`provider-failed`; `admin.engine.test` returned `ok:false,errorClass:egress` in 210 ms. No fallback occurred.

Evidence logs on the validation machine: `/tmp/pr602-real-{red,cold}.log`, `/tmp/pr602-red-preserved.log`,
`/tmp/pr602-linux-{amd64,arm64}-real.log`, `/tmp/pr602-docker-amd64-{build,smoke}.log`,
`/tmp/pr602-abort-results.json`, `/tmp/pr602-live-policy-results.json`. These ephemeral files contain measurement
evidence, not committed fixtures; generated signed download URLs were not copied into this document.

## C — macOS import containment and rollback

`5380ffbddd` fixes all nine reproduced baseline failures: three `isInsideDir` and six rollback cases involving
`/var` versus `/private/var`. Both sides are canonicalized with `realpathSync.native`; missing targets walk to
the next existing ancestor and append the remaining suffix. ELOOP/ENOTDIR fail closed. Existing symlink escapes,
including missing children below an external symlink, remain outside; caller-visible rollback report spelling
is preserved after canonical equality checks.

`import/fs-atomic.test.ts` + `import/rollback-ledger.test.ts`: baseline 64 passed / 9 failed; expanded RED 67 passed /
14 failed; GREEN **81/81**. The three security regressions fail when the old containment code is restored.
All import tests: **1,113 total, 1,108 passed, zero failures, four skipped, one existing TODO**. Eight new cases
cover aliases, missing ancestors, symlink escapes, cycles and invalid intermediate components.

## D — real Engine role tests, RPC and Web

`admin.engine.test` is experimental, Core-owned, closed-params and human Owner/Admin-only (`settings.write`),
with the existing device-scope/API allowlist rules. It calls public Engine `embedding.embed` / `rerank` through
the production host ports, using bounded fixed inputs and a ten-second deadline, without session/memory writes.
The result contains role, success, latency, safe model identifier and embedding dimensions, or a fixed error class:
`egress`, `key`, `download`, `provider`, `timeout`, `unsupported`. Key values, raw exceptions, URLs and provider
payloads never leave the probe boundary. Per-probe async diagnostics preserve a port failure class when an Engine
provider replaces its exception. Concurrent unrelated requests cannot overwrite another probe's diagnostic context.

Models and Memory have de/en Test buttons using the shared component, accessible status feedback and no inline
styles. There is no captioning Engine-role contract; it is explicitly unsupported. Remote configured role tests
can invoke their selected provider; acceptance here used local models/loopback only, never a paid provider.

Named tests: `engine-role-test.test.ts` (input/result validation, timeout, sanitization, RBAC/scopes and diagnostic
isolation), `engine-role-live.test.ts` (real Engine fetch/secret/embed/rerank, live egress, real Core RPC), API
`web-rpc.test.ts`, Web `engine-role-test.test.ts` (Models/Memory, de/en, errors, permissions, three axe checks).
Generated RPC fixtures/types, Python schema and RPC/config documentation were regenerated through the tooling.
Focused D checks: RPC/schema 88/88, real Engine/Core 2/2, API 9/9, Web/i18n/accessibility 99/99.

## Implementation commits

All commits use `Cyb3rb1ade <cyb3rblade@me.com>`; implementation/test/docs commits retain the Codex co-author trailer.

| Commit | Change |
|---|---|
| `916462ada4` | Regular merge of main |
| `5380ffbddd` | Native canonical import containment and rollback paths |
| `e7dfe2fbb6` | Named, guarded model downloads and safe port diagnostics |
| `37e96052cb` | Engine role RPC and Models/Memory tests |
| `7a05f99ea4` | Rust RPC fixture/generative/roundtrip registrations |
| `bb9c8a0853` | Settings field metadata for the model download policy |
| `c0367130b1` | WebMCP exclusion regression for the new admin method |
| `b2c95df4a1` | RBAC documentation parity |
| `f985f97e67` | Human-only Core RPC inventory |

This handoff and final validation totals are committed separately after the implementation checks.

## Completion checks and remaining external gates

The full workspace run completed **17,860 tests: 17,627 passed, seven failed, 51 skipped, 175 TODO**.
Core accounted for 9,651 tests (9,606 passed, one inventory mismatch, 20 skipped, 24 TODO).
Four of the seven failures were the new Settings metadata, WebMCP admin count, RBAC documentation row and Core
human-only inventory mismatches; all four were fixed and their relevant suites rerun green as detailed below.
The other three were the two main-reproduced browser cases and the intermittent palette focus case. No second
full workspace run is claimed after those focused fixes. Full output: `/tmp/pr602-full-test.log`.

`pnpm lint` passed (typecheck, generation/build, source-quality/hygiene/i18n and 106 tooling tests).
`pnpm docs:gen` and `pnpm docs:check` passed. The final combined HTTP/Egress/host-port/role suite passed **157/157**.
The broad Web run also caught missing static Settings metadata for the new catalog policy; the fields were added.
Settings schema/palette alignment, config UI and Engine role buttons passed **51/51** in the final focused rerun;
the final TypeScript check passed. WebMCP's explicit admin-method count was updated and the new method's exclusion
asserted; its full package rerun passed (783 tests, 651 passed, 132 existing TODO, zero failures).
The API's RBAC parity check caught a missing documentation row for the new method; after adding it, the full API
package passed: **813 total, 802 passed, four skipped, seven existing TODO, zero failures**.
The Core's explicit human-only inventory was also extended for the new RPC; principal-boundary and real/fake
role-probe checks passed **53/53** in `/tmp/pr602-core-rbac-final.log`.
Rust formatting and workspace Clippy passed. The broad Rust run exposed missing dispatch entries for the new RPC
in three hand-maintained fixture/generative/roundtrip tables; these were added and all **21/21** corresponding tests
now pass. The broad run otherwise completed 2,118 passing tests and nine ignored tests; its additional Docker
fake-API target abort/failure reproduces on unchanged main and in an isolated rerun (macOS curl/fake network handling).
This is separate from the real amd64 image build/smoke, which passed again after the final runtime changes.
Rust evidence: `/tmp/pr602-rust-checks.log`, `/tmp/pr602-rust-rpc-green.log`, `/tmp/pr602-rust-docker-baseline.log`,
`/tmp/pr602-final-clippy.log`; final image smoke: `/tmp/pr602-docker-amd64-final-smoke.log`.
The full workspace run also exercises locally available Chromium. Its existing chat keyboard/stale-revision case
fails identically on an archived unchanged main baseline (`916462ada4`, one failed of two selected checks). The
palette settings-focus test failed in the broad run and one rerun, then passed isolated; it also passes on that
main baseline. The existing Users rights save test also fails identically on unchanged main (missing the expected
revocation in the test's observed write set). None of these unrelated browser behaviors was changed.
Evidence: `/tmp/pr602-web-main-baseline.log`, `/tmp/pr602-users-rights-baseline.log`,
`/tmp/pr602-web-failures-rerun.log`, `/tmp/pr602-palette-isolated.log`.

Required GitHub checks are `unit (ubuntu-24.04)`, `build + smoke (amd64)`, `wsl`, and functional release smoke
linux-x64/linux-arm64. **CI was not polled**, per owner instruction; their final GitHub status is not asserted here.
Local amd64/arm64 image builds, amd64 container smoke and both Linux real-model smokes passed. Actual Windows/WSL
host acceptance is unavailable on this Mac and remains an external gate. The existing excluded Windows release-smoke
and Python-host executable-casing failures were not changed. No merge or deployment is performed by this task.

Owner questions: none for the implemented scope. Future orphan-part cleanup and the missing captioning Engine-role
contract belong to their owning components; automatic Engine hot-reconfiguration and real reembed usage remain
separate previously documented work.
