# Egress policy (B4)

Hand-written. Code: `packages/core/src/egress/`. Plan: `docs/superpowers/plans/2026-10-07-b4-egress-policy.md`.
Built on the SSRF guard in `packages/core/src/tools/web/` (`docs/web-tools.md`).

One central decision for every outgoing request the core makes: **which destinations are reachable at all**
(allowlist), on top of **which addresses are never reachable** (the SSRF ranges). Ordinary requests default to deny;
local model artifact downloads have the named catalog exception described below.

## Configuration (`config.json`, `x-restart: live`, advanced tier)

| Key | Default | Meaning |
|---|---|---|
| `egress.allowHosts` | `[]` | Exact names, `*.suffix` (subdomains of any depth, never the apex), `*` (any **name**), or an exact IP literal (IPv6 in brackets). Empty = ordinary requests denied. |
| `egress.modelDownloads.enabled` | `true` | Allow the named model catalog exception; disabling it denies artifact requests, including under an ordinary wildcard policy. |
| `egress.modelDownloads.allowHosts` | `["huggingface.co", "us.aws.cdn.hf.co"]` | Exact catalog origin and observed CDN host. Removing either blocks the corresponding hop; no wildcard is accepted. |
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
- a request with a body, a method other than GET/HEAD or sensitive caller headers **never follows a redirect**: the 3xx
  answer is returned unread. The engine port opts into redirecting credential-free GET/HEAD requests carrying only
  `Accept`, `User-Agent` or `Range`; `Authorization`, API-key headers and bodies never reach another destination.

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

## Read-only SSH/SFTP import

SSH uses the same compiled central `egress.allowHosts` and `egress.allowPorts`
rules before DNS. The source endpoint must match the host allowlist and its TCP
port must be allowed; SSH's default 22 is **not** in the default `[443]`. Creating
an Owner-managed `import.ssh.connections` entry does not grant central egress or
silently add a wildcard. The Owner explicitly approves the exact host and port
through the configuration path. A denied or invalid policy causes no resolution,
worker launch, authentication or private-key lease. Removing that permission
denies further source operations.

The central host and port lists form a global cross-product: adding port 22 also
permits it for the other already allowed hosts. Review both lists when approving
SSH; a named connection narrows which endpoint this import feature uses.

After the central check, the shared guarded resolver validates every DNS answer.
A connection's Owner-only `allowPrivate` can permit RFC1918, loopback and ULA
addresses for that particular source (including a Docker host); it never bypasses
the host/port policy or admits link-local/metadata destinations. It does not change
ordinary HTTP/HTTPS address rules. Mixed safe/unsafe answers fail closed. The
native helper receives one vetted numeric IP and never resolves the hostname again.

SSH then uses its exact confirmed SHA256 host-key pin, rather than TLS. Initial
probing performs only the handshake; later connections verify the pin before
leasing the private Ed25519 key, authenticating or reading source files. A host-key
change, expired trust probe, missing key or untrusted helper fails closed. The
read-only filesystem port exposes no shell or writes. Key/connection changes and
role revocation invalidate active access. Lifecycle audit records contain only
connection IDs, outcomes and fixed reasons, never key values or file contents.
SSH audits are separate from the HTTP per-hop `egress.status` counters.

Implementation: `import/ssh-service.ts`, `import/ssh-egress.ts`, the existing
`egress/policy.ts`/SSRF resolver, and `@plur1bus/remote-fs`. The exact reviewed native
dependency exception is recorded in
[the SSH dependency decision](ops/m-russh-dependency-decision.md). See
[the import workflow](import.md#13-supervised-import-and-remote-sources-m-v2) for
source roots, snapshots and maintenance; source credentials never enter ordinary RPC.

## Engine HTTP and secrets (contract 1.15)

The core supplies `HostServices.fetch` and `HostServices.secrets.resolve` to the memory engine. Every engine HTTP
request goes through `egress.request`: embeddings, HTTP reranking, engine LLM calls, webhooks and model downloads.
The live policy and DNS pinning apply on every request and every permitted redirect. A provider request with caller
headers or a body returns redirects without following them, so credentials and memory text stay with their destination.
There is no global-fetch fallback in the harness port. The core requires engine contract 1.15 or later.

### Named model catalog exception

The pinned local embedder and reranker download artifacts from `huggingface.co` and follow redirects to
`us.aws.cdn.hf.co`. Only credential-free HTTPS GET/HEAD requests to repository `/owner/model/resolve/revision/file`
artifact paths qualify for `egress.modelDownloads`; provider inference, request bodies, URL credentials, arbitrary
queries and other origins use the ordinary policy. Supported artifact suffixes are `json`, `onnx`, `onnx_data`,
`txt` and `model`. The model list is authoritative for every redirect, so ordinary `allowHosts: ["*"]` cannot bypass
a removed catalog host. DNS pinning, private-address refusal, allowed ports, redirect limits and decoded-stream
size/deadline limits remain in force. A newly introduced CDN host needs an explicit code/schema/test change.

These are local model weights, not a remote inference provider: `privacy.localOnly` still forbids remote inference.
For an offline installation, disable model downloads and pre-provision the pinned, hash-validated cache. Live policy
changes affect the next request; every redirect uses that request's policy. Safe host/code diagnostics identify a denial without logging signed CDN URLs,
credentials or provider payloads. A cold engine reports `provider-failed`; `admin.engine.test` also identifies the
port error class, including `egress`.

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
is never local by itself). It is enforced where a provider is chosen: chat and role models (also compaction summaries), the model probe `models.test` (a cloud model is refused before a provider is built, no request is sent),
model discovery (cloud models are listed with `locked: "local-only"`, not hidden, and their catalogs are not scanned: no request, no credential lookup; local endpoints keep being scanned), voice (local tier only, no cloud adapter
is built), media generation, the media index and captioning, the memory engine (embedding, reranker, engine LLM
features) and the embedding adapters package (`deps.policy`, see docs/embedding-adapters.md). The memory engine and the media index are shared by all agents, so they stay local while the installation or
**any** agent is local-only. A refused provider fails with `E_DENIED`, `reason: local-only`, and a hint to the switch;
it is never replaced by another model. Egress still applies on top: a local endpoint must also be reachable under
`egress.*` (loopback needs `allowLoopback`).

Web tools (`web.fetch`, `web.search`) are not model calls: `privacy.localOnly` does not block them; egress alone governs
them. The doctor report (`doctor.report`, check `privacy.local-only`) fails while the switch is on and a cloud model is
still configured, and lists what will be refused.


## Live local-only policy (II)

`privacy.localOnly`, `agents.<id>.privacy.localOnly` and `privacy.localEndpoints` have restart class `live`.
Chat and role adapters check the current policy before every new model request, including the next tool round
and fallback attempt. An already admitted response may finish. File-only Core reads a changed valid config before
the next admission; supervisor snapshots and pushes apply directly. Doctor overlays privacy on its cached report.

A single explicit `true` agent override pins the shared embedding, reranker and engine LLM features for all agents.
Cloud engine configurations are rejected before writing (`E_DENIED`, `local-only-shared-engine`, naming the agents).
Changing the installation flag cannot remove another agent's pin. An explicit `false` override affects only that agent's
individual model calls. Model server origins require an exact scheme, host and port match; allowing a home server
does not exempt it from egress, SSRF, TLS, license or function-specific privacy acknowledgment checks.

The running Engine keeps its startup endpoints. A private `run/engine-models.json` inventory (Core PID and instance,
role and origin only, no credentials) prevents a proposed local engine configuration from disguising a still-bound
remote engine. First migrate/change engine models with local-only off, wait for the existing Core restart job, then
enable local-only. An older running Core without a verifiable inventory must be restarted first.

**Remaining hot-reconfiguration gap:** contract 1.17 includes the 1.15 host fetch/secret ports, now wired to the live
request gate. The Engine still has no public hot-reconfiguration port. An unsafe
live transition is rejected with a restart hint; automatic engine-only restart / `restartPending` for that rejected
transition is not implemented. No switch is reported as enabled while an uncontrolled remote Engine keeps running.
Reembed usage remains an estimated token count until that port exposes actual provider usage; its desired
behavior has a todo test.
