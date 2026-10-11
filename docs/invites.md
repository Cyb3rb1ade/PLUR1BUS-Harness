# Invitations

An Owner or Admin invites a person with a role (never Owner). Besides the one-time Identity pairing code, an
invitation can carry a **shareable link** with a validity the inviter picks. This page describes the link; the pairing
code, its claim and its confirmation are in [identity.md](identity.md), the RPC shapes in [rpc.md](rpc.md).

## Validity

`user.invite.create` takes `ttlMinutes` (1 minute to 30 days, default 60). The web dialog offers 1 hour, 24 hours,
7 days and 30 days, or a whole number of hours up to 720. `expiresInMinutes` (1 to 60) still works for callers that
send it; the two are exclusive. The pairing code that rides along keeps the Identity service's own limit and lives at
most 60 minutes, whatever the link's validity.

## The link

A link is created only when the caller passes `origin` (`scheme://host[:port]`, nothing else; the web UI sends its own
origin). The result carries `link`: `<origin>/#/invite/<token>`.

- The token is 256 random bits from the CSPRNG (43 characters, unpadded base64url).
- Only a SHA-256 hash of the token is stored (`state/admin.sqlite`, table `admin_invites`). The link is returned once, in the
  `user.invite.create` reply. `user.invite.list` never shows a token, a hash or a code.
- It travels in the URL fragment, which a browser never sends to a server, so no access log can hold it.
- The token is never written to the log, the audit trail, a metric or an error text. Audit events carry the invitation
  id, the role and the validity.

## Redeeming

`user.invite.redeem { token }` consumes the token exactly once and returns the invited person (`userId`,
`displayName`, `role`). It needs no signed-in person, since the redeemer has none yet; it is served only on the core's own
authenticated connection and has no RBAC rule.

- **One uniform failure.** An unknown, expired, revoked, already used or malformed token all answer `E_INVITE_INVALID`
  with no `reason` and the same message. The audit trail records the real cause (`user.invite.redeem.refused`).
- **Single use.** One guarded update takes the row only if it is unredeemed, unrevoked and unexpired; of two simultaneous
  redeems exactly one wins. If the audit write fails the token is not consumed and the caller gets `E_INVITE_INVALID`.
- **Rate limit.** Failed redeems count per connection (5 within 15 minutes, then a 15-minute lock) and over all connections
  (100 within 15 minutes, then a 5-minute lock); a locked caller gets `E_DENIED reason=rate-limited`, valid token or not.
  A token has 256 bits, so the limits only cap noise; the overall one is loose on purpose, so it cannot be used to lock
  legitimate redeems out. The counters live in the database and survive a restart. The per-connection key is the RPC
  connection: behind the Harness API's proxy all browsers share one.
- A redeemed invitation cannot be revoked afterwards (`E_CONFLICT reason=redeemed`).

Redeeming returns the person; it does not open a session. Sign-in for an invited person comes with the Harness API's
sessions (see [rbac.md](rbac.md)); the web UI has no landing page for `#/invite/<token>` yet.

## Revoking and the list

`user.invite.revoke` kills the link and the pairing code at once. `user.invite.list` reports `pending`, `claimed`,
`confirmed`, `declined`, `expired`, `revoked` and, for a link, `redeemed`; `shareable` tells a link from a code-only
invitation. A link's state comes from its own validity, not from the pairing code behind it. Invitations are stored
durably and survive a restart.

## Audit events

| Action | When | Detail |
|---|---|---|
| `user.invite.create` | an invitation is created | `role`, `channel`, `ttlMinutes`, `shareable` |
| `user.invite.redeem` | a token is redeemed | `role`; the target is the invitation id |
| `user.invite.redeem.refused` | a redeem fails | `reason` (`unknown`, `expired`, `revoked`, `redeemed`, `malformed`, `rate-limited`), for the trail only |
| `user.invite.revoke` | an invitation is revoked | target is the invitation id |

## Web

Settings › Users & roles › People › Invite person: name, role, validity, rights. After creating, the link is shown once with a
Copy button; closing the dialog drops it. Open invitations are listed under the people list and are revoked after a
confirmation. The CLI (`plur1bus user invite`) is unchanged: no origin, so no link, and it keeps its 1 to 60 minute code.
