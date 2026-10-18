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

The A2A push delivery (`a2a/push.ts`) and the OAuth token POST (`auth/http.ts`) send through this variant and nothing else:
neither file opens a socket or calls `fetch` (`test/egress/post-paths.test.ts` guards that statically). Pinning, the
request and response caps, the deadline, the no-redirect rule for a request with a body or caller headers and the
decision counters therefore live here only.

- **Push** sends `POST` with `discardBody: true`: only status and `Location` are read, so a large answer from the receiver
  cannot make an accepted delivery look failed. The dispatcher keeps what is specific to A2A: it judges each hop with
  `decide`, follows a 3xx itself (at most `maxRedirects`), drops the token and bearer credentials when the origin changes,
  retries with backoff and abandons a POST after `postTimeoutMs` (default 15 s; the egress call itself is bounded at 60 s).
- **OAuth token POST** sends the form with `errorBodyBytes` equal to its 64 KiB cap (an error answer carries the OAuth
  error code), one deadline of `timeoutMs` (default 30 s) over the whole call, and refuses every 3xx (`redirect_refused`)
  so the form never leaves the host it was addressed to. A refusal by the gate, the SSRF check or the URL rules is
  `egress_denied`, a timeout, connection or TLS failure is `transient`, a body over the cap or an unreadable
  `Content-Encoding` is `invalid_response`; no text of the failure is kept.

`discardBody` (any `request` call): the response body is never read, whatever its size or encoding, and `body` comes back
empty; status and headers are returned as usual.

## Engine model endpoints at start

The pinned memory engine has no fetch port yet, so its own model calls (a remote embedding, the Cohere reranker, an engine
LLM feature with its own `baseUrl`) cannot run through `request`. Until it has one, the core judges every such endpoint
with `decide(url)` before it builds the engine (`checkEngineEgress` in `engine-config.ts`). A refusal stops the engine
start with `E_DENIED`, `reason: egress-denied`, naming the role and the origin (never a path). A name that does not
resolve at start (offline, `not-found`) is logged, not refused; an engine feature that names a key but no `baseUrl`
calls its provider's default endpoint, which cannot be judged here and is logged.

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
