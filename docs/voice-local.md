# Local voice (sherpa-onnx) and the local real-time profile

## Local tier

`voice.local` selects a language and a tier. The models are described by a data catalog (`packages/voice-providers/src/local/catalog.json`), run by `sherpa-onnx-node`, an optional peer that is loaded lazily. When it is missing or the platform has no binary, `LocalVoice.capability()` reports `unavailable` with a message instead of throwing at import.

| Language | Tier | ASR | TTS |
|---|---|---|---|
| de | fast | Kroko-ASR streaming | Piper Thorsten (low) |
| de | quality | Parakeet TDT 0.6B v3 (int8) | Martin voice (owner choice) |
| en | fast | Streaming Zipformer | Piper Lessac (low) |
| en | quality | Parakeet TDT-CTC 110M | Pocket TTS (not runnable yet), fallback Kokoro multilingual |

VAD is Silero (MIT). Fast uses a streaming recogniser and a small voice for low latency. Quality uses larger, non-streaming recognisers. `warm()` loads both models and runs one dummy pass so the first real turn does not pay load time.

### Language API

`LocalVoice` offers `listLanguages()`, `getLanguage(code)`, `setLanguage(code, { profile, acceptLicences })`, `useForAgent(agentId, ...)`, `resolveFor(agentId)`, `capability()`, `warm()`, `vad()`, `unload()`. Per-agent overrides come from `voice.local.perAgent`. An empty `voice.local.language` means the system language when the catalog has it, otherwise the first catalog language.

### Adding a language is data

Add an entry to `languages` plus its models in `voice.local.catalogOverride` (same shape as `catalog.json`; entries add or replace). No code changes. The catalog is validated on load, and a bad override fails with code `catalog`.

### Downloads

Models are downloaded on demand into `voice.local.modelsDir` (default under the harness data directory). Only https URLs are accepted (plain http to loopback for tests). A download is staged in `.downloads/<id>/`, resumed with a Range request (the partial file is re-hashed), capped at the catalog size (or 2 GiB when it is unknown), verified against sha256 and only then extracted with the system `tar` (`--no-same-owner --no-same-permissions`). The extracted tree is audited before it is used: symlinks, hard links, special files, paths that resolve outside the staging directory and trees over the size or entry limits fail the install with `download_failed`. The swap keeps the previous version until the new one is in place. An unpinned sha256 (`null`) is refused. A mismatch fails with `checksum_mismatch` and removes the staged file.

### Licences

Each model carries a licence record. A model whose licence is non-commercial or `unconfirmed` is used only after the owner confirmed it **for that model and licence id**: `voice.local.acceptedLicences` maps `<model id>@<licence id>` to the date-time of the confirmation, and a call can pass `acceptLicences: [key]`. A model that a catalog update adds, or whose licence id changes, needs a new confirmation. `LocalVoice.pendingLicences(code)` returns the keys still open with the notice to show. `voice.local.catalogOverride` cannot change the `licence` of a built-in model id (it can add new models, which carry and are gated by their own licence). The former global switch `acceptNcLicence` is gone. Without confirmation the call fails with `licence_required` and names the key.

Licences as recorded in the catalog (from the model cards and the packages):

| Model | Licence | Status |
|---|---|---|
| Silero VAD, Streaming Zipformer en, Kokoro | MIT, Apache-2.0 | confirmed, commercial |
| Piper Thorsten de | CC0 (dataset) | confirmed, commercial |
| Parakeet TDT 0.6B v3, Parakeet TDT-CTC 110M | CC-BY-4.0 | confirmed, commercial |
| Piper Lessac en | Blizzard 2013 research licence | confirmed, **non-commercial** (research only) |
| Kroko de | CC-BY-SA per the model card (metadata says `other`) | unconfirmed |
| Pocket TTS en | CC-BY-4.0 file, but the package README says non-commercial | unconfirmed |
| Martin de | unknown | unconfirmed, no package |

Open questions for the owner: Martin (package and licence), Kroko (exact terms, share-alike), Pocket TTS (conflicting statements). The English fast voice (Piper Lessac) is research-only; use another voice for commercial use.

Pinned packages (url, size, sha256) are in `src/local/catalog.json`; each was checked against the release asset and its file layout. Pocket TTS is pinned but this package's sherpa-onnx runner cannot drive it yet, so `en` / `quality` falls back to Kokoro. Parakeet 110M is a single-file CTC export (`nemo-ctc`).

### Model lifetime

Loaded models are reference counted: every ASR/TTS call, stream and session holds the models it uses. A language switch or `unload()` retires the old models and frees them once the last holder is done, so a running stream is never cut off. `leaseVad()` returns a reference-counted detector for core sessions. `vad()` returns the resident detector without a hold: fetch it again after a language switch. The sherpa engine calls the binding's `free`/`delete` where it has one (names to verify against the pinned binding).

## Local real-time profile

A simulated real-time mode for local ASR and TTS: speech is cut into turns, the answer is spoken sentence by sentence, and optional memory features run under a time budget. The package holds the logic; [Voice V2](voice-v2.md) wires it into the existing core turn loop.

Keys under `voice.localRealtime`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | false | When off, features run without a time limit |
| `endpointingMs` | 400 | Silence that ends a turn |
| `speculativeTurnStart` | false | Start the turn on the final transcript, cancel if speech resumes |
| `ackSound` | false | Short sound when the turn ends |
| `sentenceChunking.maxWords` | 24 | Longest spoken chunk; cut at a comma |
| `toolSchemas` | reduced | Smaller tool prompt for speed |
| `auditDetail` | minimal | Audit detail per real-time turn |
| `features.<name>` | see below | `{ mode: on, deferred or off, maxMs }` |
| `perAgent.<id>` | `{}` | Same shape, overrides the defaults per agent |

Feature defaults and why:

| Feature | Default | Reason |
|---|---|---|
| autoRecall | on, 30 ms | Cheap and gives the answer context; drops out if slow |
| promptEnrichment | on, 10 ms | Short context only |
| reranker | off | Adds a model call before the first word |
| recallMultiIdentity | off | Wider recall costs time |
| decisionService | off | An extra model call before the answer |
| postTurnRefine | deferred | Runs after the answer is spoken |
| memoryWrite | deferred | Capture after the turn |
| compaction | deferred | Never in the latency path |

`on` runs before the answer under `maxMs` (on timeout the result is skipped and recorded), `deferred` runs after the turn, `off` never runs. `resolveProfile(config, agentId)` merges defaults, global config and the per-agent override. `runWithBudget` and `createFeatureRunner` enforce the budgets, `SentenceChunker` splits the stream (abbreviations, ordinals, decimals and ellipses do not end a sentence), `createTurnDetector` is the endpointing, barge-in and speculative-start state machine, and `FeatureLatencyRecorder` reports per-feature p50 and p95 for tuning.

### Behaviour worth knowing

- **Validation.** `perAgent.<id>` takes the same keys and limits as the global block (the schema refuses unknown keys). Whatever still arrives invalid at run time (a negative `endpointingMs`, a string `maxMs`) is ignored layer by layer, so the next lower layer wins; it never reaches a timer.
- **Default budget.** When the profile is enabled, a feature set to `on` without `maxMs` gets 50 ms (`DEFAULT_FEATURE_BUDGET_MS`). With `enabled: false` every feature runs unbudgeted, including those set to `off`: the caller that checks the mode itself decides.
- **Endpointing.** The silence window never ends a turn with an empty transcript (`minTranscriptChars`, default 1; `finalWaitMs` optionally waits for a late first transcript, then the detector returns to idle). Final segments of one utterance accumulate. A new or different transcript cancels a running speculative turn at once. `agent_audio_start` / `agent_audio_end` can carry the `responseId` that `turn_end` returned, so a late end of a cancelled answer cannot end a newer one. `respondingTimeoutMs` (off by default) returns a detector that never got audio to idle with a `response_timeout` output. `minBargeInMs` (default 0, immediate) makes a barge-in count only when the user keeps speaking that long, so a click or echo does not cancel the answer; the VAD still needs its own minimum speech duration.
- **Deferred work.** `drainDeferred` checks the abort before it takes a job; jobs that did not run stay queued (`pendingDeferred`). `runWithBudget` returns `aborted` on the caller's abort even when the function ignores its signal, and a synchronous throw becomes an `error` result.
