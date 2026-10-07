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

## Router (`src/router/`)

`ProviderRouter` maps a profile name to an ordered candidate list (`provider`, `model`, adapter) and adds retry with
jittered backoff, a circuit breaker per provider+model (closed / open / half-open) and fallback. Fallback happens only
before the first streamed event and always emits `provider.fallback` through `onEvent`; a `BudgetGuard` port is asked
before every attempt so a fallback cannot bypass a cost limit. Content-filter, context-length and bad-request errors
are never retried nor routed to another vendor. Time and randomness are injected (`Clock`, `random`).

## Local models (`src/local`)

- `discoverLocalEndpoints()` probes `127.0.0.1:11434` (Ollama: `/api/tags`, then `/v1/models`) and `127.0.0.1:1234` (LM Studio: `/v1/models`) without any key.
- `probeEndpoint()` never throws on a service problem; it returns a `state`: `ok`, `empty`, `unreachable`, `timeout`, `refused`, `protocol`.
- Loopback only. Any other origin needs `allowNonLoopback: true` **and** an `EgressPolicy`; without a policy it is `refused`.
- `createLocalChatAdapter(endpoint, createChatCompletionsAdapter)` builds the chat_completions adapter with `NO_AUTH` credentials (no `Authorization` header).

Tests: `pnpm --filter @plur1bus/providers test` (fake loopback servers only).
