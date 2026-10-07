# Model providers and profiles

This page explains how to choose models, how fallback behaves, how to use local models, and what the error classes
mean. The technical reference is [../../providers.md](../../providers.md); the German version of this page is
[../de/providers.md](../de/providers.md).

## Profiles

A **profile** is a named, ordered list of models. The first one is tried first; if it fails for a reason that another
model could fix, the next one is tried. Profiles live under `modelProfiles` in `config.json`:

```json
{
  "modelProfiles": {
    "default": {
      "candidates": [{ "model": "openai/gpt-4.1" }, { "model": "gemini/gemini-2.5-pro" }, { "model": "ollama/llama3.1:8b" }],
      "params": { "temperature": 0.2, "maxTokens": 4096 }
    }
  }
}
```

- A model is written `provider/model`. Everything after the first `/` is the model id.
- The order of the list is the priority.
- `params` set sampling defaults for the profile; anything a request sets itself wins.
- A profile called `default` is used when nothing else is named. If you configure none, one is built from the providers
  that have a default model.
- A typo is reported with its place in the file, for example
  `modelProfiles.fast.candidates[1].model: unknown provider "opnai"`. All problems are listed at once.
- `strategy: "moa"` (mixture of agents) is accepted and checked, but cannot run yet: using such a profile fails with a
  clear message instead of quietly behaving like a plain fallback list.

## When does it fall back?

| Problem | Retried | Falls back to the next model |
|---|---|---|
| Rate limit (429) | yes, waiting as long as the provider asks | yes |
| Provider overloaded or 5xx | yes | yes |
| Timeout, network failure | yes | yes |
| Wrong or missing API key | no | **no** — fix the key |
| Invalid request, content/safety block | no | **no** — another vendor would refuse it too |
| Prompt too long for the model | no | **no** |
| You cancelled | no | no |

Each model of each provider has its own breaker: if `gemini-2.5-pro` keeps failing it is skipped for a while, while
`gemini-2.5-flash` stays usable. Waiting between retries grows exponentially with random jitter; a provider that asks
for a very long wait is skipped in favour of the next model.

## Local models (Ollama, LM Studio)

Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`) are found automatically and need no key. If one is not
running, it simply counts as **unavailable** and the next model in the profile is used; nothing crashes and startup is
not delayed. No credentials are ever sent to a local server. Using a server on another machine needs an explicit
setting and an egress allowance.

## Error classes

`auth`, `rate_limit`, `overloaded`, `context_length`, `invalid_request`, `network`, `timeout`, `aborted`, `unknown`.
They are the same for every provider; raw provider errors are not shown, and API keys never appear in error messages
or logs.

## Token counts

Providers report different token details. If one does not report a number, it is shown as *unknown*, not as 0.
