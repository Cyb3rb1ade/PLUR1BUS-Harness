# Voice V2 core integration

The composition root registers `composition/voice.ts` once. Its trusted host API extends the D110 broker with `openTalk(request, client)`, `metrics()` and `renderMetrics()`. The existing broker and its owner/session binding remain available. V2 creates no listener, Web UI or client credential API. The host supplies authenticated caller/person/session context, audio delivery, playback cancellation and sanitized events.

## Routing and privacy

`openTalk` validates session ownership before reserving budget or constructing providers. Preferences select enabled realtime, ASR and TTS adapters. Each cloud component needs D109 `net.submit` admission and egress admission before it can read a secret or connect. An unavailable or denied realtime adapter falls through to an admitted ASR → existing session agent → TTS cascade, then installed local models. Provider discovery does not run during admission. Missing local models fail closed; `openTalk` never downloads them.

A privacy pin constructs no cloud voice registry and admits only loopback LLM profiles, including fallback candidates. The fixed engine can independently invoke remote embedding/refinement providers, so pinned turns conservatively skip engine recall, capture and background compaction. Foreground context bounds still apply. Tools retain the existing explicit capability/approval rules. No vendor error, connection object or provider credential is passed to the client.

## Talk and model lifetime

Local sessions lease package Silero VAD and feed PCM to streaming ASR. The package endpoint detector starts the existing session turn pipeline, and the sentence chunker streams TTS sentence by sentence. Cloud cascades accept speech boundaries from the trusted host through `speech(active)`; they do not implicitly install local VAD models. Audio frames are capped at 128 KiB and must contain complete PCM16 samples.

Speech start interrupts playback and aborts the current response synchronously. Late audio from a provider ignoring cancellation is dropped. Optional speculative turns can produce draft text but wait for transcript confirmation before audio, tool dispatch or turn completion. A changed transcript cancels the draft, without capturing it. A completed turn's committed write-behind survives a subsequent playback interruption.

`channel.setLanguage(language, profile)` lets outstanding response work finish, loads the new package language atomically, closes the old ASR/VAD leases and opens a new stream. A failed model load retains the old language. `LocalVoice.leaseVad()` holds models through the switch. Concurrent channel closes share one completion promise and release admission once.

## Additive turn profile

`turnProfile` is an internal optional pipeline argument. Profile-free turns retain the original recall/provider/capture behavior; the regression test checks their order and reply. AsyncLocalStorage carries profile context per turn without mutating shared host configuration.

Only an enabled local realtime profile applies feature modes and budgets. Defaults remain:

| Feature | Mode | Budget |
|---|---|---|
| autoRecall | on | 30 ms |
| promptEnrichment | on | 10 ms |
| reranker | requested off, engine-fixed | — |
| decisionService | off | — |
| postTurnRefine | requested deferred, engine-fixed | — |
| memoryWrite | deferred | after response |
| compaction | deferred | after response |
| toolSchemas | reduced | top 4 |

Exhausting a foreground feature budget emits `feature.budget_exceeded` and continues with a bounded fallback. Deferred capture and compaction start after the answer; runner shutdown awaits queued work. Unconfirmed or aborted turns never enqueue capture. The foreground hard context bound is never deferred.

The pinned engine resolves reranker and `runtime.deferPostTurnLlm` when `createEngine` builds its closures. Neither can be changed through later `host.config()` calls. `channel.engineFeatures` and `voice.metrics().engineFeatures` therefore report **engine-fixed**, rather than claiming those switches took effect. Host config reads return the original object and values. `TurnProfile.engineOptions` carries the requested recall/capture options to the memory port as the single future integration point; it is advisory until the engine offers public options per call. No engine version or code changes are included.

## Metrics and manual measurement

`FeatureLatencyRecorder` retains at most 500 turns and reports feature durations plus median/p95 speech end → first audio. Registry labels use only the closed feature/ASR/agent/TTS/speech-to-audio sets, with no session, agent, model or transcript labels. The histogram label space remains below the registry's 1024-series cap. Local voice reports zero vendor cost. Missing cloud price information is reported as `unpricedReports`, rather than claimed as known zero cost.

`tests/manual/voice-fast.ts` is a manual native-model benchmark, excluded from automated test scripts. It requires a separately installed `sherpa-onnx-node` runtime and explicit `--prepare` for model downloads. `VOICE_BENCH_LANGUAGE`, `VOICE_BENCH_TTS=kokoro`, `VOICE_BENCH_MODELS`, `VOICE_BENCH_TURNS` and owner-provided `VOICE_BENCH_ACCEPT_LICENCES` configure the measurement only. Licence confirmations have no default in the script and must never be copied into product defaults or fixtures.

Each voice runs three warmups and 30 measured turns, with the same Piper-generated input per language, explicit speech boundaries, a 400 ms endpoint window and a deterministic in-process agent. Measurements exclude a production LLM, microphone/playback latency and network. TTS-alone measures first package output chunk; the current local adapter generates a whole sentence before yielding that chunk. RAM is whole-process RSS, including ASR, TTS, VAD and runtime, not isolated model allocation. Results and voice recommendations are recorded in the PR; defaults are unchanged.
