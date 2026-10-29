# Desktop: primary/client role switch — make an SSH host the owner's primary server — design

**Status:** Draft for owner review (phase 1: specification and plan, no product code). Open owner questions in §15 ·
**Date:** 2026-10-29 · **Owner:** Christian (Cyb3rb1ade) · **Track:** D (desktop), follow-up to D113 ·
**Proposed register entry:** **D118** in the core spec's register
([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2; D117 is proposed by
[`2026-10-21-media-image-verify-design.md`](2026-10-21-media-image-verify-design.md), D118 is the next free number on
every branch at this commit) · **Companion:** shared compute in the owner's cluster,
[`2026-10-29-shared-compute-design.md`](2026-10-29-shared-compute-design.md) (proposed **D119**) ·
**Plan:** [`2026-10-29-primary-client-role-switch.md`](../plans/2026-10-29-primary-client-role-switch.md)

**Owner request (2026-10-29, paraphrased from German).** A pure CLI/headless installation with the harness web server
running must be first-class, so a remote desktop PLUR1BUS can attach to it. From the desktop app on the MacBook the
owner sets up an SSH host (VPS or home server) as his **primary server**. After that the MacBook instance is a
**client / second instance**; Telegram and the other channels, the agents, the schedules and memory keep working while
the notebook is off. **Owner decision 2026-10-29:** the desktop track owns this flow as a D113 follow-up spec; the WIF
spec's WP13 depends on it (WIF Q14). **Owner addendum 2026-10-29:** shared compute across the cluster is in scope
(companion spec).

**Inputs read** (`origin/main` @ `699439979c`): the D113 spec and plan
([`2026-10-18-desktop-ssh-remote-design.md`](2026-10-18-desktop-ssh-remote-design.md),
[`2026-10-18-desktop-ssh-remote.md`](../plans/2026-10-18-desktop-ssh-remote.md)); the transport choice
([`2026-10-21-desktop-transport-choice-design.md`](2026-10-21-desktop-transport-choice-design.md)); D114
([`2026-10-19-federation-cluster-design.md`](2026-10-19-federation-cluster-design.md) §5.2, §7.3, §7.4, §11, §12);
D116 ([`2026-10-20-memory-tree-relationships-design.md`](2026-10-20-memory-tree-relationships-design.md)); the WIF spec
on `main` and its amendment in open PR #823 (§9.7, §12.5 remote-primary contract, plan WP13);
[ADR-005](../../adr/ADR-005-auth-policy-and-secrets.md) (kinds, `--bare`, M2 secret store record, B19);
[ADR-006](../../adr/ADR-006-embedding-and-reranking.md); [ADR-007](../../adr/ADR-007-users-roles-identity.md) via
[`docs/rbac.md`](../../rbac.md); the core register rows D28, D35, D51, D109, D112; the desktop spec rows DS17, DS26;
`crates/plur1bus/src/{paths.rs,cli.rs}`, `supervisor/mod.rs` (single-instance lock), `install/setup.rs` (step ids,
install lock), `backup/` (`plur1bus.backup/1`, `ensure_quiescent`), `commands/{setup,login,firstaid}.rs`;
`packages/core/src/{core.ts,lock.ts}`, `import/maintenance-admission.ts` (the read-only hold),
`channels/registry.ts`, `privacy/local-only.ts`, `user-jobs/`, `dreams/`, `system-jobs/`;
`packages/channels-telegram/src/{api,channel}.ts`, [`docs/channels/telegram.md`](../../channels/telegram.md);
`packages/api/src/rpc-route.ts`; [`docs/portable-backup.md`](../../portable-backup.md), [`docs/recurring.md`](../../recurring.md),
[`docs/desktop.md`](../../desktop.md) (host bridge), `apps/desktop/src-tauri/src/tray.rs`; `scripts/lint-hygiene.mjs`.

## 1. Goal and non-goals

**Goal.** One owner runs one **logical PLUR1BUS instance** that can live on different machines over time. Exactly one
machine at a time is its **primary**: it runs every single-writer unit (channels, schedulers, memory writes, outbound
automations). Other machines of the same owner are **clients**: they show the UI, keep a connection profile, and may
offer compute and device capabilities to the primary (companion spec), but never write the instance's state.

1. **Headless primary is first-class.** `plur1bus setup --non-interactive --json` on a Linux host plus the harness API on
   loopback is a complete primary; a desktop attaches through D113's SSH tunnel or a `tailnet`/`network` connection.
2. **Promote.** The person moves the instance from the MacBook to an SSH host — from the desktop over D113, or from the
   CLI alone (**CLI parity is a hard requirement**) — with preflight, quiesce, a consistent verified snapshot, transfer,
   start, health check including channel liveness, and a rollback window.
3. **Demote, failback, re-promote** in either direction with the same protocol.
4. **Never two primaries** from any cooperative flow, including a MacBook that wakes up after the server took over. A
   takeover while the primary is unreachable is an explicit, confirmed, epoch-fenced action, never automatic.

**Non-goals.**

- No consensus protocol, no witness node, no replicated store, no automatic merge of divergent state (§4.6, Q4).
- No continuous replication or warm standby in v1 (Q9).
- No cluster across owners: that is D114 federation, unchanged (§10.2).
- No new exposure mode: `remote.publish` stays `local | tailnet | network`; the API is never published to the internet
  (transport choice §1).
- No macOS or Windows **target** for promote in v1: the target list is D113 R1 (Linux x64/arm64, glibc, systemd user
  manager). Any desktop target can be a **source** or a **client**.
- No change to RBAC roles, pairing policy or the owner model: ADR-007 keeps exactly one Owner and no ownership transfer.

## 2. Decisions at a glance

| # | Topic | Decision (recommendation) | Main alternative, why not |
|---|---|---|---|
| RS1 | Roles | Durable per-node role: `standalone` (today's default, no cluster), `primary`, `client`; transitional `handing-over`, `pending`, `fenced` (§4.1). Writers run only in `standalone` and `primary`. | A boolean "remote mode": cannot express an interrupted handover or a fenced former primary. |
| RS2 | Authority | Authority moves only by a **two-phase handover committed by the current authority**, or by an explicit **forced takeover** (§6.4). No witness, no quorum in v1. | Lease-based leadership: the primary must keep running while every client is off, so there is nobody to renew a lease with. |
| RS3 | Fencing | A per-cluster **epoch** (u64) is the fencing token: in the role record, every bundle and commit token, the node-bridge hello and every primary→node message. Higher epoch wins at first contact; a lower-epoch primary turns `fenced` at once (§4.6). | Timestamps: clocks of a sleeping laptop and a VPS disagree. |
| RS4 | Enforcement | **Two gates:** the supervisor starts no writer unit unless the role allows writes; the core runs in a **role hold** (generalising the existing import maintenance hold) that defers all background startup and refuses write methods (§4.4). | Core-only gate: supervisor-managed channel modules would still start. |
| RS5 | Snapshot | The existing verified **`plur1bus backup` archive** (`plur1bus.backup/1`, SHA-256 per file, engine/SQLite staged by the core) inside a **role bundle** header (`plur1bus.role-bundle/1`) with cluster, epoch, source, target and a signature; vault values never inside on the SSH path (§5.3). | A new archive format: duplicates M8's verified, tested path. |
| RS6 | Transfer | Over D113's SSH session with WP4's resumable upload, server-side SHA-256 before import; the same bundle as a file for the CLI's manual path (§5.4). | A harness-to-harness HTTP push: needs an inbound listener on the target. |
| RS7 | CLI parity | **One protocol of four primitives** (`role promote --prepare`, `role accept`, `role promote --commit`, `role activate`) with three drivers: the desktop (russh, D113), `plur1bus role promote --ssh` (system OpenSSH client, Q6), and by hand with files (§5.1). | A desktop-only flow: violates the hard requirement. |
| RS8 | Node identity | Per-node Ed25519 **node key** (`ring`, already in the resolved graph through `plur1bus-ext`), private half in `state/role/node.key` (0600, never backed up), shared later with D114's instance key (§4.2). | HMAC with a per-handover secret: no durable node identity for the node bridge and compute attribution. |
| RS9 | Rollback | **Rollback window** (default 7 days, Q2): the former primary keeps its frozen pre-handover state read-only; *failback* (reverse promote, keeps server changes) is the default, *restore frozen* (discards them) needs typed confirmation (§5.7). | No window: a failed move after commit could only be repaired from backups. |
| RS10 | Secrets | Per class (§7): static secrets move over the tunnel into owner-only `secret set` (stdin, zeroized); host-bound registrations re-login on the server; WIF never crosses (each host its own source); the target store is the keyring or the B19 machine-bound file fallback (Q12). | Copying the secret store file: it is bound to a machine key by design. |
| RS11 | Locality | `privacy.localOnly` means **inside the owner's cluster** (primary plus enrolled nodes over the authenticated tunnel), never a third party; preflight warns that a VPS keeps data at a hoster (§8.1, Q7). | Keeping "loopback only": local models on the MacBook become unusable for a VPS primary. |
| RS12 | Client capabilities | v1: SPA voice works (the browser captures); local models and compute through the D51 b node (companion); computer use and local files later through DS17 grants (§8.2, Q8). | Opening the host bridge to a remote primary at once: widens DS17 before its grants model exists for remote. |
| RS13 | Surfaces | `plur1bus role status|promote|accept|activate|demote|takeover|rollback|members`; supervisor RPC `role.*`, writes Owner only, `humanOnly`, surface T3, never on WebMCP or the web in v1 (§9). | `migrate` as one verb: hides the commit point the person must understand. |

## 3. What exists and what this builds on

| Piece | Where | Used for |
|---|---|---|
| Single-instance guards: `run/supervisor.lock` (OS file lock), `state/core.lock` | `supervisor/mod.rs` `run`, `packages/core/src/lock.ts` | one supervisor/core per home; **not** across machines — that is this spec's gap |
| Read-only core hold: restarted core stays a read-only host, background startup deferred, non-read methods `E_CONFLICT busy` | `packages/core/src/import/maintenance-admission.ts`, `core.ts` (`importHold`, `startImportBackground`) | template for the role hold (§4.4) |
| Deferred background startup: system jobs, discovery scan, dreams scheduler, user jobs tick, model warmup, switchboard (channels), journal replay | `core.ts` `startImportBackground` | the writer set the hold keeps off |
| Backup archive, verify, restore, quiescence check | `crates/plur1bus/src/backup/`, `plur1bus backup create|verify|restore` | the snapshot (§5.3) |
| Portable encrypted vault (AES-256-GCM, scrypt), owner-only `secret set` via stdin | [`docs/portable-backup.md`](../../portable-backup.md), `scripts/release/portable-backup.mjs` | vault transfer (§7) |
| Secret store: keyring, B19 machine-bound file fallback `state/secrets/store.key` (off by default, owner decision open) | ADR-005 implementation record | target store on a headless server |
| Install/update lock (one installer per home) | `install/setup.rs` `run_steps` → `crate::update::lock` | role operations take the same lock |
| D113: closed `RemoteCommand` set, charset `[A-Za-z0-9._/:=@+-]`, scripts via `/bin/sh -s`, upload mode, tunnel, `ssh_manage` | D113 spec §6.3, §6.2, §7; plan WP1–WP5 (not built; only the spike exists) | the desktop driver (§5.1) |
| D51 b node bridge (`plur1bus node`, paired device over the M3 WebSocket, provider `node:<device>/<model>`) and DS17 host bridge (same protocol, named capabilities) | core register D51; desktop spec DS17 | client ↔ primary channel (§4.7, companion spec) |
| Telegram adapter: long polling, `409` retried with backoff, offset persisted before acknowledgement | `packages/channels-telegram/src/{api,channel}.ts` | channel fence evidence (§4.6) |
| `privacy.localOnly` (loopback or `privacy.localEndpoints`) | `packages/core/src/privacy/local-only.ts` | locality (§8.1) |
| Tray: `HarnessState`, `PathLabel`, `Badge` | `apps/desktop/src-tauri/src/tray.rs` | role display (§9.3) |
| WIF remote-primary contract (identity token and minted token stay on the server) | WIF spec §12.5, §9.7 (open PR #823) | §10.1 |

Searched and **not found** on `main` (searched: primary, role switch, second instance, cluster role, epoch, fencing,
takeover): any cross-machine authority, role record, or handover. `installationId` exists only in the import-extensions
code, not as an installation identity (U5).

## 4. Roles and invariants

### 4.1 Roles and transitions

| Role | Writers | Meaning |
|---|---|---|
| `standalone` | yes | today's behaviour; no cluster; epoch 0; the default when no role record exists |
| `primary` | yes | the cluster's authority at its epoch |
| `client` | **no** | a member that knows the primary (node id, epoch, how to reach it) |
| `handing-over` | **no** (quiesced) | the authority while it hands over; still the only node allowed to commit |
| `pending` | **no** | a target holding an imported, verified bundle, waiting for the commit token |
| `fenced` | **no** | a former primary that saw a higher epoch, or found its handover overtaken; waits for the owner |

| From | Event | To | Actor | Guard |
|---|---|---|---|---|
| `standalone` | `prepare(target)` | `handing-over` | source | mints `clusterId`, sets epoch 1; install lock held; an abort returns to `primary` at epoch 1 (a primary without clients behaves like `standalone`) |
| `primary` | `prepare(target)` | `handing-over` | source | target is a member or a fresh node |
| `handing-over` | `abort` or handover lease expired before commit | previous role | source | writers resume; target told to discard |
| `handing-over` | `commit(receipt)` | `client` (epoch N+1, primary = target) | source | valid target receipt for this bundle; **durable write before the commit token leaves** |
| `standalone` (fresh) or `client` | `accept(bundle)` | `pending` | target | signature, checksum, cluster, epoch ≥ last seen; non-fresh target needs `--replace` |
| `pending` | `activate(commit token)` | `primary` (epoch N+1) | target | token signed by the bundle's source key, for this bundle hash, this node, epoch N+1 |
| `pending` | `discard` | role before `accept` | target | restores the pre-accept local backup |
| `client` | `takeover --force` | `primary` (epoch = highest seen + 1) | client | primary unreachable ≥ `role.takeoverMinUnreachableMs`, typed confirmation (§6.4) |
| `primary`/`handing-over` | contact with a higher epoch of the same cluster | `fenced` | any | automatic, immediate; audited |
| `client` | contact with a higher epoch of the same cluster | `client` (new epoch and primary pointer) | any | automatic; audited |
| `pending` | contact with a higher epoch than the bundle's commit would give | role before `accept` | target | the bundle is stale; automatic discard; audited |
| `client` with `frozen` | `rollback --restore-frozen` | `primary` (epoch = highest seen + 1) | owner | inside the rollback window, typed confirmation, the server demoted cooperatively first (§5.7) |
| `fenced` | `resolve --as-client` | `client` | owner | divergent state quarantined first (§4.6) |
| `standalone` (fresh, empty) | `join(pairing)` | `client` | joining node | Owner confirmed the pairing on the primary; records cluster, epoch, primary |
| `client` | `leave` | `standalone` | owner | after the rollback window or with typed confirmation; the node removes its membership |

The table is closed: any other pair is refused with `role-invalid-transition`. Epochs only grow within a cluster; a
node that returns to `standalone` (`leave`, or `discard` back to a fresh state) forgets the cluster and its epochs. Events that change no
role (bundle hash recorded, handover lease renewed, contact with the primary at the same epoch) update fields only.

### 4.2 Cluster and node identity

- **Cluster:** `clusterId` (UUIDv7), minted at the first `prepare`, bound to the installation's Owner principal
  (ADR-007: exactly one Owner). A node belongs to at most one cluster.
- **Node:** `nodeId` (UUIDv7, created with the node key) and an Ed25519 **node key**. The private half lives in
  `state/role/node.key` (0600, user-and-SYSTEM ACL on Windows, created once, never regenerated over an existing file,
  never in a backup or bundle; `backup/create.rs`'s allow-list does not include `state/role/`). Fingerprint
  `sha256:<base64url>` like device keys. D114's instance key (§5.2 there) is the same concept; when D114 is built it
  adopts this key instead of minting a second one (§10.2).
- **Why a file and not the secret store:** the supervisor (Rust) signs the commit token and must work while the core is
  held or stopped; the trust anchor is the OS user (D113 §7.2), which can read the store's key file anyway. Same
  reasoning as `run/core.token` and B19's key file.

### 4.3 Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | At most one node per cluster has a writer-allowed role at any epoch. | two-phase commit (§5.2); epoch fencing (§4.6) |
| I2 | A cooperative flow never yields two writer-allowed nodes, at any instant. | source writes `client(N+1)` durably **before** the commit token exists; target activates only with that token |
| I3 | A node whose role record is missing is `standalone`; a record that is corrupt or unreadable allows **no** writers (`role-record-corrupt`, fail closed) and is never regenerated over. | role store (plan RS0) |
| I4 | Epochs only grow; a bundle or token with an epoch below the node's highest seen is refused (`role-stale-epoch`). | role store; accept/activate |
| I5 | Every writer unit checks the role at start (supervisor) and the core refuses write methods while held. | §4.4 |
| I6 | A client never takes over by itself. Automatic transitions only ever **remove** writers from cluster members (fence, stale-bundle discard, epoch update of a client); the single automatic return to a writer role inside the cluster is the source's own abort before its commit, which is safe because no commit token exists yet. A node that returns to `standalone` has left the cluster and is a separate instance. Every transition that grants writers to a node that did not hold them (`activate`, `takeover --force`, `rollback --restore-frozen`) is a human command. | state machine; tests |
| I7 | Secrets cross only as §7 allows; WIF sources and minted tokens never leave their host. | §7; WIF §12.5 |
| I8 | The role record and node key are per node and never travel. | backup allow-list; bundle schema |
| I9 | Every transition is audited before it takes effect; an audit write failure aborts the transition. | M2 audit rule (ADR-005 record) |

### 4.4 Single-writer units and the two gates

| Unit | Where it starts today | Gate |
|---|---|---|
| Channels (Telegram polling/webhook, Discord gateway, Matrix sync, Signal, Email IMAP, Slack socket) | core `switchboard.start()`; channel modules under the supervisor (restart class `module:<name>`) | role hold defers the switchboard; supervisor skips modules whose manifest marks them `writer` (U8) |
| Recurring tasks (`state/user-jobs.sqlite`, 30 s tick) | core `runUserJobs` | role hold |
| Dreams scheduler, system jobs (knowledge update), discovery scan | core background startup | role hold |
| Journal replay and every memory write (`memory.capture`, `correct`, `forget`, proposals, curation) | core | role hold: deferred replay; write methods `E_CONFLICT reason=role-hold` |
| Outbound automations: delivery targets, webhooks, federation/A2A/MCP servers that accept work | core | role hold |
| Media index backfill, re-embedding migration | core/engine | role hold |
| Extension background workers | supervisor (`ext/worker`) | supervisor gate |
| WIF mint for cluster providers | core auth engine | role hold (a client keeps only a profile of its own source, WIF §12.5 inv. 5) |

**Supervisor gate.** The supervisor reads the role record at start and on every role change. Writer roles start
everything as today. Non-writer roles start the core with the role hold (`PLUR1BUS_ROLE_HOLD=<role>:<epoch>`,
the same mechanism as `PLUR1BUS_IMPORT_MAINTENANCE`), the API, and only non-writer units (the node bridge,
companion spec). A role change restarts the affected units through the existing restart path (B8 `RestartJob`).

**Core role hold.** Generalise `createImportMaintenanceHold` into a hold with a reason (`import` or `role`): the role
hold never releases by itself (only a restart in a writer role ends it), allows the read methods plus
`admin.backup.snapshot`, `secret.set` (vault import while `pending`), `doctor.report` and `role`-related reads, and
refuses the rest with `E_CONFLICT reason=role-hold` and the role in the error data.

### 4.5 Role record

`state/role.json`, schema `plur1bus.role/1`, closed (unknown fields refused), atomic private write, written **only**
by the supervisor or by the CLI while no supervisor runs (the CLI takes the install lock):

```text
{ schema: "plur1bus.role/1", role, epoch, clusterId?, nodeId, nodeKeyFingerprint,
  primary?: { nodeId, nodeKeyFingerprint, displayName, reach: { kind: ssh | tailnet | network, ref } },
  handover?: { id, side: source | target, peerNodeId, peerKeyFingerprint, bundleSha256?, expectedEpoch?,
               startedAtMs, leaseExpiresAtMs, previousRole, previousClusterId?, previousEpoch },
  frozen?: { epoch, bundleSha256, frozenAtMs, rollbackUntilMs },
  highestSeenEpoch, lastPrimaryContactAtMs?, changedAtMs, changedBy }
```

`reach.ref` is a connection or SSH-profile id on desktops and a short operator note on CLI nodes; never an address
with credentials. The record holds no secret.

### 4.6 Fencing and split brain

- **Epoch on every contact.** The node bridge hello (D51 b), `role status` over SSH and every bundle carry
  `{clusterId, epoch, role, nodeId}`. A node that sees the same cluster with a **higher** epoch than its own writer
  epoch turns `fenced` at once: the supervisor restarts the core in hold and stops writer modules; audit `role.fenced`.
- **The MacBook wakes after the server took over** (the owner's case): the MacBook's record already says `client`
  (it committed before the server activated, I2). It never starts a writer, whatever it sees on the network.
- **Interrupted handover:** a source that sleeps in `handing-over` resumes there; before the commit it may abort
  (writers resume) or commit. A target in `pending` never activates without the token and never times out into
  `primary`. If the source aborted while the target holds a bundle, the target's next contact tells it to discard.
- **Forced takeover during a partition** is the one way to get two writer-allowed nodes: the old primary still runs
  until it sees the new epoch. This is explicit (§6.4), bounded by the next contact, detected, and recovered by
  quarantine: the fenced node writes a **divergence archive** (`plur1bus backup` of its state, labelled
  `divergent-epoch-<n>`) before it becomes a client. v1 merges nothing automatically; selected memories can be imported
  later through `memory.import` with provenance (Q4).
- **Channel-level fence as a second signal.** Two Telegram pollers on one bot token make Telegram answer `409` to one
  of them (`docs/channels/telegram.md`: "409: stop the other poller"). A sustained `409` (more than 5 minutes) raises
  `role.channel-conflict` in `1staid` and the tray on the node that sees it, and the audit; it changes no role (U4).
  Webhook mode is fenced by Telegram itself: the last `setWebhook` wins, so the new primary's activation moves delivery.

### 4.7 What a client keeps and what it must not run

**Keeps:** its role record (primary pointer), its node key, the desktop connection profile (`connections.json` /
`ssh-hosts.json` row with the device token in the keychain, D113), UI settings, the frozen pre-handover state during
the rollback window (read-only, never opened for writing), and the **node bridge** to the primary (D51 b; companion
spec) for local models, compute and, later, device capabilities. No offline cache of the primary's data in v1.

**Must not run:** any unit of §4.4; an engine that opens the frozen stores for writing (U7: a compute-only engine mode,
otherwise no in-core compute on that node); a memory service for attached external systems (D28 attachments on the
MacBook must be re-pointed to the primary; preflight lists them, §5.2 step 1).

### 4.8 Leases: reuse of the D114 pattern and the difference

D114 §7.3 uses a lender-signed lease (120 s, renewed every 30 s) so that a lent agent stops when its owner's instance
disappears. The role switch reuses the **numbers and the mechanics** where liveness matters, not the authority model:

| Lease | Between | TTL / heartbeat | On expiry |
|---|---|---|---|
| Handover lease | source ↔ target during `prepare` → `commit` | 120 s / 30 s (`role.handoverLeaseTtlMs`, `role.heartbeatMs`) | source aborts (writers resume) unless already committed |
| Node attachment lease | client ↔ primary over the node bridge | 120 s / 30 s | client shows "primary unreachable since …"; compute leases of that node lapse (companion) |

**Difference from D114.** D114 lends one agent between instances of **different owners**, and the lender's lease is the
permission itself. Here **one owner's one logical instance** moves or is split into one writer and several helpers;
the primary's authority is **not leased** — it must survive every client being off. Authority changes only through the
commit token or a forced takeover, both epoch-fenced.

## 5. Promote: MacBook → server

### 5.1 One protocol, three drivers

The protocol consists of four primitives. Each is a harness CLI command with `--json` (schema-tagged documents,
ADR-016 §8) and stable exit codes, so every driver composes the same steps and the GUI never re-implements them:

| Primitive | Runs on | Effect | Output |
|---|---|---|---|
| `plur1bus role promote --prepare --target-node <fingerprint|new> [--plan]` | source | preflight (local half), quiesce, snapshot, bundle | `role.bundle/1` (path, SHA-256, size, units, secret names, handover id) |
| `plur1bus role accept <bundle> [--vault-stdin] [--replace]` | target | verify, import, start held, pre-commit health | `role.receipt/1` (receipt file, target node fingerprint, health rows) |
| `plur1bus role promote --commit <receipt>` | source | verify receipt, durable `client(N+1)`, issue commit token | `role.commit/1` (token file, new epoch) |
| `plur1bus role activate <token>` | target | verify token, `primary(N+1)`, start writers, liveness | `role.activate/1` (health rows, channel liveness) |

`--plan` on `prepare` (and `--dry-run` on `accept`) computes everything, changes nothing and quiesces nothing.

| Driver | Transport | How it runs the primitives |
|---|---|---|
| **Desktop** (D113) | russh session, in-process | new closed `RemoteCommand`s `RoleStatus`, `RolePreflight`, `ReceiveRoleBundle` (upload channel of D113 WP4), `RoleAccept`, `RoleActivate`, `RoleDemote`; locally the app calls the bundled harness's supervisor RPC `role.*` (§9.2) |
| **CLI over SSH** | the system OpenSSH client, fixed argv (`ssh -T -- <user@host> <fixed command>`), the person's own `~/.ssh/config` (Q6) | `plur1bus role promote --ssh <user@host> [--port N]`: local prepare, stream bundle over the session's stdin to `role accept --bundle-stdin`, read the receipt, local commit, remote activate |
| **CLI by hand** | any (scp, USB, a clinic share) | the person runs the four commands in order; files carry everything, vault values go in a separate passphrase-protected portable vault (§7) |

Only the desktop driver is new code in the app; the CLI drivers are thin composition in `crates/plur1bus`.

### 5.2 Steps

| # | Step | What happens | Fails with | Recovery |
|---|---|---|---|---|
| 1 | **Preflight** (nothing changes) | Versions: source and target release equal (major.minor, same core contract and RPC version; `update` first otherwise). Target: D113 probe (OS, arch, libc, systemd user + linger), `setup` done, daemon healthy, role `standalone` and empty (no agents, no memories) or `client` of this cluster. Disk: free space ≥ 2.5 × estimated bundle size on both sides. Reachability and transport: D113 session or `--ssh` works; transport check (Tailscale/direct, public warning). Secrets: target backend usable (keyring or B19 fallback, Q12); every secret class mapped (§7). Host-specific paths in config (absolute workspace roots, vault paths, `privacy.localEndpoints` loopback models) listed for mapping. Attached systems (D28) and paired devices listed. Clock skew ≤ 120 s. Local-only consequences (§8.1). | `role-version-mismatch`, `role-target-unsupported`, `role-target-not-empty`, `role-disk-low`, `role-target-unreachable`, `role-secret-backend-missing`, `role-host-paths`, `role-clock-skew` | fix and rerun; nothing changed |
| 2 | **Quiesce** | Source takes the install lock, writes `handing-over` (handover id, lease), supervisor restarts the core in role hold and stops writer modules within `role.quiesceBudgetMs` (default 60 s); journal replay drained; open turns finish or are cancelled (partials kept); channel offsets persisted (Telegram persists before acknowledging) | `role-quiesce-timeout`, `role-busy` (setup/update/import running) | `role promote --abort`: writers resume |
| 3 | **Snapshot** | `plur1bus backup create` against the held core (engine/SQLite staged by `admin.backup.snapshot`; plain units copied), verified (`backup verify`); role bundle header written and signed (§5.3); vault names listed, values not read yet | `role-snapshot-failed`, `role-snapshot-mismatch` | abort |
| 4 | **Transfer** | Desktop: D113 upload (resumable, offsets), into `~/.cache/plur1bus-desktop/role-<handover id>.p1role`, server-side SHA-256; CLI: stdin stream or file copy. Handover lease renewed every 30 s | `role-transfer-interrupted`, `role-checksum-mismatch`, `role-lease-expired` | resume upload; abort after lease expiry |
| 5 | **Accept on the server** | Verify signature, checksum, cluster and epoch; local backup of the target first (`--replace` only); `backup restore` with the daemon stopped; host-path mapping applied; daemon started **held** (`pending`); vault values streamed into owner-only `secret set` over stdin (§7); pre-commit health: stores open, engine ready, config valid, every secret reference resolves, every channel's **credential check without polling** (Telegram `getMe`, Discord `/users/@me`, Matrix `whoami`, IMAP login/logout), schedulers' next runs computed, WIF profiles of the server validated (WIF §12.5); receipt signed with the target's node key | `role-bundle-signature`, `role-stale-epoch`, `role-bundle-foreign-cluster`, `role-health-failed` (with rows) | `role accept --discard` deletes every vault value it imported, restores the target's backup (a fresh target returns to an empty `standalone`, so it can never poll the cluster's bot tokens), and the source aborts |
| 6 | **Commit (the point of no return)** | Source verifies the receipt (target fingerprint as confirmed in step 1), writes `client`, epoch N+1, primary = target, `frozen` = its pre-handover state, **fsync**, then issues the commit token | `role-receipt-invalid` | before the durable write: abort; after it: only activation or rollback |
| 7 | **Activate on the server** | Verify token; `primary(N+1)`; supervisor restarts the core without hold and starts writer modules | `role-commit-invalid` | retry activation (idempotent with the same token) |
| 8 | **Health and channel liveness** | `daemon status`, `1staid check`; per channel: Telegram first successful `getUpdates` (or `setWebhook` ok), Discord READY, Matrix first sync, IMAP IDLE, Slack socket hello; each within `role.livenessBudgetMs` (default 120 s); recurring tasks armed; journal replay done | `role-channel-not-live`, `role-health-failed` | the server stays `primary`, `degraded`; the GUI offers *Fix* or *Failback* (§5.7); no automatic failback (Q2) |
| 9 | **Switch the desktop to client mode** | The app adds or updates the SSH connection to the server, opens it once M3 P1–P3 exist (D113 Q5), sets the tray's role label, pairs the node bridge (companion) with an Owner-confirmed device grant | — | — |

The source's channels are silent from step 2 to step 8. Messages sent meanwhile wait at the platform (Telegram keeps
updates for 24 h; offsets move with the bundle) or arrive by IMAP later; the router's 10-minute duplicate window covers
replays (`docs/channels/README.md`). Recurring slots that fall into the gap run once after activation through the
user-jobs catch-up rule ([`docs/recurring.md`](../../recurring.md); U12 for the precise rule).

### 5.3 Role bundle `plur1bus.role-bundle/1`

A `tar` with two entries, in order: `role-bundle.json` and the unchanged `plur1bus.backup/1` archive.

```text
role-bundle.json: { schema: "plur1bus.role-bundle/1", handoverId, clusterId, epoch (source's current), sourceNodeId,
  sourceNodeKey (public, base64), targetNodeId | null (fresh target), createdAtMs, release: { version, coreContract,
  rpc }, platform: { os, arch }, archive: { name, sha256, bytes }, secretNames: [..], hostPaths: [{ key, value }],
  channels: [{ name, mode }], signature (Ed25519 over the canonical JSON without `signature`) }
```

| Unit | Source | In the bundle |
|---|---|---|
| Memory stores, engine data, sessions, dream ledger, API accounts and paired devices, recurring tasks | core-staged SQLite/engine snapshot | yes (archive) |
| `config.json` (agents, personas, channel bindings, schedules' config, providers, privacy) | plain unit; webhook secrets replaced by placeholders (M8 R4) | yes; channel webhook secrets regenerated on accept |
| `agents/` (persona and SOUL files, workspaces), `skills/`, `modules/`, `extensions/`, `catalog/`, `state/journal`, `state/system-jobs` | plain units | yes |
| Media outputs, media index, voice models, channel offset stores, extension data | **to verify per unit** (U1) | must be added to the backup allow-list where missing (plan RS3) |
| Downloaded model artefacts (ONNX, GGUF) | `models/` | **no**: the target downloads or receives them with D113's upload and verifies the pinned SHA-256 (ADR-006) |
| Vault values | secret store | **no** (§7) |
| `state/role.json`, `state/role/node.key`, `run/` | per node | **never** (I8) |

Limits: bundle ≤ 64 GiB in v1 (configurable cap, U12), the archive streams; verification before any change on the
target (the whole archive authenticates first, as the portable backup does).

### 5.4 Transfer

- **Desktop.** D113 WP4's mandatory upload path (SFTP with explicit offsets, resumable), into a temp file under
  `~/.cache/plur1bus-desktop/`, SHA-256 on the server before `role accept` reads it; the temp file is deleted after
  accept or discard. This is D113's offline mode: the data comes from the desktop, so the server needs no internet.
- **CLI `--ssh`.** `ssh -T -- user@host plur1bus role accept --bundle-stdin --json` with the bundle on stdin; no
  resume in v1 (a failed stream restarts from the start; Q6).
- **By hand.** Any copy; `role accept` verifies the checksum and the signature before touching anything.

### 5.5 Start on the server

The server's service is the systemd user unit with linger (D113 R7, §6.5). Activation restarts the supervisor's units,
not the service. A server without linger is refused at preflight (`role-target-unsupported`, reason `no-linger`),
because a primary that stops at logout would silently lose the channels.

### 5.6 Switch the desktop to client mode

The bundled harness on the MacBook keeps running in `client` role: supervisor, held core (compute-only if the engine
allows, U7), API on loopback for the app, node bridge to the primary. The app's default connection becomes the
server's SSH connection; the bundled connection stays in the list as *This Mac (client)*. The CLI on the MacBook
answers `role status` locally and points every write command at the primary with
`E_CONFLICT reason=role-not-primary` and a hint naming the primary.

### 5.7 Rollback window

- **Length:** `role.rollbackWindowDays`, default **7** (Q2), matching D114's hand-over undo window.
- **During the window** the former primary keeps its pre-handover home frozen (never written, never opened for write)
  and the role bundle it sent. Two actions:
  - **Failback** (default): a normal promote from the server back to the MacBook (server → `handing-over` →
    MacBook `pending` → … ). The server's newer state comes back; nothing is lost.
  - **Restore frozen** (typed confirmation of the server name): the server is demoted cooperatively and quarantines its
    state as a divergence archive; the MacBook activates its frozen state at epoch N+2. Everything the server did after
    the handover is set aside.
- **After the window** the frozen state becomes an ordinary `plur1bus backup` archive in `backups/` and the frozen live
  directories are removed — on explicit confirmation (tray, `role rollback --finish`), with a `1staid` reminder until
  then (Q5).

## 6. Demote, failback, re-promote, unreachable server

### 6.1 Demote

`plur1bus role demote --to <node>` on the primary is the source half of a promote towards an existing client: the same
steps 2–8 with the client as target. A client target replaces its frozen state only after a local backup.

### 6.2 Failback and re-promote

Failback is a demote of the server towards the MacBook within the rollback window; re-promote later is the same flow
again. Every round increments the epoch twice at most (commit plus a possible forced takeover); epochs are never reused.

### 6.3 When the server is unreachable

The client shows **"Primary unreachable since <time>"** (tray *Attention*, `1staid` row `role.primary-reachable`) and
does nothing else. It never starts channels, schedulers or writes. The person can wait, repair the server over SSH
(D113 management works without the harness API), or decide on a takeover.

### 6.4 Takeover

| Kind | Precondition | Effect |
|---|---|---|
| **Cooperative** (`role takeover`) | primary reachable | identical to a demote of the primary towards this client (§6.1) |
| **Forced** (`role takeover --force`) | primary unreachable for at least `role.takeoverMinUnreachableMs` (default **10 min**, Q3) by every path the client knows; typed confirmation of the primary's name; on a desktop a T3 surface | this client becomes `primary` at epoch = highest seen + 1 from **the data it has**: its frozen state (rollback window) or a fresh install; the UI states how old that data is and that the old primary, if it still runs, keeps writing until it next sees this epoch |

When the old primary returns it sees the higher epoch (node bridge hello, a desktop's `role status`, or the new
primary's contact) and turns `fenced` (§4.6). A forced takeover without any local data is allowed (disaster recovery
onto a fresh install) but warns that channels must be reconfigured from the vault values the person still holds.

## 7. Secrets

| Class | Example | Decision | Path |
|---|---|---|---|
| API keys and static provider secrets | Anthropic/OpenAI/xAI keys, OpenRouter key (PKCE-issued, static), embedding cloud keys | **transfer** | owner-only `secret set` on the target, value on stdin over the SSH session; never argv, env, file or log; zeroized after use on both ends; the source keeps its copy only as part of the frozen state (unused: its core is held) until the rollback window ends, because *restore frozen* and a forced takeover need it, then deletes it |
| Channel bot tokens and channel secrets | `channels.telegram.botToken`, Discord token, Matrix access token, IMAP password, Slack tokens | **transfer** (same path) | webhook secrets are **regenerated** on accept (M8 R4 placeholder rule) and re-registered at activation |
| OAuth/PKCE refresh tokens bound to a host | `openai:chatgpt-plan` (D110 registration with `host_id`) | **re-login on the server** | ADR-005 D110 headless ladder (loopback with `ssh -L`, then the documented transfer, then paste-back after a spike); the desktop shows the server's `login` flow through the tunnel; the source signs out after commit |
| Other refresh tokens (rotating) | Nous Portal, future kinds | **move** if the profile is not host-bound (single refresh owner, ADR-005: never both), otherwise re-login | `secret set` on the target, then delete at the source **before** activation, so two refresh owners never coexist |
| Device-code refresh tokens | none shipped (ADR-005: no vendor documents a usable grant) | re-login if one ships | — |
| Google ADC / service-account JSON | Vertex ADC | user ADC (`gcloud auth application-default login`): **re-login on the server**; a service-account JSON stored as a secret: **transfer** | ambient ADC files are host files and never copied |
| Delegated CLIs (`external_cli`) | Claude Code (`claude --bare`, D12), Codex CLI, Grok CLI | **re-login on the server** with the vendor's own flow (`claude setup-token` / `claude login`); the harness never reads or moves their credentials (ADR-005) | preflight lists which backends need a server-side login |
| Anthropic setup-token (`restricted`) | pasted `claude setup-token` value in the vault | **transfer** (it is a static stored secret; person-bound, risk notice unchanged) | as API keys |
| Workload identity (WIF) | `workload_identity` profiles | **never transferred**; each host its own identity source; the server is configured by its own CLI over SSH or by Owner RPC (WIF §12.5) | the client's own profile, if any, mints from its own source (WIF §9.7) |
| Node keys, device tokens of the app, D113 SSH keys | `state/role/node.key`, keychain entries | **never** | per node |

**Target store.** The server's secret backend must be usable before any value moves (`role-secret-backend-missing`).
On a headless Linux host without Secret Service that is ADR-005's encrypted file fallback with the B19 machine-bound key
file (`secrets.fileFallback.enabled = true`, `state/secrets/store.key`), which is **off by default until the owner
decides B19** (Q12). The promote plan shows this as an explicit step the Owner confirms.

**By-hand path.** The source writes the vault values into the portable-backup encrypted format (AES-256-GCM, scrypt)
with a passphrase file the person provides (≥ 16 bytes, 0600); the target reads it with the same file. The passphrase
never travels with the bundle.

## 8. Locality

### 8.1 `privacy.localOnly` once agents run on the server

Today "local" means loopback or an origin listed in `privacy.localEndpoints` (`privacy/local-only.ts`); a LAN address
is never local by itself. After a promote the agents run on the server, so its loopback models (an Ollama on the home
server) are local and the MacBook's are not.

**Recommendation (Q7):** "local" means **inside the owner's cluster**: the primary's loopback, origins in
`privacy.localEndpoints`, and models or compute on **enrolled nodes of this cluster** reached over the node bridge
(D51 b provider `node:<device>/<model>`; companion spec §9.1). Never a third party, never a cloud API. The one
place that decides (`local-only.ts`) gains the node rule; refusal codes stay `E_DENIED reason=local-only`.

Promote preflight shows two consequences: (a) loopback model endpoints in the source config now point at the server's
loopback (mapped or disabled, `role-host-paths`); (b) a target in public address space (transport classifier
`target-public`, typically a rented VPS) keeps the instance's data at a hosting provider: *Nur lokale Modelle* still
holds for inference, but the data lives on a machine the owner rents. The person confirms once per promote.

### 8.2 Capabilities that need the MacBook

| Capability | v1 | Later |
|---|---|---|
| Voice in the SPA (microphone in the app window) | **works**: the SPA captures in the client and streams to the server's API through the tunnel | — |
| Local models on the MacBook (MLX, Ollama, LM Studio) | **yes**, through the D51 b node bridge (companion spec) | — |
| In-core compute (embeddings, reranker, captioning) | **yes**, companion spec | — |
| Computer use, file pick, local files, notifications (`host.computerUse`, `host.filePick`, `host.notify`) | **no** for a remote primary: the host bridge is bundled-only today (`docs/desktop.md`: "Remote and native-local connections never start a bridge") | DS17 capabilities over the node bridge to the owner's own primary, each named in the device grant, enabled in the app, T3, D109 approvals (Q8) |

When the client is offline, a turn that needs a node capability gets the D51 fallback (another role, queue, or refuse
for local-only agents), never a silent cloud fallback.

## 9. Surfaces

### 9.1 CLI

| Command | Notes |
|---|---|
| `plur1bus role status [--json]` | role, epoch, cluster, primary, handover, frozen window, last contact; works with or without a supervisor; schema `role.status/1` |
| `plur1bus role promote --prepare --target-node <fp|new> [--plan] [--json]` | §5.1 primitive 1 |
| `plur1bus role promote --commit <receipt> [--json]` / `--abort` | primitives 3 and abort |
| `plur1bus role promote --ssh <user@host> [--port N] [--plan] [--yes] [--json]` | the composed CLI driver (Q6) |
| `plur1bus role accept <bundle>|--bundle-stdin [--vault-stdin|--vault-file F --passphrase-file P] [--replace] [--dry-run] [--discard]` | primitive 2 |
| `plur1bus role activate <token> [--json]` | primitive 4 |
| `plur1bus role demote --to <node> …` | §6.1, same flags as `promote` |
| `plur1bus role takeover [--force] [--confirm <primary name>]` | §6.4; `--force` refuses without the typed name on a TTY or `--confirm` |
| `plur1bus role rollback --failback|--restore-frozen [--confirm …]` / `--finish` | §5.7 |
| `plur1bus role members list|remove <node>` | cluster membership (primary only for `remove`) |
| `plur1bus role join --pairing <link|code>` | a fresh node joins as `client` without ever having been primary (a headless compute node, a second desktop): D35 pairing as device kind `node` or `desktop`, Owner confirms on the primary; the node records the cluster, epoch and primary |
| `plur1bus role resolve --as-client` | leave `fenced` after the divergence archive exists |

All mutating leaves take the install lock, print a plan first on a TTY, accept `--yes` for non-interactive runs, and
are `[experimental]` in v1. Exit codes come from `output::exit_code_for` of the error code; no new codes.

### 9.2 RPC and RBAC

Supervisor methods (the supervisor owns the role record; the core only reads it through the hold):

| Method | Action | Allowed |
|---|---|---|
| `role.status` | `role.read` | Owner, Admin, Operator (people); agents denied |
| `role.prepare`, `role.commit`, `role.abort`, `role.accept`, `role.activate`, `role.discard`, `role.demote`, `role.takeover`, `role.rollback`, `role.resolve`, `role.join`, `role.members.remove` | `role.manage` | **Owner only**, `humanOnly`, minimum surface **T3** (desktop app, CLI with TTY, web with step-up); `takeover --force` and `rollback --restore-frozen` additionally need the typed name in params |

- Web API: `role.status` joins `WEB_SUPERVISOR_METHODS`; the write methods are **not** exposed to the web SPA or WebMCP
  in v1 (Q13). The desktop app calls the bundled supervisor natively; for the server it uses the CLI over SSH.
- WebMCP forbidden set and the MCP server: the whole `role.*` family is never exposed (D114 §4.4 rule).
- `role.*` errors use existing codes only:

  | Code | Reasons |
  |---|---|
  | `E_CONFLICT` | `role-hold`, `role-not-primary`, `role-not-client`, `role-invalid-transition`, `role-fenced`, `role-target-not-empty`, `role-version-mismatch`, `role-rollback-expired` |
  | `E_LOCKED` | `role-busy` (setup, update, import or another role operation holds the install lock) |
  | `E_DENIED` | `role-takeover-too-early`, `role-unconfirmed` (a required typed confirmation is missing) |
  | `E_STORAGE` | `role-record-corrupt`, `role-snapshot-failed`, `role-snapshot-mismatch`, `role-checksum-mismatch`, `role-disk-low` |
  | `E_INVALID_PARAMS` | `role-bundle-signature`, `role-stale-epoch`, `role-bundle-foreign-cluster`, `role-receipt-invalid`, `role-commit-invalid`, `role-host-paths`, `role-invalid-input` |
  | `E_NOT_AVAILABLE` | `role-target-unsupported`, `role-target-unreachable`, `role-secret-backend-missing`, `role-clock-skew`, `role-quiesce-timeout`, `role-transfer-interrupted`, `role-lease-expired`, `role-health-failed`, `role-channel-not-live` |

### 9.3 Desktop UI and tray

- **Host page (D113 WP3/WP4):** a new action *Make this my primary server* on an installed, healthy host. Wizard:
  plan (preflight rows, secret classes, host paths, local-only notice, public-hoster notice) → confirm → progress per
  step (§5.2) → health and liveness rows → *Done* with the rollback deadline. *Abort* is offered until step 6.
- **Connection list:** a role chip next to the path chip: „Primär“ / "Primary" on the primary's row, „Client“ on
  *This Mac*. Never colour alone.
- **Tray header** (`tray.rs`): `PLUR1BUS — {connection} · {path} · {role} — {state}`; `{role}` is „Primär“, „Client von
  {server}“, „Übergabe läuft“, „Abgeschirmt“ (fenced) / "Primary", "Client of {server}", "Handing over", "Fenced".
  `HarnessState` is unchanged (it describes the connection's harness); a new `RoleLabel` field sits beside `PathLabel`.
  Badges: `handing-over` → *Busy*; `fenced`, "primary unreachable", `role.channel-conflict` → *Attention*.
- **Rollback:** the host page and Settings show the deadline and the two actions of §5.7.

### 9.4 `1staid check` rows

| Id | Status rules |
|---|---|
| `role.state` | info: role, epoch, primary; fail when the record is corrupt (I3) |
| `role.single-writer` | fail when a writer unit runs in a non-writer role (supervisor and core both report) |
| `role.primary-reachable` | client only: warn after 2 × heartbeat without contact, fail after `role.takeoverMinUnreachableMs` |
| `role.handover` | warn while `handing-over` or `pending` longer than the handover lease |
| `role.rollback-window` | info with the deadline; warn in the last 24 h; warn after expiry until `--finish` |
| `role.channel-conflict` | warn on a sustained Telegram `409` or a webhook overtaken (§4.6) |
| `role.divergence` | warn while a divergence archive is unreviewed |
| `role.secret-backend` | target-side preflight row (Q12) |

### 9.5 Audit

`role.promote.prepared|aborted|accepted|discarded|committed|activated|failed`, `role.demoted`,
`role.takeover.cooperative|forced`, `role.fenced`, `role.resolved`, `role.rollback.failback|restore-frozen|finished`,
`role.member.enrolled|removed`, `role.channel-conflict`. Detail keys: handover id, epochs, node fingerprints, bundle
SHA-256 and size, unit counts, step ids and reasons. Never secret values, names of other persons' data, or addresses
with credentials. D111 log events with the same names.

### 9.6 Configuration keys

| Key | Type | Default | `x-restart` | Meaning |
|---|---|---|---|---|
| `role.rollbackWindowDays` | integer | `7` | `live` | §5.7 (Q2) |
| `role.takeoverMinUnreachableMs` | integer | `600000` | `live` | §6.4 (Q3) |
| `role.handoverLeaseTtlMs` / `role.heartbeatMs` | integer | `120000` / `30000` | `live` | §4.8 |
| `role.quiesceBudgetMs` / `role.livenessBudgetMs` | integer | `60000` / `120000` | `live` | §5.2 |
| `role.maxBundleBytes` | integer | 64 GiB | `live` | §5.3 |

Role, epoch, members and handovers are **state** (`state/role.json`), not configuration. Writes Owner only
(`x-write-roles`), on WebMCP's forbidden list like every configuration write.

## 10. Hook points

### 10.1 WIF WP13 (WIF spec §12.5, PR #823)

- The server's WIF profiles are configured on the server: D113 install step 4 (`setup … --auth workload-identity`) or
  the `Workload*` `RemoteCommand`s of WIF WP13, or Owner RPC through the tunnel. The role switch calls the same
  commands; it adds none.
- Promote preflight lists WIF profiles of the source as **not transferable** and offers to configure the server's own
  source (WIF §12.5 inv. 5). The bundle carries the profile *definitions* in `config.json` but the server validates
  them against its own paths before activation (step 5); a profile whose source path does not exist on the server is
  disabled with a hint, never pointed at a copied token file (WIF R11, §9.7).
- After commit the client's own WIF profiles are disabled in `client` role (no cluster provider mints on a client);
  a client that later becomes primary re-validates them.

### 10.2 D114 federation

- D114 instance key ≙ this spec's node key (§4.2); D114 adopts it.
- Federation peers are **instances**; the cluster is **one instance** spread over nodes. A federation peer record points
  at the cluster's primary; after a promote the primary's origin changes, so peers get a `federation/hello` with the new
  origin from the new primary (signed with the same instance identity → the cluster key; Q-open in D114 when built).
  Until D114 is built nothing changes.
- D114 leases (loans) live on the primary only; a client never borrows or lends.

### 10.3 Shared compute (companion spec)

The companion spec defines the node bridge's compute capability, the job queue (primary only), placement and vector
consistency. This spec provides: roles (only `primary`/`standalone` run the queue), the node attachment lease (§4.8),
membership (`role members`) and the epoch on every node message.

### 10.4 D116 confidentiality

The bundle moves the whole store unchanged (levels, relationships, the step-up rules); no filter runs on export,
because the data stays inside one instance. The companion spec decides what of it a compute node may see.

## 11. Threat model

| Threat | Asset | Protection | Residual risk |
|---|---|---|---|
| Two primaries after a laptop wakes | channel state, memory consistency | I2 durable commit order, epoch fencing, client never self-promotes | — |
| Forced takeover during a partition | consistency | minimum unreachable time, typed confirmation, epoch, quarantine on reconnect, channel-conflict signal | writes on both sides until reconnect; manual merge |
| Forged or replayed commit token / bundle | authority | Ed25519 signatures bound to cluster, epoch, bundle hash and target node; epochs never reused | an attacker who runs code as the harness's OS user on the source (already owns the instance) |
| Malicious server substitutes data in the receipt | source's decision | receipt signed with the target key confirmed in preflight (D113 host key + node fingerprint) | — |
| Secrets in transit or at rest | provider keys, channel tokens | stdin only, never argv/env/log/bundle, zeroize, owner-only `secret set`; rotating refresh tokens moved, static secrets held unused at the source only until the rollback window ends | values held in process memory during transfer; a second at-rest copy on the MacBook during the window |
| Bundle stolen from `~/.cache` or a USB stick | instance data (memories, accounts DB with hashes) | temp files 0600 and deleted after accept; by-hand path warns that the bundle is unencrypted like a `backup` archive (vault values are separate and encrypted) | a stolen by-hand bundle without vault is still the person's memories |
| Agent triggers a promote or takeover | authority | `humanOnly`, Owner, T3, never on WebMCP/MCP, typed confirmations | — |
| Compromised server after promote | everything on it | same as any primary; D113 host-key pinning; rollback window keeps the frozen copy on the MacBook | data already on the server |
| Stale data used for a forced takeover | consistency | UI states the data's age; divergence archive of the old primary | loss of the old primary's newest writes if it never comes back |

## 12. Failure classification

| Class | Reasons | Behaviour |
|---|---|---|
| **Refused before any change** | `role-version-mismatch`, `role-target-unsupported`, `role-target-not-empty`, `role-disk-low`, `role-target-unreachable`, `role-secret-backend-missing`, `role-host-paths`, `role-clock-skew`, `role-invalid-transition`, `role-invalid-input`, `role-takeover-too-early`, `role-unconfirmed` | nothing changed; rerun after fixing |
| **Aborted, writers resume** | `role-quiesce-timeout`, `role-snapshot-failed`, `role-snapshot-mismatch`, `role-transfer-interrupted` (after lease expiry), `role-checksum-mismatch`, `role-bundle-signature`, `role-stale-epoch`, `role-bundle-foreign-cluster`, `role-health-failed` (pre-commit), `role-receipt-invalid` | source back to its previous role; target discards and restores its backup |
| **Retryable after commit** | `role-commit-invalid` (wrong file), a crash during activation, `role-transfer-interrupted` of the token | activation is idempotent with the same token; the source keeps the token file (`state/role/commit-<handover id>.json`), resends it at the next contact, and shows *Client of <server> — activation pending* until the server confirms |
| **Degraded primary** | `role-channel-not-live`, `role-health-failed` (post-commit) | server stays primary; *Fix* or *Failback* |
| **Fail closed** | `role-record-corrupt`, `role-fenced` | no writers; the owner repairs: `role resolve` for a fenced node; for a corrupt record a `1staid repair` step shows the last audited `role.*` transition and writes a new record only from the owner's typed answers (role, cluster, epoch), keeping the corrupt file as `role.json.corrupt-<ms>` |

## 13. Test strategy

- **Unit (Rust, no network):** the state machine table exhaustively (every pair, closed refusal); epoch comparison
  and fencing; role store (missing → standalone, corrupt → no writers and never overwritten, unknown field refused,
  atomic write, 0600); lease timing with an injected clock; commit-token and receipt signing/verification with
  test-generated keys (never committed); takeover eligibility; bundle header canonical JSON and signature.
- **Unit (TS, no network):** role hold admission table (reads allowed, writes `E_CONFLICT role-hold`, background start
  deferred, never released by itself); supervisor gate selects units by role.
- **Two-instance integration harness** (Linux/macOS CI, loopback only): two homes, two supervisors, a fake core
  (`fake-core.mjs`) and the real core in separate jobs; the CLI by-hand driver runs prepare → accept → commit →
  activate; kill points between every step (`PLUR1BUS_TEST_ROLE_FAIL_AT=<step>`, honoured only with
  `PLUR1BUS_ALLOW_TEST_INTERNALS=1`), asserting I1/I2 after each: never two writer-allowed records, no writer unit
  running in a non-writer role; source sleep simulation (suspend the source process between 5 and 6); forced takeover
  plus reconnect → fenced, divergence archive written; failback round trip with byte-equal stores.
- **Channel fence:** a fake Telegram Bot API on loopback answering `409` to the older poller; asserts the
  `role.channel-conflict` row after the threshold and no role change.
- **Secrets never leave:** a full by-hand and `--ssh` (against a loopback `sshd` in the D113 container job) promote with
  marker secrets; scan every file, log, argv record (fake binary recorder), audit line, bundle and receipt.
- **Desktop:** D113's fixture russh server and `fake-plur1bus` scenarios for the new `RemoteCommand`s; Playwright for
  the wizard, rollback and tray texts (axe light/dark, DE/EN, 44 px, 400 px).
- **Real run (manual owner worksheet):** MacBook → Ubuntu VM (the owner's NAS VM), Telegram test bot, notebook off for
  an hour, messages answered, failback.

## 14. Prerequisites

| # | Prerequisite | Needed for | Owner workstream | Status on `main` |
|---|---|---|---|---|
| P1 | D113 WP1–WP4 (SSH core, profiles, native commands, install/manage with upload) | desktop driver | Track D | open (spike only) |
| P2 | D113 WP5 + M3 P1–P3 (desktop pairing, owner bootstrap, `/api/v1/meta`) | opening the server in the app, node bridge pairing | M3 | open (#581 proposed) |
| P3 | Backup allow-list covers every unit of §5.3 (U1) | complete snapshot | M8 / this plan RS3 | partial |
| P4 | B19 owner decision (file fallback on headless servers) | target secret store | ADR-005 | open |
| P5 | Compute-only engine mode or no in-core compute on clients (U7) | client core that never opens frozen stores | engine | unknown |
| P6 | WIF WP13 | WIF on the server | auth | gated (PR #823) |

## 15. Owner questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Register this as **D118** (role switch) and the companion as **D119** (shared compute), or one record? | Two records: they ship in different phases and D119 has its own owner decisions (runtimes, privacy tiers). |
| Q2 | Rollback window length; automatic failback when post-commit health fails? | **7 days** (D114 hand-over undo); **no automatic failback** — a degraded primary with one-click failback avoids flapping between machines. |
| Q3 | Minimum unreachable time before `takeover --force`? | **10 minutes** plus typed confirmation. 120 s (the lease TTL) is too short for a laptop on bad Wi-Fi; longer only delays real recovery. |
| Q4 | Divergent state after a forced takeover: automatic merge? | **No.** Quarantine as a divergence archive; selected memories can be imported later through `memory.import` with provenance. |
| Q5 | After the window: remove the frozen live state automatically, or on confirmation? | Convert to a `backup` archive automatically; **remove the live directories only on confirmation** (tray / `role rollback --finish`), with a `1staid` reminder. |
| Q6 | CLI driver over the **system OpenSSH client** (`role promote --ssh`), although D113 R3 chose russh for the GUI? | **Yes, CLI only.** On a terminal the person's own ssh, config and agent are the expected tools; fixed argv, `-T`, `--`, no options injected; the GUI stays on russh. The by-hand path needs no SSH at all. |
| Q7 | Meaning of *Nur lokale Modelle* after a promote? | **Inside the owner's cluster** (primary loopback, `privacy.localEndpoints`, enrolled nodes over the node bridge); never a third party; a public-hoster notice at promote. |
| Q8 | May the primary use MacBook-only capabilities (computer use, files, notifications) through an online client? | **Not in v1** beyond SPA voice, local models and compute. Later through DS17 capabilities over the node bridge with per-capability grants, T3 and D109 approvals. |
| Q9 | Warm standby (the client pulls a periodic encrypted copy) to make forced takeovers less lossy? | **Not in v1.** Revisit after real use; it doubles the data at rest on a laptop. |
| Q10 | Channel bot tokens and API keys: transfer or re-enter on the server; and does the MacBook keep its copy during the rollback window? | **Transfer** over stdin into the server's vault; the MacBook keeps its unused copy with the frozen state until the window ends (needed for *restore frozen* and a forced takeover), then deletes it. Rotating refresh tokens always move (Q11). |
| Q11 | Host-bound OAuth (ChatGPT plan, D110 `host_id`): transfer or re-login? | **Re-login on the server** through the tunnel; other rotating refresh tokens **move** (deleted at the source before activation). |
| Q12 | B19 for headless primaries: enable the machine-bound file fallback as a promote step? | **Yes, as an explicit, Owner-confirmed step** of the promote plan when no keyring exists; the passphrase mode stays unbuilt. This implies deciding B19 for servers. |
| Q13 | Role writes in the web SPA? | **No in v1**: desktop native commands and the CLI only; `role.status` is readable in the web. |
| Q14 | Target data: refuse a non-empty target unless `--replace` (with an automatic backup)? | **Yes.** A target with its own agents or memories is a federation case (D114), not a promote target. |

## 16. Unknowns (not verified in the repository)

| # | Unknown | Why it matters | How to settle |
|---|---|---|---|
| U1 | Which state the M8 backup omits: media outputs (`OutputStore`), media index, voice models, channel offset stores (Telegram `FileOffsetStore` path), extension data (`ext_data`), `state/media-search.json` | an incomplete snapshot loses data or redelivers messages | RS3 inventory test: a home with every unit populated, `backup create`, diff against the home |
| U2 | Engine and LanceDB store portability macOS arm64 → Linux x64/arm64 through `backup restore` | the main promote direction | two-instance CI job across runners; owner VM run |
| U3 | Approval HMAC chain and audit hash chain continuity on a new host (`docs/audit-chain.md`, key in the secret store) | `audit.verify` after promote | test restore + `audit.verify` on the target |
| U4 | Which Telegram poller receives `409` when two poll; whether `getMe` from a second host disturbs an active poller | channel fence signal, pre-commit credential check | loopback fake per documented behaviour, then one manual test bot run |
| U5 | No `installationId` on `main` (only in import-extensions); D113 §7.1 assumes it in `run/api.json` | the desktop detects a reinstalled server | M3 P3; this spec uses `nodeId` meanwhile |
| U6 | `ring` as a direct dependency of `crates/plur1bus` (already resolved through `plur1bus-ext`) under the dependency policy | node keys and signatures | dependency record in RS4 |
| U7 | Whether the pinned engine can serve `embed()` without opening stores (compute-only) | a client core that never touches frozen stores | engine contract check (`EmbeddingService` exists in the Rust engine contract); otherwise no in-core compute on clients |
| U8 | Whether channels run in the core's switchboard, as supervisor modules, or both, per channel | which gate stops them | inventory in RS1/RS2 |
| U9 | How many absolute host paths `config.json` holds (workspace roots, vaults, attachments, loopback model endpoints) | mapping at accept | inventory over the config schema in RS3 |
| U10 | Paired phones and browsers (device store moves with `accounts.db`) keep pointing at the MacBook's origin | they must re-pair or learn the new origin | M3 pairing behaviour once P2 lands |
| U11 | WIF §12.5 and WP13 are in open PR #823, not on `main` | §10.1 wording | re-check when #823 merges |
| U12 | Snapshot and transfer duration for large stores; the exact catch-up rule of recurring slots missed during the gap | the size cap and the downtime the person sees | measure in the two-instance job; read `user-jobs` catch-up code in RS2 |
| U13 | systemd linger default on the target distributions (D113 open point) | a primary that stops at logout | D113 WP6 real-install job |

## 17. Alternatives considered

- **Raft/etcd-style consensus or a witness node:** needs three nodes or an extra service for a one-person setup; the
  primary must run alone while the laptop is off. Rejected for v1.
- **Active-active with CRDT memory:** two writers on channels are impossible anyway (one bot token, one poller); a
  CRDT store is an engine rewrite. Rejected.
- **Federation (D114) between the MacBook and the server:** D114 links instances of different owners and keeps two
  writers; the owner wants one instance. Rejected; D114 stays for its own purpose.
- **Plain `backup create` + `restore` documented as a recipe:** no fencing, no commit point, no channel hand-over, no
  rollback; it is the snapshot layer of this design, not the design.
- **Leader lease renewed by clients:** the primary would stop when all clients are off — the opposite of the request.
