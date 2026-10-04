# Provisional desktop harness contract

This is the **test-only, provisional** contract consumed by the desktop shell. It is not
the real harness API. M3 will supply the production names and semantics; the shell
client and fixed exec argv are the mapping points. The mock deliberately serves
only the surfaces below.

## HTTP and session

The bundled origin is `http://127.0.0.1:<port>`; remote origins use HTTPS.
All request JSON objects are closed. Device bearer values are generated at run time,
returned only by redemption, stored by the mock as SHA-256 hashes, and never given
to the SPA. A revoked device receives `401` with `schema:error/1`, `code:E_AUTH`,
`reason:device-revoked`.

| Method and route | Authorization | Request / response |
|---|---|---|
| `GET /api/v1/meta` | none | `{apiVersion:"1.0.0",version,installationId,capabilities:["desktop.sessionTicket","host.bridge"]}` |
| `POST /api/v1/devices/redeem` | none, 10 calls/minute | `{code,name,kind:"desktop"}` → `{deviceId,token}`; code is `XXXX-XXXX`, expires after 1 hour, single use |
| `POST /api/v1/auth/session-ticket` | Bearer, `ui.session` | `{ticket,expiresAt}`; 60 seconds, single use, at most five open per device |
| `POST /api/v1/auth/ticket/redeem` | none | `{ticket}` → `{csrf}` plus session cookie (`HttpOnly; SameSite=Lax`, no expiry attribute); bad ticket → `401 E_AUTH ticket-invalid` |
| `GET /api/v1/auth/whoami` | Bearer or mock SPA session cookie | `{userId,deviceId,scopes}` |
| `GET /events?topics=harness.status[,approval]` | Bearer, `events.read` | SSE `harness.status` with `{state,secrets,reason?}` and provisional `approval.requested`/`approval.resolved`, event IDs and `Last-Event-ID` replay; `topics` filters both initial/replayed and live events; control can drop the stream |
| `GET /ws` | Bearer, `bridge.serve` | WebSocket JSON text messages, maximum 64 KiB per frame/message |
| `GET /api/v1/approvals?state=pending` | Bearer, `approvals.decide` | Provisional synthetic pending D109 §5 cards in `{schema:"approvals.list/1",approvals:[...]}` |
| `POST /api/v1/approvals/{id}/decision` | Bearer, `approvals.decide`; debug opt-in | `{decision:"approve"|"deny",scope:"once"|"task"|"session"|"always"}` → resolved card; default is `403` |

Device scopes: `ui.session`, `events.read`, `bridge.serve`, and provisional
`approvals.decide`. `bridge.serve` and the `host.keyUnlock` grant are for bundled
devices only; the native fallback pair argv gets neither. Unknown pairing scopes
are rejected. `bridge.hello {capabilities}` gets `bridge.welcome {accepted}`;
`host.keyUnlock` is the only provisional capability. A real shell replies to
`bridge.call {callId,capability,op,args}` with `bridge.result {callId,ok,value?,error?}`.
Only `provision` and `get` are valid key unlock operations. No generic command
execution is part of the bridge. A call is sent only to a connected client that
accepted `host.keyUnlock` in its hello.

Native attach discovery is represented by a synthetic `<state root>/run/api.json`
with `{url,pid,instanceId,installationId,apiVersion}`. The fixture writer takes
a caller-owned temporary directory, writes only its `run/api.json`, and requires
a loopback-bound mock. It never reads or writes `run/*.token`; WP4 implements the
native shell reader and stale/non-loopback rejection.

The placeholder SPA at `/` and `/auth/ticket` redeems the fragment ticket,
removes the fragment with `replaceState`, displays `whoami`, and calls Tauri
`shell_info` only when `window.__TAURI_INTERNALS__.invoke` is present. A plain
browser skips that bridge call. WP4 adds the shell connection flow; WP5 adds
the hosted SPA window and native `shell_info` command/capability. WP2 tests
only the conditional SPA-side call.

## Fixed container exec documents

Every supported command emits one JSON document with a top-level `schema`; errors
emit `error/1`. `fake-plur1bus` matches these exact argv shapes and rejects unknown
argv. Test scenario files can override a command with a matching `argv`, `exit`,
and `stdout` document, but cannot introduce a new `fake-plur1bus` argv shape.
`fake-container` has scenario responses only and keeps its separate test-case
flexibility.

| argv | Schema |
|---|---|
| `user create --owner --json` | `user.create/1` |
| `device pair --json --kind desktop --name <name> --scope ui.session,events.read,bridge.serve --grant host.keyUnlock` | `device.pair/1` |
| `device pair --json --kind desktop --name <name>` | `device.pair/1` (native fallback) |
| `device revoke <deviceId> --json` | `device.revoke/1` |
| `daemon status --json` | `daemon.status/1` fixture |
| `1staid check --json` | `1staid.check/1` fixture |
| `state snapshot --src <src> --dst <dst> --json` | `state.snapshot/1` |
| `state verify --dir <dir> --json` | `state.verify/1` |
| `state restore --src <src> --dst <dst> --json` | `state.restore/1` |
| `admin migrate --from <from> --to <to> --yes --json` | `admin.migrate/1` |
| `admin smoke --json` | `admin.smoke/1` |

The mock control can change status/secrets/optional reason, reported installation ID/API version,
revoke a device, drop SSE, and inject a failure for `snapshot`, `verify`,
`restore`, `migrate`, or `smoke`. It can create synthetic approvals and enable or
disable key unlock. Approval **decisions** require a debug build and explicit
`PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1`; the default remains
read-only. The test-only `POST /__test/pair`,
`/__test/revoke`, and `/__test/failure` routes connect the separate fake CLI to
the server. They are absent unless `--test-control` or
`PLUR1BUS_DESKTOP_TEST_CONTROL=1` is set. These routes must never be exposed by a
production harness. Even when opted in, they reject non-loopback connection
peers, including callers through a published stub-image port. Missing peer
metadata is refused as well. `pnpm tauri dev`
opts in for its local fake CLI; the stub image does not enable them by default.
The standalone binary binds loopback by default and refuses any non-loopback
`--bind`; only `0.0.0.0` is allowed when `PLUR1BUS_CONTAINER=1` explicitly marks
the test stub container.

State under `--state-dir` contains installation ID, device token hashes and
metadata, session/ticket hashes, and the secret-store `provisioned` flag. Raw
bearer values, tickets, session cookies, and key bytes are never serialized.
The state file is written owner-only (`0600`) on POSIX. Tickets use 32 random
bytes. Scope, capability, route, and fixed exec-argv names are shared by the
shell, mock and fake binaries through the independent `desktop-contract` crate.

## WP4 pairing proof and trust (provisional until M3)

`desktop-contract::trust` is the shared source for paths, DTOs, limits, encodings,
code alphabet and cryptographic parameters. JSON objects are closed. Fields called
pins below are canonical `sha256:` plus 43 unpadded base64url characters encoding
SHA-256 of the complete DER certificate. CA pins hash the root DER, leaf pins hash
the leaf DER. Generated certificates/private keys stay in test memory.

| Route | Trust / authorization | Wire contract |
|---|---|---|
| `POST /api/v1/devices/pair-proof` | nonce only; temporary untrusted TLS, no code or bearer | `{clientNonce}` → `{salt,serverNonce,proof,caPin:null|string}`; request/response bounded to 4096 bytes |
| `GET /api/v1/devices/ca?pin=sha256%3A…` | public DER; accepted only after exact SHA-256 match | `application/pkix-cert`; maximum 16384 bytes; selector allows current/next/retired CA refetch after restart |
| `GET /api/v1/devices/trust` | verified current/next TLS plus device bearer, `ui.session` | `{certPin,caPin,nextCertPin,nextCaPin}`; explicit null for absent fields, at most one current and one next type |
| `POST /api/v1/devices/trust/ack` | verified TLS plus device bearer, `ui.session` | `{nextCertPin,nextCaPin}` must exactly match staged trust; → `{ok:true}` |
| `GET /events?topics=devices.trust.next` | verified TLS plus device bearer, `events.read` | `devices.trust.next` event with the same trust document; SSE reader is bounded to 65536 bytes per frame |

Codes have eight uniformly sampled characters from Crockford's 32-character
alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (40 random bits), displayed `XXXX-XXXX`.
The mock replaces its previous **proof offer** when it issues a new code. Since
nonce-only proof requests contain no code identifier, only the newest outstanding
proof offer is answerable. Other unexpired redemption codes still work over
already-trusted TLS. Concurrent proof offers need an M3 design decision; this is
not a production harness policy. A proof offer expires after one hour; the mock
limits proof attempts to ten per minute per origin and accepts a single active
offer. Production per-source rate limiting remains M3's responsibility.

`K = Argon2id(code, salt)`, version 0x13, memory 65536 KiB, iterations 3, lanes 1,
output 32 bytes. Salt is 16 random bytes; each nonce and HMAC is 32 bytes. All are
canonical unpadded base64url strings on the wire. No server-selected KDF parameters
are accepted, and no phone timing is claimed. HMAC-SHA256 input is the literal
concatenation of canonical UTF-8 strings, without separators or length prefixes:

```
plur1bus-pair-v1 || leafPin || [caPin if present] || normalizedOrigin || clientNonce || serverNonce
```

The prefix/fixed-length fields and `https:` origin make optional CA unambiguous.
The client binds `leafPin` to `reqwest::tls::TlsInfo` on the **proof response's own
TLS connection**, validates TLS CertificateVerify signatures even for bootstrap,
and verifies HMAC in constant time before transmitting the code. Company CA is
then hash-fetched, checked as a valid CA, and used with normal rustls hostname,
chain and leaf-validity checks. There is no OS CA installation or on-disk CA cache.
Production clients have no public accept-invalid-certificate option. Ambient
proxies, redirects and cookie storage are disabled; ordinary HTTP bodies are
bounded to 65536 bytes and requests to ten seconds.

The proxy fetches `/api/v1/meta` once while creating each SPA session and
validates the supported API major, capability and installation identity before
serving browser traffic. The immutable session snapshot is reused for the
session lifetime, so a transient later `/meta` outage cannot turn every browser
request into a 502. A new SPA session repeats the full validation. A new pairing immediately pulls trust, persists both
current and next pins, then acknowledges; every open repeats that sequence.
After the server switches, a response's current trust must match the locally
stored current or previously authenticated next trust. Only then is next promoted.
Both cert→CA and CA→cert work, including after reloading public metadata. Unannounced
changes fail before bearer/code transmission. For initially OS-trusted pairing,
proof is skipped; an authenticated current leaf must equal the served leaf, and
an adopted current CA must validate the actual live origin chain.

WP4 has a bounded authenticated SSE consumer. It treats the event as a wakeup,
re-pulls the authenticated trust route, persists, then acks; event data alone cannot
install pins. WP6 owns the persistent active-connection subscription/reconnect
loop. WP4 does not claim continuously subscribed UI/tray behavior.

`MockHarness::start_tls` takes a runtime-generated `tls::Identity`. `CompanyCa`
issues renewed leaves; `stage_trust` keeps the old identity active and emits SSE;
`switch_trust` swaps listener identity for new connections. Negative-control methods
are in-process test APIs only, not network admin routes. No M3 admin upload API is
implemented. Keys, bearer values and raw HTTP bodies are never request-trace data;
traces contain only route and whether authorization was present.

### WP4 owner corrections: required trust route and transient CA policy

M3 must implement `GET /api/v1/devices/trust` for every desktop-capable origin,
including loopback and OS-trusted origins. A successful empty trust document means
OS trust is current; 404 is not an optional feature negotiation signal. Pairing and
opening require this route before persisting/acknowledging trust.

CA 404/5xx, timeout, oversized or malformed bytes are retryable `trust-unavailable`;
they cannot invalidate a saved pin. A successful bounded response containing a
valid CA certificate with a different SHA-256 hash is a trust mismatch and may
require repair. A malformed successful response supplies no usable cryptographic
proof, reconciling the review's transient-malformed rule with Part B's successful-
proof rule. Real TLS verification rejection still requires repair. The `pin`
query is retained because the harness must distinguish current/next CA objects
while both are staged: it carries only a public digest, never a credential.

Test controls `advertise_os_trust`, `ca_response` and
`set_session_ticket_capability` operate only in the mock process. They inject
OS-current announcements, transport/response failures, and capability removal.

### WP5 provisional browser sessions (not the M3 API)

Ticket redemption retains a session hash, bound device and CSRF hash. The cookie
is HttpOnly, SameSite=Lax, Path=/ and additionally Secure on TLS. Browser whoami,
/events and /ws use that cookie separately from the Rust device bearer path.
Browser WS is an echo fixture and grants no host-bridge capabilities. Existing
device scopes and host.keyUnlock behavior remain unchanged. Revocation also
rejects subsequent browser-session authentication.

POST /api/v1/session/check is a provisional mutation fixture. A valid browser
cookie, exact harness Origin and x-csrf-token are required; wrong or missing
CSRF and foreign Origin return 403. The mock SPA keeps CSRF in renderer memory
and loads /spa.js under script-src self. Missing/replayed/expired tickets
navigate to /auth/ticket-failed. The desktop retries once then serves its error
view. SSE keepalive after 11 seconds proves survival past the API deadline.

M3 must map these cookie, CSRF and live-surface semantics onto its real browser
routes. Session-check, mock SPA and echo WS remain fixtures. No server was
implemented under packages/.

WP5 native-only controls (enabled only by `test_control` and protected by the
existing loopback peer guard) are `/__test/ticket-mode` (force failed browser
redemptions), `/__test/download` (ten MiB of byte 0x5a), and
`/__test/foreign-redirect` (a controlled redirect destination). They are mock
fixtures, never proposed M3 routes. The Rust driver retains credentials only
in memory and counts issued tickets without publishing their values.
