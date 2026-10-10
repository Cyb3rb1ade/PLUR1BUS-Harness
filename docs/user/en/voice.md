# Voice features

Voice features let you interact with your agents using speech in real time. Plur1bus supports automated speech recognition (ASR), text-to-speech (TTS), and voice activity detection (VAD). You can choose speech languages, select between fast and high-quality model profiles, manage model downloads, and tune real-time turn behavior and feature time budgets.

The German version of this page is [../de/sprachfunktionen.md](../de/sprachfunktionen.md). Technical details for the web UI are in [../../web-ui.md](../../web-ui.md).

## Languages and model profiles

In **Settings > Voice** (`/settings/voice`) and in the first-run setup wizard, you configure the speech language:

- **Language selection:** Choose the spoken language for your agents. When setting up Plur1bus, your system language is suggested automatically.
- **Fast and Quality profiles:**
  - **Fast:** Prioritizes low latency and smaller download sizes. Suitable for snappy conversations and constrained hardware.
  - **Quality:** Uses larger models for higher transcription accuracy and natural-sounding voices. For English, Plur1bus suggests the quality profile (Kokoro voice) over fast profiles that use research-only voices.
- **Model details and download sizes:** The model table displays each required model for speech recognition (`asr`), speech synthesis (`tts`), and voice activity detection (`vad`), along with its size and installation status.
- **Licence confirmation:** Models with specific licence conditions (such as CC-BY-SA or research-only licences) require an explicit confirmation before download. Licence identifiers are presented clearly without arbitrary external links.
- **Research-only licences:** Models restricted to non-commercial research (such as Blizzard Challenge datasets) are explicitly marked with a warning badge ("Research only, no commercial use"). The first-run setup never preselects a research-only voice automatically.

## Real-time interaction

When real-time mode is enabled, Plur1bus processes speech input continuously:

- **Endpointing delay:** Configures silence detection (200 ms to 2000 ms; default 700 ms) before deciding the speaker has finished a turn.
- **Speculative turn start:** Begins preparing agent generation while the user is still finishing speech to reduce perceived turn-around latency.
- **Confirmation sound:** Plays an acoustic earcon when speech turn endpointing triggers.

## Feature controls and time budgets

Real-time speech interaction operates within strict latency bounds. You can toggle each conversational subsystem between `on`, `deferred`, and `off` (`toolSchemas` also offers `reduced`):

- **autoRecall:** Memory lookup during speech ingestion.
- **promptEnrichment:** Context assembly before inference.
- **reranker:** Relevance filtering of retrieved memory cards.
- **decisionService:** Real-time routing and safety checks.
- **postTurnRefine:** Background synthesis cleanup.
- **memoryWrite:** Persisting conversation notes to memory.
- **compaction:** Context truncation and summarization.
- **toolSchemas:** Injection of tool definitions into the model prompt.

Each feature can be given an individual maximum budget in milliseconds (10 ms to 5000 ms). Beside each switch, Plur1bus reports measured latency statistics (median and p95) from past turns. Features marked as "Fixed by the engine" reflect behaviors that require backend engine activation before overrides take effect.

## Agent overrides

By default, agents inherit the global real-time voice settings. On each agent's detail page (**Agents > [Agent]**), you can override specific real-time voice parameters for that agent. Overridden fields are indicated with a badge, and an option to reset all fields back to global inheritance is available at any time.
