# Agent secret leases — owner decision pending (Phase E)

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

Owner question: which authority model should a later implementation use? No answer is assumed and none of these options
is implemented by Phase E. Values remain unavailable to agents under all current code paths.
