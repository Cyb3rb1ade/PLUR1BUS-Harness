# Media search (harness side)

Search over images, videos and audio by text or by example (`plur1bus media search`, `media.search`). The vector work happens in the
engine; this page describes what the harness adds: configuration and validation, the caption pipeline, the index hook, the backfill
job, the ffmpeg ports, the RPC/CLI surface and the setup step. The binding interface is the contract of the media-embeddings plan
(Engine 1.19 mapped by the Harness `EngineMediaIndex` adapter).

## H2 integration status (2026-10-20)

The production adapter targets Engine contract **1.19.0** ([Engine H1 PR #248](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/248)); the current pinned Engine remains unchanged and does not expose that API. Media stays disabled until the Controller pin and an actual `HostServices.fetch` binding are present. [Harness #602](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/602) owns Fetch/Secret transport; this change does not copy it or fall back to global fetch. Bootstrap disables Engine media configuration before construction without Fetch and passes readiness to runtime composition.

The existing Web **Medien** tab, settings and six RPC methods are reused. Native Harness H3 acceptance is gated on the pin/ports. Engine H1's real image/audio measurements remain separate evidence.

MM-3a adds the Harness prerequisites for the Rust media path: authenticated channel uploads, a local capability catalogue,
optional status metadata and explicit ffmpeg setup. The Rust media index and its `engine.media.*` binding arrive in
MM-2b/MM-3b; these prerequisites do not make an unavailable index ready.

## Model of the two indexes

- The text index stays the main index. Media never change its provider, dimension or fingerprint.
- Image, video and audio have their own media index. Text and media providers are chosen independently; the same model may serve
  both (the indexes and inference sessions stay separate). Vectors of different spaces are never compared: a text query against the
  media index uses the text encoder of the **media** model.
- Every medium gets a caption. The caption is a normal memory entry in the text index (`kind="media-caption"`, `mediaRef=<mediaId>`),
  embedded with the text provider. `fuseCaptions` fuses the two result lists by rank (RRF), never by vector.

## Configuration

`memory.mediaEmbedding.*` (installation) and `agents.<id>.memory.mediaEmbedding.*` (per-agent override, unset keys inherit); the
reference with defaults is [config.md](config.md).

| Key | Default |
|---|---|
| `enabled` | `true` |
| `provider` / `model` / `dimensions` | `local-transformers` / `google/embeddinggemma-2` / `768` |
| `modalities` | `["image","video","audio"]` |
| `image.softTokens` / `video.softTokens` | `140` / `70` |
| `video.segmentSec` / `maxFrames` / `sceneDetect` | `10` / `32` / `true` |
| `audio.segmentSec` / `maxSeconds` | `30` / `3600` |
| `caption.source` | `prompt-then-user-then-auto` (or `user-only`, `off`) |
| `caption.provider` | local when the embedding is local, otherwise unset (setup asks) |
| `caption.maxChars` / `caption.perSegment` | `280` / `false` |
| `backfill` | `manual` (or explicitly `auto`) |

New setup choices and unset configuration use `backfill = manual`: existing media are indexed only on request.
Explicit saved choices, including `auto`, are preserved.
`audio.segmentSec` accepts 1–30 seconds, globally and in agent overrides; older values above 30 are rejected rather than
silently clamped. `dtypes` records text, vision and audio separately for each supported platform, currently all `q8`.
Audio always stays q8. A later text/vision dtype change needs a different vector-space identity and re-embedding.

Validation (`packages/core/src/media-search/validate.ts`) checks capability, licence, “Only local models” (`privacy.localOnly`), function-specific privacy acknowledgments and availability.
There are no lists of allowed provider combinations. Failures use the `E_MEDIA_*` codes in [errors.md](errors.md).
“Only local models” forces local processing: a cloud embedding or caption provider while the switch is on fails with `E_MEDIA_PRIVACY`
before any request is sent. The composition reads the switch (`privacy.localOnly`) through a callback that defaults to "off" and hands it both to the provider choice and to the caption service, which checks it again on every call.
An index call that hit the hook timeout cannot be cancelled in the port; if the medium is deleted afterwards, the hook removes it again once the late call settles.

## Ports and engine independence

`MediaIndexPort` (`media-search/types.ts`) has three implementations:

| Implementation | When |
|---|---|
| `EngineMediaIndex` | installed engine exports the complete public `media.*` shape and bootstrap confirms a bound Host Fetch port |
| `InMemoryMediaIndex` | reference implementation with brute-force cosine, for tests only |
| `DisabledMediaIndex` | everything else; `media.search` answers `E_MEDIA_UNAVAILABLE` ("Engine-Version unterstützt Medienindex noch nicht") |

`createHarnessHost` supplies `capabilities.mediaPorts.frameExtractor.extract` and `audioDecoder.decode` **before** `createEngine`. They translate the existing ffmpeg frame/PCM ports into Engine 1.19 requests. `mediaSourceRoot` is `<home>/media`; decoders are bounded and local. There is no `attachHost` call.

The adapter translates Harness principals to trusted `{agentId, scope:"agent-private"}`. Engine IDs include the agent, a workspace hash and safe media ID; unrelated agent/workspace hits are rejected before public projection. Mutations resolve the authoritative owner file, and indexing rejects an owner mismatch before caption/encoder work. Like-image seeds are sent only to their authoritative scope. Human queries search their authorized agents and retain the best score per readable item; agents query only their own index. Global counters are exposed only to Owner/Admin people, because 1.19 has no scoped status API.

The current supported encoder selection is local Gemma 2, with exact supported dimensions. Unsupported providers/models remain unavailable, including non-commercial models without a bound license/catalogue admission path; nothing is automatically accepted or replaced. The shared Engine cannot serve distinct per-agent provider/model/dimension selections. Such overrides fail closed; enablement/modalities/caption preferences are checked per agent. Engine 1.19 also has one global backfill and segment interval. Its audio limit is 300 seconds, even when Harness configuration requests more.

### ffmpeg

`FrameExtractorPort` and `AudioDecoderPort` run `ffmpeg`/`ffprobe` from `PATH`. If no binary is found the port is absent and the
engine reports `unsupported-kind` for that medium (no crash). Calls use no shell, the arguments are an array, inputs are passed as
`file:<path>` with `-protocol_whitelist file,pipe`, and every call has a timeout and an output size limit. Byte sources are written
to `<home>/media/tmp` and removed afterwards, also on errors.

Setup can offer installation through brew, apt, dnf, pacman, zypper or winget. It uses a fixed argument list and a separate
interactive answer; `--yes` does not authorize this external installation. The operating system handles sudo/UAC.
Without an interactive terminal, a supported package manager or sufficient rights, setup prints the manual command and
continues. `plur1bus 1staid check` includes the read-only `media.ffmpeg` check. Photos do not require ffmpeg; audio/video
decoding does. This project does not distribute, link or download ffmpeg, and the container image is unchanged.

## Captions

`CaptionService` picks the text in this order and cuts it to `caption.maxChars` at a word boundary:

1. the generation or edit prompt (ADR-017) for media the harness made,
2. the caption or alt text of the user,
3. an automatic caption from the `CaptionProvider`.

`user-only` skips 1 and 3, `off` writes no caption. Providers:

- Local (default): Florence-2 through transformers.js for images; a video gets 3–5 keyframes captioned and merged deterministically
  without an LLM; audio uses the transcript of the local ASR (`packages/voice-providers`), shortened. The model files are read from
  `<home>/models/caption/<model>`; the revision and SHA-256 pins in `caption/local.ts` are still placeholders (`TODO-PIN`) and the
  download is not implemented in this change.
- Cloud: a vision-capable model through the provider layer, counted against the call budget and subject to the D109 policy like
  other cloud calls.

Default rule: local embedding gives a local caption provider; with a cloud embedding there is no preselection.

## Search bounds and isolation

The reference index (`InMemoryMediaIndex`) shows the rules every `MediaIndexPort` must keep: `limit` is an integer from 1 to 200, `text` is 1 to 4096 characters and not blank, `kinds` are known kinds, `minScore` is finite (otherwise `E_INVALID_PARAMS`). A medium is visible only inside its own workspace, to the same agent or to the same non-empty user; the same agent id in another workspace sees nothing, also not through `likeMediaId`.

Paths: `createFfmpegPorts({ allowedRoots })` and the caption providers (`allowedRoots`) refuse media paths outside the given directories (symlinks and `..` resolved) with `E_MEDIA_UNSUPPORTED_KIND`; without the option nothing is restricted; the composition passes `<home>/media` and the store root to the ffmpeg ports and the local caption provider. Media above 64 MiB are not captioned (checked before reading).

## Index hook and backfill

After a result is stored in the `OutputStore` the hook captions the medium and calls `MediaIndexPort.index(...)` asynchronously;
the reply never waits for it. Deleting calls `remove`; a delete that finishes while an index job of the same medium is still running makes that job remove the medium again, so a deleted medium does not come back. An error produces a `media.index.failed` event and a counter, nothing else.
Telegram, Discord, Slack, Matrix, Signal and Email can forward their existing attachments through the additive channel
message field. Existing transport limits still apply, with an additional framework limit of ten attachments and 25 MiB
combined per message. The host resolves the current linked person, session and agent and checks `agent.use` before saving.
Unknown, disabled or unauthorized people cannot publish uploads. Incognito sessions refuse persistent uploads.

Raw media are saved privately through `OutputStore.putUploaded`, with a separate `media.upload/1` manifest. Actual bytes
determine size and hash; filenames do not determine paths. MIME/container validation runs before publication. The host
publishes the agent/person owner record and host-constructed D19 provenance before exactly one `hook.onUploaded` call.
Uploads remain agent-private. An attachment-only message receives a receipt without submitting an empty turn; a text
message keeps its text. Ingress awaits private storage, while captioning and embedding run on the background hook.

Cloud encoding remains disabled in production. The dependency-free `MediaEncodingBudget` seam prepares [#603](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/603): reserve one image or the ceiling of trusted video seconds before encode, settle started encodes conservatively even on failure, release an unused reservation when privacy changes during admission, and propagate settlement failures. It imports no pending budget implementation and makes no token-budget substitution. Cloud query encoding also needs its own token/Secret admission; global Engine backfill cannot meter each item and therefore cannot run a cloud encoder. The current runtime binds only the coarse local backfill gate. This is not a claim that #603 unit accounting is wired.

The backfill job starts by itself on activation and when the index fingerprint changes (`backfill = auto`), resumes after a restart
unless the user paused it, and pauses with `pausedReason="budget"` when the call budget is used up. The last seen fingerprint is
kept in `<home>/state/media-search.json`.

## RPC, CLI and rights

| RPC | CLI | Allowed |
|---|---|---|
| `media.search` | `plur1bus media search "<text>" [--like <mediaId>] [--kind …] [--limit N]` | anyone who may read the medium; agents in their own scope |
| `media.index.status` | `plur1bus media index status` | Owner/Admin people for the global 1.19 backend; other callers get unavailable |
| `media.index.pause` / `resume` / `reindex` | `plur1bus media index pause\|resume\|reindex` | owner, admin |
| `media.caption.set` | `plur1bus media caption set <id> <text>` | whoever may edit the medium; not agents |

The generated reference is [rpc.md](rpc.md) and [cli.md](cli.md); the rule table is in [rbac.md](rbac.md).

RPC 1.20.0 adds optional `capabilities` and `encoders` to `model.memory.status` and `media.index.status`. Responses without
either field remain valid. Capabilities describe what the selected catalogue model understands; encoder state describes
available installation evidence. An empty encoder list does not mean the files are installed or inference is ready.

## Setup

`plur1bus setup` has a step "Memory & Mediensuche": text and media provider separately (EmbeddingGemma 2 local preselected for both),
modalities, captioning. The step can be skipped; every choice also has a flag for non-interactive runs.

The pinned local EmbeddingGemma 2 q8 vision/audio encoders total **535,699,121 bytes (about 511 MiB)**, excluding
the text model: vision is 195,391,167 bytes and audio is 340,307,954 bytes. These are the Controller-verified graph and
data files at revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`. Setup displays this download size separately from
installation readiness. Time per photo on the current machine has not yet been measured; setup says so explicitly.
With Controller approval (E1), hardware-specific photo timing is deferred to MM-3b. MM-3a shows the verified
download size and measurement status.

## Privacy acknowledgments

Text embedding currently uses `local-transformers` only. `memory.embedding.privacyAck` is optional preparation for a future cloud-text decision; its cloud validation is unit-tested with synthetic choices. Setup has no cloud-text selection and `buildEngineConfig` still forces the local provider.

Media embedding currently remains local only. A future cloud media embedding choice would require `memory.mediaEmbedding.privacyAck`; cloud captioning separately requires `memory.mediaEmbedding.caption.privacyAck`. Each record contains `{ provider, acknowledgedAt, by }` and, where an actual configurable endpoint exists, `endpoint`. Confirmations never transfer between functions. The admitted provider and endpoint must match exactly. Local providers ignore these records. A runtime privacy pin takes precedence and blocks cloud calls even with a valid acknowledgment (`E_MEDIA_PRIVACY`); `createCaptionService` also accepts a `pinned` callback and then refuses any non-local provider at call time. No installation-wide pin configuration is introduced.

Setup requires a separate checkbox naming each supported cloud function's provider. Changing the provider clears the checkbox; saving replaces the affected config parent, removes previous acknowledgment metadata and checks the config revision. Confirmation identity comes from the current signed-in person, not restored browser state. General `config.set` authorization, audit and automatic removal after provider/endpoint changes require the future authenticated supervisor transport. The schema declares owner/admin writes and audit; those annotations alone do not enforce them.

The current media provider selection offers local media models only; MEDIA_PROVIDERS and selectMediaIndex are unchanged. Cloud captioning alongside local media embedding is valid and requires only caption.privacyAck. A cloud media embedding adapter/provider selection is still missing and is not invented here. Cloud captioning has a provider factory and a consent-guarded composition seam, but the default production composition does not bind a cloud caption provider; a host must supply that binding with current consent/pin/endpoint callbacks. Existing D109 policy and budget admission still run after consent. See the [handoff report](handoff/2026-10-14-backend-gaps.md) for open wiring and transport requirements.

Cloud captioning is selectable and validated in Setup, with an explicit notice that execution is not yet connected to the media index. Until a separate production binding exists, the index uses local captioning or none as before. This package does not select a default vision model or a general chat profile and does not assign a person/Owner as caption principal. Consent and pin tests exercise the OpenAI factory directly.

The production follow-up needs: an Owner decision on the vision model per provider; a dedicated media-index system principal with a narrow policy; a D109 classification for background calls without user approval that processes only media already authorized for indexing; and an explicit budget assignment. It must also bind the actual provider endpoint consistently to the acknowledgment. See the handoff's Transport-Abhängigkeit and Offen sections.
