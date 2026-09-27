# ADR-016: API stability and versioning

**Status:** Accepted (2026-09-25, owner decision D26; implementation record of plan 2a-H2 added 2026-09-26; implementation record of plan 2a-H3a added 2026-09-26; implementation record of plan 2a-H3b-a added 2026-09-27) · **Date:** 2026-09-25 / 2026-09-26 / 2026-09-27 · **Deciders:** Christian (owner) · **Inputs:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2 (D3, D14, D21, D25), §6.2 · ADR-012 (process model, RPC) · ADR-013 (configuration, migrations) · the engine's contract amendment policy (`types/engine.d.ts:23-31` in `openclaw-plur1bus-memory`) · `docs/superpowers/plans/2026-09-26-m1b-2a-h2-memory-surface-and-api-stability.md` ("Global Constraints" and rulings G1–G3, G6, G10, G11–G15; lands on `main` via docs PR #3) · `docs/superpowers/plans/2026-09-26-m1b-2a-h3-supervisor-installer-warmup.md` (ruling S2, S13; Tasks 2 and 11) · `docs/superpowers/plans/2026-09-27-m1b-2a-h3b-config-modules-setup-repair.md` ("Global Constraints", owner decision B15, rulings H3B-R11, H3B-R23, H3B-R25 through H3B-R28; Tasks 7–11) · Source of record: this repository @ `feat/m1b-2a-h3b-a` (`58b2986` at this record), engine @ `d0842424` (contract 1.8.0, unchanged by this plan).

## Context

The harness is meant to carry third-party skills, plugins and modules (D3, D14), and people will script against its CLI. The owner requirement is that the harness must not keep shipping breaking changes that "pull the rug" from skill and plugin developers or from users.

The architecture already contains most of the necessary pieces:
- The engine contract is internal. Only `@plur1bus/core` consumes it, so an engine major (contract 2.0, E6) is absorbed by the core.
- Every RPC envelope carries `rpc` and `contract`, and an unknown major is refused with `E_RPC_VERSION`.
- Result objects allow additional properties.
- `config.json` has `schemaVersion` with migrations and backups (ADR-013).
- A CI test keeps the shipped operations skill in step with the CLI.

Four things are missing:
- a written compatibility policy for the public surface;
- capability discovery;
- rules that make the deliberately strict parts (closed params, closed error enum) forward-compatible;
- a harness-owned schema for events. ADR-012 forwards engine events verbatim as `engine.event`, which leaks the engine's payload shapes to every subscriber.

## Decision

**The public surface is versioned by semantic versioning with written additive/breaking rules, discovered by capabilities rather than version numbers, split into `stable` and `experimental` tiers, and changed only through announced deprecations with a support window. Nothing the engine emits reaches a client unmapped.**

### 1. What is public

| Surface | Version carrier |
|---|---|
| Core and supervisor JSON-RPC (methods, params, results, notifications, error codes) | `rpc` (schema `x-rpc-version`) |
| `@plur1bus/module-api` (TS package) and the module manifest | npm semver + manifest `apiVersion` |
| Extension points (`chain` / `collect` payloads) | per extension point `version` |
| CLI commands, flags, exit codes and `--json` output | CLI semver + `schema` field in every `--json` document |
| `config.json` | `schemaVersion` (ADR-013) |
| Slash commands of the command layer (D21) and the ACP/MCP server surfaces (D25) | follow the RPC they map to |

The engine contract (`types/engine.d.ts`) is **not** public. It may break on its own schedule; the core translates.

### 2. Compatibility rules

- **Additive (minor), allowed at any time:**
  - new methods, notifications, extension points or CLI commands;
  - new optional params;
  - new result fields;
  - new enum members in results and notifications;
  - new error codes;
  - new optional manifest fields.
- **Breaking (major), only through §5:**
  - removing or renaming anything;
  - making an optional param required;
  - narrowing a param's accepted values;
  - changing a field's type or meaning;
  - changing an exit code;
  - removing a `--json` field.
- **Client obligations**, which the SDKs implement and the conformance kit (§7) tests:
  - ignore unknown result fields;
  - treat an unknown error code as a generic failure with its `message`;
  - treat an unknown enum member as "other";
  - send a new optional param only after the capability check (§3). Params stay closed (`additionalProperties: false`) so typos fail loudly, which is why this obligation exists.
- **Server obligations:** a server supports the current and the previous major of every public surface for the support window (§5). The supervisor loads modules of the current and the previous manifest `apiVersion` side by side.

### 3. Capabilities, not version sniffing

`core.auth` (and the supervisor's handshake) returns a `capabilities` object:
- `methods` (name → `{ stability, since, deprecated? }`);
- `notifications`;
- `extensionPoints`;
- `features` (a flat set of named feature flags, e.g. `memory.ops`, `session.progressive-compaction`).

Clients branch on capabilities. A version comparison is only allowed to refuse an unsupported major.

### 4. Stability tiers

Every method, notification, extension point and CLI command carries `x-stability: experimental | stable` (a schema annotation; the CLI help marks experimental commands).
- **`experimental`** may change or disappear in any minor, and is announced as such in capabilities and docs.
- **`stable`** falls under §2 and §5.
- New surface starts `experimental` unless a plan explicitly declares it `stable`. Promotion to `stable` is a minor change recorded in the changelog.

### 5. Deprecation and support window

A breaking change to a `stable` surface first ships as an additive replacement plus a deprecation: `deprecated: { since, removeAfter, replacement }` in the schema and in capabilities.
- Every use is logged once per process and listed by `1staid check`.
- The old form keeps working for **at least two minor releases and at least six months**, whichever is later.
- Removal happens only in a major release, whose changelog lists every removal with its replacement.

### 6. Events are harness-owned

Engine events are mapped by the core onto harness notification schemas (`recall.completed`, `recall.degraded`, `job.run`, `dream.completed`, `acl.denied`, `embedding.identity.changed`, …), each with its own versioned schema. They are never forwarded as raw engine payloads. This replaces ADR-012's verbatim `engine.event` (the H1 interim, T17 ruling). The interim notification is marked `experimental` until the mapping lands in H2, then deprecated under §5.

### 7. Conformance kit

The contract fixtures the harness tests itself against (`packages/rpc-schema/fixtures`, the restart-plan and defaults fixtures) are published as `@plur1bus/conformance` with a small runner, so a module or client author can test against the exact rules in §2.

### 8. CLI output

Every `--json` document carries `"schema": "<command>/<major>"`. Its fields follow §2. Human-readable output is not an interface and may change freely.

## Consequences

- **H2 implements:**
  - `capabilities` in both handshakes;
  - `x-stability` and `deprecated` annotations in the schemas, with generated docs showing them;
  - harness-owned event schemas with the core-side mapping;
  - the `schema` field in CLI `--json` output;
  - side-by-side `apiVersion` loading in the supervisor.

  The conformance kit follows with the first published module API.
- The H1 surface is `experimental` in its entirety until H2 declares its `stable` subset. Nothing has shipped to third parties yet, so this costs nothing now. Retrofitting it after the first module exists would itself be a breaking change.
- Engine majors (2.0 in E6) never require a harness major on their own.
- The price is a second implementation path during each deprecation window, plus the discipline of starting new surface as `experimental`.

## Alternatives considered

- **Date-based API versions per request (Stripe-style):** strong for a hosted API with many long-lived integrations; too heavy for a local daemon whose client and server usually update together.
- **Open params (`additionalProperties: true`):** forward-compatible without a capability check, but typos and wrong field names then pass silently. Rejected in favour of closed params plus capabilities.
- **No tiers, everything stable from day one:** freezes early mistakes. Rejected.

## Implementation record (2a-H2)

Plan 2a-H2 (this repository @ `53acbb3`, `feat/m1b-2a-h2`, engine `@cyb3rb1ade/plur1bus-memory` @ `d32771c5`, contract 1.6.0) is the first plan to build against this ADR. What follows records what shipped, what deviated (via the plan's rulings G1–G20), and what is still deferred to plan **2a-H3** (ruling G1: the owner's cut of 2a-H2 does not contain the supervisor, installer, `1staid`, soak testing, the Windows named-pipe ACL or model warm-up, all of which §"Consequences" above had labelled "H2").

### The stable subset (G14)

§"Consequences" above deferred naming the stable subset to "H2 declares its `stable` subset". 2a-H2 fixes it, once, in the RPC schema (`packages/rpc-schema/schema/rpc.schema.json`, `x-rpc-version` bumped to `1.1.0`) and in the CLI (`crates/plur1bus/src/cli.rs`, `STABLE_COMMANDS`):

- **RPC methods:** `core.auth`, `core.status`, `core.shutdown`, `memory.recall`, `memory.capture`, `events.subscribe`, `events.unsubscribe`.
- **RPC notification:** `core.state`.
- **CLI commands:** `memory add`, `memory recall`, `config get`, `config set`.

Everything else — every other H1 method and notification, and all ten new MemoryOps methods (`memory.list|show|forget|correct|share|state|propose`, `memory.proposals.list|accept|reject`) — is `experimental`. Every method and notification in the schema now carries `x-stability` and `x-since` (`"1.0.0"` for everything that predates this plan, `"1.1.0"` for what 2a-H2 adds); `packages/rpc-schema/test/stability.test.ts` pins universal coverage and the exact G14 lists, and `crates/plur1bus/src/cli.rs`'s `leaf_commands_are_stable_or_marked_experimental` test walks the whole clap tree asserting every visible leaf is either in `STABLE_COMMANDS`, prefixed `[experimental] ` in its `about`, or names the milestone that will deliver it (`2a-H3`, `M1b-3`, `M2`, `M3`, `M4`, `M8` — the CLI stub labels §"What is public" implies were still "H2" are relabelled `2a-H3` throughout, per G1). `docs/rpc.md`'s generated `## Stability` section and each method/notification heading's `**Stability:** … · since …` line (`scripts/gen-docs.mjs`) make this visible without reading the schema.

### `x-deprecated`, not the bare 2020-12 `deprecated` boolean (G10)

The standard `deprecated` keyword is boolean and cannot carry `since`/`removeAfter`/`replacement`. Schemas now carry **both**: `deprecated: true` (so generic 2020-12 tooling still sees it) **and** `x-deprecated: { since, removeAfter, replacement }` (the structured form §5 needs). `removeAfter` is the earliest ISO date, at least six months after `since`'s release; removal still happens only in a major (§5, unchanged). `buildCapabilities` (`packages/rpc-schema/src/index.ts`) surfaces the object as `deprecated` on the matching `CapabilityEntry`. The one deprecated surface today is the H1 interim `engine.event` notification (§6 below); `packages/core/src/rpc/server.ts` logs one warning per process, per deprecated name, the first time a subscription names it or a deprecated method is dispatched — the mechanism §5 asked for ("every use is logged once per process"), now built and, for the notification path, tested (`rpc-server.test.ts`: "subscribing to a deprecated notification logs one warning per process").

### Capabilities: placement and features (§3, ruling G2)

`capabilities` is attached to `core.auth`'s result only (`{ methods, notifications, extensionPoints: {}, features }`), not to "both handshakes" as §3 originally said — there is no supervisor handshake to extend in 2a-H2 (ruling G2; it gets the same `Capabilities` `$def` in 2a-H3). `extensionPoints` is `{}` (out of 2a's scope; no extension point exists yet). `features` is `CORE_FEATURES` (`packages/core/src/capabilities.ts`), sorted by `buildCapabilities`: **`memory.ops`** (the ten MemoryOps methods, Task 5), **`memory.proposals`** (D31's propose/accept/reject sub-surface, also Task 5), **`events.harness`** (the nine mapped notifications replacing verbatim forwarding, Task 7). `methods`/`notifications` are derived entirely from the schema's own `x-stability`/`x-since`/`x-deprecated` annotations — `buildCapabilities` never hand-keeps a second list, so capabilities and the generated docs can never drift apart.

Both clients implement the capability check §3 asked for: `Client::supports(method)` (`crates/plur1bus-rpc/src/client.rs`) and `CoreClient.supports(method)` (`packages/module-api/src/client.ts`) return `true` when `capabilities` is absent from the handshake (an older, pre-2a-H2 core — nothing to check against, so the old core answers for itself) and otherwise check membership in `capabilities.methods`. This is exactly Review Focus 5's contract: the 2a-H2 CLI against an H1 core, or against a 2a-H2 core whose capabilities happen to omit a method, answers `E_NOT_AVAILABLE reason=core-lacks-method` (exit 2) for that one method rather than crashing or sending a request the old core cannot parse. `crates/plur1bus/src/commands/memory_ops.rs` calls `supports` once per command, before ever issuing the RPC call.

### Event mapping and G11–G13 (§6)

§6 said engine events are "mapped by the core onto harness notification schemas... never forwarded as raw engine payloads," and named `recall.completed`, `recall.degraded`, `job.run`, `dream.completed`, `acl.denied`, `embedding.identity.changed` as examples. 2a-H2 builds the mapper (`packages/core/src/events-map.ts`, `mapEngineEvent`) and ships nine notification schemas: the six §6 named, plus `recall.block-clipped`/`recall.block-dropped` (deferral events the design spec's engine event list also covers) and `memory.proposal` (D31, new in this plan). Three of the nine — `dream.completed`, `acl.denied`, `embedding.identity.changed` — are not yet emitted by the engine at `d32771c5` (confirmed by grep: only `recall.*`, `job.run` and `memory.proposal` call `emitEngineEvent`); ruling **G11** ships them anyway as minimal, `experimental` schemas (`{ agentId? }` and friends) with no invented payload fields, ready to map the moment the engine emits them. `mapEngineEvent` returns `null` — logged at debug, never sent — for an unknown event name, a non-object payload, a missing or wrongly-typed required field, or an enum value (a `job.run` trigger/outcome/phase, a deferral reason, a proposal status) outside the schema's own `enum`.

**G12** answers §6's unstated question of who receives `memory.proposal` under an `events.subscribe { agentId }` filter: both the sharer and the proposer. The core notifies with `audience: [sharerAgentId, proposerAgentId]` (`RpcServer.notify`'s new `audience` option, `packages/core/src/rpc/server.ts`) while the payload's `agentId` is the sharer, so a subscription filtered to either side of the proposal receives it.

**G13** resolves §6's "deprecated under §5" for the H1 interim, given that an H1 no-filter subscriber got every engine event: `engine.event` keeps its verbatim payload and its eight-name enum unchanged, is marked `experimental` **and** deprecated (`x-deprecated`, above), but is now delivered **only** to a subscription that names it explicitly in `events.subscribe { names }` — opt-in, not opt-out. A subscriber with no `names` filter gets the nine mapped notifications and never sees `engine.event`; a subscriber that still names it gets it verbatim, unchanged, alongside a one-time-per-process deprecation warning. This is the mechanism that finally stops the payload leak §"Context" above named as missing, without silently breaking an H1 subscriber that explicitly opted into the old notification.

### CLI `schema` ids (G15)

§8's `"schema": "<command>/<major>"` left the spelling of `<command>` and the shape of error and non-object documents unstated. Ruling G15 fixes: a dotted command path (`memory.list/1`, `memory.proposals.accept/1`, `config.schema/1`, not `memory-list/1` or `memory list/1`); every failure document, of any command, is `error/1`; `config schema --json`'s value is `{ schema: "config.schema/1", tier, jsonSchema }` — the id is a sibling of the JSON Schema value, never spliced into it, because a JSON Schema value must not carry a foreign top-level key; `core run`'s `{"ready":true,...}` line is the core process's own startup output, not a CLI `--json` document, and is exempt. `crates/plur1bus/src/output.rs`'s `document()` helper is the single place that inserts the key (`Out::ok`/`Out::fail` are its only callers), and `packages/rpc-schema/test/schema.test.ts`'s "no method result declares a top-level schema property" plus `crates/plur1bus/tests/cli.rs`'s "every_json_document_carries_a_schema_id" pin that no RPC result and no CLI command can collide with it.

### Deferred: G2, G3

- **G2** (above): the supervisor's own handshake capabilities wait for the supervisor itself, in 2a-H3.
- **G3**: §"Server obligations" also said "the supervisor loads modules of the current and the previous manifest `apiVersion` side by side." `packages/module-api` in 2a-H2 still has only the client and the wire framing, no module loader — there is nothing to load two versions of. Deferred to 2a-H3 with the loader itself; nothing in 2a-H2 touches `apiVersion` compatibility.
- **`1staid` listing of deprecations** (§5: "listed by `1staid check`"): `1staid check|repair` are still stubs in 2a-H2 (relabelled `2a-H3` per G1, `crates/plur1bus/src/cli.rs`); the one thing to list today — `engine.event`'s deprecation — is visible in `docs/rpc.md`'s generated stability line and in the one-per-process warning log until `1staid check` exists to surface it on demand.

### Consequences, updated

Of the five bullets §"Consequences" listed under "H2 implements," 2a-H2 delivers the first four in full (capabilities in `core.auth`; `x-stability`/`x-deprecated` annotations with generated docs; harness-owned event schemas with the core-side mapping; the `schema` field in CLI `--json` output) and explicitly defers the fifth, side-by-side `apiVersion` loading, to 2a-H3 alongside the supervisor that would host it (G3). The conformance kit (§7) is still unbuilt — it follows the first published module API, which does not exist yet in 2a. The H1 surface is no longer experimental in its entirety: G14 fixes its stable subset now, ahead of any third-party module, which is a stronger guarantee than §"Consequences" originally asked for ("until H2 declares its stable subset").

## Implementation record (2a-H3a)

Plan 2a-H3a (this repository @ `feat/m1b-2a-h3a`, `6baeb8e` at plan close, engine `@cyb3rb1ade/plur1bus-memory` @ `d0842424`, contract 1.8.0) is the plan that finally builds the supervisor 2a-H2 deferred (ADR-012 §1, §8, §10). It closes **G2** in full for the surface it built, closes the deprecation-listing half of **§5** ("listed by `1staid check`"), and leaves **G3** deferred again, now explicitly to **2a-H3b** rather than an unnamed "2a-H3".

### G2 closed: a second server, its own capabilities, and a filtered `x-server` (ruling S2)

§"Deferred: G2, G3" above said the supervisor's own handshake capabilities would wait for the supervisor itself. 2a-H3a builds that supervisor (`crates/plur1bus/src/supervisor/`) and, with it, closes G2 as originally scoped: the RPC schema's single method/notification namespace now carries **`x-server: "core" | "supervisor"`** on every one of its (by plan's end) entries, and `buildCapabilities(features, server)` (`packages/rpc-schema/src/index.ts`) / `capabilities(server, features)` (`crates/plur1bus-rpc/src/capabilities.rs`) both filter by it before returning `{ methods, notifications, extensionPoints, features }` — so `core.auth`'s `capabilities` lists only core methods and `supervisor.auth`'s lists only the supervisor's, exactly as §3's "capabilities, not version sniffing" describes for whichever server a client is talking to. This is a stricter, more literal reading of §3's "and the supervisor's handshake" than G2's placeholder text needed to resolve, because there is now a real second server whose method set is genuinely disjoint from the core's (the supervisor never serves `memory.*`, and the core never serves `daemon.*`).

New surface added under this filter, all `experimental`/`x-since: "1.2.0"` (RPC schema version bumped 1.1.0 → **1.2.0**, additive): `supervisor.auth` (the supervisor's own handshake, `x-server: "supervisor"`, mirroring `core.auth`'s shape — token in, `{rpc, instanceId, pid, capabilities}` out, with `SUPERVISOR_FEATURES = ["adoption", "lifelines"]`), `daemon.status`, `daemon.start`, `daemon.stop` (all `x-server: "supervisor"`), and **`core.adopt`** (`x-server: "core"` — ruling **S2**/**C3** settled the design spec's `daemon.adopt` naming question: the call a supervisor makes *on* the core is named after the server that answers it, `core.adopt`, not after the server that initiates it; 2a-H3b's `module.adopt` will follow the identical convention). `core.status`'s result became the schema's first named, shared `$defs/CoreStatus` (previously an inline result type only `core.status` used) so that `core.adopt`'s result — also a `CoreStatus` — can `$ref` the same definition rather than duplicating it; a new `$defs/ChildStatus` describes a supervised child from the supervisor's point of view (`role`, `process`, `instanceId`, `pid`, `adopted`, `restarts`, `lastExit`, `nextRestartAt`), independent of `CoreStatus` since it describes the core *from outside*, not the core's own self-report. Both clients' `supports(method)` (`crates/plur1bus-rpc/src/client.rs`, `packages/module-api/src/client.ts`) were already capability-driven from 2a-H2 (G2's original text); they needed no change to correctly restrict a supervisor connection's capability check to `capabilities.methods` from *that* handshake, since each `Client`/`CoreClient` instance already only ever holds the one handshake it authenticated with.

### `1staid check` lists deprecations (closing the last unbuilt piece of §5)

§"Deferred: G2, G3" above also noted that "`1staid` listing of deprecations" could not be built in 2a-H2 because `1staid check` was still a stub. 2a-H3a builds `1staid check` for real (spec §6.6, D12; `crates/plur1bus/src/commands/firstaid.rs`), and its `api.deprecations` row is now the mechanism §5 asked for: it lists every deprecated entry from **both** handshakes' capabilities (core and supervisor — reusing the same `x-server`-filtered `capabilities()` call as any other client, `plur1bus_rpc::capabilities`), each annotated with `used` from the new `core.status.deprecationsUsed: string[]` field (**ruling S13** — the schema's `deprecationsUsed` addition; `RpcServer.deprecationsUsed()` returns the existing per-process "warned once" set, sorted, that `warnIfDeprecated` already populated in 2a-H2). **Ruling H3-R16** (a fix-round correction to the plan's own first cut): the check reports `ok` while every deprecated entry's `used` is `false` and only escalates to `warn` once at least one has actually been used — not "warn merely because a deprecated surface exists in the schema," which would make `1staid check` warn forever about `engine.event`'s deprecation (ADR-012 §3/§10, still deprecated, still opt-in) on every installation that has never once subscribed to it. This is a refinement of §5's "every use is logged once per process and listed by `1staid check`" — the wording already implied *use*, not mere *existence*, is what should surface.

### G3 still deferred, now explicitly to 2a-H3b

§3's "server obligations" line — "the supervisor loads modules of the current and the previous manifest `apiVersion` side by side" — remains unbuilt. 2a-H3a's supervisor spawns and monitors exactly one kind of child (the core); `packages/module-api` still has only the client and wire framing, with no module loader, manifest schema, or `module.adopt` method. **2a-H3b-2** ("Module manifest and loader") is where this lands, per the harness plan's own split (ruling S1): the manifest schema (D14: `provides`/`consumes`/`implements`/`extensionPoints`/`scope`/`priority`), `module.adopt` (following `core.adopt`'s naming convention, above), and the side-by-side current/previous `apiVersion` loading G3 describes. Nothing in 2a-H3a touches `apiVersion` compatibility, exactly as the 2a-H2 record already said would remain true until the loader exists.

### Additive surface added by this plan, for completeness

Beyond the `x-server`/`core.adopt`/`daemon.*` surface above (all new, all `experimental`, all backward-compatible under §2's additive rules), 2a-H3a added four optional fields to `core.status`'s result (`$defs/CoreStatus`) as engine PR E4 (contract 1.8.0) landed. **`core.status` itself is `stable` (`x-since: "1.0.0"`)**, not experimental: these are new optional result fields on a stable method, which §2 lists as additive (minor), and every client already ignores unknown result fields (§2's client obligations). The new fields: **`deprecationsUsed: string[]`** (this section, S13); **`engine.models: { embedder, reranker }`** (`$defs/ModelStatus`, spec §6.3's model warm-up, ADR-012 §10.10); **`engine.sharedMemory`** (`$defs/SharedMemoryStatus`, ADR-012 §10, the shared-memory-status check); and **`jobs`** (`$defs/JobsStatus`, Task 15, job health flattened per ruling H3-R6). The existing `journalBacklog` keeps its type; it now counts the engine's journal backlog including `*.jsonl.replaying-*` files (Task 15). None of this required a schema-version bump beyond the `x-server` split's own 1.1.0 → 1.2.0 move.

One change is not additive in §2's strict sense, and is recorded here rather than hidden: **the meaning of `engine.ready`/`engine.degraded` changed under ruling C4** (spec §6.3, S7). Since 2a-H3a, `engine.degraded` carries the engine's model-derived state (`{ reason: "models-warming" | "model-failed", capability }`), and the core keeps it at `models-warming` (capability `recall`) until its recall-path warm-up has finished (rulings H3-R22/H3-R23: the models are loaded and one side-effect-free recall-path pass per agent has run); `engine.ready` is `true` only when `engine.degraded` is `null`. Before, `engine.ready` simply mirrored `process.state === "ready"` and `engine.degraded` mirrored a degraded `process` (capability `core`), so a freshly started core reported `engine.ready: true` the moment it served. `process` is unchanged — it stays `ready` once the socket serves (B8) — so the supervisor, `daemon status` and every caller that gates on `process.state` see no difference; a client that treated `engine.ready: false` as an error now sees it for the first seconds after each start. The owner accepted this under C4 instead of shipping a replacement field through §5, because the field's documented purpose (whether the engine can answer at full quality) is what the new value reports.

## Implementation record (2a-H3b-a)

Plan 2a-H3b-a (this repository @ `feat/m1b-2a-h3b-a`, `58b2986` at this record, engine unchanged at `d0842424`, contract 1.8.0) is the plan that closes **G3** in full — the last piece §"Deferred: G2, G3" and the 2a-H3a record's "G3 still deferred, now explicitly to 2a-H3b" both left open — and adds a third server role, `module`, to the `x-server` split G2 closed in 2a-H3a. It also adds `admin.*` (owner decision B15), the first CLI surface this ADR's §1 table calls out by name as never reaching an agent through WebMCP.

### G3 closed: side-by-side module `apiVersion` loading

§"Server obligations" (§2) says "the supervisor loads modules of the current and the previous manifest `apiVersion` side by side." This is now literally true: `crates/plur1bus/src/modules/manifest.rs`'s `api_version_supported(v, current)` accepts `current` and `current − 1` (`checked_sub`, no underflow at `current = 1`); `current_api_version()` is `MODULE_API_VERSION` (`1`) unless `PLUR1BUS_MODULE_API_CURRENT` overrides it under `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (the test seam that makes the side-by-side claim testable without publishing two real module API majors). `module_api_versions_run_side_by_side` (`crates/plur1bus/tests/modules.rs`) proves it end to end: with `PLUR1BUS_MODULE_API_CURRENT=2`, a module declaring `apiVersion: "2"` and one declaring `"1"` both reach `ready` together, while one declaring `"3"` is refused. A module outside the supported window is never spawned: it is shown `crashed` with the new `api-version-unsupported` `CrashReason` (ADR-012 §10.12), and the same identity check runs again on every respawn — a manifest whose `apiVersion` changes while a module is already running (an in-place edit, or a reinstall of the same directory) is caught the next time that module is spawned or probed, not only at supervisor start (a fix-round addition, `a_respawn_reads_the_manifest_again`).

### A third server role: `x-server: "module"`

RPC schema 1.3.0 (no version bump beyond what Tasks 2–11 of this plan needed for other reasons; the `x-server` enum's third member is additive under §2) extends `x-server` from `"core" | "supervisor"` to `"core" | "supervisor" | "module"`, on methods only — **every notification's `x-server` stays `"core" | "supervisor"`; no module ever emits a notification of its own** (a module's status changes reach a watcher through the supervisor's own `module.state`, `x-server: "supervisor"`, not from the module directly). `buildCapabilities`/`capabilities(server, …)` (§"G2 closed" in the 2a-H3a record above) filter by it exactly as they already filtered core versus supervisor: a module's own `module.auth` handshake capabilities list only the four methods every module serves (`module.auth`, `module.status`, `module.adopt`, `module.shutdown`) — the module runtime shared by every module (`@plur1bus/module-api`'s `runModule`, `docs/module-guide.md`) is what makes this a single, closed, tested set rather than something each module author could vary. `MODULE_FEATURES = ["adoption", "lifelines"]`, the same two features `SUPERVISOR_FEATURES` already had for the core's own lifeline/adoption story — a module's own handshake advertises no feature the core's or the supervisor's schema entries don't already cover. `Endpoint::Module` (`crates/plur1bus-rpc`) is the Rust side's third connection kind, alongside `Endpoint::{Core, Supervisor}`.

### Supervisor notifications this plan adds: `config.changed`, `module.state`

§"Deferred: G2, G3" (2a-H2 record) and the deviations table both once listed `config.changed`/`module.state` as "not yet in the schema; supervisor notifications, arriving with the supervisor's ownership of config/modules." Both now exist, `x-server: "supervisor"`, `x-since: "1.3.0"`: `config.changed { diff, restartPlan }` (ADR-013 §4/§8) and `module.state { name, process, pid, instanceId }` (ADR-012 §10.12). Both follow `config.watch`/`module.watch`'s existing subscription-queue delivery (no gap between a snapshot and the first push after it — the same guarantee `config.watch`'s reply ordering already gave, extended to `module.watch`).

### Additive surface added by this plan, for completeness

All new, all `experimental`, all `x-since: "1.3.0"`, all backward-compatible under §2's additive rules — RPC schema version stays 1.3.0 throughout (Tasks 2–11 share one bump, done once by Task 2 for the journal-replay work, ADR-012 §10.12):
- `config.get|set|watch`, `module.list|start|stop|restart|graph|install|uninstall|watch`, the four `module.auth|status|adopt|shutdown` methods every module serves, and the six `admin.*` methods (below) — all new `x-server`-carrying methods this plan adds.
- New `$defs`: `RestartPlan`, `ModuleStatus`, `ModuleState`, `ModuleListEntry`, `ModuleGraph`, `CrashReason` (an explicit enum for what was previously only ever a free-form string on `ChildStatus.process.reason`), `JournalReplayStatus` (ADR-012 §10.12), `IpcAddress`, `EmbeddingIdentity`. `ChildStatus` gains an optional `kind: "core" | "module"` so a client can tell a module child from the core in `daemon.status.children` without relying on array position (`daemon.rs`'s `core_child` helper does the same on the Rust side).
- **Extension points are declared, but still never dispatched (ruling B11, unchanged from 2a-H3a's own note under this same heading in spirit).** A module's manifest may declare `extensionPoints: { <name>: "chain" | "collect" }` (D14, `docs/module-guide.md`), and `module.graph`/`module list` both surface what a module declared; nothing in the supervisor or the core calls into one. `capabilities.extensionPoints` in every handshake stays `{}`, exactly as it has since 2a-H2 — declaring an extension point is validated, graphed and visible, but "dispatching a chain/collect call across modules" itself remains out of scope, deferred past this plan with no assigned successor named yet.

### `admin.*` (B15): a core surface an agent cannot reach through WebMCP

Six new core methods (`x-server: "core"`, since a module never needs `admin.*` and the supervisor has no engine to administer): `admin.obsidian.detect|prepare|confirm`, `admin.migrate`, `admin.embedding.probe|serve` — the harness's E2/E3 surface (the design spec's owner-only administrative operations) finally reachable over RPC instead of only by editing files by hand. They are ordinary `core` methods under every rule in §1–§5: additive, experimental, subject to the same deprecation and capability rules as any other core method. What is new is a rule this ADR's §1 table did not previously need to state explicitly, because nothing before `admin.*` needed it: **`packages/webmcp`'s `FORBIDDEN_PREFIX` now includes `"admin."`, so no `admin.*` method — present or future — is ever offered as a WebMCP tool, regardless of its `x-stability`, `x-server`, or whether it is explicitly named in an `include` list** (D55; `packages/webmcp/test/provider.test.ts`'s `admin methods are never offered as WebMCP tools` tests this against the six real methods *and* a hypothetical `admin.future.op`, so a later `admin.*` addition inherits the exclusion without a matching test change). The reasoning: WebMCP exposes tools to an agent acting through the M3 GUI on the user's behalf; `admin.*` covers operations the design intends only for the person at the CLI (an Obsidian vault migration, a store-schema migration, serving the embedding IPC to another process) — the CLI can call them, an agent cannot, by construction rather than by convention. This is the one place in the harness today where "public surface" (§1's table) and "reachable by every kind of client" deliberately diverge: `admin.*` is public RPC surface, versioned and capability-discovered like any other, but one specific client (WebMCP, and so any agent behind it) is carved out of it at the schema-adjacent layer, not left to each caller's discretion.
