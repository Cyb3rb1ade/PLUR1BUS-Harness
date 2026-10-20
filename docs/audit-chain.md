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

`detail` is passed through the D111 redactor (`logs/redact.ts`, the data in `packages/log-schema/schema/redaction.json`) before the line is
built, so a secret-keyed value or a credential shape inside it is written as `[REDACTED:…]`; the `audit.log` writers in rbac and identity do
the same. Plain numbers, booleans, names and hex digests are unchanged.

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

The Rust CLI writes directly, including while the core is stopped (setup, repair, backup, uninstall and extensions). It uses the same line envelope, SHA-256 bytes, anchor and 8 MiB rotation names. The core holds a SQLite `BEGIN EXCLUSIVE` OS lock on `audit-chain.lock`; Rust holds the corresponding pending/reserved/shared byte range (`0x40000000`, 512 bytes), using `fcntl` on Unix and `LockFileEx` on Windows. A Rust process mutex also serializes its own threads because POSIX record locks belong to a process. No SQLite database contents are changed by Rust. The kernel releases either lock when its process exits. Direct writes keep offline operations independent of RPC authentication and core availability. A writer **fails closed**: it refuses to
append when the anchor is missing or invalid, when the chain is shorter than the anchor, or when the tail does not
match the anchor (including an anchor behind the tail), so tampering is never papered over by new lines. The recovery is manual: move the chain files and
the anchor aside (keep them as evidence) and start a new chain.

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
- **Known gaps:** `detail` is redacted by the TypeScript chain writer and the rbac and identity `audit.log` writers only. The Rust CLI's chain and `audit.log` lines and the secret-store `audit.log` copy write `detail` as given (the secret store keeps an allow-list of primitive keys; the Rust callers are not checked by this change). Neither `audit.log` nor the journal rotates. Both chain writers use the same rotation contract.
