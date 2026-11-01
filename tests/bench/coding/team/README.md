# Team-tier coding fixtures (D124 PT-2)

Eighteen original MIT tasks: twelve decomposable tasks and six coupled tasks, in TypeScript, Python, Rust and Go.
This package supplies tasks, private behavioral graders and arm planning data. K2 owns the B1 model runner,
worktree provisioner, public benchmark report and execution policy. No model baseline or throughput result is included.

| Task | Language | Kind | Packages |
| --- | --- | --- | ---: |
| `ts-event-ledger` | TypeScript | Decomposable | 3 |
| `ts-release-notes` | TypeScript | Decomposable | 3 |
| `ts-calendar` | TypeScript | Decomposable | 5 |
| `py-order-allocation` | Python | Decomposable | 3 |
| `py-document-index` | Python | Decomposable | 4 |
| `py-csv-import` | Python | Decomposable | 3 |
| `rs-range-set` | Rust | Decomposable | 3 |
| `rs-route-path` | Rust | Decomposable | 5 |
| `rs-frame-checksum` | Rust | Decomposable | 3 |
| `go-access-log` | Go | Decomposable | 4 |
| `go-retry-plan` | Go | Decomposable | 3 |
| `go-file-manifest` | Go | Decomposable | 3 |
| `ts-schema-migration` | TypeScript | Coupled | 3 |
| `ts-balance-reducer` | TypeScript | Coupled | 3 |
| `py-money-pipeline` | Python | Coupled | 3 |
| `py-url-pipeline` | Python | Coupled | 3 |
| `rs-frame-pipeline` | Rust | Coupled | 3 |
| `go-stock-ledger` | Go | Coupled | 3 |

## Corpus and public inputs

`catalog.json` is the explicit task list; K2's B1 loader excludes this `team/` directory. Both the materializer and
checker load manifests through `parseTeamTask`. Paths, symbols, exact ownership, backward dependencies, language,
three uint32 seeds and positive allocations are validated before use. Seed generators and references are trusted,
authored fixture source; arbitrary downloaded task generators are outside this interface's trust boundary.

The materializer copies only `start/`, the neutral instruction as `TASK.md` and allowlisted instance metadata.
The kind and package ownership remain private manifest metadata. `TASK.md` states the public entry points, runtime,
allowed neighbor files, optional text frame and input/output contract. It gives no routing label or ownership plan.
References and checkers are never copied into model input. Only src and the two public documents are snapshotted; Git/build/cache artifacts elsewhere are ignored.
The supplied contract module is fixed/read-only; editing it is an unresolved candidate. Linux snapshots pin directory
file descriptors and read regular files without following links. Links and special files are refused, traversal is bounded,
and failed materialization removes only its newly created destination.

Seeds 17, 104729 and 8675309 produce opaque names, seeded exported function names, numeric literals and three distinct
text-frame algorithms: sentinel, UTF-8 byte length, or byte length plus checksum. The numeric seed is host-only;
public metadata contains the instance tag, literal and frame profile. The frame has no private answer data.
`__SEED__`, `__PROFILE__` and `__SALT__` are expanded only by materialization. Every one of the 108
(task × seed × start/reference) variants is materialized twice and compared by path and byte hash.
Git enforces LF for the whole fixture tree.

All languages have actual public contract modules. Coupled stages consume typed `Packet` state containing the
preceding semantic result, stage identity and integrity stamp. Checkers test standalone stage behavior, corrupt/stale
state and prefixes using the actual preceding implementations. A correct later function therefore loses prefix grades
when its producer is broken. Coupled reference overlays update their shared source file; decomposable changes have
disjoint ownership. Calendar slot records, route summaries, search records and error-rate modules add real work at
four- and five-package boundaries. The source architecture and functional requirements remain visible to the solver.

Task allocations differ according to module count, validation groups and coupled-state work. They are provisional
benchmark caps, not measured recommendations or product defaults. **Before capturing a baseline after K2 merges,
pilot `single` and calibrate individual tasks toward roughly 40–80% resolution.** Review difficulty, case coverage and
budgets then; do not assert that structural complexity establishes that target. Freeze the calibrated corpus revision
with the first baseline. Matched plans derive tokens, `maxRounds` and `wallMs` directly from that task; all roles share
one allocation. Natural comparisons require a complete explicit allocation per canonical arm ID.

## Host oracle and execution boundary

The host retains the seed, private case IDs, expected results and reference paths. An input-only bridge receives raw
UTF-8 via stdin, including NUL. The sandbox returns SHA-256 and byte count of stdout; only the host has the expected
value/digest and compares it. The 128-KiB valid hex boundary therefore fits the bounded K2 control frame. Candidate
output never decides a grade. Python reads stdin bytes directly, preserving CRLF as well as UTF-8.
Bridges, command descriptors, candidate environments and sandbox parent command lines contain no expected output or
private seed. A candidate snapshot contains only public input files and allowed neighbor modules under `src/`.

`_shared/isolation.mjs` is the replaceable process-isolation interface. Following K2 and owner ruling D123 Q6:

- Live candidates run only under Linux, through `VerifierPort`, without network access and with a private PID space.
  Host oracle/repository paths are absent. The adapter also makes ephemeral parent directories read-only; only its
  private workspace is writable. The default port reuses Core’s verifier mount plan and adds explicit read-only
  SDK roots discovered from trusted toolchains (Rust sysroot, Go GOROOT, Python prefix). Oracle/runtime path overlap
  in either direction is refused before execution. A caller-supplied K2 port must supply the same runtime visibility;
  an unavailable runtime or isolation fails closed.
- Authored fixture self-tests explicitly choose trusted `fixture` mode on Linux/macOS. A live failure never selects it.
- Windows refuses both process paths with typed `platform-unavailable`; it runs materialization/contract proofs and
  asserts that refusal. Job Object isolation is deferred to D123. No unisolated Windows fallback exists.

The port owns a process group, sends SIGTERM then SIGKILL after 100 ms, and kills descendants when the leader exits.
Candidate stdout/stderr are bounded to 1 MiB combined; command/preflight output defaults to 64 KiB. One task-wide checker deadline covers preflight, compilation, every case and every scope
(default 60 seconds, at most the task's remaining wall allocation; caller limit up to 300 seconds).
The standalone host command also propagates SIGTERM/SIGINT and cleans its workspace in `finally`.

A known-good compile-and-run preflight runs before candidate evaluation for each language. Missing/broken tools are
infrastructure failures. A candidate compile error, deleted executable, bad output or timeout remains an unresolved
candidate, including ENOENT after preflight. Rust's channel comes from repository `rust-toolchain.toml`; candidate
compiler/module configuration is ignored. TypeScript uses Node's type transformation (including `enum`), Python disables site packages and adds
the entry directory and `src/` to its isolated module path, and Go/Rust support the public neighbor-module layout.
All use only their standard libraries; Go proxies/cgo are disabled.

## K2 contracts and tests

The published K2 contract at [#868](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/868), revision
`c25213eed108170d1a06f8d52ed0fa9d4e8cde56`, is recorded in `_shared/k2-contract.json` while K2 is absent from main.
The checker returns exactly K2's `CodingCheckResult`: `passed`, `unavailable`, `reason`, `wallMs`.
Reasons are `passed`, `unresolved`, `unavailable`, `aborted`. Scope/case diagnostics are private host callbacks.
There is no separate `team-check` report. K2's live report remains `plur1bus.coding-bench/1` and alone owns paired
results and model metrics. Its public environment keys are `platform`, `node`, `rust`, `go`, `python`, `rpc` with
Linux/semver values; paths, endpoints, credentials and transcripts never enter it. Command environments use K2's exact
compiler/runtime allowlist, filtering ambient credentials and loader injection. Replace the pinned contract facade
with K2 imports when the runtime adapter lands; never introduce a second runner or public report schema.

With Node 24.21, repository Rust, Go 1.27.1 and Python 3.13 on PATH, run from the repository root:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/core/test/collab/team*.test.ts
```

Linux also requires the same usable bubblewrap/user-namespace setup as the Core CI jobs. Language/task files are split
for measured shard balance. Tests cover every seed's start/reference grades, partial solutions, ownership, all 108
deterministic variants, the twelve review mutants, NUL inputs, enum/neighbor compatibility, runtime preflight,
self-deletion, trapping/orphan processes, total deadlines, oracle reading, outside writes, four-language live smoke, ignored root artifacts and readonly-contract tampering. On macOS/Windows the live
proof asserts refusal; the actual adversarial execution proof runs on Linux. No platform test is skipped.

A standalone private checker is a **host** process, outside the candidate sandbox:

```sh
node --experimental-strip-types <task>/check.mjs --candidate <public-tree> --seed 17 --scope all
```

`--scope` accepts a package ID, `e2e` or `all`. Exit 0 requires `passed: true`. `--fixture` is an explicit authored-code
self-test option; it must never be offered to a model or selected after isolation failure. Reports suppress all candidate
stdout/stderr, expected/actual text and private seed data. K2's eventual team adapter supplies its provisioned runtime
paths and verifier; the private fixture directory is never granted to model tools or mounted into the candidate.

## Arms and remaining TM2 integration

An arm is `{ family, params }` plus a canonical ID; roles/capabilities are separate planning metadata. A caller-owned
registry provides `registerArm` and explicit extension families. Unknown IDs raise `arm-unknown`; reserved families
without a definition raise `arm-not-executable`. Initial definitions are `single`, highest-effort `single`, reviewed
`single`, and `explore+single`. These are data; capability metadata grants no execution or tool authority.

The ID encoding matches K2: recursively sorted UTF-16 object keys, exact JSON strings and array order, finite numbers
(`-0` becomes `0`), data properties only, depth 32, 4096 visited values and 16,384 serialized UTF-8 bytes. Empty `single`
keeps ID `single`. Other IDs use the family (`+` becomes `-`), a hyphen and the first 32 hex digits of SHA-256 over
canonical `{"family":...,"params":...}`. Families are 1–31 lowercase ASCII letters/digits/`+`/`-`, starting with a letter;
IDs fit 64 portable characters. Stable vectors pin the initial controls. `team` and `best-of-n` remain extension points.

K2 must merge before the runtime adapter, live baseline, nightly and replacement of `fanout-eval.ts`/`eval:m5`.
`explore+single` becomes executable in the last TM2 commit, only after #853 is on main; first merge main, never rebase.
The declared trials remain 1/2/4 concurrent local-model requests and 1/1.5/2 writer-capacity multipliers.
Fixture timings measure grader cost only. They establish no model throughput, peak memory, slowdown or team-quality result.
Both K2 and TM2 edit `docs/ci.md`; the second merger integrates main and resolves that overlap.
