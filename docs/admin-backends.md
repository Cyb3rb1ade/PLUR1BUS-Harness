# Administration backends (F39–F42, F44)

The core RPC and CLI surface is available; web page binding is separate work. These methods never accept a principal or a
role claimed by a browser. `RPC_RULES` resolves the authenticated person and the durable role/rights store on every call.
All methods are experimental. Tests use scratch stores, deterministic clocks and fake providers; no external requests.

| Area | RPC | CLI | Boundary |
|---|---|---|---|
| F39 lifecycle | `agent.pause`, `agent.resume`, `agent.archive`, `agent.unarchive` | `plur1bus agent pause/resume/archive/unarchive <id>` | Pause admits no new turns or agent jobs; in-flight work finishes. Archive makes the agent unusable and retains data. Unarchive preserves the pause flag. |
| F39 export | `agent.export` | `plur1bus agent export <id> [--offer-only]` | Secret-redacted JSON, signed manifest; ten-minute actor-bound export offer. |
| F39 delete | `agent.delete` | `plur1bus agent delete <id> --confirm-name <name> --export-offer <offer-id>` | Requires archive and exact configured display name (or id). Current engine cannot hard-erase: returns `E_NOT_AVAILABLE`, reason `engine-erasure-unavailable`, without deleting anything. |
| F40 people | `user.list`, `user.role.set` | `plur1bus user list`, `plur1bus user role <user-id> <preset>` | Five presets. Only Owner may change an Owner or promote one. Last Owner cannot be demoted. No user-delete RPC exists. |
| F40 invitations | `user.invite.create/list/revoke` | `plur1bus user invite create <name> --role <preset> --channel <channel> [--minutes <1-60>]`, `list`, `revoke <id>` | One-time code, fixed non-owner role, Identity claim/confirm proof. Revoking a claimed invitation prevents confirmation. |
| F40 agent rights | `agent.rights.get/set` | `plur1bus agent rights get <agent>`, `set <agent> <user> use/manage/none` | Explicit rights are intersected with role permissions; session writes require `agent.use`. Owner/Admin retain rights by role. |
| F41 break-glass | `breakglass.request/list/revoke/notices` | `plur1bus breakglass request <user> --reason <text> [--minutes <1-60>]`, `list`, `revoke <id>`, `notices` | Reason 10–500 trimmed characters. Read-only, holder/target bound, audited per read, revoked or expired grants cannot be reused. |
| F42 overview | `session.list` | `plur1bus session list [--owner <principal>] [--agent <id>] [--all-owners]` | Own metadata by default. Owner/Admin/Operator/Viewer may select all owners; Member sees own only. No messages or events. |
| F44 pairing | `pairing.qr` | `plur1bus pairing qr --link <existing-link>` | Read-only conversion of an existing unexpired deep link to the remote-access QR byte payload. No code issuance or device registration. |

Every CLI supports `--json`, emits the original RPC value with its `<method>/1` schema id, and reports errors as `error/1`.
The legacy `agent remove` command still removes configuration while retaining data; it is not hard deletion.

## Lifecycle and persistence

`state/agent-lifecycle.sqlite` stores pause/archive/deletion state. The complete agent registry still supports list/status;
those RPCs include an additive `lifecycle` field. Execution uses an active registry in the host, turn composition, dreaming,
post-turn maintenance and journal replay. Manual job execution passes the same gate. Pausing does not call `agent.close`,
change schedules or remove the workspace. Resume restores admission without losing configuration or schedule settings.

The current core has no registered channel switchboard (`channel.*` reports that separately). Channel/ACP execution using
the shared composition registry is gated. A future independently wired channel dispatcher must consume that registry too;
this change does not modify the channel packages. Already running turns/jobs finish normally.

`state/admin.sqlite` holds role presets, explicit object rights and affected-person notices. Mutations audit before execution;
role changes and last-owner checks run inside one `BEGIN IMMEDIATE` transaction. The bootstrap local token owner is seeded
only when the role table is empty. Assigned roles take effect on the next RPC invocation, including already connected clients.
Revoking an explicit right also takes effect immediately. No user erasure path is added.

Invitations create a human and call the existing `IdentityService.startPairing`. The code is returned only from create;
stored pairing proofs contain hashes, never plaintext. Redeem with `identity.pair.claim`, then confirm through
`identity.pair.confirm` or `identity.link.approve`. Pending invitations and proofs are ephemeral: restart invalidates them;
the created person and assigned role remain durable. Expired/revoked codes cannot link an identity. Successful confirmation
is single-use; revoking an already confirmed invitation is a conflict (use identity unlink to revoke the link).

## Export format

`agent.export` returns `{ agentId, offerId, expiresAt, bundle? }`. `offerOnly: true` returns an export offer without reading
persona or memory data. Delete requires a live offer issued to the same authenticated person for the same agent, even when
the person chooses to decline downloading the actual export. Rejected name/archive/offer checks never call an erasure port.

The bundle is `plur1bus.agent-export/1`, a UTF-8 JSON document:

- `files`: sorted `{ path, text }` entries. Paths are relative; no absolute or parent paths, hidden files, symlinks, database
  files or credentials. Persona/identity/user Markdown files, memory Markdown files, skill Markdown files, redacted agent
  `config.json`, and `memory/cards.json` from the engine API are included.
- `manifest`: `{ format, agentId, files: [{ path, bytes, sha256 }] }`. Hashes are SHA-256 of each **redacted UTF-8** file.
- `manifestHash`: SHA-256 of UTF-8 `JSON.stringify(manifest)`, with the property order shown above. Verification uses these
  exact serialized bytes; pretty-printed/reordered JSON is not the signed representation.
- `algorithm: Ed25519`, `publicKey` (base64 DER SPKI), `signature` (base64 signature over the 32 decoded manifest-hash bytes).
  The persistent private signing identity is kept in the ADR-005 secret store and leased only for signing. It never enters a
  bundle. Verify against a public key already trusted for the installation; the bundled key alone is not proof of origin.

A bundle has at most 256 files and 2 MiB of redacted file text. File opens reject links; config secret keys are omitted.
Recognizable credentials and exact secret-store values (including encoded forms recognized by the existing redactor) are
redacted. Known secrets are held only while building the bundle; leases are revoked. Arbitrary sensitive prose that was never
stored as a secret is not classified as a credential by this mechanism.

Memory export uses the engine's ACL: agent-private/workspace data plus the authenticated exporter's own user-scope data.
Another person's memories are not bulk-exported by an Owner's role or a break-glass window. The pinned engine exposes no
pagination cursor; if the 100-card list is truncated, the RPC refuses with `memory-export-truncated` instead of calling an
incomplete bundle complete. A separate engine API is needed for exhaustive large exports and hard erasure. The delete
handler deliberately does **not** substitute archive-first `memory.forget` or direct store deletion for hard erasure.

## Break-glass, approvals and privacy

The RPC uses the existing `createBreakGlass` library, with mandatory durable notices enabled. A failed notice write removes
the grant and fails closed. The affected person reads their inbox through `breakglass.notices`; it is self-scoped for every
human role. `breakglass.notice` delivers a live opt-in event only when **every** subscriber is the affected authenticated
person; a mixed audience withholds the event, leaving the durable inbox available. Web inbox/dialog binding is follow-up.
Grants are ephemeral and disappear on restart. Expiry is swept on use/list and produces an audit event exactly once.

`session.get/resume/events` authorize a foreign transcript only via the library's live grant, with a `.used` event for every
read. `memory.list/show` accept an additive `targetUserId` for user-scope reads through the same gate and the engine ACL.
They return only user-scope cards for that target; there is no target parameter on writes. Token scopes can only narrow both
the coarse surface gate and the resource read. Owner-scope compatibility for old local CLI sessions keeps their caller hash;
other authenticated people use canonical v2 plus their currently linked v1 principals. Session mutations require the supplied
caller identity to be one of those active links, preventing request-text impersonation.

D109 explicitly distinguishes human harness administration from agent tool execution. Its capability table classifies
`harness.admin` as **never for an agent**, with people acting through CLI/UI. These RPCs are direct human actions, not tools
submitted to the D109 dispatcher. No agent, grant, model assertion or auto-approved decision can invoke them. The existing
approval queue/service remains unchanged; it does not provide a second approval for these direct human RPC actions.
Deletion attempts, role changes and break-glass grants/uses/revocations/expiry are audited through the core sink/hash chain.

## Session usage and F44 gaps

The metadata listing adds `owner`, `model`, and `usage { inputTokens, outputTokens, costMicros, pendingCalls? }` by joining the
existing `budget_call` admission ledger to `usage_event` using its prefixed request id. All settled calls (including retries
and fallbacks) count once. Model is the latest recorded model in the session. Pending/unpriced usage makes cost `null`, never
an invented zero. Older/fake-provider sessions fall back to existing `turn.completed` provider/token metadata; a provider id
is the fallback model label, and absent costs stay `null`. No prompt/result content is read from the budget ledger.
Searching one's own sessions retains the old FTS semantics; searching another person's transcripts from the overview is
denied, including through `allOwners`, so it cannot be used as a content oracle. Filtering by owner/agent and paging limits
are enforced in the listing query.

`remote.publish` now exists in the config schema (`local | tailnet | network`, default `tailnet`, core restart, advanced tier).
It expresses configuration; applying listeners/TLS/Tailscale remains the existing remote-access integration follow-up.
`pairing.qr` validates/encodes an existing offer and returns `qrData` from the package. It does not verify the offer's HMAC or
turn client text into a trusted server-issued offer; redemption remains responsible for that verification. **Geräte-Store mit
List/Revoke fehlt in packages/remote-access**. Consequently there is no `device.list` or `device.revoke` RPC/CLI in this PR.
