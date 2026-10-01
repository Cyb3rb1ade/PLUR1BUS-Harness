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
| `GET /events?topics=harness.status` | Bearer, `events.read` | SSE `harness.status` with `{state,secrets}` and an event ID; control can drop the stream |
| `GET /ws` | Bearer, `bridge.serve` | WebSocket JSON text messages, maximum 64 KiB per frame/message |

Device scopes: `ui.session`, `events.read`, `bridge.serve`. The latter is for bundled
devices only. `bridge.hello {capabilities}` gets `bridge.welcome {accepted}`;
`host.keyUnlock` is the only provisional capability. A real shell replies to
`bridge.call {callId,capability,op,args}` with `bridge.result {callId,ok,value?,error?}`.
Only `provision` and `get` are valid key unlock operations. No generic command
execution is part of the bridge.

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
and `stdout` document. `fake-container` has scenario responses only.

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

The mock control can change status/secrets, reported installation ID/API version,
revoke a device, drop SSE, and inject a failure for `snapshot`, `verify`,
`restore`, `migrate`, or `smoke`. The test-only `POST /__test/pair`,
`/__test/revoke`, and `/__test/failure` routes connect the separate fake CLI to
the server. These routes must never be exposed by a production harness.

State under `--state-dir` contains installation ID, device token hashes and
metadata, session/ticket hashes, and the secret-store `provisioned` flag. Raw
bearer values, tickets, session cookies, and key bytes are never serialized.
