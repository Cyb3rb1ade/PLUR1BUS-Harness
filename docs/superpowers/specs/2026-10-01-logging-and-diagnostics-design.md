# Logging and diagnostics — design (D111)

**Status:** Decided (owner 2026-10-01, "Ja", the proposal in §2 with all four defaults) · **Date:** 2026-10-01 · **Owner:** Christian (Cyb3rb1ade) · **Milestone:** foundation in **M1b-2b** (first, before D109/D106 code); later parts with M2, M3, M8 and track D (§9) · **Inputs:** `crates/plur1bus/src/supervisor/mod.rs` (`Log`, the `logs/supervisor.log` line `{ at, level, role, …fields, msg }`), `crates/plur1bus/src/supervisor/logfile.rs` (`RotatingFile`, S17), `crates/plur1bus/src/supervisor/child.rs` (`pump`, the raw `logs/<role>.out.log`), `crates/plur1bus/src/audit.rs` (HB12), `crates/plur1bus/src/repair/risky.rs` (`service.silent-exit` reads `supervisor.log`), `packages/module-api/src/logger.ts` (`createLogger`, `HarnessLogger`), `packages/module-api/src/runtime.ts:235`, `packages/core/src/logger.ts`, `packages/core/src/core.ts:192` · ADR-002 Q6 · ADR-004 (audit list, Sessions/Logs/Audit page, role matrix) · ADR-005 (secrets "never" row, action item 8) · ADR-006 "Implementation record (2a-H3b-b)" (audit log HB12) · ADR-007 (Operator role, ACL audit, PR #4) · ADR-008 (deprecated MCP logging → stderr/OpenTelemetry) · ADR-009 (cause 6, silent early returns) · ADR-010 §4 (budgets), B5 · ADR-012 (process model, RPC) · ADR-013 §2, §8 (keys, live appliers) · ADR-016 · `docs/config.md` (generated) · `docs/rpc.md` (generated, `Request` envelope) · `docs/extensions.md` "Audit" · `docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` §D109 (§6 store, §8 untrusted content, §9 audit), §D94 (no bodies in logs), §D106 (audit line) · `docs/superpowers/specs/2026-09-30-openai-auth-design.md` §2.5 item 7, §5 test 5 · `docs/superpowers/specs/2026-09-27-desktop-app-design.md` §6.9 "Logs", §6.13 · `docs/handoff/2026-09-30-desktop-shell-codex.md` §4.2 "Logs"/"Crash handling", WP6 · `docs/milestones.md` M1b-2b · `skills/plur1bus-ops/SKILL.md`, `playbooks/diagnose.md`.

## 1. Verified current state (`origin/main` @ `7db4dcc`)

| # | Fact | Where |
|---|---|---|
| F1 | Every harness process writes JSON lines `{ at, level, role, …fields, msg }`; `at` is an ISO-8601 string; levels `debug\|info\|warn\|error`; no event code, no source version, no trace id. | `supervisor/mod.rs` `Log::write`; `module-api/src/logger.ts` `createLogger` |
| F2 | The supervisor's `Log` has **no level filter** (it has only `info/warn/error` methods); module processes are created with `level: "info"` hard-coded, so `core.logLevel` reaches the core only. | `supervisor/mod.rs` `Log`; `module-api/src/runtime.ts:235`; `core.ts:192` |
| F3 | Children's stdout/stderr are copied **as raw bytes** in 8 KiB chunks into `logs/<role>.out.log` — no line assembly, no wrapping, no redaction, no rate limit. | `supervisor/child.rs` `pump` |
| F4 | Size rotation exists (`logs.maxBytes` 20 MiB, `logs.keep` 5, live since 2a-H3b-a); no retention by age. The TS sink opens files `0600`; the Rust `RotatingFile` opens with the process umask (no mode set). | `logfile.rs` `append`; `logger.ts` `rotatingSink`; ADR-013 §2 |
| F5 | `logs/audit.log` (HB12): `{ at, actor: { user, host }, action, target, detail }`, `at` **epoch milliseconds (number)**, `0600`/user+SYSTEM DACL, one `write_all` on `O_APPEND`, fsynced; actions `licence.accept-nc`, `setup.complete`, `repair.<step>`, `ext.install\|enable\|disable\|uninstall\|purge\|restore`. Not rotated. | `audit.rs`; ADR-006; `docs/extensions.md` "Audit" |
| F6 | D109 keeps its own audit (requests, decisions, grant changes, denials, integrity failures) in the core's SQLite store, HMAC-chained, **retained 400 days**, read by `plur1bus approval audit`. | D109 §6, §9 |
| F7 | `core.logLevel` enum `debug\|info\|warn\|error`, class `live`; `logs` has `additionalProperties: false` (only `maxBytes`, `keep`). `docs/config.md` is **generated** from the schema by `scripts/gen-docs.mjs`. | `packages/config-schema/schema/config.schema.json`; ADR-013 §2 |
| F8 | The RPC `Request` envelope is `additionalProperties: false` with `params: object`; no trace field exists anywhere. | `docs/rpc.md` `Request` |
| F9 | `1staid repair`'s `service.silent-exit` matches the **message text** `exiting 0 instead of <code>` and the `at` of the last `supervisor.log` record. | `repair/risky.rs:46-535` |
| F10 | The desktop shell has one redacting formatter (Authorization, cookies, `token\|ticket\|csrf\|code\|key` JSON values, URL query and fragment, base64url runs ≥ 43, `PLUR1BUS_*` env values) and local crash files; nothing is uploaded. | desktop spec §6.9 "Logs"; handoff §4.2, WP6 |
| F11 | "Critical push" today is an **engine** memory feature: the host capability `pushCriticalButtons` delivers critical memory cards with accept/reject buttons (contract 1.7.0). It is not a general alert route. | E3 plan; basics spec F6 |
| F12 | ADR-009 cause 6: six silent early returns in `runRemDream`, four invisible at the default level (`debug` or no log). | ADR-009 §1 table row 6 |
| F13 | D110 requires that tokens, `ek_…` values, issued client IDs and `id_token_hint` URLs never reach logs, `--json`, audit, exports or fixtures. It says nothing about the provider request id. | D110 §2.5 item 7, §5 test 5 |

## 2. Decision D111

**PLUR1BUS writes five separate streams in one OpenTelemetry-aligned JSONL record format, from a writer that owns levels, redaction, truncation, dedup and rate limits; every record names its source; third-party output is wrapped and never trusted; LLM traffic is logged as metadata only unless the person turns on time-limited payload capture; nothing leaves the machine unless the person points an OTLP exporter at their own collector.**

### 2.1 Streams

| Stream | Content | Sink | Retention (default) | Readers |
|---|---|---|---|---|
| **diagnostic** | technical events from every source (§2.3) | `logs/<role>.log` (own records), `logs/<role>.out.log` (wrapped child output, §2.4) | **14 days** + size rotation | `plur1bus logs`, web/desktop viewer, bundle, Owner/Admin/Operator |
| **audit** | immutable who-did-what: approvals and grants (D109), config changes, installs and extensions, logins/secrets, licence, setup/repair, payload-capture and OTLP switches, break-glass (M3) | `logs/audit.log` (extended, never replaced) | **unlimited** | `plur1bus logs --stream audit`, `plur1bus approval audit` (D109), V2Approvals › Audit, Owner/Admin |
| **activity** | human-readable feed for the UI ("Bernd ran `pkg.install` — approved by you") | core SQLite table `activity` (M3), derived from diagnostic/audit events flagged `activity: true` in the catalogue | 90 days | web UI, desktop, channels |
| **usage** | tokens, cost, latency per model, provider, agent, project, user | core SQLite table `usage` (M2) — the source of truth for ADR-010 §4 budgets and B5 | 400 days | `plur1bus usage` (M2), budgets, UI |
| **transcripts** | conversation content | the session store (2c) — **never** a log | session rules (incognito, retention) | sessions UI |

Payload capture (§2.5) writes a sixth, opt-in, short-lived file `logs/payload.log`; it is not a stream that exists by default.

### 2.2 Record format

One JSON object per line, UTF-8, keys in this order (grep-stable), absent optional keys omitted:

```json
{"ts":"2026-10-01T09:14:03.218Z","level":"error","source":{"kind":"provider","id":"openai","version":"profile@3"},
 "event":"provider.request.failed","msg":"provider request failed","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736",
 "span_id":"00f067aa0ba902b7","agent":"bernd","session":"s_01J…","turn":7,"task":"t_01J…","principal":"u_9f…",
 "duration_ms":1840,"err":{"code":"rate-limited","reason":"slow_down","retryable":true,"hint":"retry after 12 s"},
 "attrs":{"model":"gpt-5.5","provider_request_id":"req_…","http_status":429,"retry_after_s":12}}
```

| Field | Rule | OTel log data model |
|---|---|---|
| `ts` | RFC 3339 UTC, millisecond precision, writer clock | `Timestamp` |
| `level` | `trace\|debug\|info\|warn\|error\|fatal` (§2.6) | `SeverityText`; `SeverityNumber` derived |
| `source` | `{ kind, id, version }`, required on every record; `version` may be `null` when unknown (§2.3) | resource `service.name` = `plur1bus.<kind>`, `service.instance.id` = `id`, `service.version` = `version` |
| `event` | stable dotted code from the registered catalogue (§3); required | `event.name` |
| `msg` | harness-authored, constant per event (a template, no interpolated foreign text), ≤ 2 KiB | `Body` |
| `trace_id`, `span_id` | W3C ids, 32 / 16 lowercase hex (§2.8) | `TraceId`, `SpanId` |
| `agent`, `session`, `turn`, `task`, `principal` | harness ids; `principal` is the ADR-007 pseudonymous principal, never a name, email or channel handle | attributes |
| `duration_ms` | integer, operations with a span | attribute |
| `err` | `{ code, reason, retryable, hint }`: `code` from the closed harness enum (the RPC enum, D94 typed failures, provider classes `rate-limited\|overloaded\|auth\|invalid-request\|server\|timeout\|network`), `reason` a short machine token, `hint` harness-authored; foreign error text goes to `attrs.foreign_message` (untrusted, truncated, redacted) | `error.type` = `code` |
| `attrs` | event-specific, schema per catalogue entry, ≤ 8 KiB after redaction; LLM attributes use the OTel GenAI names at export (§2.5) | attributes |
| `stream` | only on wrapped child output: `stdout\|stderr` (§2.4) | attribute `log.iostream` |

Writers: Rust (`supervisor`, CLI, desktop) and TypeScript (core, modules) share one **`log-schema`** package — the record JSON Schema, the event catalogue, the level map and the redaction patterns as data — with a Rust/TypeScript parity test, the same pattern as `rpc-schema` (H1 criterion 7). All log files are created private to the user (`0600`, user+SYSTEM DACL on Windows, reusing `audit::create_private`), closing F4's Rust gap.

### 2.3 Sources

| `source.kind` | `source.id` (examples) | `version` |
|---|---|---|
| `harness` | `supervisor`, `core`, `engine`, `api`, `scheduler`, `module/<name>`, `cli` (the `plur1bus` CLI process) | harness version (engine: contract + pin) |
| `extension` | `plugin/<id>`, `skill-script/<skill>/<script>`, `mcp-server/<id>` | manifest version |
| `provider` | `openai`, `anthropic`, `jina`; `attrs.capability` = `chat\|embedding\|rerank\|oauth\|realtime` | profile catalogue revision |
| `model` | `ollama/<model>`, `llamacpp/<model>`, `mlx/<model>`, `transformers/<model>` (in-core ONNX) | model revision / server version |
| `cli` | `codex`, `claude-code`, `gemini`, `grok` (ACP or spawned) | reported binary version |
| `channel` | `telegram/<account>`, `discord/<account>`, … | channel module version |
| `host` | `helper`, `bridge` | helper version |
| `desktop` | `shell`, `controller`, `updater` | app version |
| `os` | `launchd`, `systemd`, `windows-scm`, `power` | OS name + version |

**Source keys** (for `logs.levels` and filters): `<kind>` or `<kind>:<id>`, `id` matched exactly or as a prefix at a `/` boundary (`extension:mcp-server` covers every MCP server). Regex: `^(harness|extension|provider|model|cli|channel|host|desktop|os)(:[a-z0-9][a-z0-9._@/-]{0,127})?$`.

**Attribution comes from the writer, not the line.** A process's own file attributes records to that process; the merging reader (`plur1bus logs`, viewer, bundle) checks each line's `source` against the file it came from and the event against the catalogue entries allowed for that source kind (§3.1). A mismatch is shown as `log.unattributed` with the original in `attrs` — a third-party module cannot write records that look like the supervisor's.

### 2.4 Third-party output is untrusted

Applies to every child the harness spawns whose code is not the harness's own: extension plugins and modules, skill scripts, MCP stdio servers (stderr; stdout is protocol and never logged), local model servers, CLI agents, the host helper's stderr, and the first-party children's stdout/stderr as well (one code path).

1. **Line assembly first.** The pump (F3) assembles lines across chunk boundaries before anything else, so redaction never sees half a secret; a partial line is flushed after 1 s idle; bytes past 4 KiB are discarded up to the next newline and counted (step 4).
2. **Wrap.** Each line becomes a record: `event: "process.output.line"`, `level: "info"`, `stream: "stdout"|"stderr"`, `source` = the child's, the line in `attrs.text`, `attrs.untrusted: true`. The text is never parsed for level, event, trace id or any field. A child that prints JSON gets its JSON as a string.
3. **Sanitise:** C0/C1 control characters except tab removed, ANSI/OSC escape sequences stripped (terminal injection through `plur1bus logs`), invalid UTF-8 replaced.
4. **Truncate** to 4 KiB (`attrs.truncated: true`, `attrs.bytes: <original>`).
5. **Redact** (§4).
6. **Rate-limit** per child stream: 100 lines/s sustained, burst 500; excess dropped and counted, one `process.output.suppressed` (`warn`) per window with the count.
7. **Level only from hard signals.** Unclassified stderr is `info`. `error` comes only from an exit code, a signal, an HTTP status, a typed protocol error (JSON-RPC/MCP/ACP error object, mapped to the closed `err.code`), or a harness typed error. Text such as `ERROR:` or `panic` never raises a level.
8. **Agents reading logs.** Log output that reaches an agent (the `plur1bus-ops` skill running `plur1bus logs`, a host-toolset `fs.read` of `logs/`, a future `logs.tail` tool) is **untrusted content under D109 §8**: it taints the turn, and text in it that claims an approval, an event or an instruction has no effect. `--json` keeps `attrs.untrusted` and `stream` on every wrapped line so a reader can tell harness facts from foreign text.

### 2.5 LLMs and models

- **Default: metadata only.** Per request: model, provider, `provider_request_id` (OpenAI `x-request-id`, Anthropic `request-id`, or the vendor's equivalent), tokens in/out/cache-read/cache-write, latency (TTFT and total), finish reason, `err.code`, `retryable`, rate-limit values (`limit`, `remaining`, `reset`, `retry_after_s`). At export these map to OTel GenAI attribute names (`gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.response.id`); the GenAI conventions are not stable, so the catalogue pins the names and the exporter maps them.
- The usage stream (§2.1) gets one row per request with the same metadata plus cost; diagnostic gets `provider.request.completed` at `debug` and failures at `warn`/`error` (§5).
- **Payload capture** (prompt and response content) is **opt-in per agent**, **time-limited** (default 60 min, maximum 24 h, then off by itself), **redacted** by the same writer, written only to `logs/payload.log` (`0600`, deleted 7 days after the window closes), never exported over OTLP, never in a bundle unless `--include-payload` is confirmed at a T3 surface. Enabling and disabling are audit events (`log.payload_capture.enabled|disabled`, who, agent, until). No log level — not even `trace` — ever includes content outside payload capture.

### 2.6 Levels

| Level | Meaning | OTel `SeverityNumber` | syslog (RFC 5424) |
|---|---|---|---|
| `trace` | step-by-step internals; **only for a limited time** | 1 (TRACE) | 7 debug |
| `debug` | developer detail, successful routine operations | 5 (DEBUG) | 7 debug |
| `info` | state changes a person may want to see; every skip with its reason (ADR-009) | 9 (INFO) | 6 informational |
| `warn` | degraded but self-healing, retrying, or a limit reached | 13 (WARN) | 4 warning |
| `error` | an operation failed and will not succeed without a retry decision or intervention, proven by a hard signal | 17 (ERROR) | 3 error |
| `fatal` | a process or service died | 21 (FATAL) | 2 critical |

- `core.logLevel` gains `trace` and `fatal` and becomes the **global default** for every source (§7 ruling R3).
- **Per source, live:** `logs.levels["provider:openai"] = "debug"`; resolution: exact `kind:id` > longest `/`-prefix > `kind` > `core.logLevel`. Applied through the existing `config.watch` live-applier path (ADR-013 §8) in the emitting process and in the supervisor's child wrapper; no restart.
- **`trace` is time-limited:** any `trace` value (global or per source) is valid only while `logs.traceUntil` is a future timestamp at most 24 h ahead; after it passes, every `trace` resolves as `debug` (config.json is not rewritten), `log.level.expired` is written once, and `1staid check` reports the stale entries. `plur1bus logs level <source> trace --for 30m` sets both keys.
- **`fatal` triggers the critical push:** each `fatal` record is handed to the harness notifier, which delivers through the same surfaces the engine's Critical Push uses (owner DM on a first-party channel from M4, desktop notification from D2); deduplicated to one push per source per 10 min. Until a delivery surface exists (M1b-2b), `fatal` is surfaced by `1staid check` (`logs.fatal.recent`) and `plur1bus daemon status`.
- **ADR-009 rule:** a skip, no-op or early return that changes a user-visible outcome is logged at `info` or higher with a reason code — never only at `debug`, never silently.

### 2.7 Redaction in the writer

Every stream, every writer, before the sink — call sites never redact and cannot opt out. Rules in §4.

### 2.8 Trace propagation

A trace starts where a request enters the harness (a channel message, a CLI command, an API request, a scheduler run, a desktop action) and follows it through core, engine, provider, tool, MCP, CLI agent and back.

| Hop | Carrier |
|---|---|
| RPC/IPC (NDJSON JSON-RPC, core ↔ supervisor ↔ modules ↔ CLI) | `params._meta.traceparent` (W3C `traceparent` string) and optional `params._meta.tracestate`, on requests and notifications; `rpc-schema` allows `_meta` on every params object (additive, rpc minor bump per ADR-016) |
| HTTP into the harness API (M3), between the person's own harnesses (D108, own A2A) | W3C `traceparent`/`tracestate` headers |
| Child processes (modules, skill scripts, MCP stdio servers, CLI agents, model servers) | env `TRACEPARENT` and `TRACESTATE` (the OpenTelemetry environment-carrier convention) set at spawn; ACP and MCP requests also carry `_meta.traceparent` |
| Channel → core | the channel module starts the trace for an inbound message and sends it over RPC |
| Outbound to third parties (LLM vendors, remote MCP servers, web fetch) | **not sent** — the provider request id is recorded instead (§7 ruling R9) |

An inbound `traceparent` from an unauthenticated or untrusted peer (public A2A, inbound MCP client, a web page) is not adopted: a new trace starts and the foreign id is kept as `attrs.link_trace_id`.

### 2.9 Operations

- **Rotation** by size stays (`logs.maxBytes`, `logs.keep`). **Retention by age** added: `logs.retentionDays.diagnostic` 14, `.audit` 0 = unlimited, `.activity` 90, `.usage` 400; pruned at start and daily by the process that owns the files (supervisor for `logs/`, core for SQLite tables). `audit.log` is size-rotated into `audit.log.<n>` but never pruned while `.audit` is 0; setting it above 0 is an Owner-only, audited change.
- **Dedup / storm suppression** in the writer: identical `(source, event, err.code, msg)` within 60 s writes the first record, counts the rest, and writes one summary record with the same event and `attrs.repeat` (all occurrences in the window, the first included) and `attrs.window_ms` — shown as "×340 in 60 s". `fatal` and audit records are never deduplicated (the push is, §2.6).
- **`plur1bus logs`** (foundation): reads the files directly, so it works with the core and supervisor down; merges all files including rotated ones by `ts`; filters `--source <key>` (repeatable), `--level <min>`, `--agent`, `--trace`, `--session`, `--event <glob>`, `--since <duration|ts>`, `--until`, `--stream diagnostic|audit|out|all`; `-f/--follow`; `-n/--lines`; `--json` emits records; human output escapes foreign text. Subcommands: `logs level <source> <level> [--for <dur>]`, `logs events` (the catalogue).
- **`1staid bundle`** (M8): a redacted diagnostic zip — last 3 days of diagnostic and out logs, `1staid check --json`, versions, platform, catalogue version, `config.json` with every `x-sensitive` value and every `logs.otlp.headers` removed; no audit (`--include-audit`), no payload, no transcripts, no store, no secret store. The bundle re-scans its own content with the §4 rules plus the secret-store values and refuses to write on a hit; written `0600` to a path it prints; never uploaded.
- **Log viewer** in the web UI (M3: Sessions/Logs/Audit page of ADR-004, SSE tail over `logs.tail`, RBAC: Owner/Admin/Operator, audit Owner/Admin) and the desktop app (D2), both rendering foreign text as plain text and meeting desktop spec §6.13 (keyboard, screen reader, contrast).

### 2.10 No telemetry

Nothing is sent anywhere by default and there is no vendor endpoint in the source. An **optional OTLP exporter** (`logs.otlp.*`, off by default) sends redacted diagnostic records (and, if listed, usage metrics) to a collector the person runs; enabling it needs an explicit `endpoint` set by the Owner, is an audit event, and has no shipped presets. Audit, payload and transcripts are never exported. The desktop app sends no analytics and no crash reports (handoff §3).

## 3. Event catalogue

### 3.1 Structure

`packages/log-schema/catalogue.json`, one entry per event, read by both writers and by the reader:

```json
{ "event": "provider.request.failed", "kinds": ["provider"], "stream": "diagnostic",
  "level": "error", "levelRule": "warn when err.retryable and a retry is scheduled",
  "msg": "provider request failed", "attrs": { "$ref": "#/attrs/provider_request" },
  "activity": false, "since": "D111", "stability": "stable" }
```

- **Name:** `<area>.<object>.<verb>` (2–4 lowercase segments, `[a-z0-9_]`, hyphens only in pre-D111 audit actions), regex `^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){1,3}$`. Names are stable API: renaming is a new event plus a deprecation, like an RPC method (ADR-016).
- **`kinds`** lists the source kinds allowed to emit it (the reader's attribution check, §2.3). `process.*` is emitted by the harness wrapper on a child's behalf and is allowed for every kind.
- **Unknown event:** debug and test builds throw; release builds write `log.unregistered` with the attempted name in `attrs`. A static test scans the TS and Rust sources for event literals and fails on any not in the catalogue.
- **Audit entries** carry `stream: "audit"` and the existing action names unchanged (`licence.accept-nc`, `setup.complete`, `repair.<step>`, `ext.*`).

### 3.2 Initial events

| Source kind | Events (default level; `→` = level rule) |
|---|---|
| writer (any) | `log.level.changed` (info), `log.level.expired` (info), `log.suppressed` (warn), `log.unregistered` (warn), `log.unattributed` (warn, reader-side), `log.retention.pruned` (info), `log.redaction.failed` (error: a redactor threw; the record is dropped, not written raw) |
| any child (wrapper) | `process.output.line` (info, `stream`), `process.output.suppressed` (warn) |
| harness: supervisor | `supervisor.process.started` (info), `supervisor.process.stopping` (info), `supervisor.process.exited` (info → error on a code other than the intended one; replaces F9's message match), `supervisor.child.spawned` (info), `supervisor.child.exited` (info planned → error unexpected → **fatal** for harness children, §5), `supervisor.child.restarting` (warn), `supervisor.child.given_up` (fatal), `supervisor.health.failed` (warn), `supervisor.health.hung` (error), `supervisor.adoption.completed` (info), `supervisor.config.applied` (info), `supervisor.config.rejected` (warn), `supervisor.subscriber.dropped` (warn) |
| harness: core | `core.process.started` (info), `core.process.ready` (info, `duration_ms`), `core.process.stopping` (info), `core.config.applied` (info), `core.config.fallback` (warn: reading `config.json` without a supervisor), `core.watch.lost` (warn), `core.orphan.detected` (warn), `core.rpc.failed` (error on `E_INTERNAL`/`E_STORAGE`; other enum codes debug) |
| harness: engine | `engine.status.degraded` (warn), `engine.status.failed` (error), `engine.recall.completed` (debug, `duration_ms`), `engine.recall.budget_exceeded` (warn), `engine.capture.failed` (error), `engine.acl.denied` (warn, §7 R11), `engine.model.loading` (info), `engine.model.ready` (info) |
| harness: scheduler | `scheduler.run.started` (debug), `scheduler.run.skipped` (**info**, reason code — ADR-009), `scheduler.run.completed` (info), `scheduler.run.failed` (error) |
| harness: api (M3) | `api.request.completed` (debug), `api.auth.failed` (warn), `api.rate.limited` (warn), `api.stream.dropped` (warn) |
| harness: module | `module.process.started` (info), `module.config.invalid` (warn), `module.core.connected` (info), `module.core.lost` (warn) |
| extension | `ext.load.failed` (error), `mcp.server.started` (info), `mcp.server.exited` (info planned → error unexpected), `mcp.server.timeout` (warn), `mcp.call.completed` (debug), `mcp.call.failed` (error on a typed error; warn on timeout with retry), `skill.script.exited` (info exit 0 → error non-zero/signal) |
| provider | `provider.request.completed` (debug), `provider.request.retrying` (warn), `provider.request.failed` (error → warn when retryable and retried), `provider.rate.limited` (warn), `provider.oauth.refreshed` (info), `provider.oauth.refresh_failed` (error), `provider.auth.expiring` (warn, D110 key expiry), `provider.payload.captured` (payload stream only) |
| model | `model.load.started` (info), `model.load.completed` (info, `duration_ms`), `model.load.failed` (error), `model.process.exited` (info planned → error unexpected), `model.memory.pressure` (warn, ADR-010 L7), `model.unloaded` (info) |
| cli | `cli.session.started` (info), `cli.session.exited` (info → error non-zero), `cli.acp.failed` (error, typed ACP error), `cli.login.required` (warn) |
| channel | `channel.connection.lost` (warn), `channel.connection.restored` (info), `channel.message.received` (debug, no content), `channel.message.sent` (debug), `channel.delivery.failed` (error → warn when retried), `channel.rate.limited` (warn) |
| host | `host.helper.connected` (info), `host.helper.lost` (warn), `host.call.denied` (warn), `host.signature.invalid` (error), `host.bridge.failed` (error) |
| desktop | `desktop.app.started` (info), `desktop.app.crashed` (fatal, written at the next start from the crash file), `desktop.connection.lost` (warn), `desktop.webview.failed` (error), `desktop.update.failed` (error), `desktop.deeplink.ignored` (info, no arguments) |
| os | `os.service.installed` (info), `os.service.restarted` (warn), `os.service.failed` (fatal), `os.power.resumed` (info) |
| audit (stream) | existing: `licence.accept-nc`, `setup.complete`, `repair.<step>`, `ext.install\|enable\|disable\|uninstall\|purge\|restore`; new: `config.set` (key, class, old/new value — `x-sensitive` values redacted), `module.install\|uninstall`, `secret.create\|rotate\|delete` (ADR-005), `auth.login\|logout` (profile id), `log.payload_capture.enabled\|disabled`, `logs.otlp.enabled\|disabled`, `logs.retention.changed`; D109 mirror: `approval.requested\|decided`, `grant.created\|revoked\|expired`, `policy.denied`, `approvals.integrity_failed`; M3: `device.paired\|revoked`, `user.break_glass` |

## 4. Redaction rules

Applied by the writer to `msg`, `attrs`, `err`, wrapped `attrs.text` and audit `detail`, in this order; the replacement is `[REDACTED:<rule>]` so a reader sees that something was removed and why.

1. **Known secret values (`secret`).** Each process registers the exact secret-store values and leases it holds (ADR-005), ≥ 8 characters, plus their base64 and URL-encoded forms; any occurrence is replaced. The registry lives in memory only, in the process that already holds the value.
2. **Keys by name (`key`).** A JSON key or `key=value` / header whose name matches `(?i)authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|client[_-]?secret|refresh|code_verifier|ticket|csrf|id_token_hint|private[_-]?key|session[_-]?key` has its value replaced.
3. **Patterns (`pattern`).** `Bearer\s+\S+`, `Basic\s+[A-Za-z0-9+/=]+`; vendor key shapes (`sk-…`, `sk-ant-…`, `sk-proj-…`, `ek_…` (D110), `ghp_…`, `github_pat_…`, `xox[abpr]-…`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`); JWTs (`eyJ…\.eyJ…\.…`); PEM private-key blocks; `PLUR1BUS_*` env values; base64url runs of ≥ 43 characters **unless the run is pure hex** (SHA-256, git ids and the extension audit's `sha256` must stay readable).
4. **URLs (`url`).** Query values and the fragment are replaced, parameter names kept (`?code=[REDACTED:url]&state=[REDACTED:url]`); userinfo (`user:pass@`) removed. Authorization URLs are redacted before any log line (D110 §2.5 item 7).
5. **D109 deny-list paths (`path`).** A path that canonicalises under a credential deny-list entry (D106/D109: keychains, `~/.ssh`, `~/.gnupg`, browser profiles, password managers, cloud-CLI credentials, `.env`/token files, the D110 additions) is replaced by the entry class and a short hash: `<deny:ssh>/…#3f9a1c`.
6. **Optional PII (`pii`).** Email addresses and phone numbers (E.164 and common national formats) when `logs.redactPii` is `true`; default `false`.
7. **Never logged at all** (not redacted — not written): response bodies and fetched content (D94), file contents and tool results (D109 §9), transcripts, panel page content and URLs (desktop §6.9), payloads outside payload capture.

A redactor that throws drops the record and writes `log.redaction.failed` with the event name only; a record is never written unredacted.

## 5. Level policy per source

General rule: `warn` = degraded, retrying, self-healing or a threshold reached; `error` = failed, proven by a hard signal, needs a retry decision or a person; `fatal` = died.

| Source | warn | error | fatal |
|---|---|---|---|
| harness: supervisor/core/module/channel modules | health check missed, restart scheduled, config rejected, watch lost, fallback to file, subscriber dropped | unexpected RPC `E_INTERNAL`/`E_STORAGE`, hung child, failed config apply | the process exited unexpectedly (crash, signal, unintended code) — **immediately**, even when a restart follows; restart given up |
| harness: engine/scheduler | degraded status, budget exceeded, ACL denial | capture/recall failure, job failure | — (the core's death covers it) |
| extension (plugin, skill script, MCP server) | timeout with retry, output suppressed, slow start | non-zero exit, signal, typed protocol error, load failure | supervisor gave up restarting it |
| provider | 429/503 with retry, retry scheduled, key or token expiring, rate limit near | non-retryable 4xx, 5xx after retries, auth or refresh failure, network failure after retries | — |
| model (local) | memory pressure, LRU unload, slow load | load failure, unexpected exit | restart given up |
| cli | login required, slow start | non-zero exit, typed ACP error | — |
| channel | connection lost (reconnecting), rate limited, delivery retried | delivery failed for good, auth revoked | channel module died (harness tier) |
| host | helper not connected, call denied by the helper's own switch | signature invalid, bridge failure | — |
| desktop | connection lost, update deferred | webview failure, update failure | app crashed (recorded at next start) |
| os | service restarted by the service manager | — | service failed / will not start |
| any wrapped child output | — (never from text) | — (never from text) | — (never from text) |

## 6. Owner decisions (as decided 2026-10-01)

The owner answered "Ja" to the proposal; every item is binding and implemented as written above.

| # | Decision | Where |
|---|---|---|
| 1 | Five separate streams: diagnostic, audit (extends `logs/audit.log`, `0600`, append-only), activity, usage/metrics (feeds ADR-010), transcripts (store only, never logs) | §2.1 |
| 2 | Levels `trace, debug, info, warn, error, fatal`, extending `core.logLevel`; OTel and syslog mapping; `trace` time-limited; `fatal` = died and triggers the critical push; per-source live levels `logs.levels[...]` | §2.6 |
| 3 | Source kinds harness, extension, provider, model, cli, channel, host, desktop, os; `source{kind,id,version}` on every record | §2.3 |
| 4 | Third-party output untrusted: wrapped with `stream`, truncated, redacted, rate-limited; level never from foreign text; no forged event codes; applies when agents read logs (D109 §8) | §2.4 |
| 5 | LLM metadata only by default; payload capture opt-in per agent, time-limited, redacted, its switch audited | §2.5 |
| 6 | JSONL with OTel-aligned fields and a registered event catalogue; `trace_id` across processes (RPC/IPC, HTTP W3C, env) | §2.2, §2.8, §3 |
| 7 | Redaction in the writer: secret-store values, token/header/key patterns, deny-list paths; email/phone optional; ADR-005 action 8 test over all outputs | §4, §8 |
| 8 | Size rotation kept; retention by days; dedup; `plur1bus logs`; `1staid bundle`; web/desktop viewer later | §2.9 |
| 9 | No telemetry; optional OTLP to the person's own collector, off by default | §2.10 |
| Defaults | **diagnostic 14 days · audit unlimited · payload capture 60 min then off · OTLP export off** (with email/phone redaction off) | §2.1, §2.5, §2.10, §4 |

No owner question is open. Rulings in §7 that change an earlier document are listed with that document in §10.

## 7. Rulings

- **R1 — `at` vs `ts`.** Ruling: diagnostic records switch to `ts` and `source`; every reader (`plur1bus logs`, the viewer, the bundle, `1staid repair`) accepts the legacy `{ at, role }` shape (`at` as an ISO string or epoch milliseconds; `role` `supervisor`/`core`/`module-<n>` → `harness:supervisor`/`harness:core`/`harness:module/<n>`). The audit log **keeps `at` and its v1 fields** (`at` epoch ms, `actor`, `action`, `target`, `detail`) and the reader aliases `at` → `ts`, `action` → `event`, `actor` → `principal`; D111 only adds optional fields to new audit lines (`v: 2`, `source`, `trace_id`, `agent`, `session`, `task`, `surface`, `store_ref`). — why: diagnostic files age out in 14 days, so OTel naming costs one release of dual reading; the audit file is append-only and unlimited, so a rename would leave two formats in one file forever and break `plur1bus approval audit`, the ADR-007 export and the HB12 tests for no gain. — cost: two timestamp names in the tree and a reader that knows both; `service.silent-exit` must move from the message text to `supervisor.process.exited` (F9).
- **R2 — D109's store stays the authority; `audit.log` mirrors it.** Ruling: every D109 audit event is written to the HMAC-chained store first, then mirrored as one redacted `audit.log` line carrying `store_ref` (row id and chain value). The store keeps D109's 400-day retention; the mirror lines follow `logs.retentionDays.audit` (unlimited). — why: the owner's "audit log includes D109 grants" and D109's tamper evidence are both kept; one file shows the whole who-did-what history. — cost: two copies of approval metadata; a mirror write failure is retried and reported by `1staid check audit.mirror`, never blocks the decision.
- **R3 — `core.logLevel` becomes the global default.** Ruling: the key keeps its name and class and becomes the default level for every source in every process (supervisor, core, modules, wrapper); `logs.levels` overrides. — why: renaming means a `schemaVersion` migration for a cosmetic gain, and F2 shows the per-process gap is the real bug. — cost: the name reads as core-only; ADR-013 and `docs/config.md` say otherwise.
- **R4 — `trace` expiry is a separate key, enforced at resolution.** Ruling: `logs.traceUntil` (≤ 24 h ahead) gates every `trace`; expiry downgrades to `debug` without rewriting `config.json`. — why: no writer of `config.json` other than the supervisor and the CLI (ADR-013 §5), and a timed rewrite would race the person's edits. — cost: a stale `trace` entry stays in the file until removed; `1staid check` reports it.
- **R5 — `fatal` tiers.** Ruling: an unexpected death of a harness-tier process (supervisor, core, first-party and channel modules) or OS service failure is `fatal` immediately; an extension, model server or CLI agent dying is `error` and becomes `fatal` only when the supervisor gives up restarting it; pushes are deduplicated per source per 10 min. — why: a third-party MCP server crash is not the harness dying, and pushing on every one trains the person to ignore pushes. — cost: a crash-looping extension pushes only after the give-up threshold.
- **R6 — Critical push reuses the delivery, not the engine semantic.** Ruling: `fatal` goes to a harness notifier that delivers through the surfaces the engine's Critical Push uses (F11); until one exists, `1staid check` and `daemon status` show recent fatals. — why: the engine's `pushCriticalButtons` is a memory-card capability with accept/reject buttons; overloading it would mix alerts into memory review. — cost: in M1b-2b nobody is pushed; the first real push arrives with M4 channels or D2 notifications.
- **R7 — Attribution from the file, not the line.** Ruling: a record's `source` is checked against the file it was read from and its event against the catalogue's `kinds`; mismatches show as `log.unattributed`. — why: module and plugin code runs with the OS user's authority (module-guide §9) and can write anything into its own file; per-file provenance is the only check that needs no central log daemon. — cost: a reader-side check instead of a write-side guarantee; a hostile module can still flood its own file (size rotation bounds it).
- **R8 — Child output becomes structured.** Ruling: `logs/<role>.out.log` keeps its name but holds wrapped D111 records instead of raw bytes. — why: one reader, one redaction path, no second format to scan; the name stays so `plur1bus-ops` and the playbooks keep their file map. — cost: `tail -f core.out.log` shows JSON; `plur1bus logs --stream out` is the human view; the skill text changes with the implementation.
- **R9 — No trace context to third parties.** Ruling: `traceparent` is never sent to LLM vendors, remote MCP servers, web fetches or untrusted peers; the provider request id is the correlation. — why: a stable per-request id in a vendor's logs is telemetry by another name (§2.10), and the vendor's own request id already lets a support case be matched. — cost: no cross-vendor distributed trace; correlation is local only.
- **R10 — Event names are stable API.** Ruling: the catalogue is versioned with `log-schema`; renames are new events with a deprecation window. — why: `1staid repair`, the skill, saved filters and OTLP dashboards key on them. — cost: careful naming up front; mistakes linger one deprecation cycle.
- **R11 — ACL denials are diagnostic, break-glass is audit.** Ruling: the engine's ACL denials (ADR-007's `logViolations`) are `engine.acl.denied` at `warn` in the diagnostic stream (14 days, dedup), not audit lines; break-glass access, shares and erasure tombstones are audit. — why: a denial is a refused read, not a privileged action, and can be high-volume; ADR-002 Q6 asked for retention and rotation, which the diagnostic stream supplies. — cost: denials older than 14 days are gone; Q6's 30-day proposal is not adopted.
- **R12 — Retention of the non-default streams.** Ruling: activity 90 days, usage 400 days (matches D109's audit retention and covers a year of budget history), payload 7 days after the capture window. — why: the owner fixed diagnostic and audit only; these follow their consumers. — cost: three more defaults to document.
- **R13 — Rate limit and truncation numbers.** Ruling: 100 lines/s sustained, burst 500 per child stream; line 4 KiB, `msg` 2 KiB, `attrs` 8 KiB; dedup window 60 s. — why: a chatty MCP server or model server must not fill 20 MiB in seconds and rotate away the evidence. — cost: a genuinely verbose child loses lines (counted).
- **R14 — Two added keys.** Ruling: besides the keys the owner named, D111 adds `logs.traceUntil` (R4) and `logs.redactPii` (§4 rule 6). — why: both are the switches the owner's own items need ("trace for a limited time", "email/phone optional"). — cost: two more advanced-tier keys.
- **R15 — Foundation first in M1b-2b.** Ruling: writer, schema, catalogue, redaction, source wrapping, per-source levels, retention, dedup, RPC trace propagation and `plur1bus logs` land as the first M1b-2b plan, before D109 and D106 code. — why: D109 and D106 both write audit and diagnostic lines and both read foreign output; building them on the old logger means migrating them twice. — cost: M1b-2b grows by 4–6 ad before its first tool runs.

## 8. Tests and acceptance

1. **Schema:** every record from every writer validates against the `log-schema` record schema with the fixed key order; Rust/TS parity on schema, catalogue, levels and redaction data.
2. **Catalogue:** the static scan finds no unregistered event literal; an unregistered event throws in tests and writes `log.unregistered` in release.
3. **Levels:** OTel and syslog mapping table test; per-source resolution precedence; `logs.levels["provider:fake"]="debug"` takes effect within one `config.changed` and is undone the same way, no restart; `trace` without a future `logs.traceUntil`, or more than 24 h ahead, is rejected; an expired `traceUntil` resolves `trace` as `debug` and writes `log.level.expired` once; module processes follow `core.logLevel` (closes F2).
4. **Foreign output** (a fixture child): forged JSON `{"level":"fatal","event":"supervisor.child.given_up"}`, `ERROR:` text, ANSI/OSC escapes, a 1 MiB line, 10 000 lines/s, a secret canary split across an 8 KiB read boundary → `process.output.line` records at `info` with `stream`, escapes stripped, truncated with `bytes`, one `process.output.suppressed` with the drop count, the canary redacted, **no** `fatal` record and **no** push.
5. **Hard signals:** exit 0/1/signal, HTTP 200/429/500 and a typed MCP error produce exactly the levels of §5.
6. **Redaction over all outputs** (ADR-005 action 8, extended; D110 §5 test 5): planted canaries — one per §4 pattern, a registered secret-store value with its encodings, an authorization URL, a deny-list path, an email (with `redactPii` on and off), an `ek_` value, a PEM key — driven through a scripted scenario touching every source; then a grep over `logs/*` (diagnostic, out, audit, payload), `--json` output of every command, RPC error responses, the bundle, OTLP export payloads (fake collector), desktop logs and crash files finds **zero** canaries; SHA-256 values in `ext.install` audit lines survive.
7. **Dedup:** 340 identical records in 60 s → the first record + one summary with `attrs.repeat: 340` (all occurrences in the window, the first included) and `attrs.window_ms: 60000`; `fatal` and audit are never deduplicated.
8. **Retention:** diagnostic files older than 14 days pruned at start and daily; audit never while `.audit` is 0; payload 7 days after the window; `log.retention.pruned` written.
9. **Audit:** v1 lines still parse; new lines are v2 with the added fields, `0600`, fsynced, append-only; `config set` writes `config.set` with `x-sensitive` values redacted; payload-capture and OTLP switches are audit lines; D109 mirror lines carry `store_ref` and a mirror failure is reported by `1staid check`.
10. **Trace propagation:** CLI → supervisor → core → module RPC share one `trace_id`; a spawned child sees `TRACEPARENT`; a fake channel → core → fake provider shares the trace; outbound requests to the fake provider carry **no** `traceparent`; an unauthenticated inbound `traceparent` is not adopted.
11. **Fatal:** `kill -9` of the core → one `fatal`, one notifier call, then the restart; ten crashes in 10 min → one push; an extension crash → `error`, its give-up → `fatal`.
12. **`plur1bus logs`:** works with supervisor and core stopped; merges rotated files and legacy `{ at, role }` lines by time; every filter; `--json`; control characters never reach the terminal; `logs level … --for 30m` sets `logs.levels` and `logs.traceUntil`.
13. **No telemetry:** with default config, no outbound connection from any logging code path (network-isolated test); the OTLP exporter refuses to start without an explicit endpoint; a static check finds no vendor endpoint or preset in the source.
14. **ADR-009:** every scheduler skip fixture produces a `scheduler.run.skipped` at `info` with a reason.
15. **Idle noise:** an idle harness at `info` writes at most one diagnostic line per minute (health polls are `debug`).
16. **Agents** (with D109): a turn whose tool result contains `plur1bus logs` output is tainted; a forged approval line in a child's output has no effect.

**Acceptance (foundation):** tests 1–10, 12–15 green on the five CI targets; the old logger and the raw pump are gone; `1staid repair`'s `service.silent-exit` keys on `supervisor.process.exited`; `skills/plur1bus-ops` documents the new file contents and `plur1bus logs`. **Later parts:** test 11's push leg with M4/D2, 16 with D109, the viewer a11y pass with M3/D2, the bundle and OTLP legs of test 6 with M8.

## 9. Placement and effort

| Part | Milestone | Effort (ad) |
|---|---|---|
| **Foundation:** `log-schema` (record schema, catalogue, levels, redaction data, parity) · Rust and TS writers (ts/source/event, per-source levels, `trace` expiry, redaction, truncation, dedup, retention, `0600`) · child wrapping in the pump · audit v2 fields, `config.set` audit · RPC `_meta.traceparent` · schema keys and live appliers · `plur1bus logs` · redaction test over the foundation's outputs | **M1b-2b, first plan, before D109/D106** | **4–6** |
| Provider/model/CLI events, the usage table for ADR-010 budgets, payload capture, HTTP and env/ACP trace propagation | M2 (CLI/ACP legs with M6) | 2–3 |
| Activity feed, `logs.tail` RPC + SSE, web log viewer (Sessions/Logs/Audit), RBAC | M3 | 2–3 |
| `1staid bundle`, OTLP exporter | M8 | 1–2 |
| Desktop log viewer; desktop records already follow D111 from WP6 (handoff amendment) | D2 | 1 (not in the total) |

**Total +9–14 ad in the v0.1.0 total** (M1b +4–6, M2 +2–3, M3 +2–3, M8 +1–2), plus 1 ad in track D.

## 10. Conflicts with existing documents, and how they are resolved

| Document | Conflict | Resolution |
|---|---|---|
| `audit.rs` vs `supervisor/mod.rs` / `logger.ts` | `at` is epoch ms (number) in the audit log and an ISO string in the diagnostic logs | R1: the reader accepts both; audit keeps `at`, diagnostic moves to `ts` |
| D109 §9 | approval audit lives in the store, 400 days, read by `plur1bus approval audit`; the owner's proposal puts D109 grants in the unlimited audit log | R2: store authoritative, mirrored into `audit.log` |
| ADR-002 Q6, ADR-007 action item 6 (PLUR1BUS PR #4) | proposed ACL audit retention 30 days or 50 MB in an engine `acl-audit.jsonl` | R11: ACL denials are diagnostic (14 days); break-glass and shares are audit |
| `module-api/src/runtime.ts:235`, `supervisor/mod.rs` `Log` | modules hard-code `info`; the supervisor has no level filter; ADR-013 says `core.logLevel` is live without saying it is core-only | R3: one global default, per-source overrides |
| `logfile.rs` `append` | Rust log files use the umask; TS files are `0600` | §2.2: every log file private |
| `child.rs` `pump`, `skills/plur1bus-ops` | raw out logs | R8 |
| `repair/risky.rs` (`service.silent-exit`) | matches message text in `supervisor.log` | the event `supervisor.process.exited` replaces the text match |
| E3 plan (`pushCriticalButtons`) | "critical push" is a memory-card capability | R6 |
| D110 | names no provider request id | §2.5 adds `provider_request_id` to the metadata set |
| handoff §4.2 "Logs" | base64url ≥ 43 would redact SHA-256 hex in shared records | §4 rule 3 exempts pure-hex runs; the handoff amendment says so |
| `docs/config.md`, `config.schema.json` | `logs` is `additionalProperties: false`; `docs/config.md` is generated | the schema change ships with the foundation; ADR-013 §2 lists the keys as "planned, D111" until then |
