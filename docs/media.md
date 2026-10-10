# Media core (MG-1)

`@plur1bus/media` is a standalone, dependency-free Node 24 package. It exports
image adapters, `AdapterRegistry`, `JobRunner`, `FileJobPersistence`, `OutputStore`,
`estimateCost`, and capability-name constants `media.generate` / `media.edit`.
The MG-1 library adds no permission approval flow. MG-3 RPC/CLI/UI/channel
surfaces and their remaining production gates are documented below.
The supplied MG-1 owner decisions are the implementation contract; the referenced
ADR-017 proposal was not present on the implementation's `origin/main` base.

## Architecture and ports

```text
Caller -> Registry / ImageAdapter -> HTTP provider or Core ML child
       -> JobRunner -> JobPersistence (file default; replaceable port)
                    -> BudgetPort (optional; core integration follows)
                    -> OutputStore -> job directory / images + manifest.json
```

Requests include prompt, negative prompt, pixel size or aspect ratio, image count,
seed, steps, guidance, reference-image bytes, mask bytes, format and metadata flag.
Adapters reject unsupported parameters before submission rather than silently
ignoring them. Capabilities describe the implemented protocol, not every model at
that provider. Variation and upscale are optional interface methods; none are
advertised by this release.

Jobs transition `queued -> running -> succeeded | failed | cancelled`. Progress
and polling checkpoints are durably persisted. A running Replicate/fal job resumes
using its existing external ID; synchronous jobs interrupted before output commit
fail with `interrupted` instead of being submitted again. A crash between external
submission and checkpoint persistence cannot guarantee remote cancellation: the
local job fails without resubmission. A committed output is recovered without
another provider call. Submission is never automatically retried.

The persistence port supplies an exclusive `claim` for each job. After confirming
the old runner has exited and obtaining exclusive ownership, the host calls
`FileJobPersistence.recoverClaims()` and `OutputStore.recoverStaging()`, then
`JobRunner.recover()`. Recovery never steals live locks. Use one trusted output
root per runner; roots and manifests are private application-owned data, not an
import interface. Files use mode 0600 and directories 0700 on POSIX.

`BudgetPort.reserve(jobId, estimate)` must reserve atomically and idempotently;
`settle(jobId, actualUsd)` must reconcile idempotently. Unknown estimates/actual
costs are `null`, not free usage. Budget refusal prevents provider submission.
The dated `src/prices.json` table is an estimate, without warranty; only the listed
model has a fixed price. Local provider billing is zero (hardware/electricity
costs are excluded). Verify current billing before use.

## Adapters and verification

Documentation was checked **2026-10-07**; URLs are recorded in adapter source comments.
“Verified protocol” means isolated fake-server tests, not a paid live-provider run.
No real credentials or external network are used by tests. Fake servers bind only
127.0.0.1. Cloud integrations and actual model generation remain live-unverified.

| Adapter | Implemented profile | Generate | Edit | Mask | Resume | Status |
|---|---|---|---|---|---|---|
| OpenRouter | Chat completions, image/text modalities | yes | references | no | no | verified protocol; live unverified |
| Replicate | Predictions API, input mapped from the model's published schema (FLUX schnell fallback) | yes | references and mask, if the model declares them | model-dependent | yes | verified protocol; live unverified |
| fal | Queue API, `image_url` / `mask_url` for edit and inpainting endpoints | yes | one reference | yes | yes | verified protocol; live unverified |
| Together | Images generations | yes | no | no | no | verified protocol; live unverified |
| OpenAI | GPT Image generations and multipart edits | yes | yes | yes | no | verified protocol; live unverified |
| Google | Gemini generateContent image output | yes | references | no | no | verified protocol; live unverified |
| xAI | Grok image generations | yes | no | no | no | verified protocol; live unverified |
| Draw Things | HTTP txt2img / img2img (the app ignores masks, so none are accepted) | yes | one reference | no | no | verified protocol; live unverified |
| Core ML | Apple's StableDiffusionPipeline, SD model folders, one-shot or JSON-Lines (`--jsonl`) helper | yes | one reference (JSON-Lines helper) | no | no | fake-helper protocol and native protocol verified; model run unverified |

Replicate reads the model's published input schema and maps the request onto it; a
model without one falls back to the FLUX schnell profile. fal passes edit and
inpainting images as `image_url` / `mask_url`. Google uses Gemini; Imagen is not
implemented because Google has shut it down in the Gemini API. Core ML dimensions come
from the compiled model, so explicit size/aspect and formats other than PNG are
refused. Draw Things' HTTP handler does not apply an inpainting mask; it is not
advertised. Per-adapter setup, defaults and limits: `docs/media-adapters.md`. OpenRouter and Gemini implement `n` through sequential one-image
calls, with aggregate progress. A later transport failure can return a partial
batch; moderation and caller cancellation always fail the batch.

Errors expose only stable codes: `content_policy`, `quota`, `too_large`,
`unsupported_parameter`, `backend_unavailable`, `timeout`, `cancelled`,
`invalid_response`, `interrupted`. Provider text, authorization and signed URLs
never enter errors. A 401/403 is `backend_unavailable` with `error.reason`
`auth_invalid` / `auth_forbidden`. Moderation is never disabled or retried elsewhere. Registry
fallback only handles `backend_unavailable`; policy/quota/timeout/cancellation
stop immediately. Polling cancellation attempts the provider cancel endpoint;
remote completion/billing may still occur.

## Configuration and use

```ts
import { AdapterRegistry, egressHosts, JobRunner, FileJobPersistence,
  OutputStore } from '@plur1bus/media';

const config = [
  { id: 'openrouter', model: 'google/gemini-2.5-flash-image', apiKey: openRouterKey },
  { id: 'replicate', model: 'black-forest-labs/flux-schnell', apiKey: replicateKey,
    downloadHosts: ['replicate.delivery', 'tjzk.replicate.delivery'] },
  { id: 'fal', model: 'fal-ai/flux/schnell', apiKey: falKey,
    downloadHosts: ['v3.fal.media'] },
  { id: 'openai', model: 'gpt-image-1', apiKey: openAIKey },
  { id: 'draw-things', model: 'sd_v1.5_f16.ckpt',
    baseUrl: 'http://127.0.0.1:7860' },
] satisfies import('@plur1bus/media').AdapterConfig[];
const registry = new AdapterRegistry(config);
const adapter = registry.select('inpaint', ['openai']);
const runner = new JobRunner(new FileJobPersistence('/private/media/jobs'),
  new OutputStore('/private/media/outputs', {
    quotaBytes: 1024 ** 3, retentionMs: 30 * 86400_000, embedMetadata: false,
  }), [adapter], budgetPort);
const job = await runner.enqueue(adapter.id, { prompt: 'A forest', n: 1 });
await runner.run(job.id, abortController.signal);
console.log(egressHosts(config)); // hand this inventory to the host allowlist
```

Supply keys in memory through the future secret port; do not serialize adapter
config in the job store. Local adapters accept literal loopback/private IPs only;
LAN additionally requires `allowLan: true`. No local adapter accepts a key. Cloud
HTTP test endpoints may use loopback without keys; credentials at local/private
hosts are refused. Production cloud endpoints require HTTPS. Download hosts must
be explicitly listed for cross-origin output URLs; no authorization is forwarded
and redirects are refused. The host must enforce the egress inventory in its
network policy. Local HTTP abort closes the client request but cannot guarantee
that Draw Things stops rendering.

## Output and metadata

Each output directory is published by a single rename after files and manifest
have been flushed. SHA-256 hashes describe the stored bytes (including embedded
metadata). The manifest always includes adapter/model, prompt, parameters,
reference/mask hashes, seed and cost (null when unknown), duration, origin and
partial-result flag. Reference bytes and mask bytes are not duplicated into the
manifest. Job persistence retains request bytes to enable polling recovery.
Quota includes images and manifest bytes and is checked under an exclusive store
lock. Quota refusal leaves no output directory. `prune()` removes expired jobs;
the host must schedule it. No background scheduler is installed.

Embedding precedence is **call > agent > global > false**. The global setting is
`OutputStore`'s `embedMetadata`; the agent value is `put(..., agentMetadata)`; the
call value is `request.embedMetadata`. Manifest data is independent of this flag.
PNG uses UTF-8 iTXt without re-encoding pixels. JPEG and WebP carry one XMP packet
(`plur1bus:payload`, the same JSON), written without re-encoding; an XMP packet already
in the file is replaced, the rest stays as delivered. Other formats are refused. Independent of embedding,
reference images and masks lose EXIF/GPS, XMP, IPTC, comments and PNG text chunks
before any adapter sends them (see `docs/media-adapters.md`).

## Core ML helper

Requires macOS 13.1+, Apple Silicon and Swift 5.9+. The helper is a separate Swift
package pinned to Apple's `ml-stable-diffusion` commit
`ea2805dc1945be20561c77e5f6d1d9a5a637cda2`. Build locally:

```sh
swift build -c release --package-path tools/coreml-sd-helper
```

Configure `helperPath` to the absolute
`tools/coreml-sd-helper/.build/release/media-coreml` executable and `modelDir`
(default `~/MochiDiffusion/models/`). Each immediate child folder must contain
Apple-compatible compiled resources (`TextEncoder.mlmodelc`, `Unet.mlmodelc` or
its chunks, `VAEDecoder.mlmodelc`, `vocab.json`, `merges.txt`, optional safety
checker). Existing Mochi model folders are usable only if compatible with this
layout; SDXL/SD3 pipelines are follow-ups. No models are downloaded automatically.
`CoreMLAdapter.listModels()` asks the helper to enumerate compatible folders.

Without flags, stdin contains one JSON object and is closed after writing. stdout is
newline JSON: progress messages, then one result with relative PNG filenames, or a
stable error. With `--jsonl` the helper serves `generate`, `img2img`, `list-models`
and `cancel` requests over JSON lines until stdin closes and keeps the model loaded;
`--capabilities` announces `jsonl/1` and the TS adapter falls back to the one-shot
protocol for a binary that does not. See `docs/media-adapters.md`. The TS adapter gives the child a private temporary output directory and
an empty environment (no inherited provider keys), reads bounded output, checks
filenames and symlinks, then removes the temporary directory. SIGTERM/SIGINT
stop at a diffusion step; the parent escalates to SIGKILL after one second.
The helper preserves Apple's safety checker and treats filtered output as
`content_policy`. Model licenses must be checked separately. CI does not build
this helper in MG-1.

## Validation and follow-ups

Run `pnpm --filter @plur1bus/media test` and
`pnpm --filter @plur1bus/media coverage` (85% lines/functions/branches enforced),
then root `pnpm lint`. Test fixtures cover success, policy rejection, rate limits,
timeout/cancellation, partial results, polling recovery, output replay, quota,
retention, metadata precedence and sanitized failures.

Remaining follow-ups: the D109 media policy/API gates described below, production
channel host/compression binding, ComfyUI workflows and progress,
A1111/Forge, model-specific gateway edit profiles, xAI edits (documented by xAI,
response shape unverified), OpenRouter's dedicated images endpoint, SDXL/SD3, helper
CI/model acceptance, host scheduling and Video (v0.2).

## Licenses and sources

No code is copied from **MochiDiffusion (GPL-3.0)**. Its conventional model-folder
path is only a configuration default. The helper imports **Apple
ml-stable-diffusion (MIT)**; its pinned dependency's license and notices apply.
Generated images and model weights have their own provider/model terms.

Primary protocol references: [OpenRouter](https://openrouter.ai/docs/api-reference/chat-completion),
[Replicate](https://replicate.com/docs/reference/http),
[fal queue](https://fal.ai/docs/documentation/model-apis/inference/queue),
[fal FLUX schema](https://fal.ai/models/fal-ai/flux/schnell/api),
[Together](https://github.com/togethercomputer/together-typescript/blob/main/src/resources/images.ts),
[OpenAI](https://developers.openai.com/api/docs/guides/image-generation),
[Google](https://ai.google.dev/gemini-api/docs/generate-content/image-generation),
[xAI](https://docs.x.ai/developers/model-capabilities/images/generation),
[Draw Things](https://github.com/drawthingsai/draw-things-community/blob/main/Libraries/HTTPAPIServer/Sources/HTTPAPIServer.swift),
[Apple](https://github.com/apple/ml-stable-diffusion),
[price estimate](https://www.together.ai/pricing). Checked 2026-10-07.

## MG-3 surfaces

The core registers `media.generate`, `media.edit`, `media.job.get/list/cancel`,
`media.output.get/list/delete`, `media.adapters.list`, and
`media.preferences.get/set`. Generate/edit return `{jobId}` immediately. Jobs
emit `media.job.progress` and `media.job.finished` to the submitting connection
only. A client reconnects with job.get; polling does not depend on event delivery.
Job responses omit persisted reference bytes and provider checkpoints.

All surface methods have human-only RBAC gates. Reads additionally need
`agent.read`; generation, cancellation and deletion need `agent.use` on the stored
agent. Lists filter inaccessible agents. Adapter discovery never exposes secret
references or keys. The core binds the existing secret/egress adapter wrappers,
D109 evaluator and CallBudget admission/settlement ports. Admission happens before
provider execution. Missing budget/policy refuses execution. Interrupt recovery
never resubmits a job; a committed output succeeds, other unfinished jobs become
`interrupted`. Existing budget reservation expiry reconciles uncertain usage.

`media.preferences.set {embedMetadata,agentId?}` persists global or agent metadata
preferences. Global writes require settings.write; agent writes require
agent.manage. Request > agent > global > false still applies. Manifests are always
retained independently of image metadata embedding.

CLI examples (all commands support the global `--json` switch):

```sh
plur1bus media adapters
plur1bus media generate 'A forest' --agent main --adapter openai --wait --out forest.png
plur1bus media edit 'Add snow' --reference <output-id> --wait
plur1bus media jobs
plur1bus media job <job-id>
plur1bus media cancel <job-id>
plur1bus media outputs --agent main
plur1bus media output <output-id> --out image.png
plur1bus media rm <output-id>
```

`--wait` reports progress on stderr and returns a terminal job; JSON stdout remains
one document. It waits up to ten minutes; timeout leaves the job queryable. `--out`
creates a new file and preserves existing files. References and masks are existing
private output IDs, not arbitrary paths or provider URLs. RPC image transfer is
bounded to 16 MiB per file; larger files remain stored. Output deletion preserves
the historical job state. Gallery (`#/media`) filters agent/adapter/date, shows
manifests and bounded previews/downloads, and confirms deletion. Chat tool-result
images resolve store IDs. Settings exposes global/agent metadata preferences.
Sharing is hidden while no output-sharing ACL/transport exists (`canShare=false`).

Telegram's `sendOutput(chatId,id,index?)` uses a host-supplied OutputPort. Its
`authorize` callback must check the destination's sharing rights. Stored bytes are
SHA-256 verified; photos are capped at 10 MiB. Larger inputs require the host's
compression callback, whose returned type and size are checked again. Missing
compression fails before sending. No output URL or credential goes to Telegram.

The Web client follows the existing `/rpc` contract. Production HTTP forwarding
and authenticated principal binding remain an API-layer dependency outside the
allowed package scope; mock-server page tests do not establish that deployment.
The two new D109 media catalogue entries are also a pending scope dependency:
`policy/**` is excluded by this work package, so unknown capabilities currently
fail closed. No D109 evaluator or budget behavior was changed.

## Media search

Indexing, captions and search over generated media are described in [media-search.md](media-search.md).
