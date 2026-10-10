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

## Offline verification

`packages/core/test/discovery/real-core.test.ts` runs all scanner protocols and the real
credential and egress decisions with an in-memory keyring, fake clock and socket-free HTTP
transport. Set `PLUR1BUS_BIN` to a locally built CLI to additionally exercise scan/list
against that Core. Legacy discovery HTTP regressions use synthetic loopback endpoints,
explicitly allowlisted only by their test configuration. No test contacts a live provider.
