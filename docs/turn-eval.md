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
fails if the configuration is empty or required credentials are absent. It
never replaces real models with fixture responses.

The variable is a JSON array of at most 32 entries:

```json
[
  {
    "provider": "openai",
    "model": "configured-default-model",
    "baseUrl": "https://api.openai.com/v1",
    "keyEnv": "OPENAI_API_KEY",
    "wireFormat": "chat_completions"
  }
]
```

Supported wires are `chat_completions`, `codex_responses`,
`anthropic_messages` and `gemini`. `keyEnv` names a credential provided to the
job; URLs cannot contain credentials. The job exposes the configured
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` and generic
`PLUR1BUS_TURN_EVAL_API_KEY` GitHub secrets. D110 keeps direct OpenAI credentials out of this scheduled job;
OpenAI configuration requires the separate owner-approved live flow or an explicit local CLI invocation.
Explicit `local: true` permits a
keyless local endpoint; conservative local tool-choice capabilities still apply.

```sh
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
