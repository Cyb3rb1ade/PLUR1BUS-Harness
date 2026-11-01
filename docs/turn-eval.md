# Turn-path evaluation

The N-G1 corpus runs through `createTurnProvider`: actual capability routing,
skill storage, prompt building, argument validation, dispatch and call budgets.
The deterministic model boundary returns an independent transcript; fixture
tools return bounded local evidence and execute no host or network effects.
Every ordinary Core test run includes the regression tests.

From the repository root, with the repository's Node toolchain:

```sh
node --experimental-strip-types --conditions=source scripts/eval/turn-eval.ts --regression --out artifacts/turn-eval/regression.json
```

The default mode is `--regression`. It exits unsuccessfully if any scenario
fails. Explicit `--baseline` captures the same checks as data and does not fail
because of unmet behavior. It is for measuring the old implementation before
changing it, never a substitute for the regression gate.

The unchanged `fd25a1433a9f950c094e08bc0c05cd2a118315fb` baseline used 20
German/English scenarios and 24 turns. It passed 2/20 scenarios, executed 18/20
required tools, missed domain calls on 2/18 tool-dependent turns, loaded 0/10
required skills and changed the tool prefix 3/24 times. Unnecessary domain tool
use was 0/2 plain-chat turns. These are fixture measurements, not vendor-model
quality or measured provider cache hits. Supplemental policy probes are kept
separate from this immutable baseline corpus.

## Completed fixture comparison

The implemented path passes 20/20 scenarios, executes 20/20 required tools and loads
10/10 required skills. Missing-needed-tool turns are 0/18, unnecessary use remains
0/2, and tool-zone prefix changes fall from 3/24 to 0/24. The separate policy probes
exercise forbidden calls and verify zero executed effects; their evidence is not
retroactively attributed to the original baseline.

## Real-model nightly

The separate `turn-eval-live` job in `nightly.yml` runs when repository variable
`PLUR1BUS_TURN_EVAL_MODELS` is configured. An explicitly invoked `--live` command
fails if the configuration is empty or a credential is absent. It never replaces
real models with fixture responses.

The variable is a JSON array of at most 32 entries. It names endpoints, never
credentials:

```json
[
  {
    "provider": "anthropic",
    "model": "configured-default-model",
    "baseUrl": "https://api.anthropic.com",
    "wireFormat": "anthropic_messages"
  }
]
```

Supported wires are `chat_completions`, `anthropic_messages` and `gemini`; a URL
cannot contain credentials. `local: true` marks a local OpenAI-compatible endpoint
(loopback only: the egress gate refuses private addresses) that needs no key and keeps the conservative local
tool-choice capabilities.

### Credentials come from the secret store

A live run resolves credentials the way the harness does: provider definitions,
`createCredentialsProvider` and the secret store (`composeAuth`), with the egress
gate on every request. There is no key variable in the evaluation and no
`process.env` read of a key. The store belongs to a short-lived eval home
(`PLUR1BUS_TURN_EVAL_HOME`, an absolute path), and a key is stored under the name
`plur1bus login <provider> --api-key` uses, `<provider>/api-key`.

The nightly job has two steps for it. A setup step runs
`scripts/eval/turn-eval-secrets.ts`; it is the only step that sees the GitHub secrets
`ANTHROPIC_API_KEY` (provider `anthropic`) and `GOOGLE_API_KEY` (providers `google`
and `gemini`) and writes them to the store. The evaluation step
(`scripts/eval/turn-eval.ts --live`) has no secret in its environment and leases
the key from the store. A last step removes the eval home. The setup step does not
use `plur1bus login`, because that stores through a running core and the nightly
would have to build the Rust CLI and the supervisor for it; it calls the store the
core's `secret.set` uses, under the same name.

The store uses its encrypted-file backend (`secrets.fileFallback`), which carries from
one process to the next through the eval home; the OS keyring is switched off, so a
developer's keychain is never touched. The in-memory keyring seam is process-local and
would not carry the key from the setup step to the evaluation. A provider other than
`anthropic`, `google` and `gemini` can only be a `local: true` endpoint; it gets a
placeholder key because the harness always presents one.

### OpenAI profiles are refused

D110 keeps direct OpenAI credentials out of every scheduled job. The scheduled job
passes only the two vendor keys above, and `--live` refuses any profile with the
`codex_responses` wire, a `chatgpt.com` or `openai.com` endpoint (subdomains
included) or a provider label of `openai`, `chatgpt` or `codex`, before it composes
a provider or sends a request. OpenAI runs only through the owner-gated live flow.
HYG-015 recognises secret names that say "openai"; `scripts/ci/nightly-live-secrets.test.mjs`
pins which secrets each live job and step may see.

For a local run, store the key first and point both scripts at one eval home:

```sh
export PLUR1BUS_TURN_EVAL_HOME=/tmp/turn-eval-home PLUR1BUS_TURN_EVAL_MODELS='[...]'
ANTHROPIC_API_KEY=... node --experimental-strip-types --conditions=source scripts/eval/turn-eval-secrets.ts
node --experimental-strip-types --conditions=source scripts/eval/turn-eval.ts --live --out artifacts/turn-eval/live-reports.json
```

Real adapters receive the same harness prompts and safe fixture tools. Reports
contain tool hit rate, answers missing needed tools, unnecessary tool use,
loaded-skill hit rate, tool-prefix changes per turn and observed forbidden
executions. Every rate has its denominator. Prefix changes are a structural
cache diagnostic; they do not measure provider cache-read tokens.

The live gate requires tool hits at least 95%, answers missing needed tools at
most 5%, loaded-skill hits at least 90%, and zero policy violations. The report
also keeps each harness check, so a model-quality rate cannot hide a specific
contract failure. Supplemental denied-tool scenarios count actual model
attempts and actual fixture effects; no expected transcript supplies live counts.
Artifacts are uploaded even when a configured model misses the targets.

## B1 coding benchmark

D120 §6.6 / Q21 adds 24 original MIT tasks under [`tests/bench/coding`](../tests/bench/coding/README.md): eight per tier,
five languages, twelve repository and twelve terminal tasks. Three task seeds yield 72 cases per model and arm. The initial
arm is `single`, using the real `composeTools` and `createTurnProvider` coding profile, its dispatcher/policy, task grants and
call budget. `CodingArmFactory` is the explicit PT-2 extension point; team and best-of-n are not implemented. The
`hostCodingArm` hook consumes the existing `HostEvalModel` / `HostEvalHarness` registry and dispatcher. A host session must
bind its provider's token budget and abort signal and close every owned request/process; missing usage remains null.

**Preparation gate:** #820 (the shared provisioner and narrow Linux writable-worktree opt-in) and K2a (normal native-turn
mount pass-through) must be merged before owner live acceptance or enabling `coding-bench-live`. K2 changes neither sandbox
validation nor its backend. Its runtime dependency check fails closed until those APIs exist. After each dependency merges,
merge approved `main`, verify actual provisioned card-turn integration, and obtain the separate Claude review of K2a. No RPC
change is needed by B1. K3–K8 remain blocked until the owner live baseline is committed (D120 Gate 2); K1 has the owner's
explicit H1-1 exception. Do not create a placeholder baseline or relabel fixture evidence as live.

### Per-PR fixture validity

Use the repository Node 24.21 and Rust toolchain. Python 3, Go >=1.22 and POSIX shell must be installed; the runner never
bootstraps a toolchain or downloads task dependencies. The selected Linux unit job runs:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts --fixture
```

All 72 starting instances must fail and all 72 reference instances must pass the same hidden assertions. This is trusted
original-fixture execution, without a model, credential setup, Git worktree or live writable mount. The optional `--out`
file is explicitly `plur1bus.coding-fixture/1`, `fixture-selftest`; it cannot be parsed as a live report. Missing runtimes or
unsupported execution fail instead of producing successful skips. Core unit tests exercise the unavailable Windows port;
trusted fixture commands support Linux/macOS. Live captures support Linux only, matching Nightly.

### Owner capture after #820 and K2a

Use the same approved `PLUR1BUS_TURN_EVAL_MODELS` list as `turn-eval-live`, with no credential fields. Its existing D110
OpenAI restrictions remain in force. The only scheduled vendor credentials are `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY`.
They reach setup alone, which writes an encrypted disposable store with OS keyring disabled and creates a runtime canary.
An existing home refuses setup; cleanup requires the private marker, so the owner's real runtime home cannot be adopted.

The owner may manually dispatch `nightly` with `coding-baseline-capture=true` after reviewing the prerequisites. Each model
gets its own Linux job, 72 cases, at most two model jobs simultaneously. This explicit capture does not require a previous
baseline. A normal nightly requires `PLUR1BUS_CODING_BENCH_ENABLED=true`, configured models and the committed live JSON
baseline. This preparation neither sets those variables nor dispatches a live job.

For a manual Linux capture, first build the existing binaries:

```sh
cargo build --locked -p plur1bus-tools --bin plur1bus-tools
cargo build --locked -p plur1bus --bin plur1bus-sandbox-limits
```

With the approved model configuration and setup-only credentials already in the owner's environment:

```sh
set -e
coding_parent=$(mktemp -d)
export PLUR1BUS_CODING_BENCH_HOME="$coding_parent/eval"
export PLUR1BUS_CODING_BENCH_REVISION=$(git rev-parse HEAD)
export PLUR1BUS_TOOLS_BIN="$PWD/target/debug/plur1bus-tools"
export PLUR1BUS_SANDBOX_LIMITS_BIN="$PWD/target/debug/plur1bus-sandbox-limits"
coding_eval() {
  env -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY node --experimental-strip-types --conditions=source \
    --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts "$@"
}
coding_cleanup() {
  if [ -d "$PLUR1BUS_CODING_BENCH_HOME" ]; then coding_eval --cleanup; fi
  rmdir "$coding_parent"
}
trap coding_cleanup EXIT
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts --setup
mkdir -p artifacts/coding-bench
coding_eval --live --out artifacts/coding-bench/capture.json > artifacts/coding-bench/capture.log 2>&1
coding_eval --scan --report artifacts/coding-bench/capture.json --log artifacts/coding-bench/capture.log
cat artifacts/coding-bench/capture.log
```

Choose new output paths for another capture: files are created exclusively and never overwrite an existing report. An
optional `PLUR1BUS_CODING_BENCH_MODEL_INDEX` selects exactly one zero-based entry for setup and capture. A partial model
selection is explicit; the nightly's baseline scope is the same selected configuration and refuses a missing one.

The runner creates fresh project/card worktrees through `GitWorktreeProvisioner`, under each private home's `state/worktrees`.
Only the card worktree is granted. Its DB-pinned opaque mount goes through the normal native turn after K2a; no raw path or
extra writable runtime directory substitutes for it. Runtime copies/caches live in the card's ignored `.build` directory.
Every worktree has its own whole seed/home and database; cleanup removes that owned tree without running host Git against
post-agent metadata. Hidden checkers/reference solutions never enter the agent's seed or readable files. Verification uses
a separate provisioned private worktree and the existing network-disabled verifier; expected values remain in the parent.

### Reports, baseline and comparisons

The closed live format is `plur1bus.coding-bench/1`, `evidence: live`. It records corpus hash, harness revision, runtime and
RPC versions, model/configuration identities and capture dates, arms and the full task/seed matrix. Endpoints, credentials,
source, model responses and tool transcripts are excluded. Publication applies the full Core redactor, validates the result
again, and scans raw/encoded secret forms. Nightly captures evaluator stdout/stderr privately, scans report and log, then
prints the scanned log and uploads only `report.json`. A failed scan blocks both publication paths. The eval home is always
deleted, including after failed setup/run/scan. Never upload the home or an unscanned log.

`wallMs` measures the solve turn including tool/provider work and cleanup; trusted workspace/runtime provisioning is outside
that interval. `verificationMs` is separate. Usage aggregates authoritative per-request uncached input, cache-read, cache-create
and output buckets, including retries; cumulative turn usage is not added again. Cache-read share is total cache reads divided
by total input, including cache reads/writes. A provider's estimated/partial usage is null and invalidates baseline completeness.
Syntax refusals, offloads, steers and rewinds are null until those features expose measurements. Budget exhaustion is a valid
unresolved result; provider, provisioning or isolation failures do not become a successful measurement.

Download the scanned owner captures. Independent model captures can be combined only with identical corpus, revision,
runtimes, task matrix and arms; duplicate configurations refuse. Their individual capture dates remain intact:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts \
  --merge --reports '["capture-model-0.json","capture-model-1.json"]' --out artifacts/coding-bench/baseline.json
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts \
  --render-baseline --report artifacts/coding-bench/baseline.json --out docs/evals/2026-10-baseline-coding-bench.md
```

For one capture, render that file directly. Only after owner review of real, complete Linux evidence, commit its JSON as
`docs/evals/2026-10-baseline-coding-bench.json` beside the generated Markdown above. Neither file is created by K2 preparation.
Both are needed: Markdown gives counts by model/tier/language and metrics; JSON preserves the exact pairing identities.

Normal nightly passes `--baseline` to `--live`, embedding the paired comparison. The standalone comparison is:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/eval/coding-bench.ts \
  --compare --baseline docs/evals/2026-10-baseline-coding-bench.json --candidate candidate.json --out comparison.json
```

Pair identities include corpus, credential-free model configuration, task and seed; arm selection is explicit. Every model
reports both-resolved, both-unresolved, improved, regressed, unmatched-baseline and unmatched-candidate counts, delta and the
exact two-sided sign probability. Changed runtimes, missing/duplicate pairs or incomplete measurements cannot pass. Harness
revision and RPC version are recorded but may change across an ACI delta. A lower overall resolved rate for any paired model
blocks the delta gate regardless of its p-value. Tier/language denominators stay visible; models are never averaged to hide
a regression. Seed variants within a task are related observations; the sign probability is descriptive evidence, not an
independence claim or permission to override the owner's no-regression rule. Quarterly corpus rotation requires a fresh owner
baseline; old and new hashes are never silently paired.
