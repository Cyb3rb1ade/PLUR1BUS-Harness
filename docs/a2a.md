# A2A server (inbound, loopback): Agent Card and tasks

Status: A2A1 (2026-10-07). Authority: ADR-008 §A2A and its 2026-09-27 amendment, ADR-007. Code:
`packages/core/src/a2a/`. Plan: `docs/superpowers/plans/2026-10-07-a2a1.md`.

Inbound only: this slice makes no outbound call (no card fetch, no client). The server is **off by default**: nothing in the
core starts it. A host builds `createA2aServer({ peers, agents, provider })` (loopback, node:http) or mounts
`createA2aHandler(...).handle` on its own listener. No RPC method and no config key is added.

## Endpoints (per agent, `/a2a/<agentId>/`)

| Request | Needs | Answer |
|---|---|---|
| `GET /a2a/<agent>/.well-known/agent-card.json` | `card.read` | the Agent Card (closed key set, A2A 0.3 shape, `capabilities.streaming/pushNotifications = false`) |
| `POST /a2a/<agent>/` `message/send` | `task.send` | a task; `configuration.blocking: true` waits for the terminal state |
| `POST /a2a/<agent>/` `tasks/get` | `task.read` | the task (`historyLength` optional) |
| `POST /a2a/<agent>/` `tasks/cancel` | `task.cancel` | the canceled task, or `TaskNotCancelable` (-32002) when already terminal |

Every other path, including a root `/.well-known/agent-card.json`, is 404. Streaming, push-notification and resubscribe
methods answer `UnsupportedOperation` (-32004).

## The `a2a-peer` principal

An external caller is an `a2a-peer`, never a harness user and never a `Role` (`rbac/policy.ts` does not mention it). It
authenticates with `Authorization: Bearer <key>`; the operator stores only `keySha256` (hex SHA-256). Rights are explicit:
`grants: { <agentId>: [<action>…] }`. Deny by default: an agent that is not opted in (`A2aAgentInfo.optIn`), not granted to the
peer, or an action not listed is refused, and an unknown / not-exposed / not-granted agent is the same 404 (no existence
oracle); a missing action on a granted agent is 403 (HTTP) / `-32600 forbidden` (JSON-RPC). Tasks are private to the peer
and agent that created them (another peer gets `TaskNotFound`). The peer table is validated at start: a typo throws.

## Limits (`A2aLimits`, defaults)

Body 1 MiB (enforced while streaming, 413), message text 64 KiB, 16 parts, 60 requests/min per peer, 240/min per remote
address, 10 failed authentications/min per address (then 429 before any key is compared), 8 live tasks per peer, 1000
stored tasks, terminal tasks kept 1 h, reply timeout 120 s, history 20. No batches. Loopback bind only; the Host header
must be one the server listens on.

## Task lifecycle

`submitted → working → completed | failed | canceled`. The runner drives the `ChatProvider` seam with an empty memory
block: a peer gets **no memory access** (no recall, no capture). Only the answer text leaves; tool events and provider error
text never do. Cancel aborts the provider's signal and does not wait for a provider that ignores it.

## Audit

`a2a.unauthenticated`, `a2a.denied`, `a2a.rate-limited`, `a2a.too-large`, `a2a.task.created|finished|canceled`, with actor
`{ user: "a2a-peer:<id>" | "anonymous", host: "a2a" }`; never keys or message text.
