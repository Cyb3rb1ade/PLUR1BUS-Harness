# @plur1bus/voice-providers

Cloud voice providers (ElevenLabs, xAI Grok Voice, Gemini Live, Amazon Polly), a local sherpa-onnx tier and the pure logic of the local real-time profile. No RPC, UI or listener.

- Providers and privacy: `docs/voice-providers.md`
- Local tier, catalog, licences and real-time profile: `docs/voice-local.md`
- Config keys: `voice.providers.*`, `voice.local.*`, `voice.localRealtime.*` in `docs/config.md`

Optional peers: `@aws-sdk/client-polly`, `@aws-sdk/credential-providers`, `sherpa-onnx-node`. Test: `pnpm --filter @plur1bus/voice-providers test`.
