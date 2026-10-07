# Providers

Hand-written. Code: `packages/providers/`. User-facing versions: [user/en/providers.md](user/en/providers.md),
[user/de/providers.md](user/de/providers.md). The provider matrix is [provider-matrix.md](provider-matrix.md).

One provider layer: adapters (OpenAI-compatible `chat_completions`, Gemini, Ollama and LM Studio through the same
OpenAI-compatible wire), one error taxonomy, one router that turns the config's `modelProfiles` into ordered fallback
chains.

## Adapters at a glance

| | chat_completions | Gemini | Ollama / LM Studio |
|---|---|---|---|
| Factory | `createChatCompletionsAdapter` | `createGeminiAdapter` | `createLocalChatAdapter(endpoint, createChatCompletionsAdapter)` |
| Wire | `POST {base}/chat/completions` (SSE) | `:generateContent` / `:streamGenerateContent?alt=sse` | the chat_completions wire (`/v1`) |
| Credentials | `Authorization` value supplied by the caller | secret store, header `x-goog-api-key` only | none: never an auth header |
| Usage fields | OpenAI fields; Ollama `prompt_eval_count`/`eval_count` as fallback | `usageMetadata` (thoughts and tool-use prompt tokens added) | as chat_completions |
| System prompt | `system`/`developer` messages | hoisted into `systemInstruction` | as chat_completions |
| Tool schema | passed through | reduced or refused (see below) | passed through |

Every adapter returns the same `ChatResult` and `ChatStreamEvent`s, and throws only `ProviderError`.

## Error classes

| `kind` | Meaning | HTTP / provider codes | Retry | Fallback |
|---|---|---|---|---|
| `auth` | credentials missing, rejected or unusable | 401, 402, 403, `API_KEY_INVALID`, `UNAUTHENTICATED` | no | **no** |
| `rate_limit` | too many requests / quota (`retryAfterMs` when given) | 429, `RESOURCE_EXHAUSTED` | yes, honouring Retry-After (quota-exhausted: no) | yes |
| `overloaded` | provider cannot serve right now | any 5xx incl. 529, `UNAVAILABLE`, `overloaded_error` | yes | yes |
| `context_length` | prompt does not fit | `context_length_exceeded`, Gemini token-count 400 | no | **no** |
| `invalid_request` | malformed, unknown or blocked | other 4xx, content filters (`contentFiltered: true`), Gemini safety blocks, refused tool schemas | no | **no** |
| `network` | no connection / connection broke | transport errors | yes (a dead local endpoint: no) | yes |
| `timeout` | client bound elapsed (`timeoutPhase`) or HTTP 408 | 408 | yes | yes |
| `aborted` | the caller cancelled | — | never | never |
| `unknown` | not understood (`code: "protocol"` for malformed responses, `"redirect"`) | 3xx, unrecognised in-stream errors | no | no |

The raw provider error is never exposed: `code`, `providerType` and `providerMessage` are kept for diagnostics, after
redaction. API keys (and the values of caller-supplied headers) never appear in messages, the `cause` chain, logs or
snapshots; `test/secrets.test.ts` scans every reachable error path for key patterns.

## Router and fallback rules

`ProviderRouter` maps a profile name to an ordered list of candidates (`provider`, `model`, adapter).

- **Fail closed.** Only the transient classes (`rate_limit`, `overloaded`, `timeout`, `network`) fall back to the next
  candidate. `auth`, `invalid_request` (incl. content filters), `context_length`, `aborted` and `unknown` end the call:
  a different vendor would get the same bad input, or the key problem is the user's to fix. A foreign (non-`ProviderError`)
  exception becomes `ProviderError("unknown")`.
- **Fallback only before the first streamed event**; every fallback emits `provider.fallback` through `onEvent`.
- **Circuit breaker per provider + model.** Three consecutive breaker-relevant failures open it for 30 s, then one
  probe is allowed. One model of a provider being down does not take out the others. `auth` and `invalid_request` never
  trip it.
- **Retry with backoff.** `maxRetries` (default 2) on the same candidate, full-jitter exponential backoff
  (`baseMs` 250, cap `maxMs` 8 s). A provider Retry-After is a floor for the wait; above `maxRetryAfterMs` (default 15 s)
  the router skips the wait and falls back. All of it is configurable through `RouterConfig.retry` / `breaker`; time and
  randomness are injected.
- **Abort everywhere.** The caller's `AbortSignal` reaches the HTTP request, the backoff sleep and the budget guard.
  Aborting ends a running stream immediately, also during a fallback, and is never retried.
- A `BudgetGuard` is asked before every attempt, so a fallback cannot bypass a cost limit.

## Configuring profiles

`modelProfiles` in `config.json` (schema: `packages/config-schema`):

```json
{
  "modelProfiles": {
    "default": {
      "candidates": [
        { "model": "openai/gpt-4.1" },
        { "model": "gemini/gemini-2.5-pro" },
        { "model": "ollama/llama3.1:8b" }
      ],
      "params": { "temperature": 0.2, "maxTokens": 4096 }
    },
    "fast": {
      "displayName": "Fast and cheap",
      "candidates": [{ "model": "gemini/gemini-2.5-flash" }, { "model": "openrouter/anthropic/claude-haiku" }]
    }
  }
}
```

- A candidate is `provider/model`, split at the **first** `/` (the model id may contain `/`, e.g. OpenRouter).
- **List order is priority order.** `weight` is kept but unused by the fallback strategy.
- `params` become request defaults for that profile; a value set on the request itself wins.
- **Default profile.** A profile named `default` is the default. If none is configured, `default` is synthesised from
  the registered providers that have a default model, in registration order; with none, there is no default and a call
  that names no profile fails with `RouterError("unknown_profile")`.
- **Validation** collects every problem and throws one `ProfileConfigError` whose `issues` carry the config path, e.g.
  `modelProfiles.fast.candidates[1].model: unknown provider "opnai" (known: gemini, ollama, openai)`. Unknown models are
  rejected only when the provider's registry entry lists its models.
- **`strategy: "moa"`** is validated but **not executable yet**: a call fails with
  `RouterError("unsupported_strategy")` instead of silently running as a plain chain. `cache` hints and `displayName`
  are carried on the resolved profile only.

```ts
import { createRouterFromProfiles } from "@plur1bus/providers";

const registry = new Map([
  ["openai", { adapter: openai, defaultModel: "gpt-4.1" }],
  ["gemini", { adapter: gemini, models: ["gemini-2.5-pro", "gemini-2.5-flash"] }],
]);
const { router, resolved } = createRouterFromProfiles(config.modelProfiles, registry, { onEvent });
```

## Local models (Ollama, LM Studio)

- `discoverLocalEndpoints()` probes `127.0.0.1:11434` (Ollama) and `127.0.0.1:1234` (LM Studio) with a short per-request
  timeout (1.5 s) and an overall deadline (3 s). Unreachable or empty servers are reported as **unavailable**
  (`availabilityOf`), never thrown.
- `LocalEndpointMonitor.snapshot()` is synchronous and never touches the network; `refresh()` is de-duplicated and
  `refreshInBackground()` is fire-and-forget.
- `guardLocalAdapter(monitor, label, adapter)` fails fast (a non-retryable `network` error, so the router falls back
  without retrying the dead endpoint) when the endpoint is known to be down.
- **No auth to local servers.** Loopback endpoints (`localhost`, `127.0.0.0/8`, `::1`) always use `NO_AUTH`; a
  credential or `Authorization`/`Cookie` header in the config is refused. Any other host needs
  `allowNonLoopback: true` and an egress policy.

## Gemini specifics

- **Safety.** A blocked prompt or candidate is `invalid_request` with `contentFiltered: true` (`GeminiSafetyBlockError`,
  keeps `reason` and `ratings`); text produced before a candidate block is in `partial`. Every `finishReason` and
  `blockReason` is mapped deliberately (table in `src/gemini/response.ts`); unknown values become finish reason `other`
  with the raw value kept. Broken tool calls (`MALFORMED_FUNCTION_CALL`, …) are protocol errors.
- **Tool schemas.** `convertToolSchema` passes the supported subset through, drops pure annotations, inlines local
  `$ref`s, rewrites `const` to `enum` and `oneOf` to `anyOf`, merges plain `allOf`. Features Gemini rejects
  (`patternProperties`, `if/then/else`, `not`, remote `$ref`, unknown keywords, …) are refused before any request with
  the tool name and schema path.
- **System prompt.** `system` and `developer` messages are hoisted in order into `systemInstruction`; empty ones are dropped.

## Usage accounting

`Usage` has `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningTokens`, all optional. **A count
the provider did not report is `undefined`, never 0.** Consumers must handle `undefined` (the core budget types still
expect numbers; bridging them is a follow-up).

## Streaming contract

Every adapter emits content events (text/reasoning deltas, tool-call start/delta) → exactly one `finish` → at most one
`usage` → exactly one `done`, last. Failures are thrown, never events. `test/contract/` runs the same scenarios over
every adapter against recorded, **synthetic** wire fixtures with no network.

## Public exports

`src/index.ts` is the whole public surface and is grouped: errors, neutral types, chat_completions, Gemini, router,
profiles, local models. Everything else is internal.
