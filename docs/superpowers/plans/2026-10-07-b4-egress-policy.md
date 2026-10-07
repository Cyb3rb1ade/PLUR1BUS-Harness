# B4 — Egress policy (allowlist) for outgoing requests

Date: 2026-10-07. Branch `claude/b4-egress-policy`. Builds on the SSRF guard of M2 (`packages/core/src/tools/web/{ip,guard,http}.ts`, PR #140).

## Problem

The web tools refuse private addresses, but nothing decides *which public destinations* the core may talk to. Every
outgoing feature (web tools today, providers, catalogue, channels later) needs one central, configurable, fail-closed
decision, and the owner needs to see the policy in force.

## Design

`packages/core/src/egress/` (library, no I/O at import):

- `policy.ts` — `compileEgressPolicy(config)`: host allowlist (exact name, `*.suffix`, `*` = any *name*; IP literals only by
  exact entry), port allowlist (default `[443]`), `allowLoopback` (default `false`). Invalid entries never widen: the
  result is deny-all plus `errors[]`.
- `gate.ts` — `createGate(policy, hooks)`: `beforeResolve(url)` (scheme, port, host allowlist; runs *before* DNS so a denied
  name is never looked up) and `afterResolve(url, pin)` (http only to a loopback pin; a name that resolves to loopback is
  refused unless the host is itself a loopback spelling).
- `service.ts` — `createEgress({ config, resolver })`: `request(url, opts)` (the existing `guardedRequest`, with the gate on every
  hop, so redirects are re-checked and the resolved IP is pinned for the connect), `decide(url)` (dry run, no connect),
  `status()` (policy + decision counters, no URLs).
- `tools/web/http.ts` gets one optional `gate` option (two calls in the hop loop); behaviour without it is unchanged.
- Config: `egress.{allowHosts,allowPorts,allowLoopback}` (`x-restart: live`, `x-tier: advanced`). The policy is rebuilt from
  the live config on each call.
- RPC `egress.status` (read-only, experimental, since 1.5.0) with RBAC action `egress.read` (Owner/Admin), RPC_RULES, policy,
  matrix fixture, guard-test params, `docs/rbac.md`.

Not in this PR: rewiring `web.fetch` / providers onto `createEgress` (the dispatcher is not registered yet); noted as open point.

## Tests first

`packages/core/test/egress/{policy,gate,decide,request,rpc}.test.ts`: IPv4/IPv6 spellings, rebinding with a flipping fake
resolver, redirect to private/metadata/non-allowlisted/other port/http, allowlist hit over a loopback stub server, RPC + RBAC.
