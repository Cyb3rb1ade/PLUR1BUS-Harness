# @plur1bus/providers

Provider adapters (private). This change adds only `src/local/**`: discovery of local OpenAI-compatible model servers.

## Local models (`src/local`)

- `discoverLocalEndpoints()` probes `127.0.0.1:11434` (Ollama: `/api/tags`, then `/v1/models`) and `127.0.0.1:1234` (LM Studio: `/v1/models`) without any key.
- `probeEndpoint()` never throws on a service problem; it returns a `state`: `ok`, `empty`, `unreachable`, `timeout`, `refused`, `protocol`.
- Loopback only. Any other origin needs `allowNonLoopback: true` **and** an `EgressPolicy`; without a policy it is `refused`.
- `createLocalChatAdapter(endpoint, createChatCompletionsAdapter)` builds the chat_completions adapter with `NO_AUTH` credentials (no `Authorization` header).

Tests: `pnpm --filter @plur1bus/providers test` (fake loopback servers only).
