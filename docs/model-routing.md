# Per-agent model routing

Agents can opt in to the decision service for choosing a model tier. Configure named
[model profiles](providers.md#configuring-profiles) first, then list them in increasing
capability and cost:

```json
{
  "agents": {
    "bernd": {
      "model": "fast",
      "modelPolicy": {
        "mode": "auto",
        "tiers": ["fast", "balanced", "strong"],
        "perTurn": false
      }
    }
  }
}
```

The policy is live configuration. `mode` defaults to `fixed`, `tiers` to an empty list,
and `perTurn` to false when the policy object is present. Auto requires 1–16 distinct
profile names. A missing policy keeps the existing D105 model-class/task-boundary routing
unchanged. An explicit `fixed` policy uses the agent's `model` (or the configured default)
and still runs D105 for task/capability classification. Fixed mode ignores any stored auto
`tiers` list and retains only that profile's existing candidate fallback; switching to auto
activates the tier list.

In auto mode, the shared decision client receives the current message, task count,
planned-tool count, context size and previous completion status. It chooses a tier with
`choice`; it receives no transcript or memory store. Oversize primitive input, low
confidence, backend absence or deadline uses an eligible cached/agent model, or the first
eligible declared tier. If only one tier is eligible, selection is deterministic. With
no eligible tier, the turn fails instead of trying an unrelated profile.

By default, the actual served model is retained for the session. Changing the task's
complexity does not request another routing decision. `perTurn: true` opts in to choosing
again on each turn. A `/model` or stored `modelProfile` selection wins over either policy
and does not overwrite the auto cache. A cancelled or unsuccessful provider response does
not commit a new cached selection.

The selected tier and the tiers following it form the failover order. Within each profile,
its existing candidate order remains in force; duplicate provider/model pairs are tried
once. Failover never returns to an earlier tier or opens another configured profile. After
a successful fallback, the actual served model becomes the next turn's starting point,
including a fallback inside the same profile. The selected profile's request defaults
apply across the request, matching the provider router's existing fallback semantics.

The existing router still enforces budget, credential leases, egress, retry limits, billing
consent and current privacy for each attempt. A tier list cannot authorize cross-billing
or a forbidden cloud model. Live local-only changes invalidate forbidden cached models;
an explicit forbidden cloud override remains a refusal. Voice turns retain their existing
feature budget and allowed-model filter. Natural routing messages do not grant cloud
disclosure eligibility to a separate cloud decision backend.

Each actual model admission emits an owned `model.selected` session event containing the
provider/model, tier, requested tier, policy source and stable reason code. It contains no
message, tool output or generated explanation. Existing session/transcript RBAC controls
replay. A completed owned event restores a stable choice after a Core restart or cache
eviction; failed turns are ignored. A failed metadata read refuses routing instead of
guessing a different cached model. Incognito uses its volatile session store.

Context reservation includes the current agent's declared tiers before selection. No
new RPC method is required: configure policy through the existing config surface and
inspect events through the session stream. The shared decision service's diagnostic RPC
remains the F2 interface; the settings UI follows F7.
