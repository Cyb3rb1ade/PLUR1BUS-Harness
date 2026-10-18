# Secret descriptions and agent access (Phase E, 2026-10-18)

Owner decisions, 17/18 October 2026: values stay masked in logs; agents may discover permitted secret names and their
purpose, never values; each secret can carry a description. This phase builds on #574's description metadata.

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

Descriptions are trimmed, one line, at most 200 Unicode code points. A complete current value is forbidden even if short;
any contiguous fragment of eight or more code points is also forbidden. Set/rotation checks both the new value and the
old one, including a retained description. The backend rechecks inside its serialized update so that a concurrent rotation
cannot be reverted by a description edit. Values read internally for validation are registered with the existing redactor.

## Owner read view of agent access

`secret.grants.list` returns effective grants separately from configuration references. The store still refuses every
agent principal: `agentLeasesEnabled` is false, `grants` is empty. `references` lists the agent id, exact secret name,
provider/channel scopes, presence and `leaseAllowed: false`. A configuration reference is not authority. The Web view
states this explicitly and offers no grant writer or lease operation. `secret_names` continues to expose names, scope,
presence and descriptions through the dispatcher, never a value.

The [lease design options](superpowers/specs/2026-10-18-agent-secret-lease-options.md) are an owner question for a later
implementation: explicit per-agent/name/purpose grants with expiry and D109 `secrets.use`, policy-approved inheritance
from configuration, or keeping leases core-only. This phase assumes no answer and implements none of the grant writers.

## Validation and stack integration

Tests cover full/partial-value rejection, rotation with retained descriptions, metadata-only edits on all three backends,
unchanged active leases and ciphertext, concurrent rotation, audit failure, owner/agent RPC boundaries, WebMCP exclusion,
CLI text/clear parsing, Web behavior, redaction, axe and 400 px layout.

#574 is itself stacked on #570. Its new basic `privacy.localOnly` key lacked the mandatory CLI setup question. The
additive integration repair asks against the current configured value, preserves that value on reruns, and never changes
it in unattended setup. Restart classes and the local-only implementation remain the inherited #570 contract; Phase C
owns the live-application follow-up. No Engine pin or Engine-repository code changes are made here.
