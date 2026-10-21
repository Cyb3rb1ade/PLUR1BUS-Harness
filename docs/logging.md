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

New records flush every second or after 64 records; transitional legacy calls flush synchronously to preserve existing diagnostic readers. `flush()` drains it synchronously; `close()`
also emits pending dedup/drop summaries. Each complete line is appended under a shared native
role lock with `O_APPEND` and fsync. Handles close before rotation and deletion, including on Windows.
Files are secured with the existing module API's private-path helper (0600 on POSIX; Windows ACL).
An I/O failure retains the unwritten queue head for retry; a producer's explicit flush can throw.
The Core bootstrap registers `uncaughtExceptionMonitor` and `exit` flushes without replacing the
process's exception behavior. SIGKILL and power loss cannot flush an in-memory queue.

The sole initialization seam is `core.ts` where the logger is created after loading configuration.
The adapter in `logs/bootstrap.ts` maps Core start/ready/stop and scheduler skips to catalogue
records. Existing callers retain `{at,level,role,...,msg}` through `writeLegacy` (a caller field named `at`, `level`, `role` or `msg` is dropped; the envelope wins); the same writer
redacts and bounds those records and owns their sink. This avoids migrating unrelated call sites
or keeping two rotation owners. Legacy records are a temporary compatibility path, not D111 records.

## Levels

The shared six levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The minimum resolves
exact `kind:id`, longest prefix ending at a `/` boundary, kind, then global default.
`updateLevels({ defaultLevel, levels, traceUntil })` replaces the snapshot atomically and removing
an override restores inheritance. Changed entries emit `log.level.changed`; unchanged snapshots stay quiet.

The `logs.levels` RPC (Owner/Admin, RBAC action `logs.query`) reads or merges that snapshot. Empty
params return the current view. `levels` merges overrides; `unset` removes named keys and restores
inheritance; `defaultLevel` and `traceUntil` replace those fields when present (`traceUntil: null`
clears the expiry). The change takes effect immediately and is live-only: no configuration file is
rewritten, and a restart restores `core.logLevel`. Writes are audited (`action: "logs.levels"`).
Persistent `logs.levels.*` config keys remain a follow-up.

A trace level requires an expiry expressed as epoch milliseconds, in the future and at most 24 hours
away. Resolution after expiry returns debug and emits `log.level.expired` once per observed source
per snapshot. `now` is injectable for tests. The existing `core.logLevel` live setter is wired into
the adapter. Fatal records bypass rate limiting and dedup. This module does not provide notifications.

## Redaction, limits and suppression

Writer-side redaction reuses `logs/redact.ts` and the shared data, before truncation. It covers
sensitive keys/headers, vendor tokens, JWT/PEM, environment values, URL credentials/query/fragment,
credential paths and optional PII (`redactPii`, false by default). `registerSecret(value)` adds known
values of at least eight characters plus base64 and URL encodings to an in-memory registry
capped at the 256 newest values (LRU). The secret store registers every value it sets, rotates, reveals or leases (`secrets/redaction.ts`); the registry fans out to the core log, the discovery and exec writers, the policy audit, `logs.query`/`logs.tail` and the doctor report. A retired or deleted value stays masked: the writer has no unregister. Pure hexadecimal hashes remain readable.
Path matching uses the existing reader's lexical canonicalisation; filesystem/symlink-aware D109
canonicalisation remains a follow-up. A redactor failure drops the original and writes only
`log.redaction.failed` and its registered attempted event. No exception text is written.
Two limits of the free-text `key=value` rule in `logs/redact.ts` are not yet enforced (both are `KNOWN GAP` todo tests in `logger.test.ts`): a secret-keyed pair that follows a `Name:` prefix is not always redacted, and the rule is quadratic in the length of an unbroken word run (about 0.8 s at 4 KiB, 4 s at 8 KiB), so a very long unbroken line is slow to redact.

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
accepts chunks directly, making fake-clock and split-boundary tests deterministic. `exec.run` pipes
stdout and stderr through `OutputLines` into a writer with role `core.out` (`core.out.log`). Only
secretish names or explicitly requested non-locale values of eight or more characters are redacted,
via a per-exec snapshot so one child's env cannot rewrite later children; PATH, TERM, LANG, TZ,
TEMP, TMP, HOME and lookup variables are not registered. The exec writer flushes on its 1s timer
and again after each run. A stdio MCP server's stderr takes the same road: `McpConnection` splits it into lines,
removes the server's declared secrets (ADR-014 §7), and passes the lines through `OutputLines` into a second writer
of role `core.out` whose source is `harness` / `mcp` (`composition/`), so a line is a `process.output.line` with
`stream: "stderr"` and `untrusted: true`, capped, redacted and rate-limited like exec output. The protocol stdout
is never written as output lines. Without a writer (`RegistryOptions.output` unset, as in unit tests of the registry)
the older `mcp.server.stderr` debug record is written instead, never both. The record does not name the server;
the `mcp.server.started` record carries the pid and the name.

Each stream assembles UTF-8 lines across reads, strips ANSI/OSC and C0/C1 controls (tabs survive),
redacts and truncates. A partial line is emitted after one second idle (`tick` from the exec timer,
then `flush`). Memory per line is bounded at 64 KiB; larger lines are replaced wholesale by
`[TRUNCATED:oversized-line]` with their original byte count, rather than exposing a credential
prefix from discarded bytes. Framed text is then cut to 4096 bytes (`LIMITS.lineBytes`) before
writer-side redaction.
Each stream has its own 100/s, burst-500 bucket and emits `process.output.suppressed` with the count.

`process.output.line` always has level info, `stream`, `attrs.text`, `attrs.untrusted: true`.
JSON, `ERROR:` and `panic` are text and cannot forge events or levels. `signalLevel` separately maps
exit/signal, HTTP status plus retry decision, and typed protocol failure to info/warn/error.
There are no stderr text-prefix exceptions in the decided spec (§2.4.7).

## Trace context

`parseTraceparent`, `newTrace`, `withTrace` and `currentTrace` implement strict W3C version-00
carriers and AsyncLocalStorage isolation. Every new record gets a valid trace id and span id.
`fromRpcMeta(meta, trusted)` adopts only a valid carrier from a caller explicitly marked authenticated
and trusted; other callers start a new trace with `link_trace_id`. Authenticated RPC dispatch in
`packages/core/src/rpc/server.ts` runs each handler under `withTrace(fromRpcMeta(params._meta, true))`.
`params._meta` is stripped before schema validation (design §2.8). Invalid, all-zero or untrusted
carriers start a new trace instead of being adopted. No helper sends a trace carrier to an external
vendor.

## Acceptance boundaries and follow-ups

`packages/core/test/logs/writer.test.ts` and `bootstrap.test.ts` cover schema/catalogue, live internal
levels/expiry, writer redaction, UTF-8/byte limits, dedup, source/stream rate limiting, retention,
independent concurrent processes, wrapper hard signals, ALS, reader integration and idle behavior.
The existing #180 query/tail/redaction/RPC tests remain unchanged. Remainder tests: "level change
takes effect immediately and only for that component"; "without a writer, live level writes fail closed";
"foreign output is bounded and redacted"; "a partial line is emitted after one idle second and flushed without close";
"trace-id from RPC to log record"; "invalid trace-id is replaced, not adopted"; "traceId matches the record's trace_id exactly";
CLI filter mapping (`--trace` → `traceId`), `E_INVALID_PARAMS` exit 2 and signal exit 130.

| Spec §8 | Coverage here | Follow-up outside this remainder's allowed scope |
|---|---|---|
| 1 | New TS diagnostic/output records, key order, existing level maps | Rust writer parity; legacy caller migration |
| 2 | Writer rejects unregistered events in strict mode, release fallback | Whole-repo event-literal migration/static scan |
| 3 | Internal live snapshots, precedence, fake-clock expiry; `logs.levels` RPC (live-only) | Persistent `logs.levels.*` config keys, supervisor/modules |
| 4 | Chunk/UTF-8 boundaries, forged JSON/ERROR, ANSI/OSC, 1 MiB line, flood, secret; `exec.run` stdout/stderr as `process.output.line` | Rust raw-pump integration; per-server attribution of MCP stderr lines |
| 5 | Exit, signal, HTTP and typed protocol classifier | Provider/MCP/ACP call-site wiring |
| 6 | Writer secret-pattern/encoding canaries and reader defense | Audit/payload/CLI/error/bundle/export/desktop outputs; secret-store registration; physical path canonicalisation |
| 7 | 340 occurrences, exact summary, fatal bypass | Audit remains independently owned |
| 8 | Diagnostic startup/daily age pruning, rotation, audit exclusion | Other streams and shared config schema |
| 9 | Existing audit readers retained | Audit v2, mirrors, config audit; audit files forbidden here |
| 10 | ALS isolation, trusted RPC-meta helper, malformed/untrusted carriers; authenticated RPC `fromRpcMeta` + `withTrace` | CLI/supervisor/module/child/channel hops |
| 12 | Existing offline reader filters and query/tail; `plur1bus logs query` / `tail` (RPC, not offline merge) | Offline file merge, `logs level` CLI; spec §8 test 12 on five targets |
| 13 | Logging paths contain no network calls/imports or vendor endpoints | OTLP exporter/endpoint admission; no exporter added |
| 14 | Actual scheduler skip example maps its reason at info | All scheduler outcomes and job-specific diagnostics |
| 15 | Fake-clock idle writer adds no periodic diagnostics | Whole-harness supervisor/module idle acceptance |

The D111 remainder on this branch adds the `logs.levels` live snapshot RPC, wraps `exec.run` child
output, adopts `_meta.traceparent` on authenticated RPC, and adds `plur1bus logs query|tail`.
`logs.query` / `logs.tail` accept optional `traceId` (exact `record.trace_id`); `text` stays a
redacted-record substring. `plur1bus logs query|tail --trace` maps onto `traceId`. Live level
writes are omitted when the core uses an injected logger (`E_NOT_AVAILABLE`).
MCP-stdio wrapping, persist-to-config `logs.levels.*` keys, supervisor/module writers, OTLP and
the five-target §8 suite remain follow-ups. Remaining sources: engine operations, RPC failures,
configuration watch/fallback, models/discovery, providers/auth, tool/MCP/ACP lifecycles, channels,
host, desktop, supervisor/modules and CLI. Full schema-only diagnostic migration, global secret
registration, config schema live appliers and Rust writer parity require separate work.
