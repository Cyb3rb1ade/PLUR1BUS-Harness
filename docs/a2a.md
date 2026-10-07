# A2A server (inbound, loopback)

Status: inbound A2A Protocol **0.3.0** (https://a2a-protocol.org/v0.3.0/specification/). Authority: ADR-008 §A2A and its 2026-09-27 amendment, ADR-007. Code: `packages/core/src/a2a/`.

Inbound only: this slice makes no outbound A2A call (no card fetch, no client of a foreign agent). The server is **off by default**: nothing in the core starts it. A host builds `createA2aServer({ peers, agents, provider })` (loopback, `node:http`) or mounts `createA2aHandler(...).handle` on its own listener. No RPC method and no config key is added.

The JSON-RPC method and field names follow the 0.3.0 specification (dotted names, kebab-case task states, `kind` discriminators). This is not the later 1.x JSON camelCase rename.

## Activation

```ts
import { createA2aServer, hashKey } from "@plur1bus/core"; // or a relative import of packages/core/src/a2a/

const server = createA2aServer({
  peers: [{ id: "peer-a", keySha256: hashKey(issuedKey), grants: { bernd: ["card.read", "task.send", "task.read", "task.cancel", "task.push"] } }],
  agents: (id) => id === "bernd" ? { optIn: true, displayName: "Bernd" } : undefined,
  provider: () => chatProvider,          // ChatProvider seam (A2A1)
  // turns: sessionPort,                 // optional: bind contextId → harness SessionStore / TurnRunner
  // egress,                             // optional: admit push webhook URLs (SSRF)
  // verifyBearer,                       // optional: replace SHA-256 peer lookup
  // defaultAgentId: "bernd",            // optional: serve GET /.well-known/agent-card.json
});
const { url } = await server.listen();   // binds 127.0.0.1 (or ::1 / 127.x); any other host is refused
```

To drive the harness session turn-loop instead of the ChatProvider seam, pass `turns` from `createSessionTurnPort` / `openA2aSessionBackend`. Session kind is `direct` (there is no `a2a` kind on `SESSION_KINDS`; that is a follow-up).

## Agent Card

Served at `GET /a2a/<agent>/.well-known/agent-card.json` (the path relative to the card's own `url`). `GET /.well-known/agent-card.json` is 404 unless `defaultAgentId` is set.

Closed key set, A2A 0.3.0 shape:

| Field | Source |
|---|---|
| `protocolVersion` | `0.3.0` |
| `name` / `description` | `A2aAgentInfo.displayName` / `.description` (control characters stripped) |
| `url` | `{advertisedBaseUrl}/a2a/<agent>/` |
| `preferredTransport` | `JSONRPC` |
| `version` | host-supplied (default `0.1.0`) |
| `capabilities.streaming` / `pushNotifications` | `features` (default both `true`); `stateTransitionHistory` is always `false` |
| `defaultInputModes` / `defaultOutputModes` | agent info, else `["text/plain"]` |
| `skills` | agent info (fallback skill `chat`) |
| `securitySchemes.peerKey` | HTTP bearer |
| `security` | `[{ peerKey: [] }]` |

The card is content-free: no workspace paths, model names, memory, or provider ids.

## Supported methods

| Request | Grant | Answer |
|---|---|---|
| `GET /a2a/<agent>/.well-known/agent-card.json` | `card.read` | Agent Card |
| `POST message/send` | `task.send` | a `Task`; `configuration.blocking: true` waits until the turn leaves `working` (terminal or `input-required` / `auth-required`) |
| `POST message/stream` | `task.send` | SSE (`text/event-stream`): `Task`, `status-update`, `artifact-update` (`append` / `lastChunk`), final `status-update` |
| `POST tasks/get` | `task.read` | the task (`historyLength` optional) |
| `POST tasks/cancel` | `task.cancel` | the canceled task, or `TaskNotCancelable` (-32002) |
| `POST tasks/resubscribe` | `task.read` | SSE from the current snapshot, then live events. Disconnecting does **not** cancel the task |
| `POST tasks/pushNotificationConfig/set\|get\|list\|delete` | `task.push` | webhook config for that task |

Every other path is 404. Unknown JSON-RPC methods are `-32601`. Batches are refused. JSON-RPC notifications (no `id`) are refused.

## Authentication

An external caller is an `a2a-peer`, never a harness user and never a `Role`. It authenticates with `Authorization: Bearer <key>`.

Default: the operator stores only `keySha256` (hex SHA-256); `resolvePeer` compares in constant time. Optionally inject `verifyBearer(token)` to replace that lookup (still Bearer, still the scheme declared on the card). A missing or invalid token is **401** with `WWW-Authenticate: Bearer` and **never starts a turn**.

Rights are explicit: `grants: { <agentId>: [<action>…] }` with `card.read`, `task.send`, `task.read`, `task.cancel`, `task.push`. Deny by default. An unknown / not-exposed / not-granted agent is the same 404 (no existence oracle); a missing action on a granted agent is 403 (HTTP) / `-32600 forbidden` (JSON-RPC). Tasks are private to the peer and agent that created them.

## Task lifecycle

`submitted → working → input-required | auth-required → completed | failed | canceled | rejected`.

`message/send` always returns a `Task` (not a bare `Message`). `contextId` maps onto one harness session per peer+agent. Repeating the same `messageId` is idempotent. A follow-up `message.taskId` is accepted only while the task is `input-required` or `auth-required`.

Cancel aborts the turn's `AbortSignal` (and `TurnRunner.cancel` when a session port is wired). Artifacts are the turn's text reply as `parts` (`kind: "text"`). Incoming parts: `text`, `file` (`bytes`/`data` or `uri` — a `uri` is stored, never fetched), `data`. Unknown kinds are `ContentTypeNotSupported` (-32005).

The store is **in-memory**: live cap per peer, stored cap, TTL on terminal tasks. A persistent store is a follow-up.

## Streaming

`message/stream` and `tasks/resubscribe` use SSE. Each `data:` field is a JSON-RPC 2.0 response whose `result` is a `Task`, `TaskStatusUpdateEvent` (`kind: "status-update"`, `final: true` on the last event) or `TaskArtifactUpdateEvent` (`kind: "artifact-update"`, `append` / `lastChunk`). The HTTP adapter writes chunked `text/event-stream` and does not set `Content-Length`. Closing the stream does not cancel the task; `tasks/resubscribe` continues from the current status.

## Push notifications

`tasks/pushNotificationConfig/set|get|list|delete`. Delivery is HTTP POST of the Task JSON to the configured URL, with `X-A2A-Notification-Token` when `token` is set and `Authorization: Bearer …` when `authentication.schemes` includes `bearer`.

The target URL is admitted through **egress** (`egress.decide`): default deny, SSRF (no private / loopback / metadata addresses, also after redirect). Each redirect hop is re-checked. Retry with exponential backoff, abort after `pushMaxAttempts` (default 3). Delivery failures never fail the task. `egress.request` is GET-only; the POST lives in `packages/core/src/a2a/push.ts` after `decide()`.

Without an egress policy (or a test `pushTransport`) a set is `invalid params` / `push-url-denied`. `capabilities.pushNotifications: false` makes the methods return `PushNotificationNotSupported` (-32003).

## Errors

JSON-RPC: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal.

A2A 0.3: `-32001` TaskNotFound, `-32002` TaskNotCancelable, `-32003` PushNotificationNotSupported, `-32004` UnsupportedOperation, `-32005` ContentTypeNotSupported, `-32006` InvalidAgentResponse. `-32000` is the live/stored task cap.

## Limits (`A2aLimits`, defaults)

Body 1 MiB (enforced while streaming, 413), message text 64 KiB, file part 256 KiB, data part 64 KiB, 16 parts, 60 requests/min per peer, 240/min per remote address, 10 failed authentications/min per address (then 429 before any key is compared), 8 live tasks per peer, 8 live streams per peer, 1000 stored tasks, terminal tasks kept 1 h, reply timeout 120 s, history 20, push 3 attempts.

**Loopback bind only.** The Host header must be one the server listens on (DNS-rebinding guard). Binding `0.0.0.0` / a public address is refused. TLS-only exposure beyond loopback is a later slice.

## Audit

`a2a.unauthenticated`, `a2a.denied`, `a2a.rate-limited`, `a2a.too-large`, `a2a.task.created|finished|canceled`, with actor `{ user: "a2a-peer:<id>" | "anonymous", host: "a2a" }`; never keys or message text.

## Follow-ups

- **Outbound A2A** — the harness calling a foreign agent (card fetch, client, TCK against someone else's server). Explicitly out of this PR.
- **Persistent task store** — survive a core restart; the in-memory cap+TTL store does not.
- **D109 rights** — bind `a2a-peer` actions to the permission/approval evaluator; today grants are the A2A peer table only.
- **`packages/api` exposure** — serve A2A next to the harness HTTP API rather than as a separate loopback listener.
- **Dedicated session kind `a2a`** — today the adapter uses `direct`.
- **GET-only `egress.request`** — push POST is implemented inside `a2a/push.ts`; promoting POST to the egress client is a later change.
