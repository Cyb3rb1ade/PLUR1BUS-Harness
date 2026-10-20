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
| `anchor-behind` | the tail has a complete line beyond the anchor: interrupted append/anchor persistence or tampering; manual investigation required |
| `pin-missing`, `pin-mismatch` | the externally supplied sequence is absent or its line has a different hash |

Findings carry file name, line and `seq`, never record content. `anchor.status` `behind` is an explicit `anchor-behind` finding and makes `ok` false, including after reopening the chain. Core startup logs the findings without record content and leaves verification available for diagnosis. The verifier never advances an anchor to hide the disagreement.

## Writers

The core tees its RBAC sink, identity audit writer and sanitized secret-store records into the chain. Secret records keep their nullable target; no secret value is added to either audit file.

The Rust CLI writes directly, including while the core is stopped (setup, repair, backup, uninstall and extensions). It uses the same line envelope, SHA-256 bytes, anchor and 8 MiB rotation names. The core holds a SQLite `BEGIN EXCLUSIVE` OS lock on `audit-chain.lock`; Rust holds the corresponding pending/reserved/shared byte range (`0x40000000`, 512 bytes), using `fcntl` on Unix and `LockFileEx` on Windows. A Rust process mutex also serializes its own threads because POSIX record locks belong to a process. No SQLite database contents are changed by Rust. The kernel releases either lock when its process exits. Direct writes keep offline operations independent of RPC authentication and core availability. A writer **fails closed**: it refuses to
append when the anchor is missing or invalid, when the chain is shorter than the anchor, or when the tail does not
match the anchor (including an anchor behind the tail), so tampering is never papered over by new lines. The recovery is manual: move the chain files and
the anchor aside (keep them as evidence) and start a new chain.

## Durability and an external pin (D2)

The writer keeps the OS lock through the line fsync, temporary-anchor fsync, atomic anchor replacement and POSIX directory fsync. Rotation also fsyncs the directory. Torn-tail evidence is flushed before truncating the interrupted bytes. These steps do not make two files a single atomic filesystem transaction: a process interrupted between them can still leave a discrepancy, which verification reports explicitly instead of silently accepting it.

**Windows known gap:** file contents are flushed, but portable Node does not provide a guaranteed directory-entry flush. A native host capability is still needed for equivalent power-loss durability on Windows. The same limit is explicit in the Rust writer; neither writer claims this gap is closed. See the todo-test in `test/audit/durability.test.ts`.

Record `lastSeq` and `lastHash` from `plur1bus audit verify --json` somewhere the host cannot change. Later supply that pair as `plur1bus audit verify --pin <seq>:<hash>` (lowercase SHA-256, positive safe integer sequence). The pin may refer to any retained sequence, including a rotated file; later appended events do not invalidate it. A missing or mismatching pinned line makes verification fail even when a complete rewrite has an internally consistent anchor. RPC callers pass `{ "pin": { "seq": 42, "hash": "<64 lowercase hex characters>" } }` to `audit.verify`. Existing Owner/Admin authorization applies. No pin is transmitted outside the host automatically.

## What it does not protect

- Someone who can write both the chain and the anchor can rewrite the whole chain consistently. Pin `lastHash` and
  `lastSeq` from `audit.verify` somewhere the host cannot write (another machine, a ticket) to cover that.
- A host-local anchor alone cannot prove which half of an interrupted append is authoritative. An anchor behind the tail is reported and new writes are refused; recovery remains manual.
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
