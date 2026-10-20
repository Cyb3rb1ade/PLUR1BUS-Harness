# Audit chain (B5)

A tamper-evident copy of the core's audit events. It sits **next to** `logs/audit.log` and does not replace it:
`audit.log` keeps the D111 record shape and has several writers (the Rust CLI, the core's RBAC sink, the identity
writer, the secret store); the chain wraps the unchanged record.

## Files (`<home>/logs/`)

| File | What |
|---|---|
| `audit-chain.jsonl` | the active chain file |
| `audit-chain.<firstSeq:10>.jsonl` | a rotated file (rotation by size, 8 MiB, or `rotate()`) |
| `audit-chain.anchor` | `{"v":1,"seq":N,"hash":"…"}`, replaced atomically after every append |
| `audit-chain.lock` | OS lock (module-api `acquireExclusiveLock`) serialising writers and the verifier |
| `audit-chain.jsonl.torn-<ms>` | bytes of a crashed, unterminated write, set aside by the next append |

All are private to the user (0600, Windows ACL via the host's `securePath`).

## Line format

```json
{"seq":4,"prev":"<sha256 of the previous line>","rec":{"at":…,"actor":{"user":"…","host":"…"},"action":"…","target":"…","detail":{…}}}
```

The hash covers the line's UTF-8 bytes without its terminator, so a CRLF copy of the file verifies the same. The
first line has `prev` = 64 zeros and `seq` 1. After rotation the first line of the new file chains to the last hash
of the old one and `seq` carries on.

## What `audit.verify` finds

`plur1bus audit verify` (RPC `audit.verify`, Owner and Admin, RBAC action `audit.read`, read-only on the log; exit 1
when anything is wrong).

| Finding | Meaning |
|---|---|
| `hash-mismatch` | a line does not chain to the one before it: the earlier line was changed, or lines were removed or inserted |
| `seq-gap` | sequence numbers are not gapless (a deleted line or a missing rotated file) |
| `prefix-missing` | the oldest file present does not start at the genesis hash (the oldest file was removed) |
| `file-name-mismatch` | a rotated file's name does not match the `seq` of its first line |
| `line-malformed` | a line is not a chain line |
| `torn-tail` | an unterminated last line |
| `truncated` | the chain is shorter than the anchor (lines cut off at the end, or files removed) |
| `anchor-mismatch` | the line at the anchor's `seq` has a different hash (the newest line was changed) |
| `anchor-missing`, `anchor-invalid` | the anchor was removed or damaged |

Findings carry file name, line and `seq`, never record content. `anchor.status` `behind` (the anchor trails by one
write that crashed before the anchor moved) is not a finding.

## Writers

The core tees its RBAC sink, identity audit writer and sanitized secret-store records into the chain. Secret records keep their nullable target; no secret value is added to either audit file.

The supervisor's `config.set` writes its `audit.config.set` rows (one per changed `x-audit` key, before `config.json` is replaced) through the same Rust writer (`audit::append_as`, `actor` = the authenticated person), so each row is a chain line and the identical `audit.log` line; the field-based `[REDACTED]` of sensitive config values is applied before the append. A chain that refuses the append does **not** fail the config set; only a failed `audit.log` write does (see [Config saves never wait for the chain](#config-saves-never-wait-for-the-chain)).

The Rust CLI writes directly, including while the core is stopped (setup, repair, backup, uninstall and extensions). It uses the same line envelope, SHA-256 bytes, anchor and 8 MiB rotation names. The core holds a SQLite `BEGIN EXCLUSIVE` OS lock on `audit-chain.lock`; Rust holds the corresponding pending/reserved/shared byte range (`0x40000000`, 512 bytes), using `fcntl` on Unix and `LockFileEx` on Windows. A Rust process mutex also serializes its own threads because POSIX record locks belong to a process. No SQLite database contents are changed by Rust. The kernel releases either lock when its process exits. Direct writes keep offline operations independent of RPC authentication and core availability. Every writer except the config audit **fails closed**: it refuses to
append when the anchor is missing or invalid, when the chain is shorter than the anchor, or when the tail does not
match the anchor (including an anchor behind the tail), so tampering is never papered over by new lines (the config audit queues its lines instead of appending them, see below). The recovery is manual: move the chain files and
the anchor aside (keep them as evidence) and start a new chain.

## Config saves never wait for the chain

`config.set` is something a person does, and saving a configuration safely must always be possible (owner decision 20.10.). The
other callers of `audit::append` (setup, repair, backup, uninstall, extensions, updates) record machine events, so they stay
fail-closed: a refused append is an error there, as above. Only the supervisor's config audit (`audit::append_as_degrading`)
degrades, and only on a refusal:

| What fails | `config.set` |
|---|---|
| `audit.log` cannot be written (I/O error, disk full) | fails (`E_INTERNAL`), `config.json` is not written: fail-closed for the log, as always |
| the chain fails for a storage reason (not a refusal) | fails, as above |
| only the chain **refuses** (`anchor-missing`, `anchor-invalid`, `chain-shorter-than-anchor`, `tail-anchor-mismatch`, `tail-malformed`, `sequence-exhausted`, `rotation-target-exists`, `lock-timeout` after 5 s) | the configuration is saved |

When only the chain refuses, the chain and its anchor are not touched (tampering is not papered over) and:

1. The redacted line still goes to `audit.log`, with the extra fields `chain: "refused"` and `chainReason` (one of the codes above, never content).
2. The same line (byte for byte) is appended to the pending journal `logs/audit-chain.pending.jsonl` (0600, fsynced). It keeps at most
   10,000 lines and 8 MiB; beyond that the oldest lines are discarded, counted in a first line `{"pendingDropped":N}`, and noted in
   `audit.log` as `audit.chain.pending_overflow` (`dropped`, `limitLines`, `limitBytes`).
3. The `config.set` result carries `warnings: ["audit-chain-unavailable"]` (the CLI prints it), and the supervisor log an `error` line
   with the reason, the number of rows and whether they are queued. `daemon.status` has no audit or health section, so it shows nothing.

`audit::drain_pending` runs after every successful append (when there is no journal, that is one `stat`). Once the chain accepts
appends again (after the anchor is restored, for example), it appends the queued lines to the chain in their original order,
with their original time (`at`) in `rec` and their `chain: "refused"` fields, so the chain line is still the exact `audit.log` line, and
then records `audit.chain.pending_drained` with `count`, `dropped` (lines the limit discarded) and `skipped` (unreadable lines). Lines
are appended in batches of 100 under one lock and one anchor update. The journal is cleared only for lines the chain took: a crash
between the chain write and the clearing can chain a line a second time, never lose one. While the chain still refuses, a drain
changes nothing. A drained line is chained late, not backdated: it sits after the line that triggered the drain, and its own time is `rec.at`.

`audit-chain.pending.jsonl` is not part of the chain: `audit.verify` does not read it, and lines waiting in it are not tamper-evident until they
are drained. A reporting gap while the chain is refused is the price of never blocking the person saving a configuration.

## What it does not protect

- Someone who can write both the chain and the anchor can rewrite the whole chain consistently. Pin `lastHash` and
  `lastSeq` from `audit.verify` somewhere the host cannot write (another machine, a ticket) to cover that.
- A last line changed in the one-write window before the anchor moves is not caught until the next append.
- Historical audit.log records written before D1 are not backfilled into the chain.
- `audit.log` and the chain are separate files, so a storage failure can leave an event in only one copy. The secret-store operation reports failure. Rust callers keep their existing error handling; some update/uninstall paths treat audit errors as best effort.

## Testabdeckung und bekannte Lücken

- **The chain** (append, `audit.verify`, rotation, torn tail, anchor) is written and tested in `packages/core` (`test/audit/`). The Rust
  CLI also writes the chain directly. Shared UTF-8/hash/CRLF/null-target vectors live in `tests/fixtures/audit-chain-v1.json`. A Rust test runs three Rust and three TypeScript child processes against one home, verifies all 180 records through the TypeScript verifier, then changes a line and checks the finding. This runs on the test host; local macOS execution is not native Windows/Linux evidence.
- **The two Rust appenders** that sit next to it, `logs/audit.log` (`crates/plur1bus/src/audit.rs`) and the offline memory journal
  (`src/journal.rs`), are tested for append-only writes (no earlier byte is rewritten), one physical line per entry whatever the content,
  eight concurrent writers without interleaved lines, private permissions, and a last line left torn by a crash: the next entry now starts
  a line of its own instead of being glued to the fragment.
- **Known gaps:** `detail` is written as given: secrets inside it are not redacted by the chain (not yet enforced; redaction belongs to the event producers in rbac and identity). Neither `audit.log` nor the journal rotates. Both chain writers use the same rotation contract.
