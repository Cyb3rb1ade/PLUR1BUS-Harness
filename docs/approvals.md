# Permissions and approvals (D109)

Status: D109 D1-D9 implemented on branch `feat/d109-approvals-grants` (2026-10-07). Hand-written. Authority: D109 in
`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` (from "D109 - Permission and approval model"). Code:
`packages/core/src/policy/` (decision), `packages/core/src/approvals/` and `packages/core/src/grants/` (store, service, RPC),
`packages/core/src/rbac/{surface,connection-surface}.ts` (surface trust), `crates/plur1bus/src/commands/{grant,approval}.rs`
(CLI). Reference pages: `docs/policy-evaluator.md` (the pure evaluator), `docs/rbac.md` (RBAC and human-only actions),
`docs/cli.md` (generated), `docs/rpc.md` (generated).

This page is in two parts, **English** (complete) and **Deutsch** (the same chapters, same numbering, shorter). Tables and
commands are given once, in the English part. Where the code and the spec differ, this page describes the code and says so
(chapter 9 and the notes marked "Deviation").

# English

## 1. The model in one paragraph

Every tool call an agent makes goes through one function, `decide()` in `packages/core/src/policy/decide.ts`, called by the
tool dispatcher after argument validation and before execution. It returns exactly one of `allow`, `ask` (a person must
decide) or `deny` (class `never`). Precedence, first match wins: credential deny-list, then `never` capabilities, then the
behaviour-layer `tools.deny`, then grants, then roots and defaults. Outside the agent's roots the default is approval.
**Nothing is ever approved automatically**: not on a timeout, not by an absent answer, not by a headless run, not by a model
claiming that the user agreed, not by a broken store. Only a person, acting on a surface that is trusted for the risk of the
request, can approve or grant, and that decision is a record in a tamper-evident store (chapter 5).

The two layers are separate and both must pass. `authorize()` (`docs/rbac.md`) decides what a human principal may ask of the
harness; `decide()` decides what an agent may do for that person.

### 1.1 Precedence in the code

| Step | Rule | Result |
|---|---|---|
| 1 | `flags.denyListHit` (computed by the path layer, never by the evaluator) | `deny` reason `deny-list` |
| 2 | capability class `never` (`harness.admin`, `credential.entry`, `captcha.solve`, `input.monitor`, `policy.bypass`), an unknown capability id, a `secrets.use` without a declared slot | `deny` reason `policy-never` |
| 3 | `tools.deny` of the behaviour layer: exact names or `*` globs, case-folded; an entry that is not a non-empty string denies everything | `deny` reason `policy-never` |
| 4 | subject limits: an A2A peer reaches no tool; token scopes only narrow; a sub-agent needs the capability in its hand-off scope | `deny` |
| 5 | class from roots and defaults, the per-agent move between `allowed` and `approval`, then the floors below | `allow` (default or override), or continue |
| 6 | a grant that applies (chapter 2) | `allow` via `grant` |
| 7 | fatigue guards: the same action hash already denied in this task, or 10 prompts in the last hour for this task | `deny` reason `repeat-denied` or `prompt-cap` |
| 8 | otherwise | `ask` |

Floors nobody lowers (the class becomes at least `approval`): a privileged or irreversible call, a batch (more than 20 targets,
or flagged), effect `money`, `external` or `local-destructive`, and any write outside the roots. A per-agent `allowed` override
never lifts the approval that applies outside the roots, and a capability that is not lowerable (grant ceiling `once`, minimum
surface T3, or class `never`) ignores overrides. An effect string outside the vocabulary counts as `money`.

## 2. Grants

A grant lets an agent use a capability without a prompt each time. It belongs to a *(person, agent)* pair: a grant one person
gives an agent never applies when that agent acts for another user. Only a person creates one: either as the answer to an
approval request (`once`, or a wider scope chosen while approving) or with `plur1bus grant add` / `grant.create` (`task`,
`session`, `always`).

### 2.1 Scopes and lifetimes

The numbers live in `DEFAULTS` in `packages/core/src/policy/capabilities.ts` and nowhere else.

| Scope | Bound to | Ends |
|---|---|---|
| `once` | one action: the SHA-256 of capability, tool, canonical arguments and resolved targets | on use (consumed atomically with the start of execution), or 10 minutes after creation unused |
| `task` | the task id | when the task ends (`GrantStore.endTask`), or 24 hours after creation |
| `session` | the session id | when the session ends (`GrantStore.endSession`), or after 7 days without use |
| `always` | the *(person, agent)* pair, optionally a project; a headless job's standing grant also carries a `jobId` | revocation, or 90 days without use (restarts at every recorded use); `--expires` can only shorten it |

A decision that uses an `always` grant at least 90 days old carries `reviewDue` (`grantReviewDue`). Uses are chained at most
once per hour per grant (`USE_RECORD_GRANULARITY_MS`), which is all the 90-day clock needs.

*Deviation (action hash):* the spec binds `once` to capability, tool, arguments, targets, `cwd` and environment names. The
dispatcher hashes capability, tool, canonical arguments and targets (`ToolDispatcher.#buildCall`); `cwd` and environment names
are not part of the hash today.

### 2.2 Limits per capability

Columns: default class inside / outside the roots ("ask" is the class `approval`), highest grant scope (the ceiling; "-" means
no standing grant exists), lowest surface that may decide (chapter 3), base risk.

| Capability | Inside / outside roots | Ceiling | Min surface | Base risk |
|---|---|---|---|---|
| `fs.read` | allowed / ask | always | T1 | low |
| `fs.write` | allowed / ask | always | T1 | low |
| `fs.delete` | ask / ask | task | T2 | high |
| `shell.exec` | ask / ask (allowed for an allowlisted command inside the roots) | always | T2 | medium |
| `proc.signal` | ask | session | T2 | medium |
| `pkg.change` | ask | once | T2 | high |
| `sys.read`, `net.fetch`, `secrets.use` (declared slot only), `agent.delegate` | allowed | - | - | low |
| `clipboard.read` | ask | session | T1 | low |
| `net.submit` | ask | session | T2 | medium |
| `comm.send` | ask | session | T2 | high |
| `net.publish` | ask | always (public: once) | T2 (always: T3) | high |
| `money.spend` | ask | once | T3 | critical |
| `os.privilege` | ask | once | T3 | critical |
| `os.grant` | ask | always | T3 | high |
| `os.script` | ask | session | T2 | medium |
| `screen.capture` | ask | session | T2 | medium |
| `ui.control` | ask | session | T2 | high |
| `remote.control` | ask | always | T3 | critical |
| `harness.admin`, `credential.entry`, `captcha.solve`, `input.monitor`, `policy.bypass` | **never** | - | - | critical |

Further ceilings are computed per call (`maxScopeFor`): a batch is `once` only, a target in a home, drive-root or system tree
is at most `task`, a public publication is `once`. `grant.create` refuses a `never` capability (`E_DENIED` reason
`policy-never`), a scope above the ceiling (`E_INVALID_PARAMS` reason `ceiling-exceeded`) and a scope the connection's surface
is too low for (`E_DENIED` reason `surface-untrusted`). A `once` grant cannot be created directly; it exists only as the answer
to a request. For a capability with no ceiling that a floor still forces to ask, approving is a single use of the request
itself and creates no grant.

A grant matches by `action` (`once`), by `capability` (the whole capability inside the roots, never outside them), or by `path`
with `read` or `write` access (write implies read) and a `recursive` flag; a non-recursive path grant covers the directory's
direct children only. No standing grant applies to a batch, a privileged call or effect `money`. A `shell.exec` capability grant
without an OS sandbox applies only if the person acknowledged "not sandboxed" when creating it. When a person approves a request
with a scope wider than `once`, the grant is narrowed to the call's own targets (the parent directory of each target,
non-recursive, with the call's access) and is never built from a masked or truncated target list.

A grant also stops applying when it is revoked, consumed, past its lifetime or `--expires`; when it was created on a surface
below what the call now needs; when it is bound to another task, session or project; and, for standing grants, when the turn is
tainted and has read private data (3.5).

### 2.3 Revocation

`plur1bus grant revoke <id>` / `grant.revoke` is immediate: the next `list` or `get` no longer yields the grant; a call that is
already running finishes, the next call is decided again. Revoking an ended grant changes nothing. Revocation only narrows, so a
broken chain or a failing audit line never blocks it.

## 3. The approval flow

When `decide()` answers `ask`, the dispatcher hands an `ApprovalAsk` to the approval service (`approvals/service.ts`). The
service stores a request, announces it, and the call waits for a person.

### 3.1 What a request contains

The harness computes everything a person sees; the model writes none of it. A request (`ApprovalRecord` on the wire) carries:
the capability, tool, effect, risk (`low`, `medium`, `high`, `critical`) and `reversible`; the computed flags; the targets
(redacted; at most 50 are stored, 200 are sent); a summary that is the canonical JSON of the arguments, redacted and cut to
2048 characters, plus the size and SHA-256 of the full arguments; the subject (kind and agent id), the principal and the
turn, task and session ids; the action hash; the grant options (narrowest first, each with the surface it needs) and the
`requiredSurface` for the narrowest one; `tainted` and `taintSuspended`; the surface the call came from. A request binds
*(request id, action hash, principal, subject, turn, task, session)* and a one-time nonce. The nonce stays inside the core: it
is not in any RPC record or notification; a session decides without it, and only a channel relay that holds one passes it back
for comparison.

*Deviation (what is shown):* the spec also lists a unified diff, the provenance of the turn and the model's reason labelled
"unverified". The record has the redacted argument summary, the targets and the `tainted` flag; it has no diff and no model
reason.

### 3.2 Surface trust, T0 to T3

A decision is accepted only from a surface that is trusted for the request (`surfaceMayDecide`): the surface must be at least
`requiredSurface` for the chosen scope, the scope must be within the ceiling, and a T1 surface may decide only a `low` risk
`fs.read`, `fs.write` or `clipboard.read`. The required surface is the larger of the capability's minimum and the level of its
risk (low T1, medium and high T2, critical T3); `always` for `fs.write` or `shell.exec` outside the roots, `always` for
`net.publish` or `remote.control`, a public publication and a home, drive-root or system-tree target all need T3.

| Level | Surfaces (`rbac/surface.ts`, a pure function of facts the core established) | May decide |
|---|---|---|
| T3 | desktop app; CLI on a TTY of the owning OS user; web with a step-up (WebAuthn or TOTP) within the last 5 minutes | everything decidable |
| T2 | web session without a current step-up; a private chat with a linked identity, a valid one-time nonce and a first-party channel module (a third-party module only when the person opted it in) | low to high risk; not `money.spend`, `os.privilege`, `remote.control`, `always` grants that need T3 |
| T1 | the inbound ACP editor that started the session | low risk `fs.read`, `fs.write`, `clipboard.read` only |
| T0 | group chats, unlinked identities, MCP clients, A2A peers, agents, model output, tool results, a CLI without a TTY, anything malformed or unknown | nothing |

**What the core actually derives today** (`rbac/connection-surface.ts`, used by every `grant.*` and `approval.*` handler):

- A connection that passed `core.auth` proved one thing: its peer could read `run/core.token`, a file of the owning OS user. The
  core cannot tell from the socket whether a human sits at a terminal, whether the peer is the desktop app, or whether it is a
  process an agent started as the same OS user. So a **person principal on a token connection without attestation is T1**
  (`UNATTESTED_LOCAL_SURFACE`; owner decision 2026-10-08, #192): only low-risk requests (`fs.read`, `fs.write` within roots,
  `clipboard.read`) are decidable, and no standing grant above T1 – in particular no long-lived blanket grant – can be created
  without attestation. One OS-backed confirmation can lift a single approval to T2 (3.2.1).
- **T3 needs a server-side attestation**: `CoreOptions.rbac.attest` returns `desktop-app`, `cli` with TTY and owner, or
  `web-step-up`, and runs inside the core process; no request field reaches it. An attestation can only raise a person above T1.
  Nothing in this repository supplies one yet (the OS confirmation of 3.2.1 lifts to T2 only), so **no T3 decision is possible over RPC today**: `money.spend`, `os.privilege`,
  `remote.control`, a public `net.publish`, `os.grant`, and `always` for outside-roots `fs.write` or `shell.exec` cannot be
  approved or granted yet. The CLI's own TTY check (chapter 6) is a client-side guard against accidents, not a trust level the
  core sees.
- An agent principal, an absent principal and a principal that is not `kind: "person"` are T0, with or without attestation.
- The T1 (ACP editor) and channel (T2 by nonce) paths exist as pure functions and as `ApprovalService.decide` with a nonce; no
  editor or channel module is connected to them yet.

**Known limit.** An agent that can run shell commands as the same OS user can read `run/core.token` and connect as the local
owner. Since #192 that connection is only T1, so it can decide low-risk requests but not medium or high ones, and cannot mint
a standing grant above T1 on its own: for a T2 decision it would need the person at the machine to answer an OS dialog
(3.2.1), which the token does not give it. The remaining exposure is the low-risk set itself, a dialog the person confirms
without reading it (the text names agent, capability and scope), and a replaced helper binary (see the threat model); the exec
sandbox should still deny `run/` and `state/` to agent processes, and no tool may ever hand out the token.

#### 3.2.1 OS-backed attestation: one confirmation lifts one approval to T2

Owner decision (#192, option C): the promise "a person can approve anything for up to 90 days" stays, and it costs one
confirmation by the operating system. A person on an unattested local connection (T1) who decides a request that needs T2
(`requiredSurface` 2 for the chosen scope, for example `shell.exec`, `pkg.change`, an outside-roots `fs.write`) triggers this:

1. `approval.decide` without `attest`: the core answers `E_APPROVAL_REQUIRED reason=attestation-required` with the method it
   will ask for in `detail` (`touch-id`, `macos-password`, `windows-hello`, `uac`, `polkit`). Nothing is shown and nothing is
   decided, so a surface can say "Confirmation by Touch ID needed" first.
2. `approval.decide` with `attest: true`: **the core** starts the native helper `plur1bus-attest` (a child process, JSON over
   stdin/stdout, one line each way) and the operating system shows its own dialog on this machine: Touch ID with the account
   password as fallback (macOS, LocalAuthentication `deviceOwnerAuthentication`), Windows Hello or, without it, the UAC consent
   prompt (Windows), polkit `org.plur1bus.approve` with the user's own password (Linux, policy file shipped in
   `crates/plur1bus-attest/policy/`). The dialog text says which agent, which capability and which scope.
3. On success the core decides this one request at surface 2 and records `decisionSurface 2`, the audit line carries
   `attestedVia: "attested:<method>"`, and the grant (every scope, including `once`) stores the same origin (`attestedVia` on
   `GrantRecord`, part of the chained grant definition, so it cannot be edited out of the row unnoticed). A `session` or
   `always` grant created this way is a normal T2 grant, up to 90 days unused for `always`.

What an attestation is bound to (all checked by the core, none of it taken from the helper's say-so alone):

- **The concrete approval.** The hash sent to the helper covers the request id, its action hash, the capability, the scope (so the
  duration), the delegable flag, the agent and the person. A confirmation for `session` is not one for `always`, and not one for
  another request.
- **A nonce, once.** A fresh random nonce per attempt; the helper must echo it with the action hash. A reply with a nonce the
  core did not issue is `mismatch`; one the core already consumed is `replay`. A nonce is spent whatever the reply says.
- **At most 60 s** (`MAX_ATTEST_TTL_MS`): the core kills a helper that is still waiting, and a confirmation time outside the
  attempt's window is `mismatch`.
- **Fresh.** Every request opens a new OS dialog; there is no cached `sudo`-style timestamp and no remembered authorization
  (the polkit action has no `_keep`).

When it does not apply or does not work, the approval simply stays where it was:

| Situation | Answer |
|---|---|
| A request T1 may decide (low risk) | decided at T1; `attest` is ignored |
| The request needs T3 (`critical` risk, `always` outside-roots `fs.write` or `shell.exec`, `net.publish`, `remote.control`, ...) | `E_DENIED surface-untrusted`, no dialog: the OS confirmation lifts to T2 only |
| An agent principal | `E_DENIED agent-principal`, the helper is never started |
| A decision relayed with a nonce (a chat channel) | never opens a dialog on the host; `surface-untrusted` |
| No helper (not installed, container mode `PLUR1BUS_CONTAINER=1`, no graphical session, no polkit agent) | `E_NOT_AVAILABLE reason=attestation-unavailable`; the request stays pending at its T1 limits and nothing else breaks |
| Cancelled, timed out, failed, replayed or mismatched confirmation | `E_DENIED reason=attestation-failed`, `detail` = `cancelled` \| `timeout` \| `failed` \| `replay` \| `mismatch`; the request stays pending |
| A second decision of the same request while its dialog is open | `E_CONFLICT reason=attestation-in-progress` |

A connection the embedder attests through `CoreOptions.rbac.attest` (T3) never reaches the helper. `grant.create` is **not**
part of this flow: creating a standing grant directly (without an approval request) from a T1 connection is still
`surface-untrusted`; the person approves a request and picks the scope there.

Audit: `attestation.requested` (before the dialog; if it cannot be written, no dialog opens) and `attestation.result`
(`attestationOutcome` `confirmed` \| `cancelled` \| `timeout` \| `unavailable` \| `failed` \| `replay` \| `mismatch`, `method`), both
keyed to the request and the action hash, never the nonce. The core finds the helper through `PLUR1BUS_ATTEST_BIN` (set by the
CLI and the supervisor to the `plur1bus-attest` beside their own executable) or `CoreOptions.attestation.helper`; it must be an
absolute path to a regular file that is not group- or world-writable, owned by root or the core's user, in a directory with the same properties. A release build also pins the helper's content: the core passes `PLUR1BUS_ATTEST_SHA256`
(and `PLUR1BUS_ATTEST_TEAM_ID` on macOS, `PLUR1BUS_ATTEST_WIN_THUMBPRINT` on Windows) from the build constants, verifies the file
before every start and after the reply, and on a deviation answers `attestation-unavailable` with the reason in the audit
(`reason`: `helper-hash-mismatch`, `helper-signature-invalid`, ...), never a dialog. Threat model and limits: `docs/rbac.md` ("OS-backed
attestation") and `docs/security/os-attestation-2026-10.md`.

### 3.3 Timeouts and the absent person

- A foreground call waits **10 minutes** (`DEFAULT_FOREGROUND_WAIT_MS`). Then it returns "not approved, parked" to the agent
  (a typed `tool-not-approved` result naming the request id), which continues with work that needs no approval. The request
  stays open and decidable.
- The request lives **24 hours** from creation (`DEFAULT_REQUEST_TTL_MS`). After that its status is `expired`, which is a denial:
  a decision, a cancel or a use is refused with reason `approval-expired`. An approved request that was never used expires the
  same way.
- If a person approves a parked `once` request later, the grant that results is valid for 10 minutes; the agent has to repeat
  the identical call (same action hash) in that window.
- Nothing is approved by timeout, by closing a surface, by an abort (the request is cancelled), by a service shutdown or by a
  store error. All of these end as "not approved".

*Deviation (parking):* the spec has the whole task park as "waiting for approval" and repeats the notification once. The
implementation returns the parked answer to the single call; there is no task-level state and no repeated notification.

### 3.4 Approval fatigue

Implemented: a request identical (same action hash) to one denied in the same task is refused without asking (`repeat-denied`);
more than 10 requests for one task within an hour are refused, not queued (`prompt-cap`). The "task" is the task id, or the
session id when the call has no task. Not implemented from the spec: one open prompt per agent and surface, grouping several
requests on one card, the offer of a narrow standing grant after the third similar request, and a count on every surface.

### 3.5 Untrusted content (taint)

`decide()` honours a `taint` context: in a tainted turn that has read private data, standing grants and per-agent overrides for
`net.submit`, `comm.send`, `net.publish` and any `external` effect are suspended, and the call asks (a `once` grant still
applies). No producer of this context exists in the core yet; the field comes from the dispatcher's `policyContext` hook.

### 3.6 Hand-offs

A sub-agent never inherits the caller's grants. It may use a referenced grant only if the person marked it **delegable** when
deciding (`--delegable`, "including helpers"), the grant belongs to the same person and the hand-off's task, and the capability
is inside the hand-off's `constraints.scope`. `ApprovalService.policyContext` verifies each id in `approvalsHeld`; a forged,
foreign, revoked or non-delegable id is dropped and audited as `approvals.held-rejected` (reasons `unknown`, `revoked`,
`not-delegable`, `task-mismatch`, `foreign-person`).

## 4. Headless runs

A cron job, background job or other unattended run executes with `ctx.headless = { jobId }` and may use **only standing grants
created for that job** (scope `always` with that `jobId`, set through the `jobId` parameter of `grant.create`). Session and task grants of the person who created the job never carry over, and a job grant never applies
to an interactive call. When no such grant covers an approval-class call, `headlessGate` (`policy/headless.ts`) turns the
`ask` into `deny` reason `policy-never`, rule `headless:no-job-grant`, **at once**: nothing is asked, nothing parks, nothing
waits, and the approval service refuses a headless ask in the same way. Silence is never approval.

*Deviation from the spec:* section 9 of the D109 spec says such a job "parks and notifies". The implementation follows the
owner's ruling for D5: refuse immediately as `never`. Parking can be added later by letting the gate pass an `ask` through.
The CLI has no `--job-id` flag on `grant add`; job grants are created through `grant.create` (RPC).

## 5. The store and `verify`

State lives in `<home>/state/approvals.sqlite` (never in `config.json`), opened on first use so that starting the core does not
touch the keychain. Tables: `approvals` and `grants` (projections for listing), `approval_chain` (the append-only event log)
and `chain_head`. **The chain is the authority**; the tables are never decided from.

**The chain.** Every entry stores the MAC of its predecessor and its own MAC, HMAC-SHA256 over `(prev, seq, ts, kind, refId,
nonce, payload)`. A keyed head row `(seq, mac, tag)` pins the newest entry. The per-installation key is 32 random bytes in the
secret store (`approvals.chain-key.v1`), created on first use; a stored value that is not a valid key is `corrupt` and is never
silently replaced, because replacing it would orphan every entry. Entries: `approval.requested`, `approval.decided`,
`approval.cancelled`, `approval.used`, `grant.created`, `grant.used`, `grant.consumed`, `grant.revoked`, `grant.ended`. A grant's
definition is chained when it is created; on every read the table row is compared with it.

**What `verify()` detects** (`approval.verify`, `plur1bus approval verify`; read-only):

| Finding (`reason`) | Meaning |
|---|---|
| `seq-gap` | an entry was deleted or inserted in the middle |
| `prev-mismatch` | entries were reordered or spliced |
| `mac-mismatch` | an entry was modified |
| `truncated`, `head-mismatch` | the tail was cut, entries exist beyond the pinned head, or the head was altered or removed |
| `nonce-reuse`, `duplicate`, `binding-mismatch` | replay and rebinding: a nonce used twice, a request decided or used twice, a decision, cancel or use that does not match its request |
| `malformed` | a payload that cannot be read |

A result is `{ ok, entries, head }` or `{ ok: false, entries, head: null, brokenAt, reason }`. A broken chain is a finding, not an
RPC error.

**When the chain breaks** the core fails closed. Store operations that need the chain (request, decide, consume, cancel, list,
get) throw an integrity error, the approval service ends every waiting call as "not approved", and an `approvals.integrity-failure`
audit line is written. **Every grant at or after the first broken position is suspended**: `GrantStore` stops returning it to
`decide()`, and a grant whose row no longer matches its chained definition is suspended as well; `grant.list` shows the state
`suspended`. Grants chained before the break stay valid, but no new grant, request or decision can be recorded while the chain is
broken, and there is no repair command for this store. Revocation still works, because it only narrows. A revocation or an end that the chain records wins over a
table row that says otherwise.

**Not protected.**

- Code that runs as the person's OS user and can read the secret store holds the key and can forge a valid chain.
- Rolling the whole file back to an older, fully consistent copy is not detected.
- Deleting the database file removes every grant and request; the fresh empty chain verifies. Nothing becomes approved by it.
- The store detects tampering by anything weaker than these; it does not stop malware with the person's rights.
- `verify()` runs when asked (CLI or RPC). There is no scheduled check yet (chapter 9).

## 6. CLI and RPC

All commands are `[experimental]` and need a running core (`plur1bus daemon start`). Every command accepts `--json` and
`--home`; `--json` documents carry `schema`: `grant.list/1`, `grant.add/1`, `grant.revoke/1`, `approval.list/1`,
`approval.pending/1`, `approval.decide/1`, `approval.verify/1` (failures: `error/1`). The full flag lists are in `docs/cli.md`
(generated; do not copy them here). Ids: grants `grt_...`, requests `apr_...`.

```text
# Standing permissions (scope task, session or always; once exists only as the answer to a request)
plur1bus grant list --agent bernd --state active
plur1bus grant add fs.read --agent bernd --scope always --path /srv/shared/notes --access read --recursive --expires 30d
plur1bus grant add fs.write --agent bernd --scope task --task-id t_42 --path /srv/shared/out --access write
plur1bus grant revoke grt_0123456789abcdef01234567 --reason "project finished"

# Requests
plur1bus approval pending
plur1bus approval list --status pending --agent bernd --limit 20
plur1bus approval approve apr_0123456789abcdef01234567 --scope session
plur1bus approval approve apr_0123456789abcdef01234567 --yes --json
plur1bus approval deny apr_0123456789abcdef01234567

# Integrity
plur1bus approval verify
```

Behaviour worth knowing:

- `approval approve` prints the request first (on stderr, so `--json` stays one document), then asks `[y/N]` on a terminal.
  Without a terminal, or with `--json`, it refuses unless `--yes` is given, and it refuses before connecting to the core
  (exit 2, reason `confirmation-required`). With no `--scope` it uses the narrowest option the request offers; a scope the
  request does not offer is refused (reason `scope-not-offered`). There is no password path and no nonce argument.
- `grant revoke --reason` is echoed in the output only; `grant.revoke` takes just an id.
- The CLI sends no connection attestation, so the core sees it as T1 (3.2). For a request that needs T2, `approval approve`
  prints what the core asks for ("This decision needs one confirmation by the operating system: Touch ID ..."), repeats the
  decision with `attest: true` and the OS dialog appears on this machine; the result shows "confirmed by the operating system
  (attested:touch-id)". Without a helper it exits 2 with `attestation-unavailable`. Requests that need T3 cannot be approved from the CLI yet.
- Exit codes: **0** success. **1** the core refused or reported an error (`E_DENIED`, `E_NOT_FOUND`, `E_CONFLICT` for a request
  that is no longer pending, and so on), and `approval verify` when the chain is broken (it prints the first broken position and
  the reason). **2** a usage error found before any call (a missing `--task-id` or `--session-id`, `--limit` out of 1-500, `approve`
  without confirmation, a declined prompt) and `E_NOT_AVAILABLE` or `E_APPROVAL_REQUIRED` from the core. **3** `E_LOCKED`.

### RPC methods

Eight methods, all `x-server: core`, experimental, **for person principals only** (the surface level and the person come from the
authenticated connection, never from params). RBAC roles per method are in `docs/rbac.md`.

| Method | Purpose | RBAC action (roles) |
|---|---|---|
| `grant.list` | grants of the caller, filter `agent`, `capability`, `state` (`active`, `revoked`, `consumed`, `suspended`), paged | `grant.read` (Owner, Admin) |
| `grant.create` | a task, session or always grant; `match` is `capability` or `path` | `grant.write` (Owner, Admin) |
| `grant.revoke` | immediate; idempotent | `grant.write` (Owner, Admin) |
| `approval.list` | requests of the caller, filter `status`, `agent`, paged; `status=pending` is the pending queue | `approval.read` (Owner, Admin, Operator) |
| `approval.get` | one request | `approval.read` |
| `approval.verify` | verify the chain (read-only) | `approval.read` |
| `approval.decide` | `approve` or `deny`, with `scope` and `delegable` | `approval.decide` (Owner, Admin) |
| `approval.cancel` | withdraw a pending request | `approval.decide` |

Errors: a request or grant of another person is `E_NOT_FOUND`, exactly like an unknown id. `E_DENIED` carries a `reason`:
`agent-principal`, `policy-never`, `surface-untrusted`, `approval-mismatch`, `approval-used`, `approval-expired`.
`E_INVALID_PARAMS` carries `scope-unavailable`, `ceiling-exceeded`, `invalid-grant`, `duplicate-id` or `bad-cursor`; `E_CONFLICT`
carries `not-pending`; a broken chain is `E_STORAGE` with reason `approval-chain-broken`.

### Notifications

`approval.requested`, `approval.resolved` and `grant.changed` are opt-in: a subscription must name them in `events.subscribe`.
They carry the wire record without the nonce. The RPC server cannot address one connection, so the rule is applied to the whole
audience: if **any** subscribed connection is not the person the request or grant belongs to, or lacks `approval.read` /
`grant.read`, the notification is withheld from all of them (and logged). An agent that subscribes therefore silences the
notification instead of reading it.
`approval.resolved` is sent with the outcome `approved`, `denied`, `expired` or `cancelled`; `grant.changed` is sent for
`created` and `revoked`. An internal `approval.parked` event exists for relays and is not a wire notification.

## 7. Agents cannot touch this

`grant.read`, `grant.write`, `approval.read` and `approval.decide` are `humanOnly` actions in the RBAC table
(`packages/core/src/rbac/policy.ts`, `docs/rbac.md`). `authorize()` checks that flag first: a principal that is not explicitly
`kind: "person"` is refused with `E_DENIED` reason `agent-principal`, whatever its role, object rights, token scopes or
break-glass grant. Every handler repeats the check before any store is opened, so a handler registered without the RBAC guard
is still human-only, and an agent call never even opens the permission store. No role entry can open these actions to an
agent, and no RPC method takes a password, so there is no password or login route for an agent. The capability `harness.admin`
(class `never`) and `policy.bypass` cover the same ground on the tool side: no grant can exist for them. A model's claim that
a person approved something has no effect, because an approval exists only as a record in the store.

## 8. Audit

Every policy line goes through the core's audit sink (`logs/audit.log`, teed into the hash-chained `logs/audit-chain.jsonl`,
`docs/audit-chain.md`); the policy audit adds no second log. A decision that cannot be recorded refuses the call, and a grant
change is written inside the same database transaction as the change, so an unrecordable change rolls back. The outcome line
after execution is best effort, and so are lines about something already refused.

Actions: `policy.decision` and `policy.outcome` (every dispatcher decision and its result code), `approval.requested`,
`approval.decided`, `approval.parked`, `approval.expired`, `approval.cancelled`, `approval.consumed`, `approval.refused`,
`grant.created`, `grant.used`, `grant.consumed`, `grant.revoked`, `grant.ended`, `approvals.integrity-failure`,
`approvals.held-rejected`. A line carries who (person, agent, subject kind), session, task and job ids, tool, capability, effect,
risk, outcome, the rule or reason, grant id and scope, request id, action hash, the surface level of the call and of the
decision, the targets (at most 20, redacted), the boolean flags, and sizes and durations.

Redaction is an allowlist, not a filter: a key that is not listed is dropped, so file contents, tool results, arguments,
environment values and diffs cannot get in by accident. Every string passes the shared redactor (secret-shaped values, URL
credentials, `Authorization` credentials, credential-store paths) and is cut to 256 characters. Arguments are recorded as size
and SHA-256 only. The approval record keeps a redacted, length-bounded argument summary for the person who decides; the raw
arguments are not stored.

*Deviation:* the spec names `plur1bus approval audit` and a 400-day retention. There is no such command, and retention is that
of the audit files (`docs/audit-chain.md`), not a D109 setting.

## 9. Known gaps and follow-ups

1. **No productive tool dispatcher in the core.** `ToolDispatcher` exists and the turn loop can use one (`toolCalls`), but the
   core constructs none; the host tools (D106) are not built. Until then the decision path is exercised by tests and by the
   MCP bridge (`tools/mcp-bridge.ts`, which registers a server's tools as `net.submit` so a call runs only after `decide()`),
   and `call-paths.test.ts` guards that nothing else in `src` executes a tool. So the dispatcher is wired to the evaluator, the
   stores and the service, but the core does not yet construct a dispatcher: until D106 lands, no agent tool call reaches
   `decide()` in a running core.
2. **WebMCP does not forbid the new methods by name.** `FORBIDDEN_PREFIX` in `packages/webmcp/src/provider.ts` lists `admin.`,
   `secret.` and others but not `grant.` or `approval.`. RBAC still refuses an agent principal, but the spec's "refused as WebMCP
   tools" is not enforced at the WebMCP layer.
3. **Registry name protection.** `ToolRegistry` accepts any name matching `[a-z][a-z0-9_.-]{0,63}`, including `grant.create` or
   `approval.decide`. Such a tool would still go through `decide()` with its declared capability, but names that collide with
   the harness's own methods should be reserved.
4. **Two approval ports.** `tools/exec/types.ts` defines its own `ApprovalPort` (`request(req)`), separate from
   `tools/approval.ts`. `exec.run` calls `decide()` itself, writes its own audit lines and has no `begin()` or grant-use step:
   an approval it receives is not consumed, and a `once` grant that lets an exec call through is not consumed either, so it
   could be replayed within its 10 minutes. Exec should move onto the dispatcher (or the service port) before it is used with
   the permission stores. Its action hash does include `cwd` and the environment names.
5. **Notification delivery needs an all-person audience** (6): one non-person subscriber withholds a notification from everyone.
   A per-connection address in the notify API would make it selective.
6. **No T3 attestation** (3.2): `CoreOptions.rbac.attest` has no supplier, so T3-only requests cannot be decided; the CLI TTY
   and the desktop app are not yet attested. The residual same-user-token risk stays until the exec sandbox denies `run/` and
   `state/` to agent processes. The OS confirmation of 3.2.1 lifts to T2 only. It is also **not yet shipped**: the release
   archives, the installer and `update` carry `plur1bus` alone, so a released build has no `plur1bus-attest` (and no polkit
   policy) and answers `attestation-unavailable` until they do; a source build finds the helper beside `plur1bus`. The web
   approvals page is still a placeholder, so only the CLI drives the flow; the web texts (`approvals.attest.*`, de/en) and
   `attestationText()` are ready for it. The interactive macOS and Windows dialogs are verified by hand, not in CI.
7. **Ed25519 signatures and `1staid check approvals.integrity` are missing.** The spec has signed decisions for out-of-process
   verifiers (the host helper, a controlled desktop) and a start and daily integrity check; only the HMAC chain and the
   on-demand `approval verify` exist. Remote-control approvals on both ends (D108) are not built.
8. **Taint has no producer** (3.5), and the roots, deny-list flag, `cwd` and environment names depend on a tool's `classify()`
   hook. A tool without one counts as outside the roots (fail closed).
9. **Task and session end are not wired to grants.** `GrantStore.endTask` and `endSession` exist; the core does not call them
   yet, so a `task` grant ends by its 24 hours and a `session` grant by 7 days idle until it does.
10. **Smaller spec items not implemented:** parking of the whole task and the repeated notification (3.3), the fatigue features
    listed in 3.4, the model's reason and the diff on the request (3.1), `grant show`, `approval show` and `approval audit`,
    the `approval.parked` wire notification, `grant.changed` for `used`, `expired` and `suspended` (rpc.md describes them; the
    code sends `created` and `revoked`), the inbox review nudge for 90-day-old `always` grants, privilege escalation handling
    (`os.privilege` is a capability, the shell-layer rules for passwords are part of the not-yet-built host tools), and
    Settings and `V2Approvals` screens.

# Deutsch

Dieselben Kapitel in derselben Nummerierung, kürzer. Tabellen, Befehle und Zahlen stehen einmal im englischen Teil; hier
stehen die Regeln. Wo Code und Spezifikation abweichen, gilt der Code.

## 1. Das Modell in einem Absatz

Jeder Tool-Aufruf eines Agenten läuft durch eine einzige Funktion, `decide()`, nach der Argumentprüfung und vor der Ausführung.
Das Ergebnis ist genau eines von `allowed`, `approval` (eine Person entscheidet) oder `never`. Vorrang, der erste Treffer
gewinnt: Credential-Deny-List, dann `never`-Fähigkeiten, dann `tools.deny`, dann Grants, dann Roots und Standardwerte. Außerhalb
der Roots ist der Standard eine Freigabe. **Nichts wird je automatisch genehmigt**: nicht bei Zeitüberschreitung, nicht durch
fehlende Antwort, nicht in einem Headless-Lauf, nicht durch eine Behauptung des Modells, nicht bei defektem Store. Genehmigen
oder einen Grant erteilen kann nur eine Person auf einer Oberfläche, der das Risiko der Anfrage zugetraut wird; die Entscheidung
ist ein Eintrag in einem manipulationssicheren Store. `authorize()` (RBAC) und `decide()` sind getrennte Schichten, beide müssen
bestehen.

## 2. Grants

Ein Grant erlaubt einem Agenten eine Fähigkeit ohne Rückfrage. Er gehört zu einem Paar *(Person, Agent)*; handelt der Agent für
einen anderen Nutzer, gilt er nicht. Erteilt wird er nur von einer Person: als Antwort auf eine Anfrage (`once` oder ein weiterer
Scope) oder mit `plur1bus grant add` (`task`, `session`, `always`).

- **Scopes und Lebensdauer** (Zahlen aus `DEFAULTS`): `once` gilt für genau eine Aktion (Hash über Fähigkeit, Tool, Argumente,
  Ziele), endet mit der Nutzung oder 10 Minuten nach Erstellung; `task` endet mit dem Task oder nach 24 Stunden; `session`
  endet mit der Sitzung oder nach 7 Tagen ohne Nutzung; `always` endet durch Widerruf oder nach 90 Tagen ohne Nutzung, mit einem
  Prüfhinweis (`reviewDue`) ab 90 Tagen Alter. `--expires` kann nur verkürzen.
- **Grenzen je Fähigkeit:** die Obergrenze steht in Tabelle 2.2 (z. B. `money.spend`, `os.privilege`, `pkg.change` nur `once`;
  `fs.delete` höchstens `task`; `net.submit`, `comm.send`, `proc.signal` höchstens `session`). Ein Batch (mehr als 20 Ziele)
  ist nur `once`, ein Ziel in Home, Laufwerkswurzel oder Systembaum höchstens `task`, eine öffentliche Veröffentlichung nur
  `once`. `never`-Fähigkeiten (`harness.admin`, `credential.entry`, `captcha.solve`, `input.monitor`, `policy.bypass`) kennen
  keinen Grant. Ein Pfad-Grant deckt bei `--recursive` alles darunter, sonst nur die direkten Kinder; er trifft nie einen Batch,
  einen privilegierten Aufruf oder Effekt `money`. Bei einer Freigabe mit weiterem Scope wird der Grant auf die Ziele des
  Aufrufs verengt (Elternverzeichnis, nicht rekursiv).
- **Widerruf wirkt sofort:** der nächste Aufruf wird neu entschieden, ein laufender Aufruf endet normal. Widerruf blockiert
  weder eine gebrochene Kette noch eine fehlschlagende Audit-Zeile; ein Widerruf verengt ja nur.

## 3. Der Freigabe-Fluss

- **Inhalt einer Anfrage** (vom Harness berechnet, nie vom Modell): Fähigkeit, Tool, Effekt, Risiko, Umkehrbarkeit, Flags,
  Ziele und eine geschwärzte Zusammenfassung der Argumente (Größe und SHA-256 der vollständigen Argumente), Subjekt, Person,
  Turn-, Task- und Sitzungs-ID, Aktions-Hash, die angebotenen Grant-Optionen (engste zuerst, jeweils mit der nötigen
  Oberfläche), `tainted`. Die Nonce verlässt den Core nie. Abweichung: Diff, Herkunft des Turns und die als "ungeprüft"
  markierte Begründung des Modells sind nicht Teil des Records.
- **Oberflächen-Vertrauen T0 bis T3:** T3 Desktop-App, CLI an einem TTY des OS-Nutzers, Web mit Step-up (5 min); T2 Web ohne
  Step-up, privater Chat mit verknüpfter Identität und einmaliger Nonce auf einem Erstanbieter-Kanal; T1 der ACP-Editor, der
  die Sitzung gestartet hat (nur `low`: `fs.read`, `fs.write`, `clipboard.read`); T0 Gruppenchats, MCP-Clients, A2A-Peers,
  Agenten, Modellausgabe, Tool-Ergebnisse: darf nichts entscheiden. Die nötige Stufe ist das Maximum aus dem Minimum der
  Fähigkeit und der Stufe des Risikos (low T1, medium und high T2, critical T3).
- **Was der Core tatsächlich ableitet:** eine tokenauthentifizierte lokale Verbindung einer Person ohne Attestation ist **T1** (Owner-Entscheidung 2026-10-08, #192): nur `low` ist entscheidbar, und ohne Attestation entsteht keine Dauerfreigabe oberhalb T1.
  Eine einzelne Freigabe lässt sich mit EINER Bestätigung des Betriebssystems auf T2 heben (3.2.1).
  Der Core kann am Socket nicht erkennen, ob ein Mensch am Terminal sitzt, ob es die Desktop-App ist oder ein Prozess, den ein
  Agent als derselbe OS-Nutzer gestartet hat. **T3 gibt es nur mit serverseitiger Attestation** (`CoreOptions.rbac.attest`, läuft
  im Core, kein Request-Feld erreicht sie). Heute liefert nichts eine solche Attestation; deshalb sind T2- und T3-Anfragen (mittleres und hohes Risiko, `money.spend`,
  `os.privilege`, `remote.control`, öffentliches `net.publish`, `always` für `fs.write` oder `shell.exec` außerhalb der Roots)
  über RPC noch nicht entscheidbar, auch nicht per CLI. Agent-Principals und fehlende Principals sind immer T0.
- **Bekannte Grenze:** Ein Agent mit Shell als derselbe OS-Nutzer kann `run/core.token` lesen und sich als lokaler Besitzer
  verbinden. Seit #192 ist diese Verbindung nur T1: er kann Anfragen niedrigen Risikos entscheiden, aber weder mittleres oder
  hohes Risiko noch eine Dauerfreigabe oberhalb T1 erzeugen. Für eine T2-Entscheidung bräuchte er den Menschen am Gerät, der einen
  OS-Dialog beantwortet (3.2.1); das Token liefert das nicht. Die Exec-Sandbox sollte `run/` und `state/` weiterhin für
  Agent-Prozesse sperren, und kein Tool darf das Token herausgeben.
**OS-gestützte Attestation (#192, Option C).** Eine Freigabe, die T2 verlangt (etwa `shell.exec`, `pkg.change`, `fs.write`
außerhalb der Roots), kann eine Person auf einer unattestierten lokalen Verbindung (T1) mit EINER Bestätigung des
Betriebssystems erteilen: Touch ID (Passwort als Rückfall) auf macOS, Windows Hello oder die UAC-Abfrage auf Windows, polkit
(`org.plur1bus.approve`, eigenes Passwort) auf Linux. Ablauf: `approval.decide` ohne `attest` antwortet
`E_APPROVAL_REQUIRED reason=attestation-required` (`detail` = Methode, damit eine Oberfläche "Bestätigung durch Touch ID nötig"
anzeigen kann); mit `attest: true` startet **der Core** den Helfer `plur1bus-attest` (Kindprozess, JSON über stdin/stdout), das OS
zeigt seinen eigenen Dialog (Agent, Fähigkeit und Scope stehen im Text), und bei Erfolg wird genau diese Freigabe als T2 gebucht
(`decisionSurface 2`, Audit `attestedVia: "attested:<methode>"`, der Grant trägt dieselbe Herkunft, auch bei `once`; bis zu 90
Tage bei `always`). Die Bestätigung gilt nur für diese Freigabe: gebunden an Anfrage, Aktion, Scope (also Dauer), Agent und Person,
Nonce nur einmal, höchstens 60 s, jedes Mal ein frischer Dialog ohne Zwischenspeicher. Nicht möglich bleibt: Agent-Principals
(Helfer startet nie), per Nonce weitergereichte Kanal-Entscheidungen, Anfragen, die T3 brauchen (kein Dialog), und `grant.create`
ohne Freigabe-Anfrage. Ohne Helfer (nicht installiert, Container-Modus, keine grafische Sitzung, kein polkit-Agent) antwortet der
Core `E_NOT_AVAILABLE attestation-unavailable`, die Anfrage bleibt auf ihren T1-Grenzen und nichts bricht. Abbruch, Zeitüberschreitung,
Fehler, Replay oder falsche Bindung: `E_DENIED attestation-failed` (`detail` nennt den Grund), die Anfrage bleibt offen. Siehe
`docs/rbac.md` und `docs/security/os-attestation-2026-10.md` für Bedrohungsmodell und Grenzen.

- **Zeitlimits:** Der Vordergrund wartet 10 Minuten, dann bekommt der Aufruf "nicht genehmigt, geparkt" und der Agent arbeitet
  an anderem weiter; die Anfrage bleibt entscheidbar. Nach 24 Stunden (ab Erstellung) ist sie `expired`, und das gilt als
  Ablehnung (`approval-expired`). Wird eine geparkte `once`-Anfrage später genehmigt, gilt der Grant 10 Minuten; der Agent muss
  den identischen Aufruf wiederholen. Abweichung: Die Spezifikation parkt den ganzen Task und wiederholt die Benachrichtigung
  einmal; umgesetzt ist nur die geparkte Antwort für den einzelnen Aufruf.
- **Ermüdungsschutz:** Eine Anfrage mit demselben Aktions-Hash wie eine im selben Task abgelehnte wird ohne Rückfrage
  verweigert (`repeat-denied`); mehr als 10 Anfragen je Task und Stunde werden verweigert, nicht eingereiht (`prompt-cap`).
  Nicht umgesetzt: ein offener Prompt je Agent und Oberfläche, Gruppierung, der Vorschlag eines engen Standing-Grants nach der
  dritten ähnlichen Anfrage.
- **Taint und Hand-offs:** In einem verunreinigten Turn, der private Daten gelesen hat, ruhen Standing-Grants und Overrides für
  `net.submit`, `comm.send`, `net.publish` und `external`-Effekte (es gibt noch keinen Lieferanten für diesen Kontext). Ein
  Sub-Agent erbt nie Grants des Aufrufers; er darf nur Grants nutzen, die die Person als `--delegable` markiert hat und die zu
  Person, Task und Hand-off-Scope passen; Fälschungen werden verworfen und als `approvals.held-rejected` protokolliert.

## 4. Headless-Regel

Ein unbeaufsichtigter Lauf (Cron, Hintergrundjob) darf **nur jobgebundene Standing-Grants** nutzen (Scope `always` mit `jobId`).
Sitzungs- und Task-Grants der Person gelten nie. Fehlt ein Grant für einen freigabepflichtigen Aufruf, wird er **sofort** als
`never` abgelehnt (`policy-never`, Regel `headless:no-job-grant`): nichts wird gefragt, nichts parkt, nichts wartet. Schweigen
ist nie Zustimmung. **Abweichung:** §9 der Spezifikation sagt "parkt und benachrichtigt"; die Umsetzung folgt der Owner-Vorgabe
D5 (sofort ablehnen). Parken ließe sich später ergänzen. `grant add` hat kein `--job-id`; Job-Grants entstehen über
`grant.create` (RPC).

## 5. Store und Verify

Der Zustand liegt in `<home>/state/approvals.sqlite`, nie in `config.json`, und wird beim ersten Gebrauch geöffnet. **Die Kette
ist die Autorität**, die Tabellen nur Projektionen. Jeder Eintrag trägt den MAC seines Vorgängers und einen eigenen
HMAC-SHA256-Wert; eine geschlüsselte Head-Zeile fixiert den neuesten Eintrag. Der Schlüssel (32 Zufallsbytes,
`approvals.chain-key.v1`) liegt im Secret-Store und wird nie stillschweigend ersetzt.

- **Was `verify()` erkennt:** Manipulation (`mac-mismatch`), Löschung oder Einfügen in der Mitte (`seq-gap`), Umordnung
  (`prev-mismatch`), abgeschnittenes Ende oder verändertes Head (`truncated`, `head-mismatch`), Replay und Umbindung
  (`nonce-reuse`, `duplicate`, `binding-mismatch`), unlesbare Payloads (`malformed`).
- **Bei Bruch** schlägt der Core fehlgeschlossen zu: Store-Operationen werfen einen Integritätsfehler, wartende Aufrufe enden
  als "nicht genehmigt", eine Zeile `approvals.integrity-failure` wird geschrieben, und **alle Grants ab der ersten gebrochenen
  Position sind suspendiert** (`grant list` zeigt `suspended`). Grants vor dem Bruch bleiben gültig; neue Anfragen, Entscheidungen
  und Grants sind unmöglich, solange die Kette gebrochen ist. Widerruf funktioniert weiter. Einen Reparaturbefehl gibt es nicht.
- **Prüfen:** `approval.verify` (RPC) und `plur1bus approval verify` (Exit 1 und erste gebrochene Position bei Bruch). Es gibt
  noch keine geplante Prüfung.
- **Nicht geschützt:** Code, der als OS-Nutzer läuft und den Secret-Store lesen kann, besitzt den Schlüssel und kann eine gültige
  Kette fälschen. Ein Zurückspielen einer älteren, in sich konsistenten Kopie wird nicht erkannt. Das Löschen der Datei entfernt
  alle Grants und Anfragen (nichts wird dadurch genehmigt). Der Store erkennt Manipulation durch alles Schwächere, er hält
  keine Schadsoftware mit den Rechten der Person auf.

## 6. CLI und RPC

Befehle: `grant list|add|revoke`, `approval list|pending|approve|deny|verify`, jeweils mit `--json` (Schemas `grant.list/1` usw.)
und `--home`; Beispiele im englischen Teil. `approval approve` zeigt die Anfrage zuerst (stderr) und fragt am Terminal `[y/N]`;
ohne Terminal oder mit `--json` ist `--yes` Pflicht, sonst Abbruch vor dem Verbindungsaufbau (Exit 2). Exit-Codes: 0 Erfolg;
1 Ablehnung oder Fehler des Core und gebrochene Kette bei `verify`; 2 Aufruffehler vor jedem Call, `E_NOT_AVAILABLE`,
`E_APPROVAL_REQUIRED`; 3 `E_LOCKED`. Die CLI sendet keine Verbindungs-Attestation, der Core sieht sie als T1; verlangt eine Freigabe T2, zeigt `approval approve`, was
das OS fragen wird, wiederholt die Entscheidung mit `attest: true` und das OS-Fenster erscheint auf diesem Rechner.

RPC: `grant.list`, `grant.create`, `grant.revoke`, `approval.list`, `approval.get`, `approval.verify`, `approval.decide`,
`approval.cancel`; nur für Personen, Person und Oberfläche stammen aus der Verbindung, nie aus Parametern; eine fremde Anfrage ist
`E_NOT_FOUND`. Notifications `approval.requested`, `approval.resolved`, `grant.changed` sind Opt-in und enthalten keine Nonce.
Weil der Server keine einzelne Verbindung adressieren kann, wird eine Benachrichtigung **zurückgehalten, wenn irgendein
Abonnent keine berechtigte Person ist**; ein Agent, der abonniert, bringt sie also zum Schweigen, statt sie zu lesen.

## 7. Agenten

`grant.*` und `approval.*` sind für Agent-Principals gesperrt: Die Aktionen `grant.read`, `grant.write`, `approval.read` und
`approval.decide` sind `humanOnly`, `authorize()` prüft das zuerst und verweigert mit `agent-principal`, gleichgültig welche
Rolle, Objektrechte, Token-Scopes oder Break-Glass-Grants vorliegen. Jeder Handler wiederholt die Prüfung, bevor ein Store
geöffnet wird. Es gibt keinen Passwortweg: keine RPC-Methode nimmt ein Passwort, und für `harness.admin`, `policy.bypass` und
`credential.entry` kann kein Grant existieren.

## 8. Audit

Alle Policy-Zeilen laufen über den Audit-Sink des Core (`logs/audit.log`, zusätzlich in die Hash-Kette
`logs/audit-chain.jsonl`). Entscheidungen werden vor der Ausführung geschrieben; was nicht protokolliert werden kann, wird nicht
ausgeführt. Grant-Änderungen stehen in derselben Transaktion wie die Änderung. Protokolliert werden Entscheidung und Ergebnis,
Anfrage, Entscheidung, Parken, Ablauf, Abbruch, Verbrauch, Verweigerung, Grant-Anlage, -Nutzung, -Verbrauch, -Widerruf, -Ende,
Integritätsbruch und verworfene Hand-off-Verweise. Die Felder sind eine Allowlist; jede Zeichenkette läuft durch den
Redaktor und ist auf 256 Zeichen begrenzt; Argumente und Diffs erscheinen nur als Größe und Hash, Dateiinhalte und
Tool-Ergebnisse nie. Abweichung: `plur1bus approval audit` und eine 400-Tage-Aufbewahrung gibt es nicht.

## 9. Bekannte Lücken und Folgearbeiten

1. Kein produktiver ToolDispatcher im Core bis D106; auch `exec.run` ist nicht angeschlossen.
2. WebMCP-`FORBIDDEN_PREFIX` kennt `grant.` und `approval.` nicht (RBAC verweigert Agenten trotzdem).
3. Der Tool-Registry fehlt ein Namensschutz für `grant.*` und `approval.*`.
4. Zwei ApprovalPorts: Der Exec-Port (`tools/exec/types.ts`) verbraucht weder Freigaben noch `once`-Grants.
5. Benachrichtigungen werden nur zugestellt, wenn alle Abonnenten berechtigte Personen sind.
6. Keine T3-Attestation; die OS-Bestätigung hebt nur auf T2. Der Helfer `plur1bus-attest` (und die polkit-Policy) ist noch nicht in
   Release-Archiv, Installer und `update`; ein Release-Build antwortet bis dahin `attestation-unavailable`. Die Web-Freigabeseite ist
   noch ein Platzhalter. Die Same-User-Token-Grenze (Kapitel 3) bleibt, bis die Sandbox `run/` und `state/` sperrt.
7. Ed25519-Signaturen und `1staid check approvals.integrity` fehlen; D108 (Freigaben auf beiden Seiten) ist nicht gebaut.
8. Taint hat keinen Lieferanten; Roots, Deny-List-Flag, `cwd` und Umgebungsnamen hängen an `classify()` des Tools.
9. `GrantStore.endTask` und `endSession` werden vom Core noch nicht aufgerufen.
10. Kleinere Spezifikationspunkte: Task-Parken und wiederholte Benachrichtigung, Ermüdungsschutz-Details, Diff und Modellbegründung
    in der Anfrage, `grant show`, `approval show`, `approval audit`, `grant.changed` für `used`, `expired`, `suspended`, der
    Inbox-Hinweis nach 90 Tagen, Oberflächen in den Einstellungen.
