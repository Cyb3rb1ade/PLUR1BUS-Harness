# Native coding turns in assigned card worktrees

K2a connects a native D115 coding delegation to the worktree provisioner and
sandbox introduced by #820. This changes no RPC schema, Engine pin or public
configuration field. K2's model benchmark and owner baseline remain separate.

## Authority and lifetime

The held delegation supplies the actual project, receiving agent, sender and
person. A requested card ID only selects a card. Before provisioning, the live
board must contain an active project and unarchived card. A delegation requires
both agents to remain assigned. Ownership handoff checks the sender in the trusted
acceptance callback, assigns the receiver and removes the sender; subsequent
admission therefore checks the receiver's live assignment. The existing `GitWorktreeProvisioner` is the only component that creates
a missing checkout. A lookup alone never creates one.

The native request carries an opaque, in-process `WorktreeMount`. Serializing a
mount, inventing an object or supplying a raw path grants no authority. The
binding fixes the provisioned row, canonical checkout, Git metadata and directory
identity. Every bound tool invocation rechecks the row, assignments and executing
agent/person identity after dispatcher authorization, including file and host tools.
The registry carries this synchronous admission check into the dispatcher, which
remains the sole caller of tool execution; approval waits cannot bypass a fresh check.
Process admission additionally rechecks the row and assignments; observed revocation
invalidates the grant permanently. A final synchronous check immediately precedes
the child spawn. Revocation prevents subsequent admission; it does not claim to
terminate a process or asynchronous tool operation already admitted.

Only writable card delegations and ownership handoffs receive this grant. Consultation, read and review
turns receive none. The provider's candidate first-party tool names are intersected
with the handoff's declared tools. The live tool registry and ordinary dispatcher
authorization still decide which calls may execute.

A write delegation without a card or repository binding receives no card mount.
Its declared tools are still intersected with the trusted first-party view and
use the receiving agent's configured ordinary roots. Linux native execution still
refuses a missing writable mount; this does not create a project-root fallback.

## Containment and resource bounds

Only native `exec.run` receives the mount. Host process, system, package, clipboard,
notification and app tools retain their existing policy. A native grant cannot
enable an unsandboxed owner bypass or upgrade a read-only turn.

Linux requires the detected `namespace-limit` backend, the limits helper and a
positive required task cap. Missing capabilities fail closed. The exact card is
writable; sibling cards, the original checkout, Core state and common Git metadata
remain outside that writable grant. Existing Git metadata is mounted read-only.
Native macOS Seatbelt operation and macOS ACP refusal retain their existing paths.
Card-bound ACP lookups now also require the active card's receiver assignment;
an unassigned external agent is refused instead of receiving that card's checkout.

The Linux native process uses the existing ACP 8 GiB virtual-address-space
profile. Node 24 cannot initialize under the generic 512 MiB Linux `RLIMIT_AS`
profile; virtual address reservation is distinct from resident memory. Generic
execution and native macOS retain their 512 MiB profile. This changes neither the
task cap nor the execution deadline and provides no host memory allocation.

## Large repositories and aliases

Admission builds a complete inventory tied to the live grant and canonical root.
Subsequent admissions re-enumerate new or changed directories while freshly
checking every known entry's identity and link count. Directory timestamps or
watcher events alone never establish alias safety. Replaced directories trigger
a complete rebuild within the same admission budget; inconsistent or incomplete
inventories fail closed. Retention is bounded to one million entries per live
grant, with at most 16 concurrent filesystem operations and a 30-second maximum
admission budget. Cancellation waits for outstanding operations to settle.

A hard-linked file is admitted only when all inode links are accounted for inside
that exact card. A contained hardlink-only package store therefore works, but external stores,
sibling cards and protected paths acquire no exception. Protected credential
aliases are checked both during preparation and the final backend refresh.
Symlinks, special entries and filesystem crossings are refused for native mounts.
Package installations that create symlinks, including typical npm/pnpm layouts,
therefore prevent subsequent native process admission under this strict policy.
These checks do not constitute an atomic filesystem snapshot: the kernel sandbox
remains responsible for the admitted process's containment.

## Verification and remaining acceptance

Focused tests exercise real SQLite/Git assignments, provisioning, production
delegation, the actual composed dispatcher and native process execution. Negative
cases cover sender/receiver/card/project revocation, forged and foreign mounts,
unbound and read-only turns, host tools, symlinks and outside hardlinks. Positive
cases include two isolated simultaneous cards, contained store links and cold,
warm and newly populated inventories exceeding 20,000 entries. Existing ACP,
coding-gate and sandbox regressions remain in place.

A native macOS regression attempts to hard-link the fixture repository's actual
Git config into the writable card and modify it. A normal card write succeeds,
and an unsandboxed control proves the same user and filesystem can create that
link. Seatbelt refuses the sandboxed link; the Git config remains byte-identical.
Held-registry tests also refuse subsequent reads and writes after receiver,
sender, card, project or worktree revocation, and calls with a foreign identity.

The Linux-only production composition test runs a genuine copied Node binary
with its normal options; unavailable required isolation fails that positive test.
macOS evidence cannot establish Linux acceptance. Windows remains unsupported for
this native writable backend and must refuse. Existing platform skips and macOS
ACP acceptance TODOs are reported separately rather than counted as passing
containment evidence.

The PR still requires current-head CI and a separate Claude review before merge.
After K2a merges, K2 consumes its reviewed API and obtains genuine Linux integration
evidence. Model credentials, captures and the real B1 baseline require the owner's
separate workflow; none is authorized or established by these fixture tests.
