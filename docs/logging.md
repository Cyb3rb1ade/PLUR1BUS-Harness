# Core diagnostic logging (D111 writers)

The Core writer lives in `packages/core/src/logs/writer.ts`. It uses the existing, read-only
`@plur1bus/log-schema` record schema, catalogue, level map, byte limits and redaction data.
It creates no network connections and has no exporter. Audit remains owned by the audit module;
this writer rejects audit and payload events and cannot open either stream's file.

## Records and files

`createWriter({ dir: <home>/logs, role: "core", source: { kind: "harness", id: "core", version } })`
writes JSONL to `core.log`; wrapped output uses a writer with role `core.out`, producing
`core.out.log`. Rotated generations are `core.log.1`, `.2`, etc. These are the names already
consumed by `logs.query` and `logs.tail`, which continue to read legacy records too.

New records have the schema's fixed key order:

```json
{"ts":"2026-10-07T00:00:00.000Z","level":"info","source":{"kind":"harness","id":"core","version":"0.1.0"},"event":"core.process.started","msg":"core started","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","attrs":{"pid":4242}}
```

`write(event, attrs, { source?, level?, stream? })` derives the constant message and default level
from the catalogue. Every new record is validated against both schema and event-specific attrs
before enqueueing. Unknown events throw with `strict: true`; otherwise they produce a redacted
`log.unregistered` record. Audit/payload events and invalid attribution, attrs or levels are refused.

The queue flushes every second or after 64 records. `flush()` drains it synchronously; `close()`
also emits pending dedup/drop summaries. Each complete line is appended under a shared native
role lock with `O_APPEND` and fsync. Handles close before rotation and deletion, including on Windows.
Files are secured with the existing module API's private-path helper (0600 on POSIX; Windows ACL).
An I/O failure retains the unwritten queue head for retry; a producer's explicit flush can throw.
The Core bootstrap registers `uncaughtExceptionMonitor` and `exit` flushes without replacing the
process's exception behavior. SIGKILL and power loss cannot flush an in-memory queue.

The sole initialization seam is `core.ts` where the logger is created after loading configuration.
The adapter in `logs/bootstrap.ts` maps Core start/ready/stop and scheduler skips to catalogue
records. Existing callers retain `{at,level,role,...,msg}` through `writeLegacy`; the same writer
redacts and bounds those records and owns their sink. This avoids migrating unrelated call sites
or keeping two rotation owners. Legacy records are a temporary compatibility path, not D111 records.

## Levels

The shared six levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The minimum resolves
exact `kind:id`, longest prefix ending at a `/` boundary, kind, then global default.
`updateLevels({ defaultLevel, levels, traceUntil })` replaces the snapshot atomically and removing
an override restores inheritance. Changed entries emit `log.level.changed`; unchanged snapshots stay quiet. This is the internal attachment point for a later `logs.levels` RPC.

A trace level requires an expiry expressed as epoch milliseconds, in the future and at most 24 hours
away. Resolution after expiry returns debug and emits `log.level.expired` once per observed source
per snapshot. No configuration file is rewritten. `now` is injectable for tests. The existing
`core.logLevel` live setter is wired into the adapter; new per-source config keys/RPC are follow-ups.
Fatal records bypass rate limiting and dedup. This module does not provide notifications.

## Redaction, limits and suppression

Writer-side redaction reuses `logs/redact.ts` and the shared data, before truncation. It covers
sensitive keys/headers, vendor tokens, JWT/PEM, environment values, URL credentials/query/fragment,
credential paths and optional PII (`redactPii`, false by default). `registerSecret(value)` adds known
values of at least eight characters plus base64 and URL encodings to an in-memory registry.
The secret store is not newly wired here. Pure hexadecimal hashes remain readable.
Path matching uses the existing reader's lexical canonicalisation; filesystem/symlink-aware D109
canonicalisation remains a follow-up. A redactor failure drops the original and writes only
`log.redaction.failed` and its registered attempted event. No exception text is written.

Messages are bounded by the catalogue and 2 KiB. Attrs are bounded by 8 KiB and the serialized
record by 4 KiB. Strings are cut at UTF-8 code-point boundaries with `…`; large arrays are shortened.
`attrs.truncated` and `attrs.bytes` mark the original size. Required attribute types remain intact;
a record that cannot fit while satisfying its schema is refused.

Identical redacted records share a 60-second window: the first is emitted immediately, and a
summary repeats the same event with `attrs.repeat` counting all occurrences, including the first,
and `attrs.window_ms: 60000`. Trace contexts are kept separate. Dedup state is bounded to 1,000
keys; eviction emits its pending summary. Fatal records are never deduplicated; audit is not written
here. After dedup, a source receives a token bucket of 100 records/second, burst 500. Excess records
produce `log.suppressed` with a drop count. Reader timestamps/cursors are unaffected.

## Rotation and retention

Rotation occurs before a line crosses `maxBytes` (default 20 MiB) or on a UTC-day transition.
`keep` defaults to five generations; `setRotation` updates it live. `retentionDays` defaults to 14,
with zero disabling age pruning. Startup and daily maintenance delete only this role's expired,
regular, numbered generations and emit `log.retention.pruned`. Active files, symlinks, audit,
payload, and other roles' files are excluded. No descriptors remain open across deletion.

## Child output and hard signals

`wrapOutput(writer, { stdout?, stderr? })` consumes existing child streams; omit stdout when it
carries MCP protocol. It neither spawns a process nor changes its environment. `OutputLines` also
accepts chunks directly, making fake-clock and split-boundary tests deterministic.

Each stream assembles UTF-8 lines across reads, strips ANSI/OSC and C0/C1 controls (tabs survive),
redacts and truncates. A partial line flushes after one second idle. Memory per line is bounded at
64 KiB; larger lines are replaced wholesale by `[TRUNCATED:oversized-line]` with their original
byte count, rather than exposing a credential prefix from discarded bytes. This conservative
choice differs from the spec's literal 4 KiB raw spool but preserves its 4 KiB written-record bound.
Each stream has its own 100/s, burst-500 bucket and emits `process.output.suppressed` with the count.

`process.output.line` always has level info, `stream`, `attrs.text`, `attrs.untrusted: true`.
JSON, `ERROR:` and `panic` are text and cannot forge events or levels. `signalLevel` separately maps
exit/signal, HTTP status plus retry decision, and typed protocol failure to info/warn/error.
There are no stderr text-prefix exceptions in the decided spec (§2.4.7).

## Trace context

`parseTraceparent`, `newTrace`, `withTrace` and `currentTrace` implement strict W3C version-00
carriers and AsyncLocalStorage isolation. Every new record gets a valid trace id and span id.
`fromRpcMeta(meta, trusted)` adopts only a valid carrier from a caller explicitly marked authenticated
and trusted; other callers start a new trace with `link_trace_id`. These helpers do not alter RPC
schemas or middleware. No helper sends a trace carrier to an external vendor.

## Acceptance boundaries and follow-ups

`packages/core/test/logs/writer.test.ts` and `bootstrap.test.ts` cover schema/catalogue, live internal
levels/expiry, writer redaction, UTF-8/byte limits, dedup, source/stream rate limiting, retention,
independent concurrent processes, wrapper hard signals, ALS, reader integration and idle behavior.
The existing #180 query/tail/redaction/RPC tests remain unchanged.

| Spec §8 | Coverage here | Follow-up outside this PR's allowed scope |
|---|---|---|
| 1 | New TS diagnostic/output records, key order, existing level maps | Rust writer parity; legacy caller migration |
| 2 | Writer rejects unregistered events in strict mode, release fallback | Whole-repo event-literal migration/static scan |
| 3 | Internal live snapshots, precedence, fake-clock expiry; existing Core live default | New config keys, `logs.levels` RPC, supervisor/modules |
| 4 | Chunk/UTF-8 boundaries, forged JSON/ERROR, ANSI/OSC, 1 MiB line, flood, secret | Rust raw-pump integration |
| 5 | Exit, signal, HTTP and typed protocol classifier | Provider/MCP/ACP call-site wiring |
| 6 | Writer secret-pattern/encoding canaries and reader defense | Audit/payload/CLI/error/bundle/export/desktop outputs; secret-store registration; physical path canonicalisation |
| 7 | 340 occurrences, exact summary, fatal bypass | Audit remains independently owned |
| 8 | Diagnostic startup/daily age pruning, rotation, audit exclusion | Other streams and shared config schema |
| 9 | Existing audit readers retained | Audit v2, mirrors, config audit; audit files forbidden here |
| 10 | ALS isolation, trusted RPC-meta helper, malformed/untrusted carriers | RPC middleware and CLI/supervisor/module/child/channel hops |
| 12 | Existing offline reader filters and query/tail read writer files | `plur1bus logs` extensions, level CLI; Rust forbidden here |
| 13 | Logging paths contain no network calls/imports or vendor endpoints | OTLP exporter/endpoint admission; no exporter added |
| 14 | Actual scheduler skip example maps its reason at info | All scheduler outcomes and job-specific diagnostics |
| 15 | Fake-clock idle writer adds no periodic diagnostics | Whole-harness supervisor/module idle acceptance |

Remaining sources: engine operations, RPC failures, configuration watch/fallback, models/discovery,
providers/auth, tool/MCP/ACP/exec lifecycles, channels, host, desktop, supervisor/modules and CLI.
Full schema-only diagnostic migration, global secret registration, config schema live appliers,
Rust writer parity and end-to-end trace propagation require separate work. No new RPC, CLI, RBAC,
audit writer, telemetry, workflow or schema changes are included here.
