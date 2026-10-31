# A2A server (inbound, loopback)

Status: inbound A2A Protocol **0.3.0** (https://a2a-protocol.org/v0.3.0/specification/). Authority: ADR-008 §A2A and its 2026-09-27 amendment, ADR-007. Code: `packages/core/src/a2a/`.

The server is **off by default**. A host builds `createA2aServer({ peers, agents, provider })` (loopback, `node:http`) or mounts `createA2aHandler(...).handle` on its own listener. The inbound `a2a`/`a2aServer` settings remain separate from outbound peer trust.

The Core also provides an opt-in outbound client under `a2aClient.*`. An Owner person registers an Ed25519 public key with `a2a.peer.add`, explicitly approves its fingerprint/revision with `a2a.peer.trust`, and assigns `a2a:<id>` to a collaboration project. The existing `consult_agent` and `delegate_task` tools then reach that peer as an external target with `origin: a2a`. Every HTTP hop passes the `network.a2a` ToolDispatcher gate, egress/DNS pinning, local-only privacy and persistent peer/turn budgets. No local agent memory authority is given to the target.

See the [V1 contract and Rust CLI handoff](handoff/2026-10-31-v1-a2a-peer-cli.md) for signatures, TOFU, credential handling, conservative token accounting and transport limits. The proposed `a2a peer` CLI commands are owned by a separate Claude PR.

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

`message/send` always returns a `Task` (not a bare `Message`). `contextId` maps onto one harness session per peer+agent (the ChatProvider port namespaces the session id with peer and agent, so equal `contextId` values of different peers never meet). Repeating the same `messageId` is idempotent. A follow-up `message.taskId` is accepted only while the task is `input-required` or `auth-required`.

Cancel aborts the turn's `AbortSignal` (and `TurnRunner.cancel` when a session port is wired). Artifacts are the turn's text reply as `parts` (`kind: "text"`). Incoming parts: `text`, `file` (`bytes`/`data` or `uri` — a `uri` is stored, never fetched; `bytes` must be canonical base64; control characters in `name`, `mimeType` and `uri` are replaced by spaces), `data`. Unknown kinds are `ContentTypeNotSupported` (-32005).

The store is **in-memory**: live cap per peer, stored cap (shared fairly between peers, see Limits), TTL on terminal tasks, a size cap on each reply and on each task's event log. A persistent store is a follow-up. A task left in `input-required` or `auth-required` for the terminal-task retention time (1 h) is canceled, so an unanswered pause cannot hold a live slot forever.

## Streaming

`message/stream` and `tasks/resubscribe` use SSE. Each `data:` field is a JSON-RPC 2.0 response whose `result` is a `Task`, `TaskStatusUpdateEvent` (`kind: "status-update"`, `final: true` on the last event) or `TaskArtifactUpdateEvent` (`kind: "artifact-update"`, `append` / `lastChunk`). The HTTP adapter writes chunked `text/event-stream` and does not set `Content-Length`. Closing the stream does not cancel the task, but a dropped client connection ends the stream and frees the peer's stream slot; `tasks/resubscribe` continues from the current status.

## Push notifications

`tasks/pushNotificationConfig/set|get|list|delete`. Delivery is HTTP POST of the Task JSON to the configured URL, with `X-A2A-Notification-Token` when `token` is set and `Authorization: Bearer …` when `authentication.schemes` includes `bearer`.

The target URL is admitted through **egress** (`egress.decide`): default deny, SSRF (no private / loopback / metadata addresses, also after redirect). Each redirect hop is re-checked; a redirect to another origin is posted without the token and bearer credentials. A receiver answering 4xx (except 408 and 429) is not retried. Only the status and `Location` of the answer are read. Retry with exponential backoff, abort after `pushMaxAttempts` (default 3). Each POST is abandoned after 15 s without an answer. A task holds at most 8 push configs (replacing one by `id` is always possible). Delivery failures never fail the task. Each hop is sent with the POST-capable `egress.request` (pinned connect, request cap, deadline, no redirect following by the client; see `docs/egress.md`); `packages/core/src/a2a/push.ts` opens no socket of its own. A caller cannot set `Host`, `Content-Length` or `Cookie`.

Without an egress policy (or a test `pushTransport`) a set is `invalid params` / `push-url-denied`. `capabilities.pushNotifications: false` makes the methods return `PushNotificationNotSupported` (-32003).

## Errors

JSON-RPC: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal.

A2A 0.3: `-32001` TaskNotFound, `-32002` TaskNotCancelable, `-32003` PushNotificationNotSupported, `-32004` UnsupportedOperation, `-32005` ContentTypeNotSupported, `-32006` InvalidAgentResponse. `-32000` is the live/stored task cap.

## Limits (`A2aLimits`, defaults)

Body 1 MiB (enforced while streaming, 413), message text 64 KiB, file part 256 KiB, data part 64 KiB, 16 parts, 60 requests/min per peer, 240/min per remote address, 10 failed authentications/min per address (then 429 before any key is compared), 8 live tasks per peer, 8 live streams per peer, 1000 stored tasks, terminal tasks kept 1 h, reply timeout 120 s, history 20, push 3 attempts, reply 256 KiB (`maxReplyBytes`), 1024 stream events per task (`maxEventsPerTask`).

**Reply size.** A reply is kept up to `maxReplyBytes` UTF-8 bytes (cut on a character boundary). Past that the reply ends in `[reply truncated: size limit]`, the turn is cancelled instead of drained, and the task completes normally (it does not fail). The marker is the only way a client learns of the cut; the 120 s reply timeout still applies.

**Event log.** A task's log holds at most `maxEventsPerTask` events. Reply chunks use the log until a reserve for status transitions and the closing events is left; after that the remaining reply text is coalesced into one tail event sent just before the last artifact chunk. A stream or `tasks/resubscribe` replay therefore always carries the whole reply and ends in the final status, but a live subscriber of a very chatty reply sees the last part in one piece rather than chunk by chunk. A task that cycles through `input-required` hundreds of times can lose later non-final status events from the log once it is full; the final status is never dropped.

**Store fairness.** `maxStoredTasksPerPeer` (default: `maxStoredTasks` divided by the number of configured peers, at least 1) is each peer's fair share. While the store has free slots any peer may use them. When it is full, a peer at or above its share is refused (`-32000` task-limit) until retention frees a slot; a peer below its share takes a slot from the peer furthest above its own share by dropping that peer's oldest finished task (a later `tasks/get` for it answers TaskNotFound). Running and paused tasks are never dropped and nobody is pushed below their share, so one peer can no longer lock the others out for the retention time. A store full of one peer's *running* tasks is still bounded only by that peer's live cap (`maxLiveTasksPerPeer`).

**Loopback bind only.** The Host header must be one the server listens on (DNS-rebinding guard). Binding `0.0.0.0` / a public address is refused. TLS-only exposure beyond loopback is a later slice.

## Audit

`a2a.unauthenticated`, `a2a.denied`, `a2a.rate-limited`, `a2a.too-large`, `a2a.task.created|finished|canceled`, with actor `{ user: "a2a-peer:<id>" | "anonymous", host: "a2a" }`; never keys or message text.

## Known limits (Bekannte Grenzen)

- A task's history (messages, not the reply) grows with each `input-required` / `auth-required` follow-up; `tasks/get` and the stream only ever show the last `maxHistoryLength` messages, but all are held until the task expires. Bounded by the peer's request rate and the 1 h retention.
- If more peers hold running tasks than the stored cap can fit (peers x `maxLiveTasksPerPeer` > `maxStoredTasks`), a store full of running tasks refuses everyone; finished tasks are the only thing reclaimed.
- An expiring paused task is only noticed on the next store access, so an open stream on it ends then, not at the exact deadline.

## Follow-ups

- **Outbound A2A** — the harness calling a foreign agent (card fetch, client, TCK against someone else's server). Explicitly out of this PR.
- **Persistent task store** — survive a core restart; the in-memory cap+TTL store does not.
- **D109 rights** — bind `a2a-peer` actions to the permission/approval evaluator; today grants are the A2A peer table only.
- **`packages/api` exposure** — serve A2A next to the harness HTTP API rather than as a separate loopback listener.
- **Dedicated session kind `a2a`** — today the adapter uses `direct`.
