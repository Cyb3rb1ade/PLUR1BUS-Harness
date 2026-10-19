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
| `egress.allowLoopback` | `false` | Plain `http` and loopback targets, only for hosts that are themselves loopback spellings (`localhost`, `127.0.0.0/8`, `::1`) **and** listed in `allowHosts` by name or address (the wildcard `*` does not list them). |

An invalid entry (bad name, non-canonical IP such as `0x7f.1` or `2130706433`, port outside 1..65535) makes the **whole**
policy deny-all; `egress.status` reports the errors.

## The decision, per hop (first request and every redirect)

0. Refused outright: embedded credentials (`user:pw@`), an empty host label (`example.com..`); a malformed list in the configuration counts as an error (deny-all), it never throws.
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

### POST-capable `request` (harness-owned provider calls)

`request(url, { method, headers, body, maxRequestBytes, maxBytes, timeoutMs, userAgent })` is the same guarded client
with a method other than GET, caller headers and a body, so a model API call (embeddings, rerank, chat) can run through
the policy end to end. The gate, the SSRF check and the pinned connect apply exactly as for GET. On top:

- the body is sent with a computed `content-length` (never chunked) and capped by `maxRequestBytes` (default 20 MB,
  `too-large` before any I/O); a GET or HEAD with a body is refused;
- connection-level headers (`host`, `content-length`, `transfer-encoding`, `connection`, `te`, `trailer`, `upgrade`,
  `keep-alive`, `expect`, `cookie`, `accept-encoding`, any `proxy-*`) are set by the client and cannot be given; a header
  name that is not a token or a value with CR, LF or NUL is refused (`invalid-url`);
- a request with a body, a method other than GET/HEAD or caller headers **never follows a redirect**: the 3xx answer is
  returned unread, so a body or an `Authorization` header never reaches a host it was not addressed to.

`a2a/push.ts` and `auth/http.ts` still carry their own POST; moving them onto this variant is a follow-up (both have
their own redirect and response handling with tests that would need to move with them).

## Engine HTTP and secrets (contract 1.15)

The core supplies `HostServices.fetch` and `HostServices.secrets.resolve` to the memory engine. Every engine HTTP
request goes through `egress.request`: embeddings, HTTP reranking, engine LLM calls, webhooks and model downloads.
The live policy and DNS pinning apply on every request and every permitted redirect. A provider request with caller
headers or a body returns redirects without following them, so credentials and memory text stay with their destination.
There is no global-fetch fallback in the harness port. The core requires engine contract 1.15 or later.

The fetch bridge accepts URL strings, URLs and Requests and returns a WHATWG Response, including status/error JSON,
headers, final URL and a decoded body stream. Downloads stream under backpressure rather than accumulating the artifact
in RAM. Request bodies are capped at 20 MiB, decoded responses at 2 GiB, with a five-minute transport deadline; caller
cancellation and the engine's own shorter budgets still apply. Existing web tools keep their buffered 20-MB default.

`checkEngineEgress` still gives preflight feedback before construction. A refusal stops startup with `E_DENIED`,
`reason: egress-denied`; an offline name or an engine LLM feature using an unknown default endpoint is reported at
startup and remains subject to the per-request gate when it actually connects.

Provider configuration can name `apiKeyRef`, a harness secret-store name, or `apiKeyEnv`, an environment variable name.
The engine prefers `apiKeyRef` and fails closed if it cannot resolve it. The host resolves it with an audited core lease
and revokes that lease immediately after copying the value into memory; it never exports the value to an environment
variable or config file. The engine caches credentials for at most 60 seconds and invalidates them on HTTP 401/403.

HTTP reranking supports `cohere`, `jina`, `voyage` and `remote`; `protocol` is `cohere`, `jina`, `voyage` or `tei`.
`remote` requires `baseUrl` and permits a keyless self-hosted service. The other providers retain their engine presets;
an explicit `baseUrl` overrides the preset and needs its own endpoint-bound privacy acknowledgment. Remote reranking
remains mandatory, with `fallbackProvider: "disabled"`: a failed call never silently changes the selected model.

## Model calls and `privacy.localOnly`

`privacy.localOnly` (Settings > Privacy, installation-wide, with `agents.<id>.privacy.localOnly` as a per-agent override in
both directions) decides **which model providers** may be used: only loopback (`localhost`, `127.0.0.0/8`, `::1`) or an
exact origin listed in `privacy.localEndpoints` (a self-hosted Ollama or vLLM server in the home network; a LAN address
is never local by itself). It is enforced where a provider is chosen: chat and role models (also compaction summaries),
model discovery (cloud models are listed with `locked: "local-only"`, not hidden), voice (local tier only, no cloud adapter
is built), media generation, the media index and captioning, and the memory engine (embedding, reranker, engine LLM
features). The memory engine and the media index are shared by all agents, so they stay local while the installation or
**any** agent is local-only. A refused provider fails with `E_DENIED`, `reason: local-only`, and a hint to the switch;
it is never replaced by another model. Egress still applies on top: a local endpoint must also be reachable under
`egress.*` (loopback needs `allowLoopback`).

Web tools (`web.fetch`, `web.search`) are not model calls: `privacy.localOnly` does not block them; egress alone governs
them. The doctor report (`doctor.report`, check `privacy.local-only`) fails while the switch is on and a cloud model is
still configured, and lists what will be refused.
