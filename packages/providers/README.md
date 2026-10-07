# @plur1bus/providers

Provider adapters for the chat wire formats (M2, `docs/milestones.md` §M2, acceptance 3). This is **part 1**: the
OpenAI-compatible `chat_completions` format (`POST {baseUrl}/chat/completions`). `codex_responses`,
`anthropic_messages`, the auth engine, budgets and the prompt zones are other packages or later parts. No runtime
dependencies; Node 24 `fetch`.

## Use

```ts
import { createChatCompletionsAdapter } from "@plur1bus/providers";

const adapter = createChatCompletionsAdapter({
  baseUrl: "https://api.openai.com/v1",
  credentials: { authorization: () => "Bearer …" },   // a ready-made header value; the adapter has no auth logic
  timeouts: { headersMs: 30_000, idleMs: 60_000, totalMs: 300_000 },   // all injectable, per call too
});

for await (const e of adapter.stream(request, { signal })) {
  // text_delta | reasoning_delta | tool_call_start | tool_call_delta | usage | finish | done {result}
}
const result = await adapter.complete(request, { signal });          // non-stream path, same ChatResult
```

`ChatRequest` carries messages (system, developer, user with text/image parts, assistant with tool calls, tool),
tools, `toolChoice`, `parallelToolCalls`, `maxTokens`, `temperature`, `topP`, `stop` and `responseFormat`
(`text`, `json_object`, `json_schema`). `buildRequestBody()` validates and serialises it with a fixed key order
(same request, same bytes — prefix caches key on them).

## What it guarantees

- **Streaming**: an incremental SSE parser (UTF-8 across chunks, CRLF/CR/LF, comments, `[DONE]`) and per-`index`
  assembly of tool-call deltas; usage from the final chunk. The stream and non-stream paths produce the same
  `ChatResult` for the same turn.
- **One error type**, `ProviderError`, with `kind` ∈ `auth`, `rate_limit` (with `retryAfterMs`), `context_length`,
  `content_filter`, `bad_request`, `server`, `timeout` (`timeoutPhase`: headers, idle, total), `network`,
  `protocol` (malformed response or stream), `aborted`. `retryable` is a hint for the retry budget. A failed stream
  carries what had arrived in `partial`.
- **Abort and timeouts everywhere**: one `AbortSignal` (caller) plus three bounds; every exit path (done, error,
  abort, the consumer leaving the loop early) cancels the request and clears the timers.
- **Fail closed**: invalid requests are refused before any I/O; a malformed chunk, a missing `[DONE]`, a tool call
  that changes its id, an oversized event — all `protocol` errors, never a half-understood turn. Redirects are not
  followed; the Authorization value is never sent over plain `http:` to a non-loopback host (unless
  `allowInsecureHttp`), and is scrubbed from provider messages.
- **Tool-argument repair hook** (`ToolArgumentRepair`, interface only): called at most once per tool call whose
  arguments are not a JSON object; the call keeps `argumentsError` when there is no hook or it declines. The real
  repair (D97) comes later.

## Rulings

Decisions the spec left open are marked `// RULING:` in the source (finish reason `content_filter` is a result, not
an error; `aborted` is its own kind; 402 is `auth`; a tool-call delta without `index` is refused; …). The PR that
introduced the package lists them.

## Tests

```bash
cd packages/providers && pnpm test      # or: node ../../scripts/test-package.mjs
```

Only hand-made fixtures (`test/fixtures/`, synthetic ids, no keys) and a local stub HTTP server on `127.0.0.1`;
no live call, no network beyond loopback. Every test has a hard timeout.

## Gemini (`src/gemini/`)

`createGeminiAdapter` speaks the Google Generative Language API (`native` in `docs/provider-matrix.md`):
`POST {baseUrl}/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`, default base
`https://generativelanguage.googleapis.com/v1beta`. Same `complete()` / `stream()` surface, request/result/event types and
`ProviderError` as above.

```ts
import { createGeminiAdapter } from "@plur1bus/providers";

const gemini = createGeminiAdapter({
  credentials: { apiKey: ({ signal }) => secretStoreLease("google-gemini", signal) },   // a port; the core's secret store implements it
});
```

- System/developer messages become `systemInstruction`; tools become `functionDeclarations` (`parametersJsonSchema`); a tool call is
  a `functionCall` part, its result a `functionResponse` in the next user turn. A call the model sends without an id gets
  `gemini-call-<n>`; a `thoughtSignature` is surfaced on `ToolCall` and must be handed back on `AssistantToolCall`.
- **Safety blocks are typed errors**: `promptFeedback.blockReason` and a candidate cut by `SAFETY`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY` or `RECITATION` throw `ProviderError` kind `content_filter` with `code` = the reason
  (a mid-stream cut keeps the text so far in `partial`).
- Tokens come from `usageMetadata` (thinking tokens count as output; `cachedContentTokenCount` as cached input).
- **The API key** is asked for on every call, sent only as `x-goog-api-key`, refused in the base URL (`?key=` is rejected), and scrubbed
  (the exact value and anything shaped like a Google key) from every provider message. It is never logged.
- A 400 that means an invalid key is `auth`, an oversized prompt `context_length`; a 429 takes `retryAfterMs` from `Retry-After`,
  else from the body's `RetryInfo.retryDelay`.

Tests: `test/gemini/` (fake server on loopback, including `secret-leak.test.ts`).
