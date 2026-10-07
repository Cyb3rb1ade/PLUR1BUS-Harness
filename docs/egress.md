# Egress policy (B4)

Hand-written. Code: `packages/core/src/egress/`. Plan: `docs/superpowers/plans/2026-10-07-b4-egress-policy.md`.
Built on the SSRF guard in `packages/core/src/tools/web/` (`docs/web-tools.md`).

One central decision for every outgoing request the core makes: **which destinations are reachable at all**
(allowlist), on top of **which addresses are never reachable** (the SSRF ranges). Default deny.

## Configuration (`config.json`, `x-restart: live`, advanced tier)

| Key | Default | Meaning |
|---|---|---|
| `egress.allowHosts` | `[]` | Exact names, `*.suffix` (subdomains of any depth, never the apex), `*` (any **name**), or an exact IP literal (IPv6 in brackets). Empty = nothing is reachable. |
| `egress.allowPorts` | `[443]` | The only destination ports; the scheme's default port is checked like any other. |
| `egress.allowLoopback` | `false` | Plain `http` and loopback targets, only for hosts that are themselves loopback spellings (`localhost`, `127.0.0.0/8`, `::1`) **and** listed in `allowHosts`. |

An invalid entry (bad name, non-canonical IP such as `0x7f.1` or `2130706433`, port outside 1..65535) makes the **whole**
policy deny-all; `egress.status` reports the errors.

## The decision, per hop (first request and every redirect)

1. Scheme: `https` only; `http` only to a loopback host with `allowLoopback`. Everything else is refused.
2. Port in `allowPorts`; host in `allowHosts` (judged on the URL's normalised host: `0x7f.1`, `2130706433`,
   `[::ffff:7f00:1]` are already `127.0.0.1` / the same IPv6 address when the URL is parsed). Refusals here happen
   **before** DNS, so a denied name is never looked up.
3. Resolution: the name is resolved to all its addresses; if **any** is private, loopback, link-local, metadata, ULA, NAT64/6to4 of
   such an address, the hop is refused (`private-address`). Only a loopback-spelled host with `allowLoopback` may reach loopback.
4. The connect uses the one vetted address (pinned `lookup`), so the name is never resolved a second time (no DNS rebinding);
   Host, SNI and certificate checks keep the name.
5. A redirect is a new hop: steps 1–4 run again; at most 10 hops.

## `egress.status` (RPC, experimental, RBAC `egress.read`: Owner/Admin)

Returns the normalised policy (`allowHosts`, `allowPorts`, `allowLoopback`, `valid`, `errors`) and counters of per-hop
decisions (`allowed`, `denied`, `byReason`: `scheme`, `port`, `host-not-allowed`, `loopback`, `private-address`, `invalid-url`).
Never a URL, a path or an address.

## Using it

`createEgress({ config: () => cfg.egress, resolver? })` returns `request(url, options)` (the guarded client with the gate on
every hop), `decide(url)` (dry run, no connect) and `status()`. The core builds one and answers `egress.status` from it.
`web.fetch` and the provider adapters are **not** rewired onto it in this change (see the PR's open points).
