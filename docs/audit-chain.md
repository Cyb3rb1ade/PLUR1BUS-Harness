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
| `audit-chain.pending.jsonl` | bounded journal of configuration-audit rows refused by the chain; outside the chain until drained |
| `audit-chain.verified.json` | private `{ "v": 1, "at": <epoch ms> }` metadata from the last successful explicit verification; survives restart, does not pin the current chain |
| `audit-chain.lock` | OS lock (module-api `acquireExclusiveLock`) serialising writers and the verifier |
| `audit-chain.jsonl.torn-<ms>` | bytes of a crashed, unterminated write, set aside by the next append |
| `audit-chain[.<firstSeq:10>].jsonl.pre-reanchor-<ms>`, `audit-chain.anchor.pre-reanchor-<ms>` | an earlier chain era, set aside unchanged by `plur1bus audit reanchor` (see [Recovery](#recovery)) |

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
write that crashed before the anchor moved) is not a finding; the next write moves the anchor up (see [Recovery](#recovery)).

After a reanchor the result also carries two additive lists. Neither makes `ok` false:

- `reanchors`: each `audit.chain.reanchored` event in the current chain (`seq`, `file`, `line`, `at`, and the `suffix` of the
  set-aside files it names). An era boundary is a note, not a break.
- `previousChains`: every chain set aside as `*.pre-reanchor-<ms>`, oldest first, read **only up to its first deviation**
  (`records` = lines before it, `firstBreak` = the deviation, `anchor` = how its own anchor fits that prefix, `intact` = no
  deviation and the anchor matches). A deviation there is normally the reason it was set aside. `announced: false` means no
  reanchor event in the current chain names that suffix (a crash between the renames and the event, or files put there by hand).

## Operational status

`core.status.audit` and `daemon.status.audit` expose cached metadata for human Owner/Admin with `audit.read`; scoped tokens also need that scope. Other principals do not receive the audit object. The local supervisor CLI follows its existing OS-user trust path; use `plur1bus daemon status --json` to see the raw section. These reads do not append, advance an anchor, trim a torn tail or create verification evidence.

The cache lasts 30 seconds. The reader scans metadata and hashes only the newest two complete rows; it is **not** a historical chain verification. `state: "ok"` means the observed tail/anchor is acceptable or in the narrowly healable one-line crash window. It proves neither complete history nor successful future writes. In particular, status preserves an unterminated fragment byte for byte; it can still require investigation even when the observed complete tail matches the anchor.

| Field | Meaning and limit |
|---|---|
| `state`, `reason` | `ok` or `refusing`, with a refusal code or `audit-unreadable`; a cached observation, not an integrity verdict |
| `lastSeq`, `observedAt` | newest observed complete sequence and observation time; an unreadable/malformed end can leave the sequence unknown |
| `lastVerifiedAt` | last successful explicit `audit.verify`, persisted in `audit-chain.verified.json`; null until known, unchanged by later appends |
| `pendingLines`, `pendingDropped` | rows observed in the pending journal and the journal's overflow counter; neither establishes complete audit coverage |
| `pending` | timestamp, actor, action and refusal reason only; no `target` or `detail` payload |
| `lastAnchorAdvanced`, `lastReanchor` | last matching events observed in the current chain, timestamp and actor only; null when unknown |

A successful explicit verification updates its private metadata sidecar. Failure to persist that time is `E_STORAGE`, even though the chain files were not changed. A previous success timestamp is not reset by a later failed check, so operators must inspect the latest verification result as well. It is not an external hash pin.

For the Web audit view, see the [user guide](user/en/audit.md) for the actual controls and the [operations runbook](ops/audit-recovery.md) for evidence handling.

## Writers

The core tees its RBAC sink, identity audit writer and sanitized secret-store records into the chain. Secret records keep their nullable target; no secret value is added to either audit file.

The supervisor's `config.set` writes its `audit.config.set` rows (one per changed `x-audit` key, before `config.json` is replaced) through the same Rust writer (`audit::append_as`, `actor` = the authenticated person), so each row is a chain line and the identical `audit.log` line; the field-based `[REDACTED]` of sensitive config values is applied before the append. A chain that refuses the append does **not** fail the config set; only a failed `audit.log` write does (see [Config saves never wait for the chain](#config-saves-never-wait-for-the-chain)).

The Rust CLI writes directly, including while the core is stopped (setup, repair, backup, uninstall and extensions). It uses the same line envelope, SHA-256 bytes, anchor and 8 MiB rotation names. The core holds a SQLite `BEGIN EXCLUSIVE` OS lock on `audit-chain.lock`; Rust holds the corresponding pending/reserved/shared byte range (`0x40000000`, 512 bytes), using `fcntl` on Unix and `LockFileEx` on Windows. A Rust process mutex also serializes its own threads because POSIX record locks belong to a process. No SQLite database contents are changed by Rust. The kernel releases either lock when its process exits. Direct writes keep offline operations independent of RPC authentication and core availability. Every writer except the config audit **fails closed**: it refuses to
append when the anchor is missing or invalid, when the chain is shorter than the anchor, when the tail does not
match the anchor (including an anchor behind the tail), or when the last line is not a chain line, so a refused tail/anchor is not silently rebuilt to accept new lines. This is a tail check, not a verification of all earlier history (the config audit attempts to queue its lines instead of appending them, see [Config saves never wait for the chain](#config-saves-never-wait-for-the-chain)). Exactly one state is healed by the writers themselves, and one command repairs the rest:
see [Recovery](#recovery).

## Recovery

### The crash window (healed by the next writer)

`append` writes in this order: the line (one `write` on an `O_APPEND` handle, then `fsync`), then the anchor (temporary
file, `fsync`, atomic `rename`). A crash or SIGKILL between the two leaves a complete, correctly chained line **one past the
anchor**. Both writers (TypeScript and Rust) treat exactly that state as recoverable. They move the anchor up to the newest line
only when all of these hold:

1. the newest line is a valid chain line with `seq` = anchor `seq` + 1,
2. its `prev` equals the anchor's `hash`,
3. the line before it (across rotated files) still hashes to the anchor's `hash`, so the line the anchor pinned has not been
   changed.

The recovery is written into the chain, ahead of the event being appended, as `audit.chain.anchor-advanced`
(`detail.fromSeq`, `detail.toSeq`; the Rust CLI also prints one line to stderr). Everything else stays a refusal, and the
anchor file is not touched when a writer refuses: a missing or invalid anchor (also for a chain of one line, so a crash during
the very first write of an installation needs the command below), a chain shorter than the anchor, a tail that does not match
the anchor, an anchor two or more lines behind, a line one past the anchor that does not chain or skips a `seq`, and a last line
that is not a chain line. Crash states are tested by building the file states directly, in both languages, from the shared
vectors in `tests/fixtures/audit-chain-recovery-v1.json`.

Torn writes were handled before: an unterminated last line is set aside as `audit-chain.jsonl.torn-<ms>` and never reached the
anchor. The fragment remains evidence; it is not reconstructed as a complete event. A later intact chain does not establish its contents or completeness of the earlier audit. Status reads themselves never perform this cleanup.

### `plur1bus audit reanchor --reason <text>` (owner only)

When writers refuse the chain for good, the owner starts a new **era** of the chain. The command works on the files, so it runs while
the core is stopped, and while it runs it takes the same lock the writers use (the SQLite-compatible byte range on
`audit-chain.lock`), so it also coordinates with a running core. It is for the owner only in the way offline commands are: the home
must belong to the calling OS user (`logs/` is a real directory of the current uid that group and others cannot write to), otherwise it
exits 1 with `E_UNAUTHORIZED` (reason `not-owner`). On Windows that check is a no-op and the files' ACL (user and SYSTEM only) is the guard. The core's RBAC does not apply because nothing is asked of the core.

Under the lock it

1. inspects the files (read-only): the anchor, the end of the chain, the number of lines and how many of them chain without a
   deviation, the first deviation. If writers would accept the chain it stops with `E_NOT_AVAILABLE` (reason `nothing-to-repair`, exit 2);
   the state a writer heals itself (the crash window above) is not a repair either,
2. renames every chain file and the anchor to `<name>.pre-reanchor-<ms>`. Nothing is deleted or rewritten, torn-write evidence
   files stay where they are,
3. starts a new chain (seq 1, the genesis hash) whose first line is `audit.chain.reanchored`. Its `detail` holds the redacted reason
   (secrets removed with the diagnostic bundle's redactor, cut at 500 characters), the actor (the line's `actor`), the disagreement
   (`anchor-missing`, `anchor-invalid`, `chain-shorter-than-anchor`, `tail-mismatch` or `tail-malformed`; a refused append calls the `tail-mismatch` state `tail-anchor-mismatch` in its `chainReason`), the old anchor
   (`ok` with seq and hash, `missing` or `invalid`), the old end (`previousEnd`: seq and hash, `null` when the last line is not a chain
   line), `lines` and `validLines`, `lastValid`, `firstBreak`, `asideSuffix`, the names of the set-aside files (`aside`) and their
   directory (`asideDir`),
4. writes the new anchor. The same event is also appended to `audit.log`; if that copy fails the command says so and the repair stands.

`--dry-run` prints the finding and what would be set aside and changes nothing (`--reason` is then optional). `--json` prints the
document `audit.reanchor/1`. A failed rename or a failed first write puts the old files back under their names. A crash between the
renames and the first line leaves the set-aside files and an empty chain; the next writer starts a chain without the event, and
`audit.verify` lists the set as `announced: false`.

**Visible tampering.** A reanchor never hides what was there: the old files are kept verbatim, the first line of the new chain says
what was wrong, who ran the command and why, and `audit.verify` keeps reporting the era boundary and the state of every set-aside
chain up to its first deviation. To the verifier a reanchor is an era boundary, not a break; a reanchor nobody asked for is
recognisable by the event (or by an `announced: false` set).

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
2. The writer attempts to append the same line (byte for byte) to the pending journal `logs/audit-chain.pending.jsonl` (0600, fsynced). It keeps at most
   10,000 lines and 8 MiB; beyond that the oldest lines are discarded, counted in a first line `{"pendingDropped":N}`, and noted in
   `audit.log` as `audit.chain.pending_overflow` (`dropped`, `limitLines`, `limitBytes`). A journal write can itself fail after the `audit.log` line succeeded: config saving still proceeds, with `queued: false` in the supervisor diagnostic. Do not infer successful queuing from the warning alone.
3. The `config.set` result carries `warnings: ["audit-chain-unavailable"]` (the CLI prints it), and the supervisor log an `error` line
   with the reason, the number of rows and whether they are queued. The cached `audit` section of `daemon.status` and `core.status` reports operational metadata (above); it does not replace the warning or prove completeness.

`audit::drain_pending` runs after every successful append (when there is no journal, that is one `stat`). Once the chain accepts
appends again (after the anchor is restored, for example), it appends the queued lines to the chain in their original order,
with their original time (`at`) in `rec` and their `chain: "refused"` fields, so the chain line is still the exact `audit.log` line, and
then records `audit.chain.pending_drained` with `count`, `dropped` (lines the limit discarded) and `skipped` (unreadable lines). Lines
are appended in batches of 100 under one lock and one anchor update. The journal is cleared only for lines the chain took: a crash
between the chain write and the clearing can chain a line a second time, never lose one. While the chain still refuses, a drain
changes nothing. A drained line is chained late, not backdated: it sits after the line that triggered the drain, and its own time is `rec.at`.

`audit-chain.pending.jsonl` is not part of the chain: `audit.verify` does not read it, and lines waiting in it are not tamper-evident until they
are drained. A reporting gap while the chain is refused is the price of never blocking the person saving a configuration. Phase `prepare` rows record preparation before the config replacement, not by themselves a successful commit. Reanchor does not itself drain this journal; a subsequent successful Rust audit append triggers the attempt.

## Evidence and operational repair

Use [Audit recovery](ops/audit-recovery.md) before making further writes or starting a new era. Preserve the chain, its anchor, `audit.log`, pending journal, verification metadata and all torn/set-aside evidence together, with private permissions. The installation backup excludes `logs/`; `backup verify` checks its archive, not this audit chain. An update rollback or `1staid repair` is likewise not proof of historical audit integrity.

Reanchor is CLI-only; no Web control runs it. A new era makes the recorded boundary visible but does not reconstruct missing records, validate the old suffix beyond its first deviation, or turn a prior failure into proof of an unbroken history. The user guide distinguishes the [current era and prior chains](user/en/audit.md).

## What it does not protect

- Someone who can write both the chain and the anchor can rewrite the whole chain consistently. Pin `lastHash` and
  `lastSeq` from `audit.verify` somewhere the host cannot write (another machine, a ticket) to cover that.
- A last line changed in the one-write window before the anchor moves is not caught by the writers: a trailing anchor is healed when
  the extra line chains correctly (see [Recovery](#recovery)), which is exactly what a crashed write looks like. `audit.verify` still
  checks every line, and the recovery leaves an `audit.chain.anchor-advanced` line behind.
- A reanchor is not authenticated beyond file ownership. Someone who can run it can also rewrite the chain; the event and the
  set-aside files make the act visible, and a pinned `lastHash` (above) makes it provable.
- Historical audit.log records written before D1 are not backfilled into the chain.
- `audit.log` and the chain are separate files, so a storage failure can leave an event in only one copy. The secret-store operation reports failure. Rust callers keep their existing error handling; some update/uninstall paths treat audit errors as best effort.

## Testabdeckung und bekannte Lücken

- **The chain** (append, `audit.verify`, rotation, torn tail, anchor) is written and tested in `packages/core` (`test/audit/`). The Rust
  CLI also writes the chain directly. Shared UTF-8/hash/CRLF/null-target vectors live in `tests/fixtures/audit-chain-v1.json`. A Rust test runs three Rust and three TypeScript child processes against one home, verifies all 180 records through the TypeScript verifier, then changes a line and checks the finding. This runs on the test host; local macOS execution is not native Windows/Linux evidence.
  The crash-window verdicts (heal one trailing line, refuse everything else) are vectors in `tests/fixtures/audit-chain-recovery-v1.json`, run by both writers
  (`packages/core/test/audit/shared-recovery.test.ts`, `crates/plur1bus/src/audit_chain.rs`); a second Rust test lets the TypeScript verifier read what `audit reanchor` leaves behind.
- **The two Rust appenders** that sit next to it, `logs/audit.log` (`crates/plur1bus/src/audit.rs`) and the offline memory journal
  (`src/journal.rs`), are tested for append-only writes (no earlier byte is rewritten), one physical line per entry whatever the content,
  eight concurrent writers without interleaved lines, private permissions, and a last line left torn by a crash: the next entry now starts
  a line of its own instead of being glued to the fragment.
- **Known gaps:** `detail` is written as given: secrets inside it are not redacted by the chain (not yet enforced; redaction belongs to the event producers in rbac and identity). Neither `audit.log` nor the journal rotates. Both chain writers use the same rotation contract.
