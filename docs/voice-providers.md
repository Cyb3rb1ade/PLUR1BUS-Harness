# Voice providers (AL1)

`packages/voice-providers` holds the cloud voice providers and the logic for the local real-time profile. It adds no RPC, CLI, UI, network listener or credential wiring: a caller (the D110 broker, a future integration PR) builds a registry from config and passes it a secret reader. The package consumes core's `VoiceUsage` type only (`packages/core/src/voice/ports.ts`, type import) and never changes core.

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

## Errors and usage

All providers throw `VoiceProviderError` with a stable `code`: `auth`, `rate_limited`, `overloaded`, `invalid_request`, `unsupported`, `network`, `timeout`, `aborted`, `bad_response`, `closed`, `unavailable`, `licence_required`, `download_failed`, `checksum_mismatch`, `catalog`, `config`. HTTP calls honour `Retry-After`. Each call reports a `UsageReport` (characters, seconds, tokens where the vendor says so, absent otherwise). `toVoiceUsage` maps it onto core's `VoiceUsage` for `VoiceBudgetPort.record`.

## Verify at integration

No vendor endpoint was exercised against the live service. Everything below lives in `src/constants.ts` (flagged `VERIFY`), is overridable through config and, for model ids, found by discovery.

- ElevenLabs: host names per region, paths `/v1/text-to-speech/{voice}`, `.../stream-input`, `/v2/voices`, `/v1/models`, `/v1/speech-to-text`, `/v1/speech-to-text/realtime`; `output_format` values per rate; the `enable_logging=false` flag; the first-message chunk schedule; default models `eleven_flash_v2_5`, `scribe_v1`, `scribe_v2_realtime`.
- xAI: base URL, `/v1/realtime` path and message shapes, `/v1/models` listing and the pattern used to pick realtime models. No default model is assumed.
- Gemini: base URL, the Live WebSocket path, `bidiGenerateContent` as the models-list marker, audio MIME and sample rates, fallback model id.
- Polly: pcm rates (8000, 16000), mp3 rates, the 3000 character request limit, engine names.
- Local catalog: every download URL, archive layout, file names inside archives and every sha256 (see `docs/voice-local.md`).

## Tests

`pnpm --filter @plur1bus/voice-providers test` runs against a fake vendor server (HTTP and a small RFC 6455 implementation) and a fake local engine. No network, no model files.
