# Local voice (sherpa-onnx) and the local real-time profile

## Local tier

`voice.local` selects a language and a tier. The models are described by a data catalog (`packages/voice-providers/src/local/catalog.json`), run by `sherpa-onnx-node`, an optional peer that is loaded lazily. When it is missing or the platform has no binary, `LocalVoice.capability()` reports `unavailable` with a message instead of throwing at import.

| Language | Tier | ASR | TTS |
|---|---|---|---|
| de | fast | Kroko-ASR streaming | Piper Thorsten (low) |
| de | quality | Parakeet TDT 0.6B v3 (int8) | Martin voice (owner choice) |
| en | fast | Streaming Zipformer | Piper Lessac (low) |
| en | quality | Parakeet TDT-CTC 110M | Pocket TTS, fallback Kokoro multilingual |

VAD is Silero (MIT). Fast uses a streaming recogniser and a small voice for low latency. Quality uses larger, non-streaming recognisers. `warm()` loads both models and runs one dummy pass so the first real turn does not pay load time.

### Language API

`LocalVoice` offers `listLanguages()`, `getLanguage(code)`, `setLanguage(code, { profile, accept })`, `useForAgent(agentId, ...)`, `resolveFor(agentId)`, `capability()`, `warm()`, `vad()`, `unload()`. Per-agent overrides come from `voice.local.perAgent`. An empty `voice.local.language` means the system language when the catalog has it, otherwise the first catalog language.

### Adding a language is data

Add an entry to `languages` plus its models in `voice.local.catalogOverride` (same shape as `catalog.json`; entries add or replace). No code changes. The catalog is validated on load, and a bad override fails with code `catalog`.

### Downloads

Models are downloaded on demand into `voice.local.modelsDir` (default under the harness data directory). A download is staged in `.downloads/<id>/`, resumed with a Range request (the partial file is re-hashed), verified against sha256 and only then extracted. An unpinned sha256 (`null`) is refused. A mismatch fails with `checksum_mismatch` and removes the staged file.

### Licences

Each model carries a licence record. A model whose licence is non-commercial or `unconfirmed` is downloaded and used only when `voice.local.acceptNcLicence` is true or the caller passes `accept`. Otherwise the call fails with `licence_required` and names the licence.

Open licence questions (confirm before shipping):

- Kroko-ASR (de fast): model card terms.
- Martin German voice (de quality): no package, URL or licence is confirmed; do not ship until it is.
- Piper Lessac (en fast): the dataset licence.
- Parakeet 110M (en quality): which checkpoint, and its licence.
- Pocket TTS (en quality): weights licence and an ONNX package that this sherpa-onnx build supports.

All catalog sha256 values are unpinned and the URLs of Kroko, Martin and Pocket TTS are empty; they are filled in at integration. Until then those downloads are refused.

## Local real-time profile

A simulated real-time mode for local ASR and TTS: speech is cut into turns, the answer is spoken sentence by sentence, and optional memory features run under a time budget. This package holds the logic only; wiring into the turn loop is a later PR.

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
