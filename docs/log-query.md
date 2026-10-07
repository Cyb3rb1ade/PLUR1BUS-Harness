# Log query RPC: `logs.query`, `logs.tail`

Status: D4 (2026-10-07), experimental since RPC 1.5.0. Code: `packages/core/src/logs/`. Spec: D111
(`docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md` §2.1, §2.2, §4). Plan:
`docs/superpowers/plans/2026-10-07-d4-logs-rpc.md`. Method shapes are in the generated `docs/rpc.md`.

Both methods are **read-only** views over the protected files in `<home>/logs/` and are served by the core. RBAC action
`logs.query` (Owner and Admin only; `docs/rbac.md`), for both streams.

## What is read

| Stream | Files | Component |
|---|---|---|
| `diagnostic` (default) | `<role>.log` and rotated `<role>.log.<n>`, `<role>.out.log` (wrapped child output) | the file's role (`core`, `supervisor`, `hermes.out`, …) |
| `audit` | `audit.log` and rotated copies | `audit` |

`payload.log` (opt-in payload capture, D111 §2.5) is never served. Symlinks and non-regular files in the directory are
skipped. Lines are read in the current harness shape (`at`, `role`) and the D111 shape (`ts`, `source`, `event`); `at` is
normalised to `ts` (millisecond precision, UTC).

## Filters

`from`/`to` (inclusive), `minLevel` (not for `audit`), `component` (the file role, a record's `source.id` or `source.kind`; on
`audit` the action's first segment), `text` (case-insensitive substring), `limit` (1–1000, default 100), `order`
(`desc` default, `asc`), `cursor`. All filters combine with AND.

## Reading rules

* **Streaming.** Files are read in 64 KiB chunks through a file descriptor, forward or backward, and located by a
  binary search on the timestamp. A page of the newest records of a 60 MiB file reads well under 1 MiB
  (`test/logs/query.test.ts`). A per-call scan budget (128 MiB) ends a search that finds nothing: `truncated: true` and a
  cursor that continues.
* **Half last line.** An unterminated last line is the writer's line in flight and is ignored, not counted.
* **Corrupt lines** (not JSON, no valid timestamp, invalid level, over 256 KiB) are counted in `corrupt`, never fatal.
* **Rotation.** Every file of the stream is opened first and checked against its path (retried up to three times), so a
  rotation during the read neither duplicates nor skips a line. The cursor is `(ts, hash of the line)`, not a file name
  or offset, so it survives rotation and appends. Lines with the same `ts` are ordered by their hash.
* **Cursor** is opaque and bound to its filters and order: another filter set is `E_INVALID_PARAMS reason=cursor-mismatch`,
  a malformed one `bad-cursor`.

## Redaction

Every record is redacted again on the way out from `@plur1bus/log-schema`'s `redaction.json` (keys by name, credential
shapes, URLs, deny-list paths; `pii` only when enabled): `[REDACTED:<rule>]`. The `text` filter matches the *redacted*
record, so a search cannot confirm a secret. The writer's own redaction stays the first line of defence.

## `logs.tail`

Without a cursor: the newest `limit` matches, oldest first, and a cursor anchored at the newest line looked at (a match or
not). With a cursor: the matches after it, in order. `waitMs` (≤ 30 s) holds the call until a match arrives; the connection
closing or the core stopping ends it. Poll in a loop, passing back the `nextCursor` each time. A push stream would need
per-connection notifications, which the shared RPC server does not have (see the PR's open points).
