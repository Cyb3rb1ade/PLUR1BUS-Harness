# C2 — Gemini adapter (Google Generative Language API)

Plan, 2026-10-07. Package `packages/providers`, new folder `src/gemini/`. Source of truth for the wire shape:
`docs/provider-matrix.md` (Google AI / Gemini API row, `native`, `api-key`).

## Scope

`createGeminiAdapter(config)` with the same `complete()` / `stream()` surface and the same neutral types
(`ChatRequest`, `ChatResult`, `ChatStreamEvent`, `ProviderError`) as the `chat_completions` adapter, over
`POST {baseUrl}/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`.

- System instruction (`systemInstruction`), contents, `functionDeclarations` / `functionCall` / `functionResponse`.
- Safety blocking (`promptFeedback.blockReason`, candidate `finishReason` SAFETY & co.) → `ProviderError` kind `content_filter`.
- Tokens from `usageMetadata`.
- API key only through a `GeminiCredentials` port (the secret store of the core implements it; tests use a fake). Sent only in the
  `x-goog-api-key` header; never in URL/query, body, error text or logs.

## Shared code

`Run`, `chunks`, `readText` in `client.ts` get an `export` (no behaviour change), `SseParser` and `classifyHttpError` are reused.
`ToolCall` / `AssistantToolCall` gain an optional opaque `thoughtSignature` (Gemini 3 requires it echoed on the next turn).

## Steps (test first, small commits)

1. Plan (this file).
2. Request builder + tests (system, contents merge, tools, tool roundtrip mapping, refusals).
3. Response accumulator (stream + non-stream share it) + usage + safety + tests.
4. Client (auth header, errors incl. 429 / retryDelay, timeouts) + local fake-server tests: streaming, tool roundtrip, block, 429, leak marker.
5. README, index export, lints, PR.

## Rulings (marked `// RULING:` in code)

See the PR description.
