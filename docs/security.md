# Security operations: confirmation, secrets, rules, sign-in

How the web UI and the harness behave on the security-relevant paths, and which exceptions the RBAC/WebMCP matrix test records.
The policy itself lives in [rbac.md](rbac.md), [approvals.md](approvals.md) and [security/os-attestation-2026-10.md](security/os-attestation-2026-10.md);
the vulnerability policy is in [SECURITY.md](../SECURITY.md). This page does not repeat them.

## Confirmation by the operating system

An approval that needs a higher surface level than the connection has can be lifted by **one** confirmation of the operating system
(Touch ID or the account password on macOS, Windows Hello or UAC on Windows, polkit on Linux). It is asked for inside `approval.decide`
with `attest: true`; details are in [approvals.md](approvals.md) 3.2.1.

* The approval record (`approval.get`, `approval.list`) has **no field** for the confirmation: no "required / pending / confirmed"
  state and no platform. The state exists only as the answer of `approval.decide`. The web UI therefore cannot show a state before
  the decision; it shows the sentence for the refusal it gets back (`attestation-required` with the method, `attestation-failed`
  with cancelled or timed out, `attestation-unavailable`, `attestation-in-progress`) and never the raw error.
* There is no "approve anyway" path. The page offers the confirmation again or leaves the request pending; the core, not the page,
  decides whether the surface level is met.
* Operating it: on a headless host or in a container the confirmation is unavailable and requests that need it stay at the limits of
  an unattested connection. Install the native helper where only an administrator can write ([rbac.md](rbac.md), threat model).

## Rotating a secret

Settings → Secrets → *Rotate* (`secret.set`, owner only, audited).

1. Type the new value into the masked field. The field is never prefilled and a password manager is not asked to fill it.
2. *Save* only validates and shows the question *Replace the value of …?* The value stays in the read-only masked field; *Back* returns to editing.
3. *Rotate now* sends the value once. The field is emptied before the request is awaited; the old value stops working and its leases are revoked.
4. The page then says only `<name>: updated on <time>` (the `updatedAt` of the answer). `secret.status` carries no per-secret time.

A value is never shown, never put in a URL, `localStorage`, `sessionStorage` or a log line, and never repeated in an error text (the
page shows fixed sentences). Deleting a secret still needs the typed name.

## The rules overview

Settings → Security & Permissions (after Network) is **read only**. It reads the running configuration with `config.get` and shows the
rules that have a config key today:

| Rule | Key | Changed in |
|---|---|---|
| Remote access | `remote.publish` | read only (the device pairing page is *Devices & remote*) |
| Host control tools | `tools.hostctl.enabled` | read only |
| Shell commands | `tools.hostctl.shell.allowed` | read only |
| Unsigned extensions | `extensions.allowUnsigned` | Settings → Extensions |
| Encrypted file store for secrets | `secrets.fileFallback.enabled` | read only |

Not shown because there is **no config key**: how long an approval lives (fixed at 24 h in the core), whether the OS confirmation is
required (decided per request by the surface level), and the break-glass limits (fixed: 10–500 character reason, 1–60 minutes,
[rbac.md](rbac.md)). Open approvals stay under Approvals; the section links to Approvals, Break-glass and Devices & remote.

## Sign-in

The page signs in with the owner token (`POST /api/v1/session`); it has no user name field.

* A refused token always reads *The token is not correct.* The page never shows the server's reason or message and never repeats what was typed.
* A rate limit or lockout (HTTP 429, `Retry-After`) reads *Too many attempts. Try again in N s* (from two minutes on, *N min*); without a usable header, *in a moment*.
* The token field is `autocomplete="current-password"`. After any failure it is emptied, masked again and focused. Nothing typed is logged.
* The page uses no inline style or script (strict CSP), so it works under the shipped policy.

## RBAC and WebMCP matrix

`packages/webmcp/test/rbac-matrix.test.ts` walks **every** method of `rpc.schema.json`:

* **A.** A core method has a rule in `RPC_RULES` whose action is in the policy table with documented roles, or is listed as open on purpose.
* **B.** A write method is forbidden as a WebMCP tool, or is on the exposure list below. The schema has no read/write marker, so writes are found by verb (`set`, `create`, `delete`, `update`, `revoke`, `decide`, `install`, `start`, `stop`, `run`, `move`, `assign`, `archive`, `import`, … see the test).
* **C.** A method behind a `humanOnly` action refuses an agent principal (checked with the real guard) and is not offered over WebMCP.

Every deviation is a `todo` case named `KNOWN GAP` after its method; fixing the product turns it green without touching the test.

### Writes that WebMCP may offer (the page opts in, the person confirms)

| Method | Reason |
|---|---|
| `memory.capture` | Default tool (stable); the engine ACL decides; the person confirms |
| `memory.forget` | Memory operation with RBAC rule `memory.forget`; the person confirms |
| `jobs.run` | RBAC rule `jobs.run` (Owner, Admin, Operator); the person confirms |
| `dreams.run` | Same class as `jobs.run` |
| `agent.pause`, `agent.resume` | A person may trigger them through an assistant (`provider.ts`); the person confirms |

### Core methods without an RBAC rule, on purpose

| Methods | Reason |
|---|---|
| `core.auth`, `events.subscribe`, `events.unsubscribe` | Handshake and connection-bound subscriptions |
| `core.status`, `core.shutdown`, `core.adopt` | Listed under *Not yet secured* in [rbac.md](rbac.md); local token only |
| `memory.recall`, `memory.capture`, `memory.checkpoint`, `memory.state`, `agent.list`, `agent.open`, `agent.close`, `jobs.list`, `jobs.history`, `dreams.status`, `dreams.log`, `dreams.schedule.get`, `models.list` | Listed under *Not yet secured*; the engine ACL or `canSee` narrows the result |
| `secret.*` | Owner only, enforced by the secret store (`secrets/rpc.ts`) |
| `user.invite.redeem` | The redeemer has no principal yet |

### Open findings (KNOWN GAP cases)

* No RBAC rule and not documented as open: `budget.set`, `budget.status`, `voice.*` (including `voice.models.install`, `voice.realtime.start`).
* No RBAC rule, documented as *Not yet secured*: `memory.correct`, `memory.share`, `memory.propose`, `memory.proposals.*`, `models.scan`, `models.acknowledge`.
* Person-only (`humanOnly`) methods that WebMCP does not forbid, so a page that opts them in offers them to an agent that then acts as the signed-in person: the `project.*`, `media.*`, `channel.*`, `session.*` and `collab.*` families, `agent.pause`, `agent.resume`, and, as **default** tools, `memory.list` and `memory.show`.
* Write methods that WebMCP does not forbid and the exposure list does not name: the same families plus `dreams.schedule.set`, `dreams.enable`, `dreams.disable`, `memory.correct`, `memory.share`, `memory.propose`, `memory.proposals.accept`, `memory.proposals.reject`.

Today only stable methods and the memory reads are tools by default, so the experimental ones above are reachable only if a page lists them in `include`.

## Secret status metadata

`secret.status` optionally includes `secrets`, a names-only metadata snapshot from the available backends. Creation and rotation persist timestamps with the existing metadata index; `updatedBy` identifies the authenticated person when known. Status never reads or decrypts values. Older entries without writer metadata remain readable. Settings displays timestamps from this snapshot and “Unknown” when metadata is unavailable. Owner-only access remains the existing ADR-005 rule.

### Configurable approval and emergency-access limits

`approvals.maxGrantDays` controls an always-grant's unused lifetime (default 90, 1–365 days); an explicit shorter expiry still wins. `approvals.requireOsConfirmation` defaults to true, preserving the conditional T1 → T2 OS-confirmation flow. False disables that lift and leaves the existing surface refusal in place. It never permits an otherwise untrusted decision.

`breakglass.reasonMinChars` / `reasonMaxChars` default to 10 / 500 trimmed characters; both are 1–10000 and minimum must not exceed maximum. `breakglass.maxWindowMinutes` defaults to 60, accepts 1–1440, and also caps the default 15-minute window. Trigger roles remain unchanged.

All five keys declare `x-write-roles: [owner, admin]` and `x-audit: true`. These annotations are the transport contract, **not enforcement**: the authenticated transport must supply a trusted person principal on the supervisor's `server.rs` / `config.rs` write path, enforce roles and write `audit.config.set` with old/new values. This package leaves those files unchanged and exposes the values read only in Settings.
