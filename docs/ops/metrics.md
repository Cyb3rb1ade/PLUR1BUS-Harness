# Metrics endpoint and Zabbix template (D3)

The core can serve its operating numbers in the Prometheus text format (0.0.4) on a local HTTP endpoint, and
`docs/ops/zabbix/plur1bus-template.yaml` is a Zabbix 7 template that reads it.

## Enable

Off by default. In `config.json` (both keys restart the core, tier advanced):

```json
{ "metrics": { "enabled": true, "port": 9464 } }
```

The endpoint binds `127.0.0.1` only. If the port is taken the core logs `metrics endpoint unavailable` and starts without
it. On start the core creates `<home>/state/metrics.token` (64 hex characters, mode `0600`, user-only ACL on Windows) and
keeps it across restarts, so a monitoring system can store it once. To rotate it, delete the file and restart the core.
This token only opens `/metrics`; the core's RPC token (`run/core.token`) does not.

```bash
curl -s -H "Authorization: Bearer $(cat <home>/state/metrics.token)" http://127.0.0.1:9464/metrics
```

## Access rules

| Rule | Behaviour |
|---|---|
| Interface | loopback only; a non-loopback bind address is refused, the peer must be loopback |
| Host header | must be `localhost`, `127.x.x.x` or `[::1]` (DNS rebinding), else 403 |
| Methods and paths | `GET`/`HEAD` on `/metrics` only (405 / 404 otherwise); nothing can be changed through it |
| Authentication | `Authorization: Bearer <token>`, constant-time compare; never a query parameter; 401 with `WWW-Authenticate` |
| Brute force | 10 failures within 60 s lock that peer out for 60 s (429, `Retry-After`) |
| RBAC | the token maps to a principal with scope `metrics.read` through the `MetricsAccess` port; the scope is required (403) |

main has no RBAC layer yet, so the default `MetricsAccess` gives the one token exactly `metrics.read`. When RBAC lands it
implements the same port against its policy.

## Metrics

Labels come only from fixed enumerations (`registry.ts` folds anything else into `other` and refuses a metric whose
label space could exceed 1024 series; `plur1bus_rpc_calls_total` alone declares a bound derived from the schema's core method count times the result classes, capped at 16384, so adding RPC methods does not break core start). There are no agent, user, path, host, model or error-text labels.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `plur1bus_rpc_calls_total` | counter | `method` (the core's RPC methods), `result` (`ok`, `invalid_params`, `unauthorized`, `not_found`, `unavailable`, `internal`, `other`) | RPC calls per method and result class |
| `plur1bus_turn_duration_seconds` | histogram | `outcome` (`ok`, `error`, `aborted`) | chat turn duration, buckets 0.1 … 120 s |
| `plur1bus_provider_errors_total` | counter | `provider` (`openai`, `anthropic`, `google`, `openrouter`, `ollama`, `openai_compatible`, `other`), `kind` (`auth`, `rate_limit`, `timeout`, `server`, `invalid_request`, `network`, `other`) | failed provider calls |
| `plur1bus_process_resident_memory_bytes`, `_heap_used_bytes`, `_heap_total_bytes`, `_external_memory_bytes`, `_array_buffers_bytes` | gauge | | core process memory |
| `plur1bus_rpc_connections_open` | gauge | | open RPC connections |
| `plur1bus_engine_ready` | gauge | | 1 when the core is ready and the engine reports no degradation |
| `plur1bus_journal_backlog_entries` | gauge | | capture journal entries not yet stored |
| `plur1bus_agents` | gauge | | number of agents (a count, never names) |
| `plur1bus_core_uptime_seconds` | gauge | | seconds since the core started |

The turn and provider series exist from the start (at 0). The session loop and the provider adapters are not on main yet;
they record through `core.metrics.turn(seconds, outcome)` and `core.metrics.providerError(provider, kind)`. A new provider
adds its id to `PROVIDERS` in `packages/core/src/metrics/metrics.ts`.

## Zabbix

1. Import `docs/ops/zabbix/plur1bus-template.yaml` (Data collection → Templates → Import) and link it to the harness host.
2. Set `{$PLUR1BUS.METRICS.TOKEN}` (secret macro) to the contents of `state/metrics.token`; adjust `{$PLUR1BUS.METRICS.PORT}`
   if you changed `metrics.port`.
3. The endpoint is loopback only, so the poller must run on the harness host: use a Zabbix proxy or server there, or put
   the host's own agent in front. Nothing in the template needs a non-loopback listener.

One HTTP agent item (`plur1bus.metrics.get`, every minute, not stored) fetches the exposition; the other twelve items are
dependent and use Prometheus pattern preprocessing. Counters are turned into per-second rates with "Change per second"; a
core restart resets a counter and that sample is discarded by Zabbix. Items whose series does not exist yet (for example
no internal error so far) fall back to 0.

| Trigger | Expression (shortened) | Severity |
|---|---|---|
| Metrics endpoint not answering | no `plur1bus.engine.ready` data for `{$PLUR1BUS.NODATA.TIMEOUT}` (5 m) | High |
| Engine not ready | `plur1bus.engine.ready` is 0 for `{$PLUR1BUS.NOTREADY.TIMEOUT}` (5 m); depends on the first | Average |
| Provider errors high | 15 min average of provider errors per second above `{$PLUR1BUS.PROVIDER.ERRORS.RATE.MAX}` (0.01) | Warning |

Memory, connections, journal backlog and turn durations are collected without triggers; add your own threshold for the host.
The template was written against the Zabbix 7.0 export format and checked structurally in CI
(`packages/core/test/metrics/zabbix-template.test.ts`); it has not been imported into a live Zabbix from this repository's CI.
