# SH3/SH4 Controller F2 implementation plan

**Authorization:** Section F2 of the afternoon Controller rulings dated 2026-11-01 and the SH3/SH4 review from that date. Execute after #854 is pushed. No rebase, amendment, force-push, new dependency, RPC change or Engine modification.

**Architecture:** One immutable secret-set generation owns compiled exact/escaped matchers. Consumers reuse that snapshot. Native tools carry the trusted snapshot to their earliest output boundary, mask using original source coordinates, and only then clip or encode. Persisted Secret-Store I/O runs outside the Core event loop; one bounded startup attempt controls fail-closed availability and queued startup messages.

## Ordering and ownership

- [x] Push/report #854; merge that exact head normally into #857 (M6 first). Resolve Core startup by preserving F1 disclosure policy/watcher reloads and SH3 Store-before-logger ordering.
- [x] Matcher worker: `logs/**`, `secrets/redaction.ts`, matcher/load/output tests. Owns one-pass escaped scanning, overlap coverage, deterministic operation budgets, one-preparation OutputLines path and idle carry.
- [x] Native boundary worker: `tools/{exec,fs,web,sandbox}/**`, `toolcall/validation.ts`, `tools/repair.ts`, `composition/tools.ts`, corresponding boundary tests. Uses shared snapshot contract; no competing matcher/dispatcher/provider edits.
- [x] Startup worker: `secrets/{store,runtime,*backend*,isolated*}.ts`, Core startup/cleanup block, preload/backend/ACL tests, Core build helper entry. No matcher or native tool edits.
- [x] Caller worker: `tools/{dispatcher,registry}.ts`, `composition/{index,provider}.ts`, integration/repair tests; coordinate trusted callbacks with native adapters.
- [x] Consumer worker: `rpc/channel-surface.ts`, `agents/export.ts`, `collab/ports.ts`, `toolcall/model-tool-error.ts`, corresponding tests; the collaboration preview masks before its cap.
- [x] Root: integration review, documentation, lifecycle positive control and changelog.

Focused tests use assigned slots; no builds/generators until integration. Full Core runs alone after all sources freeze. Each worker returns concrete RED→GREEN evidence and freezes, without staging/commit/push.

## Shared contract

`SecretFormsCache.snapshot(values)` returns immutable `SecretFormsSnapshot { forms, matcher }`; `forms()` remains compatible. Registry `snapshot()` returns its current generation. `RedactOptions.secretMatcher` avoids derivation/compilation in production consumers.

`SecretMatcher` exposes `maxFormUnits`, `maxSourceBytes`, text/byte span matching, text/byte source-window masking and JSON scanning. Window coordinates always refer to the original input; a preceding replacement must never shift a caller's requested range. Each intersecting union match emits one marker. Refresh before presentation; if newly required padding exceeds discarded process capture, withhold rather than guess.

## Matcher and output

- [x] Precompile all forms using Aho–Corasick with longest terminal suffix per state; scan raw and escaped views in a constant number of passes. Streaming JSON token scanning avoids forms × retained views. Preserve numeric withholding and original-hit residual semantics.
- [x] Cover periodic/self overlaps, mixed escaped/raw overlaps, surrogate replacement, adjacent markers and object key collisions.
- [x] Load test: 512 runtime-generated secrets, about 170,000 short escaped JSON tokens, no hit and late hit; deterministic operation-count ceiling. Keep time limits generously above observed runtime.
- [x] Prepare each output line once, before byte clipping; writer still protects other attrs/PII/source and schema/rate/dedup/error behavior. No general caller-controlled already-redacted flag.
- [x] Idle/chunk carry retains longest possible secret suffix; do not leak secrets across idle flush, line/retention boundaries, or final UTF-8 cuts. Include a registered secret containing a newline: framing/sanitization must not expose its separate pieces. Oversized frames stay withheld wholesale. Restore `deliveries >= 2` lifecycle positive control.

## Native boundaries

- [x] Trusted snapshot plumbing through composition → provider/dispatcher → ToolRunContext → native adapters.
- [x] Exec captures bounded source prefix plus full match padding, drains remaining stdout/stderr, masks then clips at valid UTF-8 boundaries. Include sandbox's earlier 1 MiB capture boundary.
- Keep any necessary sandbox-adapter change limited to this native output-capture boundary; do not alter containment/External Agents policy. An actual conflict with the active #820 work must be reported rather than overwritten.
- [x] File reads pad both sides through the verified handle; project matches onto original byte window before UTF-8/base64. Preserve validation/identity/abort/EOF/source metadata and final JSON size limit.
- [x] Web preserves HTTP size rejection; masks bounded decoded content and entity-decoded metadata before parse/pagination/title/section limits and cursor storage. Reuse a fresh registry snapshot on cursor reads too; a value registered between pages must not be exposed as a partial match at a later page boundary, and source offsets must remain coherent.
- [x] Validation diagnostics and runtime repair previews mask before 80/40-unit cuts. Sanitize the repair request's argument presentation; execute the original arguments.
- [x] Runtime canaries cross every cap, both file window edges, exec chunk/sandbox cap, all web pages and metadata cuts; include binary/base64, Unicode boundaries and source-offset alignment. Cover real native dispatcher/provider path.

## Store startup

- [x] Isolate actual synchronous native keyring/file operations behind bounded asynchronous IPC; no plaintext argv/env/log/error output, real keychain tests or unrestricted production fixture selector.
- [x] Bound the whole startup attempt, including imports/probe/list/all reads. Timeout is unavailable, distinct from an empty successful Store. Secret use fails promptly via existing unavailable errors; Core remains responsive.
- [x] Invalidate stale completions and recheck availability/generation before secret/lease release. Recovery completes a fresh bounded preload, registers atomically first and preserves startup pins until process exit.
- [x] On timeout, discard unsafe queued startup messages and emit fixed unavailable diagnostics; never replay unread secrets later.
- [x] Cleanup helper/pending requests on stop, rejected startup and ACL refusal with bounded waits. Preserve disabled fallback, audit/grants/leases/reconciliation and injected test seams.
- [x] Actual synchronously hanging child fixture plus heartbeat, bounded startup/stop, fail-closed reveal/lease, late completion, recovery and pinned redaction regressions.

## Publication

- [x] Update truthful startup/output docs and put SH3 changelog under `[Unreleased]`.
- [ ] Run affected packages/API, lint/docs and full Core alone; actual Claude review of exact frozen tree; commit/push #857 and report exact head. Inspect one new CI snapshot and classify remaining MFA/FileOAuth failures against main if present.
- [ ] Merge pushed #857 into #858; remove S3's binding to the IBAN false positive, assert provenance trace/span identity, record S1/S2 follow-ups, normalize changelog. Focused replay tests, necessary gates and actual Claude; push/report #858.
- [ ] Only then continue SH5 → SH6 → SH7 → separate SH8.
