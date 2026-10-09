# Core turn pipeline

The turn composition starts from `core.ts` after global configuration, secrets, egress,
D111 logging, engine, identity and the permission runtime exist. `composition/index.ts`
is the single assembly point for the persistent call budget, auth/refresh/pools,
provider profiles, MCP lifecycle, media, scoped tool registry, prompt builder,
capability index, triage, collaboration and session runner. There is no new RPC,
CLI command, RBAC rule or configuration-schema change.

## AB1 — port inventory and integration work list

Basis: `origin/main` at `5cad68b4`. #288 is open, not merged; D110 and voice are
conditional follow-ups, not implemented or claimed here. Existing milestone status
paragraphs lag several merged libraries; source/API ownership below is authoritative.

| Port / previous follow-up | Implementation owner | Composition connection | Verification / remaining boundary |
|---|---|---|---|
| Session ChatProvider / fake-only bootstrap | providers adapters and `composition/provider.ts` | `openTurnComposition` → `openSessionService` | Core and CLI tests over chat_completions, anthropic_messages, codex_responses, Gemini |
| Identity principal | identity/service, principals | active exact handle link → v2; unlinked CLI retains proved v1 | Actual identity store test; no heuristic linking or owner migration |
| RecallScopeProvider | identity/recall, engine public recall | engineTurnMemory reads v2 ∪ active linked v1, deduplicates identical blocks, applies final cap; writes canonical v2 | Two linked identities; scope revocation remains authoritative. Engine has a single-principal contract, so this adapter does multiple ACL reads, not engine-native RRF |
| Memory recall/capture/checkpoint | session/memory-port, engine | existing engine port with identity scope; exactly one recall **stage**, capture after completion, no incognito capture | Real Core tests inspect recall/capture spans; model acceptance 3a remains a reference-hardware/live gate |
| Triage | triage/index | rule baseline per turn, combined task categories, highest recommended initial class | Wire/integration traces; optional `decision.classProfiles` chooses configured router profiles only at turn boundaries |
| Capability registration / Top-k | toolcall/CapabilityIndex | registry metadata → scoped index → top-k catalogue; dynamic MCP list before selection | Selected `file.read`, MCP and media; no global catalogue shared across agent scopes |
| Prompt zones / snapshot | prompt/builder + session snapshot storage | tools/system/frozen first recall/conversation/live recall tail | B6 prefix hashes, reopen test; session schema v2 stores frozen memory; incognito stores no separate snapshot |
| Cache breakpoint translation | prompt metadata, composition HTTP adapter | exact Anthropic system/tool/conversation markers applied to built body; volatile recall unmarked | Actual wire body checked; interior tool-block mapping and vendor live hit rates are separate acceptance work |
| Cache telemetry | prompt/telemetry | normalised provider cache read/creation/input counts → hook/logger | Synthetic ≥.90 cache-read share from turn 3; no claim of live vendor cache hits |
| Pre-call budget / reservations | budget/calls | router BudgetGuard before **every** initial, retry, fallback and repair attempt | Pre-call refusal, real usage settlement, unknown usage remains reserved |
| Context zone allocation | budget/context, model catalogue | Existing session bound and prompt zone caps remain; no silent budget-driven prompt clipping | Model-window/tokenizer binding to allocateContext/checkZones remains a follow-up; initial call admission already refuses before invocation |
| Pending usage / retention | budget call ledger, future reconciliation host | Uncertain charges remain reserved across restart and calendar rollover | Reconciliation and pruning require authoritative provider usage; no expiry frees an unknown charge |
| Retry budget | budget/retry | same turn counter for transient retries/fallbacks and argument repair, actual cost settlement | Matrix covers fallback and repair. Unpriced retries reserve the whole retry-class ceiling instead of zero |
| Tool and subagent return caps | toolcall/results, budget/subagent | private full-result files + valid JSON reference; collab runner enforces 2000-token return | Real output reference and scoped subagent tests; full-result retrieval RPC/retention policy remains follow-up |
| D109 decision / approval / grant consumption | tools/dispatcher, approvals/runtime/service, grants | all registered calls traverse the dispatcher; runtime opens lazily on first tool; recorded decision, begin/once consumption | Actual RPC local-owner list → decide → resume test plus chained-store tests, deny, headless refusal; foreground wait expires under existing approval service rules |
| File tools / deny-port | tools/fs, policy path canonicaliser, host-tools deny list | async classification on real target; current agent workspace by default; never paths include host credential trees and harness run/state | Real file read in Core/CLI; reads outside executor roots remain refused even after policy approval (path-grant expansion needs a separate filesystem-port change) |
| exec.run | tools/exec unchanged, composition adapter | central recorded gate first; inner gate sees the already-authorized invocation, while existing mode/allowlist/roots/deny/env/process limits remain | Existing exec suite; default mode deny. OS sandbox and T3 attestation remain existing gaps |
| Host tools | host-tools/catalog/context | all D106 catalogue entries registered with capability effect/risk; native implementation and caller abort | Registry/dispatch tests and existing host conformance suite; privileged execution and package-manager changes keep their library refusals |
| MCP tools | mcp registry + tools/mcp-bridge | per-agent/principal visibility; `mcp.<server>.<tool>` names; lazy processes, independent server degradation | Actual stdio fake MCP server, real bridge, approval and shutdown reaping; sampling/elicitation/Apps UI/task extensions remain separate |
| Media generate/edit | media adapters and OutputStore | image.generate/edit behind net.submit + money, pre-call budget, operation-time secret lookup, output references and referenceIds for edits | Fake adapter + real output store; dedicated media.generate/edit D109 capabilities do not exist in main and need a catalogue change. Native media HTTP still owns its own transport after egress admission; unified pinned transport needs a media adapter injection port |
| Auth / credential pools / refresh owner | auth credentials, HttpRefresher, GoogleAdc | secret-store leases per attempt, actual result reporting, profile-specific wire factories, guarded OAuth POST | Actual Core auth lease path + existing auth/refresh suites; delegated CLI routes and login/logout UI/RPC remain follow-ups |
| Provider profiles / fallback / dialects | providers profiles/router, toolcall dialects | profile parameters retained; shared breaker owner with ALS-separated turn budgets; cache metadata changes with the actual fallback model; reversible wire tool aliases; one repair owner | Rate-limit fallback, no auth fallback, four real wire adapters; unsupported MoA is refused. Strict=false retains internal original-schema validation without rewriting required/optional fields |
| Collaboration | collab service + composition scoped runner | authenticated caller reaches runner, real registry directory, real call-budget admission, shared pipeline, private capped returns, shutdown abort/drain | Scoped runner test; Core exposes only an in-process collaboration port. Project/collab RPC/UI/workflow, project memory pools and hand-off grants remain follow-ups |
| D111 writer / per-stage trace | existing Core writer, logs/trace, composition stage | legacy writer bridge keeps structured stage/span/parent/duration/code fields; actual writer redaction/flush lifecycle retained | All main stages checked in real Core log. Catalogue-native stage events and payload capture are not claimed |
| RPC `_meta.traceparent` | logs/fromRpcMeta helper only | **Not wired:** Request is closed and has no `_meta`; CallContext has no carrier | Requires rpc.schema.json/shared RPC adapter work, prohibited by this task's file scope; new root traces and existing ALS propagation are tested |
| Audit | existing audit-chain tee and PolicyAudit | decisions/outcomes plus budget refusal use existing sinks; no second policy evaluator | Actual audit file checked; known policy hard-link name-alias TODO remains outside scope |
| Discovery modelRoles | discovery + future composition profile resolver | Existing discovery remains live; this pipeline selects configured router profiles via decision.classProfiles | Automatic discovery-role → router-profile resolution is a follow-up; no compatible public profile resolver exists |
| OpenRouter sticky routing | prompt session_id + composition HTTP | Session identity feeds cache telemetry; no vendor routing header is added | Vendor-specific routing-header contract remains a follow-up |
| Context compaction | existing session/Compactor | Bounded history and checkpoint-before-swap retained | LLM summarizer adapter remains a follow-up; no additional summarization model call is claimed |
| D110 / voice (#288) | unmerged branch | No conditional code loaded | Revisit after #288 lands; no subscription flow or realtime claim |

Every former follow-up is either connected above or named with its owner and reason.
No changes are made to dreams, ACP, A2A, channels, apps, Rust, workflows, RPC schemas,
RBAC or generated sources. Small additive existing-library changes are: budget's
`releaseUnused` port for a retry refused before invocation, MCP's composition factory,
and collab's authenticated runner context and draining shutdown. Registry/dispatcher
changes support async path classification and immutable metadata enumeration.

## Sequence

```mermaid
sequenceDiagram
    participant CLI
    participant Supervisor
    participant Core
    participant Identity
    participant Engine
    participant Pipeline
    participant Budget
    participant Router
    participant Provider
    participant Dispatcher
    participant Approvals
    participant Tool
    CLI->>Supervisor: daemon start / existing chat path
    Supervisor->>Core: start / monitor Core
    CLI->>Core: session.submit (caller, text)
    Core->>Identity: resolve active exact handle link
    Core->>Engine: recall under v2 and linked v1 ACLs
    Core->>Pipeline: compacted context + recalled tail + turn signal
    Pipeline->>Pipeline: identity / triage / scoped registry / top-k index / zones
    loop bounded model/tool rounds
        Router->>Budget: checkBeforeCall per attempt
        alt budget refused
            Budget-->>Core: typed budget_exceeded (audit)
        else reserved
            Router->>Provider: auth lease + dialect-specific streaming request
            Provider-->>Pipeline: deltas, calls, authoritative usage
            Router->>Budget: settle known usage (retain unknown reservation)
            Pipeline->>Dispatcher: validated args (one bounded repair if needed)
            Dispatcher->>Dispatcher: policy.decide + audit
            alt never
                Dispatcher-->>Core: typed tool-denied
            else approval
                Dispatcher->>Approvals: request; turn waits, no execution
                Approvals-->>CLI: approval.requested via existing notification
                CLI->>Approvals: existing approval.decide
                Approvals-->>Dispatcher: bound decision; begin consumes once
                Dispatcher->>Tool: execute with limits and abort
            else allowed / standing grant
                Dispatcher->>Tool: execute with limits and abort
            end
            Tool-->>Pipeline: bounded result + provenance
            Pipeline->>Pipeline: cap + private full-result reference
            Pipeline->>Provider: correlated tool result on next model round
        end
    end
    Core->>Engine: capture once after successful remembered turn
    Core-->>CLI: persisted outcome and replayable ordered session events
```

## Stages and error handling

The server resolves the D109 approving person from the authenticated connection, never from session params. Memory/budget and MCP visibility retain the canonical turn principal; those identities are deliberately carried separately.

`TurnRunner` owns persisted events, context preparation, cancellation, completion and
post-turn capture. The composition ChatProvider owns the complete model/tool loop.
The existing legacy provider seam is adapted through the router and budget too;
provider-reported tool results never bypass the composition dispatcher.

Each stage checks AbortSignal before and after work and emits start/end/error with
trace_id, span_id, parent_span_id and duration. A stream is advanced under the same
trace and turn context, without buffering its whole response. Closing iteration closes
the nested adapter; cancellation and Core shutdown reach the provider, approval
wait and tool process. A completed turn's capture uses the Core-owned shutdown signal.

Budget admission raises `CallBudgetExceededError` (`budget_exceeded`); retry exhaustion
keeps `retry_budget_exceeded`. Router/provider errors retain their original taxonomy;
auth never falls back, and no fallback happens after a streamed event. Dispatcher
failures become typed `TurnToolError` with the original envelope; source error codes
survive the adapter boundary. A second invalid argument set is `tool-call-invalid`.
Unknown usage is **not zero usage**, but it never stays pending forever. An attempt
whose request provably billed nothing (the adapter never ran, the credential lease
failed, egress refused locally, or the provider answered an HTTP error before the
first byte) releases its reservation; an attempt that was sent but ended without
authoritative usage (abort mid-stream, network failure after the request) settles an
estimate (input estimate plus streamed output). Media generate/edit failures release;
an aborted generation settles the requested quantity. As a safety net, a reservation
older than the call budget's `reservationTtlMs` (default 30 min) stops counting and
is reconciled on start. Known usage is settled before done can be consumed.

Router events (`provider.retry`, `provider.fallback`, `provider.skipped`,
`provider.breaker`) are written to the core log and the audit log with their turn.
A retry or fallback is charged to the retry budget at its own authorization
(`attempt > 1`, class of the failure that caused it). A fallback across billing
classes (plan vs paid, from the provider definition's `billingPath` or its credential
kind) is refused with `provider.cross_billing_refused` unless
`providers.modelProfilePolicy.<profile>.allowCrossBilling` is `true`.

Each dispatched call gets the approval service's D109 context (repeat-denied, prompt
cap per session) and the connection's derived surface. A non-person principal may
chat; a call that needs a person's approval fails with `approval-requires-person`.

Recall errors degrade to an empty/live context and remain logged. Failed captures
leave the completed session outcome intact and are logged. Budget/auth/session store
failure disables that subsystem while the memory Core can continue serving. MCP
listing failure removes only the affected server's offered tools and is logged;
unknown/unoffered names never execute. Permission/audit failure refuses the call.
Services stop in reverse dependency order: sessions, collaboration abort/drain, MCP,
auth owner, call budget; global engine/identity/permission/log shutdown stays in Core.

## Configuration and defaults

The existing reserved `providers`, `modelProfiles` and `decision` namespaces are used.
No schema key is added. A provider definition has `wireFormat`, `defaultModel`,
optional `models`, a validated auth `profile`, credential-pool `entries`, and optional
`strategy`. Values in config are **secret references**, never plaintext keys.

```json
{
  "providers": {
    "anthropic": {
      "wireFormat": "anthropic_messages",
      "defaultModel": "claude-haiku-4-5-20251001",
      "entries": [],
      "profile": {
        "id": "anthropic",
        "display_name": "Anthropic API key",
        "kind": "api_key",
        "capabilities": ["chat"],
        "base_url": "https://api.anthropic.com/v1",
        "auth_header_scheme": "x-api-key: {token}",
        "secret_ref": "anthropic.key",
        "policy_status": "allowed",
        "policy_source": "deployment policy",
        "policy_checked": "2026-10-08"
      }
    }
  },
  "modelProfiles": {
    "default": { "candidates": [{ "model": "anthropic/claude-haiku-4-5-20251001" }], "params": { "maxTokens": 4096 } }
  },
  "decision": { "classProfiles": { "small": "default", "medium": "default" } }
}
```

Configure egress with the provider's approved hosts/ports and provision referenced
credentials through the existing `secret set` interface. Empty provider configuration
still returns `no-provider` without creating a turn. `providers.mcp` accepts
`allowedCommands` and server definitions validated by the existing MCP module.
`providers.media.adapters` accepts existing adapter configuration plus `secretRef`;
plaintext `apiKey` is refused. The first configured media adapter is selected; its
own capability declaration determines whether edit is offered. Edit accepts only
existing private output-store `referenceIds`, never an arbitrary file path.

Composition inputs are taken at Core start. Egress, secret lookup and identity links
remain live; hot rebuilding auth profiles/routers on changes to the reserved live
provider namespaces is a follow-up. In-process CompositionOptions supplies explicit
roots, exec policy, adapters and limits for tests/embedders. Production defaults are
current agent workspace only, exec mode deny, top-k 12, up to 25 model rounds, and
4096 max output tokens when the selected profile supplies none. Collab's default
AgentScope has an empty toolView and cannot silently acquire host tools.

## Verification and follow-ups

The integration matrix uses in-memory synthetic SSE for all four wire formats;
no DNS, sockets or external network is used by those provider tests. The MCP test
uses a stdio fixture process. Media uses a fake image adapter and the real OutputStore.
System tests bootstrap the real Core under the real supervisor, provision a synthetic
key in the gated memory keyring, and run the existing `plur1bus chat --json` binary.
The flat embedder/reranker seam prevents model downloads. No real user data is used.

Covered scenarios: (a) plain chat; (b) allowed real file read and model continuation;
(c) real chained approval store, park/decide/consume/resume; (d) never/headless refusal;
(e) one repair and second-invalid failure on every wire; (f) budget refusal before any
model invocation; (g) rate-limit fallback and auth no-fallback; (h) actual stdio MCP
server; (i) image output reference; (j) abort/adapter cleanup; (k) v2 plus two linked
v1 identity scopes; (l) stable prefix/reopen snapshots and synthetic B5 cache-read
usage. Main stage spans and actual Core log/audit files are checked.

Remaining surface work: Web approval UI and channel ConfirmPrompt, ACP/A2A turn
entry points, Dreams jobs, collab RPC/UI, D110/voice after #288, T3 attestation,
RPC trace carriers/catalogue-native stage events, engine-native union ranking,
filesystem path-grant expansion, live model/cache acceptance and runtime provider
configuration refresh, discovery `modelRoles` to router-profile resolution, sticky
OpenRouter headers and LLM-backed context compaction. These boundaries are in the AB1 table, not hidden behind
passing fixture tests. The existing hard-link-to-denied-name and WebMCP
`grant.`/`approval.` TODO tests are not fixed in this file-scoped integration PR.

Local verification on 2026-10-08: complete Core suite 3500 tests, 3489 passed,
0 failed, 9 skipped, 2 pre-existing TODO gaps. New integration matrix: 67 passed;
CLI → daemon → Core system matrix: 4 passed. Build, typecheck and lint/hygiene
completed successfully. The two TODO gaps are the hard-link deny-name alias and
WebMCP forbidden grant/approval prefixes. No CI state was polled or claimed.
