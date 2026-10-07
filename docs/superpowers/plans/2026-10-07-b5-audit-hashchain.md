# B5 audit log with a hash chain (`audit.verify`, `plur1bus audit verify`)

**Goal.** Make tampering with the audit trail detectable: every line of a new append-only audit file carries the
SHA-256 of the line before it, an anchor in a separate file pins the tail, rotation keeps the chain, and a read-only
verifier (RPC `audit.verify`, CLI `plur1bus audit verify`) reports exactly what is wrong.

## Findings that shape the design

1. `logs/audit.log` has four writers today: the Rust CLI (`crates/plur1bus/src/audit.rs`), the core's RBAC sink
   (`rbac/audit.ts`), the identity writer (`identity/audit.ts`) and the secret store (`secrets/audit.ts`). Its line
   shape is the D111 audit record (`audit.schema.json`, `additionalProperties: false`). Putting a chain into that file
   would change a schema shared with the Rust parity test and break the Rust writer. So the chain is a **new file**
   next to it that wraps the unchanged record: `{ "seq", "prev", "rec": <audit record> }`.
2. The core's own writers (RBAC, identity) tee into the chain; the Rust CLI and the secret store are not wired yet
   (open point in the PR).
3. `audit.read` (Owner/Admin) already exists in the RBAC policy; `audit.verify` maps onto it, no new action.

## Format

- `logs/audit-chain.jsonl` (active), `logs/audit-chain.<firstSeq:10>.jsonl` (rotated), `logs/audit-chain.anchor`
  (`{"v":1,"seq":N,"hash":"…"}`, replaced atomically after every append), `logs/audit-chain.lock` (OS lock via
  module-api's `acquireExclusiveLock`).
- `hash(line)` = SHA-256 hex of the line's UTF-8 bytes without the line terminator (`\n` or `\r\n`).
- first line ever: `prev` = 64 zeros. A new file after rotation chains to the last hash of the old one; `seq` goes on.

## Tests (test first)

tamper a line, delete a line, truncate the tail (anchor), rotation (+ missing rotated file), concurrent writers
(several processes), CRLF line endings, torn tail repair, anchor lag after a crash window, RPC + RBAC completeness.
