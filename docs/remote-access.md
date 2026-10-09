# Remote access

`packages/remote-access` (`@plur1bus/remote-access`) is the library behind remote access to the harness: **exposure modes**, **TLS material**, **pairing with certificate pinning**, **pair-proof for typed codes**, **trust rollover**, the **client-subnet allow-list**, the **security notice** and the **1staid warnings**.

It is a library with injected ports (clock, exec, secret store). It opens no listener, serves no route and reads no configuration file. Wiring it into `packages/api` and the web UI is a follow-up (see [Follow-ups](#follow-ups)). Normative sources: `docs/milestones.md` §M3 (*Remote access*), the desktop spec (`docs/superpowers/specs/2026-09-27-desktop-app-design.md` §13.5 C8, C9 and §6.2), ADR-004 (binding, TLS) and ADR-007 (devices, pairing).

The API is **never public**: there is no Funnel at any level. The configuration parser rejects the word at any depth, no plan or command contains it, and `1staid` warns if Tailscale reports one active.

## Exposure modes

`remote.publish` is one of `local | tailnet | network`, default `tailnet`.

| Mode | What listens | Who can reach it | Pairing pins |
|---|---|---|---|
| `local` | plain http on `127.0.0.1` | this machine | none |
| `tailnet` | plain http on `127.0.0.1`, published by `tailscale serve` (HTTPS on the tailnet name → the loopback port) | the tailnet; until the machine has joined one, no further than `local` | none (valid `*.ts.net` certificate) |
| `network` | loopback http as above **plus** a TLS-only listener on the chosen interface | LAN, VPN, MPLS; optionally limited to client subnets | `certPin` (self-signed) or `caPin` (company CA) |

`planListeners(config, env)` turns a validated configuration and a description of the host into the sockets to open. Unsafe combinations are refused with a stable code each, not bound quietly:

| Code | Refused because |
|---|---|
| `network-needs-tls` | no usable server certificate and key |
| `network-needs-notice-confirmation` | the security notice was not confirmed |
| `network-no-port` / `network-port-clash` | no port for the TLS listener, or it equals the loopback API port |
| `network-bind-loopback` | binding a loopback address reaches nobody |
| `network-bind-unknown-interface` | the address is not one of this machine's |
| `network-public-interface-unconfirmed` | a publicly routable interface (specific, or included by the wildcard) without `bind.allowPublicInterface` |

`bind-ignored` and `allow-subnets-not-enforced` are warnings: at `local` and `tailnet` every request arrives on loopback, so a subnet rule cannot be enforced there and the plan says so. `tailnet-not-joined` warns that `tailnet` currently behaves like `local`. In container mode the harness cannot see real client addresses behind a userland proxy or VM NAT; the desktop app refuses a non-empty allow-list there (spec §6.2).

Configuration (`parseRemoteConfig`): `publish`, `tls` (`self-signed` default | `company-ca`), `bind { address, port, allowPublicInterface }`, `allowSubnets` (the spec text calls it `allowCidrs`; both are accepted, giving both is an error). Host names are not accepted as `bind.address`. Mapping these onto the harness's real config keys (`remote.tls.certFile`, `remote.tls.keyRef`, `remote.tls.caFile`, …) belongs to the API integration.

### Tailscale

`detectTailscale(exec)` finds the CLI (PATH, the macOS app bundle, Homebrew, Windows) and reports `not-installed | daemon-down | needs-login | stopped | running`, with tailnet name and MagicDNS name. `planServe` builds `tailscale serve --bg --https=443 http://127.0.0.1:<port>`; `runServePlan` runs a plan only after `assertNoFunnel` passed on every command. `detectServe` reads `tailscale serve status --json` and reports an active Funnel. The tsnet variant (in-process) is a follow-up; the exec port is how tests feed fake output.

## TLS

### Self-signed (default for `network`)

`generateSelfSigned` creates an EC P-256 key and an X.509 v3 server certificate (SAN: host names, IPs, the MagicDNS name; default 365 days, maximum 825; valid from five minutes before `now` for clock skew). The private key goes to the **secret port** and nowhere else: the result carries the certificate, the key reference and the pins; `loadTlsMaterial` hands the key to `tls.createServer` in memory. A hygiene test keeps `fs`, `child_process`, `http(s)` and OpenSSL out of the sources.

**Why an in-package DER writer.** `node:crypto` can parse and sign but cannot create certificates, the package may not add runtime dependencies and may not shell out to OpenSSL. `src/der.ts` and `src/x509.ts` (about 250 lines) build the certificate and sign it with `node:crypto`. They are checked against independent parsers: node's `X509Certificate` and OpenSSL inside `node:tls` (the end-to-end tests handshake, verify chains and check host names).

Fingerprints are `sha256:<base64url of the 32 hash bytes>`. `certPin` hashes the DER certificate, `spkiPin` the SubjectPublicKeyInfo. Parsing is strict and comparison constant-time; an unparseable pin never matches.

### Company CA

`importCompanyCa` validates an upload as one unit **before** the key reaches the secret port: the key matches the first certificate (and is not passphrase-protected), the SAN covers every published host name and address, nothing is expired or not yet valid, the chain is complete and signature-checked up to the root, the root CA argument is a self-signed CA. All findings come back together (`key-mismatch`, `san-missing`, `expired`, `chain-incomplete`, `ca-invalid`, `ca-expired`, `leaf-not-first`, …). On success the result carries the normalised chain, the **root CA PEM and its `caPin`**: the harness holds the root and hands it to devices through pairing, so no device installs a CA file. Without a root CA the import succeeds with a `no-root-ca` warning (clients then rely on the OS trust store). A client trusts the CA only for this connection's origin.

PEM only. PKCS#12 needs a parser `node:crypto` does not have (follow-up).

## Pairing

`buildPairingOffer` issues a one-time code and returns the offer, the deep link and QR data:

```text
plur1bus://pair?origin=<origin>[&origin=…]&code=XXXX-XXXX&exp=<epoch s>[&pin=sha256:…|&ca=sha256:…][&nextpin=…][&nextca=…]&tag=<tag>
```

- **Origins** (one to three) follow spec §6.2: `https://host[:port]`, or http on loopback; no userinfo, path, query or fragment; IDN as punycode.
- **Pins follow the exposure level:** `pin` exactly for `network` + `self-signed`; `ca` exactly for `network` + `company-ca` when the root CA is held; none at `tailnet` and `local`. While a trust change is staged, new offers also carry `nextpin` / `nextca`.
- **Code:** `XXXX-XXXX`, 8 characters from a 32-character alphabet without `I O 0 1` (40 bits), single use, one hour, at most three pending. The store keeps only a salt, the Argon2id key and a SHA-256 verifier; never the code, and nothing is persisted (a restart ends open codes).
- **Tag:** an HMAC over every field, truncated to 128 bits. Clients cannot verify it and nothing claims they can: a link altered in transit is defeated by the channel the person trusts. The tag lets the harness recognise its own, unmodified offer when a client echoes it back.
- **QR:** `qrData(link)` returns the exact text plus byte mode, error correction M and the capacity (2331 bytes). This package does not draw a QR matrix: that needs Reed–Solomon coding, mask selection and format bits, which the web UI and the desktop app render with the QR libraries they need for scanning anyway.

`parsePairingLink` is strict about scheme, action, unknown and duplicate parameters, code, expiry, pins and origins.

### Pinning in a client

Self-signed: connect with `rejectUnauthorized: false`, then compare the leaf's pin (`verifySocket`). Company CA: connect with `ca: [caPem]` and the host name; `socket.authorized` proves the chain, so a leaf renewed by the same CA needs nothing. The client fetches the CA certificate from `GET /api/v1/devices/ca` and accepts it only if `pinsEqual(certPin(pem), caPin)`.

### pair-proof (typed codes)

A typed code cannot carry a fingerprint, so before sending the code the client has the harness prove the certificate it sees (spec §6.2):

1. The client records `fp`, the SHA-256 of the leaf it was shown, and sends `{ clientNonce }` without the code.
2. `handlePairProof` answers `{ salt, serverNonce, proof[, caPin] }` with `proof = HMAC-SHA256(K, label | fp_served | [caPin] | origin | clientNonce | serverNonce)` and `K = Argon2id(code, salt)` (19 MiB, 2 passes, 1 lane; derived once when the code is issued).
3. `verifyPairProof` derives `K` from the typed code and checks the proof against **its own** `fp`. A relaying TLS-inspecting proxy has a different certificate, so the check fails and the code is never sent.

The spec writes the HMAC input as a plain concatenation. Origin and nonces are variable-length, so the concrete encoding length-prefixes them and marks the CA pin with a presence byte. `handlePairProof` is only the handler function: it refuses any body that carries more than `clientNonce`, never consumes a code, rate-limits per source and per open code (HTTP 429 with `retryAfterMs`), and answers 404 `no-open-code` when no pairing is open. The route layer passes `origin` from configuration, not from a raw Host header.

**Brute force.** `PairCodeStore.redeem` does the same work (one Argon2id per open code, one dummy when none is open) and constant-time comparisons whatever the input looks like. A source with five failures in ten minutes is locked for 15 minutes (refused before any work). Every failure counts against every open code, and a code is burned after ten, so the 40 bits cannot be searched from any number of sources. The price: an attacker with several addresses can burn open codes (a denial of service on pairing, not a bypass); the owner issues a new code.

## Trust rollover

Any change of what a client pins — a new self-signed certificate, `self-signed` ↔ `company-ca`, a new company CA — is staged, announced, then switched (`stageTrust`, `ackTrust`, `switchTrust`, `cancelTrust`):

- `none → staged → switched → none`; cancel goes `staged → none`. Both anchors are accepted while staged; new offers carry both.
- The harness announces the next trust only over each device's current, authenticated connection (`GET /api/v1/devices/trust`, event `devices.trust.next`); a device confirms with its token (`trust/ack`); `trustProgress` gives "4 of 6 devices" and who is missing.
- `switchTrust` makes the next current and returns exactly the devices that never confirmed: only those pair again.
- **Device side** (`receiveAnnouncement`, `evaluateConnection`, `promote`): a next pin is accepted only from an authenticated request on a connection the *current* trust verified; both fingerprints are accepted during the transition; the next is promoted when the harness serves it; a device that missed the change gets `certificate-changed`. A CA anchor compares the chain's root, so a renewed leaf from the same CA needs nothing. A stolen device token pushes trust to nobody.
- `serializeTrust` / `parseTrust` persist the harness state with strict validation.

## Allow-list, notice and 1staid

- `compileAllowlist(cidrs)`: IPv4 and IPv6 CIDRs, IPv4-mapped clients (`::ffff:a.b.c.d` matches an IPv4 rule), zone ids; empty means any client; an address that does not parse never passes a non-empty list. `admitSocket` is the gate for a listener's raw `connection` event, before the TLS handshake. Pairing and sign-in apply either way.
- `securityNoticeItems`, `confirmSecurityNotice`, `noticeNeeded`: enabling `network` shows the notice (reach, pairing, TLS inspection, allow-list, never public) and needs an explicit confirmation by a named person; the record is `{ by, at, version }`.
- `firstAidChecks(config, state)` returns `warn` entries with stable ids: `remote.network-on` (for as long as network is on), `remote.notice-unconfirmed`, `remote.tls-not-ready`, `remote.cert-expiring` (30 days) / `remote.cert-expired`, `remote.allowlist-empty`, and `remote.funnel-active` at **every** level.

## Spec coverage

| Spec statement (M3 *Remote access*, desktop spec C8/C9/§6.2) | Implemented in the package | Test | Follow-up in API / UI |
|---|---|---|---|
| `remote.publish` = `local \| tailnet \| network`, default `tailnet` | `exposure.ts` `parseRemoteConfig`, `DEFAULT_REMOTE_CONFIG` | `exposure.test` | API reads the keys and applies the plan |
| `tailnet`: tsnet or `tailscale serve`, valid certificate, tailnet only; until joined = `local` | `tailscale.ts` (detect, serve plan), `planListeners` (`tailnet-not-joined`) | `tailscale.test`, `exposure.test` | API runs the serve plan; tsnet in-process variant |
| `network`: LAN/MPLS/VPN, TLS mandatory, TLS-only listener on the chosen interface | `planListeners` (refusal matrix, public-interface confirmation) | `exposure.test` | API opens the listener; DS16 container publishing (D2) |
| `remote.tls` = `self-signed` (default): key and certificate generated, key in the secret store, never exported | `selfsigned.ts`, `secrets.ts` (secret port) | `selfsigned.test`, `hygiene.test` | wire ADR-005 secret store; generate on first enable |
| Certificate SHA-256 in the pairing payload (QR, deep link); clients pin, no manual check, no TOFU | `fingerprint.ts`, `pairing.ts` (`certPin`, link, `qrData`) | `pairing.test`, `pinning-e2e.test` | offer endpoint/CLI; QR rendering in SPA and app; desktop and mobile clients pin |
| `company-ca`: chain + key upload; key matches, chain complete, SAN covers host, not expired | `company-ca.ts` | `company-ca.test`, `pinning-e2e.test` | admin upload route; PKCS#12; config mapping `certFile`/`keyRef` |
| Root CA held on the harness and handed to devices through pairing (`caPin`, `GET /api/v1/devices/ca`) | `importCompanyCa` returns `caPem` + `caPin`; `pairing.ts` carries `caPin` | `company-ca.test`, `pairing.test` | `GET /api/v1/devices/ca` route; `caFile` storage |
| `POST /api/v1/devices/pair-proof` for typed codes; rate-limited per source and per open code | `pair-proof.ts` handler + client check; `pair-code.ts`, `rate-limit.ts` | `pair-proof.test`, `pair-bruteforce.test`, `pinning-e2e.test` | route, OpenAPI/RPC schema entry (not touched here) |
| Typed code `XXXX-XXXX`, one use, about one hour (C10); hashed storage | `pair-code.ts` | `pair-code.test` | link to the device-pairing store of ADR-007 / PR #143 |
| Pairing card hidden at `local` | `planListeners` states the mode; nothing else | `exposure.test` | SPA decides from the mode |
| Trust rollover: stage, announce over the trusted connection, switch; only devices that missed it pair again | `trust-rollover.ts` | `trust-rollover.test`, `pinning-e2e.test` | `GET /api/v1/devices/trust`, `trust/ack`, SSE `devices.trust.next`, persistence |
| Optional client-subnet allow-list | `security.ts` `compileAllowlist`, `admitSocket`; plan carries the rules | `security.test`, `pinning-e2e.test` | listener integration; container caveat refusal in the app |
| Security notice with explicit confirmation | `security.ts` `confirmSecurityNotice`, `securityNoticeItems`, `noticeNeeded` | `security.test` | dialog in Devices & Remote; persist the record; audit entry |
| `1staid check` warns while `network` is on | `firstAidChecks` | `security.test` | register with `1staid check` |
| Never public: no Funnel | `parseRemoteConfig`, `assertNoFunnel`, `detectServe`, `firstAidChecks` | `exposure.test`, `tailscale.test`, `security.test` | API never configures a funnel |
| Desktop spec acceptance 8a (pinned self-signed remote) | library half: pair-proof, pinning, refusal of changed or unpinned certificates | `pinning-e2e.test`, `pair-proof.test` | the app's proxy and rustls client |

## Follow-ups

- **Listener integration in `packages/api`:** read the `remote.*` keys, call `planListeners`, bind the loopback listener and the TLS listener, `admitSocket` on `connection`, run the Tailscale serve plan, feed `1staid`.
- **Routes `/api/v1/devices/*`:** `pair` offer, `redeem`, `pair-proof`, `ca`, `trust`, `trust/ack`, the SSE event `devices.trust.next`, RPC schema, OpenAPI and RBAC entries (all outside this package's scope).
- **Persistence:** the trust state (`serializeTrust`), the offer-tag key and the notice confirmation need a home in the core's store.
- **Web UI:** the pairing card (code, QR, deep link), the certificate and root CA upload, the rollover progress, the security notice, the allow-list editor.
- **Desktop app:** pairing from the deep link or a typed code with pair-proof, the pinned rustls client, the SPA proxy, *Certificate changed* and *Company CA not known* states.
- **Mobile clients:** the same pairing and pinning rules.
- **Open points:** PKCS#12 import; tsnet inside the harness; with several open codes `handlePairProof` answers for the newest, so a client holding an older code has to retry after it expires (the spec's single-answer shape leaves this open); a UI-facing text for each `firstAidChecks` and notice code (they are stable keys for translation).
