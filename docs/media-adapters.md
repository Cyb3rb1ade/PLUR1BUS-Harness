# Media adapters (MG-2)

Image adapters for `@plur1bus/media`: what each one can do, how to switch it on, what it sends, and where it stops.
`docs/media.md` describes the library (jobs, output store, manifest); this page covers the adapters.

Provider documentation was checked on **2026-10-08**. "Verified" below means isolated tests against loopback fake servers
with synthetic answers; no live provider, key or model was used. Video is not part of this work (v0.2).

## Adapters at a glance

`Edit` means the adapter accepts reference images. `Mask` means inpainting with a mask image. "model" means the answer
depends on the configured model (Replicate reads the model's published input schema, OpenRouter lists image models).

| Adapter | Where | Generate | Edit | Mask | Async | Formats | Max images | Sizes | Default model |
|---|---|---|---|---|---|---|---|---|---|
| `openai` | remote | yes | yes (several references) | yes | no | png, jpeg, webp | 10 | width x height | `gpt-image-2.5-sunburst` |
| `google` | remote | yes | yes (several references) | no | no | provider decides | 10 (one call each) | aspect ratio | `gemini-nano-banana-2.1` |
| `xai` | remote | yes | no | no | no | provider decides | 10 | aspect ratio | `grok-imagine-image-2.0` |
| `openrouter` | remote | yes | yes (model) | no | no | provider decides | 10 (one call each) | aspect ratio | `google/gemini-2.5-flash-image` |
| `replicate` | remote | yes | yes (model) | yes (model) | yes | png, jpeg, webp | 4 | model | `black-forest-labs/flux-schnell` |
| `fal` | remote | yes | yes (one reference) | yes | yes | png, jpeg | 4 | width x height | `fal-ai/flux/schnell` |
| `together` | remote | yes | no | no | no | png, jpeg | 4 | width x height | `black-forest-labs/FLUX.2-dev` |
| `draw-things` | local | yes | yes (one reference) | no | no | provider decides | 10 | width x height | none, set `model` |
| `coreml-local` | local | yes | yes (one reference) | no | no | png | 10 | fixed by the model | none, set `model` |

Async adapters (Replicate, fal) submit a job, report `queued` then `running` progress while polling, write a durable
checkpoint before the first poll, and cancel the job at the provider when you cancel. Local adapters cost no money; their
results carry `costUsd: 0` and the run time in the manifest. For the remote adapters cost is whatever the provider reports
(OpenRouter's `usage.cost`), otherwise unknown (`null`), never a guessed price.

## Switching an adapter on

Everything is off by default. A remote adapter turns on when `apiKeyRef` names a secret that exists; `enabled: false` turns
it off whatever the key. Local adapters need `enabled: true`. The key itself never goes into the config:

```sh
printf '%s' "$OPENAI_API_KEY" | plur1bus secret set media/openai
plur1bus config set media.adapters.openai.apiKeyRef media/openai
```

Settings live under `media.adapters.<id>` (see `docs/config.md`): `enabled`, `apiKeyRef`, `baseUrl`, `model`, `timeoutMs`
and `maxConcurrent` for the remote adapters; `drawthings.{host,port,allowLan,model}` and `coreml.{binary,modelsDir,model,computeUnits,scheduler}`
for the local ones. `adapterConfigsFromSettings(settings, resolveSecret)` turns them into adapter configs and reports which
adapters it skipped and why (`disabled`, `no_key`, `key_unresolved`, `no_model`, `no_binary`, `lan_not_allowed`), never the key.
Hand `egressHosts(configs)` to the network policy: it lists exactly the hosts of the enabled adapters.

| Adapter | Key | Notes |
|---|---|---|
| OpenAI | API key | Images API (`/images/generations`, `/images/edits`, multipart with `mask`). The ChatGPT-plan sign-in path is separate and not used here. |
| Google | Gemini API key | `generateContent` with image output. Google recommends the Interactions API for new code and states `generateContent` "remains fully supported". Output carries SynthID. |
| xAI | API key | `/images/generations`. |
| OpenRouter | API key | Chat completions with image output. `listModels()` reads `/models?output_modalities=image` and caches it for one hour (`modelListTtlMs`). |
| Replicate | API token | `owner/name` for official models, `owner/name:version` to pin a version (needed for community models). |
| fal | API key | The model is the queue endpoint id. Use an edit or inpainting endpoint (for example `fal-ai/flux-lora/inpainting`) for `edit`; the adapter sends `image_url` and `mask_url`. |
| Together | API key | `/images/generations`, base64 results. |

### Replicate input mapping

The adapter reads the model's published input schema once and maps the request onto the names the model declares
(`prompt`, `negative_prompt`, `seed`, `num_inference_steps` or `steps`, `guidance` or `guidance_scale`, `aspect_ratio`,
`width`/`height`, `num_outputs`, `output_format`, and `image`/`input_images` and `mask` for edits). A request the model
cannot take, or a value outside the declared range or enum, is refused before anything is submitted. A model without a
published schema falls back to the FLUX schnell profile (generate only). Reference images are sent as data URIs, which
Replicate recommends only for small files.

### Draw Things

Draw Things serves an A1111-compatible API (`/sdapi/v1/txt2img`, `/sdapi/v1/img2img`) only while the app is running with its
HTTP API server switched on in the app's settings. Defaults are `127.0.0.1:7860`. When the connection fails, the error
carries `reason: drawthings_api_off` (app not reachable) or `drawthings_not_installed` (loopback, macOS, no app found) and a
hint. `probe()` reports `running`, `api_off` or `not_installed` without generating anything.

A host other than loopback (LAN, Tailscale) needs `allowLan: true`; the traffic is plain http, no key is ever sent, and the
host shows up as the result's `origin`. **Masks are not supported:** the app's request handler never reads a mask (checked
in its open source: `mask = .none` on the img2img path), so claiming inpainting would silently draw without the mask. Such
requests are refused. The API has no endpoint that lists models or samplers, so there is nothing to enumerate.

### Core ML helper

Apple Silicon and macOS 13.1 or newer. Everywhere else the adapter exists but reports `coreml_unavailable_platform` and never starts a process.

```sh
cd tools/coreml-sd-helper
swift build -c release        # produces .build/release/media-coreml
swift test                    # 21 tests; needs the built binary for the CLI tests
```

With only the Command Line Tools installed (no Xcode), Swift Testing needs its macro plugin path:
`swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`.
Distributing the binary is a release matter (M8); this page covers building it yourself.

Point `coreml.binary` at the executable and put compiled model folders into `coreml.modelsDir` (default
`~/MochiDiffusion/models/`). Mochi Diffusion's folder layout is read, no Mochi code is used (GPL-3.0). Understood layouts:
`<name>/{TextEncoder,Unet|UnetChunk1,VAEDecoder}.mlmodelc`, `<name>/{split_einsum,original}/compiled/...` and `<name>/compiled/...`.
Split-einsum models default to the Neural Engine, original models to the GPU; `computeUnits` (`cpuAndNeuralEngine`, `all`,
`cpuAndGPU`) overrides. img2img needs a `VAEEncoder.mlmodelc`. SDXL and SD3 are not supported.

The helper speaks two protocols. Without flags it behaves exactly as before (one JSON request on stdin). With `--jsonl` it
serves JSON lines until stdin closes: `generate`, `img2img`, `list-models`, `cancel`, with `progress` events, and keeps the
last model loaded between requests. `--capabilities` prints `{"protocol":"jsonl/1",...}`; the adapter probes it once and falls
back to the one-shot protocol (no edit, no cancel mid-run) for an older binary. The adapter starts the helper with an empty
environment, serialises requests, asks it to cancel and kills it if it does not stop within `cancelGraceMs` (default 2 s),
and restarts it for the next request after a crash.

## Privacy and metadata

- **Nothing is embedded by default.** Prompt, model and seed enter a stored image only when the call, the agent or the global
  setting asks for it (call, then agent, then global, then off). PNG uses an iTXt chunk, JPEG and WebP a single XMP packet
  (`plur1bus:payload`, the same JSON). Existing EXIF and XMP are removed first. A prompt too long for one JPEG segment is
  truncated and the packet says so (`truncated: true`).
- **References and masks are cleaned before they leave.** EXIF (including GPS), XMP, IPTC, comments and PNG text chunks are
  removed from every reference image and mask before any adapter sends them, so a photo's location does not reach a provider
  or a local model. Pixel data is untouched. A JPEG with a rotated orientation keeps a block holding only that one tag, so it
  stays upright. The type is read from the bytes, not from the declared format; unreadable or unknown images are refused.
- **Provider output is checked by magic bytes.** A response that is not a PNG, JPEG or WebP is `invalid_response`, whatever
  content type it claims. Downloads are size-bounded, never receive the provider's authorization, and refuse redirects.
- There is no approval gate for image generation or editing, including photos of real people. Provider-side moderation is
  never disabled, retried elsewhere or routed around: a refusal is `content_policy` and stops the job.

## Errors and retries

Errors carry only stable codes. The code list is the one in `@plur1bus/media` (`content_policy`, `quota`, `too_large`,
`unsupported_parameter`, `backend_unavailable`, `timeout`, `cancelled`, `invalid_response`, `interrupted`); it has no
dedicated authentication code. A 401 or 403 is therefore `backend_unavailable` with a sub-key on the error: `error.reason`
is `auth_invalid` or `auth_forbidden`, and the message says to check the API key or secret reference for that adapter
(`reasonOf(error)` reads it). The persisted job record keeps only `error.code`.

| Situation | Code |
|---|---|
| 429 (after retries) or 402 | `quota` |
| Provider moderation, safety filter, refused image | `content_policy` |
| 400/422, a parameter the adapter or model cannot take | `unsupported_parameter` |
| 413, oversized download | `too_large` |
| Timeout, caller abort | `timeout`, `cancelled` |
| Not an image, malformed answer | `invalid_response` |
| Network, 5xx, 401/403 | `backend_unavailable` (401/403 with `reason`) |

A 429 is retried up to three attempts in total, waiting for `Retry-After` (seconds or HTTP date) or an exponential backoff,
capped at 30 s; a longer `Retry-After` fails at once as `quota`. A 5xx is retried for status polling and other reads, **not
for a submission**: a submission that failed with a 5xx may already be billed, and MG-1 keeps the rule that a submission is
never resent blindly. A 429 is safe to resend because the provider rejected the request before doing any work.

## Known limits

- Imagen is not implemented. Google lists `imagen-4.0-*` for shutdown from 2026-08-17 and Imagen as no longer available in
  the Gemini API; Gemini image models cover generate and edit.
- xAI documents `/v1/images/edits` (JSON body with `model`, `prompt`, `image: {type, url}`), but the response shape is not
  documented, so the adapter does not offer edit yet. It needs a live check.
- OpenRouter now documents a dedicated `/api/v1/images` endpoint; this adapter still uses chat completions with image output.
- No per-adapter quality or background options (OpenAI), no SynthID flag in the manifest, no remote-host warning field
  beyond `origin`: `ImageResult.metadata` is a closed type in MG-1.
- Replicate and OpenRouter defaults come from the MG-1 documentation and were not re-verified against the vendors' pages.
- Cost: only OpenRouter reports an actual cost. A configurable per-adapter estimate is not part of this work.
- Live behaviour of all cloud adapters, Draw Things and real Core ML generation is unverified here.
