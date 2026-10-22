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
3. *Rotate now* sends the value once. The field is emptied before the request is awaited; the old value stops working, its leases are revoked, and a copy of the old value in the other backend (OS keyring or encrypted file) is removed too.
4. The page then says only `<name>: updated on <time>` (the `updatedAt` of the answer). `secret.status` carries no per-secret time.

A value is never shown, never put in a URL, `localStorage`, `sessionStorage` or a log line, and never repeated in an error text (the
page shows fixed sentences). Deleting a secret still needs the typed name; it removes the secret from both backends, including the encrypted file when the
file fallback is switched off. A lease object printed or serialised (log line, JSON, debugger) shows `[redacted]` in place of the value, and every file error from
the encrypted store is reduced to a code, so no file path leaves the store.

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
* Person-only (`humanOnly`) methods that WebMCP still does not forbid: `agent.pause`, `agent.resume` (the README and `provider.test.ts` document them as exposed, a person may trigger them through an assistant), `memory.list` and `memory.show` (default D55 tools, asserted by `provider.test.ts`), and `voice.session.create` (the Voice V3 test keeps non-write `voice.*` open). Each needs an owner decision; blocking any of them contradicts a documented flow. Every other person-only method (the `project.*` surface and card writes, `media.*`, `channel.*`, `session.*`, `collab.*`, `chat.promote.*`, `model.embedding.select`, `model.licence.*`) is forbidden by exact name, even on explicit `include`; the agent-admitted neighbours (`project.card.get`, `project.card.list`, `project.card.move`, `project.card.comment.*`, `media.search`, `media.index.status`) stay available.
* Write methods that WebMCP does not forbid and the exposure list does not name: `chat.archive`, `chat.cancel`, `chat.create`, `chat.delete`, `chat.export`, `chat.restore`, `chat.submit`, `chat.update`, `dreams.schedule.set`, `dreams.enable`, `dreams.disable`, `project.card.move`, `project.card.comment.add`, `memory.correct`, `memory.share`, `memory.propose`, `memory.proposals.accept`, `memory.proposals.reject`. None is person-only; whether each is forbidden or exposed with confirmation is an owner decision.

Today only stable methods and the memory reads are tools by default, so the experimental ones above are reachable only if a page lists them in `include`.

## Browser transport threat model

| Attack | Protection | Evidence |
|---|---|---|
| Cross-site cookie writes / DNS rebinding | Existing Host, Origin, Referer and Fetch-Site checks; one-time session CSRF on every `/rpc` POST | `packages/api/test/web-rpc.test.ts`, existing hardening suites |
| Browser principal / actAs spoofing | Claims discarded; server builds identity from session; explicit bootstrap mapping | RPC unit test and real API/Core E2E; directory id `owner` regression |
| Another local Core-token client delegates a person | Separate registered API credential; identity fixed per connection; authoritative stored roles | Real socket delegation test; missing and agent principals fail humanOnly |
| Private event leak or cross-person resume | Audience metadata preserved; explicit event-name/global allowlists; filtered replay buffer per person and cookie session | Audience unit tests; two-person real Core E2E |
| Connection/body flood or slow SSE reader | Body cap, independent RPC/IP/person rate class, eight streams/person, feed/peer/output caps | HTTP body test, stream-limit/expiry test, existing limiter tests |
| Session resurrection via heartbeat | Non-renewing session checks; logout/rotation/expiry close streams | Real logout E2E and idle-expiry test |
| Error leaks a secret marker | Fixed HTTP RPC messages; no stacks/details; raw handler errors logged with a fixed reason | Real socket marker test, credential scans, secrets-never-leave sweep |
| Parent config replacement bypasses annotations | Supervisor checks changed annotated descendants after preparing the whole resulting tree | Five-role config-policy tests |
| Sensitive config enters audit or old cloud consent survives a switch | Schema sensitivity inherited; credential keys redacted; old ack invalidation; authenticated writer; durable audit intent | Config-policy/audit tests |

The API credential narrows ordinary local-client capabilities, but cannot isolate hostile processes of the same OS user. A cookie authenticates an account; it is not proof of physical human intent. Browser delegation preserves current surface trust and never performs automatic OS confirmation. Stronger broker/OS separation, durable account provisioning and the production active-person source remain Owner decisions; details in the [transport handoff](handoff/2026-10-14-web-transport.md).

### Known boundary: same OS user

`run/api-delegation.token` is private (0600) and rotated when the Core restarts, including configuration restarts. A process running as the same OS user can read it and impersonate the API. This is the same trust boundary as the existing local IPC credentials. Today, service installations can use a separate OS user to isolate them from interactive applications; strict API/Core separation through different users, a broker or attestation is planned, and is not implemented.

The durable account database holds credentials only; Core person status and rights are authoritative. Disabled/missing people cannot log in, use sessions/tokens, or retain a stream. Core revisions prevent revoked tokens or sessions from returning after enable. Cookie authentication does not prove a human or raise browser trust; the WebMCP exclusions and OS confirmation requirements remain.

| Boundary | Check | Remaining limit |
|---|---|---|
| Invite → account | Validate before collision disclosure; pending credentials before atomic consumption | Activation failure after consumption requires a new invitation; audited |
| Account → Core person | Current Core role, rights, status and revision per use | Same OS-user delegation credential boundary |
| Disable → credential lifetime | Session/SSE invalidation; permanent token revocation by issuance revision | Dedicated API service notification; five-second synchronization or next request/heartbeat after disconnect |
| Channel inbound → person | Deferred to switchboard owner | KNOWN GAP: channel inbound ignores person.disabled |

## Secret status metadata

`secret.status` optionally includes `secrets`, a names-only metadata snapshot from the available backends. Creation and rotation persist timestamps with the existing metadata index; `updatedBy` identifies the authenticated person when known. Status never reads or decrypts values. Older entries without writer metadata remain readable. Settings displays timestamps from this snapshot and “Unknown” when metadata is unavailable. Owner-only access remains the existing ADR-005 rule.

Each secret may carry a `description`: one line of plain text, at most 200 characters (counted as Unicode code points), saying what the secret is for. It is metadata like `updatedBy`, never a value: the store refuses control characters (so a description cannot pose as another line of text) and a description that contains the secret value being written. `secret.set` takes it as an optional `description`; a replacement that names none keeps the stored one and an empty one removes it. `secret.list`, `secret.get` and `secret.status` return it, `plur1bus secret set NAME --description TEXT` and the Settings → Secrets dialog set it, and the agent's `secret_names` tool shows it next to a stored secret. The audit log never carries it. File format: the encrypted file keeps its schema id (`plur1bus.secrets-file/1`, which is bound into every entry's AAD) and the keyring index keeps its own; the field is optional in both, files and indexes written before it existed read unchanged, and an older core that rewrites an entry drops the description. To change only the description, set the secret again with the same value.

### Configurable approval and emergency-access limits

`approvals.maxGrantDays` controls an always-grant's unused lifetime (default 90, 1–365 days); an explicit shorter expiry still wins. `approvals.requireOsConfirmation` defaults to true, preserving the conditional T1 → T2 OS-confirmation flow. False disables that lift and leaves the existing surface refusal in place. It never permits an otherwise untrusted decision.

`breakglass.reasonMinChars` / `reasonMaxChars` default to 10 / 500 trimmed characters; both are 1–10000 and minimum must not exceed maximum. `breakglass.maxWindowMinutes` defaults to 60, accepts 1–1440, and also caps the default 15-minute window. Trigger roles remain unchanged.

All five keys declare `x-write-roles: [owner, admin]` and `x-audit: true`. These annotations are enforced by the web transport in the supervisor: the authenticated transport must supply a trusted person principal on the supervisor's `server.rs` / `config.rs` write path, enforce roles and write `audit.config.set` with old/new values. Settings continues to expose these limits read only; the authenticated transport enforces them for direct RPC writes.

## M3 account bootstrap and passkeys

| Attack | Protection | Evidence |
|---|---|---|
| Reuse startup proof after Owner creation | Account insertion and durable proof consumption in one SQLite transaction; startup cannot reset consumed marker; Owner-token login disabled afterward | `webauthn-http.test.ts`, `account-store.test.ts`, real browser `bootstrap-account.test.ts` |
| Read bootstrap proof as another OS user | Checked private run directory, regular file, owner check and mode 0600 / secure-path ACL; logs contain only a redacted notice | `bootstrap.test.ts` |
| Replay or substitute WebAuthn ceremony | One-use five-minute bounded challenges, account revision and exact configured/allowlisted origin, RP hash, mandatory UP and UV | `webauthn.test.ts`, `webauthn-http.test.ts` |
| Clone credential | Verify signature before evaluating counter; repeated/decreasing non-zero counter rejected and audited | `webauthn.test.ts`, HTTP counter rollback |
| CBOR/COSE denial of service | Maximum 16 KiB, eight nesting levels, 256 items, definite canonical lengths, duplicate-map-key rejection, only ES256/Ed25519 | Deterministic 5,000-input parser corpus and bounded-invalid cases |
| Credential mutation leaves old authority usable | Registration/rename/revoke transaction bumps account session version; counters use compare-and-swap | `account-store.test.ts`, browser enrollment/session expiry |

No private passkey material or attestation certificate chain is persisted. Credential identifiers, COSE public keys and counters are stored with account/key names. Attestation is `none` or packed self attestation; hardware provenance is not claimed. The accepted same-OS-user boundary is unchanged. OIDC remains deferred until after M3.
## M3 remote listener enforcement

| Attack | Enforcement | Named verification |
|---|---|---|
| Expose HTTP on a non-loopback address | Network requires TLS plus current notice acknowledgement; tailnet backend binds loopback only | `remote-policy.test.ts` |
| Reuse a local password-only Owner/Admin cookie remotely | Remote factor gate checks each request; tokens carry no factor proof | `remote-policy.test.ts` |
| Enable network without reviewing the notice or forge its actor | Closed REST body, authenticated actor/time, audit and supervisor revision CAS | `remote-config.test.ts` |
| Spoof a proxy client address/Host/Origin | No forwarded-header trust; exact configured remote origin; socket CIDR gate | Remote policy/runtime tests |
| Steal a typed pairing code with a changed certificate | Nonce-only proof before disclosure; client compares MAC with actual leaf/origin; one-use receipt and code | Remote pairing HTTP/TLS tests |
| Switch certificate before devices learn the new trust | Durable staged announcement, registered-key acknowledgements, missed-device repair | Remote pairing rollover tests |

Pair-proof and code redemption are reviewed bootstrap exceptions to cookie authentication: a device cannot already have a paired identity. They are closed without an Owner-opened ephemeral code, bounded and rate limited, and never mint a password session. The MAC is not an authority to accept arbitrary TLS: the client must compare its own certificate and configured origin. No remote change strengthens the accepted same-OS-user boundary.
