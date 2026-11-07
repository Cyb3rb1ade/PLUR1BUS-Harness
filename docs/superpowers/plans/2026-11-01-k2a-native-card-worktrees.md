# K2a: native coding turns bound to provisioned cards

Status: implementation waits for #820 to merge. This is the owner-authorized follow-up, a separate ready PR based on main, with a separate Claude review before controller/owner merge. K2 preparation and this plan do not establish Linux acceptance or authorize a model run.

## Scope and prerequisites

Merge main after #820. Reuse its sole `GitWorktreeProvisioner`, opaque mount identity, revocation checks, Linux opt-in and bubblewrap containment. Rename ACP-only mount names neutrally where native coding also consumes them. Do not add RPC methods, another Git implementation, a raw-path grant or a sandbox fallback. Ask the owner for an allocated RPC version only if an actual schema change becomes necessary.

The handoff is a trusted, live D115 card assignment to a native coding turn, then an opaque mount through `composeTools` and `createSandboxProcessPort` to `SandboxPolicy`. Host tools do not receive it. Reconcile the exact API against merged #820 before implementation; unmerged passthrough code is not an approved dependency.

## H-1: no writable root for an unbound or consultation turn

- Empty or missing card bindings never obtain a mount, including the project's root checkout.
- Only a trusted card-bound delegate/handoff obtains the native coding grant. `consult_agent` remains without this grant.
- A missing mount must preserve Linux's existing refusal of writable roots. Do not auto-mount a project's root checkout to make a turn run.

## H-2: authenticate the card assignment before provisioning or mounting

- A model-supplied `cardId` is a selection request, not authority.
- Resolve the card through the held project and live store. It must exist, be unarchived and have the receiving `agentId` as an agent assignee.
- A delegated grant also requires the sender's assignment. Derive sender/receiver identities from trusted composition, never model arguments.
- `root()` must not create worktrees for arbitrary IDs. Check the card before any auto-fork, and independently check `agentId` at `mount()`.
- Unknown, archived or foreign cards create neither a writable grant nor a new worktree. Keep grant revocation live throughout subsequent process admission.

## M-1: keep host-tool exec outside the opt-in

Pass the grant only to the native coding `exec.run` process port. Do not forward it to `createSandboxHostExec` or package, clipboard, notification, system, process or app tools. Their existing Linux writable-root refusal remains observable even inside a bound coding turn.

## M-2: preserve ACP-equivalent Linux resource gates

A native writable mount requires a positive task cap, the detected `namespace-limit` mechanism and the helper's required-task flag. Reject `maxTasks=0`, an absent helper or a weaker mechanism before spawning the writable workload. Keep the native macOS Seatbelt behavior and #820's macOS ACP refusal unchanged.

## L-5: scalable alias validation without accepting external hardlinks

The acceptance case includes a real repository with more than 20,000 entries, dependency installation that creates another large subtree, and subsequent coding commands. A global 20,000-entry inventory limit cannot be retained as successful behavior for that case.

The implementation target is a complete initial inventory tied to the live grant and canonical worktree identity, followed by incremental enumeration of new or changed directories. Recheck known entry identity/link metadata; cached paths, mtimes or watcher notifications alone cannot prove that a file has no new external alias. Invalidated or incomplete inventories fail closed and are rebuilt within the task's bounded admission budget. Revoked grants and replacement worktrees cannot inherit an old inventory.

For a pnpm/Git store genuinely inside the same permitted worktree, an inode may be accepted only when all of its links are accounted for inside that exact writable root. A link to a sibling card, root checkout, common Git directory, global pnpm store or any other outside path is still refused. A store's name alone grants no exception. Dependency copies may be used instead of shared external hardlinks; there is no broader writable store mount.

Measure the large-repository admission cost and test cold, warm and newly populated inventories. If the merged implementation cannot support those cases without weakening alias validation or extending containment scope, report the concrete design question to the owner before proceeding. This plan does not claim that incremental validation has already been implemented or proven safe.

## M-4: required acceptance matrix through the native composition

Exercise the real `composeTools` → `exec.run` path, rather than only the mount validator:

| Case | Required result |
|---|---|
| Unbound turn, missing/empty card, consultation | No mount; Linux writable-root execution refused |
| Assigned, active card | Only that provisioned card worktree writable |
| Sibling card, root checkout, `state/`, `commonGitDir` | Access remains refused outside the granted card |
| Unknown, foreign or archived card; unassigned sender/receiver | No grant and no fork |
| Two simultaneous turns on different cards | Each sees only its own permitted writable tree |
| Revoked/foreign grant or changed provisioned identity | Refused before process execution |
| Symlink ancestor/entry or external hardlink | Refused through native composition |
| Linux missing namespace task cap, zero cap, unavailable helper | Refused without fallback |
| Host-tool exec inside a bound coding turn | Existing Linux refusal preserved |
| Repository/store larger than 20,000 entries, internal and external aliases | Legitimate contained case works; outside aliases still fail |
| macOS native and ACP | Native Seatbelt behavior preserved; ACP still refused |

Linux CI must fail when its required backend is absent; do not add a skip to obtain green tests. Local macOS checks do not substitute for that Linux evidence. Ensure every spawned test process is killed and reaped on success, failure and abort.

## K2 consumption and remaining gates

After K2a merges, K2 consumes the exact reviewed API: shared provisioner, trusted card assignment, opaque grant and ordinary native coding turn. Run the prepared integration checks on Linux. Describe the owner capture on the same Linux platform as `coding-bench-live`, then stop before credentials/model use. The owner captures and accepts the real B1 baseline. K3–K8 remain gated until that baseline and its actual JSON are committed.
