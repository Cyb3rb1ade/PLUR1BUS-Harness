# Secret descriptions and agent access (Phase E, 2026-10-18)

Owner decisions, 17/18 October 2026: values stay masked in logs; agents may discover permitted secret names and their
purpose, never values; each secret can carry a description. This phase builds on #574's description metadata.

## Startup redaction

Core reads indexed keyring values and, when file fallback is enabled and usable, encrypted-file values before
startup logs reach a sink. Both accessible copies of a name are registered without syncing, rotating or deleting
either copy. Readable initial values stay masked until Core exits, including values subsequently rotated or deleted.
Later Store reads and writes continue to register values normally. The eight UTF-16-unit masking minimum is unchanged.

Disabled file fallback stays unopened; unavailable backends and unreadable entries cannot supply values to register.
These conditions do not prevent startup. Read failures produce only fixed backend/phase identifiers and counts,
without credential values or platform exception text. Empty stores start normally. Metadata-only operations remain
metadata only, and startup registration returns no credential or lease and records no credential-access audit event.

Focused coverage: run the Core `secrets/config-registration`, `secrets/preload` and `logs/startup-redaction` tests
with Node source conditions and the gated in-memory/off keyring test seam.

## Edit a description without rotating

Only an authenticated owner may call `secret.describe`. The RPC takes `{ name, description }` and returns metadata only;
there is no value parameter and no value result. An empty description clears the field. CLI:

```sh
plur1bus secret describe billing "Production billing account"
plur1bus secret describe billing --clear
```

Settings → Secrets has a separate Edit description dialog. It has no credential input and calls neither `secret.get` nor
`secret.set`. A successful edit preserves the credential bytes and active leases. The encrypted-file backend preserves
the entry's ciphertext, nonce, authentication tag and store key. The keyring backend updates only its metadata index.
The audit event is `secret.describe` and contains the name/backend, never the description or value. Audit failure refuses
the write. Both new RPC methods also have explicit human-only guards; token scopes can only narrow access.

Descriptions are trimmed, one line, at most 200 Unicode code points. A complete current value of eight or more code points is forbidden (a shorter value is accepted by `secret.set` since #652 and is not looked for in prose, so a letter or a word is never a leak);
any contiguous fragment of eight or more code points is also forbidden. Set/rotation checks both the new value and the
old one, including a retained description. The backend rechecks inside its serialized update so that a concurrent rotation
cannot be reverted by a description edit. Values read internally for validation are registered with the existing redactor.

## Owner read view of agent access

`secret.grants.list` returns effective grants separately from configuration references. The store still refuses every
agent principal: `agentLeasesEnabled` is false, `grants` is empty. `references` lists the agent id, exact secret name,
provider/channel scopes, presence and `leaseAllowed: false`. A configuration reference is not authority. The Web view
states this explicitly and offers no grant writer or lease operation. `secret_names` continues to expose names, scope,
presence and descriptions through the dispatcher, never a value.

### Reference names and pasted keys

Schema-declared secret references are provisioning metadata and remain readable in configuration views, audit changes,
logs and ordinary backups. Matching uses the declared reference subschema and the canonical name-safety policy, never
field-name guesses or target reads. Store and environment names follow their declared formats; structured Engine
references retain the pinned source contract. Inline literals at `x-sensitive` keys remain masked. A name that looks
like a pasted key (a known token prefix, excessive length or high entropy) is treated as a literal, masked and registered
for text redaction. Configuration CLI stderr and Supervisor warnings name the key and say
`Reference looks like a pasted key; use a secret-store reference name.` without echoing the value. Explicit file paths
retain normal path syntax and length; bare token-shaped file/exec ids are still protected. Actual store values remain
protected in registry-filtered outputs even when their bytes equal a reference name. Grant views mask such a collision;
agent exports refuse before signing so the provisioning manifest remains valid. These disclosure checks add no
authority or backend access.

The [lease design options](superpowers/specs/2026-10-18-agent-secret-lease-options.md) are an owner question for a later
implementation: explicit per-agent/name/purpose grants with expiry and D109 `secrets.use`, policy-approved inheritance
from configuration, or keeping leases core-only. This phase assumes no answer and implements none of the grant writers.

## Validation and stack integration

Tests cover full/partial-value rejection, rotation with retained descriptions, metadata-only edits on all three backends,
unchanged active leases and ciphertext, concurrent rotation, audit failure, owner/agent RPC boundaries, WebMCP exclusion,
CLI text/clear parsing, Web behavior, redaction, axe and 400 px layout.

No Engine pin or Engine-repository code changes are made here.
