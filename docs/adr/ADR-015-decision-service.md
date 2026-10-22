# ADR-015: Decision service

**Status:** Proposed implementation contract; implements owner decisions D18/D30/D33/D34/D69/D70,
without claiming acceptance of new implementation choices. **Date:** 2026-10-20.
**Decider:** Christian (owner).

## Context and sources

The harness needs one decision boundary for cheap classification, selection and scoring. The
existing `modelRoles.decision` must remain usable until local backends and System One are ready.
This ADR records the boundary before F2 introduces runtime behaviour.

Repository evidence at `31f8dd62cb1bf022ae99cae58a9538e38df5c918`:

- [Core design](../superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md), D18, D30,
  D33, D34, D69, D70, D105 and §7.1: primitives, routing/cache discipline, pruning, backend
  and German gate requirements.
- `packages/core/src/session/role-routing.ts:25`: decision-role JSON classification through the
  existing provider router. `packages/core/src/triage/runtime.ts:7`: 200 ms default and core-only
  fallback; task boundaries preserve active recommendations.
- `packages/core/src/session/pruning.ts:8`: `LayaDecisionPort` is a port, not an installed Laya
  backend; `:54` protects approval/audit evidence in addition to the last K completed turns.
- `packages/core/src/privacy/local-only.ts:23`: installation/agent inheritance and explicit
  endpoint allowlisting define locality; the service reuses these rules.
- [D116 design](../superpowers/specs/2026-10-20-memory-tree-relationships-design.md), §§7–8:
  confidentiality fallback, `TreeChooser`, two-branch zoom and parallel flat recall.
- [ADR-012](ADR-012-process-model-and-languages.md), D14 process boundaries;
  [ADR-016 §6](ADR-016-api-stability-and-versioning.md#6-events-are-harness-owned), mapped events;
  [ADR-010](ADR-010-latency-and-caching.md), cached prefix versus dynamic suffix.

System One shapes were checked against the primary [Noul](https://docs.typesafe.ai/primitives/noul),
[Choice](https://docs.typesafe.ai/primitives/choice) and [Score](https://docs.typesafe.ai/primitives/score)
documentation on 2026-10-20. Noul is a yes/no probability; Choice supplies a selected key and
probabilities over a declared set; Score uses an ordered rubric. The harness owns its normalised
contract; a backend adapter translates its wire format. No upstream SDK dependency is required.

## Decision: module with one Core client

D70's delivery unit remains the supervised D14 module **`plur1bus-decision`**, installed and shown
as a plugin. The module owns Laya inference and the shared Jev/Kev client; Kev itself runs as a
supervised Python module (ADR-012), never through kevMac. Engines remain store-independent.

The Core owns one `DecisionClient` boundary, consumer safety policy, request context, trace and
metrics. F2 may implement this boundary as a Core service and keep `role` in-process: it must use
the existing provider router so auth leases, model budgets, local-only checks, retries and usage
settlement remain authoritative. This is an explicit staged implementation, **not completion
of D70 packaging**. The module transport replaces the backend port without changing consumers.
Do not instantiate a second ONNX engine or memory store in the Core decision client.

F1 defines configuration only. It neither installs a backend nor advertises decision RPC methods.
Future RPC starts experimental with closed params, `x-since`, `x-server`, RBAC and inventory coverage.
`decision.status` returns aggregate health; `decision.test` is Owner/Admin, **humanOnly**, bounded
and uses a fixed synthetic example. It must be excluded from model tool surfaces.

## Primitive contract (`plur1bus.decision/1`)

Common input: `requestId`, `useCase`, `agentId`, optional `sessionId`/`turnId`, `locale`, an absolute
monotonic `deadline`, caller `AbortSignal`, and **bounded** `state` / `features`. Context comes from
the authenticated caller, never from model-supplied identity fields. State is untrusted data, not
system instructions. Features are named text, finite numbers or booleans; no secret values,
provider credentials, raw files or store handles. Bounds: state 16,384 UTF-16 code units, up to
32 features, text feature 1,024 code units, question 2,048 code units, response 65,536 code units.
Oversize input is refused, not silently truncated where doing so could change the decision.

| Primitive | Additional input | Valid output |
|---|---|---|
| `noul` | question/statement, optional yes/no descriptions | `probability` in [0,1]; yes means the statement holds; never treat probability as a boolean |
| `choice` | question; 2–255 unique stable option IDs and bounded descriptions; explicit `none` where the set is incomplete | selected `id` from that set; one probability per ID, no extras, finite, [0,1], sum within 0.000001 of 1; selected ID has maximal probability |
| `score` | question; 2–10 ordered, described rubric levels | per-level probability distribution; fractional `score` = weighted level index, range [0, levels−1] |

Common success envelope: primitive, request ID, backend/model revision, elapsed milliseconds,
`confidence` in [0,1], `confidenceSource` (`backend`, `derived`, `uncalibrated`), optional bounded
`reason` and a stable harness `reasonCode`. Noul adapters derive confidence as `max(p, 1−p)` and
mark it **derived**; Choice/Score use backend confidence when present. A role model's self-report
is **uncalibrated**, never presented as measured accuracy. A backend need not generate prose:
`reason` is optional; deterministic reason codes suffice. No hidden reasoning is requested.

Failure is a tagged result, not a fabricated model answer: `unavailable`, `timeout`, `invalid`,
`low-confidence`, `privacy` or `cancelled`. It includes elapsed time and attempted eligible backends,
never provider error text or response content. Cancellation propagates; consumer fallbacks below
apply to unavailable/invalid/uncertain results, not to a cancelled foreground task.

The D105 classifier also returns segmentation, category and class distributions. Its existing
validated `plur1bus.triage/1` payload must survive the role migration byte-for-byte in meaning.
F2 keeps an internal compatibility adapter for that structured classification while moving its
execution, deadline and trace through the same client. It is not a fourth public primitive and
must not claim that an arbitrary triage JSON object is a portable System One Choice result.
Backend-neutral decomposition into typed questions follows only with regression evidence.

## Deadlines, fallback and backend selection

One request owns **one** deadline: minimum of remaining caller time, `decision.timeoutMs` and
`decision.budgets.<useCase>`. Attempts and an optional schema repair share that budget; fallback
never resets it. Abort is forwarded, timers/listeners are cleaned up, late results discarded.
No backend may hold the foreground open by ignoring its signal. Start no attempt after expiry.

Default selection is **`role`**, preserving current installations. Explicit `role|laya|kev|jev`
tries the named backend if installed/eligible, then eligible `role`, then the consumer fallback.
`auto` considers Jev with a usable lease, then Kev only where its hardware/language spike passed
and beat Laya, then eligible Laya, then eligible role. De-duplicate attempts. Backend absence,
invalid output or low confidence may advance while time remains. Explicit Laya stays available
if its German gate fails, with a diagnostic; auto never chooses it for German in that state.
Kev is not shipped/offered before its gate passes. Missing gate evidence is not a pass. Unknown
or mixed locale takes the stricter applicable gate until evaluation supports a broader policy.

D33 historically requests Laya before Jev. Resolve the apparent conflict with global D70 auto:
pruning may supply a local-first preference (`laya`, eligible `kev`, `jev`, `role`), but **explicit
installation backend selection wins**; privacy and eligibility win over both. Record the order
in the request trace. F2 has role only and therefore cannot claim local-backend availability.

Privacy refusal for an explicitly selected forbidden cloud backend is terminal, in keeping with
`privacy/local-only.ts`; do not silently replace that explicit model. Auto first filters forbidden
backends, and can choose a permitted local backend. Every fallback rechecks current privacy.

## Consumers, budgets and conservative result

These are proposed implementation defaults, bounded by the caller. Existing consumer protection
and stricter D116 thresholds always win; reducing a service threshold never authorises disclosure.

| Use case | Status at baseline / planned phase | Default max ms | Confidence floor / fallback |
|---|---|---:|---|
| D105 message triage | role JSON exists; F2 shared execution | 200 | 0 keeps existing validator; malformed/deadline → current core-only fallback |
| D30 model routing | class-profile routing exists; F5 session policy | 200 | 0.7; retain fixed or already selected session model; no mid-session change without opt-in |
| D33 tool-output pruning | port + heuristic exists; F2 adapter, F6 three-way result | 100 | 0.7; keep originals; timeout → compaction without pruning |
| D69 skill injection | current skill pipeline exists; F6 decision selection | 100 | 0.7; no additional dynamic skill; explicit pins/blocks remain authoritative; max 3 per turn |
| D116 placement / level | design only; C3/F7 adapter | 200 | 0.7; category placement, confidentiality **confidential**; person override wins |
| D116 zoom recall | design only; C4/F7 adapter | 150 per level | minimum 0.35, pick at 0.6; middle → two branches; below/deadline/none → existing parallel flat recall |
| D33-like compaction choice | compaction exists; decision enhancement pending | 200 | 0.7; existing D23 summary; no destructive edit to append-only history |

Pruning cannot alter user/assistant text, last K turns (3), pending follow-ups, restored outputs,
approval/audit evidence or uncertain pairs. `keep` preserves bytes; `truncate` retains head/tail
and a ref marker; `drop` retains a call/status/argument-hash stub. Originals stay retrievable.
Skill selection writes only the dynamic suffix (ADR-010). Session routing records model and reason;
its tier list also defines failover. None of these decisions grants permissions or bypasses D109.

## Configuration and rollout

`decision` is a closed namespace. Every field is `x-restart: live`, `x-tier: advanced`:

- `backend`: `role|laya|kev|jev|auto`, default `role`.
- `timeoutMs`: integer 1–60,000, default 200; retains the existing D105 key.
- `budgets`: `triage:200`, `routing:200`, `pruning:100`, `skills:100`, `placement:200`, `zoom:150`,
  `compaction:200`, each integer 1–60,000. Effective deadline uses the minimum above.
- `confidence`: `triage:0`, `routing:0.7`, `pruning:0.7`, `skills:0.7`, `placement:0.7`, `zoom:0.35`,
  `compaction:0.7`, each finite [0,1]. D116's own pair/pick and disclosure thresholds remain binding.
- `classProfiles`: optional `small|medium|large|frontier` profile names, 1–128 characters,
  preserving the existing D105 setting and task-boundary loader. Empty/whitespace-only invalid.

New keys are contract-only in F1. Old configs without `decision` receive defaults. Existing
`timeoutMs` and `classProfiles` remain accepted; previously arbitrary undocumented keys now fail
validation instead of appearing to configure a backend. F2 must read settings per request, with
no process restart required. Endpoints, model hashes and lease references belong to the normal
provider/module/catalogue configuration, never inline API keys under `decision`.

## Calibration and German gate

F3/F4 use the §7.1 **60-item paired German/English** dataset: routing, D22 sensitivity, D30 tiers,
D33 keep/truncate/drop; extend with labelled triage, skills and D116 cases per consumer. Fix labels
and splits before measurement. Report model/artifact hash, backend version, hardware/OS, cold/warm
p50/p95, peak memory, accuracy, Brier and sample count per language/use case, alongside role.
Accuracy alone does not establish calibration. Fit temperature only on the calibration split and
report held-out results; version the calibration record with model + task + locale.

Gate from the binding spec: German accuracy no more than 5 percentage points below English and
German Brier no more than 0.05 above English. Missing cases, model revision change, failed gate
or unmeasured platform leaves auto eligibility unproven; never substitute English-only numbers
or fake latency for native evidence. Role regression remains required even if a local model passes.

## Trace, metrics and privacy

Emit a harness-owned `decision.completed` **turn event** for request completion, mapped according
to ADR-016 §6. Keep optional session/turn linkage (background calls may lack it), use case,
primitive, backend/revision, eligible attempt order, elapsed time, outcome, confidence/source,
calibration revision and stable reason code. Record routing tier, pruning verdict/tokens saved,
selected skill IDs or branch IDs only inside the authorised turn store. The persistent global
status aggregates counts, p50/p95 and failures; it contains no prompts, option descriptions,
user text, summaries, private relationship IDs, raw errors or model-generated reasons. Trace
schema, publisher, storage readers, RBAC, inventory and Rust tables must land together in F2.
Telemetry failure cannot invalidate an otherwise admitted decision.

The caller constructs the smallest permitted view before a backend sees it. Cloud-eligible data:
explicitly permitted bounded query/task excerpt and visible candidate IDs/names/short summaries,
subject to current agent privacy, provider consent and source confidentiality. Cloud-forbidden:
secret values, private relationships/entries, break-glass payloads, unfiltered stores, full
transcripts or raw tool outputs. No free-form feature field may smuggle them into an allowed call.
If disclosure cannot be established, use local processing or the consumer fallback.

`privacy.localOnly` is evaluated through the current shared locality helpers for the authenticated
agent; shared jobs use `localOnlyShared`. Jev cannot run under local-only. A role is local only
when its selected provider is local, including after provider failover. Unknown locality fails
closed. Egress is mandatory even when a provider is otherwise privacy-eligible: D73 policy,
POST-capable request port, origin/address pinning, byte cap, deadline and redirect checks. Keys
come from secret-store leases scoped to agent/secret/purpose; never log a key or attach it to a
cross-origin redirect. This work authorises **no paid or cloud model call**: F4 tests use loopback
with recorded response shapes until the owner authorises real calls in chat.

## Options and consequences

| Option | Benefit | Cost / disposition |
|---|---|---|
| Core-only service forever | easiest role migration | contradicts D70 delivery; rejected as final architecture |
| Module-only from the first commit | final process boundary immediately | provider-router and secret/budget duplication risk; stage behind one Core client |
| Separate decision code per consumer | simple individual changes | privacy, deadlines and telemetry diverge; rejected |
| One client, module backend ports, role compatibility bridge | preserves behaviour and D70 direction | temporary compatibility adapter and module packaging work; selected |

No new owner question blocks F1. Module delivery remains an explicit F3/F4/F7 action, not a
silent replacement of D70. Native measurement, German calibration, real Jev approval and
controller-managed Engine pinning remain separate evidence gates.
