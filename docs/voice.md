# D110 voice session broker

`packages/core/src/voice/index.ts` exports the in-process `VoiceBroker` and its ports. This PR adds no RPC, CLI, UI, network listener or production credential wiring.

## Session creation

The caller supplies an authenticated server-derived principal and surface, agent, provider, discovered model, parent profile (`api_key` or `federated_token`) and region (`global`, `us`, `eu`). Never accept these identity/trust values directly from an untrusted request body. Plan profiles cannot parent voice credentials.

`create(request)` reserves budget before asking for a project credential. Realtime defaults to the unified WebRTC `/v1/realtime/calls` broker; GPT-Live uses `/v1/live/sessions` with `gpt-live-1`, `delegation.type: client` and `store:false`. Responses delegation is explicit per agent. The selected model/delegation is fixed for the session. The public result contains only `sessionId` and optional `sdpAnswer`.

WebSocket creation uses the server-only WebSocket port; GPT-Live sends `session.start` first. That port relays audio/events inside the core. No bearer reaches a client. Realtime WebRTC encoding (multipart SDP + session JSON), actual socket transport and vendor-event normalization are HttpPort/sideband responsibilities to wire in the next integration PR.

The broker attaches a regional server sideband to Live `/{id}/attach` or Realtime `?call_id=`. Instructions are enforced there and tracing is off. Tool calls go through the D109 policy port before execution; duplicate call IDs do not execute twice. Live client delegation calls the agent backend through a policy port so memory, routing and tools stay in the harness. Raw tools/agent content is never sent to an audit sink.

## Direct desktop Realtime

`mint(request)` is an explicit alternative for an authenticated paired desktop using WebRTC, T2+. It refuses T1, unauthenticated surfaces, web/channel/group delivery and GPT-Live. The TTL is 60 seconds by default, with the harness cap of 600 seconds and the vendor floor of 10 seconds. Each call makes one secret for one reservation. A secret's `consume()` method is single-use and refuses expired delivery. JSON/inspection are redacted; there is no persistence API for ephemeral values.

The server-authenticated connection notification calls `attachEphemeral(reservation, callId)` exactly once. The integration must authenticate vendor call ownership before invoking it; never trust a client-submitted call ID. An expired unused reservation is released by `sweep`. Secret-attached config is **not a security boundary**. Require sideband enforcement plus a dedicated voice project with model allow-list and spend cap. The explicit delivery getter is the only boundary allowed to return an ephemeral value to the paired desktop.

## Budgets and lifecycle

The `VoiceBudgetPort` owns durable, atomic per-agent/per-user/per-installation day and month limits, minutes and cost ceilings, and concurrent-session reservations. The broker checks `reserve` before every create/mint and `record` on every usage event; at a ceiling it closes the provider session and sends a spoken and written notice. A denied start produces a D109 `money.spend` request (`once`, T3), then remains refused until the approval workflow applies a permitted budget change.

Live usage updates and final figures are cumulative: the broker subtracts the last provider totals. Delegated backend token/cost events and Realtime `response.done` are deltas. Both feed the same budget port, which prices from the setup-provided price table; prices are never guessed here. Normalization into `VoiceEvent` is a transport-port obligation. Rate-limit updates are accepted through the same path. Duplicate event IDs are idempotent. Accounting failure stops the session rather than allowing unmetered spend.

Capacity comes from the vendor tier at setup and applies to active and pending sessions. Realtime sessions close at the 60-minute cap. Runtime integration must call `sweep()` periodically and `dispose()` at shutdown. Closing the provider comes before budget release; if that fails the session is retained for retry.

## Safety and follow-ups

All project credentials stay behind the credential/transport ports. `OpenAI-Safety-Identifier` hashes the principal. Audit records contain fixed kinds, hashed agent/session references, surface and TTL, never token values. Backend exceptions become constant typed errors.

Follow-ups: `voice.session.create` RPC and schemas, CLI, real auth/secret/egress/refresh/budget/D109 wiring, vendor payload normalization and audio relay, Desktop WebRTC client, SIP incoming hooks and session accept/reject/refer/hangup with M3/D1, EU Modified Retention setup confirmation, vendor capacity/price discovery, budget approval UX, and the prescribed UI texts on the web. SIP currently returns `transport-unavailable` explicitly.

Tests: `packages/core/test/voice/broker.test.ts`; synthetic dispatcher in `packages/core/test/fixtures/openai/server.ts`. Acceptance 16 covers credential-free SDP, mint TTL/trust, policy tools, budget closure and redaction. No ordinary test opens a network connection.

Local verification (2026-10-08): all voice tests passed as part of the 43-test D110 suite, including early sideband events, concurrent ephemeral claims, per-agent budget isolation and provider/backend accounting. No real vendor sessions were created.
