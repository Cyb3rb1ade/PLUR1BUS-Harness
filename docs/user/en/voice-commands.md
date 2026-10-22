# Voice commands

`plur1bus voice` reads and changes the voice settings from a terminal: the speech language and profile, the real-time behaviour, the per-agent overrides and the licensed speech models. It works on the same settings as **Settings > Voice**, which is described in [voice.md](voice.md). The German version of this page is [../de/sprach-befehle.md](../de/sprach-befehle.md).

All 11 commands talk to the running core, so the daemon must be up. If it is not, they stop with `E_CORE_UNAVAILABLE`; start it with `plur1bus daemon start`. Every command is marked experimental in `plur1bus voice --help`.

## Output, rights and errors

- Without `--json`, a command prints the result as indented JSON. With `--json`, the result is one JSON document with a `schema` field such as `voice.status/1`. `--json` works before or after the command.
- Reading is open to every role. Changing (`profile set`, `features set`, `override set`, `override clear`, `models install`) is for Owner and Admin; anyone else gets `E_DENIED`.
- The CLI waits up to 10 minutes for an answer, because a model download can take long.
- An unknown agent is `E_AGENT_UNKNOWN`. Saving a setting needs the running supervisor; without it the core answers `E_NOT_AVAILABLE`.
- Agent IDs are lower case letters, digits, `_` and `-`, up to 64 characters, starting with a letter or digit.

## Status

| Command | What it does |
|---|---|
| `plur1bus voice status` | Shows whether voice is available, the selected `language` and `profile`, the number of `activeSessions` and the real-time `budgetMs`. `available` is true when the core has a trusted audio transport and voice is running. |

## Language and profile

| Command | What it does |
|---|---|
| `plur1bus voice profile list` | Lists the languages `de` and `en`. For each, the `fast` and `quality` profiles name their three models: speech recognition (`asr`), speech synthesis (`tts`) and voice activity detection (`vad`), each with its size, licence, whether it needs confirmation and whether it is installed. |
| `plur1bus voice profile get` | Shows the selected language and profile. With `--agent <id>` it shows what that agent uses: its override if it has one, otherwise the global choice. |
| `plur1bus voice profile set --language de --profile quality` | Selects a language (`de` or `en`) and a profile (`fast` or `quality`), downloading the models that are not installed yet. With `--agent <id>` the choice is saved as that agent's override instead of the global setting. |

How `profile set` works, in this order:

1. For each of the three models that needs a licence confirmation, you must name it with `--accept-licence <model>@<licence>`, for example `--accept-licence piper-en-lessac-low@Blizzard-2013-Lessac-research`. A model needs confirmation when its licence is not confirmed as allowing commercial use (research-only, non-commercial or unconfirmed). Take both parts from `plur1bus voice models list` (`modelId` and `licenceId`). The option can be repeated, and it is checked on every call: licences you confirmed earlier do not count. A missing confirmation is `E_VOICE_LICENCE`, naming the licence in `detail` and the model in `ids.modelId`. Nothing is downloaded.
2. The models that are not installed are downloaded and verified. If a download or verification fails, the command stops with `E_VOICE_UNAVAILABLE`.
3. The confirmations are stored, then the selection is saved. The result is `ok: true`.

## Real-time features

| Command | What it does |
|---|---|
| `plur1bus voice features get` | Shows the effective real-time profile: `enabled`, `endpointingMs`, `speculative`, `ackSound` and the eight features, each with `mode`, `maxMs` if set, and `effective`. `effective` is `applied`, or `engine-fixed` for `reranker` and `postTurnRefine`. With `--agent <id>` the agent's override is applied on top of the global profile. |
| `plur1bus voice features set --value '<json>'` | Replaces the real-time profile with the JSON object you give. With `--agent <id>` it is stored as that agent's override instead. The result is the new effective profile. |

The JSON object of `features set` must hold exactly these keys, and nothing else:

- `enabled`, `speculative` and `ackSound` are `true` or `false`.
- `endpointingMs` is the silence before a turn ends, 200 to 2000 milliseconds.
- `features` holds all eight: `autoRecall`, `promptEnrichment`, `reranker`, `decisionService`, `postTurnRefine`, `memoryWrite`, `compaction` and `toolSchemas`. Each one is `{ "mode": ... }` with `on`, `deferred` or `off`, and an optional `"maxMs"`. Only `toolSchemas` also accepts `reduced`.

Leave out the `effective` fields that `features get` adds; the command refuses unknown keys. A value that is not a JSON object is refused with `E_INVALID_PARAMS`.

The features share a time budget, `voice.v3.budgetMs` (1000 milliseconds by default). Every feature that is not `off` counts its `maxMs`, or 50 when it has none. If the sum passes the budget, the command fails with `E_VOICE_BUDGET`; `detail` names the first feature that overflows and `ids.totalMs` and `ids.budgetMs` give the numbers. Nothing is saved. A global change is checked against every agent's override as well.

```sh
plur1bus voice features set --value '{"enabled":true,"endpointingMs":700,"speculative":false,"ackSound":true,"features":{"autoRecall":{"mode":"on","maxMs":100},"promptEnrichment":{"mode":"on","maxMs":100},"reranker":{"mode":"off"},"decisionService":{"mode":"on","maxMs":100},"postTurnRefine":{"mode":"deferred"},"memoryWrite":{"mode":"deferred"},"compaction":{"mode":"deferred"},"toolSchemas":{"mode":"reduced"}}}'
```

## Agent overrides

An agent inherits the global voice settings. An override lists only the values that differ; everything it leaves out is inherited.

| Command | What it does |
|---|---|
| `plur1bus voice override get <agent>` | Shows the agent's `override` (empty when it has none) and its `effective` profile. |
| `plur1bus voice override set <agent> --value '<json>'` | Replaces the whole override of the agent with the JSON object. |
| `plur1bus voice override clear <agent>` | Removes the override, so the agent inherits everything again. |

The object of `override set` may hold `language` (`de` or `en`), `profile` (`fast` or `quality`), `enabled`, `endpointingMs`, `speculative`, `ackSound` and `features`, where `features` may name just some of the eight features. For example, `{"endpointingMs":1200,"features":{"reranker":{"mode":"off"}}}` changes two things and inherits the rest. The budget is checked against the global profile with your changes on top. If the override names a `language` or `profile`, the licences of the models it selects must already be confirmed (through `profile set` or `models install`); otherwise the command fails with `E_VOICE_LICENCE`. It never downloads.

## Models

| Command | What it does |
|---|---|
| `plur1bus voice models list` | Lists the models with `modelId`, `role` (`asr`, `tts` or `vad`), `sizeBytes`, `licenceId`, `needsConfirmation` and `installed`. |
| `plur1bus voice models install <model>` | Downloads and verifies one model. |

A model that needs confirmation (see `profile set` above) is installed only with `--license-accepted`. Without it the command fails at once with `E_VOICE_LICENSE`, before any download, even if the model is already installed. An unknown model is `E_NOT_FOUND`. A model that is already installed is not downloaded again. A failed download or verification is `E_VOICE_UNAVAILABLE`. Note the spelling: `models install` uses `--license-accepted`, `profile set` uses `--accept-licence`.

## Next

- Voice in the web interface and the meaning of the profiles: [voice.md](voice.md)
- Errors: [../../errors.md](../../errors.md)
