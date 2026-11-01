# TODO inventory

Source snapshot: SH1–SH6, `bbd00876ebb3340a4ff7d6cf39bade19fb80be89`, checked on 2026-11-01. This is an inventory of source markers and
their closing conditions, not a claim that every platform or model acceptance has run. Historical verification
counts in milestone and handoff documents describe their original revisions.

## 1. Controls removed from the open-gap list

All four controls named by package SH are enforced in this snapshot. Three former todo markers were activated
by SH; the Rust schema assertion was already active before SH and is retained, rather than credited as a new closure.
The Owner separately authorizes one new device-history todo below: the server guarantee does not close that device gap.

| Control | Current evidence | Change |
|---|---|---|
| Settings derives sensitivity from the config schema | `packages/web/test/settings-known-gaps.test.ts:7` and the config-schema sensitivity/reference/URL tests | SH1 declares the metadata; SH2 applies it and replaces the old todo with assertions about declared headers and public labels. |
| Secret-bearing config properties are annotated | `crates/plur1bus-log-schema/tests/events.rs:737`, `every_config_property_that_holds_a_secret_value_is_marked_x_sensitive` | Already an ordinary assertion before SH. SH2 retains it while expanding the schema-driven consumers. |
| Release-audit exceptions cannot exempt another crate or version | `scripts/release/test/audit-policy.test.mjs` | SH5 activates the old package-scope todo and tests advisory/crate/version matching, expiry and malformed approvals. |
| A recorded withdrawn server trust fingerprint or departed key cannot be staged or activated again | `packages/api/test/remote-trust-hardening.test.ts`, `packages/remote-access/test/hardening-certs.test.ts` and `trust-rollover.test.ts` | SH6 activates the old server todo against persisted state, retains DER/SPKI history and tests actual certificates, multi-step rotations, restart/recovery, legacy uncertainty and both anchor roles. Device-side history remains open below. |

SH3 also adds regression coverage for JSON-escaped secrets, shared compiled snapshots, redaction before native output
caps, well-formed text cuts, isolated startup/recovery Store values, fresh async export snapshots and a 512-secret load.
SH4 strengthens replay proof with fixed W3C trace/span IDs and explicit provenance equality. The replay runtime repair itself was already present in
commit `e396666d`; SH4 does not claim a second runtime fix.

Other stale rows from the 2026-10-20 inventory are no longer open markers: the attest dialog's invisible characters,
extension endpoint consent hashing, ordinary-backup webhook literals, support-bundle hex values, unknown critical
extensions in leaf certificates. Their ordinary assertions remain in source; outdated Core and adapter rows are replaced
by the current marker inventory below. In particular, the backup webhook and bundle-hex assertions were already
active before SH; SH2 generalizes backup handling through schema metadata without claiming those prior repairs.

## 2. TODO comments and model-pin sentinels

Run this from the repository root to list uppercase markers in source and current prose:

```sh
rg -n -e '\b(TODO|FIXME|XXX|HACK)\b' . \
  -g '*.ts' -g '*.tsx' -g '*.mjs' -g '*.js' -g '*.rs' -g '*.md' \
  -g '!**/dist/**' -g '!**/target/**' -g '!**/node_modules/**' -g '!**/generated/**' \
  -g '!docs/superpowers/**' -g '!docs/phase0/**' -g '!docs/handoff/**' -g '!docs/handoffs/**' \
  -g '!docs/reference/todo-inventory.md' -g '!docs/reference/README.md' \
  -g '!docs/coding-standard.md' -g '!docs/architecture/turn-pipeline.md' \
  -g '!docs/demos/**' -g '!docs/ci.md' -g '!docs/milestones.md' -g '!docs/m2-c9-model-switch-cache.md' \
  | rg -v '^\./(scripts/test/decision-laya\.acceptance\.todo\.test\.mjs:1:|packages/core/test/dreams/engine-acceptance\.test\.ts:29:)' \
  | LC_ALL=C sort
```

The extension list excludes lockfiles; the globs exclude dependencies/builds, generated output, plans/history, this
inventory/index, marker conventions and documents reporting historical scope or test counts. The two explicit
line exclusions are explanatory comments at `scripts/test/decision-laya.acceptance.todo.test.mjs:1` and
`packages/core/test/dreams/engine-acceptance.test.ts:29`. Only those lines are excluded; decision-laya's actual todo
sites remain in section 3. The scan returns 13 rows: nine production markers and four current prose references.
The current production markers are two dreaming comments and seven caption-pin sentinel lines:

| Source | Open item |
|---|---|
| `packages/core/src/dreams/scheduler.ts:107` | `TODO(D111)`: emit the recorded dreaming events as catalogued log-schema events. |
| `packages/core/src/dreams/scheduler.ts:501` | `TODO(engine)`: one guaranteed diary entry per deep sweep; the pinned engine reports none. |
| `packages/core/src/media-search/caption/local.ts:22,28,31,32,36,37,42` | `TODO-PIN`: caption-model revisions and per-file SHA-256 values are placeholders; no downloader acceptance is implied. |

Related open-work prose: `docs/adr/ADR-009-dreaming-scheduler.md:317`, `docs/media-search.md:81` and
`apps/desktop/transport-spike/SSH.md:48` (direct RSA needs a Marvin-safe version or audited backend), and
`docs/remote-access.md:256` (the device-history todo).
The old `dreams/index.ts` and `dreams/types.ts` markers are gone. The TODO references in
`docs/architecture/turn-pipeline.md` describe that integration's historical scope; current permission tests assert
that their `knownGap` rows are empty.

## 3. Todo test locations

Scan explicit todo syntax with:

```sh
rg -n -e 'todo: true|\btodo:\s|\.todo\(|\btodo\(' packages apps tests scripts \
  -g '*.test.ts' -g '*.test.mjs' -g '*.test.tsx' \
  -g '!**/dist/**' -g '!**/target/**' -g '!**/node_modules/**' \
  | rg -v ':[0-9]+:\s*//'
```

There are **37 explicit syntax locations: 32 direct test sites and five generated-case sites**. These are source
locations, not a runtime todo total: receipt-dependent options may be false and generated tables can produce zero
or many todo tests. The shorthand `{ todo }` route-smoke helper is listed separately below.

| Area | Direct sites | Generated-case sites |
|---|---:|---:|
| `packages/core` | 12 | 1 |
| `packages/api` | 2 | 0 |
| `packages/channels-matrix` | 2 | 0 |
| `packages/web` | 1 | 0 |
| `apps/desktop` | 6 | 0 |
| `scripts/release` | 2 | 0 |
| `scripts/test` | 3 | 1 |
| `tests/acceptance` | 3 | 0 |
| `packages/embedding-adapters` | 0 | 1 |
| `packages/voice-providers` | 0 | 1 |
| `packages/webmcp` | 0 | 1 |
| `packages/remote-access` | 1 | 0 |
| `packages/media` | 0 | 0 |
| **Total** | **32** | **5** |

### Core: direct sites

| Source | Closing condition |
|---|---|
| `packages/core/test/audit/durability.test.ts:84` | Native Windows directory-entry durability beyond portable Node fsync. |
| `packages/core/test/channels/behaviour-runtime.test.ts:84` | Engine per-request allowed scopes and searchable provenance-only capture; restrictive profiles currently suppress engine memory calls. |
| `packages/core/test/composition/model-test.test.ts:63` | Real embedding/reranker role probes through the Phase D host ports. |
| `packages/core/test/decision/acceptance.todo.test.ts:11` | Real local Kev MLX inference, cold/cache latency and RSS evidence. |
| `packages/core/test/decision/acceptance.todo.test.ts:18` | Independently labelled paired native Accuracy/Brier evidence for German eligibility. |
| `packages/core/test/knowledge/job.test.ts:47` | Real pinned-engine high-importance capture through `knowledge.update`, file output and recall. |
| `packages/core/test/media-search/acceptance.todo.test.ts:19` | Public pinned-engine media API and Host Fetch receipt. |
| `packages/core/test/media-search/acceptance.todo.test.ts:27` | Production media unit-budget reservations and secret leases before cloud requests. |
| `packages/core/test/media-search/acceptance.todo.test.ts:38` | Real scoped image/audio indexing, image query and caption-memory recall. |
| `packages/core/test/media-search/audit-c08.test.ts:179` | Engine `MediaIndexPort.remove` and `setCaption` carry caller scope. This Engine contract change is explicitly outside SH. |
| `packages/core/test/privacy/live-policy.test.ts:88` | Reembed settlement from actual provider usage through the approved engine host network port. |
| `packages/core/test/privacy/live-policy.test.ts:91` | Automatic engine-only restart scheduling and live privacy-transition hints. |

### Other direct sites

| Source | Closing condition |
|---|---|
| `packages/api/test/m3-agent-licences-e2e.test.ts:45` | Public pinned-engine validation for migrating an existing memory store to another embedding model. |
| `packages/api/test/remote-runtime.test.ts:80` | Disposable joined-host Tailscale Serve, CA-verified edge and desktop pairing acceptance. |
| `packages/remote-access/test/hardening-certs.test.ts:408` | Owner-authorized device-history reproducer: persist device retirement across restart and reject an authenticated announced `next` pin already retired. Server-side history alone does not establish this. |
| `packages/channels-matrix/test/crypto-store-spike.test.ts:39` | Complete approved IndexedDB-over-SQLite checkpointing of WASM identity/session ratchets. |
| `packages/channels-matrix/test/crypto-store-spike.test.ts:40` | Five-target persistent crypto restart, cross-signing bootstrap and approved recovery backup. |
| `packages/web/test/bootstrap-account.test.ts:33` | Physical platform/security-key interoperability; browser WebAuthn automation does not establish hardware acceptance. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:4` | Marvin-safe direct RSA or an audited backend, deferred beyond v1 by the owner. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:5` | Windows and Linux x64/arm64 SSH suite. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:6` | OpenSSH 8.9/9.6 interoperability, algorithm allowlist and real PTY. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:7` | Real SPA HTTP/SSE/WS proxy, jump host and LAN latency. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:8` | Windows agent pipe, isolated 1Password/FIDO fixture and hashed known hosts. |
| `apps/desktop/transport-spike/known-gaps.test.mjs:9` | Installed desktop binary delta on five release targets. |
| `scripts/release/test/updater-zip9.test.mjs:14` | Native updater signature refusal before any extraction write. |
| `scripts/release/test/updater-zip9.test.mjs:15` | Native updater anti-rollback and exclusive install slot. |
| `scripts/test/decision-laya.acceptance.todo.test.mjs:27` | Public production backend, bounded abort and role fallback receipt. |
| `scripts/test/decision-laya.acceptance.todo.test.mjs:85` | Independent labels for the exact paired fixture hash. |
| `scripts/test/decision-laya.acceptance.todo.test.mjs:86` | Independently reviewed identical German/English role comparisons. |
| `tests/acceptance/d111-known-gaps.test.mjs:4` | Per-source settings across restart, bounded trace expiry and live reload. |
| `tests/acceptance/d111-known-gaps.test.mjs:7` | Supervisor D111 writer parity, trusted attribution, trace, live levels and child-output redaction. |
| `tests/acceptance/d111-known-gaps.test.mjs:8` | Named D111 suite on all five native release targets. |

### Generated cases

| Source | Todo source and current boundary |
|---|---|
| `packages/webmcp/test/rbac-matrix.test.ts:85` | Per-method unruled/write/human-only deviations; a runtime count requires the schema and matrix. Outside SH. |
| `packages/core/test/policy/permission-eval-e2e.test.ts:40` | `knownGap` fixture rows; the assertion at line 66 requires the list to be empty. |
| `packages/embedding-adapters/test/error-table.test.ts:222` | `KNOWN_GAPS` map; currently empty. |
| `packages/voice-providers/test/error-table.test.ts:292` | Per-cell `gap`; currently no entries. |
| `scripts/test/decision-laya.acceptance.todo.test.mjs:40` | Per-platform native timing/environment receipts; this syntax remains even when a receipt makes `todo` false. |
| `packages/web/test/routes-smoke.test.ts:76` | Shorthand `{ todo }` from `KNOWN_GAPS`; currently empty, excluded from the 37 explicit-syntax locations. |

## 4. Known-gap controls without a todo flag

| Source | Boundary |
|---|---|
| `packages/core/test/import/provenance-imported.test.ts:86` | The ordinary test pins the current engine behavior: editing creates a new card without imported provenance. It alarms if the engine changes; a todo flag would suppress that alarm. |
| `packages/core/test/import/provenance-imported.test.ts:105` | Per-run rollback needs engine undo; outside SH and the prompt-import work. |
| `packages/core/test/import/hermes-acceptance3.test.ts:2,47` | Cron import is explicitly deferred; soul, skills and cards are separate existing acceptance. |
| `packages/remote-access/test/hardening-certs.test.ts:394` | Active characterization: intact persisted A→B refuses original A, while `initTrust(B)` after history loss permits A again. Detecting lost state is not implemented or claimed. |

## 5. Rust ignore markers

Only two behavioral/decision gaps remain under `#[ignore]`:

| Source | Closing condition |
|---|---|
| `crates/plur1bus-containers/tests/private_network.rs:139` | `DockerRuntime::address` returns a private IP rather than the trait-default container name. |
| `crates/plur1bus/tests/coverage_login.rs:128` | Owner decision on API keys consisting only of whitespace; current parsing rejects empty/NUL values. |

Eleven other ignore sites are explicit environment, opt-in or subprocess markers: desktop `controller_e2e.rs` (3),
`upgrade_e2e.rs` (2), real-keychain `secrets.rs` (1), `examples/production_job.rs` subprocess entries (4), and
`crates/plur1bus-ext/tests/fuzz.rs` nightly fuzzing (1). There are **13 Rust ignore sites** in total. No marker was
removed or relaxed by this documentation update. Count actual attributes with:

```sh
rg -n '^\s*#\[ignore(?:\s*=\s*[^]]+)?\]' crates apps \
  -g '*.rs' -g '!**/target/**' | LC_ALL=C sort
```

The explanatory `#[ignore]` comment at `crates/plur1bus-ext/tests/fuzz.rs:5` is not an attribute.

## 6. SH coverage boundaries and follow-ups

- Store-description validation still uses the plain-value `contains`/`mask` helpers in
  `packages/core/src/secrets/redaction.ts`. Shared RPC/log variant coverage from SH3 does not establish equivalent
  encoded-value rejection in description metadata; a broader metadata review remains a follow-up. This records a
  coverage boundary, not a newly validated exploit.
- Startup can register only readable Store values. The existing eight-UTF-16-unit masking minimum remains in
  effect; [the Secrets documentation](../secrets.md) explains backend failures and initial-snapshot retention.
- SH5 supports exact stable versions and bounded numeric ranges within one major (the next major's `.0.0` is
  allowed only as an exclusive upper endpoint), without a new dependency. Prerelease/build versions cannot receive
  an exception. Current pnpm findings provide no installed version, so GHSA allowlist entries are rejected explicitly.
  Checked-in approvals are validated; unused advisory/crate/version tuples produce nonblocking warnings. Workspace
  and lockfile identity are not exception dimensions. See [Dependency policy](../dependency-policy.md).
- SH6's private API v2 requires explicit valid DER/SPKI lists and preserves both through restart and activation-intent
  recovery. The library still accepts legacy missing lists; that does not weaken the strict v2 envelope. Legacy retired
  DER hashes with unknown key identities remain unresolved and block new staging/activation; reads and cancellation
  remain available. Current-key renewal is allowed until that key is departed.
- Both activation intent and final state are validated before TLS changes, counting UTF-8 bytes and the final newline
  against the 256 KiB reader limit; retained history is never evicted to fit. Newly rejected candidates are cleaned;
  cancellation without a stage also clears orphan material while preserving history and a switched summary. Duplicate
  stage and failed announcement after durable stage preserve the existing candidate. No manual file deletion is needed
  to recover from retired-candidate rejection. See [Remote access](../remote-access.md#security).
- Device-side durable retirement remains open (`hardening-certs.test.ts:408`). Missing/deleted/old private snapshots,
  state rollback, `initTrust`, software downgrade and same-user state replacement cannot reconstruct unknown history.
  The retirement audit records an activation attempt once per persisted intent, not an atomic completed TLS event
  across separate stores; automatic reconciliation against rollback is not implemented.
- Company-CA import checks unsupported critical extensions in the leaf certificate; those in intermediate
  certificates remain a separate open gap, described in [Remote access](../remote-access.md).
- Engine contracts/pins, physical authenticators, owner-host/native acceptance, prompt import, external-agent
  containment and V-A protocol work retain their separate owners and gates. Removing a historical inventory row
  is not acceptance of any of these dependencies.
