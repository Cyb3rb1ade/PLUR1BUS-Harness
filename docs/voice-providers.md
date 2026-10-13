# Voice providers (AL1)

`packages/voice-providers` holds the cloud voice providers and the logic for the local real-time profile. It adds no RPC, CLI, UI, network listener or credential wiring: a caller (the D110 broker or the [Voice V2 core integration](voice-v2.md)) builds a registry from config and passes it a secret reader. The package consumes core's `VoiceUsage` type only (`packages/core/src/voice/ports.ts`, type import) and never changes core.

## Capability table

| Provider | TTS | ASR | Realtime (speech to speech) | Auth | Config key |
|---|---|---|---|---|---|
| ElevenLabs | HTTP stream and text-streaming WebSocket | batch and realtime | no (see below) | API key from a secret reference | `voice.providers.elevenlabs` |
| xAI Grok Voice | no | no | WebSocket, OpenAI-realtime shaped | API key from a secret reference | `voice.providers.xai` |
| Gemini Live | no | no | WebSocket (bidirectional generate) | API key from a secret reference | `voice.providers.gemini` |
| Amazon Polly | `SynthesizeSpeech` (pcm, mp3) | no | no | AWS default credential chain | `voice.providers.polly` |
| Local (sherpa-onnx) | yes | yes (streaming and batch) | no | none | `voice.local` |

Every provider is off until `enabled` is true. The registry (`createVoiceProviders`) lists status per provider, and `discover` lists models and voices at run time so model ids are not hard-coded in config.

## Setup

1. Store the key in the secret store and put its reference in config, for example `voice.providers.elevenlabs.apiKeyRef`. The key is read lazily on first use. Plaintext keys are not a config option.
2. Set `enabled` to true. Optional: `region` (ElevenLabs: `default`, `us`, `eu`, `in`), `baseUrl` (https only, or loopback for a local relay), `defaultVoice`, `defaultModel`.
3. Polly takes no key. It uses the AWS SDK default credential chain (environment, shared config, SSO profile, instance role). `voice.providers.polly.credentials.profile` names a shared-config profile. Install the optional peers `@aws-sdk/client-polly` and `@aws-sdk/credential-providers`.

## Privacy

- The provider key never appears in results returned to clients, in log lines, in error messages or in snapshots. Errors are scrubbed of the key, and the HTTP logger never writes a query string.
- ElevenLabs `zeroRetention` asks the vendor not to log or retain request content. Use the `eu` or `in` region for data residency.
- Redirects are refused. A non-https `baseUrl` is accepted only for loopback.
- Cloud audio leaves the machine. The local tier (`docs/voice-local.md`) does not.

## Why there is no ElevenLabs Agents custom-LLM mode

That mode makes the vendor call a model endpoint that we expose, which needs a publicly reachable harness endpoint. The harness API is never public (loopback only), so the mode is out of scope. ElevenLabs is used as a TTS and ASR component inside the harness's own turn loop.

## WebSocket client

The realtime and streaming providers use a small built-in RFC 6455 client (`src/ws.ts`) instead of the global `WebSocket`, because the global one hides the status of a refused handshake and the unified codes need it (401 `auth`, 429 `rate_limited` with `Retry-After`). It treats everything the service sends as untrusted: a total message limit over all fragments (4 MiB, close 1009), reserved bits, masked server frames, bad fragmentation, bad control frames and unknown opcodes (1002), invalid UTF-8 in a message or close reason (1007), a close timeout (5 s) and a ping keepalive (every 20 s idle, dead peer after 10 s without any bytes). A frame that makes a codec throw ends the session with one `upstream_protocol` error event and a clean close. Limits and timers can be passed per socket (`limits`, `timers`); the global proxy variables are not honoured by this client.

## Egress

`voiceEgressHosts({ providers, catalog })` lists the hosts a configuration will contact (enabled cloud providers, the Polly regional endpoint when a region is set, the model download hosts including `release-assets.githubusercontent.com` that GitHub redirects release downloads to) in the shape of the embedding adapters' egress declaration, and `toEgressConfig` turns it into a fragment for core's egress allowlist. The package declares; core enforces.

## Errors and usage

All providers throw `VoiceProviderError` with a stable `code`: `auth`, `rate_limited`, `overloaded`, `invalid_request`, `unsupported`, `network`, `timeout`, `aborted`, `bad_response`, `upstream_protocol`, `closed`, `unavailable`, `licence_required`, `download_failed`, `checksum_mismatch`, `catalog`, `config`. HTTP calls honour `Retry-After`. Each call reports a `UsageReport` (characters, seconds, tokens where the vendor says so, absent otherwise). `toVoiceUsage` maps it onto core's `VoiceUsage` for `VoiceBudgetPort.record`.

## Verify at integration

No vendor endpoint was exercised against the live service. Everything below lives in `src/constants.ts` (flagged `VERIFY`), is overridable through config and, for model ids, found by discovery.

- ElevenLabs: host names per region, paths `/v1/text-to-speech/{voice}`, `.../stream-input`, `/v2/voices`, `/v1/models`, `/v1/speech-to-text`, `/v1/speech-to-text/realtime`; `output_format` values per rate; the `enable_logging=false` flag; the first-message chunk schedule; default models `eleven_flash_v2_5`, `scribe_v1`, `scribe_v2_realtime`.
- xAI: base URL, `/v1/realtime` path and message shapes, `/v1/models` listing and the pattern used to pick realtime models. No default model is assumed.
- Gemini: the API key travels in the `x-goog-api-key` header of the Live handshake (option `keyTransport: "query"` selects the documented `?key=` form; the official docs show only the query form, so confirm the header at integration), base URL, the Live WebSocket path, `bidiGenerateContent` as the models-list marker, audio MIME and sample rates, fallback model id.
- Polly: pcm rates (8000, 16000), mp3 rates, the 3000 character request limit, engine names.
- Local catalog: every download URL, archive layout, file names inside archives and every sha256 (see `docs/voice-local.md`).

## Tests

`pnpm --filter @plur1bus/voice-providers test` runs against a fake vendor server (HTTP and a small RFC 6455 implementation) and a fake local engine. No network, no model files.

## HTTP error mapping per voice adapter (test matrix)

`packages/voice-providers/test/error-table.test.ts` runs the same simulated responses through every voice function the cloud registry
exposes: ElevenLabs (`synthesize`, `synthesizeStream` over HTTP and WebSocket, `listVoices`, `transcribe`, `openStream`), xAI (`connect`,
`listModels`), Gemini (`connect`, `listModels`) and Polly (`synthesize`, `synthesizeStream`, `listVoices`). Cells read
`code / retryable / documented`. `[KNOWN GAP]` marks a cell that differs from the documented mapping in `docs/errors.md` (Voice provider
error codes) or in this file.

Shared status rows (ElevenLabs HTTP and WebSocket, xAI and Gemini `connect`, the JSON listing calls):

| Response | Code / retryable / documented |
|---|---|
| 401 | `auth` / no / yes |
| 403 | `auth` / no / yes |
| 404 (unknown voice or model) | `invalid_request` / no / yes |
| 408 | `timeout` / yes / no (the adapters have no deadline seam; 408 stands in) |
| 413 (audio too large) | `invalid_request` / no / yes |
| 429 with `Retry-After: 7` | `rate_limited` / yes / yes (`retryAfterMs` 7000) |
| 429 without `Retry-After` | `rate_limited` / yes / yes |
| 500 | `overloaded` / yes / yes |
| 503 | `overloaded` / yes / yes |

Body and abort rows:

| Function | Truncated JSON | Invalid JSON | Abort mid-response |
|---|---|---|---|
| ElevenLabs `synthesize`, `synthesizeStream` (HTTP) | n/a | n/a | raw `TypeError: terminated`, not a `VoiceProviderError` [KNOWN GAP] |
| ElevenLabs `synthesizeStream` (WebSocket), `openStream`; xAI and Gemini `connect` | `upstream_protocol` / no / yes | `upstream_protocol` / no / yes | `network` / yes / yes |
| ElevenLabs `listVoices`, `transcribe`; xAI and Gemini `listModels` | `bad_response` / no / yes | `bad_response` / no / yes | n/a |
| Polly `synthesize`, `synthesizeStream` | n/a | n/a | `network` / yes / yes |
| Polly `listVoices` | n/a | n/a | n/a |

Polly's status rows differ from the shared ones:

| Response | Polly |
|---|---|
| 401, 403 | `auth` / no / yes |
| 404 | `network` / yes / yes [KNOWN GAP: expected `invalid_request`, not retryable] |
| 408 | `network` / yes / no |
| 413 | `network` / yes / yes [KNOWN GAP: expected `invalid_request`, not retryable] |
| 429 (with or without `Retry-After`, since the simulated client sends no headers) | `rate_limited` / yes / no for the Retry-After row (no `retryAfterMs`), yes / yes otherwise |
| 500, 503 | `overloaded` / yes / yes |

Known gaps in this matrix, each with a todo case in the test file:
- ElevenLabs HTTP abort: a raw `TypeError` escapes instead of a `VoiceProviderError` (`src/providers/elevenlabs.ts:129`, `:135`).
- Polly 404 and 413: mapped to retryable `network`. `src/providers/polly.ts:129` maps only 400, and every other status falls through to `:131`.
- Vendor text: `docs/errors.md:115` says messages carry no vendor text, but the 404, 413 and 429 messages include the vendor's `detail` (`src/errors.ts:83`, `:86`, via `src/http.ts:110`). The secret itself is scrubbed in every cell.

Observations outside the table: `errorFromStatus` maps 504 to `timeout` (`src/errors.ts:84`), while the docs describe 5xx as `overloaded`. Not covered by
the matrix. The cloud registry names the xAI adapter `xai` (its file is `grok.ts`); `src/local/providers.ts` is outside the registry by design.
