# Agent secret leases — owner decision (Phase E)

Current authority: SecretStore refuses every agent principal. `secret_names` lists configured references; those references
are not grants. Phase E therefore adds an owner-only read view with an empty effective-grants list and separately labelled
configuration references. It adds no grant writer and opens no agent value or lease path.

Options for a later phase:

1. Explicit owner-issued grants per agent, exact secret name and purpose, with expiry and revocation. Require D109
   `secrets.use`, intersect all token/capability scopes, audit issuance/use/denial, cap lease TTL and revoke on rotation.
   Recommended: authority is explicit and narrower than configuration references.
2. Inherit grants from provider/channel configuration references, with an owner-approved policy. Lower administrative
   effort, but a config edit changes secret authority; this needs a clear approval boundary and purpose derivation.
3. Keep leases core-only. Agents discover permitted slots through `secret_names`; core adapters own resolution and audit.
   Smallest authority surface, but agent-authored integrations cannot request their own purpose-bound leases.

## Owner decision — 2026-10-18

Option 1 is selected: explicit Owner grants per agent, exact secret and required purpose, intersected with D109
`secrets.use` and the caller's effective scopes. Each lease must check the purpose: an `embedding` grant never permits
`llm` use. The default grant expiry is 90 days, freely selectable; unlimited duration requires an explicit choice.
Expiry and revocation take effect immediately, terminate running leases and produce an audit entry.

Option 2 contributes convenience only: a provider/channel configuration reference may propose a grant with agent,
secret, purpose and expiry prefilled. Only explicit Owner confirmation makes it effective. A configuration change
alone never creates a grant.

Secret values go only to the tool or provider adapter through its lease, never to the model itself. `secret_names`
must expose only names/descriptions covered by a currently valid grant. Configuration references are not grants.

Phase E remains the read-only Owner view. Effective grants remain empty under the current implementation. Grant
creation, revocation and the lease enforcement lifecycle above require a separate subsequent implementation step;
this decision does not introduce writers or authorize agent value access in Phase E.
