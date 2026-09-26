# ADR-016: API stability and versioning

**Status:** Accepted (2026-09-25, owner decision D26; implementation record of plan 2a-H2 added 2026-09-26) · **Date:** 2026-09-25 / 2026-09-26 · **Deciders:** Christian (owner) · **Inputs:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2 (D3, D14, D21, D25), §6.2 · ADR-012 (process model, RPC) · ADR-013 (configuration, migrations) · the engine's contract amendment policy (`types/engine.d.ts:23-31` in `openclaw-plur1bus-memory`) · `docs/superpowers/sdd/2026-09-26-m1b-2a-h2-memory-surface-and-api-stability/global-constraints.md` (rulings G1–G3, G6, G10, G11–G15, plan 2a-H2) · Source of record: this repository @ `53acbb3` (`feat/m1b-2a-h2`), engine @ `d32771c5` (contract 1.6.0).

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
