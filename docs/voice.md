# D110 voice broker and client delivery

[OpenAI auth](openai-auth.md) describes credentials and billing; the [D110 design](superpowers/specs/2026-09-30-openai-auth-design.md) amends ADR-005 and D45. Core registers the services additively. Trusted in-process surfaces obtain `VoiceRuntime` through `CompositionOptions.onVoice` or `TurnComposition.voice`. No voice RPC, CLI or Web UI is added.

## Two separate paths

| Path | Client receives | Provider credential |
|---|---|---|
| Realtime, direct paired desktop WebRTC | Short-lived provider ephemeral secret via `RealtimeService` | API key/federated bearer stays in Core |
| GPT-Live, `gpt-live-1` | Random Harness handle, then Core PCM relay | Credential and provider session remain in Core |

Plan OAuth cannot parent either voice path. `providers.openaiVoice` selects a trusted server-side `secretRef` or external `federated` supplier. The runtime checks model availability with that parent. Egress decisions pin HTTP/WebSocket connections while retaining the original TLS name and refusing redirects. Regional hosts follow the configured parent. Realtime WebRTC uses multipart `/v1/realtime/calls`; Live uses `/v1/live/sessions` and its separate sideband. See [OpenAI Live](https://developers.openai.com/api/docs/guides/live) and [Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live).

## GPT-Live handle and relay

`live.issue(request, client)` returns `{ handle: Sensitive, expiresAt }`. The caller's authenticated server-side context contains person, chat session, model, unique connection surface (`desktop:<binding>` or `web:<binding>`) and T2/T3 trust. These are trusted adapter facts, never request/body assertions.

The handle is 256 random bits, unrelated to any provider secret. Only its SHA-256 digest and bound server-side entry are retained. `auth.openai.liveHandleTtlSeconds` defaults to 60 seconds until redemption, with a 600-second ceiling. `live.redeem(handle, client)` checks all bindings and claims the entry before asynchronous provider/budget work. Foreign attempts cannot consume the owner's handle. Errors are `handle-unknown`, `handle-binding`, `handle-expired`, `handle-replay` and `handle-revoked`; refusal events contain the fixed code, never the handle or credential.

Redemption opens a WebSocket-backed provider session and sideband only after budget admission. It returns a Core `MediaChannel`, with `send(Uint8Array)` and `close()`. Audio is PCM16 mono at 24 kHz: Core encodes client frames as `session.input_audio.append` and decodes only `session.output_audio.delta` into client audio. Control events, vendor errors, session IDs, credentials and arbitrary vendor payloads are never forwarded to the client. This is a relay through Core; browser WebRTC capture/playback and media resampling are follow-up surface work.

`live.endSession(session, client)` revokes both unused handles and active channels for that authenticated person/session. It requests graceful provider closure, records the final usage, closes primary and sideband connections, aborts active delegated turns and releases budget reservations. A missing final event after five seconds causes a hard close and an explicit final-usage-unconfirmed diagnostic; the latest observed usage is retained. Revocation while opening closes any channel that finishes late. Provider/session/accounting failures close media; `sweep` expires unused entries and enforces session lifetime. Core schedules sweep and disposes the services at shutdown.

Live defaults to client delegation. Input transcript deltas remain in bounded memory; `session.delegation.created` starts the existing turn provider under the authenticated person. Its tools still traverse D109 and its model calls still traverse budget admission. Results return as bounded `session.commentary.append` with the original delegation ID. Backend work does not block media/usage event processing. No direct sideband tool bypass exists; unsupported direct tool calls are denied. Responses-delegation configuration and richer transcript/task revision handling remain explicit integration work.

## Realtime ephemeral delivery

`realtime.mint(request, client)` is restricted to the authenticated paired desktop WebRTC path, T2+. The returned `EphemeralDelivery` serializes only redacted metadata. `deliver(client)` checks person/session/model/connection surface and extracts the secret once. TTL is 60 seconds by default, vendor minimum 10 and harness maximum 600. Expired/consumed/revoked delivery is refused. `realtime.endSession(client)` revokes local delivery entries and closes attached sessions.

The server-authenticated connection notification calls `broker.attachEphemeral(reservation, callId)`. A client-supplied call ID must never be trusted as ownership proof. Local single-use delivery is not a claim that OpenAI cryptographically binds a secret to one model or prevents reuse after extraction. Provider-side ephemeral config can be overridden; short TTL, a dedicated project/model allow-list/spend cap and server sideband enforcement remain required by D110. No provider ephemeral-secret revocation endpoint is invented.

## Budgets and lifecycle

Every opening/mint uses the existing `CallBudget.checkBeforeCall`. Voice seconds and provider-reported cost figures are recorded separately in `state/voice-usage.sqlite`; `auth.openai.voiceDailySeconds` guards per-person/per-agent daily use. Provider usage updates/final totals are cumulative; backend token events are deltas. Duplicate event IDs are idempotent. Existing hard token/cost limits retain their semantics, including refusal of unpriced models. Vendor pricing is not inferred from duration.

At a ceiling, the broker stops the provider and records a notice. An overbudget opening calls the existing D109 evaluator and records a `money.spend` request with its existing once/T3 requirements, then remains refused. Approval alone neither raises a limit nor authorizes a paid fallback. Spoken/media notice UX and configuring more detailed monthly/install voice ceilings require the follow-up surface/setup integration.

`auth.openai.voiceCapacity` defaults conservatively to one session and must not exceed the vendor tier. SIP is refused as `transport-unavailable`; browser media capture, SIP hooks, monthly/install voice settings, price/capacity discovery and provider-native platform acceptance remain follow-ups.

## Validation

Tests use only synthetic fixtures and loopback HTTP/WebSocket servers. They cover budget denial before provider I/O, a real PCM relay, no provider credential/session in client results/errors/logs, TTL, replay, foreign person/session/model/surface, revocation during opening and active relay, and Realtime delivery binding. These results do not establish real OpenAI or microphone/device acceptance.


## Voice V3 settings backend

The existing browser contract is canonical: profile names are `fast | quality`,
and the RPCs are `voice.language.list|get|set`,
`voice.realtime.profile.get|set`, and `voice.metrics.get`. There is no parallel
`accurate` profile or alias API. Additive RPCs are `voice.status`,
`voice.agent.override.get|set|clear`, `voice.models.list|install`, and
`voice.realtime.start|stop`. The browser imports generated RPC types without
loading the Node schema runtime.

| Language | fast TTS | quality TTS |
|---|---|---|
| de | Piper Thorsten low (CC0-1.0) | Kokoro (Apache-2.0) |
| en | Kokoro (Apache-2.0), owner decision pending | Kokoro (Apache-2.0) |

`EN_FAST_TTS_MODEL` in `packages/core/src/voice/v3-catalog.ts` is the single
named English fast choice. These selections also replace the legacy V2 runtime
preselection. The existing verified model catalog supplies ASR/VAD packages,
checksums and licence metadata. Research-only voices are listed for deliberate
installation and never preselected. Voice packages with unverified download
metadata remain unavailable. The runtime's native/platform and language quality
acceptance still requires actual devices and models; package installation alone
is not an inference test.

`voice.language.set` downloads the selected ASR/TTS/VAD packages with the existing
bounded, resumable, SHA-256-verified installer. Before any download, all required
licences must appear as exact `modelId@licenceId` entries in `acceptLicences`.
`voice.models.install` instead accepts one `modelId` and an explicit
`licenseAccepted: true`. Research-only, non-commercial and unconfirmed licences
are gated even if the model was previously installed. Installing a model never
selects it. Downloads emit private `voice.download.progress` events with the UI's
`modelId`, `receivedBytes`, `totalBytes`, `done`, and optional `error` fields.
Accepted licences used by language selection are saved by model and licence.

Configuration lives under `voice.v3`: language, selected profile per language,
TTS profile defaults, `budgetMs` (default 1000), and `realtime`. The eight feature
switches are `autoRecall`, `promptEnrichment`, `reranker`, `decisionService`,
`postTurnRefine`, `memoryWrite`, `compaction`, and `toolSchemas`. Modes match the
UI (`on`, `deferred`, `off`; `toolSchemas` also supports `reduced`). Each active
switch contributes `maxMs` to the total, including deferred work; absent `maxMs`
uses 50 ms. Disabled switches contribute zero. A zero budget suppresses pipeline
work. The first overflowing switch in this stable order is returned in
`E_VOICE_BUDGET`; rejected writes do not change configuration. Installation
changes also validate every inherited agent profile. Reranker and post-turn
refinement continue to report `effective: engine-fixed`, because the pinned
engine cannot change these options per call. No engine dependency is changed.

`agents.<id>.voice` is a sparse override, using the same inheritance convention
as agent memory settings: unset keys inherit. `voice.agent.override.set` replaces
the sparse object, and `.clear` restores inheritance. The existing UI's
`voice.realtime.profile.*` and `voice.language.*` accept `agentId` and use this
same storage. Writes use the supervisor's configuration transaction; a core
running without a supervisor answers `E_NOT_AVAILABLE reason=no-supervisor`.

`voice.realtime.start` takes `agentId` and the person's existing `chatSessionId`;
it returns a new voice `sessionId`. The chat must belong to that person and agent.
It opens the existing V2 talk pipeline through an explicitly supplied trusted
`CompositionOptions.voiceAudio` transport. `voice.v3.channel(sessionId,
connectionId)` gives that host adapter the PCM input handle. No transport yields
`E_VOICE_UNAVAILABLE reason=no-audio-transport`. A session stops through
`voice.realtime.stop`, connection loss, or core shutdown. State and transcript
events have an explicit originating connection audience and require named
subscriptions. Foreign persons and agent subscriptions never receive them.
The general connection/person audience API is described in
[the event reference](reference/events.md#private-audiences).

All five human roles may read. Owner/Admin may write; agent principals may read
only their own `voice.agent.override.get`. Voice token scopes narrow these rights
with `voice.read`, `voice.write`, or `voice.override.read` (and `voice.*`). All
seven write methods are permanently blocked in WebMCP, including explicit
`include` requests. Metrics expose aggregate bounded recorder measurements,
not transcript text, with the elapsed process observation window.

The Sprache setup step already existed in the browser's eight-step standalone /
seven-step bundled wizard. The Core now mirrors that exact step model and validates
its language selection using the canonical RPC. No ninth step was added.

CLI: `plur1bus voice status`, `voice profile list|get|set`,
`voice features get|set`, `voice override get|set|clear`, and
`voice models list|install`, all with global `--json`. `features set --value`
takes the complete realtime profile as JSON; `override set --value` takes a sparse
JSON object. Example: `plur1bus --json voice profile set --language en --profile quality`.
Explicit model licence confirmation uses `voice models install MODEL --license-accepted`;
profile installation uses repeated `--accept-licence MODEL_ID@LICENCE_ID`.
