# @plur1bus/embedding-adapters

Unified remote embedding and rerank adapters (ADR-006, M2): OpenAI and OpenAI-compatible servers (vLLM, llama.cpp, oMLX), OpenRouter, Google, Cohere, Jina, Voyage,
Ollama, TEI and MTPLX for embeddings; Cohere, Jina, Voyage, TEI, vLLM, llama.cpp, oMLX and MTPLX for rerank. No runtime dependencies, no network in unit tests, secrets only through an
injected `getSecret()`.

Not connected to core or the engine. Full documentation, provider table, error classes and the wiring follow-up: [`docs/embedding-adapters.md`](../../docs/embedding-adapters.md).

```sh
pnpm --filter @plur1bus/embedding-adapters test            # fixtures only
pnpm --filter @plur1bus/embedding-adapters test:coverage
PLUR1BUS_LIVE_EMBED=1 OPENAI_API_KEY=... pnpm --filter @plur1bus/embedding-adapters test   # optional live smoke
```
