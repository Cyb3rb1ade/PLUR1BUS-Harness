# Operating model discovery (D112)

The Core reads provider definitions from live `providers.<id>` configuration, the same
`{ wireFormat, profile, entries, strategy, openai }` definitions used by turn composition.
D15 `modelProfiles` selects models and fallback candidates; it does not store credentials.
Discovery reads definitions without rewriting model profiles, roles or credentials.
It shares the turn composition's credential pool and refresh owner. Replacing a stored key
under its existing reference takes effect immediately. Changing the auth profile itself
(origin, scheme, secret references or pool configuration) requires a Core restart to
rebuild that shared owner; discovery fails closed with `no_credential` until then.

## Routes and credentials

| Definition | Scanner | Credential path |
| --- | --- | --- |
| `chat_completions`, API key or supported OAuth profile | `openai-models` | Auth credential pool (`entries`), or `profile.secret_ref`, through the Core secret store and refresh owner |
| `anthropic_messages`, allowed API profile | `anthropic-models` | Same pool/store; use the profile's `x-api-key: {token}` scheme |
| `gemini`, allowed API profile | `google-models` | Same pool/store; use `x-goog-api-key: {token}` |
| `chat_completions` with `discovery: "ollama-tags"` | `ollama-tags` | No credential when both entries and secret reference are absent; otherwise the same pool/store |
| D110 direct SIWC plan, `dynamic_on_authorize`, `base_url` absent or exactly `https://api.openai.com/v1`, `openai.credentialId` and `openai.person` | `openai-models` | Existing `AuthService.lease` with the configured owner/person binding; never starts login |
| Codex or Claude `external_cli`; non-SIWC `codex_responses`; another SIWC base URL; ADC/Vertex; federated workload; restricted/prohibited profile | `manual` | No scanner, token lookup or invented Models request |

An Ollama definition must use the server root as `profile.base_url`, for example
`http://127.0.0.1:11434`, because its scanner requests `/api/tags`. `vendor` is an optional
provider-definition field selecting a section of the bundled metadata table. Without it,
the wire family selects `openai`, `anthropic`, `google` or `ollama`.

Secret references are handles, never keys in configuration. Store keys with
`plur1bus secret set <name>` using stdin. Missing credentials produce `failed:auth` with
`no_credential`; expired/dead D110 or OAuth logins retain `renew_sign_in`. Credentials are
bound to the configured origin and excluded from JSON/string inspection.

## Egress and scheduling

Set `egress.allowHosts` and `egress.allowPorts` for each provider. Defaults deny outbound
access. Ollama additionally needs `egress.allowLoopback: true`, an explicit loopback host
and its port. Every redirect is checked against the live Core egress policy; connections
use only its vetted IP. Cross-origin and userinfo redirects are refused. The existing
loopback-DNS, decompression, response-size, pagination and cursor limits remain in force.
Ambient HTTP proxy variables remain ignored.

`models.scan.enabled` defaults to true and `models.scan.intervalHours` to 24. Scans run
with the existing jitter and bounded concurrency. Startup arms catch-up timers after Core
readiness; it does not make synchronous provider requests. Persisted scan state prevents
fresh providers from being rescanned on every restart. Overdue providers catch up within
the startup window; auth and network failures retain their distinct backoff rules. Live
scan/provider configuration changes replan the scheduler. Shutdown cancels its timers.

Run `plur1bus model scan` for an explicit scan, or add `--provider <id>` for one definition.
`plur1bus model list` shows available models immediately and adds `new` to their status.
`--json` includes optional boolean `new`; RPC 1.6.0 adds this field without changing
`newCount` or `newOnly`. `plur1bus model list --new` selects unacknowledged models;
`plur1bus model list --new --ack` acknowledges them. API metadata overrides table defaults;
user overrides retain highest priority. Unknown metadata stays editable.

Clients subscribe with `events.subscribe` and `names: ["models.changed"]` to receive
catalog deltas. The D111 catalogue registers `model.discovered`, `model.unavailable`,
`model.scan.failed` and `model.scan.completed` as provider diagnostic events. Core log
rotation, level settings, redaction and schema validation apply. Event attributes contain
metadata and fixed failure tokens, never credential values or provider response bodies.

## Limits and edge cases

A scan stops at 5 s for the connection, 15 s per request and 60 s overall, reads at most 10
pages, 4 MiB per body (also after decompression), 8 MiB in total and 5 000 entries. One invalid
entry fails the whole scan as `failed:invalid`, so a real model is never marked unavailable
because a neighbour was malformed; an optional field that is `null` counts as absent, an `id`
that is missing or malformed does not. An empty list is `failed:empty` and changes nothing.

Aliases are unique per provider. When two models claim one alias, an alias set by the user
(override or manual entry) wins, then a model that the provider still lists, then the more recent one. Models that disappear stay in the catalog as `unavailable`; they are not
pruned. The catalog file is capped at 16 MiB: a write that would exceed it fails with
`store_write_failed` instead of producing a file the next start would quarantine.

A manual entry's `id` is non-empty, at most 512 bytes, without control characters.
`models.setOverride` rejects unknown keys in `set` and a `contextWindow` above 2^53 - 1 as
`E_INVALID_PARAMS`. Timers are never armed further out than 2^31 - 1 ms; a longer wait is
re-armed in steps.

## Offline verification

`packages/core/test/discovery/real-core.test.ts` runs all scanner protocols and the real
credential and egress decisions with an in-memory keyring, fake clock and socket-free HTTP
transport. Set `PLUR1BUS_BIN` to a locally built CLI to additionally exercise scan/list
against that Core. Legacy discovery HTTP regressions use synthetic loopback endpoints,
explicitly allowlisted only by their test configuration. No test contacts a live provider.

## Reasoning levels

Every catalog model carries a reasoning description, used by the per-chat reasoning choice (`chat.model.get`/`chat.model.set`,
`session.model.set`): `kind` (`none`, `effort`, `budget`, `toggle`), the supported `levels` on the harness scale
`off < minimal < low < medium < high < xhigh`, an optional provider `default`, the wire parameter and, for `budget`, token bounds.
The sources, in this order:

1. **The provider's own model list**, stored by the scan as `api.reasoning`: OpenRouter `supported_parameters` (`reasoning` means its
   unified `reasoning.effort` object; the list without it means no setting), Gemini model metadata `thinking`, and the `capabilities`
   of newer Ollama servers (`thinking`). The API decides whether a model reasons; where it gives no details, a matching table rule
   supplies them, else a conservative default. A malformed hint is treated as silence, never as a failed scan.
2. **The curated table** `packages/core/catalog/reasoning-metadata.json` (schema `plur1bus.reasoning-metadata/1`, versioned by
   `revision`): OpenAI `reasoning_effort` (o-series, gpt-5 with `minimal`, gpt-5.1 with `off` = `none`, gpt-5.2 with `xhigh`), Anthropic
   extended thinking as `thinking.budget_tokens`, Gemini 2.5 `thinkingBudget` and Gemini 3 `thinkingLevel`, xAI `reasoning_effort`,
   the Qwen3 thinking toggle (`chat_template_kwargs.enable_thinking`), Ollama models through `reasoning_effort`, and models that reason
   on their own (`none`: deepseek-reasoner, grok-4, other Claude models). The vendor section is tried first, then `generic`.
3. **Unknown**: `none`, with the hint `reasoning-unknown`.

`node --experimental-strip-types scripts/check-reasoning-metadata.mjs` validates the reasoning table and reports
coverage hints for concrete chat model IDs and aliases from the bundled D112 `model-metadata.json` table. Vendor
identity is preserved. Open-ended family patterns do not enumerate model IDs, so they are not counted as concrete
models; no IDs are invented from a regex. The summary reports how many known models were checked. Missing coverage
is informational; invalid schema or unsafe patterns still fail the check.

The description is fitted to the wire the profile speaks (the Responses API spells OpenAI's effort `reasoning.effort`); a parameter a
wire cannot write becomes `none` with the hint `reasoning-wire-unsupported`. Each attempt of a turn maps the chat's level onto that
candidate model (the nearest supported level, ties to the cheaper one), so a fallback model with other levels gets its own nearest
level; budget levels map onto the model's range (minimal = min, low 1/8, medium 1/4, high 1/2, xhigh = max). An adapter refuses a
parameter it cannot express before any I/O. Anthropic: `max_tokens` is lifted above the thinking budget, and a request that continues
a tool loop carries its complete unmodified signed thinking and redacted-thinking blocks before assistant text/tool calls.
Opaque blocks are kept in WeakMap transport metadata only for the current turn: they do not serialize into logs,
partial results, prompt records or session storage. An unsigned continuation or a different fallback model fails before I/O.
The budget guard reserves the same lifted output maximum that the wire sends, including every tool round.



## Chat model selection II (2026-10-18)

Confirmed changes append `session.model.changed` atomically with the profile/reasoning CAS. The event records model,
profile, reasoning, time, actor and message position; a failed or stale write appends nothing. Remembered sessions
persist these events, while incognito sessions and their changes stay in the memory-only store. `session.resume` and
`chat.get` include the latest 2000 model-change notes, independent of delta volume, for chronological transcript replay.

`plur1bus chat --model <profile> --reasoning <level>` sets either or both for a new/current session. The experimental
`plur1bus session model get <session>` and `set <session> [--model <profile>] [--reasoning <level>] --yes` retain raw RPC
fields in JSON (`session.model.get/1` and `session.model.set/1`). Preview/CAS and the cache/cost confirmation remain required.

The dropdown uses `privacy/local-only.ts` as its sole classification source. Accepted live privacy changes emit
`chat.models.changed`, a value-free invalidation containing only time and reason. The API can broadcast that hint;
clients must reread their authorized `chat.model.get`, and receive no config, secret or agent-ID list through it.

Anthropic's [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort), checked 2026-10-18,
states that top-level `output_config.effort` needs no beta header. The curated supported-model rules use that stable
parameter; per-message effort remains outside this implementation. Curated 4.6/4.7/4.8 rules explicitly enable adaptive
thinking with effort; effort alone would leave thinking off on those models. Opus 4.5 and older manual-thinking models
retain their token-budget path. The table and schema carry this capability, without model-name rules in the request builder.
See also [thinking with tools](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).

`scripts/check-reasoning-metadata.mjs` validates the JSON Schema and safe compiled patterns in CI's unit job. Callers that
pass a list of known models get informational coverage hints for models without a matching rule, never validation failures.
Schema errors and unsafe/duplicate patterns fail. Local tests cover both cases.
