# D3: metrics endpoint and Zabbix template

Plan, 2026-10-07. Branch `claude/d3-metrics-zabbix`, one PR.

## Goal

A read-only, loopback-only, token-protected `GET /metrics` on the core (Prometheus text format 0.0.4) with a small,
fixed set of counters, gauges and one histogram, no personal labels, plus a Zabbix 7 template and `docs/ops/metrics.md`.

## Design

- `packages/core/src/metrics/registry.ts`: Counter/Gauge/Histogram over **closed label enumerations**. A label value
  outside its enumeration is folded to `other`; the series count of a metric is bounded by the product of its
  enumerations and checked at construction (`MAX_SERIES_PER_METRIC`).
- `metrics/metrics.ts`: the harness's metric set (`createMetrics`): `plur1bus_rpc_calls_total{method,result}`,
  `plur1bus_turn_duration_seconds{outcome}`, `plur1bus_provider_errors_total{provider,kind}`, process memory,
  `plur1bus_rpc_connections_open`, core/engine readiness, journal backlog, agent count (a number, never names).
- `metrics/http.ts`: `node:http` server bound to a loopback address only; `GET /metrics` only; Bearer token, constant
  time; Host and peer address must be loopback (DNS rebinding); failed-auth lockout; RBAC port `MetricsAccess`
  (scope `metrics.read`), default implementation = one token that grants only that scope.
- `metrics/token.ts`: persistent token in `<home>/state/metrics.token` (a Zabbix macro cannot follow a per-start token).
- Wiring: config `metrics.enabled` (default `false`) and `metrics.port` (default 9464), both `x-restart: core`;
  `RpcServerOptions.onCall` and `RpcServer.connectionCount()` in module-api; `Core.metrics` for later session/provider
  code to record turns and provider errors (no turn loop or provider adapter on main yet).
- `docs/ops/zabbix/plur1bus-template.yaml`, `docs/ops/metrics.md`.

## Tests (first)

Format (a strict exposition parser in the test), label cardinality, auth (missing/wrong/other path/other method/
non-loopback host), no secret in output, wiring through `onCall`, template structure.
