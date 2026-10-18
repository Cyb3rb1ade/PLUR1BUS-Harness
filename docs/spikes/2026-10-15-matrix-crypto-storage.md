# Matrix WASM / Node persistent store spike (2026-10-15)

Owner limit: at most one day; no NAPI/native packages; existing built-in SQLite preferred;
no extra package without an owner question listing name/version/license/size/maintenance/reason.

## Result: production persistence blocked

WASM 18.9.0 runs in Node 24.21.0. `StoreHandle.open(undefined, undefined)` opens memory storage;
`StoreHandle.open(name, passphrase)` cannot open persistent storage because Node has no IndexedDB.
The actual package API offers only IndexedDB/memory StoreHandles; `initFromStore` accepts an opaque
StoreHandle, not a host-supplied SQL/CryptoStore interface. The shipped JS/WASM bindings require
IndexedDB factory/version-upgrade, object stores/indexes, cursors/key ranges, instanceof constructors,
asynchronous request events and commit/abort scheduling. These are observable correctness semantics,
not interchangeable method names. A thin key/value map over SQLite is insufficient.

The existing module-api SQLite usage (`src/lock.ts`) is an exclusive OS lock. It is not an IndexedDB
implementation. Node's built-in SQLite supplies transactions and FULL-synchronous WAL without a new
native dependency. `crypto-store-spike.test.ts` kills a child inside an UPDATE/INSERT transaction and
proves the previously committed opaque record survives, with owner-only permissions. This proves
SQLite durability only, NOT persistence of a real WASM machine or its ratchets.

Writing and validating a production IndexedDB implementation, including structured clones, index/key
ordering, upgrade transactions, auto-commit timing and error bubbling, exceeds this bounded spike.
An independent read-only reviewer reached the same conclusion from the exact installed bindings.
No persistence package was added, and no in-memory shim is represented as durable storage.
Room-key/SecretsBundle exports are incomplete checkpoints: they do not preserve the complete device
identity, Olm sessions, ratchets, replay tracking and pending requests.

Primary sources: [18.9.0 package](https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm/v/18.9.0),
[StoreHandle API](https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/StoreHandle.html),
[upstream source](https://github.com/matrix-org/matrix-sdk-crypto-wasm).
The assertions in `crypto-memory.test.ts` execute the exact installed 18.9.0 package, not an API mock.

## Authorized fallback

`channels.matrix.e2ee.mode` defaults to `off`. Opt-in `memory` runs actual Olm/Megolm WASM,
with unverified devices rejected by default; owner can explicitly choose `allow` for an experiment.
Every memory-mode start warns: **Not persistent: restart loses keys; verification is required again.**
SAS operations are owner/admin-only, flow-bound to the initiating person, and confirmation requires
an explicit matched-SAS acknowledgement. No automatic cross-signing bootstrap or recovery backup is
activated; both remain KNOWN GAP until durable storage and the associated owner confirmation flow exist.

Five-target execution and persistent key-recovery acceptance remain open. One portable WASM package
is pinned, but a package's portability is not evidence that device verification ran on five targets.
