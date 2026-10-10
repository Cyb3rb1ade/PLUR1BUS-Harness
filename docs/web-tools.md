# Web tools: `web.fetch` and `web.search`

Hand-written. Code: `packages/core/src/tools/web/`, `packages/core/src/tools/repair.ts`. Spec: D94, D95, D97 item 1, D103
(`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`); acceptance: `docs/milestones.md` §M2 items 12–14.
The tools are library code with dispatcher-ready specs (`createWebTools`); they are not yet registered with a dispatcher.

## SSRF guard (every hop)

A request is allowed only if the host is positively public:

1. URL must be `http:`/`https:` without credentials.
2. An IP literal is classified directly, in every spelling a C resolver accepts (`2130706433`, `017700000001`,
   `0x7f.1`, `127.1`, `[::ffff:127.0.0.1]`); a name is resolved to **all** its addresses and refused if **any** is not
   public. `localhost` and `*.localhost` never reach DNS.
3. Refused ranges: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.0.0/24`,
   `192.168/16`, `198.18/15`, documentation nets, multicast, `240/4`; IPv6 anything outside `2000::/3`, ULA `fc00::/7`,
   link-local, `2001::/23`, `2001:db8::/32`; IPv4-mapped, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are judged
   by the IPv4 address they carry.
4. The TCP connect uses the **vetted address** (a pinned `lookup`), so the name is never resolved a second time; the
   Host header, SNI and certificate check keep the name.
5. A redirect is a new request: scheme, credentials, resolution and the range check run again. At most 10 hops.

The only exception is the explicit `allowPrivate` CIDR list in `createWebFetch` (D94: e.g. a tailnet `100.64.0.0/10`).
Default: empty. An invalid entry throws at construction.

## Limits

20 MB of **decompressed** body (gzip/deflate/br bombs are cut), 30 s for the whole call including redirects and the body,
content-type allowlist (HTML, plain text, Markdown, JSON, XML, CSV; everything else is `unsupported-type`, checked before
the body is read), 200 000 extracted tokens (`too-large`, never silently truncated). Long documents are returned in
chunks of `maxTokens` (default 6 000) with a table of contents and a `cursor`; `section` jumps to one section. Cursors
live in memory for 15 minutes and are bound to the agent.

## Failures

Every failure is a structured `isError` result `{ code, message, hint, userAction, status?, retryAfterSeconds? }`.
Codes: `invalid-arguments`, `invalid-url`, `private-address`, `egress-denied`, `not-found`, `gone`, `auth-required`,
`paywall`, `rate-limited`, `timeout`, `too-large`, `unsupported-type`, `tls-error`, `needs-render`,
`too-many-redirects`, `robots-disallowed`, `network-error`, `http-error`, `cursor-expired`, `no-provider`,
`provider-failed`, `internal-error`. Unexpected exceptions never leak their message.

## robots.txt and User-Agent

A single page asked for does not consult `robots.txt`. `crawl: true` (links beyond the page asked for) fetches and
caches `robots.txt` per host (404 = allow, 5xx/unreachable = disallow, RFC 9309 matching), honours `Crawl-delay` and paces
to at most 1 request/s per host. The User-Agent is `PLUR1BUS/<version> (+https://plur1bus.app/bot)`.

## `web.search`

`SearchProvider { id, search(query, signal) }` is the whole contract. The one provider that ships is SearXNG
(`tools/web/searxng.ts`, JSON API, wired by `sidecars/web-search.ts`, see [sidecars.md](sidecars.md)); the tool is
registered per turn only when that backend exists, as capability `net.fetch` (D109, a network read, allowed by default).
The sidecar is the only destination and it comes from configuration, not from the model. `createWebSearch` takes the
fallback order (frozen at creation: a provider is chosen per agent session, never switched mid-session, ADR-010 R4),
skips failing providers with a `skipped` note (ids and reasons only, never error text), and normalises results:
http(s) only, de-duplicated by URL, markup and control characters stripped, lengths capped, unknown fields dropped, the
`site` filter re-applied. The answer carries `provenance: { source: "web.search", provider, retrievedAt, trust: "untrusted" }`.

## Repair hook and capability index

`callWithRepair(tool, args, { repair })` validates against the tool's schema, does not execute an invalid call, offers
**one** repair round through the hook, and otherwise returns `tool-call-invalid` (D97). `WEB_CAPABILITIES` holds the two
D103 index rows (`kind: tool`, `sideEffects: external`, `effect: external` for D109, categories `web.browse` /
`web.research`, a content-hash `version`).

## Tests

`cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/tools/**/*.test.ts`.
Only loopback stub servers and stub resolvers are used. The TLS tests need `openssl` and skip without it.
