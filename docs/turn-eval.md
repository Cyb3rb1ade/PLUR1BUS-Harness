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
