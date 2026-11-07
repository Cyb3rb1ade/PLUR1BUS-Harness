# B1 original coding corpus

D120 §6.6 / Q21: all 24 tasks, starting trees, reference solutions, generators and hidden assertions were authored
for this repository. They use the repository MIT licence, copied in [LICENSE](LICENSE). No upstream benchmark tasks,
third-party task files, external datasets or derived fixture material are included. Rust, TypeScript, Python, Go and
POSIX shell use only their standard runtimes/libraries; no task downloads dependencies or accesses the network.

There are eight tasks per tier, twelve repository tasks and twelve terminal tasks. The language totals are Rust 5,
TypeScript 5, Python 5, Go 5 and shell 4.

| Task | Tier | Language | Kind |
| --- | --- | --- | --- |
| [easy-go-lookup](easy-go-lookup/task.json) | easy | go | repository |
| [easy-go-unique](easy-go-unique/task.json) | easy | go | repository |
| [easy-python-merge](easy-python-merge/task.json) | easy | python | repository |
| [easy-python-normalize](easy-python-normalize/task.json) | easy | python | terminal |
| [easy-rust-duration](easy-rust-duration/task.json) | easy | rust | terminal |
| [easy-rust-window](easy-rust-window/task.json) | easy | rust | repository |
| [easy-shell-lines](easy-shell-lines/task.json) | easy | shell | terminal |
| [easy-ts-tags](easy-ts-tags/task.json) | easy | typescript | repository |
| [hard-go-ndjson](hard-go-ndjson/task.json) | hard | go | repository |
| [hard-python-cache](hard-python-cache/task.json) | hard | python | repository |
| [hard-python-sqlite](hard-python-sqlite/task.json) | hard | python | repository |
| [hard-rust-intervals](hard-rust-intervals/task.json) | hard | rust | repository |
| [hard-shell-export](hard-shell-export/task.json) | hard | shell | terminal |
| [hard-shell-paths](hard-shell-paths/task.json) | hard | shell | terminal |
| [hard-ts-events](hard-ts-events/task.json) | hard | typescript | terminal |
| [hard-ts-workers](hard-ts-workers/task.json) | hard | typescript | repository |
| [medium-go-config](medium-go-config/task.json) | medium | go | terminal |
| [medium-go-truncate](medium-go-truncate/task.json) | medium | go | terminal |
| [medium-python-log](medium-python-log/task.json) | medium | python | terminal |
| [medium-rust-tokenizer](medium-rust-tokenizer/task.json) | medium | rust | repository |
| [medium-rust-word-index](medium-rust-word-index/task.json) | medium | rust | terminal |
| [medium-shell-retain](medium-shell-retain/task.json) | medium | shell | terminal |
| [medium-ts-migrate](medium-ts-migrate/task.json) | medium | typescript | terminal |
| [medium-ts-topology](medium-ts-topology/task.json) | medium | typescript | repository |

## Fixture contract and provenance

Each directory contains a closed `task.json`, `start/`, `reference/`, `generate.mjs` and `checker.mjs`. Instructions
and signatures are public; the runner renders a README and seeded entry file for the model. The three canonical seeds
live only in `seed.mjs`: identifiers, constants and filenames vary deterministically. These are task variants, not
provider sampling seeds. Public corpus content is SHA-256 addressed, including checker, reference and generator bytes.

The common `check-*.mjs` modules contain original assertions. `bridge-*` files serialize one invocation or inspect its
observable effects; they contain no reference solution or expected answer. Expected values stay in the parent coordinator.
Candidate code, thin bridges and executable bytes are restored before each hidden invocation; only test data persists.
Native code is compiled separately, its bounded executable copied into parent memory, and its compiler directory removed
before execution. A model cannot satisfy a checker by printing a pass marker.

`--fixture` runs only our trusted starting and reference files in fresh private copies: all 72 starts must fail and all
72 references must pass the same checker. It uses no model, live credentials or provisioner worktree and explicitly emits
`fixture-selftest` evidence. Unsupported/missing runtimes fail; there are no successful skips. Run from the repository root:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts --fixture
```

The supported fixture hosts are macOS and Linux with the repository Node/Rust toolchains, Python 3, Go >=1.22, Git for
live seed authoring, and POSIX shell. Windows command isolation is explicitly unavailable. The regular Core tests exercise
that refusal; the full five-language fixture command runs in the selected Linux unit job.

## Live boundary

Live execution requires merged #820 and K2a. The shared `GitWorktreeProvisioner` creates every agent and private verifier
workspace as a Card-worktree below its disposable home's `state/worktrees`. The turn receives the opaque database-backed
mount and real chained task grants; a path string cannot substitute for that authority. K2 does not change sandbox policy,
implement another worktree backend or bypass the normal coding dispatcher. Native `plur1bus-tools` health and the actual
writable process port must pass preflight before a model request. Compiler copies/caches live within the granted worktree;
no writable toolchain aliases or additional writable roots are admitted. Reference solutions and hidden checkers never enter
an agent's files, Git history or readable roots.

Only Linux live captures qualify, matching the Nightly host. Missing provisioning, grants, isolation or measured provider
usage invalidates the measurement; no fixture replay substitutes for live evidence. Each case's whole private seed/home is
removed after handles close. No host Git is invoked against post-agent metadata, including during cleanup.

See [the operator instructions](../../../docs/turn-eval.md#b1-coding-benchmark) for owner capture, redaction, pairing and gates.

## Quarterly rotation

The initial set is introduced in 2026-Q4. Beginning in 2027-Q1, replace six tasks per quarter: two from each tier. Replace
like-for-like language and repository/terminal kind so the balance above stays fixed. The owner reviews originality, licence,
public contract, adversarial hidden cases and three-seed start-fail/reference-pass evidence before admitting replacements.
Record the new task's introduction quarter in its metadata. Keep old reports immutable; a changed corpus hash requires a new
owner live baseline and never silently pairs with the previous quarter. Rotating seed numbers alone does not count as a task
replacement. No automated rotation or upstream import is enabled by this preparation.
