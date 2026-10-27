# Engine contract schema sources

## Contract snapshot

`engine-contract.schema.json` is the editable source of truth for generated
Rust data types. It transcribes the public `types/engine.d.ts` contract at
commit `9f34008c143c5da87b2194b5a28442b407ff8ba7`, whose contract is `1.17.0`.
The installed package is resolved from `packages/core/package.json` with
`createRequire` and `require.resolve('@cyb3rb1ade/plur1bus-memory/package.json')`;
no package-manager store path is part of the schema or recorder contract.

A1 additions come only from the `types/engine.d.ts` delta between the common
base `98dfe2f0` and `9b935ce1f970bd92a931aa99a58c620669c8085f`. The pinned
`AdminOps.reembedding.validate` remains present at `x-since: "1.17.0"`.
The A1 branch also calls itself `1.17.0`; its additions have not been assigned
a distinct version on the main engine line. Therefore their `x-since` is
`a1-pending`, rather than asserting a conflicting released version. This
applies to the six new A1 types, `MemoryOps.stats`, `MemoryOps.promote`,
`MemoryOps.curation.*`, the three additional engine capability flags, and the
`knowledge-update` `JobName` member. The owner still needs to assign their
version on merge. `x-enum-since` records versions of additive union members.
Other version annotations follow the changelog in the pinned declaration
header; a type's initial version is distinct from a later field amendment.

## JSON and Rust translation

Each exported interface or alias has a definition with its original title.
Methods live in `x-methods`, keyed by their name relative to the exported
owner, including anonymous groups such as `reembedding.validate`. Each entry
retains the parameter and return schemas, comments, and version annotation.
Referenced service interfaces retain their own method metadata. A service
or process handle marked `x-runtime: true` is implemented by hand-written
Rust traits or handles, so the data generator excludes its definition.
`CaptureHandle` completion and abort remain a channel receiver and an abort
handle in Rust; a serialized completed result is not a capture handle.

`AbortSignal` fields are documented in `x-runtime-properties` and become
separate `Cancel` arguments for recall, LLM calls and the four memory requests.
Capture keeps the brief's fixed method signature: `TurnRecord.cancel` carries
its caller token as a Rust-only field marked by `x-rust-cancel-field`, skipped
by serde and defaulting to `Cancel::never()` for JSON input. `Promise<T>` contributes its completed `T` data
shape only to method metadata. Inheritance and intersection object members
are expanded into their full structured properties, and `Partial<T>` makes
those properties optional. String template principals retain their prefix
patterns. Native data structs preserve the engine's camelCase JSON keys.
Input records and all fixed-shape data objects are closed; the explicitly
open `DecisionTrace` and source-declared `Record`/index-signature dictionaries
retain their open values. Genuine `unknown` values remain arbitrary JSON;
structured source types are not replaced with arbitrary JSON. Unconstrained
TypeScript numbers use `serde_json::Number`, retaining the JSON integer or
floating representation without adding integer constraints absent from the
source contract. The explicit float vector uses native `f32` elements.

`EngineConfig` is an explicit external schema reference marked
`x-config-type: true`. It is generated separately from
`engine-config.schema.json`, avoiding a duplicate weakly typed config map.
The data generator substitutes that generated config type when a contract
reference needs it. `EmbedKind`, `RunOptions`, `HistoryFilter`, and
`EngineEvent` name shapes consumed by the Rust traits. The A1 request/query
and resolve-result definitions name anonymous shapes of its existing methods.
`ShareOptions`, `ProposeOptions`, `ProposalRejectOptions`,
`ObsidianDetectOptions`, `MemoryShareTarget`, and `MemoryCurationAction`
name the corresponding anonymous operation arguments for stable Rust signatures.
`MemoryOpError` is retained as runtime metadata; its Rust implementation is a
hand-written safe error with the generated `MemoryOpErrorCode`.
The runtime aliases are `Capabilities = EngineCapabilities` and
`AdoptReport = StoreAdoptResult`; `AgentStoreHandle` is a runtime store lease.

`MemoryRow` is transcribed from the 69-property bootstrap row in
`engine/store/memory-db.js:772` at the same pin, as RE-02 requires. All 69
column names are required. Strings, booleans, and numeric columns follow
the seed's values; `vector` has `number` items with `format: "float"`, which
generates `Vec<f32>`. This schema does not add or migrate any store columns.

## Deliberate drops

The following members are omitted by RE-01 and the plan's host boundary:

- `HostRuntime` and `HostPathOverrides`: adapter runtime and path escape hatches.
  `HostServices.runtime` and `HostServices.pathOverrides` therefore disappear.
- `HostCapabilities.pushCriticalButtons` and `HostCapabilities.memoryArchiveDir`:
  adapter UI delivery and the archive path now fixed below the state directory.
  Their standalone argument/result declarations remain so exported names do
  not silently disappear beyond the agreed drop list.
- `HostServices.logger`: the engine emits its own typed logs.
- `HostServices.configPath` and `HostServices.routing`: no engine-side adapter use.
- `HostServices.mutateConfig`: administrative methods return proposed patches;
  the core owns configuration writes.
- `HostServices.fetch`: native outbound clients use the egress gate.
- `HostServices.clock` and `HostServices.events`: the Rust host provides
  `now_ms` and `emit` directly.
- `Engine.tools`, `Engine.commands`, `Engine.runCommand`, `ToolSpec`,
  `CommandSpec`, and `CommandResult`: deprecated adapter command plumbing.
- `EmbeddingServeResult.address` and `EmbeddingServeResult.tokenPath`: scoped
  embedding IPC addresses and token files are replaced by the engine RPC
  transport (RE-D4). The `serve` method and its result identity remain.

`Engine.channels` and `Engine.open` remain present. Cancellation, runtime
ports, and method metadata are represented explicitly and are not drift drops.

## Runtime oracle drift

`DRIFT.json` records approved differences between the pinned declarations and
observed runtime values. In particular,
`RecallTiming.namespacePhases[].namespace` permits `string` or `null`: the
default namespace is returned as `null` by the pinned engine even though its
declaration names only `string`. The field remains required, so its generated
`Option<String>` serializes `null` explicitly. The recorded recall fixture
exercises this value; no fixture was changed by hand.

Uncapped early recall exits return `capChars: Infinity` in JavaScript, which
JSON represents as `null`. `RecallResult.capChars` therefore also permits null
as an uncapped sentinel, with an additional ledger entry and a raw closed-engine
recall recorded by the same deterministic public-API recorder. The live startup
default checker compares the installed engine with the ledger without changing
goldens, and a simulated changed module proves that a default-only pin change fails.

## Neutralized contract descriptions

Host-specific wording in retained declaration comments is expressed in terms
of the plugin host. Keys and data shapes retain their source spelling. The
retained changed description locations are:

- `/$defs/ContractVersion/description`: the contract header's host references
  are generalized to the plugin host and host manifest.
- `/$defs/ProviderCredentialConfig/properties/apiKey/description`:
  ``Literal key, `${ENV}` reference or plugin host SecretInput (legacy; prefer apiKeyRef).``
- `/$defs/RemoteRerankerConfig/properties/apiKey/description`: the same inherited
  credential description as `ProviderCredentialConfig`.
- `/$defs/HostServices/properties/stateDir/description`:
  `Replaces HOST_STATE_DIR (index.js:12425).`
- `/$defs/RecallTiming/description`:
  ``1.9.0: `totalMs` runs from `Engine.recall` entry (for the plugin host hook path: assembler entry); `phases.completed` begins with `entry` (Engine.recall only), `queue` and `prelude`.``

Other host-specific comments belonged only to deliberately dropped members.

## Configuration schema

`engine-config.schema.json` is copied from
`engine/config/engine-config.schema.json` at
`9f34008c143c5da87b2194b5a28442b407ff8ba7`. Only the following 13
description values are rewritten to neutral host wording. No keys, values,
constraints, defaults, or `x-contract` annotations are changed. The drift
test compares parsed JSON after recursively removing `description` fields;
this also avoids line-ending differences between checkouts. Runtime
validation differences are recorded separately in `DRIFT.json`.

```json
[
  {
    "pointer": "/properties/dreaming/properties/enabled/description",
    "text": "Controls the plugin host memory-core dreaming sidecar compatibility and the sleep plan shown on the plugin host's Memory page. Keep false when memory-core can still run its own sweep; when PLUR1BUS owns the memory slot the host disables memory-core anyway, and true makes the page stop claiming dreaming is off."
  },
  {
    "pointer": "/properties/dreaming/properties/narrative/properties/diary/description",
    "text": "Also append each dream narrative to the agent's DREAMS.md, the file the plugin host's Dreams page shows."
  },
  {
    "pointer": "/properties/runtime/properties/detachPostTurnWork/description",
    "text": "Run post-turn capture work (episodes, insights, light dream) outside the finished turn's caller identity, so its LLM calls are not refused as unauthorized by hosts that revoke that identity when the turn ends (the plugin host: LLM_COMPLETION_NOT_AUTHORIZED). Off by default; turn on and observe."
  },
  {
    "pointer": "/properties/merging/properties/model/description",
    "text": "Optional feature-local chat model. When absent, uses the effective plugin host agent model."
  },
  {
    "pointer": "/properties/schicht15/properties/model/description",
    "text": "Optional feature-local chat model. When absent, uses the effective plugin host agent model."
  },
  {
    "pointer": "/properties/llmRouter/properties/defaultModel/description",
    "text": "Model used for every background feature that has not configured one of its own (episode extraction, dream interpretation, conversation analysis, consolidation, …). Without this value, they fall back to the agent's main model and consume its quota even though they need nothing from the live conversation. A feature-local model always takes precedence; features with their own transport (baseUrl/apiKey/headers) are unaffected. The route stays the plugin host-override, so authentication and transport remain with the host."
  },
  {
    "pointer": "/properties/llmRouter/properties/agentModels/description",
    "text": "Optional model overrides per plugin-host agent and LLM task. Missing entries preserve the existing feature-local model/transport, then llmRouter.defaultModel, then the host default. Dashboard choices use the plugin host route; existing direct credentials are preserved for resetting."
  },
  {
    "pointer": "/properties/skillMiner/properties/autoApply/description",
    "text": "Apply mined skills through the plugin host Skill Workshop without a manual review: \"host\" follows skills.workshop.autonomous.mode (auto applies, propose/off leaves drafts pending), \"on\" always applies, \"off\" always waits for approval in the PLUR1BUS dashboard or /plur1bus skills."
  },
  {
    "pointer": "/properties/skillMiner/properties/model/description",
    "text": "Optional feature-local chat model. When absent, uses the effective plugin host agent model."
  },
  {
    "pointer": "/properties/criticalPush/properties/model/description",
    "text": "Optional feature-local chat model. When absent, uses the effective plugin host agent model."
  },
  {
    "pointer": "/properties/emotion/properties/t3/properties/model/description",
    "text": "Optional feature-local chat model. When absent, uses the effective plugin host agent model."
  },
  {
    "pointer": "/properties/healthWatch/properties/gatewayLog/description",
    "text": "Read the host's gateway log for lost-reply and wedge signals (tail of today and yesterday, at most once a minute; the plugin host: the plugin host-YYYY-MM-DD.log)."
  },
  {
    "pointer": "/properties/healthWatch/properties/gatewayLogDir/description",
    "text": "Directory with the host's rolling gateway log files (the plugin host: the plugin host-YYYY-MM-DD.log). Defaults to the directory of the host's logging.file setting, else /tmp/the plugin host."
  }
]
```

## Input limits

`input-limits.json` records all 17 exported limits from `lib/input-limits.js` at the pinned commit. Regenerate it together with the 46 validation vectors using `node crates/plur1bus-engine/tests/fixtures/input-limits/record.mjs`. The typed string boundary counts UTF-16 code units and never truncates; it does not coerce arbitrary objects.

## Generator representations

The config accepts both camelCase and legacy snake_case keys in workspace entries. Their Rust fields use distinct names (the legacy field has `_legacy`), with explicit serde names preserving both original wire keys. Scalar literal unions are consolidated into disjoint branches for typify 0.8; absent, explicit null, and empty collections remain distinct. Schema integer fields deserialize through lossless JSON numbers after validation, which also accepts integral values written as `1.0`.

Scalar union consolidation resolves local scalar references first and removes
duplicate literals. This preserves string-valued import/unimport reasons and
model failures. Principal template types retain exactly their declared prefix
alternatives, without adding suffix restrictions. `HistoryFilter.limit` retains
the declared unconstrained number domain; the registry's later implementation
decides which values impose a cap.
