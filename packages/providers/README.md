# @plur1bus/providers

Provider adapters for the chat wire formats (M2, `docs/milestones.md` §M2, acceptance 3): the OpenAI-compatible
`chat_completions` format (`POST {baseUrl}/chat/completions`, also behind Ollama and LM Studio), Gemini, and the two
wire formats that completed M2's set: `anthropic_messages` (`createAnthropicAdapter`, Messages API, API-key route) and
`codex_responses` (`createResponsesAdapter`, OpenAI Responses API). The auth engine (OAuth, the Claude Code / Agent SDK
route), budgets and the prompt zones are other packages or later parts. No runtime dependencies; Node 24 `fetch`.

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
- **One error type**, `ProviderError`, with `kind` ∈ `auth`, `rate_limit` (with `retryAfterMs`), `overloaded`,
  `context_length`, `invalid_request` (`contentFiltered` marks a content/safety refusal), `network`, `timeout`
  (`timeoutPhase`: headers, idle, total), `aborted`, `unknown` (`code: "protocol"` for a malformed response or stream).
  `retryable` is a hint for the retry budget. A failed stream carries what had arrived in `partial`. No credential
  reaches a message, the `cause` chain or a field (`test/secrets.test.ts`). Table: `docs/providers.md`.
- **Abort and timeouts everywhere**: one `AbortSignal` (caller) plus three bounds; every exit path (done, error,
  abort, the consumer leaving the loop early) cancels the request and clears the timers.
- **Fail closed**: invalid requests are refused before any I/O; a malformed chunk, a missing `[DONE]`, a tool call
  that changes its id, an oversized event — all `protocol` errors, never a half-understood turn. Redirects are not
  followed; the Authorization value is never sent over plain `http:` to a non-loopback host (unless
  `allowInsecureHttp`), and is scrubbed from provider messages.
- **Tool-argument repair hook** (`ToolArgumentRepair`, interface only): called at most once per tool call whose
  arguments are not a JSON object; the call keeps `argumentsError` when there is no hook or it declines. The real
  repair (D97) comes later.

## Gemini (`createGeminiAdapter`)

Native adapter for the Google Generative Language API (`POST {base}/models/{model}:generateContent` and
`:streamGenerateContent?alt=sse`, default base `https://generativelanguage.googleapis.com/v1beta`). Same `ChatRequest`,
`ChatResult`, `ChatStreamEvent` and `ProviderError` as above; the system messages become `systemInstruction`, tools
become `functionDeclarations`, tool results `functionResponse` parts.

```ts
import { createGeminiAdapter, secretStoreKey } from "@plur1bus/providers";

const gemini = createGeminiAdapter({ credentials: secretStoreKey(secretStore, profile.secret_ref) });
```

- **Key**: read from the secret store (any `{ get(ref) }`, i.e. the core `SecretStore`) on every call; sent only as the
  `x-goog-api-key` header, never in the URL, query, body, an error message or a log; scrubbed from provider texts;
  refused over plain `http:` to a non-loopback host. No key is an `auth` error before any I/O.
- **Safety blocks** are `GeminiSafetyBlockError` (`invalid_request` + `contentFiltered`, never retryable) with `source`
  (`prompt` | `candidate`), the verbatim `reason` and the `ratings`; text generated before a candidate block is in `partial`.
- **Usage** from `usageMetadata`: output = candidates + thoughts, input = prompt + tool-use prompt, cached and reasoning
  tokens separate; a count Gemini did not report is `undefined`, never 0. **Tool schemas** go through `convertToolSchema`
  (supported subset kept, annotations dropped, local `$ref` inlined, unsupported features refused before any I/O). **Tool-call ids** are positional (`call_<n>`); a Gemini 3 `thoughtSignature` rides in the id after `~`
  and is replayed automatically when the id is sent back.
- Not covered here: `safetySettings`, context caching (`cachedContent`), Vertex AI (ADC auth), embeddings, remote image URLs.
  Decisions the API left open are `// RULING:` comments in `src/gemini/`.

## Anthropic Messages (`createAnthropicAdapter`)

`POST {base}/messages` (default base `https://api.anthropic.com/v1`). **API-key route only** (ADR-005 D12): the key comes
from `credentials.apiKey(ctx)` on every call and travels only as `x-api-key`, next to `anthropic-version` (default
`2023-06-01`, configurable). The Claude Code / Agent SDK route is a different component and not part of this package.

```ts
import { createAnthropicAdapter } from "@plur1bus/providers";

const claude = createAnthropicAdapter({
  credentials: { apiKey: () => secrets.get("anthropic:main") }, // or secretStoreKey(store, "anthropic:main")
  defaultMaxTokens: 4096,                                       // max_tokens is mandatory on this wire
  cache: { system: true, tools: true, ttl: "5m" },              // optional cache_control markers
});
```

- **Request**: `system`/`developer` messages are hoisted into top-level `system` blocks; consecutive same-role messages
  are merged into one turn (a user turn lists its `tool_result` blocks first); the first turn must be a user turn. Tool
  call ids are rewritten to Anthropic's id alphabet (a collision is refused), tool pairing is validated before any I/O.
  `toolChoice` → `auto`/`any`/`tool`/`none`; `parallelToolCalls: false` → `disable_parallel_tool_use`; `stop` →
  `stop_sequences`. Refused with `invalid_request`: `temperature` above 1 and any `responseFormat` other than `text`
  (the wire has none). Key order is fixed (prompt-cache stability).
- **Prompt caching** is an adapter option (`config.cache`) overridable per request through
  `request.providerOptions.anthropic.cache` (`tools`, `system`, `messages`, `ttl: "5m" | "1h"`); nothing in core types
  changes, other adapters ignore `providerOptions`.
- **Stream**: `message_start`, `content_block_*` (`text_delta`, `input_json_delta` assembled per block,
  `thinking_delta` → `reasoning_delta`; `signature_delta`, `redacted_thinking` and server-tool blocks are never shown),
  `message_delta`, `message_stop`, `ping`, `error`. `finish` is emitted at `message_stop`, so a stream cut before it is
  a `protocol` error carrying `partial`. Unknown event types are ignored.
- **Usage**: `inputTokens` is the whole prompt (`input_tokens` + cache creation + cache read), `cachedInputTokens` the
  cache-read part, `AnthropicUsage.cacheCreationInputTokens` the written part; the wire reports no reasoning count.
- **Stop reasons**: `end_turn`/`stop_sequence` → `stop`, `max_tokens`/`model_context_window_exceeded` → `length`,
  `tool_use` → `tool_calls`, `refusal` → `content_filter` (a result, not an error), anything else → `other`.
- **Errors**: `authentication_error`/`permission_error`/`billing_error` and an exhausted credit balance → `auth`;
  `rate_limit_error` → `rate_limit` (`retry-after`); 529, `overloaded_error`, `api_error`, 5xx → `overloaded`;
  `invalid_request_error` → `invalid_request`, or `context_length` for "prompt is too long".

## OpenAI Responses (`createResponsesAdapter`, wire `codex_responses`)

`POST {base}/responses` (default base `https://api.openai.com/v1`); credentials are a ready-made `Authorization` value,
as for chat_completions.

```ts
import { createResponsesAdapter } from "@plur1bus/providers";

const codex = createResponsesAdapter({
  credentials: { authorization: () => `Bearer ${key}` },
  reasoningEffort: "medium", reasoningSummary: "auto",   // defaults; request.providerOptions.responses overrides
});
```

- **Request**: `system`/`developer` messages become `instructions`; user/assistant turns become `input` items
  (`message`, `function_call`, `function_call_output`, linked by `call_id`; ids over 64 characters are replaced by a
  stable hash everywhere they occur). `tools` (function), `tool_choice`, `parallel_tool_calls`, `max_output_tokens`,
  `reasoning.effort` / `reasoning.summary`, `text.format`, `store` (**default false**) and `stream`. Refused with
  `invalid_request`: `stop` sequences, a tool result without its call, an empty assistant message.
- **`profile: "chatgpt_plan"`** is the switch for the later ChatGPT-plan (Codex) profile, **a switch only (no OAuth, no
  account logic)**: it forces `store:false` and `stream:true` (`complete()` streams on the wire and returns the collected
  result), requires `instructions`, and refuses `maxTokens`, `temperature`, `topP` and `store:true`; the factory itself
  refuses `store: true`. The caller supplies the bearer token and any account headers (`headers`).
- **Stream**: `response.created`, `response.output_item.added/done`, `response.output_text.delta`,
  `response.function_call_arguments.delta/done` (a tool call's id is its `call_id`), `response.reasoning_summary_text.delta`
  / `response.reasoning_text.delta` → `reasoning_delta` (never text), `response.refusal.delta` (text, finish
  `content_filter`), `response.completed` / `response.incomplete` (`max_output_tokens` → `length`), `response.failed`
  and `error` (thrown). `finish` is emitted at the terminal event; a stream that ends without one is a `protocol` error.
- **Usage**: `input_tokens` is the whole prompt, `cached_tokens` its subset (`cachedInputTokens`), `reasoning_tokens`
  → `reasoningTokens`; `totalTokens` is the reported one, else input + output when both are known.
- **Errors**: as the shared taxonomy, plus the rate-limit reset headers (`x-ratelimit-reset-requests/-tokens`, Go-style
  durations such as `6m0s`, used only on a 429 and only when there is no `retry-after`), `insufficient_quota` and the
  plan's `usage_limit_reached` as a `rate_limit` that retrying does not fix, `invalid_prompt` from the usage policy as a
  content filter, `context_length_exceeded` → `context_length`.

## Wire formats in one profile

```json
{
  "modelProfiles": {
    "default": {
      "candidates": [
        { "model": "openai/gpt-4.1" },
        { "model": "anthropic/claude-sonnet-4-5" },
        { "model": "codex/gpt-5-codex" }
      ],
      "params": { "maxTokens": 4096 }
    }
  }
}
```

Each provider id in the registry maps to whichever adapter speaks its wire; the router treats them alike. Transient
failures (`rate_limit`, `overloaded`, `timeout`, `network`) fall through to the next wire, `auth`, `invalid_request` and
`context_length` end the call (`test/router/mixed-wires.test.ts`).

## Limits and follow-ups

- Anthropic thinking-block signatures are not replayed (the neutral `ChatMessage` has no field for them), so extended
  thinking across tool turns is not supported yet; `cacheCreationInputTokens` rides on an adapter-level `Usage`
  extension because core types are untouched.
- `responseFormat` other than `text` is refused for Anthropic (no equivalent on the wire); `stop` is refused for Responses.
- The fields the ChatGPT-plan backend refuses are taken from its documented behaviour and are **not verified against
  the live backend**; the auth engine (OAuth, account headers) is a separate component.
- The tool-argument helper (`src/anthropic/tool-args.ts`, shared with the Responses adapter) should move to `src/`
  and be shared with chat_completions and Gemini; the change that added it could only touch `src/anthropic/**` and
  `src/responses/**`.
- All fixtures are **synthetic** reconstructions from the public docs (`test/contract/fixtures/README.md`); recorded
  captures replace them when keys are available. The end-to-end tool-call run through `plur1bus chat` (M2 acceptance
  3) is a follow-up; `test/roundtrip.test.ts` covers the provider half.

## Rulings

Decisions the spec left open are marked `// RULING:` in the source (the OpenAI-compatible finish reason
`content_filter` is a result, not an error; `aborted` is its own kind; 402 is `auth`; every 5xx is `overloaded`; a
tool-call delta without `index` is refused; …). The PRs that introduced them list them.

## Tests

```bash
cd packages/providers && pnpm test      # or: node ../../scripts/test-package.mjs
```

Only hand-made fixtures (`test/fixtures/`, `test/contract/fixtures/`, synthetic ids, no keys) and a local stub HTTP server on `127.0.0.1`;
no live call, no network beyond loopback. Every test has a hard timeout.

## Router (`src/router/`)

`ProviderRouter` maps a profile name to an ordered candidate list (`provider`, `model`, adapter) and adds retry with
jittered backoff, a circuit breaker per provider+model (closed / open / half-open) and fallback. Fallback happens only
before the first streamed event and always emits `provider.fallback` through `onEvent`; a `BudgetGuard` port is asked
before every attempt so a fallback cannot bypass a cost limit. Only `rate_limit`, `overloaded`, `timeout` and `network`
fall back; `auth`, `invalid_request` (incl. content filters), `context_length`, `aborted` and `unknown` never do.
`src/profiles/` resolves the config's `modelProfiles` into a router (`createRouterFromProfiles`) with path-bearing
config errors and a default profile; `strategy: "moa"` is validated but not executable yet. Time and randomness are injected (`Clock`, `random`).

## Local models (`src/local`)

- `discoverLocalEndpoints()` probes `127.0.0.1:11434` (Ollama: `/api/tags`, then `/v1/models`) and `127.0.0.1:1234` (LM Studio: `/v1/models`) without any key.
- `probeEndpoint()` never throws on a service problem; it returns a `state`: `ok`, `empty`, `unreachable`, `timeout`, `refused`, `protocol`.
- Loopback only. Any other origin needs `allowNonLoopback: true` **and** an `EgressPolicy`; without a policy it is `refused`.
- Discovery is short and bounded (1.5 s per request, 3 s overall); an unreachable server is `unavailable`, never an exception. `LocalEndpointMonitor` keeps a non-blocking cache; `guardLocalAdapter` makes a known-dead endpoint fail fast so the router falls back.
- `createLocalChatAdapter(endpoint, createChatCompletionsAdapter)` builds the chat_completions adapter with `NO_AUTH` credentials (no `Authorization` header); credentials or auth headers in the config for a loopback endpoint are refused.

Tests: `pnpm --filter @plur1bus/providers test` (fake loopback servers only). `test/contract/` runs one streaming
contract (order: content → one `finish` → at most one `usage` → one `done`) over every adapter; its fixtures are
synthetic reconstructions of the wire formats, not live captures. Docs: `docs/providers.md`.
