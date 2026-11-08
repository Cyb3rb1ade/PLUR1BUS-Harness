# Team core contract (TK)

The human `team.*` RPCs store bounded plans, immutable approval bindings and pending
commands. They do not call the transition function or execute actions. PT-4b owns
persistence, reconciliation, authenticated event construction and execution.
Under ADR-019/D131, PT-4b is implemented in Rust as part of P4-50; TK's existing
TypeScript persistence surface is running work and supplies the parity contract.

`rpc.schema.json` is the wire source. TypeScript is generated from it and Rust uses
`typify`; the native boundary additionally validates schema limits and closed objects.
The same fixtures under `packages/rpc-schema/fixtures` are consumed on both sides.
Plan and policy hashes use recursively key-sorted UTF-8 JSON with SHA-256.

## Checker inputs

`tools.team.check` receives a plan, repository file inventory, workflow contents and
an effective project policy. The Core must supply the complete inventory, including
unreadable workflows as `content: null`. No method reads the filesystem or opens a
network connection. Project path and branch restrictions only add protection.

Globs contain literal path segments, a whole-segment `*`, or `**` (zero or more
segments). Embedded wildcards such as `*.ts`, character classes, absolute paths and
traversal are refused. Explicit files or `src/*` express those scopes. The intersection
algorithm searches the product of two finite automata; it does not infer disjointness
from the current file inventory.

The Core/PT-4b shell safely parses workflow YAML and supplies `workflows[].content`
as JSON, together with the complete inventory and an explicit `sectionBranchPattern`.
Rust does not parse YAML. Non-JSON, unreadable contents, unknown keys/events/filters,
unresolved workflow references and cycles conservatively mean possible deployment.
`push`, PR/PR-target `closed`, `merge_group` and their `workflow_run` chains are checked
against branch filters. Workflows may execute opaque code regardless of their job names.

The report's required `targetDeploys` and `targetDeployReasons` describe the target
branch separately from package lanes. Matching `deployBranches` policy entries count
too. Deployment on the target requires an exact human-confirmed section-to-target
merge, even under `auto`. Packages become closed for deployment only when a direct
merge trigger (`push`, PR/PR-target `closed`, or its `workflow_run` chain) also matches
the section branch language. `merge_group` affects the target only: **PT-4b must never
create section branches with branch protection or merge-queue rules.** The Harness
merges section branches locally, never through a GitHub queue (Owner ruling 2026-11-07).
Unsupported GitHub glob syntax remains conservative; partial exclusions of a section
pattern do not prove that every possible section branch is excluded.

Ruling (D127 K4 amendment): the deployment gate belongs to the merge that deploys.
This preserves usable contained/wide lanes while requiring human approval before any
merge onto a deployment target. An incorrect branch classification could permit an
automatic deployment, so the full inventory and the section-branch premise are required.
The checker report participates in `checkHash`; a changed deployment report invalidates
approval. The shell must fill required boolean `run.targetDeploys` from that report;
missing or null values are rejected. Protected lockfiles, Cargo/toolchain configuration
and audit policy remain closed independently of deployment classification.

`tools.team.diffcheck` prioritizes interface/shared restrictions over an overlapping
own declaration. `tools.team.impact` includes explicit dependencies, consumed provided
interfaces, declared ownership overlaps and supplied changed-file overlaps. Cross-section
impact or fan-out of five becomes wide; a closed lane is never downgraded.

Approvals bind plan hash, checker hash, composition hash, effective policy hash and scope.
A changed composition or policy invalidates prior approval. Project settings are stored
under `settings.collaboration.teams`; only the future human-authorized settings shell may
change them. Installed configuration supplies defaults, while project restrictions are
unioned with those defaults. Neither source can remove built-in protected classes.

## Transition and executor boundary

`tools.team.next` accepts the closed `plur1bus.teamstate/1` snapshot and an event.
It returns a replacement snapshot and typed actions. Event sequence numbers come from
`team_events`, increase monotonically and are unique within a run. Replayed sequence
numbers produce no actions. Package events bind the writer epoch; lead events bind the
lead epoch. Stale epochs leave the entire state untouched, including the sequence cursor.
The shell must serialize events and atomically compare the persisted state version when
storing the result and outbox. A sequence gap is allowed after an ignored stale epoch.

All human events are constructed from an authenticated human RPC decision. A model's
message is never an approval event. The Core supplies checked plan/report/composition/policy
hashes, calculated lanes, measured capacity/disk/budget availability, eligible confirmed
members and revert-rate facts. `autoAllowed` is resolved project policy, not model output.
Only the checker supplies lanes. PT-4b must build the initial state from those trusted
records; `tools.team.next` is not an alternative plan-approval endpoint.

Checks bind both the package tree and section head. Outcomes identify the check index and
criterion; every declared check must pass. Worker `met` is consulted only for criteria
without a check. Missing and unavailable outcomes fail. A new section head invalidates
old merge confirmations and requires fresh checks before a merge proposal.
An obsolete `checks.finished` while checking invalidates the result and immediately
emits `run-checks` against the current snapshot. The executor persists that snapshot
and action together; it must take the current package tree and section head from it.

Ruling: scope `package` never permits an autonomous merge into the section, even for
a contained package. A human must confirm the exact tree and section head. This is
deliberately stricter than D124 Q7 and costs one additional approval step.

A stop action increments the epoch first. `writer.stopped` acknowledges the new epoch and
permits subsequent work; `stopEpoch` identifies the revoked session. Handover additionally
waits for `handover.committed` before starting the replacement. The shell commits dirty work
with hooks off and never stashes; an A2A stop revokes its local binding and rejects old
artifacts. Reviewer handover keeps the original writer and chooses a distinct confirmed
reviewer. Lead holds pause the run and carry independent epochs and deadlines.

Actions have stable SHA-256 identifiers derived from run, event sequence and action index.
PT-4b must execute each idempotently and turn completion into a new event. `restart` with
`reconciled: true` is allowed only after inspecting worktrees, session liveness and in-flight
merges and recording already completed effects; pending actions are replayed, not guessed
from the snapshot. Timers and quota probes are actions/facts only: TK performs no probes,
model calls, worktree operations or merges.

## Binding prerequisites before PT-4b

[TK-Folgen vor PT-4b (#901)](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/issues/901)
tracks the remaining L1–L5 prerequisites from the Controller review of #900. Resolve
them before enabling the executor: uniform run visibility errors, trusted A2A peer
binding, cross-language hash parity, traversal-free config globs and cancellation/approval
ordering. Unknown A2A peers must be refused; an owner role alone does not establish peer trust.
M1–M3 are implemented in TK under the Owner ruling above.

Composition confirmation is allowed only before the first outbox action. Pending,
applied, completed and failed action history all require shell revision handling;
re-confirmation must not reset an executing run to planning or invalidate its approval.
