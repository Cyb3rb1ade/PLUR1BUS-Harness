# Engine contract reference (contract 1.17.0)

Generated from `crates/plur1bus-engine/schema/engine-contract.schema.json` by `scripts/gen-docs.mjs` — do not edit by hand; run `pnpm docs:gen`.

Pinned engine contract 1.17.0 with additive A1 curated-memory members. Runtime ports and cancellation remain hand-written Rust contracts.

Source engine commit: `9f34008c143c5da87b2194b5a28442b407ff8ba7`. Additive A1 commit: `9b935ce1f970bd92a931aa99a58c620669c8085f`.
`a1-pending` marks additive members whose final contract version the engine owner has not assigned.
Type summaries describe the schema. Method signatures preserve its `x-methods` parameters and resolved result shapes;
the Rust traits, cancellation parameters and runtime ports live under `crates/plur1bus-engine/src/contract/`.
The schema block in each section retains every constraint, annotation and runtime-member definition.

## `ContractVersion`

**Since:** 1.17.0

types/engine.d.ts — the frozen PLUR1BUS engine contract. Contract version 1.17.0 (frozen at 1.0.0 on 2026-09-22, owner decision B8; amended seventeen times under the policy below — see the changelog at the end of this header). This file reconciles the four places Phase 0 sketched the same API differently (review-report finding S4). Where ADR-002 and engine-extraction.md §b.2 disagreed, B8 chose: - `Principal.trust: "proved" | "inferred"`   (not `proof: "transport"`) - `TurnOrigin` as a string union plus a separate `AgentContext` (not one `TurnOrigin` object) - `capture()` returns a non-blocking `CaptureHandle` (not `Promise<CaptureResult>`) - `RecallResult.degraded` is a structured object or null (not a boolean) `createEngine` (engine/create-engine.js) implements it from M1b-1 on. It is the shape both the plugin host adapter and the harness are written against, and it is checked by `npm run typecheck`. Amendment policy: "frozen" means 1.0.0 is never edited in place. Any change to an exported member's shape that an existing adapter could observe — a new required property, a removed or renamed member, a narrowed or widened union, a changed parameter or return type — forces a `ContractVersion` bump; only additions no adapter can observe (a comment, a new optional property on a type the engine alone constructs) may land without one. `ContractVersion`, the assertions in `types/engine.conformance.ts` and both adapters move together in a single PR, so the contract, its gate and its two consumers are never in disagreement at any commit. Changelog: 1.1.0 — SecurePathResult.reason gains "acl-tool-unavailable" (Task 5). 1.2.0 — HostServices.workspaceDir becomes async (Task 6). 1.3.0 — HostServices.configPath(), HostServices.routing?, HostServices.pathOverrides? (G1 closure, M1b-1 Task 11). 1.4.0 — Engine surface of createEngine (M1b-1): ContextBlock.chars; RecallResult.timing (replaces timings) and .deferrals; RecallQuery.budget optional; JobRun/JobRegistry/JobSpec per spec 3.3 (outcome gains "abandoned"); CheckpointReason gains "session-end"; Engine.close({ budgetMs }); Engine.channels; HostServices.capabilities?; EngineEventName gains recall.block-clipped/-dropped, recall.completed; createEngine testOptions. 1.4.1 — JobTrigger gains "unknown" (a crash row recovered from a corrupt, unreadable start marker; M1b-1 final review m2). 1.5.0 — MemoryOps types, Engine.memory (E1 Task 2); runCommand deprecated; MemoryState.tombstones number | null (E1-R11); HostCapabilities.memoryArchiveDir? (E1 Task 8). 1.6.0 — AdminOps.share/forget alias Engine.memory (deprecated); ObsidianOps with explicit paths; migrate over a store schema marker; MemoryOps.propose/proposals (D31); MemoryCard.sharedBy/sourceId; MemoryOpError.detail; "memory.proposal" event; EngineStatus.storeSchema (E2). 1.7.0 — EmbeddingService.probe(opts?) → EmbeddingProbeResult (identity, readiness, memoized); serve(address?: IpcAddress | null) → EmbeddingServeResult (real scoped IPC, in-process owner, no claim listener); HostCapabilities.pushCriticalButtons? typed (E3). 1.8.0 — EngineStatus.jobs/models/journal/sharedMemory, degraded derived from model readiness; Engine.models (status, warm); HostCapabilities.journalBacklog?; MemoryOpErrorCode "unsupported"; CaptureResult.reason "duplicate-turn" (E4). 1.9.0 — engine-config.schema.json with readAt/x-tier/x-sensitive and its types (EngineConfigSchema, EngineConfigKey, EngineConfigReadAt); RecallQuery.warmOnly; RecallTiming.totalMs covers queue wait and prelude (E5). 1.10.0 — additive engine-config keys from the 7.18.5–7.18.20 port (runtime.deferPostTurnLlm, diaryFromUserChats, captureChunkingJev, recall.fullTextTopRecords/fullTextMaxChars) and JobName "post-turn-refine"; adapter-only keys stay on the plugin host manifest; no breaking change to existing callers. 1.11.0 — MemoryOps.import (finished-card ingest with deterministic ids) and Engine.stores.adopt (copy-never-move store take-over with a sample cosine probe for legacy stores); MemoryCard.provenance/sourceRef optional; no breaking change to existing callers. 1.12.0 — MemoryOps.rebind / MemoryOps.unbind (manual N:1 channel-identity link; user-scope owner metadata only) and ADOPT_PROBE_MIN_ROWS = min(8, available); UserPrincipal accepts user:v1 and user:v2; MemoryOpErrorCode "identity-already-bound" | "ledger-corrupt" | "lock-lost"; no breaking change to existing callers. 1.13.0 — MemoryOps.unimport (roll back the cards one import run created; archive-first soft delete without a registry tombstone, key freed for re-import); MemoryImportRequest.importRunId optional; MemoryOpErrorCode "lock-busy"; no breaking change to existing callers. 1.14.0 — additive complete vector-space identities, routes and degraded notes. 1.15.0 — HostServices.fetch? (HostFetch: every outbound engine HTTP request goes through it when set); SecretStore becomes resolve(ref, purpose) (lease() kept optional and deprecated; it was never called) for provider `apiKeyRef`; ProviderCredentialConfig, RemoteRerankerConfig and the reranker providers jina | voyage | remote with baseUrl/protocol; no breaking change to existing callers (the engine called no SecretStore member before 1.15.0). Also: MemoryImportRequest without importRunId attributes each card to the run its sourceRef names (`;run=<id>`); MemoryUnimportRequest.importRunId also selects such lines; MemoryUnimportResult.derived.graphEdgesRemoved? / mirrorsArchived? / cleanupErrors? (unimport drops the undone cards' graph edges and archives their Obsidian mirrors). 1.17.0 — AdminOps.reembedding.validate({ id }) (the coordinator's validating → ready_to_switch step: target generation check and semantic recall probe, so a host that owns its switch can finish a migration); a failed validation rejects and leaves the record in validating; no breaking change to existing callers. 1.16.0 — MemoryOps.link(id, req, p, a) (owner decision 2026-10-19: attach an imported duplicate to an existing card as an additional source instead of storing a duplicate; sidecar `_links/`, the card row is never written; idempotent per sourceRef); MemoryCard.links? (show/list); MemoryUnimportResult.links? (unimport of a run unlinks that run's links, the card stays); Engine.capabilities (EngineCapabilities, `memoryLink: true`); no breaking change to existing callers.

**Type:** `"1.17.0"`

**Schema**

```json
{
  "title": "ContractVersion",
  "type": "string",
  "enum": [
    "1.17.0"
  ],
  "x-since": "1.17.0",
  "description": "types/engine.d.ts — the frozen PLUR1BUS engine contract. Contract version 1.17.0 (frozen at 1.0.0 on 2026-09-22, owner decision B8; amended seventeen times under the policy below — see the changelog at the end of this header). This file reconciles the four places Phase 0 sketched the same API differently (review-report finding S4). Where ADR-002 and engine-extraction.md §b.2 disagreed, B8 chose: - `Principal.trust: \"proved\" | \"inferred\"`   (not `proof: \"transport\"`) - `TurnOrigin` as a string union plus a separate `AgentContext` (not one `TurnOrigin` object) - `capture()` returns a non-blocking `CaptureHandle` (not `Promise<CaptureResult>`) - `RecallResult.degraded` is a structured object or null (not a boolean) `createEngine` (engine/create-engine.js) implements it from M1b-1 on. It is the shape both the plugin host adapter and the harness are written against, and it is checked by `npm run typecheck`. Amendment policy: \"frozen\" means 1.0.0 is never edited in place. Any change to an exported member's shape that an existing adapter could observe — a new required property, a removed or renamed member, a narrowed or widened union, a changed parameter or return type — forces a `ContractVersion` bump; only additions no adapter can observe (a comment, a new optional property on a type the engine alone constructs) may land without one. `ContractVersion`, the assertions in `types/engine.conformance.ts` and both adapters move together in a single PR, so the contract, its gate and its two consumers are never in disagreement at any commit. Changelog: 1.1.0 — SecurePathResult.reason gains \"acl-tool-unavailable\" (Task 5). 1.2.0 — HostServices.workspaceDir becomes async (Task 6). 1.3.0 — HostServices.configPath(), HostServices.routing?, HostServices.pathOverrides? (G1 closure, M1b-1 Task 11). 1.4.0 — Engine surface of createEngine (M1b-1): ContextBlock.chars; RecallResult.timing (replaces timings) and .deferrals; RecallQuery.budget optional; JobRun/JobRegistry/JobSpec per spec 3.3 (outcome gains \"abandoned\"); CheckpointReason gains \"session-end\"; Engine.close({ budgetMs }); Engine.channels; HostServices.capabilities?; EngineEventName gains recall.block-clipped/-dropped, recall.completed; createEngine testOptions. 1.4.1 — JobTrigger gains \"unknown\" (a crash row recovered from a corrupt, unreadable start marker; M1b-1 final review m2). 1.5.0 — MemoryOps types, Engine.memory (E1 Task 2); runCommand deprecated; MemoryState.tombstones number | null (E1-R11); HostCapabilities.memoryArchiveDir? (E1 Task 8). 1.6.0 — AdminOps.share/forget alias Engine.memory (deprecated); ObsidianOps with explicit paths; migrate over a store schema marker; MemoryOps.propose/proposals (D31); MemoryCard.sharedBy/sourceId; MemoryOpError.detail; \"memory.proposal\" event; EngineStatus.storeSchema (E2). 1.7.0 — EmbeddingService.probe(opts?) → EmbeddingProbeResult (identity, readiness, memoized); serve(address?: IpcAddress | null) → EmbeddingServeResult (real scoped IPC, in-process owner, no claim listener); HostCapabilities.pushCriticalButtons? typed (E3). 1.8.0 — EngineStatus.jobs/models/journal/sharedMemory, degraded derived from model readiness; Engine.models (status, warm); HostCapabilities.journalBacklog?; MemoryOpErrorCode \"unsupported\"; CaptureResult.reason \"duplicate-turn\" (E4). 1.9.0 — engine-config.schema.json with readAt/x-tier/x-sensitive and its types (EngineConfigSchema, EngineConfigKey, EngineConfigReadAt); RecallQuery.warmOnly; RecallTiming.totalMs covers queue wait and prelude (E5). 1.10.0 — additive engine-config keys from the 7.18.5–7.18.20 port (runtime.deferPostTurnLlm, diaryFromUserChats, captureChunkingJev, recall.fullTextTopRecords/fullTextMaxChars) and JobName \"post-turn-refine\"; adapter-only keys stay on the plugin host manifest; no breaking change to existing callers. 1.11.0 — MemoryOps.import (finished-card ingest with deterministic ids) and Engine.stores.adopt (copy-never-move store take-over with a sample cosine probe for legacy stores); MemoryCard.provenance/sourceRef optional; no breaking change to existing callers. 1.12.0 — MemoryOps.rebind / MemoryOps.unbind (manual N:1 channel-identity link; user-scope owner metadata only) and ADOPT_PROBE_MIN_ROWS = min(8, available); UserPrincipal accepts user:v1 and user:v2; MemoryOpErrorCode \"identity-already-bound\" | \"ledger-corrupt\" | \"lock-lost\"; no breaking change to existing callers. 1.13.0 — MemoryOps.unimport (roll back the cards one import run created; archive-first soft delete without a registry tombstone, key freed for re-import); MemoryImportRequest.importRunId optional; MemoryOpErrorCode \"lock-busy\"; no breaking change to existing callers. 1.14.0 — additive complete vector-space identities, routes and degraded notes. 1.15.0 — HostServices.fetch? (HostFetch: every outbound engine HTTP request goes through it when set); SecretStore becomes resolve(ref, purpose) (lease() kept optional and deprecated; it was never called) for provider `apiKeyRef`; ProviderCredentialConfig, RemoteRerankerConfig and the reranker providers jina | voyage | remote with baseUrl/protocol; no breaking change to existing callers (the engine called no SecretStore member before 1.15.0). Also: MemoryImportRequest without importRunId attributes each card to the run its sourceRef names (`;run=<id>`); MemoryUnimportRequest.importRunId also selects such lines; MemoryUnimportResult.derived.graphEdgesRemoved? / mirrorsArchived? / cleanupErrors? (unimport drops the undone cards' graph edges and archives their Obsidian mirrors). 1.17.0 — AdminOps.reembedding.validate({ id }) (the coordinator's validating → ready_to_switch step: target generation check and semantic recall probe, so a host that owns its switch can finish a migration); a failed validation rejects and leaves the record in validating; no breaking change to existing callers. 1.16.0 — MemoryOps.link(id, req, p, a) (owner decision 2026-10-19: attach an imported duplicate to an existing card as an additional source instead of storing a duplicate; sidecar `_links/`, the card row is never written; idempotent per sourceRef); MemoryCard.links? (show/list); MemoryUnimportResult.links? (unimport of a run unlinks that run's links, the card stays); Engine.capabilities (EngineCapabilities, `memoryLink: true`); no breaking change to existing callers."
}
```

## `AgentId`

**Since:** 1.0.0

Matches /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (memory-host-runtime.js:30).

**Type:** `string`

**Schema**

```json
{
  "title": "AgentId",
  "type": "string",
  "x-since": "1.0.0",
  "description": "Matches /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (memory-host-runtime.js:30).",
  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
}
```

## `WorkspacePrincipal`

**Since:** 1.0.0

Workspace Principal in the engine contract.

**Type:** `string`

**Schema**

```json
{
  "title": "WorkspacePrincipal",
  "type": "string",
  "x-since": "1.0.0",
  "description": "Workspace Principal in the engine contract.",
  "pattern": "^(?:workspace:v1:|workspace-dir:v1:)"
}
```

## `UserPrincipal`

**Since:** 1.0.0

`user:v1:` + sha256(JSON.stringify([channel, accountId, userId])), or from 1.12.0 `user:v2:` + sha256(harnessUserId). The v1 hash is the on-disk pool directory name and must not change (memory-request-context.js).

**Type:** `string`

**Schema**

```json
{
  "title": "UserPrincipal",
  "type": "string",
  "x-since": "1.0.0",
  "description": "`user:v1:` + sha256(JSON.stringify([channel, accountId, userId])), or from 1.12.0 `user:v2:` + sha256(harnessUserId). The v1 hash is the on-disk pool directory name and must not change (memory-request-context.js).",
  "pattern": "^user:v[12]:"
}
```

## `ChatKind`

**Since:** 1.0.0

Chat Kind in the engine contract.

**Type:** `"direct" \| "dm" \| "group" \| "channel"`

**Schema**

```json
{
  "title": "ChatKind",
  "type": "string",
  "enum": [
    "direct",
    "dm",
    "group",
    "channel"
  ],
  "x-since": "1.0.0",
  "description": "Chat Kind in the engine contract."
}
```

## `ChannelRef`

**Since:** 1.0.0

Open vocabulary, host-declared. Replaces the closed four-value set at memory-request-context.js:24-25.

**Type:** `string`

**Schema**

```json
{
  "title": "ChannelRef",
  "type": "string",
  "x-since": "1.0.0",
  "description": "Open vocabulary, host-declared. Replaces the closed four-value set at memory-request-context.js:24-25."
}
```

## `TurnOrigin`

**Since:** 1.0.0

Turn Origin in the engine contract.

**Type:** `"user" \| "cron" \| "subagent" \| "heartbeat" \| "system"`

**Schema**

```json
{
  "title": "TurnOrigin",
  "type": "string",
  "enum": [
    "user",
    "cron",
    "subagent",
    "heartbeat",
    "system"
  ],
  "x-since": "1.0.0",
  "description": "Turn Origin in the engine contract."
}
```

## `SchemaVersion`

**Since:** 1.0.0

Schema Version in the engine contract.

**Type:** `string`

**Schema**

```json
{
  "title": "SchemaVersion",
  "type": "string",
  "x-since": "1.0.0",
  "description": "Schema Version in the engine contract."
}
```

## `Disposable`

**Since:** 1.0.0

Disposable in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `dispose(): null` | 1.0.0 |  |

**Schema**

```json
{
  "title": "Disposable",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "dispose": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "type": "null"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Disposable in the engine contract.",
  "x-runtime": true
}
```

## `Logger`

**Since:** 1.0.0

Logger in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `info(message: string, ...rest: Array<unknown>): null` | 1.0.0 |  |
| `warn(message: string, ...rest: Array<unknown>): null` | 1.0.0 |  |
| `error(message: string, ...rest: Array<unknown>): null` | 1.0.0 |  |
| `debug(message: string, ...rest: Array<unknown>): null` | 1.0.0 |  |

**Schema**

```json
{
  "title": "Logger",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "info": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "message",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "rest",
          "optional": false,
          "rest": true,
          "schema": {
            "type": "array",
            "items": {}
          }
        }
      ],
      "returns": {
        "type": "null"
      }
    },
    "warn": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "message",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "rest",
          "optional": false,
          "rest": true,
          "schema": {
            "type": "array",
            "items": {}
          }
        }
      ],
      "returns": {
        "type": "null"
      }
    },
    "error": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "message",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "rest",
          "optional": false,
          "rest": true,
          "schema": {
            "type": "array",
            "items": {}
          }
        }
      ],
      "returns": {
        "type": "null"
      }
    },
    "debug": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "message",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "rest",
          "optional": false,
          "rest": true,
          "schema": {
            "type": "array",
            "items": {}
          }
        }
      ],
      "returns": {
        "type": "null"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Logger in the engine contract.",
  "x-runtime": true
}
```

## `Message`

**Since:** 1.0.0

Message in the engine contract.

**Type:** `{ role: "system" \| "user" \| "assistant" \| "tool"; content: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `role` | `"system" \| "user" \| "assistant" \| "tool"` | yes | 1.0.0 |  |
| `content` | `string` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "Message",
  "type": "object",
  "properties": {
    "role": {
      "type": "string",
      "enum": [
        "system",
        "user",
        "assistant",
        "tool"
      ],
      "x-since": "1.0.0"
    },
    "content": {
      "type": "string",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "role",
    "content"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Message in the engine contract."
}
```

## `Principal`

**Since:** 1.0.0

Principal in the engine contract.

**Type:** `{ agentId: AgentId; workspace: WorkspacePrincipal; user?: UserPrincipal; channel: ChannelRef; accountId: string; chat: { id: string; kind: ChatKind }; trust: "proved" \| "inferred" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.0.0 |  |
| `workspace` | `WorkspacePrincipal` | yes | 1.0.0 |  |
| `user` | `UserPrincipal` | no | 1.0.0 | Absent means the `user` ACL scope is unreachable (acl-middleware.js:139-159). Never accepted from an untrusted host. |
| `channel` | `ChannelRef` | yes | 1.0.0 |  |
| `accountId` | `string` | yes | 1.0.0 |  |
| `chat` | `{ id: string; kind: ChatKind }` | yes | 1.0.0 |  |
| `trust` | `"proved" \| "inferred"` | yes | 1.0.0 | "inferred" degrades every read and write to agent-private and never throws (memory-request-context.js:1405-1417). |

**Schema**

```json
{
  "title": "Principal",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.0.0"
    },
    "workspace": {
      "$ref": "#/$defs/WorkspacePrincipal",
      "x-since": "1.0.0"
    },
    "user": {
      "$ref": "#/$defs/UserPrincipal",
      "description": "Absent means the `user` ACL scope is unreachable (acl-middleware.js:139-159). Never accepted from an untrusted host.",
      "x-since": "1.0.0"
    },
    "channel": {
      "$ref": "#/$defs/ChannelRef",
      "x-since": "1.0.0"
    },
    "accountId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "chat": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-since": "1.0.0"
        },
        "kind": {
          "$ref": "#/$defs/ChatKind",
          "x-since": "1.0.0"
        }
      },
      "required": [
        "id",
        "kind"
      ],
      "additionalProperties": false,
      "x-since": "1.0.0"
    },
    "trust": {
      "type": "string",
      "enum": [
        "proved",
        "inferred"
      ],
      "description": "\"inferred\" degrades every read and write to agent-private and never throws (memory-request-context.js:1405-1417).",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "agentId",
    "workspace",
    "channel",
    "accountId",
    "chat",
    "trust"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Principal in the engine contract."
}
```

## `AgentContext`

**Since:** 1.0.0

Agent Context in the engine contract.

**Type:** `{ origin: TurnOrigin; background: boolean; jobId?: string; parentRunId?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `origin` | `TurnOrigin` | yes | 1.0.0 |  |
| `background` | `boolean` | yes | 1.0.0 | Fail-closed: unknown means true. |
| `jobId` | `string` | no | 1.0.0 |  |
| `parentRunId` | `string` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "AgentContext",
  "type": "object",
  "properties": {
    "origin": {
      "$ref": "#/$defs/TurnOrigin",
      "x-since": "1.0.0"
    },
    "background": {
      "type": "boolean",
      "description": "Fail-closed: unknown means true.",
      "x-since": "1.0.0"
    },
    "jobId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "parentRunId": {
      "type": "string",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "origin",
    "background"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Agent Context in the engine contract."
}
```

## `SecretPurpose`

**Since:** 1.15.0

1.15.0: what a resolved secret is for; passed as `purpose` to SecretStore.resolve.

**Type:** `string`

**Schema**

```json
{
  "title": "SecretPurpose",
  "type": "string",
  "x-since": "1.15.0",
  "description": "1.15.0: what a resolved secret is for; passed as `purpose` to SecretStore.resolve."
}
```

## `SecretStore`

**Since:** 1.0.0

1.15.0: the host's secret store. The engine calls `resolve` for every provider config that sets `apiKeyRef` — before `apiKeyEnv`/`apiKey`; with `apiKeyRef` set and no store (or a failed / empty resolution) the provider fails closed, it never falls back to the environment. The value is never logged, persisted or put into a cache key in clear (only hashed, as before); providers keep it at most 60 s (embedding, reranker) or not at all (LLM: per call) and drop it on HTTP 401/403, so a rotated key applies without a restart.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `resolve(ref: string, purpose: SecretPurpose): string` | 1.0.0 | Resolve `ref` (the configured `apiKeyRef`, a name, never the value). Reject or return "" when unknown. |
| `lease(ref: string): string` | 1.0.0 |  |

**Schema**

```json
{
  "title": "SecretStore",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "resolve": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "ref",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "purpose",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/SecretPurpose"
          }
        }
      ],
      "returns": {
        "type": "string"
      },
      "description": "Resolve `ref` (the configured `apiKeyRef`, a name, never the value). Reject or return \"\" when unknown."
    },
    "lease": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "ref",
          "optional": false,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "type": "string"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "1.15.0: the host's secret store. The engine calls `resolve` for every provider config that sets `apiKeyRef` — before `apiKeyEnv`/`apiKey`; with `apiKeyRef` set and no store (or a failed / empty resolution) the provider fails closed, it never falls back to the environment. The value is never logged, persisted or put into a cache key in clear (only hashed, as before); providers keep it at most 60 s (embedding, reranker) or not at all (LLM: per call) and drop it on HTTP 401/403, so a rotated key applies without a restart.",
  "x-runtime": true
}
```

## `HostFetch`

**Since:** 1.15.0

1.15.0: WHATWG-fetch-compatible function. The engine passes `input` as a URL string and `init` with at least method, headers (plain object), body (string) and signal; it reads `ok`, `status`, `headers.get()`, `text()`/`json()` and `body` (ReadableStream, for size-capped reads) of the result.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `$call(input: string \| { [key: string]: unknown } \| { [key: string]: unknown }, init?: { [key: string]: unknown }): { [key: string]: unknown }` | 1.15.0 |  |

**Schema**

```json
{
  "title": "HostFetch",
  "type": "object",
  "additionalProperties": false,
  "x-runtime": true,
  "x-methods": {
    "$call": {
      "x-since": "1.15.0",
      "parameters": [
        {
          "name": "input",
          "optional": false,
          "schema": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "additionalProperties": true,
                "x-runtime": true
              },
              {
                "type": "object",
                "additionalProperties": true,
                "x-runtime": true
              }
            ]
          }
        },
        {
          "name": "init",
          "optional": true,
          "schema": {
            "type": "object",
            "additionalProperties": true,
            "x-runtime": true
          }
        }
      ],
      "returns": {
        "type": "object",
        "additionalProperties": true,
        "x-runtime": true
      }
    }
  },
  "x-since": "1.15.0",
  "description": "1.15.0: WHATWG-fetch-compatible function. The engine passes `input` as a URL string and `init` with at least method, headers (plain object), body (string) and signal; it reads `ok`, `status`, `headers.get()`, `text()`/`json()` and `body` (ReadableStream, for size-capped reads) of the result."
}
```

## `ProviderCredentialConfig`

**Since:** 1.15.0

1.15.0: credential fields every remote provider config (embedding, embedding.routes[].provider, reranker, feature LLM overrides) accepts. Order: apiKeyRef → apiKeyEnv → apiKey → provider default env.

**Type:** `{ apiKeyRef?: string; apiKeyEnv?: string; apiKey?: string \| { source: "env" \| "store" \| "file" \| "exec"; provider: string; id: string } }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `apiKeyRef` | `string` | no | 1.15.0 | Name in the host's secret store (HostServices.secrets). 1–256 chars of [A-Za-z0-9._:/@-]. |
| `apiKeyEnv` | `string` | no | 1.15.0 | Name of an environment variable holding the key. |
| `apiKey` | `string \| { source: "env" \| "store" \| "file" \| "exec"; provider: string; id: string }` | no | 1.15.0 | Literal key, `${ENV}` reference or plugin host SecretInput (legacy; prefer apiKeyRef). |

**Schema**

```json
{
  "title": "ProviderCredentialConfig",
  "type": "object",
  "properties": {
    "apiKeyRef": {
      "type": "string",
      "description": "Name in the host's secret store (HostServices.secrets). 1–256 chars of [A-Za-z0-9._:/@-].",
      "x-since": "1.15.0"
    },
    "apiKeyEnv": {
      "type": "string",
      "description": "Name of an environment variable holding the key.",
      "x-since": "1.15.0"
    },
    "apiKey": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "enum": [
                "env",
                "store",
                "file",
                "exec"
              ],
              "x-since": "1.0.0"
            },
            "provider": {
              "type": "string",
              "x-since": "1.0.0"
            },
            "id": {
              "type": "string",
              "x-since": "1.0.0"
            }
          },
          "required": [
            "source",
            "provider",
            "id"
          ],
          "additionalProperties": false
        }
      ],
      "description": "Literal key, `${ENV}` reference or plugin host SecretInput (legacy; prefer apiKeyRef).",
      "x-since": "1.15.0"
    }
  },
  "additionalProperties": false,
  "x-since": "1.15.0",
  "description": "1.15.0: credential fields every remote provider config (embedding, embedding.routes[].provider, reranker, feature LLM overrides) accepts. Order: apiKeyRef → apiKeyEnv → apiKey → provider default env."
}
```

## `RerankProtocol`

**Since:** 1.15.0

1.15.0: reranker wire formats. "cohere"/"jina": {model, query, documents, top_n} → {results}; "voyage": {model, query, documents, top_k} → {data}; "tei": {query, texts} → [{index, score}]. All are normalised to `[{index, relevance_score}]`.

**Type:** `"cohere" \| "jina" \| "voyage" \| "tei"`

**Schema**

```json
{
  "title": "RerankProtocol",
  "type": "string",
  "enum": [
    "cohere",
    "jina",
    "voyage",
    "tei"
  ],
  "x-since": "1.15.0",
  "description": "1.15.0: reranker wire formats. \"cohere\"/\"jina\": {model, query, documents, top_n} → {results}; \"voyage\": {model, query, documents, top_k} → {data}; \"tei\": {query, texts} → [{index, score}]. All are normalised to `[{index, relevance_score}]`."
}
```

## `RemoteRerankerConfig`

**Since:** 1.15.0

1.15.0: `config.reranker` for the HTTP providers. Presets (default baseUrl / protocol / model / env): cohere — https://api.cohere.com/v2, cohere, rerank-v3.5, COHERE_API_KEY; jina — https://api.jina.ai/v1, jina, jina-reranker-v2-base-multilingual, JINA_API_KEY; voyage — https://api.voyageai.com/v1, voyage, rerank-2.5, VOYAGE_API_KEY; remote — no defaults: baseUrl required, protocol "cohere", key optional (keyless self-hosted servers). The endpoint is `{baseUrl}/rerank` unless baseUrl already ends in /rerank. A failed rerank never switches to another model unless `fallbackProvider: "local-transformers"` is set; otherwise recall runs unreranked.

**Type:** `{ apiKeyRef?: string; apiKeyEnv?: string; apiKey?: string \| { source: "env" \| "store" \| "file" \| "exec"; provider: string; id: string }; enabled?: boolean; provider: "cohere" \| "jina" \| "voyage" \| "remote"; baseUrl?: string; protocol?: RerankProtocol; model?: string; candidates?: number; timeoutMs?: number; maxDocuments?: number; maxRequestBytes?: number; maxResponseBytes?: number; fallbackOnError?: boolean; fallbackProvider?: "local-transformers" \| "disabled"; fallbackModel?: string; fallbackRevision?: string; fallbackCacheDir?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `apiKeyRef` | `string` | no | 1.15.0 | Name in the host's secret store (HostServices.secrets). 1–256 chars of [A-Za-z0-9._:/@-]. |
| `apiKeyEnv` | `string` | no | 1.15.0 | Name of an environment variable holding the key. |
| `apiKey` | `string \| { source: "env" \| "store" \| "file" \| "exec"; provider: string; id: string }` | no | 1.15.0 | Literal key, `${ENV}` reference or plugin host SecretInput (legacy; prefer apiKeyRef). |
| `enabled` | `boolean` | no | 1.15.0 |  |
| `provider` | `"cohere" \| "jina" \| "voyage" \| "remote"` | yes | 1.15.0 |  |
| `baseUrl` | `string` | no | 1.15.0 |  |
| `protocol` | `RerankProtocol` | no | 1.15.0 |  |
| `model` | `string` | no | 1.15.0 |  |
| `candidates` | `number` | no | 1.15.0 |  |
| `timeoutMs` | `number` | no | 1.15.0 | Own timer only when the caller passes no signal (the recall pipeline always does). Default 5000. |
| `maxDocuments` | `number` | no | 1.15.0 | Refuse requests with more documents. Default 1000. |
| `maxRequestBytes` | `number` | no | 1.15.0 | Refuse request bodies above this size. Default 4 MiB. |
| `maxResponseBytes` | `number` | no | 1.15.0 | Abort and fail on response bodies above this size. Default 1 MiB. |
| `fallbackOnError` | `boolean` | no | 1.15.0 |  |
| `fallbackProvider` | `"local-transformers" \| "disabled"` | no | 1.15.0 |  |
| `fallbackModel` | `string` | no | 1.15.0 |  |
| `fallbackRevision` | `string` | no | 1.15.0 |  |
| `fallbackCacheDir` | `string` | no | 1.15.0 |  |

**Schema**

```json
{
  "title": "RemoteRerankerConfig",
  "type": "object",
  "properties": {
    "apiKeyRef": {
      "type": "string",
      "description": "Name in the host's secret store (HostServices.secrets). 1–256 chars of [A-Za-z0-9._:/@-].",
      "x-since": "1.15.0"
    },
    "apiKeyEnv": {
      "type": "string",
      "description": "Name of an environment variable holding the key.",
      "x-since": "1.15.0"
    },
    "apiKey": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "enum": [
                "env",
                "store",
                "file",
                "exec"
              ],
              "x-since": "1.0.0"
            },
            "provider": {
              "type": "string",
              "x-since": "1.0.0"
            },
            "id": {
              "type": "string",
              "x-since": "1.0.0"
            }
          },
          "required": [
            "source",
            "provider",
            "id"
          ],
          "additionalProperties": false
        }
      ],
      "description": "Literal key, `${ENV}` reference or plugin host SecretInput (legacy; prefer apiKeyRef).",
      "x-since": "1.15.0"
    },
    "enabled": {
      "type": "boolean",
      "x-since": "1.15.0"
    },
    "provider": {
      "type": "string",
      "enum": [
        "cohere",
        "jina",
        "voyage",
        "remote"
      ],
      "x-since": "1.15.0"
    },
    "baseUrl": {
      "type": "string",
      "x-since": "1.15.0"
    },
    "protocol": {
      "$ref": "#/$defs/RerankProtocol",
      "x-since": "1.15.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.15.0"
    },
    "candidates": {
      "type": "number",
      "x-since": "1.15.0"
    },
    "timeoutMs": {
      "type": "number",
      "description": "Own timer only when the caller passes no signal (the recall pipeline always does). Default 5000.",
      "x-since": "1.15.0"
    },
    "maxDocuments": {
      "type": "number",
      "description": "Refuse requests with more documents. Default 1000.",
      "x-since": "1.15.0"
    },
    "maxRequestBytes": {
      "type": "number",
      "description": "Refuse request bodies above this size. Default 4 MiB.",
      "x-since": "1.15.0"
    },
    "maxResponseBytes": {
      "type": "number",
      "description": "Abort and fail on response bodies above this size. Default 1 MiB.",
      "x-since": "1.15.0"
    },
    "fallbackOnError": {
      "type": "boolean",
      "x-since": "1.15.0"
    },
    "fallbackProvider": {
      "type": "string",
      "enum": [
        "local-transformers",
        "disabled"
      ],
      "x-since": "1.15.0"
    },
    "fallbackModel": {
      "type": "string",
      "x-since": "1.15.0"
    },
    "fallbackRevision": {
      "type": "string",
      "x-since": "1.15.0"
    },
    "fallbackCacheDir": {
      "type": "string",
      "x-since": "1.15.0"
    }
  },
  "required": [
    "provider"
  ],
  "additionalProperties": false,
  "x-since": "1.15.0",
  "description": "1.15.0: `config.reranker` for the HTTP providers. Presets (default baseUrl / protocol / model / env): cohere — https://api.cohere.com/v2, cohere, rerank-v3.5, COHERE_API_KEY; jina — https://api.jina.ai/v1, jina, jina-reranker-v2-base-multilingual, JINA_API_KEY; voyage — https://api.voyageai.com/v1, voyage, rerank-2.5, VOYAGE_API_KEY; remote — no defaults: baseUrl required, protocol \"cohere\", key optional (keyless self-hosted servers). The endpoint is `{baseUrl}/rerank` unless baseUrl already ends in /rerank. A failed rerank never switches to another model unless `fallbackProvider: \"local-transformers\"` is set; otherwise recall runs unreranked."
}
```

## `LlmParams`

**Since:** 1.0.0

Llm Params in the engine contract.

**Type:** `{ messages: Array<Message>; model?: string; temperature?: number; maxTokens?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `messages` | `Array<Message>` | yes | 1.0.0 |  |
| `model` | `string` | no | 1.0.0 |  |
| `temperature` | `number` | no | 1.0.0 |  |
| `maxTokens` | `number` | no | 1.0.0 |  |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.0.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "LlmParams",
  "type": "object",
  "properties": {
    "messages": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/Message"
      },
      "x-since": "1.0.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "temperature": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "maxTokens": {
      "type": "number",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "messages"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.0.0"
    }
  },
  "x-since": "1.0.0",
  "description": "Llm Params in the engine contract."
}
```

## `LlmResult`

**Since:** 1.0.0

Llm Result in the engine contract.

**Type:** `{ text: string; model?: string; usage?: { inputTokens?: number; outputTokens?: number } }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `text` | `string` | yes | 1.0.0 |  |
| `model` | `string` | no | 1.0.0 |  |
| `usage` | `{ inputTokens?: number; outputTokens?: number }` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "LlmResult",
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "usage": {
      "type": "object",
      "properties": {
        "inputTokens": {
          "type": "number",
          "x-since": "1.0.0"
        },
        "outputTokens": {
          "type": "number",
          "x-since": "1.0.0"
        }
      },
      "additionalProperties": false,
      "x-since": "1.0.0"
    }
  },
  "required": [
    "text"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Llm Result in the engine contract."
}
```

## `PlatformCapabilities`

**Since:** 1.0.0

Platform Capabilities in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `securePath(path: string, options?: { mode?: number }): SecurePathResult` | 1.0.0 |  |
| `ipcAddress(stateRoot: string): IpcAddress` | 1.0.0 |  |
| `isUnsafeLink(path: string): boolean` | 1.0.0 |  |
| `canonicalIdentityPath(path: string): string` | 1.0.0 |  |

**Schema**

```json
{
  "title": "PlatformCapabilities",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "securePath": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "path",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "options",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "mode": {
                "type": "number",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/SecurePathResult"
      }
    },
    "ipcAddress": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "stateRoot",
          "optional": false,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/IpcAddress"
      }
    },
    "isUnsafeLink": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "path",
          "optional": false,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "type": "boolean"
      }
    },
    "canonicalIdentityPath": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "path",
          "optional": false,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "type": "string"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Platform Capabilities in the engine contract.",
  "x-runtime": true
}
```

## `SecurePathResult`

**Since:** 1.0.0

Secure Path Result in the engine contract.

**Type:** `{ applied: boolean; reason?: "not-a-filesystem-path" \| "missing" \| "unsupported-platform" \| "acl-tool-unavailable"; mechanism?: "chmod" \| "acl" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `applied` | `boolean` | yes | 1.0.0 |  |
| `reason` | `"not-a-filesystem-path" \| "missing" \| "unsupported-platform" \| "acl-tool-unavailable"` | no | 1.1.0 |  |
| `mechanism` | `"chmod" \| "acl"` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "SecurePathResult",
  "type": "object",
  "properties": {
    "applied": {
      "type": "boolean",
      "x-since": "1.0.0"
    },
    "reason": {
      "type": "string",
      "enum": [
        "not-a-filesystem-path",
        "missing",
        "unsupported-platform",
        "acl-tool-unavailable"
      ],
      "x-since": "1.1.0"
    },
    "mechanism": {
      "type": "string",
      "enum": [
        "chmod",
        "acl"
      ],
      "x-since": "1.0.0"
    }
  },
  "required": [
    "applied"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Secure Path Result in the engine contract."
}
```

## `IpcAddress`

**Since:** 1.0.0

Ipc Address in the engine contract.

**Type:** `{ kind: "abstract-socket" \| "unix-socket" \| "named-pipe"; address: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `kind` | `"abstract-socket" \| "unix-socket" \| "named-pipe"` | yes | 1.0.0 |  |
| `address` | `string` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "IpcAddress",
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "abstract-socket",
        "unix-socket",
        "named-pipe"
      ],
      "x-since": "1.0.0"
    },
    "address": {
      "type": "string",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "kind",
    "address"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Ipc Address in the engine contract."
}
```

## `HostServices`

**Since:** 1.0.0

`HostServices` is the name used in engine-extraction.md §b.2; ADR-002 calls the same interface `Host`. They are one type.

**Type:** `{ stateDir: string; capabilities?: HostCapabilities; secrets?: SecretStore; platform: PlatformCapabilities }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `stateDir` | `string` | yes | 1.0.0 | Replaces HOST_STATE_DIR (index.js:12425). |
| `capabilities` | `HostCapabilities` | no | 1.4.0 | Host-specific construction inputs (registration mode, path resolver, optional host features). Every one has an inert default. |
| `secrets` | `SecretStore` | no | 1.15.0 | 1.15.0: provider keys named by `apiKeyRef`. Absent: `apiKeyRef` fails closed. |
| `platform` | `PlatformCapabilities` | yes | 1.0.0 |  |

| Method signature | Since | Description |
|---|---|---|
| `workspaceDir(agentId: AgentId): string` | 1.2.0 | Replaces memory-host-runtime.js:104-111. A harness agent without a real workspace gets a synthetic one under `stateDir` (engine-extraction R7). |
| `config(): EngineConfig` | 1.0.0 |  |
| `llm.complete(params: LlmParams): LlmResult` | 1.0.0 |  |

**Schema**

```json
{
  "title": "HostServices",
  "type": "object",
  "properties": {
    "stateDir": {
      "type": "string",
      "description": "Replaces HOST_STATE_DIR (index.js:12425).",
      "x-since": "1.0.0"
    },
    "capabilities": {
      "$ref": "#/$defs/HostCapabilities",
      "description": "Host-specific construction inputs (registration mode, path resolver, optional host features). Every one has an inert default.",
      "x-since": "1.4.0"
    },
    "secrets": {
      "$ref": "#/$defs/SecretStore",
      "description": "1.15.0: provider keys named by `apiKeyRef`. Absent: `apiKeyRef` fails closed.",
      "x-since": "1.15.0"
    },
    "platform": {
      "$ref": "#/$defs/PlatformCapabilities",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "stateDir",
    "platform"
  ],
  "additionalProperties": false,
  "x-methods": {
    "workspaceDir": {
      "x-since": "1.2.0",
      "parameters": [
        {
          "name": "agentId",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentId"
          }
        }
      ],
      "returns": {
        "type": "string"
      },
      "description": "Replaces memory-host-runtime.js:104-111. A harness agent without a real workspace gets a synthetic one under `stateDir` (engine-extraction R7)."
    },
    "config": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "$ref": "#/$defs/EngineConfig"
      }
    },
    "llm.complete": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "params",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/LlmParams"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/LlmResult"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "`HostServices` is the name used in engine-extraction.md §b.2; ADR-002 calls the same interface `Host`. They are one type.",
  "x-runtime": true
}
```

## `CriticalButtonPushArgs`

**Since:** 1.7.0

1.7.0: argument of HostCapabilities.pushCriticalButtons (engine/jobs/internal-job-bodies.js).

**Type:** `{ agentId: AgentId; result: unknown; commandCtx: unknown; warning: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.7.0 |  |
| `result` | `unknown` | yes | 1.7.0 | The classify-recent classifier result (pushMessages, errors, …); host-opaque. |
| `commandCtx` | `unknown` | yes | 1.7.0 | The host's own command context, passed back unchanged; host-opaque. Revisited with HostRuntime in 2.0 (E6). |
| `warning` | `string` | yes | 1.7.0 | Partial-failure note for the last card; "" when there is none. |

**Schema**

```json
{
  "title": "CriticalButtonPushArgs",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.7.0"
    },
    "result": {
      "description": "The classify-recent classifier result (pushMessages, errors, …); host-opaque.",
      "x-since": "1.7.0"
    },
    "commandCtx": {
      "description": "The host's own command context, passed back unchanged; host-opaque. Revisited with HostRuntime in 2.0 (E6).",
      "x-since": "1.7.0"
    },
    "warning": {
      "type": "string",
      "description": "Partial-failure note for the last card; \"\" when there is none.",
      "x-since": "1.7.0"
    }
  },
  "required": [
    "agentId",
    "result",
    "commandCtx",
    "warning"
  ],
  "additionalProperties": false,
  "x-since": "1.7.0",
  "description": "1.7.0: argument of HostCapabilities.pushCriticalButtons (engine/jobs/internal-job-bodies.js)."
}
```

## `CriticalButtonPushResult`

**Since:** 1.7.0

`sent` cards went out with buttons; `unsentTexts` go out as plain cron text; `reason` is host-defined.

**Type:** `{ sent: number; unsentTexts: Array<string>; reason?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `sent` | `number` | yes | 1.7.0 |  |
| `unsentTexts` | `Array<string>` | yes | 1.7.0 |  |
| `reason` | `string` | no | 1.7.0 |  |

**Schema**

```json
{
  "title": "CriticalButtonPushResult",
  "type": "object",
  "properties": {
    "sent": {
      "type": "number",
      "x-since": "1.7.0"
    },
    "unsentTexts": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "x-since": "1.7.0"
    },
    "reason": {
      "type": "string",
      "x-since": "1.7.0"
    }
  },
  "required": [
    "sent",
    "unsentTexts"
  ],
  "additionalProperties": false,
  "x-since": "1.7.0",
  "description": "`sent` cards went out with buttons; `unsentTexts` go out as plain cron text; `reason` is host-defined."
}
```

## `JournalBacklog`

**Since:** 1.8.0

1.8.0: what the host knows about turns it journaled while the engine was unavailable.

**Type:** `{ entries: number; oldestAt: number \| null }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `entries` | `number` | yes | 1.8.0 |  |
| `oldestAt` | `number \| null` | yes | 1.8.0 |  |

**Schema**

```json
{
  "title": "JournalBacklog",
  "type": "object",
  "properties": {
    "entries": {
      "type": "number",
      "x-since": "1.8.0"
    },
    "oldestAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.8.0"
    }
  },
  "required": [
    "entries",
    "oldestAt"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "1.8.0: what the host knows about turns it journaled while the engine was unavailable."
}
```

## `HostCapabilities`

**Since:** 1.4.0

Host Capabilities in the engine contract.

**Type:** `{ registrationMode?: string; postTurnRefineScheduled?: boolean }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `registrationMode` | `string` | no | 1.3.0 |  |
| `postTurnRefineScheduled` | `boolean` | no | 1.10.0 | 1.10.0: host has scheduled the post-turn-refine drain. Absent or false → capture runs light-dream/episodes inline. |

| Method signature | Since | Description |
|---|---|---|
| `resolvePath(path: string): string` | 1.3.0 |  |
| `journalBacklog(): JournalBacklog \| null \| JournalBacklog \| null` | 1.8.0 | 1.8.0: read by Engine.status(); absent, throwing, invalid or slower than 50 ms → `EngineStatus.journal: null`. |

**Schema**

```json
{
  "title": "HostCapabilities",
  "type": "object",
  "properties": {
    "registrationMode": {
      "type": "string",
      "x-since": "1.3.0"
    },
    "postTurnRefineScheduled": {
      "type": "boolean",
      "description": "1.10.0: host has scheduled the post-turn-refine drain. Absent or false → capture runs light-dream/episodes inline.",
      "x-since": "1.10.0"
    }
  },
  "additionalProperties": false,
  "x-methods": {
    "resolvePath": {
      "x-since": "1.3.0",
      "parameters": [
        {
          "name": "path",
          "optional": false,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "type": "string"
      }
    },
    "journalBacklog": {
      "x-since": "1.8.0",
      "parameters": [],
      "returns": {
        "anyOf": [
          {
            "$ref": "#/$defs/JournalBacklog"
          },
          {
            "type": "null"
          },
          {
            "anyOf": [
              {
                "$ref": "#/$defs/JournalBacklog"
              },
              {
                "type": "null"
              }
            ]
          }
        ]
      },
      "description": "1.8.0: read by Engine.status(); absent, throwing, invalid or slower than 50 ms → `EngineStatus.journal: null`."
    }
  },
  "x-since": "1.4.0",
  "description": "Host Capabilities in the engine contract.",
  "x-runtime": true
}
```

## `EngineConfig`

**Since:** 1.0.0

Engine configuration validated and generated from the accompanying engine-config.schema.json.

**Type:** `./engine-config.schema.json`

**Schema**

```json
{
  "title": "EngineConfig",
  "$ref": "./engine-config.schema.json",
  "x-since": "1.0.0",
  "description": "Engine configuration validated and generated from the accompanying engine-config.schema.json.",
  "x-config-type": true
}
```

## `EngineConfigReadAt`

**Since:** 1.9.0

1.9.0: when the engine reads a config value. construction: from createEngine's `config` argument, once — a change needs a new engine. live: per operation through HostServices.config() (engine/config/live-config.js).

**Type:** `"construction" \| "live"`

**Schema**

```json
{
  "title": "EngineConfigReadAt",
  "type": "string",
  "enum": [
    "construction",
    "live"
  ],
  "x-since": "1.9.0",
  "description": "1.9.0: when the engine reads a config value. construction: from createEngine's `config` argument, once — a change needs a new engine. live: per operation through HostServices.config() (engine/config/live-config.js)."
}
```

## `EngineConfigTier`

**Since:** 1.9.0

Engine Config Tier in the engine contract.

**Type:** `"basic" \| "advanced"`

**Schema**

```json
{
  "title": "EngineConfigTier",
  "type": "string",
  "enum": [
    "basic",
    "advanced"
  ],
  "x-since": "1.9.0",
  "description": "Engine Config Tier in the engine contract."
}
```

## `EngineConfigSchemaNode`

**Since:** 1.9.0

A node of engine/config/engine-config.schema.json (JSON Schema 2020-12 plus three annotations).

**Type:** `{ type?: string \| Array<string>; default?: unknown; description?: string; readAt?: EngineConfigReadAt; x-tier?: EngineConfigTier; x-sensitive?: boolean; properties?: { [key: string]: EngineConfigSchemaNode }; [key: string]: unknown }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `type` | `string \| Array<string>` | no | 1.9.0 |  |
| `default` | `unknown` | no | 1.9.0 |  |
| `description` | `string` | no | 1.9.0 |  |
| `readAt` | `EngineConfigReadAt` | no | 1.9.0 | Required on every top-level key; a nested node may override its parent. |
| `x-tier` | `EngineConfigTier` | no | 1.9.0 |  |
| `x-sensitive` | `boolean` | no | 1.9.0 | true on values every surface must mask/redact (credentials, `*.headers`, `reminders.webhookUrl`). Not the manifest's secretInputs: those are the nodes whose `$ref` is `#/$defs/secretInput` (a subset). |
| `properties` | `{ [key: string]: EngineConfigSchemaNode }` | no | 1.9.0 |  |

**Schema**

```json
{
  "title": "EngineConfigSchemaNode",
  "type": "object",
  "properties": {
    "type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ],
      "x-since": "1.9.0"
    },
    "default": {
      "x-since": "1.9.0"
    },
    "description": {
      "type": "string",
      "x-since": "1.9.0"
    },
    "readAt": {
      "$ref": "#/$defs/EngineConfigReadAt",
      "description": "Required on every top-level key; a nested node may override its parent.",
      "x-since": "1.9.0"
    },
    "x-tier": {
      "$ref": "#/$defs/EngineConfigTier",
      "x-since": "1.9.0"
    },
    "x-sensitive": {
      "type": "boolean",
      "description": "true on values every surface must mask/redact (credentials, `*.headers`, `reminders.webhookUrl`). Not the manifest's secretInputs: those are the nodes whose `$ref` is `#/$defs/secretInput` (a subset).",
      "x-since": "1.9.0"
    },
    "properties": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/EngineConfigSchemaNode"
      },
      "x-since": "1.9.0"
    }
  },
  "additionalProperties": {},
  "x-since": "1.9.0",
  "description": "A node of engine/config/engine-config.schema.json (JSON Schema 2020-12 plus three annotations)."
}
```

## `EngineConfigSchema`

**Since:** 1.9.0

Engine Config Schema in the engine contract.

**Type:** `{ type?: string \| Array<string>; default?: unknown; description?: string; readAt?: EngineConfigReadAt; x-tier?: EngineConfigTier; x-sensitive?: boolean; properties: { [key: string]: { type?: string \| Array<string>; default?: unknown; description: string; readAt: EngineConfigReadAt; x-tier: EngineConfigTier; x-sensitive?: boolean; properties?: { [key: string]: EngineConfigSchemaNode }; [key: string]: unknown } }; $schema: "https://json-schema.org/draft/2020-12/schema"; $id: "plur1bus-engine-config"; x-contract: ContractVersion; [key: string]: unknown }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `type` | `string \| Array<string>` | no | 1.9.0 |  |
| `default` | `unknown` | no | 1.9.0 |  |
| `description` | `string` | no | 1.9.0 |  |
| `readAt` | `EngineConfigReadAt` | no | 1.9.0 | Required on every top-level key; a nested node may override its parent. |
| `x-tier` | `EngineConfigTier` | no | 1.9.0 |  |
| `x-sensitive` | `boolean` | no | 1.9.0 | true on values every surface must mask/redact (credentials, `*.headers`, `reminders.webhookUrl`). Not the manifest's secretInputs: those are the nodes whose `$ref` is `#/$defs/secretInput` (a subset). |
| `properties` | `{ [key: string]: { type?: string \| Array<string>; default?: unknown; description: string; readAt: EngineConfigReadAt; x-tier: EngineConfigTier; x-sensitive?: boolean; properties?: { [key: string]: EngineConfigSchemaNode }; [key: string]: unknown } }` | yes | 1.9.0 |  |
| `$schema` | `"https://json-schema.org/draft/2020-12/schema"` | yes | 1.9.0 |  |
| `$id` | `"plur1bus-engine-config"` | yes | 1.9.0 |  |
| `x-contract` | `ContractVersion` | yes | 1.9.0 |  |

**Schema**

```json
{
  "title": "EngineConfigSchema",
  "type": "object",
  "properties": {
    "type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ],
      "x-since": "1.9.0"
    },
    "default": {
      "x-since": "1.9.0"
    },
    "description": {
      "type": "string",
      "x-since": "1.9.0"
    },
    "readAt": {
      "$ref": "#/$defs/EngineConfigReadAt",
      "description": "Required on every top-level key; a nested node may override its parent.",
      "x-since": "1.9.0"
    },
    "x-tier": {
      "$ref": "#/$defs/EngineConfigTier",
      "x-since": "1.9.0"
    },
    "x-sensitive": {
      "type": "boolean",
      "description": "true on values every surface must mask/redact (credentials, `*.headers`, `reminders.webhookUrl`). Not the manifest's secretInputs: those are the nodes whose `$ref` is `#/$defs/secretInput` (a subset).",
      "x-since": "1.9.0"
    },
    "properties": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "type": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ],
            "x-since": "1.9.0"
          },
          "default": {
            "x-since": "1.9.0"
          },
          "description": {
            "type": "string",
            "x-since": "1.0.0"
          },
          "readAt": {
            "$ref": "#/$defs/EngineConfigReadAt",
            "x-since": "1.0.0"
          },
          "x-tier": {
            "$ref": "#/$defs/EngineConfigTier",
            "x-since": "1.0.0"
          },
          "x-sensitive": {
            "type": "boolean",
            "description": "true on values every surface must mask/redact (credentials, `*.headers`, `reminders.webhookUrl`). Not the manifest's secretInputs: those are the nodes whose `$ref` is `#/$defs/secretInput` (a subset).",
            "x-since": "1.9.0"
          },
          "properties": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/EngineConfigSchemaNode"
            },
            "x-since": "1.9.0"
          }
        },
        "required": [
          "description",
          "readAt",
          "x-tier"
        ],
        "additionalProperties": {}
      },
      "x-since": "1.9.0"
    },
    "$schema": {
      "type": "string",
      "enum": [
        "https://json-schema.org/draft/2020-12/schema"
      ],
      "x-since": "1.9.0"
    },
    "$id": {
      "type": "string",
      "enum": [
        "plur1bus-engine-config"
      ],
      "x-since": "1.9.0"
    },
    "x-contract": {
      "$ref": "#/$defs/ContractVersion",
      "x-since": "1.9.0"
    }
  },
  "required": [
    "$schema",
    "$id",
    "x-contract",
    "properties"
  ],
  "additionalProperties": {},
  "x-since": "1.9.0",
  "description": "Engine Config Schema in the engine contract."
}
```

## `EngineConfigKey`

**Since:** 1.9.0

One top-level key as engineConfigKeys() reports it.

**Type:** `{ key: string; type: string \| Array<string> \| null; default?: unknown; description: string; readAt: EngineConfigReadAt; liveOverrides: Array<string>; tier: EngineConfigTier; sensitive: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `key` | `string` | yes | 1.9.0 |  |
| `type` | `string \| Array<string> \| null` | yes | 1.9.0 |  |
| `default` | `unknown` | no | 1.9.0 |  |
| `description` | `string` | yes | 1.9.0 |  |
| `readAt` | `EngineConfigReadAt` | yes | 1.9.0 |  |
| `liveOverrides` | `Array<string>` | yes | 1.9.0 | Paths below this key whose readAt differs from the key's own (none in 1.9.0; hosts re-read HOST_REREAD_PATHS separately). |
| `tier` | `EngineConfigTier` | yes | 1.9.0 |  |
| `sensitive` | `boolean` | yes | 1.9.0 | true when the key or any path below it is x-sensitive. |

**Schema**

```json
{
  "title": "EngineConfigKey",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "x-since": "1.9.0"
    },
    "type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.9.0"
    },
    "default": {
      "x-since": "1.9.0"
    },
    "description": {
      "type": "string",
      "x-since": "1.9.0"
    },
    "readAt": {
      "$ref": "#/$defs/EngineConfigReadAt",
      "x-since": "1.9.0"
    },
    "liveOverrides": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Paths below this key whose readAt differs from the key's own (none in 1.9.0; hosts re-read HOST_REREAD_PATHS separately).",
      "x-since": "1.9.0"
    },
    "tier": {
      "$ref": "#/$defs/EngineConfigTier",
      "x-since": "1.9.0"
    },
    "sensitive": {
      "type": "boolean",
      "description": "true when the key or any path below it is x-sensitive.",
      "x-since": "1.9.0"
    }
  },
  "required": [
    "key",
    "type",
    "description",
    "readAt",
    "liveOverrides",
    "tier",
    "sensitive"
  ],
  "additionalProperties": false,
  "x-since": "1.9.0",
  "description": "One top-level key as engineConfigKeys() reports it."
}
```

## `ContextBlockName`

**Since:** 1.0.0

Context Block Name in the engine contract.

**Type:** `string`

**Schema**

```json
{
  "title": "ContextBlockName",
  "type": "string",
  "x-since": "1.0.0",
  "description": "Context Block Name in the engine contract."
}
```

## `ContextBlock`

**Since:** 1.0.0

Context Block in the engine contract.

**Type:** `{ name: ContextBlockName; text: string; droppable: boolean; chars: number; tokensEstimate?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `name` | `ContextBlockName` | yes | 1.0.0 |  |
| `text` | `string` | yes | 1.0.0 |  |
| `droppable` | `boolean` | yes | 1.0.0 |  |
| `chars` | `number` | yes | 1.4.0 | `text.length`. |
| `tokensEstimate` | `number` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "ContextBlock",
  "type": "object",
  "properties": {
    "name": {
      "$ref": "#/$defs/ContextBlockName",
      "x-since": "1.0.0"
    },
    "text": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "droppable": {
      "type": "boolean",
      "x-since": "1.0.0"
    },
    "chars": {
      "type": "number",
      "description": "`text.length`.",
      "x-since": "1.4.0"
    },
    "tokensEstimate": {
      "type": "number",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "name",
    "text",
    "droppable",
    "chars"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Context Block in the engine contract."
}
```

## `RecallBudget`

**Since:** 1.0.0

Recall Budget in the engine contract.

**Type:** `{ softMs: number; hardMs: number; capChars: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `softMs` | `number` | yes | 1.0.0 |  |
| `hardMs` | `number` | yes | 1.0.0 |  |
| `capChars` | `number` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "RecallBudget",
  "type": "object",
  "properties": {
    "softMs": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "hardMs": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "capChars": {
      "type": "number",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "softMs",
    "hardMs",
    "capChars"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Recall Budget in the engine contract."
}
```

## `RecallOptions`

**Since:** 1.0.0

Call-local overrides. Omitted settings use the configured engine behavior.

**Type:** `{ reranker?: "on" \| "off" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `reranker` | `"on" \| "off"` | no | 1.0.0 | "on" uses the configured provider; if absent, recall continues with a diagnostic. |

**Schema**

```json
{
  "title": "RecallOptions",
  "type": "object",
  "properties": {
    "reranker": {
      "type": "string",
      "enum": [
        "on",
        "off"
      ],
      "description": "\"on\" uses the configured provider; if absent, recall continues with a diagnostic.",
      "x-since": "1.0.0"
    }
  },
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Call-local overrides. Omitted settings use the configured engine behavior."
}
```

## `PerCallDiagnostic`

**Since:** 1.0.0

Non-fatal, closed-code explanation of an unavailable requested option.

**Type:** `{ feature: "reranker"; reason: "reranker-not-configured"; fallback: "unreranked" } \| { feature: "postTurnLlm"; reason: "post-turn-refine-unscheduled"; fallback: "inline" }`

**Schema**

```json
{
  "title": "PerCallDiagnostic",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "feature": {
          "type": "string",
          "enum": [
            "reranker"
          ],
          "x-since": "1.0.0"
        },
        "reason": {
          "type": "string",
          "enum": [
            "reranker-not-configured"
          ],
          "x-since": "1.0.0"
        },
        "fallback": {
          "type": "string",
          "enum": [
            "unreranked"
          ],
          "x-since": "1.0.0"
        }
      },
      "required": [
        "feature",
        "reason",
        "fallback"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "feature": {
          "type": "string",
          "enum": [
            "postTurnLlm"
          ],
          "x-since": "1.0.0"
        },
        "reason": {
          "type": "string",
          "enum": [
            "post-turn-refine-unscheduled"
          ],
          "x-since": "1.0.0"
        },
        "fallback": {
          "type": "string",
          "enum": [
            "inline"
          ],
          "x-since": "1.0.0"
        }
      },
      "required": [
        "feature",
        "reason",
        "fallback"
      ],
      "additionalProperties": false
    }
  ],
  "x-since": "1.0.0",
  "description": "Non-fatal, closed-code explanation of an unavailable requested option."
}
```

## `RecallQuery`

**Since:** 1.0.0

Recall Query in the engine contract.

**Type:** `{ query: string; principal: Principal; agent: AgentContext; budget?: { softMs?: number; hardMs?: number; capChars?: number }; compactedAt?: number \| null; previousUserTurnAt?: number \| null; validAt?: string; warmOnly?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `query` | `string` | yes | 1.0.0 |  |
| `principal` | `Principal` | yes | 1.0.0 |  |
| `agent` | `AgentContext` | yes | 1.0.0 |  |
| `budget` | `{ softMs?: number; hardMs?: number; capChars?: number }` | no | 1.4.0 |  |
| `compactedAt` | `number \| null` | no | 1.0.0 |  |
| `previousUserTurnAt` | `number \| null` | no | 1.0.0 |  |
| `validAt` | `string` | no | 1.0.0 |  |
| `warmOnly` | `boolean` | no | 1.9.0 | 1.9.0: run only the read-only heavy path (neo prelude reads, query embedding, read-only store open, vector search, rerank) and answer { blocks: [], degraded: null, timing } on success. Writes no memory data, no store, no file and no persistent embedding-cache row (embeds are memory-only, E5-R26), emits no event, never uses or fills the recall cache, never calls an LLM, runs at background (low, evictable) priority. It warms in-memory caches (the provider's embedding cache, loaded models, the neo worker); a cold local model cache still downloads model files, as any first model load does. A warm recall can also answer blocks [] with degraded "warm-failed" (the warm path failed), "aborted", "timeout", "queue-full" or "pressure" (shed at background priority), or "engine-closed"; a workspace whose policy disables memory answers an empty success. |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.0.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "RecallQuery",
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "principal": {
      "$ref": "#/$defs/Principal",
      "x-since": "1.0.0"
    },
    "agent": {
      "$ref": "#/$defs/AgentContext",
      "x-since": "1.0.0"
    },
    "budget": {
      "type": "object",
      "properties": {
        "softMs": {
          "type": "number",
          "x-since": "1.0.0"
        },
        "hardMs": {
          "type": "number",
          "x-since": "1.0.0"
        },
        "capChars": {
          "type": "number",
          "x-since": "1.0.0"
        }
      },
      "additionalProperties": false,
      "x-since": "1.4.0"
    },
    "compactedAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.0.0"
    },
    "previousUserTurnAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.0.0"
    },
    "validAt": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "warmOnly": {
      "type": "boolean",
      "description": "1.9.0: run only the read-only heavy path (neo prelude reads, query embedding, read-only store open, vector search, rerank) and answer { blocks: [], degraded: null, timing } on success. Writes no memory data, no store, no file and no persistent embedding-cache row (embeds are memory-only, E5-R26), emits no event, never uses or fills the recall cache, never calls an LLM, runs at background (low, evictable) priority. It warms in-memory caches (the provider's embedding cache, loaded models, the neo worker); a cold local model cache still downloads model files, as any first model load does. A warm recall can also answer blocks [] with degraded \"warm-failed\" (the warm path failed), \"aborted\", \"timeout\", \"queue-full\" or \"pressure\" (shed at background priority), or \"engine-closed\"; a workspace whose policy disables memory answers an empty success.",
      "x-since": "1.9.0"
    }
  },
  "required": [
    "query",
    "principal",
    "agent"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.0.0"
    }
  },
  "x-since": "1.0.0",
  "description": "Recall Query in the engine contract."
}
```

## `VectorSpaceIdentity`

**Since:** 1.14.0

Canonical vector-space identity; credentials and transport are excluded.

**Type:** `{ provider: string; model: string; revision: string; dimension: number; normalization: string; prefixScheme: string; instruction: string; dtype: string; artifacts?: Array<{ path: string; sha256: string }>; tokenCap?: number \| null; pooling?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `provider` | `string` | yes | 1.14.0 |  |
| `model` | `string` | yes | 1.14.0 |  |
| `revision` | `string` | yes | 1.14.0 |  |
| `dimension` | `number` | yes | 1.14.0 |  |
| `normalization` | `string` | yes | 1.14.0 |  |
| `prefixScheme` | `string` | yes | 1.14.0 |  |
| `instruction` | `string` | yes | 1.14.0 |  |
| `dtype` | `string` | yes | 1.14.0 |  |
| `artifacts` | `Array<{ path: string; sha256: string }>` | no | 1.14.0 |  |
| `tokenCap` | `number \| null` | no | 1.14.0 |  |
| `pooling` | `string` | no | 1.14.0 |  |

**Schema**

```json
{
  "title": "VectorSpaceIdentity",
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "revision": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "dimension": {
      "type": "number",
      "x-since": "1.14.0"
    },
    "normalization": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "prefixScheme": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "instruction": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "dtype": {
      "type": "string",
      "x-since": "1.14.0"
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "x-since": "1.0.0"
          },
          "sha256": {
            "type": "string",
            "x-since": "1.0.0"
          }
        },
        "required": [
          "path",
          "sha256"
        ],
        "additionalProperties": false
      },
      "x-since": "1.14.0"
    },
    "tokenCap": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.14.0"
    },
    "pooling": {
      "type": "string",
      "x-since": "1.14.0"
    }
  },
  "required": [
    "provider",
    "model",
    "revision",
    "dimension",
    "normalization",
    "prefixScheme",
    "instruction",
    "dtype"
  ],
  "additionalProperties": false,
  "x-since": "1.14.0",
  "description": "Canonical vector-space identity; credentials and transport are excluded."
}
```

## `Degraded`

**Since:** 1.0.0

Degraded in the engine contract.

**Type:** `{ reason: string; capability: string; detail?: string; identities?: Array<{ identityId: string; code: string }> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `reason` | `string` | yes | 1.0.0 |  |
| `capability` | `string` | yes | 1.0.0 |  |
| `detail` | `string` | no | 1.0.0 |  |
| `identities` | `Array<{ identityId: string; code: string }>` | no | 1.14.0 |  |

**Schema**

```json
{
  "title": "Degraded",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "capability": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "detail": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "identities": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "identityId": {
            "type": "string",
            "x-since": "1.0.0"
          },
          "code": {
            "type": "string",
            "x-since": "1.0.0"
          }
        },
        "required": [
          "identityId",
          "code"
        ],
        "additionalProperties": false
      },
      "x-since": "1.14.0"
    }
  },
  "required": [
    "reason",
    "capability"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Degraded in the engine contract."
}
```

## `DecisionTrace`

**Since:** 1.0.0

Decision Trace in the engine contract.

**Type:** `{ [key: string]: unknown }`

**Schema**

```json
{
  "title": "DecisionTrace",
  "type": "object",
  "properties": {},
  "additionalProperties": {},
  "x-since": "1.0.0",
  "description": "Decision Trace in the engine contract."
}
```

## `Deferral`

**Since:** 1.4.0

A block the host's joiner clipped or dropped to fit `capChars`.

**Type:** `{ block: ContextBlockName; kind: "clipped" \| "dropped"; from: number; to: number; reason: "global-cap" \| "memories-cap" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `block` | `ContextBlockName` | yes | 1.4.0 |  |
| `kind` | `"clipped" \| "dropped"` | yes | 1.4.0 |  |
| `from` | `number` | yes | 1.4.0 |  |
| `to` | `number` | yes | 1.4.0 |  |
| `reason` | `"global-cap" \| "memories-cap"` | yes | 1.4.0 |  |

**Schema**

```json
{
  "title": "Deferral",
  "type": "object",
  "properties": {
    "block": {
      "$ref": "#/$defs/ContextBlockName",
      "x-since": "1.4.0"
    },
    "kind": {
      "type": "string",
      "enum": [
        "clipped",
        "dropped"
      ],
      "x-since": "1.4.0"
    },
    "from": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "to": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "reason": {
      "type": "string",
      "enum": [
        "global-cap",
        "memories-cap"
      ],
      "x-since": "1.4.0"
    }
  },
  "required": [
    "block",
    "kind",
    "from",
    "to",
    "reason"
  ],
  "additionalProperties": false,
  "x-since": "1.4.0",
  "description": "A block the host's joiner clipped or dropped to fit `capChars`."
}
```

## `RecallTiming`

**Since:** 1.4.0

1.9.0: `totalMs` runs from `Engine.recall` entry (for the plugin host hook path: assembler entry); `phases.completed` begins with `entry` (Engine.recall only), `queue` and `prelude`.

**Type:** `{ phases: { [key: string]: unknown } \| null; totalMs: number; namespacePhases?: Array<{ namespace: string \| null; phase: string; ms: number }> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `phases` | `{ [key: string]: unknown } \| null` | yes | 1.4.0 |  |
| `totalMs` | `number` | yes | 1.4.0 |  |
| `namespacePhases` | `Array<{ namespace: string \| null; phase: string; ms: number }>` | no | 1.4.0 |  |

**Schema**

```json
{
  "title": "RecallTiming",
  "type": "object",
  "properties": {
    "phases": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": {}
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.4.0"
    },
    "totalMs": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "namespacePhases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "namespace": {
            "type": [
              "string",
              "null"
            ],
            "x-since": "1.4.0",
            "description": "Namespace identifier, or null for the default namespace. The pinned runtime returns null; see DRIFT.json."
          },
          "phase": {
            "type": "string",
            "x-since": "1.0.0"
          },
          "ms": {
            "type": "number",
            "x-since": "1.0.0"
          }
        },
        "required": [
          "namespace",
          "phase",
          "ms"
        ],
        "additionalProperties": false
      },
      "x-since": "1.4.0"
    }
  },
  "required": [
    "phases",
    "totalMs"
  ],
  "additionalProperties": false,
  "x-since": "1.4.0",
  "description": "1.9.0: `totalMs` runs from `Engine.recall` entry (for the plugin host hook path: assembler entry); `phases.completed` begins with `entry` (Engine.recall only), `queue` and `prelude`."
}
```

## `RecallResult`

**Since:** 1.0.0

Recall Result in the engine contract.

**Type:** `{ diagnostics?: Array<PerCallDiagnostic>; blocks: Array<ContextBlock>; capChars: number \| null; degraded: Degraded \| null; trace?: DecisionTrace; timing: RecallTiming; deferrals: Array<Deferral> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `diagnostics` | `Array<PerCallDiagnostic>` | no | 1.0.0 |  |
| `blocks` | `Array<ContextBlock>` | yes | 1.0.0 |  |
| `capChars` | `number \| null` | yes | 1.0.0 | Character cap, or null for the JSON representation of an uncapped non-finite limit (Infinity in Node). |
| `degraded` | `Degraded \| null` | yes | 1.0.0 | null means not degraded. Structured, never a bare boolean (B8). |
| `trace` | `DecisionTrace` | no | 1.0.0 |  |
| `timing` | `RecallTiming` | yes | 1.4.0 |  |
| `deferrals` | `Array<Deferral>` | yes | 1.4.0 |  |

**Schema**

```json
{
  "title": "RecallResult",
  "type": "object",
  "properties": {
    "diagnostics": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/PerCallDiagnostic"
      },
      "x-since": "1.0.0"
    },
    "blocks": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ContextBlock"
      },
      "x-since": "1.0.0"
    },
    "capChars": {
      "type": [
        "number",
        "null"
      ],
      "description": "Character cap, or null for the JSON representation of an uncapped non-finite limit (Infinity in Node).",
      "x-since": "1.0.0"
    },
    "degraded": {
      "anyOf": [
        {
          "$ref": "#/$defs/Degraded"
        },
        {
          "type": "null"
        }
      ],
      "description": "null means not degraded. Structured, never a bare boolean (B8).",
      "x-since": "1.0.0"
    },
    "trace": {
      "$ref": "#/$defs/DecisionTrace",
      "x-since": "1.0.0"
    },
    "timing": {
      "$ref": "#/$defs/RecallTiming",
      "x-since": "1.4.0"
    },
    "deferrals": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/Deferral"
      },
      "x-since": "1.4.0"
    }
  },
  "required": [
    "blocks",
    "capChars",
    "degraded",
    "timing",
    "deferrals"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Recall Result in the engine contract."
}
```

## `TurnRecord`

**Since:** 1.0.0

Turn Record in the engine contract.

**Type:** `{ agentId: AgentId; principal: Principal; agent: AgentContext; messages: Array<Message>; runId?: string; sessionKey?: string; incognito: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.0.0 |  |
| `principal` | `Principal` | yes | 1.0.0 |  |
| `agent` | `AgentContext` | yes | 1.0.0 |  |
| `messages` | `Array<Message>` | yes | 1.0.0 |  |
| `runId` | `string` | no | 1.0.0 |  |
| `sessionKey` | `string` | no | 1.0.0 |  |
| `incognito` | `boolean` | yes | 1.0.0 | Classified by the host, fail-closed. |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.0.0 | Caller cancellation is carried by the Rust-only TurnRecord.cancel field, which is omitted from JSON. |

**Schema**

```json
{
  "title": "TurnRecord",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.0.0"
    },
    "principal": {
      "$ref": "#/$defs/Principal",
      "x-since": "1.0.0"
    },
    "agent": {
      "$ref": "#/$defs/AgentContext",
      "x-since": "1.0.0"
    },
    "messages": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/Message"
      },
      "x-since": "1.0.0"
    },
    "runId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "sessionKey": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "incognito": {
      "type": "boolean",
      "description": "Classified by the host, fail-closed.",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "agentId",
    "principal",
    "agent",
    "messages",
    "incognito"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Caller cancellation is carried by the Rust-only TurnRecord.cancel field, which is omitted from JSON.",
      "x-since": "1.0.0"
    }
  },
  "x-since": "1.0.0",
  "description": "Turn Record in the engine contract.",
  "x-rust-cancel-field": "cancel"
}
```

## `CaptureOptions`

**Since:** 1.0.0

Call-local refinement scheduling; true requires postTurnRefineScheduled, otherwise inline + diagnostic.

**Type:** `{ deferPostTurnLlm?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `deferPostTurnLlm` | `boolean` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "CaptureOptions",
  "type": "object",
  "properties": {
    "deferPostTurnLlm": {
      "type": "boolean",
      "x-since": "1.0.0"
    }
  },
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Call-local refinement scheduling; true requires postTurnRefineScheduled, otherwise inline + diagnostic."
}
```

## `CaptureResult`

**Since:** 1.0.0

Capture Result in the engine contract.

**Type:** `{ diagnostics?: Array<PerCallDiagnostic>; stored: number; skipped: number; reason?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `diagnostics` | `Array<PerCallDiagnostic>` | no | 1.0.0 |  |
| `stored` | `number` | yes | 1.0.0 |  |
| `skipped` | `number` | yes | 1.0.0 |  |
| `reason` | `string` | no | 1.0.0 | "duplicate-turn": the same turn was already captured (Q3, E4). |

**Schema**

```json
{
  "title": "CaptureResult",
  "type": "object",
  "properties": {
    "diagnostics": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/PerCallDiagnostic"
      },
      "x-since": "1.0.0"
    },
    "stored": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "skipped": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "reason": {
      "type": "string",
      "description": "\"duplicate-turn\": the same turn was already captured (Q3, E4).",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "stored",
    "skipped"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Capture Result in the engine contract."
}
```

## `CaptureHandle`

**Since:** 1.0.0

Non-blocking by contract (B8, ADR-002 "capture returns in < 5 ms"): the caller gets the handle immediately and may await `done` or abandon it.

**Type:** `{ id: string; acceptedAt: number }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.0.0 |  |
| `acceptedAt` | `number` | yes | 1.0.0 |  |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `done` | 1.0.0 | Completion is received through the Rust capture result channel. |

| Method signature | Since | Description |
|---|---|---|
| `abort(reason?: string): null` | 1.0.0 |  |

**Schema**

```json
{
  "title": "CaptureHandle",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "acceptedAt": {
      "type": "number",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "id",
    "acceptedAt"
  ],
  "additionalProperties": false,
  "x-methods": {
    "abort": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "reason",
          "optional": true,
          "schema": {
            "type": "string"
          }
        }
      ],
      "returns": {
        "type": "null"
      }
    }
  },
  "x-runtime-properties": {
    "done": {
      "description": "Completion is received through the Rust capture result channel.",
      "x-since": "1.0.0"
    }
  },
  "x-since": "1.0.0",
  "description": "Non-blocking by contract (B8, ADR-002 \"capture returns in < 5 ms\"): the caller gets the handle immediately and may await `done` or abandon it.",
  "x-runtime": true
}
```

## `CheckpointReason`

**Since:** 1.0.0

Checkpoint Reason in the engine contract.

**Type:** `"compaction" \| "session-end" \| "shutdown" \| "manual"`

| Enum member | Since |
|---|---|
| `session-end` | 1.4.0 |

**Schema**

```json
{
  "title": "CheckpointReason",
  "type": "string",
  "enum": [
    "compaction",
    "session-end",
    "shutdown",
    "manual"
  ],
  "x-since": "1.0.0",
  "description": "Checkpoint Reason in the engine contract.",
  "x-enum-since": {
    "session-end": "1.4.0"
  }
}
```

## `CheckpointResult`

**Since:** 1.0.0

Checkpoint Result in the engine contract.

**Type:** `{ agentId: AgentId; reason: CheckpointReason; digest: string; written: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.0.0 |  |
| `reason` | `CheckpointReason` | yes | 1.0.0 |  |
| `digest` | `string` | yes | 1.0.0 | Idempotency key over the transcript digest. |
| `written` | `boolean` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "CheckpointResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.0.0"
    },
    "reason": {
      "$ref": "#/$defs/CheckpointReason",
      "x-since": "1.0.0"
    },
    "digest": {
      "type": "string",
      "description": "Idempotency key over the transcript digest.",
      "x-since": "1.0.0"
    },
    "written": {
      "type": "boolean",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "agentId",
    "reason",
    "digest",
    "written"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Checkpoint Result in the engine contract."
}
```

## `JobName`

**Since:** 1.4.0

Job Name in the engine contract.

**Type:** `"persona-evolve" \| "afterthought" \| "consolidate-daily" \| "auto-accept-stale" \| "embedding-drain" \| "emotion-refine" \| "post-turn-refine" \| "classify-recent" \| "rem-dream" \| "skill-miner" \| "discover-semantic-links" \| "gc-run" \| "reminder-dispatch" \| "feedback-report" \| "proactive-check" \| "meta-reflect" \| "skill-benefit-backfill" \| "episodes-rebuild" \| "light-dream" \| "knowledge-update"`

| Enum member | Since |
|---|---|
| `post-turn-refine` | 1.10.0 |
| `knowledge-update` | a1-pending |

**Schema**

```json
{
  "title": "JobName",
  "type": "string",
  "enum": [
    "persona-evolve",
    "afterthought",
    "consolidate-daily",
    "auto-accept-stale",
    "embedding-drain",
    "emotion-refine",
    "post-turn-refine",
    "classify-recent",
    "rem-dream",
    "skill-miner",
    "discover-semantic-links",
    "gc-run",
    "reminder-dispatch",
    "feedback-report",
    "proactive-check",
    "meta-reflect",
    "skill-benefit-backfill",
    "episodes-rebuild",
    "light-dream",
    "knowledge-update"
  ],
  "x-since": "1.4.0",
  "description": "Job Name in the engine contract.",
  "x-enum-since": {
    "post-turn-refine": "1.10.0",
    "knowledge-update": "a1-pending"
  }
}
```

## `JobSpec`

**Since:** 1.4.0

Job Spec in the engine contract.

**Type:** `{ name: JobName; needsLlm: boolean; singleton: boolean; defaultSchedule?: { kind: "cron" \| "every"; expr: string; timezone?: string }; phase?: "light" \| "rem" \| "deep" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `name` | `JobName` | yes | 1.4.0 |  |
| `needsLlm` | `boolean` | yes | 1.4.0 |  |
| `singleton` | `boolean` | yes | 1.4.0 |  |
| `defaultSchedule` | `{ kind: "cron" \| "every"; expr: string; timezone?: string }` | no | 1.4.0 |  |
| `phase` | `"light" \| "rem" \| "deep"` | no | 1.4.0 |  |

**Schema**

```json
{
  "title": "JobSpec",
  "type": "object",
  "properties": {
    "name": {
      "$ref": "#/$defs/JobName",
      "x-since": "1.4.0"
    },
    "needsLlm": {
      "type": "boolean",
      "x-since": "1.4.0"
    },
    "singleton": {
      "type": "boolean",
      "x-since": "1.4.0"
    },
    "defaultSchedule": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "cron",
            "every"
          ],
          "x-since": "1.0.0"
        },
        "expr": {
          "type": "string",
          "x-since": "1.0.0"
        },
        "timezone": {
          "type": "string",
          "x-since": "1.0.0"
        }
      },
      "required": [
        "kind",
        "expr"
      ],
      "additionalProperties": false,
      "x-since": "1.4.0"
    },
    "phase": {
      "type": "string",
      "enum": [
        "light",
        "rem",
        "deep"
      ],
      "x-since": "1.4.0"
    }
  },
  "required": [
    "name",
    "needsLlm",
    "singleton"
  ],
  "additionalProperties": false,
  "x-since": "1.4.0",
  "description": "Job Spec in the engine contract."
}
```

## `JobOutcome`

**Since:** 1.4.0

Job Outcome in the engine contract.

**Type:** `"completed" \| "skipped" \| "incomplete" \| "failed" \| "abandoned"`

**Schema**

```json
{
  "title": "JobOutcome",
  "type": "string",
  "enum": [
    "completed",
    "skipped",
    "incomplete",
    "failed",
    "abandoned"
  ],
  "x-since": "1.4.0",
  "description": "Job Outcome in the engine contract."
}
```

## `JobTrigger`

**Since:** 1.4.1

"unknown" only on a crash row recovered from a corrupt start marker (1.4.1).

**Type:** `"cron" \| "manual" \| "harness" \| "capture" \| "unknown"`

**Schema**

```json
{
  "title": "JobTrigger",
  "type": "string",
  "enum": [
    "cron",
    "manual",
    "harness",
    "capture",
    "unknown"
  ],
  "x-since": "1.4.1",
  "description": "\"unknown\" only on a crash row recovered from a corrupt start marker (1.4.1)."
}
```

## `JobCost`

**Since:** 1.4.0

Job Cost in the engine contract.

**Type:** `{ ms: number; provider?: string; model?: string; inputTokens?: number; outputTokens?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `ms` | `number` | yes | 1.4.0 |  |
| `provider` | `string` | no | 1.4.0 |  |
| `model` | `string` | no | 1.4.0 |  |
| `inputTokens` | `number` | no | 1.4.0 |  |
| `outputTokens` | `number` | no | 1.4.0 |  |

**Schema**

```json
{
  "title": "JobCost",
  "type": "object",
  "properties": {
    "ms": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "provider": {
      "type": "string",
      "x-since": "1.4.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.4.0"
    },
    "inputTokens": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "outputTokens": {
      "type": "number",
      "x-since": "1.4.0"
    }
  },
  "required": [
    "ms"
  ],
  "additionalProperties": false,
  "x-since": "1.4.0",
  "description": "Job Cost in the engine contract."
}
```

## `JobRun`

**Since:** 1.4.0

Job Run in the engine contract.

**Type:** `{ runId: string; job: JobName; phase: "light" \| "rem" \| "deep" \| null; agentId: AgentId; trigger: JobTrigger; startedAt: number; finishedAt: number; durationMs: number; outcome: JobOutcome; reason?: string; attempt: number; cost: JobCost; counts: { [key: string]: number }; idempotencyKey?: string; keys?: Array<string>; pendingKeys?: Array<string>; diary?: { written: boolean; reason?: string }; migrated?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `runId` | `string` | yes | 1.4.0 |  |
| `job` | `JobName` | yes | 1.4.0 |  |
| `phase` | `"light" \| "rem" \| "deep" \| null` | yes | 1.4.0 |  |
| `agentId` | `AgentId` | yes | 1.4.0 |  |
| `trigger` | `JobTrigger` | yes | 1.4.0 |  |
| `startedAt` | `number` | yes | 1.4.0 |  |
| `finishedAt` | `number` | yes | 1.4.0 |  |
| `durationMs` | `number` | yes | 1.4.0 |  |
| `outcome` | `JobOutcome` | yes | 1.4.0 |  |
| `reason` | `string` | no | 1.4.0 |  |
| `attempt` | `number` | yes | 1.4.0 |  |
| `cost` | `JobCost` | yes | 1.4.0 |  |
| `counts` | `{ [key: string]: number }` | yes | 1.4.0 |  |
| `idempotencyKey` | `string` | no | 1.4.0 |  |
| `keys` | `Array<string>` | no | 1.4.0 |  |
| `pendingKeys` | `Array<string>` | no | 1.4.0 |  |
| `diary` | `{ written: boolean; reason?: string }` | no | 1.4.0 |  |
| `migrated` | `boolean` | no | 1.4.0 |  |

**Schema**

```json
{
  "title": "JobRun",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "x-since": "1.4.0"
    },
    "job": {
      "$ref": "#/$defs/JobName",
      "x-since": "1.4.0"
    },
    "phase": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "light"
          ]
        },
        {
          "type": "string",
          "enum": [
            "rem"
          ]
        },
        {
          "type": "string",
          "enum": [
            "deep"
          ]
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.4.0"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.4.0"
    },
    "trigger": {
      "$ref": "#/$defs/JobTrigger",
      "x-since": "1.4.0"
    },
    "startedAt": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "finishedAt": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "durationMs": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "outcome": {
      "$ref": "#/$defs/JobOutcome",
      "x-since": "1.4.0"
    },
    "reason": {
      "type": "string",
      "x-since": "1.4.0"
    },
    "attempt": {
      "type": "number",
      "x-since": "1.4.0"
    },
    "cost": {
      "$ref": "#/$defs/JobCost",
      "x-since": "1.4.0"
    },
    "counts": {
      "type": "object",
      "additionalProperties": {
        "type": "number"
      },
      "x-since": "1.4.0"
    },
    "idempotencyKey": {
      "type": "string",
      "x-since": "1.4.0"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "x-since": "1.4.0"
    },
    "pendingKeys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "x-since": "1.4.0"
    },
    "diary": {
      "type": "object",
      "properties": {
        "written": {
          "type": "boolean",
          "x-since": "1.0.0"
        },
        "reason": {
          "type": "string",
          "x-since": "1.0.0"
        }
      },
      "required": [
        "written"
      ],
      "additionalProperties": false,
      "x-since": "1.4.0"
    },
    "migrated": {
      "type": "boolean",
      "x-since": "1.4.0"
    }
  },
  "required": [
    "runId",
    "job",
    "phase",
    "agentId",
    "trigger",
    "startedAt",
    "finishedAt",
    "durationMs",
    "outcome",
    "attempt",
    "cost",
    "counts"
  ],
  "additionalProperties": false,
  "x-since": "1.4.0",
  "description": "Job Run in the engine contract."
}
```

## `JobRegistry`

**Since:** 1.4.0

Job Registry in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `list(): Array<JobSpec>` | 1.4.0 |  |
| `run(job: JobName, agentId: AgentId, opts?: { trigger?: JobTrigger; dryRun?: boolean }): JobRun` | 1.4.0 | `signal` is observed before start only (an already-aborted call is a recorded skip, reason "aborted"). `dryRun` is not supported in M1b-1: it resolves skipped/"dry_run_unsupported" without running or writing a ledger row. |
| `history(agentId: AgentId, opts?: { job?: JobName; since?: number; limit?: number }): Array<JobRun>` | 1.4.0 |  |

**Schema**

```json
{
  "title": "JobRegistry",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "list": {
      "x-since": "1.4.0",
      "parameters": [],
      "returns": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/JobSpec"
        }
      }
    },
    "run": {
      "x-since": "1.4.0",
      "parameters": [
        {
          "name": "job",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/JobName"
          }
        },
        {
          "name": "agentId",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentId"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "trigger": {
                "$ref": "#/$defs/JobTrigger",
                "x-since": "1.0.0"
              },
              "dryRun": {
                "type": "boolean",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false,
            "x-runtime-properties": {
              "signal": {
                "description": "Cancellation is supplied through the Rust Cancel parameter.",
                "x-since": "1.0.0"
              }
            }
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/JobRun"
      },
      "description": "`signal` is observed before start only (an already-aborted call is a recorded skip, reason \"aborted\"). `dryRun` is not supported in M1b-1: it resolves skipped/\"dry_run_unsupported\" without running or writing a ledger row."
    },
    "history": {
      "x-since": "1.4.0",
      "parameters": [
        {
          "name": "agentId",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentId"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "job": {
                "$ref": "#/$defs/JobName",
                "x-since": "1.0.0"
              },
              "since": {
                "type": "number",
                "x-since": "1.0.0"
              },
              "limit": {
                "type": "number",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/JobRun"
        }
      }
    }
  },
  "x-since": "1.4.0",
  "description": "Job Registry in the engine contract.",
  "x-runtime": true
}
```

## `EmbeddingIdentity`

**Since:** 1.0.0

Embedding Identity in the engine contract.

**Type:** `{ fingerprintId: string; provider: string; model: string; dimensions: number; space?: VectorSpaceIdentity }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `fingerprintId` | `string` | yes | 1.0.0 |  |
| `provider` | `string` | yes | 1.0.0 |  |
| `model` | `string` | yes | 1.0.0 |  |
| `dimensions` | `number` | yes | 1.0.0 |  |
| `space` | `VectorSpaceIdentity` | no | 1.14.0 | 1.14.0: full vector-space identity for routing and cache isolation. |

**Schema**

```json
{
  "title": "EmbeddingIdentity",
  "type": "object",
  "properties": {
    "fingerprintId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "provider": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "model": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "dimensions": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "space": {
      "$ref": "#/$defs/VectorSpaceIdentity",
      "description": "1.14.0: full vector-space identity for routing and cache isolation.",
      "x-since": "1.14.0"
    }
  },
  "required": [
    "fingerprintId",
    "provider",
    "model",
    "dimensions"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Embedding Identity in the engine contract."
}
```

## `RerankHit`

**Since:** 1.0.0

Rerank Hit in the engine contract.

**Type:** `{ index: number; score: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `index` | `number` | yes | 1.0.0 |  |
| `score` | `number` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "RerankHit",
  "type": "object",
  "properties": {
    "index": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "score": {
      "type": "number",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "index",
    "score"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Rerank Hit in the engine contract."
}
```

## `EmbeddingProbeError`

**Since:** 1.7.0

Embedding Probe Error in the engine contract.

**Type:** `"aborted" \| "provider-failed" \| "invalid-vector" \| "dimension-mismatch"`

**Schema**

```json
{
  "title": "EmbeddingProbeError",
  "type": "string",
  "enum": [
    "aborted",
    "provider-failed",
    "invalid-vector",
    "dimension-mismatch"
  ],
  "x-since": "1.7.0",
  "description": "Embedding Probe Error in the engine contract."
}
```

## `EmbeddingProbeResult`

**Since:** 1.7.0

Embedding Probe Result in the engine contract.

**Type:** `{ ok: boolean; error?: EmbeddingProbeError; cached: boolean; identity: EmbeddingIdentity; durationMs: number; checkedAt: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `ok` | `boolean` | yes | 1.7.0 | The provider returned a finite vector of `identity.dimensions`: the model is loaded and ready. |
| `error` | `EmbeddingProbeError` | no | 1.7.0 |  |
| `cached` | `boolean` | yes | 1.7.0 | true: the memoized result of an earlier successful probe of this engine; no provider call was made. |
| `identity` | `EmbeddingIdentity` | yes | 1.7.0 |  |
| `durationMs` | `number` | yes | 1.7.0 | Provider call time of the probe that produced this result. |
| `checkedAt` | `number` | yes | 1.7.0 | Clock time (host.clock) when that probe finished. |

**Schema**

```json
{
  "title": "EmbeddingProbeResult",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "description": "The provider returned a finite vector of `identity.dimensions`: the model is loaded and ready.",
      "x-since": "1.7.0"
    },
    "error": {
      "$ref": "#/$defs/EmbeddingProbeError",
      "x-since": "1.7.0"
    },
    "cached": {
      "type": "boolean",
      "description": "true: the memoized result of an earlier successful probe of this engine; no provider call was made.",
      "x-since": "1.7.0"
    },
    "identity": {
      "$ref": "#/$defs/EmbeddingIdentity",
      "x-since": "1.7.0"
    },
    "durationMs": {
      "type": "number",
      "description": "Provider call time of the probe that produced this result.",
      "x-since": "1.7.0"
    },
    "checkedAt": {
      "type": "number",
      "description": "Clock time (host.clock) when that probe finished.",
      "x-since": "1.7.0"
    }
  },
  "required": [
    "ok",
    "cached",
    "identity",
    "durationMs",
    "checkedAt"
  ],
  "additionalProperties": false,
  "x-since": "1.7.0",
  "description": "Embedding Probe Result in the engine contract."
}
```

## `EmbeddingEnvelopeIdentity`

**Since:** 1.7.0

The values a client must put into the IPC envelope next to the token.

**Type:** `{ model: string; dimensions: number; fingerprintId: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `model` | `string` | yes | 1.7.0 |  |
| `dimensions` | `number` | yes | 1.7.0 |  |
| `fingerprintId` | `string` | yes | 1.7.0 |  |

**Schema**

```json
{
  "title": "EmbeddingEnvelopeIdentity",
  "type": "object",
  "properties": {
    "model": {
      "type": "string",
      "x-since": "1.7.0"
    },
    "dimensions": {
      "type": "number",
      "x-since": "1.7.0"
    },
    "fingerprintId": {
      "type": "string",
      "x-since": "1.7.0"
    }
  },
  "required": [
    "model",
    "dimensions",
    "fingerprintId"
  ],
  "additionalProperties": false,
  "x-since": "1.7.0",
  "description": "The values a client must put into the IPC envelope next to the token."
}
```

## `EmbeddingServeResult`

**Since:** 1.7.0

Embedding Serve Result in the engine contract.

**Type:** `{ identity: EmbeddingEnvelopeIdentity \| null }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `identity` | `EmbeddingEnvelopeIdentity \| null` | yes | 1.7.0 |  |

**Schema**

```json
{
  "title": "EmbeddingServeResult",
  "type": "object",
  "properties": {
    "identity": {
      "anyOf": [
        {
          "$ref": "#/$defs/EmbeddingEnvelopeIdentity"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.7.0"
    }
  },
  "required": [
    "identity"
  ],
  "additionalProperties": false,
  "x-since": "1.7.0",
  "description": "Embedding Serve Result in the engine contract."
}
```

## `EmbeddingService`

**Since:** 1.0.0

probe(): exercises the provider once (a query embed of a fixed probe text with a per-engine nonce, so a persisted embedding cache cannot answer it) and memoizes a successful result; concurrent calls share one provider call; `refresh: true` forces a new provider call (queued behind a call already in flight, never answered by it). Never rejects for a provider failure (the result says `ok: false`) and has no timeout of its own: callers should pass a `signal` (the harness warm-up does); rejects with MemoryOpError `storage` ("engine is closed") after close(). serve(address): starts the engine's scoped-embedding IPC server on `address` (omitted → the platform default, `host.platform.ipcAddress(<baseDbPath>/control/embedding-ipc)`), without the loopback claim listener (ADR-001 C1). Idempotent for the address already served (same result object); `null` stops serving and resolves `{ address: null, tokenPath: null, identity: null }` (in-process only). `dispose()` stops that server if it is still the served one (fire and forget). close() stops serving. Rejects with MemoryOpError: `invalid-input` (malformed address, a kind the platform does not use, an unsafe socket directory), `conflict` (another address already served, the address in use, the host lifecycle owns the IPC, the engine is an IPC client), `storage` (closed, or the listener failed to start).

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `embed(texts: Array<string>, o: { kind: "query" \| "passage"; identity: EmbeddingIdentity }): Array<Array<number>>` | 1.0.0 |  |
| `rerank(query: string, docs: Array<string>, o: { topN: number }): Array<RerankHit>` | 1.0.0 |  |
| `probe(opts?: { refresh?: boolean }): EmbeddingProbeResult` | 1.7.0 |  |
| `identities(): Array<EmbeddingIdentity>` | 1.0.0 |  |
| `serve(address?: IpcAddress \| null): EmbeddingServeResult` | 1.7.0 |  |

**Schema**

```json
{
  "title": "EmbeddingService",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "embed": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "texts",
          "optional": false,
          "schema": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        {
          "name": "o",
          "optional": false,
          "schema": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "query",
                  "passage"
                ],
                "x-since": "1.0.0"
              },
              "identity": {
                "$ref": "#/$defs/EmbeddingIdentity",
                "x-since": "1.0.0"
              }
            },
            "required": [
              "kind",
              "identity"
            ],
            "additionalProperties": false,
            "x-runtime-properties": {
              "signal": {
                "description": "Cancellation is supplied through the Rust Cancel parameter.",
                "x-since": "1.0.0"
              }
            }
          }
        }
      ],
      "returns": {
        "type": "array",
        "items": {
          "type": "array",
          "items": {
            "type": "number",
            "format": "float"
          }
        }
      }
    },
    "rerank": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "query",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "docs",
          "optional": false,
          "schema": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        {
          "name": "o",
          "optional": false,
          "schema": {
            "type": "object",
            "properties": {
              "topN": {
                "type": "number",
                "x-since": "1.0.0"
              }
            },
            "required": [
              "topN"
            ],
            "additionalProperties": false,
            "x-runtime-properties": {
              "signal": {
                "description": "Cancellation is supplied through the Rust Cancel parameter.",
                "x-since": "1.0.0"
              }
            }
          }
        }
      ],
      "returns": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/RerankHit"
        }
      }
    },
    "probe": {
      "x-since": "1.7.0",
      "parameters": [
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "refresh": {
                "type": "boolean",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false,
            "x-runtime-properties": {
              "signal": {
                "description": "Cancellation is supplied through the Rust Cancel parameter.",
                "x-since": "1.0.0"
              }
            }
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/EmbeddingProbeResult"
      }
    },
    "identities": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/EmbeddingIdentity"
        }
      }
    },
    "serve": {
      "x-since": "1.7.0",
      "parameters": [
        {
          "name": "address",
          "optional": true,
          "schema": {
            "anyOf": [
              {
                "$ref": "#/$defs/IpcAddress"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/EmbeddingServeResult"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "probe(): exercises the provider once (a query embed of a fixed probe text with a per-engine nonce, so a persisted embedding cache cannot answer it) and memoizes a successful result; concurrent calls share one provider call; `refresh: true` forces a new provider call (queued behind a call already in flight, never answered by it). Never rejects for a provider failure (the result says `ok: false`) and has no timeout of its own: callers should pass a `signal` (the harness warm-up does); rejects with MemoryOpError `storage` (\"engine is closed\") after close(). serve(address): starts the engine's scoped-embedding IPC server on `address` (omitted → the platform default, `host.platform.ipcAddress(<baseDbPath>/control/embedding-ipc)`), without the loopback claim listener (ADR-001 C1). Idempotent for the address already served (same result object); `null` stops serving and resolves `{ address: null, tokenPath: null, identity: null }` (in-process only). `dispose()` stops that server if it is still the served one (fire and forget). close() stops serving. Rejects with MemoryOpError: `invalid-input` (malformed address, a kind the platform does not use, an unsafe socket directory), `conflict` (another address already served, the address in use, the host lifecycle owns the IPC, the engine is an IPC client), `storage` (closed, or the listener failed to start).",
  "x-runtime": true
}
```

## `ModelState`

**Since:** 1.8.0

Model State in the engine contract.

**Type:** `"loading" \| "ready" \| "failed" \| "disabled"`

**Schema**

```json
{
  "title": "ModelState",
  "type": "string",
  "enum": [
    "loading",
    "ready",
    "failed",
    "disabled"
  ],
  "x-since": "1.8.0",
  "description": "Model State in the engine contract."
}
```

## `RerankerProbeError`

**Since:** 1.8.0

Reranker Probe Error in the engine contract.

**Type:** `"aborted" \| "provider-failed" \| "invalid-result"`

**Schema**

```json
{
  "title": "RerankerProbeError",
  "type": "string",
  "enum": [
    "aborted",
    "provider-failed",
    "invalid-result"
  ],
  "x-since": "1.8.0",
  "description": "Reranker Probe Error in the engine contract."
}
```

## `ModelReadiness`

**Since:** 1.8.0

Model Readiness in the engine contract.

**Type:** `{ state: ModelState; warming: boolean; checkedAt: number \| null; error?: EmbeddingProbeError \| RerankerProbeError }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `state` | `ModelState` | yes | 1.8.0 | loading: not confirmed yet (checkedAt null) or first probe running; the embedder is never "disabled". |
| `warming` | `boolean` | yes | 1.8.0 | true while a probe is in flight. |
| `checkedAt` | `number \| null` | yes | 1.8.0 | Clock time of the completed probe that set `state`; null before any, and when disabled. |
| `error` | `EmbeddingProbeError \| RerankerProbeError` | no | 1.8.0 | Only when state === "failed". |

**Schema**

```json
{
  "title": "ModelReadiness",
  "type": "object",
  "properties": {
    "state": {
      "$ref": "#/$defs/ModelState",
      "description": "loading: not confirmed yet (checkedAt null) or first probe running; the embedder is never \"disabled\".",
      "x-since": "1.8.0"
    },
    "warming": {
      "type": "boolean",
      "description": "true while a probe is in flight.",
      "x-since": "1.8.0"
    },
    "checkedAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "description": "Clock time of the completed probe that set `state`; null before any, and when disabled.",
      "x-since": "1.8.0"
    },
    "error": {
      "anyOf": [
        {
          "$ref": "#/$defs/EmbeddingProbeError"
        },
        {
          "$ref": "#/$defs/RerankerProbeError"
        }
      ],
      "description": "Only when state === \"failed\".",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "state",
    "warming",
    "checkedAt"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Model Readiness in the engine contract."
}
```

## `ModelsStatus`

**Since:** 1.8.0

Models Status in the engine contract.

**Type:** `{ embedder: { state: ModelState; warming: boolean; checkedAt: number \| null; error?: EmbeddingProbeError \| RerankerProbeError; identity: EmbeddingIdentity }; reranker: { state: ModelState; warming: boolean; checkedAt: number \| null; error?: EmbeddingProbeError \| RerankerProbeError; provider: string \| null } }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `embedder` | `{ state: ModelState; warming: boolean; checkedAt: number \| null; error?: EmbeddingProbeError \| RerankerProbeError; identity: EmbeddingIdentity }` | yes | 1.8.0 |  |
| `reranker` | `{ state: ModelState; warming: boolean; checkedAt: number \| null; error?: EmbeddingProbeError \| RerankerProbeError; provider: string \| null }` | yes | 1.8.0 |  |

**Schema**

```json
{
  "title": "ModelsStatus",
  "type": "object",
  "properties": {
    "embedder": {
      "type": "object",
      "properties": {
        "state": {
          "$ref": "#/$defs/ModelState",
          "description": "loading: not confirmed yet (checkedAt null) or first probe running; the embedder is never \"disabled\".",
          "x-since": "1.8.0"
        },
        "warming": {
          "type": "boolean",
          "description": "true while a probe is in flight.",
          "x-since": "1.8.0"
        },
        "checkedAt": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "description": "Clock time of the completed probe that set `state`; null before any, and when disabled.",
          "x-since": "1.8.0"
        },
        "error": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmbeddingProbeError"
            },
            {
              "$ref": "#/$defs/RerankerProbeError"
            }
          ],
          "description": "Only when state === \"failed\".",
          "x-since": "1.8.0"
        },
        "identity": {
          "$ref": "#/$defs/EmbeddingIdentity",
          "x-since": "1.0.0"
        }
      },
      "required": [
        "state",
        "warming",
        "checkedAt",
        "identity"
      ],
      "additionalProperties": false,
      "x-since": "1.8.0"
    },
    "reranker": {
      "type": "object",
      "properties": {
        "state": {
          "$ref": "#/$defs/ModelState",
          "description": "loading: not confirmed yet (checkedAt null) or first probe running; the embedder is never \"disabled\".",
          "x-since": "1.8.0"
        },
        "warming": {
          "type": "boolean",
          "description": "true while a probe is in flight.",
          "x-since": "1.8.0"
        },
        "checkedAt": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "description": "Clock time of the completed probe that set `state`; null before any, and when disabled.",
          "x-since": "1.8.0"
        },
        "error": {
          "anyOf": [
            {
              "$ref": "#/$defs/EmbeddingProbeError"
            },
            {
              "$ref": "#/$defs/RerankerProbeError"
            }
          ],
          "description": "Only when state === \"failed\".",
          "x-since": "1.8.0"
        },
        "provider": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.0.0"
        }
      },
      "required": [
        "state",
        "warming",
        "checkedAt",
        "provider"
      ],
      "additionalProperties": false,
      "x-since": "1.8.0"
    }
  },
  "required": [
    "embedder",
    "reranker"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Models Status in the engine contract."
}
```

## `ModelsService`

**Since:** 1.8.0

warm(): probes embedder and reranker concurrently (embedding.probe semantics: coalesced, memoized on success, `refresh` forces new provider calls, `signal` ends only this caller's wait) and resolves the status afterwards. Never rejects for a provider failure; rejects MemoryOpError `storage` ("engine is closed") after close().

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `status(): ModelsStatus` | 1.8.0 |  |
| `warm(opts?: { refresh?: boolean }): ModelsStatus` | 1.8.0 |  |

**Schema**

```json
{
  "title": "ModelsService",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "status": {
      "x-since": "1.8.0",
      "parameters": [],
      "returns": {
        "$ref": "#/$defs/ModelsStatus"
      }
    },
    "warm": {
      "x-since": "1.8.0",
      "parameters": [
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "refresh": {
                "type": "boolean",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false,
            "x-runtime-properties": {
              "signal": {
                "description": "Cancellation is supplied through the Rust Cancel parameter.",
                "x-since": "1.0.0"
              }
            }
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/ModelsStatus"
      }
    }
  },
  "x-since": "1.8.0",
  "description": "warm(): probes embedder and reranker concurrently (embedding.probe semantics: coalesced, memoized on success, `refresh` forces new provider calls, `signal` ends only this caller's wait) and resolves the status afterwards. Never rejects for a provider failure; rejects MemoryOpError `storage` (\"engine is closed\") after close().",
  "x-runtime": true
}
```

## `ShareResult`

**Since:** 1.5.0

Share Result in the engine contract.

**Type:** `MemoryShareResult`

**Schema**

```json
{
  "title": "ShareResult",
  "$ref": "#/$defs/MemoryShareResult",
  "x-since": "1.5.0",
  "description": "Share Result in the engine contract."
}
```

## `ForgetResult`

**Since:** 1.5.0

Forget Result in the engine contract.

**Type:** `MemoryForgetResult`

**Schema**

```json
{
  "title": "ForgetResult",
  "$ref": "#/$defs/MemoryForgetResult",
  "x-since": "1.5.0",
  "description": "Forget Result in the engine contract."
}
```

## `MigrationResult`

**Since:** 1.6.0

`applied` is false when `from === to`. Both are decimal strings ("0" = a store written before any marker existed).

**Type:** `{ from: SchemaVersion; to: SchemaVersion; applied: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `from` | `SchemaVersion` | yes | 1.6.0 |  |
| `to` | `SchemaVersion` | yes | 1.6.0 |  |
| `applied` | `boolean` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MigrationResult",
  "type": "object",
  "properties": {
    "from": {
      "$ref": "#/$defs/SchemaVersion",
      "x-since": "1.6.0"
    },
    "to": {
      "$ref": "#/$defs/SchemaVersion",
      "x-since": "1.6.0"
    },
    "applied": {
      "type": "boolean",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "from",
    "to",
    "applied"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "`applied` is false when `from === to`. Both are decimal strings (\"0\" = a store written before any marker existed)."
}
```

## `ObsidianVaultCandidate`

**Since:** 1.6.0

Obsidian Vault Candidate in the engine contract.

**Type:** `{ path: string; isVault: boolean; confirmed: boolean; source: "config" \| "workspace" \| "candidate" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `path` | `string` | yes | 1.6.0 | Absolute, normalised path. Input may be `~/…` or home-relative; the engine expands it. |
| `isVault` | `boolean` | yes | 1.6.0 | `.obsidian/workspace.json` or `.obsidian/app.json` exists. |
| `confirmed` | `boolean` | yes | 1.6.0 | A confirmation receipt for this agent, workspace and vault exists (lib/obsidian-vault-authority.js). |
| `source` | `"config" \| "workspace" \| "candidate"` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianVaultCandidate",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute, normalised path. Input may be `~/…` or home-relative; the engine expands it.",
      "x-since": "1.6.0"
    },
    "isVault": {
      "type": "boolean",
      "description": "`.obsidian/workspace.json` or `.obsidian/app.json` exists.",
      "x-since": "1.6.0"
    },
    "confirmed": {
      "type": "boolean",
      "description": "A confirmation receipt for this agent, workspace and vault exists (lib/obsidian-vault-authority.js).",
      "x-since": "1.6.0"
    },
    "source": {
      "type": "string",
      "enum": [
        "config",
        "workspace",
        "candidate"
      ],
      "x-since": "1.6.0"
    }
  },
  "required": [
    "path",
    "isVault",
    "confirmed",
    "source"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Obsidian Vault Candidate in the engine contract."
}
```

## `ObsidianDetectResult`

**Since:** 1.6.0

Obsidian Detect Result in the engine contract.

**Type:** `{ agentId: AgentId; vaults: Array<ObsidianVaultCandidate> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.6.0 |  |
| `vaults` | `Array<ObsidianVaultCandidate>` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianDetectResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "vaults": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ObsidianVaultCandidate"
      },
      "x-since": "1.6.0"
    }
  },
  "required": [
    "agentId",
    "vaults"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Obsidian Detect Result in the engine contract."
}
```

## `ObsidianPrepareResult`

**Since:** 1.6.0

Obsidian Prepare Result in the engine contract.

**Type:** `{ nonce: string; expiresAt: number; vaultPath: string; vaultDigest: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `nonce` | `string` | yes | 1.6.0 |  |
| `expiresAt` | `number` | yes | 1.6.0 |  |
| `vaultPath` | `string` | yes | 1.6.0 |  |
| `vaultDigest` | `string` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianPrepareResult",
  "type": "object",
  "properties": {
    "nonce": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "expiresAt": {
      "type": "number",
      "x-since": "1.6.0"
    },
    "vaultPath": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "vaultDigest": {
      "type": "string",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "nonce",
    "expiresAt",
    "vaultPath",
    "vaultDigest"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Obsidian Prepare Result in the engine contract."
}
```

## `ObsidianConfirmResult`

**Since:** 1.6.0

Obsidian Confirm Result in the engine contract.

**Type:** `{ confirmed: true; vaultPath: string; vaultDigest: string; alreadyConfirmed: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `confirmed` | `true` | yes | 1.6.0 |  |
| `vaultPath` | `string` | yes | 1.6.0 |  |
| `vaultDigest` | `string` | yes | 1.6.0 |  |
| `alreadyConfirmed` | `boolean` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianConfirmResult",
  "type": "object",
  "properties": {
    "confirmed": {
      "type": "boolean",
      "enum": [
        true
      ],
      "x-since": "1.6.0"
    },
    "vaultPath": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "vaultDigest": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "alreadyConfirmed": {
      "type": "boolean",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "confirmed",
    "vaultPath",
    "vaultDigest",
    "alreadyConfirmed"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Obsidian Confirm Result in the engine contract."
}
```

## `ObsidianOps`

**Since:** 1.6.0

Host-neutral Obsidian setup: explicit paths, no host runtime. `prepare` and `confirm` are user-originated (`a.origin === "user"`, `a.background === false`) and need a proved principal with a user; the nonce expires after 10 minutes and is consumed by the first `confirm`. Every member rejects with MemoryOpError (`not-found`, `denied`, `invalid-input`, `storage`).

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `detect(p: Principal, a: AgentContext, opts?: { candidates?: Array<string> }): ObsidianDetectResult` | 1.6.0 |  |
| `prepare(vaultPath: string, p: Principal, a: AgentContext): ObsidianPrepareResult` | 1.6.0 |  |
| `confirm(nonce: string, p: Principal, a: AgentContext): ObsidianConfirmResult` | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianOps",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "detect": {
      "x-since": "1.6.0",
      "parameters": [
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "x-since": "1.6.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/ObsidianDetectResult"
      }
    },
    "prepare": {
      "x-since": "1.6.0",
      "parameters": [
        {
          "name": "vaultPath",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/ObsidianPrepareResult"
      }
    },
    "confirm": {
      "x-since": "1.6.0",
      "parameters": [
        {
          "name": "nonce",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/ObsidianConfirmResult"
      }
    }
  },
  "x-since": "1.6.0",
  "description": "Host-neutral Obsidian setup: explicit paths, no host runtime. `prepare` and `confirm` are user-originated (`a.origin === \"user\"`, `a.background === false`) and need a proved principal with a user; the nonce expires after 10 minutes and is consumed by the first `confirm`. Every member rejects with MemoryOpError (`not-found`, `denied`, `invalid-input`, `storage`).",
  "x-runtime": true
}
```

## `AdminOps`

**Since:** 1.5.0

Admin Ops in the engine contract.

**Type:** `{ obsidian: ObsidianOps }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `obsidian` | `ObsidianOps` | yes | 1.5.0 |  |

| Method signature | Since | Description |
|---|---|---|
| `share(id: string, target: "workspace" \| "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): MemoryShareResult` | 1.5.0 |  |
| `forget(id: string, p: Principal, a: AgentContext): MemoryForgetResult` | 1.5.0 |  |
| `reembedding.plan(): unknown` | 1.5.0 |  |
| `reembedding.apply(): unknown` | 1.5.0 |  |
| `reembedding.resume(): unknown` | 1.5.0 |  |
| `reembedding.validate(): unknown` | 1.17.0 | 1.17.0: `validate({ id })` moves a fully copied migration from `validating` to `ready_to_switch` after the target generation check and the semantic recall probe; on failure it rejects and the record stays `validating`. |
| `reembedding.rollback(): unknown` | 1.5.0 |  |
| `reembedding.status(): unknown` | 1.5.0 |  |
| `reembedding.switch(): unknown` | 1.5.0 |  |
| `workspacePolicy.get(): unknown` | 1.5.0 |  |
| `workspacePolicy.list(): unknown` | 1.5.0 |  |
| `workspacePolicy.set(patch: unknown): unknown` | 1.5.0 |  |
| `migrate(from: SchemaVersion, to: SchemaVersion): MigrationResult` | 1.5.0 | Store schema migration (E2, variant a). Rejects with MemoryOpError: `conflict` when `from` is not the store's current version, `invalid-input` for an unknown or downgrading `to`, `storage` when the marker is unreadable. |

**Schema**

```json
{
  "title": "AdminOps",
  "type": "object",
  "properties": {
    "obsidian": {
      "$ref": "#/$defs/ObsidianOps",
      "x-since": "1.5.0"
    }
  },
  "required": [
    "obsidian"
  ],
  "additionalProperties": false,
  "x-methods": {
    "share": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "target",
          "optional": false,
          "schema": {
            "type": "string",
            "enum": [
              "workspace",
              "user"
            ]
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "allowSensitive": {
                "type": "boolean",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryShareResult"
      }
    },
    "forget": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryForgetResult"
      }
    },
    "reembedding.plan": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "reembedding.apply": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "reembedding.resume": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "reembedding.validate": {
      "x-since": "1.17.0",
      "parameters": [],
      "returns": {},
      "description": "1.17.0: `validate({ id })` moves a fully copied migration from `validating` to `ready_to_switch` after the target generation check and the semantic recall probe; on failure it rejects and the record stays `validating`."
    },
    "reembedding.rollback": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "reembedding.status": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "reembedding.switch": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "workspacePolicy.get": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "workspacePolicy.list": {
      "x-since": "1.5.0",
      "parameters": [],
      "returns": {}
    },
    "workspacePolicy.set": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "patch",
          "optional": false,
          "schema": {}
        }
      ],
      "returns": {}
    },
    "migrate": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "from",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/SchemaVersion"
          }
        },
        {
          "name": "to",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/SchemaVersion"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MigrationResult"
      },
      "description": "Store schema migration (E2, variant a). Rejects with MemoryOpError: `conflict` when `from` is not the store's current version, `invalid-input` for an unknown or downgrading `to`, `storage` when the marker is unreadable."
    }
  },
  "x-since": "1.5.0",
  "description": "Admin Ops in the engine contract.",
  "x-runtime": true
}
```

## `MemoryOpErrorCode`

**Since:** 1.5.0

Reason codes a MemoryOps call can fail with. `not-found` also covers "exists but you may not see it" and "tombstoned" (anti-oracle).

**Type:** `"not-found" \| "denied" \| "invalid-input" \| "approval-required" \| "conflict" \| "storage" \| "unsupported" \| "identity-already-bound" \| "ledger-corrupt" \| "lock-lost" \| "lock-busy" \| "EMBEDDER_UNAVAILABLE" \| "EMBEDDING_IDENTITY_MISMATCH"`

| Enum member | Since |
|---|---|
| `unsupported` | 1.8.0 |
| `identity-already-bound` | 1.12.0 |
| `ledger-corrupt` | 1.12.0 |
| `lock-lost` | 1.12.0 |
| `lock-busy` | 1.13.0 |

**Schema**

```json
{
  "title": "MemoryOpErrorCode",
  "type": "string",
  "enum": [
    "not-found",
    "denied",
    "invalid-input",
    "approval-required",
    "conflict",
    "storage",
    "unsupported",
    "identity-already-bound",
    "ledger-corrupt",
    "lock-lost",
    "lock-busy",
    "EMBEDDER_UNAVAILABLE",
    "EMBEDDING_IDENTITY_MISMATCH"
  ],
  "x-since": "1.5.0",
  "description": "Reason codes a MemoryOps call can fail with. `not-found` also covers \"exists but you may not see it\" and \"tombstoned\" (anti-oracle).",
  "x-enum-since": {
    "unsupported": "1.8.0",
    "identity-already-bound": "1.12.0",
    "ledger-corrupt": "1.12.0",
    "lock-lost": "1.12.0",
    "lock-busy": "1.13.0"
  }
}
```

## `MemoryOpError`

**Since:** 1.5.0

Thrown by every MemoryOps member on failure; `code` is stable, `message` is English and log-safe.

**Type:** `{ name?: string; message: string; stack?: string; code: MemoryOpErrorCode; detail?: { [key: string]: string } }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `name` | `string` | no | 1.5.0 |  |
| `message` | `string` | yes | 1.5.0 |  |
| `stack` | `string` | no | 1.5.0 |  |
| `code` | `MemoryOpErrorCode` | yes | 1.5.0 |  |
| `detail` | `{ [key: string]: string }` | no | 1.6.0 | 1.6.0: non-secret ids a caller needs to recover (e.g. a half-finished shared-copy refresh). |

**Schema**

```json
{
  "title": "MemoryOpError",
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "stack": {
      "type": "string"
    },
    "code": {
      "$ref": "#/$defs/MemoryOpErrorCode",
      "x-since": "1.5.0"
    },
    "detail": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      },
      "description": "1.6.0: non-secret ids a caller needs to recover (e.g. a half-finished shared-copy refresh).",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "code",
    "message"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Thrown by every MemoryOps member on failure; `code` is stable, `message` is English and log-safe.",
  "x-runtime": true
}
```

## `MemoryScope`

**Since:** 1.5.0

Memory Scope in the engine contract.

**Type:** `"agent-private" \| "workspace" \| "user"`

**Schema**

```json
{
  "title": "MemoryScope",
  "type": "string",
  "enum": [
    "agent-private",
    "workspace",
    "user"
  ],
  "x-since": "1.5.0",
  "description": "Memory Scope in the engine contract."
}
```

## `MemoryCard`

**Since:** 1.5.0

Memory Card in the engine contract.

**Type:** `{ id: string; scope: MemoryScope; text: string; summary: string; createdAt: number \| null; origin: string \| null; epistemicStatus: string \| null; score?: number; sharedBy?: AgentId; sourceId?: string; provenance?: "imported"; sourceRef?: string; links?: Array<MemoryLink> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.5.0 |  |
| `scope` | `MemoryScope` | yes | 1.5.0 |  |
| `text` | `string` | yes | 1.5.0 |  |
| `summary` | `string` | yes | 1.5.0 |  |
| `createdAt` | `number \| null` | yes | 1.5.0 |  |
| `origin` | `string \| null` | yes | 1.5.0 |  |
| `epistemicStatus` | `string \| null` | yes | 1.5.0 |  |
| `score` | `number` | no | 1.5.0 | Present on list results from a topic query; absent on show. |
| `sharedBy` | `AgentId` | no | 1.6.0 | 1.6.0, only on workspace/user copies: the sharing agent and its original card. |
| `sourceId` | `string` | no | 1.6.0 |  |
| `provenance` | `"imported"` | no | 1.11.0 | 1.11.0: set when the card was written by `memory.import`. |
| `sourceRef` | `string` | no | 1.11.0 | 1.11.0: import source reference, truncated to ≤ 500 characters before store. |
| `links` | `Array<MemoryLink>` | no | 1.16.0 | 1.16.0: additional sources attached by `memory.link` (oldest first); absent when there are none. Recorded per agent: only the linking agent's show/list report them. |

**Schema**

```json
{
  "title": "MemoryCard",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "scope": {
      "$ref": "#/$defs/MemoryScope",
      "x-since": "1.5.0"
    },
    "text": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "summary": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "createdAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.5.0"
    },
    "origin": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.5.0"
    },
    "epistemicStatus": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.5.0"
    },
    "score": {
      "type": "number",
      "description": "Present on list results from a topic query; absent on show.",
      "x-since": "1.5.0"
    },
    "sharedBy": {
      "$ref": "#/$defs/AgentId",
      "description": "1.6.0, only on workspace/user copies: the sharing agent and its original card.",
      "x-since": "1.6.0"
    },
    "sourceId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "provenance": {
      "type": "string",
      "enum": [
        "imported"
      ],
      "description": "1.11.0: set when the card was written by `memory.import`.",
      "x-since": "1.11.0"
    },
    "sourceRef": {
      "type": "string",
      "description": "1.11.0: import source reference, truncated to ≤ 500 characters before store.",
      "x-since": "1.11.0"
    },
    "links": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryLink"
      },
      "description": "1.16.0: additional sources attached by `memory.link` (oldest first); absent when there are none. Recorded per agent: only the linking agent's show/list report them.",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "id",
    "scope",
    "text",
    "summary",
    "createdAt",
    "origin",
    "epistemicStatus"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory Card in the engine contract."
}
```

## `MemoryLink`

**Since:** 1.16.0

1.16.0: one additional source of a card, attached by `memory.link`.

**Type:** `{ linkId: string; sourceRef: string; provenance: MemoryImportProvenance; importRunId: string \| null; linkedAt: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `linkId` | `string` | yes | 1.16.0 | Deterministic over (agentId, card id, sourceRef); 32 hex characters. |
| `sourceRef` | `string` | yes | 1.16.0 |  |
| `provenance` | `MemoryImportProvenance` | yes | 1.16.0 |  |
| `importRunId` | `string \| null` | yes | 1.16.0 | The import run the link belongs to (explicit, or named in the sourceRef as `;run=<id>`); null when none. |
| `linkedAt` | `number` | yes | 1.16.0 | Epoch ms. |

**Schema**

```json
{
  "title": "MemoryLink",
  "type": "object",
  "properties": {
    "linkId": {
      "type": "string",
      "description": "Deterministic over (agentId, card id, sourceRef); 32 hex characters.",
      "x-since": "1.16.0"
    },
    "sourceRef": {
      "type": "string",
      "x-since": "1.16.0"
    },
    "provenance": {
      "$ref": "#/$defs/MemoryImportProvenance",
      "x-since": "1.16.0"
    },
    "importRunId": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "The import run the link belongs to (explicit, or named in the sourceRef as `;run=<id>`); null when none.",
      "x-since": "1.16.0"
    },
    "linkedAt": {
      "type": "number",
      "description": "Epoch ms.",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "linkId",
    "sourceRef",
    "provenance",
    "importRunId",
    "linkedAt"
  ],
  "additionalProperties": false,
  "x-since": "1.16.0",
  "description": "1.16.0: one additional source of a card, attached by `memory.link`."
}
```

## `MemoryLinkRequest`

**Since:** 1.16.0

1.16.0: argument of `MemoryOps.link`.

**Type:** `{ sourceRef: string; provenance: MemoryImportProvenance; importRunId?: string; idempotencyKey?: string; dryRun?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `sourceRef` | `string` | yes | 1.16.0 | 1–500 characters after trim (longer is `invalid-input`, never truncated: it is the idempotency key). |
| `provenance` | `MemoryImportProvenance` | yes | 1.16.0 |  |
| `importRunId` | `string` | no | 1.16.0 | `/^[A-Za-z0-9_-]{1,64}$/`. Absent: the run named in `sourceRef` (`;run=<id>`, rules as for import), else none. |
| `idempotencyKey` | `string` | no | 1.16.0 | The importer's key for the duplicate card (1–256); `unimport`'s `idempotencyKeys` filter matches it. |
| `dryRun` | `boolean` | no | 1.16.0 | Default false. True: checks and classifies, writes nothing, takes no lock. |

**Schema**

```json
{
  "title": "MemoryLinkRequest",
  "type": "object",
  "properties": {
    "sourceRef": {
      "type": "string",
      "description": "1–500 characters after trim (longer is `invalid-input`, never truncated: it is the idempotency key).",
      "x-since": "1.16.0"
    },
    "provenance": {
      "$ref": "#/$defs/MemoryImportProvenance",
      "x-since": "1.16.0"
    },
    "importRunId": {
      "type": "string",
      "description": "`/^[A-Za-z0-9_-]{1,64}$/`. Absent: the run named in `sourceRef` (`;run=<id>`, rules as for import), else none.",
      "x-since": "1.16.0"
    },
    "idempotencyKey": {
      "type": "string",
      "description": "The importer's key for the duplicate card (1–256); `unimport`'s `idempotencyKeys` filter matches it.",
      "x-since": "1.16.0"
    },
    "dryRun": {
      "type": "boolean",
      "description": "Default false. True: checks and classifies, writes nothing, takes no lock.",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "sourceRef",
    "provenance"
  ],
  "additionalProperties": false,
  "x-since": "1.16.0",
  "description": "1.16.0: argument of `MemoryOps.link`."
}
```

## `MemoryLinkOutcome`

**Since:** 1.16.0

`linked`: a new link was written. `already-linked`: this sourceRef is already linked (no-op; `importRunId` is the existing link's run). `already-source`: the card was itself imported from this sourceRef (no-op, `importRunId` null).

**Type:** `"linked" \| "already-linked" \| "already-source"`

**Schema**

```json
{
  "title": "MemoryLinkOutcome",
  "type": "string",
  "enum": [
    "linked",
    "already-linked",
    "already-source"
  ],
  "x-since": "1.16.0",
  "description": "`linked`: a new link was written. `already-linked`: this sourceRef is already linked (no-op; `importRunId` is the existing link's run). `already-source`: the card was itself imported from this sourceRef (no-op, `importRunId` null)."
}
```

## `MemoryLinkResult`

**Since:** 1.16.0

Memory Link Result in the engine contract.

**Type:** `{ id: string; linkId: string; outcome: MemoryLinkOutcome; importRunId: string \| null; dryRun: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.16.0 |  |
| `linkId` | `string` | yes | 1.16.0 |  |
| `outcome` | `MemoryLinkOutcome` | yes | 1.16.0 |  |
| `importRunId` | `string \| null` | yes | 1.16.0 |  |
| `dryRun` | `boolean` | yes | 1.16.0 |  |

**Schema**

```json
{
  "title": "MemoryLinkResult",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.16.0"
    },
    "linkId": {
      "type": "string",
      "x-since": "1.16.0"
    },
    "outcome": {
      "$ref": "#/$defs/MemoryLinkOutcome",
      "x-since": "1.16.0"
    },
    "importRunId": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.16.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "id",
    "linkId",
    "outcome",
    "importRunId",
    "dryRun"
  ],
  "additionalProperties": false,
  "x-since": "1.16.0",
  "description": "Memory Link Result in the engine contract."
}
```

## `MemoryListQuery`

**Since:** 1.5.0

Memory List Query in the engine contract.

**Type:** `{ topic?: string; since?: number; until?: number; limit?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `topic` | `string` | no | 1.5.0 | Topic query (vector search, best first). Exactly one of `topic` and `since` is required. |
| `since` | `number` | no | 1.5.0 | Epoch ms lower bound for a time listing (newest first). |
| `until` | `number` | no | 1.5.0 | Epoch ms upper bound; only with `since`, and not before it. Default: now. |
| `limit` | `number` | no | 1.5.0 | Default 20, maximum 100. |

**Schema**

```json
{
  "title": "MemoryListQuery",
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "Topic query (vector search, best first). Exactly one of `topic` and `since` is required.",
      "x-since": "1.5.0"
    },
    "since": {
      "type": "number",
      "description": "Epoch ms lower bound for a time listing (newest first).",
      "x-since": "1.5.0"
    },
    "until": {
      "type": "number",
      "description": "Epoch ms upper bound; only with `since`, and not before it. Default: now.",
      "x-since": "1.5.0"
    },
    "limit": {
      "type": "number",
      "description": "Default 20, maximum 100.",
      "x-since": "1.5.0"
    }
  },
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory List Query in the engine contract."
}
```

## `MemoryListResult`

**Since:** 1.5.0

Memory List Result in the engine contract.

**Type:** `{ agentId: AgentId; items: Array<MemoryCard>; truncated: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.5.0 |  |
| `items` | `Array<MemoryCard>` | yes | 1.5.0 |  |
| `truncated` | `boolean` | yes | 1.5.0 |  |

**Schema**

```json
{
  "title": "MemoryListResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.5.0"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryCard"
      },
      "x-since": "1.5.0"
    },
    "truncated": {
      "type": "boolean",
      "x-since": "1.5.0"
    }
  },
  "required": [
    "agentId",
    "items",
    "truncated"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory List Result in the engine contract."
}
```

## `MemoryForgetResult`

**Since:** 1.5.0

Memory Forget Result in the engine contract.

**Type:** `{ id: string; archived: boolean; tombstoneId: string \| null; alreadyForgotten: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.5.0 |  |
| `archived` | `boolean` | yes | 1.5.0 |  |
| `tombstoneId` | `string \| null` | yes | 1.5.0 |  |
| `alreadyForgotten` | `boolean` | yes | 1.5.0 |  |

**Schema**

```json
{
  "title": "MemoryForgetResult",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "archived": {
      "type": "boolean",
      "x-since": "1.5.0"
    },
    "tombstoneId": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.5.0"
    },
    "alreadyForgotten": {
      "type": "boolean",
      "x-since": "1.5.0"
    }
  },
  "required": [
    "id",
    "archived",
    "tombstoneId",
    "alreadyForgotten"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory Forget Result in the engine contract."
}
```

## `MemoryCorrectResult`

**Since:** 1.5.0

`id` is the id of the corrected (new, live) version — `correct` supersedes the old row, and the caller's old id is no longer live (fix round 1, E1-R8).

**Type:** `{ id: string; archived: true }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.5.0 |  |
| `archived` | `true` | yes | 1.5.0 |  |

**Schema**

```json
{
  "title": "MemoryCorrectResult",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "archived": {
      "type": "boolean",
      "enum": [
        true
      ],
      "x-since": "1.5.0"
    }
  },
  "required": [
    "id",
    "archived"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "`id` is the id of the corrected (new, live) version — `correct` supersedes the old row, and the caller's old id is no longer live (fix round 1, E1-R8)."
}
```

## `MemoryShareResult`

**Since:** 1.5.0

Memory Share Result in the engine contract.

**Type:** `{ sourceId: string; sharedId: string; target: "workspace" \| "user" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `sourceId` | `string` | yes | 1.5.0 |  |
| `sharedId` | `string` | yes | 1.5.0 |  |
| `target` | `"workspace" \| "user"` | yes | 1.5.0 |  |

**Schema**

```json
{
  "title": "MemoryShareResult",
  "type": "object",
  "properties": {
    "sourceId": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "sharedId": {
      "type": "string",
      "x-since": "1.5.0"
    },
    "target": {
      "type": "string",
      "enum": [
        "workspace",
        "user"
      ],
      "x-since": "1.5.0"
    }
  },
  "required": [
    "sourceId",
    "sharedId",
    "target"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory Share Result in the engine contract."
}
```

## `MemoryState`

**Since:** 1.5.0

Memory State in the engine contract.

**Type:** `{ agentId: AgentId; cards: { agentPrivate: number \| null; workspace: number \| null; user: number \| null }; tombstones: number \| null; archiveDir: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.5.0 |  |
| `cards` | `{ agentPrivate: number \| null; workspace: number \| null; user: number \| null }` | yes | 1.5.0 |  |
| `tombstones` | `number \| null` | yes | 1.5.0 | `null` means the tombstone registry was unreadable, never "zero tombstones". |
| `archiveDir` | `string` | yes | 1.5.0 | The archive root (e.g. `<stateDir>/memory/_archive`); per-agent archives land in `<archiveDir>/<agentId>/`. |

**Schema**

```json
{
  "title": "MemoryState",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.5.0"
    },
    "cards": {
      "type": "object",
      "properties": {
        "agentPrivate": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.5.0"
        },
        "workspace": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.5.0"
        },
        "user": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.5.0"
        }
      },
      "required": [
        "agentPrivate",
        "workspace",
        "user"
      ],
      "additionalProperties": false,
      "x-since": "1.5.0"
    },
    "tombstones": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "description": "`null` means the tombstone registry was unreadable, never \"zero tombstones\".",
      "x-since": "1.5.0"
    },
    "archiveDir": {
      "type": "string",
      "description": "The archive root (e.g. `<stateDir>/memory/_archive`); per-agent archives land in `<archiveDir>/<agentId>/`.",
      "x-since": "1.5.0"
    }
  },
  "required": [
    "agentId",
    "cards",
    "tombstones",
    "archiveDir"
  ],
  "additionalProperties": false,
  "x-since": "1.5.0",
  "description": "Memory State in the engine contract."
}
```

## `MemoryProposalStatus`

**Since:** 1.6.0

Memory Proposal Status in the engine contract.

**Type:** `"pending" \| "accepted" \| "rejected" \| "stale"`

**Schema**

```json
{
  "title": "MemoryProposalStatus",
  "type": "string",
  "enum": [
    "pending",
    "accepted",
    "rejected",
    "stale"
  ],
  "x-since": "1.6.0",
  "description": "Memory Proposal Status in the engine contract."
}
```

## `MemoryProposal`

**Since:** 1.6.0

Memory Proposal in the engine contract.

**Type:** `{ id: string; sharedId: string; sourceId: string; target: "workspace" \| "user"; sharerAgentId: AgentId; proposerAgentId: AgentId; oldText: string; newText: string; note: string \| null; createdAt: number; status: MemoryProposalStatus; resolvedAt: number \| null; resultId: string \| null; resolutionNote: string \| null }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.6.0 |  |
| `sharedId` | `string` | yes | 1.6.0 | The shared copy the proposal was filed against and the sharer's original behind it. |
| `sourceId` | `string` | yes | 1.6.0 |  |
| `target` | `"workspace" \| "user"` | yes | 1.6.0 |  |
| `sharerAgentId` | `AgentId` | yes | 1.6.0 |  |
| `proposerAgentId` | `AgentId` | yes | 1.6.0 |  |
| `oldText` | `string` | yes | 1.6.0 |  |
| `newText` | `string` | yes | 1.6.0 |  |
| `note` | `string \| null` | yes | 1.6.0 |  |
| `createdAt` | `number` | yes | 1.6.0 |  |
| `status` | `MemoryProposalStatus` | yes | 1.6.0 |  |
| `resolvedAt` | `number \| null` | yes | 1.6.0 |  |
| `resultId` | `string \| null` | yes | 1.6.0 | accepted: the id of the refreshed shared copy. |
| `resolutionNote` | `string \| null` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposal",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "sharedId": {
      "type": "string",
      "description": "The shared copy the proposal was filed against and the sharer's original behind it.",
      "x-since": "1.6.0"
    },
    "sourceId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "target": {
      "type": "string",
      "enum": [
        "workspace",
        "user"
      ],
      "x-since": "1.6.0"
    },
    "sharerAgentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "proposerAgentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "oldText": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "newText": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "note": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.6.0"
    },
    "createdAt": {
      "type": "number",
      "x-since": "1.6.0"
    },
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus",
      "x-since": "1.6.0"
    },
    "resolvedAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.6.0"
    },
    "resultId": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "accepted: the id of the refreshed shared copy.",
      "x-since": "1.6.0"
    },
    "resolutionNote": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.6.0"
    }
  },
  "required": [
    "id",
    "sharedId",
    "sourceId",
    "target",
    "sharerAgentId",
    "proposerAgentId",
    "oldText",
    "newText",
    "note",
    "createdAt",
    "status",
    "resolvedAt",
    "resultId",
    "resolutionNote"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Proposal in the engine contract."
}
```

## `MemoryProposeResult`

**Since:** 1.6.0

Memory Propose Result in the engine contract.

**Type:** `{ proposalId: string; sharedId: string; sharerAgentId: AgentId }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `proposalId` | `string` | yes | 1.6.0 |  |
| `sharedId` | `string` | yes | 1.6.0 |  |
| `sharerAgentId` | `AgentId` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposeResult",
  "type": "object",
  "properties": {
    "proposalId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "sharedId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "sharerAgentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "proposalId",
    "sharedId",
    "sharerAgentId"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Propose Result in the engine contract."
}
```

## `MemoryProposalListQuery`

**Since:** 1.6.0

Memory Proposal List Query in the engine contract.

**Type:** `{ status?: MemoryProposalStatus; limit?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `status` | `MemoryProposalStatus` | no | 1.6.0 |  |
| `limit` | `number` | no | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposalListQuery",
  "type": "object",
  "properties": {
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus",
      "x-since": "1.6.0"
    },
    "limit": {
      "type": "number",
      "x-since": "1.6.0"
    }
  },
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Proposal List Query in the engine contract."
}
```

## `MemoryProposalListResult`

**Since:** 1.6.0

Memory Proposal List Result in the engine contract.

**Type:** `{ agentId: AgentId; items: Array<MemoryProposal>; truncated: boolean; unreadable: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.6.0 |  |
| `items` | `Array<MemoryProposal>` | yes | 1.6.0 | Proposals the agent filed or received, newest first. |
| `truncated` | `boolean` | yes | 1.6.0 |  |
| `unreadable` | `number` | yes | 1.6.0 | Proposal files that could not be parsed; never silently dropped. |

**Schema**

```json
{
  "title": "MemoryProposalListResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryProposal"
      },
      "description": "Proposals the agent filed or received, newest first.",
      "x-since": "1.6.0"
    },
    "truncated": {
      "type": "boolean",
      "x-since": "1.6.0"
    },
    "unreadable": {
      "type": "number",
      "description": "Proposal files that could not be parsed; never silently dropped.",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "agentId",
    "items",
    "truncated",
    "unreadable"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Proposal List Result in the engine contract."
}
```

## `MemoryProposalAcceptResult`

**Since:** 1.6.0

`id` is the refreshed shared copy, `sourceId` the corrected original (both new ids).

**Type:** `{ proposalId: string; id: string; sourceId: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `proposalId` | `string` | yes | 1.6.0 |  |
| `id` | `string` | yes | 1.6.0 |  |
| `sourceId` | `string` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposalAcceptResult",
  "type": "object",
  "properties": {
    "proposalId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "id": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "sourceId": {
      "type": "string",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "proposalId",
    "id",
    "sourceId"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "`id` is the refreshed shared copy, `sourceId` the corrected original (both new ids)."
}
```

## `MemoryProposalRejectResult`

**Since:** 1.6.0

Memory Proposal Reject Result in the engine contract.

**Type:** `{ proposalId: string; status: "rejected" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `proposalId` | `string` | yes | 1.6.0 |  |
| `status` | `"rejected"` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposalRejectResult",
  "type": "object",
  "properties": {
    "proposalId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "status": {
      "type": "string",
      "enum": [
        "rejected"
      ],
      "x-since": "1.6.0"
    }
  },
  "required": [
    "proposalId",
    "status"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Proposal Reject Result in the engine contract."
}
```

## `MemoryProposalEvent`

**Since:** 1.6.0

Memory Proposal Event in the engine contract.

**Type:** `{ proposalId: string; status: MemoryProposalStatus; sharerAgentId: AgentId; proposerAgentId: AgentId; sharedId: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `proposalId` | `string` | yes | 1.6.0 |  |
| `status` | `MemoryProposalStatus` | yes | 1.6.0 |  |
| `sharerAgentId` | `AgentId` | yes | 1.6.0 |  |
| `proposerAgentId` | `AgentId` | yes | 1.6.0 |  |
| `sharedId` | `string` | yes | 1.6.0 |  |

**Schema**

```json
{
  "title": "MemoryProposalEvent",
  "type": "object",
  "properties": {
    "proposalId": {
      "type": "string",
      "x-since": "1.6.0"
    },
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus",
      "x-since": "1.6.0"
    },
    "sharerAgentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "proposerAgentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.6.0"
    },
    "sharedId": {
      "type": "string",
      "x-since": "1.6.0"
    }
  },
  "required": [
    "proposalId",
    "status",
    "sharerAgentId",
    "proposerAgentId",
    "sharedId"
  ],
  "additionalProperties": false,
  "x-since": "1.6.0",
  "description": "Memory Proposal Event in the engine contract."
}
```

## `MemoryOps`

**Since:** 1.5.0

Memory Ops in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `stats(ids: Array<string>, p: Principal, a: AgentContext): MemoryStatsResult` | a1-pending | 1.17.0: per-agent counters for visible cards only, at most 500 ids. Undefined ids reads persisted counters; unseen requested visible ids return zero. |
| `promote(req: { ids: Array<string> }, p: Principal, a: AgentContext): MemoryPromotionResult` | a1-pending | 1.17.0: foreground system/user host only. Uses schicht15 cap per invocation (0 unlimited), never invokes providers; only agent-private source rows. |
| `curation.list(q: { limit?: number }, p: Principal, a: AgentContext): MemoryCurationListResult` | a1-pending |  |
| `curation.resolve(id: string, action: "keep" \| "drop", p: Principal, a: AgentContext): { id: string; ok: boolean; status?: string; reason?: string }` | a1-pending |  |
| `list(q: MemoryListQuery, p: Principal, a: AgentContext): MemoryListResult` | 1.5.0 |  |
| `show(id: string, p: Principal, a: AgentContext): MemoryCard` | 1.5.0 |  |
| `forget(id: string, p: Principal, a: AgentContext): MemoryForgetResult` | 1.5.0 |  |
| `correct(id: string, newText: string, p: Principal, a: AgentContext): MemoryCorrectResult` | 1.5.0 |  |
| `share(id: string, target: "workspace" \| "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): MemoryShareResult` | 1.5.0 | `allowSensitive` is the caller's explicit confirmation after an `approval-required` refusal. |
| `state(p: Principal, a: AgentContext): MemoryState` | 1.5.0 |  |
| `propose(sharedId: string, newText: string, p: Principal, a: AgentContext, opts?: { note?: string }): MemoryProposeResult` | 1.6.0 | File a change proposal against a shared copy the caller can read but does not own (`a.origin === "user"`). |
| `proposals.list(q: MemoryProposalListQuery, p: Principal, a: AgentContext): MemoryProposalListResult` | 1.5.0 |  |
| `proposals.accept(proposalId: string, p: Principal, a: AgentContext): MemoryProposalAcceptResult` | 1.5.0 | Sharer only (anyone else: `not-found`). Refreshes the copy with the proposal's text. |
| `proposals.reject(proposalId: string, p: Principal, a: AgentContext, opts?: { note?: string }): MemoryProposalRejectResult` | 1.5.0 |  |
| `import(req: MemoryImportRequest, p: Principal, a: AgentContext): MemoryImportResult` | 1.11.0 | 1.11.0: ingest finished cards (text + provenance + source timestamp) without the live-store LLM merge. `p` is the operator; `req.principal` is the card ACL binding. Requires `a.origin === "system"` and `a.background === false`. At most 500 cards per call. |
| `rebind(req: MemoryRebindRequest, p: Principal, a: AgentContext): MemoryRebindResult` | 1.12.0 | 1.12.0: attach user-scope cards of one channel identity to a harness user. `dryRun` defaults to true. Requires `a.origin === "system"` and `a.background === false`. Counters only; no card text or raw identity keys. |
| `unbind(req: MemoryUnbindRequest, p: Principal, a: AgentContext): MemoryUnbindResult` | 1.12.0 | 1.12.0: restore the owner bindings recorded under `req.rebindId`. Cards written after that rebind are left alone. `dryRun` defaults to false. |
| `unimport(req: MemoryUnimportRequest, p: Principal, a: AgentContext): MemoryUnimportResult` | 1.13.0 | 1.13.0: roll back the cards `import` created under `req.importRunId` for `req.agentId`. `dryRun` defaults to true. Requires `a.origin === "system"` and `a.background === false`. Ids, keys, counters and reason codes only. |
| `link(id: string, req: MemoryLinkRequest, p: Principal, a: AgentContext): MemoryLinkResult` | 1.16.0 | 1.16.0: attach an additional source to the existing card `id` (an imported card that duplicates it) without changing its text, vector or row. Requires `a.origin === "system"` and `a.background === false` (`denied`). The card must be one the caller can `show`; otherwise `not-found` (also for an unknown id). Idempotent per sourceRef. Apply takes the per-agent import lock (`lock-busy` / `lock-lost`); more than 100 links on one card is `conflict`. Audit line `memory.linked`. |

**Schema**

```json
{
  "title": "MemoryOps",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "stats": {
      "x-since": "a1-pending",
      "parameters": [
        {
          "name": "ids",
          "optional": false,
          "schema": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryStatsResult"
      },
      "description": "1.17.0: per-agent counters for visible cards only, at most 500 ids. Undefined ids reads persisted counters; unseen requested visible ids return zero."
    },
    "promote": {
      "x-since": "a1-pending",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "type": "object",
            "properties": {
              "ids": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "x-since": "1.5.0"
              }
            },
            "required": [
              "ids"
            ],
            "additionalProperties": false
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryPromotionResult"
      },
      "description": "1.17.0: foreground system/user host only. Uses schicht15 cap per invocation (0 unlimited), never invokes providers; only agent-private source rows."
    },
    "curation.list": {
      "x-since": "a1-pending",
      "parameters": [
        {
          "name": "q",
          "optional": false,
          "schema": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "number",
                "x-since": "1.5.0"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryCurationListResult"
      }
    },
    "curation.resolve": {
      "x-since": "a1-pending",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "action",
          "optional": false,
          "schema": {
            "type": "string",
            "enum": [
              "keep",
              "drop"
            ]
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "x-since": "1.5.0"
          },
          "ok": {
            "type": "boolean",
            "x-since": "1.5.0"
          },
          "status": {
            "type": "string",
            "x-since": "1.5.0"
          },
          "reason": {
            "type": "string",
            "x-since": "1.5.0"
          }
        },
        "required": [
          "id",
          "ok"
        ],
        "additionalProperties": false
      }
    },
    "list": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "q",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryListQuery"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryListResult"
      }
    },
    "show": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryCard"
      }
    },
    "forget": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryForgetResult"
      }
    },
    "correct": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "newText",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryCorrectResult"
      }
    },
    "share": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "target",
          "optional": false,
          "schema": {
            "type": "string",
            "enum": [
              "workspace",
              "user"
            ]
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "allowSensitive": {
                "type": "boolean",
                "x-since": "1.5.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryShareResult"
      },
      "description": "`allowSensitive` is the caller's explicit confirmation after an `approval-required` refusal."
    },
    "state": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryState"
      }
    },
    "propose": {
      "x-since": "1.6.0",
      "parameters": [
        {
          "name": "sharedId",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "newText",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "note": {
                "type": "string",
                "x-since": "1.5.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryProposeResult"
      },
      "description": "File a change proposal against a shared copy the caller can read but does not own (`a.origin === \"user\"`)."
    },
    "proposals.list": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "q",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryProposalListQuery"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryProposalListResult"
      }
    },
    "proposals.accept": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "proposalId",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryProposalAcceptResult"
      },
      "description": "Sharer only (anyone else: `not-found`). Refreshes the copy with the proposal's text."
    },
    "proposals.reject": {
      "x-since": "1.5.0",
      "parameters": [
        {
          "name": "proposalId",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "note": {
                "type": "string",
                "x-since": "1.5.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryProposalRejectResult"
      }
    },
    "import": {
      "x-since": "1.11.0",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryImportRequest"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryImportResult"
      },
      "description": "1.11.0: ingest finished cards (text + provenance + source timestamp) without the live-store LLM merge. `p` is the operator; `req.principal` is the card ACL binding. Requires `a.origin === \"system\"` and `a.background === false`. At most 500 cards per call."
    },
    "rebind": {
      "x-since": "1.12.0",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryRebindRequest"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryRebindResult"
      },
      "description": "1.12.0: attach user-scope cards of one channel identity to a harness user. `dryRun` defaults to true. Requires `a.origin === \"system\"` and `a.background === false`. Counters only; no card text or raw identity keys."
    },
    "unbind": {
      "x-since": "1.12.0",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryUnbindRequest"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryUnbindResult"
      },
      "description": "1.12.0: restore the owner bindings recorded under `req.rebindId`. Cards written after that rebind are left alone. `dryRun` defaults to false."
    },
    "unimport": {
      "x-since": "1.13.0",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryUnimportRequest"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryUnimportResult"
      },
      "description": "1.13.0: roll back the cards `import` created under `req.importRunId` for `req.agentId`. `dryRun` defaults to true. Requires `a.origin === \"system\"` and `a.background === false`. Ids, keys, counters and reason codes only."
    },
    "link": {
      "x-since": "1.16.0",
      "parameters": [
        {
          "name": "id",
          "optional": false,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/MemoryLinkRequest"
          }
        },
        {
          "name": "p",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/Principal"
          }
        },
        {
          "name": "a",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentContext"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/MemoryLinkResult"
      },
      "description": "1.16.0: attach an additional source to the existing card `id` (an imported card that duplicates it) without changing its text, vector or row. Requires `a.origin === \"system\"` and `a.background === false` (`denied`). The card must be one the caller can `show`; otherwise `not-found` (also for an unknown id). Idempotent per sourceRef. Apply takes the per-agent import lock (`lock-busy` / `lock-lost`); more than 100 links on one card is `conflict`. Audit line `memory.linked`."
    }
  },
  "x-since": "1.5.0",
  "description": "Memory Ops in the engine contract.",
  "x-runtime": true
}
```

## `MemoryRebindFromIdentity`

**Since:** 1.12.0

Memory Rebind From Identity in the engine contract.

**Type:** `{ channel: ChannelRef; identityKey: string; accountId?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `channel` | `ChannelRef` | yes | 1.12.0 | Channel name, e.g. "telegram". |
| `identityKey` | `string` | yes | 1.12.0 | Opaque channel user id (the third v1-hash tuple member). |
| `accountId` | `string` | no | 1.12.0 | Bot account id; omitted → `"default"`, matching live capture. |

**Schema**

```json
{
  "title": "MemoryRebindFromIdentity",
  "type": "object",
  "properties": {
    "channel": {
      "$ref": "#/$defs/ChannelRef",
      "description": "Channel name, e.g. \"telegram\".",
      "x-since": "1.12.0"
    },
    "identityKey": {
      "type": "string",
      "description": "Opaque channel user id (the third v1-hash tuple member).",
      "x-since": "1.12.0"
    },
    "accountId": {
      "type": "string",
      "description": "Bot account id; omitted → `\"default\"`, matching live capture.",
      "x-since": "1.12.0"
    }
  },
  "required": [
    "channel",
    "identityKey"
  ],
  "additionalProperties": false,
  "x-since": "1.12.0",
  "description": "Memory Rebind From Identity in the engine contract."
}
```

## `MemoryRebindRequest`

**Since:** 1.12.0

Memory Rebind Request in the engine contract.

**Type:** `{ agentId: AgentId; fromIdentity: MemoryRebindFromIdentity; toUser: string; dryRun?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.12.0 |  |
| `fromIdentity` | `MemoryRebindFromIdentity` | yes | 1.12.0 |  |
| `toUser` | `string` | yes | 1.12.0 | Harness user id; hashed to `user:v2:` by the engine. |
| `dryRun` | `boolean` | no | 1.12.0 | Defaults to true. Writes only when explicitly `false`. |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.12.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "MemoryRebindRequest",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.12.0"
    },
    "fromIdentity": {
      "$ref": "#/$defs/MemoryRebindFromIdentity",
      "x-since": "1.12.0"
    },
    "toUser": {
      "type": "string",
      "description": "Harness user id; hashed to `user:v2:` by the engine.",
      "x-since": "1.12.0"
    },
    "dryRun": {
      "type": "boolean",
      "description": "Defaults to true. Writes only when explicitly `false`.",
      "x-since": "1.12.0"
    }
  },
  "required": [
    "agentId",
    "fromIdentity",
    "toUser"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.12.0"
    }
  },
  "x-since": "1.12.0",
  "description": "Memory Rebind Request in the engine contract."
}
```

## `MemoryRebindResult`

**Since:** 1.12.0

Memory Rebind Result in the engine contract.

**Type:** `{ rebindId: string; matched: number; rebound: number; skipped: number; dryRun: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `rebindId` | `string` | yes | 1.12.0 |  |
| `matched` | `number` | yes | 1.12.0 |  |
| `rebound` | `number` | yes | 1.12.0 |  |
| `skipped` | `number` | yes | 1.12.0 |  |
| `dryRun` | `boolean` | yes | 1.12.0 |  |

**Schema**

```json
{
  "title": "MemoryRebindResult",
  "type": "object",
  "properties": {
    "rebindId": {
      "type": "string",
      "x-since": "1.12.0"
    },
    "matched": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "rebound": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "skipped": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.12.0"
    }
  },
  "required": [
    "rebindId",
    "matched",
    "rebound",
    "skipped",
    "dryRun"
  ],
  "additionalProperties": false,
  "x-since": "1.12.0",
  "description": "Memory Rebind Result in the engine contract."
}
```

## `MemoryUnbindRequest`

**Since:** 1.12.0

Memory Unbind Request in the engine contract.

**Type:** `{ rebindId: string; dryRun?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `rebindId` | `string` | yes | 1.12.0 |  |
| `dryRun` | `boolean` | no | 1.12.0 |  |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.12.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "MemoryUnbindRequest",
  "type": "object",
  "properties": {
    "rebindId": {
      "type": "string",
      "x-since": "1.12.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.12.0"
    }
  },
  "required": [
    "rebindId"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.12.0"
    }
  },
  "x-since": "1.12.0",
  "description": "Memory Unbind Request in the engine contract."
}
```

## `MemoryUnbindResult`

**Since:** 1.12.0

Memory Unbind Result in the engine contract.

**Type:** `{ rebindId: string; matched: number; unbound: number; skipped: number; skippedModified: number; dryRun: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `rebindId` | `string` | yes | 1.12.0 |  |
| `matched` | `number` | yes | 1.12.0 |  |
| `unbound` | `number` | yes | 1.12.0 |  |
| `skipped` | `number` | yes | 1.12.0 |  |
| `skippedModified` | `number` | yes | 1.12.0 |  |
| `dryRun` | `boolean` | yes | 1.12.0 |  |

**Schema**

```json
{
  "title": "MemoryUnbindResult",
  "type": "object",
  "properties": {
    "rebindId": {
      "type": "string",
      "x-since": "1.12.0"
    },
    "matched": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "unbound": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "skipped": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "skippedModified": {
      "type": "number",
      "x-since": "1.12.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.12.0"
    }
  },
  "required": [
    "rebindId",
    "matched",
    "unbound",
    "skipped",
    "skippedModified",
    "dryRun"
  ],
  "additionalProperties": false,
  "x-since": "1.12.0",
  "description": "Memory Unbind Result in the engine contract."
}
```

## `MemoryImportProvenance`

**Since:** 1.11.0

Memory Import Provenance in the engine contract.

**Type:** `"imported"`

**Schema**

```json
{
  "title": "MemoryImportProvenance",
  "type": "string",
  "enum": [
    "imported"
  ],
  "x-since": "1.11.0",
  "description": "Memory Import Provenance in the engine contract."
}
```

## `MemoryImportOutcome`

**Since:** 1.11.0

Memory Import Outcome in the engine contract.

**Type:** `"created" \| "matched-existing" \| "rejected"`

**Schema**

```json
{
  "title": "MemoryImportOutcome",
  "type": "string",
  "enum": [
    "created",
    "matched-existing",
    "rejected"
  ],
  "x-since": "1.11.0",
  "description": "Memory Import Outcome in the engine contract."
}
```

## `MemoryImportCardInput`

**Since:** 1.11.0

Memory Import Card Input in the engine contract.

**Type:** `{ idempotencyKey: string; text: string; kind?: string; createdAt?: number; provenance: MemoryImportProvenance; sourceRef?: string; scope?: MemoryScope }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `idempotencyKey` | `string` | yes | 1.11.0 | Stable caller key; a second call with the same key and agent is a resume. |
| `text` | `string` | yes | 1.11.0 |  |
| `kind` | `string` | no | 1.11.0 | Mapped onto `MemoryCard` category; omitted → auto-categorise. |
| `createdAt` | `number` | no | 1.11.0 |  |
| `provenance` | `MemoryImportProvenance` | yes | 1.11.0 |  |
| `sourceRef` | `string` | no | 1.11.0 | Truncated to ≤ 500 characters before store. |
| `scope` | `MemoryScope` | no | 1.11.0 |  |

**Schema**

```json
{
  "title": "MemoryImportCardInput",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "description": "Stable caller key; a second call with the same key and agent is a resume.",
      "x-since": "1.11.0"
    },
    "text": {
      "type": "string",
      "x-since": "1.11.0"
    },
    "kind": {
      "type": "string",
      "description": "Mapped onto `MemoryCard` category; omitted → auto-categorise.",
      "x-since": "1.11.0"
    },
    "createdAt": {
      "type": "number",
      "x-since": "1.11.0"
    },
    "provenance": {
      "$ref": "#/$defs/MemoryImportProvenance",
      "x-since": "1.11.0"
    },
    "sourceRef": {
      "type": "string",
      "description": "Truncated to ≤ 500 characters before store.",
      "x-since": "1.11.0"
    },
    "scope": {
      "$ref": "#/$defs/MemoryScope",
      "x-since": "1.11.0"
    }
  },
  "required": [
    "idempotencyKey",
    "text",
    "provenance"
  ],
  "additionalProperties": false,
  "x-since": "1.11.0",
  "description": "Memory Import Card Input in the engine contract."
}
```

## `MemoryImportRequest`

**Since:** 1.11.0

Memory Import Request in the engine contract.

**Type:** `{ agentId: AgentId; principal: Principal; cards: Array<MemoryImportCardInput>; dryRun?: boolean; importRunId?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.11.0 |  |
| `principal` | `Principal` | yes | 1.11.0 | Card ACL binding (A1). Must share `agentId` with `p` and `req.agentId`. |
| `cards` | `Array<MemoryImportCardInput>` | yes | 1.11.0 |  |
| `dryRun` | `boolean` | no | 1.11.0 |  |
| `importRunId` | `string` | no | 1.13.0 | 1.13.0: `/^[A-Za-z0-9_-]{1,64}$/`. Recorded on every ledger line this call writes; `unimport` selects by it. 1.15.0: when absent, a card whose `sourceRef` carries exactly one segment `;run=<id>` (same pattern, sourceRef shorter than the 500-char cap) is recorded under that run, with its digest. |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.11.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "MemoryImportRequest",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.11.0"
    },
    "principal": {
      "$ref": "#/$defs/Principal",
      "description": "Card ACL binding (A1). Must share `agentId` with `p` and `req.agentId`.",
      "x-since": "1.11.0"
    },
    "cards": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryImportCardInput"
      },
      "x-since": "1.11.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.11.0"
    },
    "importRunId": {
      "type": "string",
      "description": "1.13.0: `/^[A-Za-z0-9_-]{1,64}$/`. Recorded on every ledger line this call writes; `unimport` selects by it. 1.15.0: when absent, a card whose `sourceRef` carries exactly one segment `;run=<id>` (same pattern, sourceRef shorter than the 500-char cap) is recorded under that run, with its digest.",
      "x-since": "1.13.0"
    }
  },
  "required": [
    "agentId",
    "principal",
    "cards"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.11.0"
    }
  },
  "x-since": "1.11.0",
  "description": "Memory Import Request in the engine contract."
}
```

## `MemoryImportRejectReason`

**Since:** 1.11.0

Memory Import Reject Reason in the engine contract.

**Type:** `"invalid-input" \| "tombstone-blocked" \| "principal-unresolved" \| "empty-text" \| "provenance-not-imported" \| "previously-imported-deleted" \| "aborted" \| "storage"`

**Schema**

```json
{
  "title": "MemoryImportRejectReason",
  "type": "string",
  "enum": [
    "invalid-input",
    "tombstone-blocked",
    "principal-unresolved",
    "empty-text",
    "provenance-not-imported",
    "previously-imported-deleted",
    "aborted",
    "storage"
  ],
  "x-since": "1.11.0",
  "description": "Memory Import Reject Reason in the engine contract."
}
```

## `MemoryImportCardResult`

**Since:** 1.11.0

Memory Import Card Result in the engine contract.

**Type:** `{ idempotencyKey: string; outcome: MemoryImportOutcome; id?: string; reason?: MemoryImportRejectReason \| "already-imported" \| "duplicate-in-batch" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `idempotencyKey` | `string` | yes | 1.11.0 |  |
| `outcome` | `MemoryImportOutcome` | yes | 1.11.0 |  |
| `id` | `string` | no | 1.11.0 | Set on created and matched-existing. Omitted on dry-run created. |
| `reason` | `MemoryImportRejectReason \| "already-imported" \| "duplicate-in-batch"` | no | 1.11.0 | Machine-stable; never card text. `already-imported` / `duplicate-in-batch` only with matched-existing. |

**Schema**

```json
{
  "title": "MemoryImportCardResult",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "x-since": "1.11.0"
    },
    "outcome": {
      "$ref": "#/$defs/MemoryImportOutcome",
      "x-since": "1.11.0"
    },
    "id": {
      "type": "string",
      "description": "Set on created and matched-existing. Omitted on dry-run created.",
      "x-since": "1.11.0"
    },
    "reason": {
      "anyOf": [
        {
          "$ref": "#/$defs/MemoryImportRejectReason"
        },
        {
          "type": "string",
          "enum": [
            "already-imported"
          ]
        },
        {
          "type": "string",
          "enum": [
            "duplicate-in-batch"
          ]
        }
      ],
      "description": "Machine-stable; never card text. `already-imported` / `duplicate-in-batch` only with matched-existing.",
      "x-since": "1.11.0"
    }
  },
  "required": [
    "idempotencyKey",
    "outcome"
  ],
  "additionalProperties": false,
  "x-since": "1.11.0",
  "description": "Memory Import Card Result in the engine contract."
}
```

## `MemoryImportResult`

**Since:** 1.11.0

Memory Import Result in the engine contract.

**Type:** `{ agentId: AgentId; dryRun: boolean; created: number; matchedExisting: number; rejected: number; cards: Array<MemoryImportCardResult> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.11.0 |  |
| `dryRun` | `boolean` | yes | 1.11.0 |  |
| `created` | `number` | yes | 1.11.0 |  |
| `matchedExisting` | `number` | yes | 1.11.0 |  |
| `rejected` | `number` | yes | 1.11.0 |  |
| `cards` | `Array<MemoryImportCardResult>` | yes | 1.11.0 |  |

**Schema**

```json
{
  "title": "MemoryImportResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.11.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.11.0"
    },
    "created": {
      "type": "number",
      "x-since": "1.11.0"
    },
    "matchedExisting": {
      "type": "number",
      "x-since": "1.11.0"
    },
    "rejected": {
      "type": "number",
      "x-since": "1.11.0"
    },
    "cards": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryImportCardResult"
      },
      "x-since": "1.11.0"
    }
  },
  "required": [
    "agentId",
    "dryRun",
    "created",
    "matchedExisting",
    "rejected",
    "cards"
  ],
  "additionalProperties": false,
  "x-since": "1.11.0",
  "description": "Memory Import Result in the engine contract."
}
```

## `MemoryUnimportRequest`

**Since:** 1.13.0

Memory Unimport Request in the engine contract.

**Type:** `{ agentId: AgentId; importRunId: string; idempotencyKeys?: Array<string>; dryRun?: boolean; force?: boolean; principal?: Principal }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.13.0 |  |
| `importRunId` | `string` | yes | 1.13.0 | Required; selects the `_imports/` ledger lines of this run: written with this `importRunId`, or (1.15.0) without one but with a `sourceRef` carrying the segment `;run=<importRunId>`. |
| `idempotencyKeys` | `Array<string>` | no | 1.13.0 | Optional narrowing filter (≤ 500); never widens the selection. |
| `dryRun` | `boolean` | no | 1.13.0 | Defaults to true. Writes only when explicitly `false`. |
| `force` | `boolean` | no | 1.13.0 | Also undo cards kept as `content-changed`, `metadata-changed` or `edited`. Never `superseded`, `shared`, `rebound`, `binding-changed`, `other-run`, forgotten or missing cards. |
| `principal` | `Principal` | no | 1.13.0 | Optional card ACL binding used at import; its workspace/user pools are searched for shared copies too. Must share `agentId`. |

| Runtime property | Since | Rust behavior |
|---|---|---|
| `signal` | 1.13.0 | Cancellation is supplied through the Rust Cancel parameter. |

**Schema**

```json
{
  "title": "MemoryUnimportRequest",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.13.0"
    },
    "importRunId": {
      "type": "string",
      "description": "Required; selects the `_imports/` ledger lines of this run: written with this `importRunId`, or (1.15.0) without one but with a `sourceRef` carrying the segment `;run=<importRunId>`.",
      "x-since": "1.13.0"
    },
    "idempotencyKeys": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional narrowing filter (≤ 500); never widens the selection.",
      "x-since": "1.13.0"
    },
    "dryRun": {
      "type": "boolean",
      "description": "Defaults to true. Writes only when explicitly `false`.",
      "x-since": "1.13.0"
    },
    "force": {
      "type": "boolean",
      "description": "Also undo cards kept as `content-changed`, `metadata-changed` or `edited`. Never `superseded`, `shared`, `rebound`, `binding-changed`, `other-run`, forgotten or missing cards.",
      "x-since": "1.13.0"
    },
    "principal": {
      "$ref": "#/$defs/Principal",
      "description": "Optional card ACL binding used at import; its workspace/user pools are searched for shared copies too. Must share `agentId`.",
      "x-since": "1.13.0"
    }
  },
  "required": [
    "agentId",
    "importRunId"
  ],
  "additionalProperties": false,
  "x-runtime-properties": {
    "signal": {
      "description": "Cancellation is supplied through the Rust Cancel parameter.",
      "x-since": "1.13.0"
    }
  },
  "x-since": "1.13.0",
  "description": "Memory Unimport Request in the engine contract."
}
```

## `MemoryUnimportOutcome`

**Since:** 1.13.0

Memory Unimport Outcome in the engine contract.

**Type:** `"unimported" \| "kept-modified" \| "already-forgotten" \| "already-unimported" \| "missing" \| "failed"`

**Schema**

```json
{
  "title": "MemoryUnimportOutcome",
  "type": "string",
  "enum": [
    "unimported",
    "kept-modified",
    "already-forgotten",
    "already-unimported",
    "missing",
    "failed"
  ],
  "x-since": "1.13.0",
  "description": "Memory Unimport Outcome in the engine contract."
}
```

## `MemoryUnimportKeptReason`

**Since:** 1.13.0

Memory Unimport Kept Reason in the engine contract.

**Type:** `"superseded" \| "content-changed" \| "binding-changed" \| "metadata-changed" \| "edited" \| "shared" \| "rebound" \| "other-run"`

**Schema**

```json
{
  "title": "MemoryUnimportKeptReason",
  "type": "string",
  "enum": [
    "superseded",
    "content-changed",
    "binding-changed",
    "metadata-changed",
    "edited",
    "shared",
    "rebound",
    "other-run"
  ],
  "x-since": "1.13.0",
  "description": "Memory Unimport Kept Reason in the engine contract."
}
```

## `MemoryUnimportCardResult`

**Since:** 1.13.0

Memory Unimport Card Result in the engine contract.

**Type:** `{ idempotencyKey: string; id: string; outcome: MemoryUnimportOutcome; reason?: MemoryUnimportKeptReason \| "storage" \| "aborted" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `idempotencyKey` | `string` | yes | 1.13.0 |  |
| `id` | `string` | yes | 1.13.0 |  |
| `outcome` | `MemoryUnimportOutcome` | yes | 1.13.0 |  |
| `reason` | `MemoryUnimportKeptReason \| "storage" \| "aborted"` | no | 1.13.0 | `kept-modified`: the kept reason. `failed`: "storage" \| "aborted". |

**Schema**

```json
{
  "title": "MemoryUnimportCardResult",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "x-since": "1.13.0"
    },
    "id": {
      "type": "string",
      "x-since": "1.13.0"
    },
    "outcome": {
      "$ref": "#/$defs/MemoryUnimportOutcome",
      "x-since": "1.13.0"
    },
    "reason": {
      "anyOf": [
        {
          "$ref": "#/$defs/MemoryUnimportKeptReason"
        },
        {
          "type": "string",
          "enum": [
            "storage"
          ]
        },
        {
          "type": "string",
          "enum": [
            "aborted"
          ]
        }
      ],
      "description": "`kept-modified`: the kept reason. `failed`: \"storage\" | \"aborted\".",
      "x-since": "1.13.0"
    }
  },
  "required": [
    "idempotencyKey",
    "id",
    "outcome"
  ],
  "additionalProperties": false,
  "x-since": "1.13.0",
  "description": "Memory Unimport Card Result in the engine contract."
}
```

## `MemoryUnimportResult`

**Since:** 1.13.0

Memory Unimport Result in the engine contract.

**Type:** `{ agentId: AgentId; importRunId: string; dryRun: boolean; selected: number; unimported: number; keptModified: number; alreadyForgotten: number; alreadyUnimported: number; missing: number; failed: number; remaining: number; cards: Array<MemoryUnimportCardResult>; derived: { jobsSinceImport: Array<JobName>; graphEdgesRemoved?: number; mirrorsArchived?: number; cleanupErrors?: number }; links?: MemoryUnimportLinksResult }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.13.0 |  |
| `importRunId` | `string` | yes | 1.13.0 |  |
| `dryRun` | `boolean` | yes | 1.13.0 |  |
| `selected` | `number` | yes | 1.13.0 | Cards attributed to this run (after the key filter). |
| `unimported` | `number` | yes | 1.13.0 |  |
| `keptModified` | `number` | yes | 1.13.0 |  |
| `alreadyForgotten` | `number` | yes | 1.13.0 |  |
| `alreadyUnimported` | `number` | yes | 1.13.0 |  |
| `missing` | `number` | yes | 1.13.0 |  |
| `failed` | `number` | yes | 1.13.0 |  |
| `remaining` | `number` | yes | 1.13.0 | Selected cards not visited in this call (abort). A rerun visits them. |
| `cards` | `Array<MemoryUnimportCardResult>` | yes | 1.13.0 |  |
| `derived` | `{ jobsSinceImport: Array<JobName>; graphEdgesRemoved?: number; mirrorsArchived?: number; cleanupErrors?: number }` | yes | 1.15.0 | Derivation-capable jobs with a run that finished after the earliest selected import. 1.15.0, apply only (absent on dryRun or when nothing was undone): graph edges of the undone cards removed from the canonical neo journal, their Obsidian mirror notes moved into the archive (`{archiveDir}/obsidian-mirrors/`), and best-effort cleanup failures (logged, the cards stay undone; a rerun retries the cleanup). |
| `links` | `MemoryUnimportLinksResult` | no | 1.16.0 | 1.16.0: present when the run made links (`memory.link`). Unlinking never writes the linked card. |

**Schema**

```json
{
  "title": "MemoryUnimportResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.13.0"
    },
    "importRunId": {
      "type": "string",
      "x-since": "1.13.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.13.0"
    },
    "selected": {
      "type": "number",
      "description": "Cards attributed to this run (after the key filter).",
      "x-since": "1.13.0"
    },
    "unimported": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "keptModified": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "alreadyForgotten": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "alreadyUnimported": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "missing": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "failed": {
      "type": "number",
      "x-since": "1.13.0"
    },
    "remaining": {
      "type": "number",
      "description": "Selected cards not visited in this call (abort). A rerun visits them.",
      "x-since": "1.13.0"
    },
    "cards": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryUnimportCardResult"
      },
      "x-since": "1.13.0"
    },
    "derived": {
      "type": "object",
      "properties": {
        "jobsSinceImport": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/JobName"
          },
          "x-since": "1.13.0"
        },
        "graphEdgesRemoved": {
          "type": "number",
          "x-since": "1.13.0"
        },
        "mirrorsArchived": {
          "type": "number",
          "x-since": "1.13.0"
        },
        "cleanupErrors": {
          "type": "number",
          "x-since": "1.13.0"
        }
      },
      "required": [
        "jobsSinceImport"
      ],
      "additionalProperties": false,
      "description": "Derivation-capable jobs with a run that finished after the earliest selected import. 1.15.0, apply only (absent on dryRun or when nothing was undone): graph edges of the undone cards removed from the canonical neo journal, their Obsidian mirror notes moved into the archive (`{archiveDir}/obsidian-mirrors/`), and best-effort cleanup failures (logged, the cards stay undone; a rerun retries the cleanup).",
      "x-since": "1.15.0"
    },
    "links": {
      "$ref": "#/$defs/MemoryUnimportLinksResult",
      "description": "1.16.0: present when the run made links (`memory.link`). Unlinking never writes the linked card.",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "agentId",
    "importRunId",
    "dryRun",
    "selected",
    "unimported",
    "keptModified",
    "alreadyForgotten",
    "alreadyUnimported",
    "missing",
    "failed",
    "remaining",
    "cards",
    "derived"
  ],
  "additionalProperties": false,
  "x-since": "1.13.0",
  "description": "Memory Unimport Result in the engine contract."
}
```

## `MemoryUnimportLinkOutcome`

**Since:** 1.16.0

Memory Unimport Link Outcome in the engine contract.

**Type:** `"unlinked" \| "already-unlinked"`

**Schema**

```json
{
  "title": "MemoryUnimportLinkOutcome",
  "type": "string",
  "enum": [
    "unlinked",
    "already-unlinked"
  ],
  "x-since": "1.16.0",
  "description": "Memory Unimport Link Outcome in the engine contract."
}
```

## `MemoryUnimportLinksResult`

**Since:** 1.16.0

Memory Unimport Links Result in the engine contract.

**Type:** `{ selected: number; unlinked: number; alreadyUnlinked: number; items: Array<{ linkId: string; id: string; outcome: MemoryUnimportLinkOutcome }> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `selected` | `number` | yes | 1.16.0 | Links this run made (after the key filter; a link without a key is not selected when a filter is set). |
| `unlinked` | `number` | yes | 1.16.0 |  |
| `alreadyUnlinked` | `number` | yes | 1.16.0 |  |
| `items` | `Array<{ linkId: string; id: string; outcome: MemoryUnimportLinkOutcome }>` | yes | 1.16.0 | One entry per handled link; empty after an abort (a rerun handles them). |

**Schema**

```json
{
  "title": "MemoryUnimportLinksResult",
  "type": "object",
  "properties": {
    "selected": {
      "type": "number",
      "description": "Links this run made (after the key filter; a link without a key is not selected when a filter is set).",
      "x-since": "1.16.0"
    },
    "unlinked": {
      "type": "number",
      "x-since": "1.16.0"
    },
    "alreadyUnlinked": {
      "type": "number",
      "x-since": "1.16.0"
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "linkId": {
            "type": "string",
            "x-since": "1.16.0"
          },
          "id": {
            "type": "string",
            "x-since": "1.16.0"
          },
          "outcome": {
            "$ref": "#/$defs/MemoryUnimportLinkOutcome",
            "x-since": "1.16.0"
          }
        },
        "required": [
          "linkId",
          "id",
          "outcome"
        ],
        "additionalProperties": false
      },
      "description": "One entry per handled link; empty after an abort (a rerun handles them).",
      "x-since": "1.16.0"
    }
  },
  "required": [
    "selected",
    "unlinked",
    "alreadyUnlinked",
    "items"
  ],
  "additionalProperties": false,
  "x-since": "1.16.0",
  "description": "Memory Unimport Links Result in the engine contract."
}
```

## `StoreAdoptRequest`

**Since:** 1.11.0

Store Adopt Request in the engine contract.

**Type:** `{ path: string; expectedIdentity: EmbeddingIdentity; dryRun?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `path` | `string` | yes | 1.11.0 | Absolute store root (the path `createEngine` would use as `baseDbPath`). |
| `expectedIdentity` | `EmbeddingIdentity` | yes | 1.11.0 |  |
| `dryRun` | `boolean` | no | 1.11.0 |  |

**Schema**

```json
{
  "title": "StoreAdoptRequest",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute store root (the path `createEngine` would use as `baseDbPath`).",
      "x-since": "1.11.0"
    },
    "expectedIdentity": {
      "$ref": "#/$defs/EmbeddingIdentity",
      "x-since": "1.11.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.11.0"
    }
  },
  "required": [
    "path",
    "expectedIdentity"
  ],
  "additionalProperties": false,
  "x-since": "1.11.0",
  "description": "Store Adopt Request in the engine contract."
}
```

## `StoreAdoptIncompatibleReason`

**Since:** 1.11.0

Store Adopt Incompatible Reason in the engine contract.

**Type:** `"path-unreadable" \| "not-a-store" \| "schema-unreadable" \| "schema-mismatch" \| "identity-unreadable" \| "identity-mismatch" \| "identity-unverifiable" \| "dimension-mismatch" \| "target-running"`

**Schema**

```json
{
  "title": "StoreAdoptIncompatibleReason",
  "type": "string",
  "enum": [
    "path-unreadable",
    "not-a-store",
    "schema-unreadable",
    "schema-mismatch",
    "identity-unreadable",
    "identity-mismatch",
    "identity-unverifiable",
    "dimension-mismatch",
    "target-running"
  ],
  "x-since": "1.11.0",
  "description": "Store Adopt Incompatible Reason in the engine contract."
}
```

## `StoreAdoptIdentitySource`

**Since:** 1.11.0

Store Adopt Identity Source in the engine contract.

**Type:** `"manifest" \| "probe"`

**Schema**

```json
{
  "title": "StoreAdoptIdentitySource",
  "type": "string",
  "enum": [
    "manifest",
    "probe"
  ],
  "x-since": "1.11.0",
  "description": "Store Adopt Identity Source in the engine contract."
}
```

## `StoreAdoptResult`

**Since:** 1.11.0

Store Adopt Result in the engine contract.

**Type:** `{ verdict: "ok" \| "incompatible"; dryRun: boolean; reason?: StoreAdoptIncompatibleReason; storeSchema?: { current: SchemaVersion \| null; expected: SchemaVersion }; identity?: EmbeddingIdentity \| null; identitySource?: StoreAdoptIdentitySource }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `verdict` | `"ok" \| "incompatible"` | yes | 1.11.0 |  |
| `dryRun` | `boolean` | yes | 1.11.0 |  |
| `reason` | `StoreAdoptIncompatibleReason` | no | 1.11.0 |  |
| `storeSchema` | `{ current: SchemaVersion \| null; expected: SchemaVersion }` | no | 1.11.0 |  |
| `identity` | `EmbeddingIdentity \| null` | no | 1.11.0 |  |
| `identitySource` | `StoreAdoptIdentitySource` | no | 1.11.0 | How identity was established when a check ran. |

**Schema**

```json
{
  "title": "StoreAdoptResult",
  "type": "object",
  "properties": {
    "verdict": {
      "type": "string",
      "enum": [
        "ok",
        "incompatible"
      ],
      "x-since": "1.11.0"
    },
    "dryRun": {
      "type": "boolean",
      "x-since": "1.11.0"
    },
    "reason": {
      "$ref": "#/$defs/StoreAdoptIncompatibleReason",
      "x-since": "1.11.0"
    },
    "storeSchema": {
      "type": "object",
      "properties": {
        "current": {
          "anyOf": [
            {
              "$ref": "#/$defs/SchemaVersion"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.11.0"
        },
        "expected": {
          "$ref": "#/$defs/SchemaVersion",
          "x-since": "1.11.0"
        }
      },
      "required": [
        "current",
        "expected"
      ],
      "additionalProperties": false,
      "x-since": "1.11.0"
    },
    "identity": {
      "anyOf": [
        {
          "$ref": "#/$defs/EmbeddingIdentity"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "1.11.0"
    },
    "identitySource": {
      "$ref": "#/$defs/StoreAdoptIdentitySource",
      "description": "How identity was established when a check ran.",
      "x-since": "1.11.0"
    }
  },
  "required": [
    "verdict",
    "dryRun"
  ],
  "additionalProperties": false,
  "x-since": "1.11.0",
  "description": "Store Adopt Result in the engine contract."
}
```

## `StoreOps`

**Since:** 1.11.0

Store Ops in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `adopt(req: StoreAdoptRequest): StoreAdoptResult` | 1.11.0 | 1.11.0: inspect a copied store (copy-never-move). Does not migrate, does not re-embed, and does not take `state/core.lock` — the host holds that lock before `createEngine`. `incompatible` is a result, not a throw. |

**Schema**

```json
{
  "title": "StoreOps",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "adopt": {
      "x-since": "1.11.0",
      "parameters": [
        {
          "name": "req",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/StoreAdoptRequest"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/StoreAdoptResult"
      },
      "description": "1.11.0: inspect a copied store (copy-never-move). Does not migrate, does not re-embed, and does not take `state/core.lock` — the host holds that lock before `createEngine`. `incompatible` is a result, not a throw."
    }
  },
  "x-since": "1.11.0",
  "description": "Store Ops in the engine contract.",
  "x-runtime": true
}
```

## `EngineEventName`

**Since:** 1.0.0

Engine Event Name in the engine contract.

**Type:** `"dream.completed" \| "job.run" \| "acl.denied" \| "recall.degraded" \| "embedding.identity.changed" \| "recall.block-clipped" \| "recall.block-dropped" \| "recall.completed" \| "memory.proposal"`

| Enum member | Since |
|---|---|
| `recall.block-clipped` | 1.4.0 |
| `recall.block-dropped` | 1.4.0 |
| `recall.completed` | 1.4.0 |
| `memory.proposal` | 1.6.0 |

**Schema**

```json
{
  "title": "EngineEventName",
  "type": "string",
  "enum": [
    "dream.completed",
    "job.run",
    "acl.denied",
    "recall.degraded",
    "embedding.identity.changed",
    "recall.block-clipped",
    "recall.block-dropped",
    "recall.completed",
    "memory.proposal"
  ],
  "x-since": "1.0.0",
  "description": "Engine Event Name in the engine contract.",
  "x-enum-since": {
    "recall.block-clipped": "1.4.0",
    "recall.block-dropped": "1.4.0",
    "recall.completed": "1.4.0",
    "memory.proposal": "1.6.0"
  }
}
```

## `EngineEvents`

**Since:** 1.0.0

Engine Events in the engine contract.

**Type:** `{}`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Method signature | Since | Description |
|---|---|---|
| `on(event: EngineEventName, handler: {}): Disposable` | 1.0.0 |  |

**Schema**

```json
{
  "title": "EngineEvents",
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "x-methods": {
    "on": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "event",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/EngineEventName"
          }
        },
        {
          "name": "handler",
          "optional": false,
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "x-runtime": true,
            "x-methods": {
              "$call": {
                "x-since": "1.0.0",
                "parameters": [
                  {
                    "name": "payload",
                    "optional": false,
                    "schema": {}
                  }
                ],
                "returns": {
                  "type": "null"
                }
              }
            }
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/Disposable"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Engine Events in the engine contract.",
  "x-runtime": true
}
```

## `JobLastRun`

**Since:** 1.8.0

Job Last Run in the engine contract.

**Type:** `{ runId: string; outcome: JobOutcome; reason?: string; trigger: JobTrigger; startedAt: number; finishedAt: number; attempt: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `runId` | `string` | yes | 1.8.0 |  |
| `outcome` | `JobOutcome` | yes | 1.8.0 |  |
| `reason` | `string` | no | 1.8.0 |  |
| `trigger` | `JobTrigger` | yes | 1.8.0 |  |
| `startedAt` | `number` | yes | 1.8.0 |  |
| `finishedAt` | `number` | yes | 1.8.0 |  |
| `attempt` | `number` | yes | 1.8.0 |  |

**Schema**

```json
{
  "title": "JobLastRun",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "x-since": "1.8.0"
    },
    "outcome": {
      "$ref": "#/$defs/JobOutcome",
      "x-since": "1.8.0"
    },
    "reason": {
      "type": "string",
      "x-since": "1.8.0"
    },
    "trigger": {
      "$ref": "#/$defs/JobTrigger",
      "x-since": "1.8.0"
    },
    "startedAt": {
      "type": "number",
      "x-since": "1.8.0"
    },
    "finishedAt": {
      "type": "number",
      "x-since": "1.8.0"
    },
    "attempt": {
      "type": "number",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "runId",
    "outcome",
    "trigger",
    "startedAt",
    "finishedAt",
    "attempt"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Job Last Run in the engine contract."
}
```

## `BreakerState`

**Since:** 1.8.0

Breaker State in the engine contract.

**Type:** `{ sweep: string; sessions: number; limit: number; open: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `sweep` | `string` | yes | 1.8.0 |  |
| `sessions` | `number` | yes | 1.8.0 |  |
| `limit` | `number` | yes | 1.8.0 |  |
| `open` | `boolean` | yes | 1.8.0 |  |

**Schema**

```json
{
  "title": "BreakerState",
  "type": "object",
  "properties": {
    "sweep": {
      "type": "string",
      "x-since": "1.8.0"
    },
    "sessions": {
      "type": "number",
      "x-since": "1.8.0"
    },
    "limit": {
      "type": "number",
      "x-since": "1.8.0"
    },
    "open": {
      "type": "boolean",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "sweep",
    "sessions",
    "limit",
    "open"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Breaker State in the engine contract."
}
```

## `AgentJobHealth`

**Since:** 1.8.0

Agent Job Health in the engine contract.

**Type:** `{ agentId: AgentId; lastRuns: { [key: string]: JobLastRun }; running: Array<JobName>; breaker: BreakerState; unreadableLines: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.8.0 |  |
| `lastRuns` | `{ [key: string]: JobLastRun }` | yes | 1.8.0 | Latest finished run per job (by finishedAt); jobs that never ran are absent. |
| `running` | `Array<JobName>` | yes | 1.8.0 | Jobs with a run in flight in this process, sorted. |
| `breaker` | `BreakerState` | yes | 1.8.0 | rem/deep LLM-session breaker for the current UTC sweep, in-flight sessions included. |
| `unreadableLines` | `number` | yes | 1.8.0 | Ledger lines that could not be parsed. |

**Schema**

```json
{
  "title": "AgentJobHealth",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.8.0"
    },
    "lastRuns": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/JobLastRun"
      },
      "description": "Latest finished run per job (by finishedAt); jobs that never ran are absent.",
      "x-since": "1.8.0"
    },
    "running": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/JobName"
      },
      "description": "Jobs with a run in flight in this process, sorted.",
      "x-since": "1.8.0"
    },
    "breaker": {
      "$ref": "#/$defs/BreakerState",
      "description": "rem/deep LLM-session breaker for the current UTC sweep, in-flight sessions included.",
      "x-since": "1.8.0"
    },
    "unreadableLines": {
      "type": "number",
      "description": "Ledger lines that could not be parsed.",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "agentId",
    "lastRuns",
    "running",
    "breaker",
    "unreadableLines"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Agent Job Health in the engine contract."
}
```

## `JobsHealth`

**Since:** 1.8.0

Jobs Health in the engine contract.

**Type:** `{ ledger: "ok" \| "unavailable"; agents: Array<AgentJobHealth> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `ledger` | `"ok" \| "unavailable"` | yes | 1.8.0 |  |
| `agents` | `Array<AgentJobHealth>` | yes | 1.8.0 |  |

**Schema**

```json
{
  "title": "JobsHealth",
  "type": "object",
  "properties": {
    "ledger": {
      "type": "string",
      "enum": [
        "ok",
        "unavailable"
      ],
      "x-since": "1.8.0"
    },
    "agents": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/AgentJobHealth"
      },
      "x-since": "1.8.0"
    }
  },
  "required": [
    "ledger",
    "agents"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Jobs Health in the engine contract."
}
```

## `SharedMemoryMode`

**Since:** 1.8.0

Shared Memory Mode in the engine contract.

**Type:** `"fd-capability" \| "verified-path" \| "unavailable"`

**Schema**

```json
{
  "title": "SharedMemoryMode",
  "type": "string",
  "enum": [
    "fd-capability",
    "verified-path",
    "unavailable"
  ],
  "x-since": "1.8.0",
  "description": "Shared Memory Mode in the engine contract."
}
```

## `SharedMemorySupport`

**Since:** 1.8.0

Shared Memory Support in the engine contract.

**Type:** `{ supported: boolean; mode: SharedMemoryMode; reason?: "platform" \| "unsafe-root" \| "acl-tool-unavailable" \| "identity-changed" }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `supported` | `boolean` | yes | 1.8.0 |  |
| `mode` | `SharedMemoryMode` | yes | 1.8.0 |  |
| `reason` | `"platform" \| "unsafe-root" \| "acl-tool-unavailable" \| "identity-changed"` | no | 1.8.0 | Why it is unsupported: the platform lacks a mode, the shared root failed its safety check, the Windows ACL reader is missing, or the root's identity changed during a lease (pool refuses until restart). |

**Schema**

```json
{
  "title": "SharedMemorySupport",
  "type": "object",
  "properties": {
    "supported": {
      "type": "boolean",
      "x-since": "1.8.0"
    },
    "mode": {
      "$ref": "#/$defs/SharedMemoryMode",
      "x-since": "1.8.0"
    },
    "reason": {
      "type": "string",
      "enum": [
        "platform",
        "unsafe-root",
        "acl-tool-unavailable",
        "identity-changed"
      ],
      "description": "Why it is unsupported: the platform lacks a mode, the shared root failed its safety check, the Windows ACL reader is missing, or the root's identity changed during a lease (pool refuses until restart).",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "supported",
    "mode"
  ],
  "additionalProperties": false,
  "x-since": "1.8.0",
  "description": "Shared Memory Support in the engine contract."
}
```

## `EngineStatus`

**Since:** 1.0.0

Engine Status in the engine contract.

**Type:** `{ ready: boolean; degraded: Degraded \| null; agents: number; contract: ContractVersion; storeSchema: { current: SchemaVersion \| null; expected: SchemaVersion }; jobs: JobsHealth; models: ModelsStatus; journal: JournalBacklog \| null; sharedMemory: SharedMemorySupport }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `ready` | `boolean` | yes | 1.0.0 |  |
| `degraded` | `Degraded \| null` | yes | 1.8.0 | 1.8.0: derived from models — embedder failed → {reason:"model-failed",capability:"embedding"}; embedder loading → {reason:"models-warming",capability:"embedding"}; reranker failed → model-failed/"reranker"; reranker loading → models-warming/"reranker"; first match wins; otherwise null. |
| `agents` | `number` | yes | 1.0.0 |  |
| `contract` | `ContractVersion` | yes | 1.0.0 |  |
| `storeSchema` | `{ current: SchemaVersion \| null; expected: SchemaVersion }` | yes | 1.6.0 |  |
| `jobs` | `JobsHealth` | yes | 1.8.0 | 1.8.0 |
| `models` | `ModelsStatus` | yes | 1.8.0 | 1.8.0 |
| `journal` | `JournalBacklog \| null` | yes | 1.8.0 | 1.8.0: null when the host reports none. |
| `sharedMemory` | `SharedMemorySupport` | yes | 1.8.0 | 1.8.0 |

**Schema**

```json
{
  "title": "EngineStatus",
  "type": "object",
  "properties": {
    "ready": {
      "type": "boolean",
      "x-since": "1.0.0"
    },
    "degraded": {
      "anyOf": [
        {
          "$ref": "#/$defs/Degraded"
        },
        {
          "type": "null"
        }
      ],
      "description": "1.8.0: derived from models — embedder failed → {reason:\"model-failed\",capability:\"embedding\"}; embedder loading → {reason:\"models-warming\",capability:\"embedding\"}; reranker failed → model-failed/\"reranker\"; reranker loading → models-warming/\"reranker\"; first match wins; otherwise null.",
      "x-since": "1.8.0"
    },
    "agents": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "contract": {
      "$ref": "#/$defs/ContractVersion",
      "x-since": "1.0.0"
    },
    "storeSchema": {
      "type": "object",
      "properties": {
        "current": {
          "anyOf": [
            {
              "$ref": "#/$defs/SchemaVersion"
            },
            {
              "type": "null"
            }
          ],
          "x-since": "1.0.0"
        },
        "expected": {
          "$ref": "#/$defs/SchemaVersion",
          "x-since": "1.0.0"
        }
      },
      "required": [
        "current",
        "expected"
      ],
      "additionalProperties": false,
      "x-since": "1.6.0"
    },
    "jobs": {
      "$ref": "#/$defs/JobsHealth",
      "description": "1.8.0",
      "x-since": "1.8.0"
    },
    "models": {
      "$ref": "#/$defs/ModelsStatus",
      "description": "1.8.0",
      "x-since": "1.8.0"
    },
    "journal": {
      "anyOf": [
        {
          "$ref": "#/$defs/JournalBacklog"
        },
        {
          "type": "null"
        }
      ],
      "description": "1.8.0: null when the host reports none.",
      "x-since": "1.8.0"
    },
    "sharedMemory": {
      "$ref": "#/$defs/SharedMemorySupport",
      "description": "1.8.0",
      "x-since": "1.8.0"
    }
  },
  "required": [
    "ready",
    "degraded",
    "agents",
    "contract",
    "storeSchema",
    "jobs",
    "models",
    "journal",
    "sharedMemory"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "description": "Engine Status in the engine contract."
}
```

## `AgentStore`

**Since:** 1.0.0

Agent Store in the engine contract.

**Type:** `{ agentId: AgentId }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | 1.0.0 |  |

| Method signature | Since | Description |
|---|---|---|
| `close(): null` | 1.0.0 |  |

**Schema**

```json
{
  "title": "AgentStore",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "agentId"
  ],
  "additionalProperties": false,
  "x-methods": {
    "close": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "type": "null"
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Agent Store in the engine contract.",
  "x-runtime": true
}
```

## `EngineCapabilities`

**Since:** 1.16.0

1.16.0: additive feature flags a host can test before calling an optional surface.

**Type:** `{ memoryLink: boolean; recallStats: boolean; knowledgePromotion: boolean; memoryCuration: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `memoryLink` | `boolean` | yes | 1.16.0 | `MemoryOps.link`, `MemoryCard.links`, unimport unlinks by run. |
| `recallStats` | `boolean` | yes | a1-pending |  |
| `knowledgePromotion` | `boolean` | yes | a1-pending |  |
| `memoryCuration` | `boolean` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "EngineCapabilities",
  "type": "object",
  "properties": {
    "memoryLink": {
      "type": "boolean",
      "description": "`MemoryOps.link`, `MemoryCard.links`, unimport unlinks by run.",
      "x-since": "1.16.0"
    },
    "recallStats": {
      "type": "boolean",
      "x-since": "a1-pending"
    },
    "knowledgePromotion": {
      "type": "boolean",
      "x-since": "a1-pending"
    },
    "memoryCuration": {
      "type": "boolean",
      "x-since": "a1-pending"
    }
  },
  "required": [
    "memoryLink",
    "recallStats",
    "knowledgePromotion",
    "memoryCuration"
  ],
  "additionalProperties": false,
  "x-since": "1.16.0",
  "description": "1.16.0: additive feature flags a host can test before calling an optional surface."
}
```

## `Engine`

**Since:** 1.0.0

Engine in the engine contract.

**Type:** `{ contract: ContractVersion; capabilities: EngineCapabilities; memory: MemoryOps; jobs: JobRegistry; embedding: EmbeddingService; models: ModelsService; admin: AdminOps; stores: StoreOps; events: EngineEvents }`

**Runtime interface:** methods and ports are supplied by the Rust contract.

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `contract` | `ContractVersion` | yes | 1.0.0 |  |
| `capabilities` | `EngineCapabilities` | yes | 1.16.0 | 1.16.0: frozen. |
| `memory` | `MemoryOps` | yes | 1.5.0 |  |
| `jobs` | `JobRegistry` | yes | 1.0.0 |  |
| `embedding` | `EmbeddingService` | yes | 1.0.0 |  |
| `models` | `ModelsService` | yes | 1.8.0 | 1.8.0 |
| `admin` | `AdminOps` | yes | 1.0.0 |  |
| `stores` | `StoreOps` | yes | 1.11.0 | 1.11.0: inspect a copied store before the host points `baseDbPath` at it. |
| `events` | `EngineEvents` | yes | 1.0.0 |  |

| Method signature | Since | Description |
|---|---|---|
| `open(agentId: AgentId): AgentStore` | 1.0.0 |  |
| `close(opts?: { budgetMs?: number }): null` | 1.4.0 | Idempotent: every call returns the same promise. Resolves within `budgetMs` (default 30 000) even if resources are still closing. |
| `status(): EngineStatus` | 1.0.0 |  |
| `systemSupplement(): Array<string>` | 1.0.0 | Stable, cached prefix (index.js:7073-7088). |
| `recall(q: RecallQuery, opts?: RecallOptions): RecallResult` | 1.0.0 | Never throws; a failure comes back as `degraded`. |
| `capture(t: TurnRecord, opts?: CaptureOptions): CaptureHandle` | 1.0.0 | Non-blocking. |
| `checkpoint(agentId: AgentId, reason: CheckpointReason): CheckpointResult` | 1.0.0 |  |
| `channels.register(name: ChannelRef): string` | 1.0.0 |  |
| `channels.has(name: ChannelRef): boolean` | 1.0.0 |  |
| `channels.list(): Array<ChannelRef>` | 1.0.0 |  |

**Schema**

```json
{
  "title": "Engine",
  "type": "object",
  "properties": {
    "contract": {
      "$ref": "#/$defs/ContractVersion",
      "x-since": "1.0.0"
    },
    "capabilities": {
      "$ref": "#/$defs/EngineCapabilities",
      "description": "1.16.0: frozen.",
      "x-since": "1.16.0"
    },
    "memory": {
      "$ref": "#/$defs/MemoryOps",
      "x-since": "1.5.0"
    },
    "jobs": {
      "$ref": "#/$defs/JobRegistry",
      "x-since": "1.0.0"
    },
    "embedding": {
      "$ref": "#/$defs/EmbeddingService",
      "x-since": "1.0.0"
    },
    "models": {
      "$ref": "#/$defs/ModelsService",
      "description": "1.8.0",
      "x-since": "1.8.0"
    },
    "admin": {
      "$ref": "#/$defs/AdminOps",
      "x-since": "1.0.0"
    },
    "stores": {
      "$ref": "#/$defs/StoreOps",
      "description": "1.11.0: inspect a copied store before the host points `baseDbPath` at it.",
      "x-since": "1.11.0"
    },
    "events": {
      "$ref": "#/$defs/EngineEvents",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "contract",
    "capabilities",
    "memory",
    "jobs",
    "embedding",
    "models",
    "admin",
    "stores",
    "events"
  ],
  "additionalProperties": false,
  "x-methods": {
    "open": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "agentId",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentId"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/AgentStore"
      }
    },
    "close": {
      "x-since": "1.4.0",
      "parameters": [
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "type": "object",
            "properties": {
              "budgetMs": {
                "type": "number",
                "x-since": "1.0.0"
              }
            },
            "additionalProperties": false
          }
        }
      ],
      "returns": {
        "type": "null"
      },
      "description": "Idempotent: every call returns the same promise. Resolves within `budgetMs` (default 30 000) even if resources are still closing."
    },
    "status": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "$ref": "#/$defs/EngineStatus"
      }
    },
    "systemSupplement": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "description": "Stable, cached prefix (index.js:7073-7088)."
    },
    "recall": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "q",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/RecallQuery"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "$ref": "#/$defs/RecallOptions"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/RecallResult"
      },
      "description": "Never throws; a failure comes back as `degraded`."
    },
    "capture": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "t",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/TurnRecord"
          }
        },
        {
          "name": "opts",
          "optional": true,
          "schema": {
            "$ref": "#/$defs/CaptureOptions"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/CaptureHandle"
      },
      "description": "Non-blocking."
    },
    "checkpoint": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "agentId",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/AgentId"
          }
        },
        {
          "name": "reason",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/CheckpointReason"
          }
        }
      ],
      "returns": {
        "$ref": "#/$defs/CheckpointResult"
      }
    },
    "channels.register": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "name",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/ChannelRef"
          }
        }
      ],
      "returns": {
        "type": "string"
      }
    },
    "channels.has": {
      "x-since": "1.0.0",
      "parameters": [
        {
          "name": "name",
          "optional": false,
          "schema": {
            "$ref": "#/$defs/ChannelRef"
          }
        }
      ],
      "returns": {
        "type": "boolean"
      }
    },
    "channels.list": {
      "x-since": "1.0.0",
      "parameters": [],
      "returns": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/ChannelRef"
        }
      }
    }
  },
  "x-since": "1.0.0",
  "description": "Engine in the engine contract.",
  "x-runtime": true
}
```

## `MemoryRecallStat`

**Since:** a1-pending

Every member rejects with MemoryOpError `storage` ("engine is closed") after `Engine.close()`. `list` and `show` read the agent-private pool plus the workspace and user pools the principal can reach. `forget`, `correct` and `share` act on the caller's own agent-private cards. On a shared (workspace/user) copy (D31): `forget` by the sharing agent retracts the copy (archive-first, soft delete; `tombstoneId` is null because the original stays live); `correct` by the sharing agent refreshes it (corrects the original, shares the new version, then retracts the old copy; the result id is the new copy); any other agent answers `denied` and files `propose` instead; `share` of a copy is always `denied`. Proposals never change a memory until the sharer calls `proposals.accept`. A proposal belongs to the shared pool of its copy: `proposals.*` reach it only through a principal that can reach that pool (otherwise `list` omits it and `accept`/`reject` answer `not-found`).

**Type:** `{ id: string; recalls: number; distinctQueries: number; lastRecalledAt: number \| null }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | a1-pending |  |
| `recalls` | `number` | yes | a1-pending |  |
| `distinctQueries` | `number` | yes | a1-pending |  |
| `lastRecalledAt` | `number \| null` | yes | a1-pending | Epoch milliseconds, null when this card has not been recalled. |

**Schema**

```json
{
  "title": "MemoryRecallStat",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "a1-pending"
    },
    "recalls": {
      "type": "number",
      "x-since": "a1-pending"
    },
    "distinctQueries": {
      "type": "number",
      "x-since": "a1-pending"
    },
    "lastRecalledAt": {
      "anyOf": [
        {
          "type": "number"
        },
        {
          "type": "null"
        }
      ],
      "description": "Epoch milliseconds, null when this card has not been recalled.",
      "x-since": "a1-pending"
    }
  },
  "required": [
    "id",
    "recalls",
    "distinctQueries",
    "lastRecalledAt"
  ],
  "additionalProperties": false,
  "x-since": "a1-pending",
  "description": "Every member rejects with MemoryOpError `storage` (\"engine is closed\") after `Engine.close()`. `list` and `show` read the agent-private pool plus the workspace and user pools the principal can reach. `forget`, `correct` and `share` act on the caller's own agent-private cards. On a shared (workspace/user) copy (D31): `forget` by the sharing agent retracts the copy (archive-first, soft delete; `tombstoneId` is null because the original stays live); `correct` by the sharing agent refreshes it (corrects the original, shares the new version, then retracts the old copy; the result id is the new copy); any other agent answers `denied` and files `propose` instead; `share` of a copy is always `denied`. Proposals never change a memory until the sharer calls `proposals.accept`. A proposal belongs to the shared pool of its copy: `proposals.*` reach it only through a principal that can reach that pool (otherwise `list` omits it and `accept`/`reject` answer `not-found`)."
}
```

## `MemoryStatsResult`

**Since:** a1-pending

Memory Stats Result in the engine contract.

**Type:** `{ agentId: AgentId; items: Array<MemoryRecallStat> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | a1-pending |  |
| `items` | `Array<MemoryRecallStat>` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryStatsResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "a1-pending"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryRecallStat"
      },
      "x-since": "a1-pending"
    }
  },
  "required": [
    "agentId",
    "items"
  ],
  "additionalProperties": false,
  "x-since": "a1-pending",
  "description": "Memory Stats Result in the engine contract."
}
```

## `MemoryPromotionReason`

**Since:** a1-pending

Memory Promotion Reason in the engine contract.

**Type:** `"integrated" \| "disabled" \| "lock-busy" \| "not-found" \| "not-live" \| "scope-not-publishable" \| "importance-pending" \| "importance-below-threshold" \| "already-promoted" \| "cap-reached"`

**Schema**

```json
{
  "title": "MemoryPromotionReason",
  "type": "string",
  "enum": [
    "integrated",
    "disabled",
    "lock-busy",
    "not-found",
    "not-live",
    "scope-not-publishable",
    "importance-pending",
    "importance-below-threshold",
    "already-promoted",
    "cap-reached"
  ],
  "x-since": "a1-pending",
  "description": "Memory Promotion Reason in the engine contract."
}
```

## `MemoryPromotionResult`

**Since:** a1-pending

Memory Promotion Result in the engine contract.

**Type:** `{ agentId: AgentId; items: Array<{ id: string; outcome: "promoted" \| "skipped"; reason: MemoryPromotionReason }> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | a1-pending |  |
| `items` | `Array<{ id: string; outcome: "promoted" \| "skipped"; reason: MemoryPromotionReason }>` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryPromotionResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "a1-pending"
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "x-since": "1.5.0"
          },
          "outcome": {
            "type": "string",
            "enum": [
              "promoted",
              "skipped"
            ],
            "x-since": "1.5.0"
          },
          "reason": {
            "$ref": "#/$defs/MemoryPromotionReason",
            "x-since": "1.5.0"
          }
        },
        "required": [
          "id",
          "outcome",
          "reason"
        ],
        "additionalProperties": false
      },
      "x-since": "a1-pending"
    }
  },
  "required": [
    "agentId",
    "items"
  ],
  "additionalProperties": false,
  "x-since": "a1-pending",
  "description": "Memory Promotion Result in the engine contract."
}
```

## `MemoryCurationRecord`

**Since:** a1-pending

Memory Curation Record in the engine contract.

**Type:** `{ id: string; status: string; text: string; category: string \| null }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | a1-pending |  |
| `status` | `string` | yes | a1-pending |  |
| `text` | `string` | yes | a1-pending |  |
| `category` | `string \| null` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryCurationRecord",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "a1-pending"
    },
    "status": {
      "type": "string",
      "x-since": "a1-pending"
    },
    "text": {
      "type": "string",
      "x-since": "a1-pending"
    },
    "category": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "x-since": "a1-pending"
    }
  },
  "required": [
    "id",
    "status",
    "text",
    "category"
  ],
  "additionalProperties": false,
  "x-since": "a1-pending",
  "description": "Memory Curation Record in the engine contract."
}
```

## `MemoryCurationListResult`

**Since:** a1-pending

Memory Curation List Result in the engine contract.

**Type:** `{ agentId: AgentId; items: Array<MemoryCurationRecord>; truncated: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `agentId` | `AgentId` | yes | a1-pending |  |
| `items` | `Array<MemoryCurationRecord>` | yes | a1-pending |  |
| `truncated` | `boolean` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryCurationListResult",
  "type": "object",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "x-since": "a1-pending"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryCurationRecord"
      },
      "x-since": "a1-pending"
    },
    "truncated": {
      "type": "boolean",
      "x-since": "a1-pending"
    }
  },
  "required": [
    "agentId",
    "items",
    "truncated"
  ],
  "additionalProperties": false,
  "x-since": "a1-pending",
  "description": "Memory Curation List Result in the engine contract."
}
```

## `MemoryRow`

**Since:** 1.0.0

Canonical persisted memory row, including all 69 columns of the pinned store bootstrap schema. The wire preserves camelCase column names.

**Type:** `{ id: string; type: string; confirmed: boolean; text: string; summary: string; origin: string; vector: Array<number>; importance: number; category: string; createdAt: number; mergedFrom: string; expiresAt: number; agentId: string; storedBy: string; sourceTurnId: string; sourceMessageRole: string; sourceTimestamp: number; sourceUrl: string; evidenceQuote: string; scope: string; ownerUserId: string; emotionalValence: string; emotionalIntensity: number; emotionalDominant: string; moodContextAtCapture: string; emotionStatus: string; importanceStatus: string; replayCount: number; lastReplayed: number; retrievalCount: number; lastRetrievedAt: number; memoryStrength: number; halfLifeDays: number; lastStrengthenedAt: number; lastDynamicsAt: number; memoryClass: string; neverForget: number; coreMemoryScore: number; coreMemoryReason: string; versionNumber: number; previousVersion: string; supersededBy: string; updateSource: string; updateEvidence: string; reconsolidationConfidence: number; status: string; versionCreatedAt: number; updatedAt: number; workspaceId: string; workspaceKey: string; memoryKind: string; reminderStatus: string; remindAt: number; remindedAt: number; dispatchedAt: number; acknowledgedAt: number; cancelledAt: number; reminderKey: string; dispatchCount: number; lastDispatchAttemptAt: number; nextDispatchAttemptAt: number; epistemicStatus: string; epistemicStatusUpdatedAt: number; epistemicStatusActor: string; epistemicStatusReason: string; previousEpistemicStatus: string; validFrom: number; validUntil: number; chunkGroupId: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | 1.0.0 |  |
| `type` | `string` | yes | 1.0.0 |  |
| `confirmed` | `boolean` | yes | 1.0.0 |  |
| `text` | `string` | yes | 1.0.0 |  |
| `summary` | `string` | yes | 1.0.0 |  |
| `origin` | `string` | yes | 1.0.0 |  |
| `vector` | `Array<number>` | yes | 1.0.0 | Embedding vector in the active vector space. |
| `importance` | `number` | yes | 1.0.0 |  |
| `category` | `string` | yes | 1.0.0 |  |
| `createdAt` | `number` | yes | 1.0.0 |  |
| `mergedFrom` | `string` | yes | 1.0.0 |  |
| `expiresAt` | `number` | yes | 1.0.0 |  |
| `agentId` | `string` | yes | 1.0.0 |  |
| `storedBy` | `string` | yes | 1.0.0 |  |
| `sourceTurnId` | `string` | yes | 1.0.0 |  |
| `sourceMessageRole` | `string` | yes | 1.0.0 |  |
| `sourceTimestamp` | `number` | yes | 1.0.0 |  |
| `sourceUrl` | `string` | yes | 1.0.0 |  |
| `evidenceQuote` | `string` | yes | 1.0.0 |  |
| `scope` | `string` | yes | 1.0.0 |  |
| `ownerUserId` | `string` | yes | 1.0.0 |  |
| `emotionalValence` | `string` | yes | 1.0.0 |  |
| `emotionalIntensity` | `number` | yes | 1.0.0 |  |
| `emotionalDominant` | `string` | yes | 1.0.0 |  |
| `moodContextAtCapture` | `string` | yes | 1.0.0 |  |
| `emotionStatus` | `string` | yes | 1.0.0 |  |
| `importanceStatus` | `string` | yes | 1.0.0 |  |
| `replayCount` | `number` | yes | 1.0.0 |  |
| `lastReplayed` | `number` | yes | 1.0.0 |  |
| `retrievalCount` | `number` | yes | 1.0.0 |  |
| `lastRetrievedAt` | `number` | yes | 1.0.0 |  |
| `memoryStrength` | `number` | yes | 1.0.0 |  |
| `halfLifeDays` | `number` | yes | 1.0.0 |  |
| `lastStrengthenedAt` | `number` | yes | 1.0.0 |  |
| `lastDynamicsAt` | `number` | yes | 1.0.0 |  |
| `memoryClass` | `string` | yes | 1.0.0 |  |
| `neverForget` | `number` | yes | 1.0.0 |  |
| `coreMemoryScore` | `number` | yes | 1.0.0 |  |
| `coreMemoryReason` | `string` | yes | 1.0.0 |  |
| `versionNumber` | `number` | yes | 1.0.0 |  |
| `previousVersion` | `string` | yes | 1.0.0 |  |
| `supersededBy` | `string` | yes | 1.0.0 |  |
| `updateSource` | `string` | yes | 1.0.0 |  |
| `updateEvidence` | `string` | yes | 1.0.0 |  |
| `reconsolidationConfidence` | `number` | yes | 1.0.0 |  |
| `status` | `string` | yes | 1.0.0 |  |
| `versionCreatedAt` | `number` | yes | 1.0.0 |  |
| `updatedAt` | `number` | yes | 1.0.0 |  |
| `workspaceId` | `string` | yes | 1.0.0 |  |
| `workspaceKey` | `string` | yes | 1.0.0 |  |
| `memoryKind` | `string` | yes | 1.0.0 |  |
| `reminderStatus` | `string` | yes | 1.0.0 |  |
| `remindAt` | `number` | yes | 1.0.0 |  |
| `remindedAt` | `number` | yes | 1.0.0 |  |
| `dispatchedAt` | `number` | yes | 1.0.0 |  |
| `acknowledgedAt` | `number` | yes | 1.0.0 |  |
| `cancelledAt` | `number` | yes | 1.0.0 |  |
| `reminderKey` | `string` | yes | 1.0.0 |  |
| `dispatchCount` | `number` | yes | 1.0.0 |  |
| `lastDispatchAttemptAt` | `number` | yes | 1.0.0 |  |
| `nextDispatchAttemptAt` | `number` | yes | 1.0.0 |  |
| `epistemicStatus` | `string` | yes | 1.0.0 |  |
| `epistemicStatusUpdatedAt` | `number` | yes | 1.0.0 |  |
| `epistemicStatusActor` | `string` | yes | 1.0.0 |  |
| `epistemicStatusReason` | `string` | yes | 1.0.0 |  |
| `previousEpistemicStatus` | `string` | yes | 1.0.0 |  |
| `validFrom` | `number` | yes | 1.0.0 |  |
| `validUntil` | `number` | yes | 1.0.0 |  |
| `chunkGroupId` | `string` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "MemoryRow",
  "description": "Canonical persisted memory row, including all 69 columns of the pinned store bootstrap schema. The wire preserves camelCase column names.",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "type": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "confirmed": {
      "type": "boolean",
      "x-since": "1.0.0"
    },
    "text": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "summary": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "origin": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "vector": {
      "type": "array",
      "items": {
        "type": "number",
        "format": "float"
      },
      "description": "Embedding vector in the active vector space.",
      "x-since": "1.0.0"
    },
    "importance": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "category": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "createdAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "mergedFrom": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "expiresAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "agentId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "storedBy": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "sourceTurnId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "sourceMessageRole": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "sourceTimestamp": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "sourceUrl": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "evidenceQuote": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "scope": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "ownerUserId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "emotionalValence": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "emotionalIntensity": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "emotionalDominant": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "moodContextAtCapture": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "emotionStatus": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "importanceStatus": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "replayCount": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "lastReplayed": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "retrievalCount": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "lastRetrievedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "memoryStrength": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "halfLifeDays": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "lastStrengthenedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "lastDynamicsAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "memoryClass": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "neverForget": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "coreMemoryScore": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "coreMemoryReason": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "versionNumber": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "previousVersion": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "supersededBy": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "updateSource": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "updateEvidence": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "reconsolidationConfidence": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "status": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "versionCreatedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "updatedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "workspaceId": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "workspaceKey": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "memoryKind": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "reminderStatus": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "remindAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "remindedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "dispatchedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "acknowledgedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "cancelledAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "reminderKey": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "dispatchCount": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "lastDispatchAttemptAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "nextDispatchAttemptAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "epistemicStatus": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "epistemicStatusUpdatedAt": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "epistemicStatusActor": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "epistemicStatusReason": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "previousEpistemicStatus": {
      "type": "string",
      "x-since": "1.0.0"
    },
    "validFrom": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "validUntil": {
      "type": "number",
      "x-since": "1.0.0"
    },
    "chunkGroupId": {
      "type": "string",
      "x-since": "1.0.0"
    }
  },
  "required": [
    "id",
    "type",
    "confirmed",
    "text",
    "summary",
    "origin",
    "vector",
    "importance",
    "category",
    "createdAt",
    "mergedFrom",
    "expiresAt",
    "agentId",
    "storedBy",
    "sourceTurnId",
    "sourceMessageRole",
    "sourceTimestamp",
    "sourceUrl",
    "evidenceQuote",
    "scope",
    "ownerUserId",
    "emotionalValence",
    "emotionalIntensity",
    "emotionalDominant",
    "moodContextAtCapture",
    "emotionStatus",
    "importanceStatus",
    "replayCount",
    "lastReplayed",
    "retrievalCount",
    "lastRetrievedAt",
    "memoryStrength",
    "halfLifeDays",
    "lastStrengthenedAt",
    "lastDynamicsAt",
    "memoryClass",
    "neverForget",
    "coreMemoryScore",
    "coreMemoryReason",
    "versionNumber",
    "previousVersion",
    "supersededBy",
    "updateSource",
    "updateEvidence",
    "reconsolidationConfidence",
    "status",
    "versionCreatedAt",
    "updatedAt",
    "workspaceId",
    "workspaceKey",
    "memoryKind",
    "reminderStatus",
    "remindAt",
    "remindedAt",
    "dispatchedAt",
    "acknowledgedAt",
    "cancelledAt",
    "reminderKey",
    "dispatchCount",
    "lastDispatchAttemptAt",
    "nextDispatchAttemptAt",
    "epistemicStatus",
    "epistemicStatusUpdatedAt",
    "epistemicStatusActor",
    "epistemicStatusReason",
    "previousEpistemicStatus",
    "validFrom",
    "validUntil",
    "chunkGroupId"
  ],
  "additionalProperties": false,
  "x-since": "1.0.0",
  "x-source": "engine/store/memory-db.js:772"
}
```

## `ShareOptions`

**Since:** 1.5.0

Explicit confirmation for sharing sensitive memory after an approval-required refusal.

**Type:** `{ allowSensitive?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `allowSensitive` | `boolean` | no | 1.5.0 |  |

**Schema**

```json
{
  "title": "ShareOptions",
  "type": "object",
  "properties": {
    "allowSensitive": {
      "type": "boolean"
    }
  },
  "additionalProperties": false,
  "description": "Explicit confirmation for sharing sensitive memory after an approval-required refusal.",
  "x-since": "1.5.0"
}
```

## `ProposeOptions`

**Since:** 1.6.0

Optional explanation accompanying a proposed memory correction.

**Type:** `{ note?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `note` | `string` | no | 1.6.0 |  |

**Schema**

```json
{
  "title": "ProposeOptions",
  "type": "object",
  "properties": {
    "note": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "description": "Optional explanation accompanying a proposed memory correction.",
  "x-since": "1.6.0"
}
```

## `ProposalRejectOptions`

**Since:** 1.6.0

Optional explanation when rejecting a proposed memory correction.

**Type:** `{ note?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `note` | `string` | no | 1.6.0 |  |

**Schema**

```json
{
  "title": "ProposalRejectOptions",
  "type": "object",
  "properties": {
    "note": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "description": "Optional explanation when rejecting a proposed memory correction.",
  "x-since": "1.6.0"
}
```

## `ObsidianDetectOptions`

**Since:** 1.6.0

Explicit candidate vault paths for host-neutral vault discovery.

**Type:** `{ candidates?: Array<string> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `candidates` | `Array<string>` | no | 1.6.0 |  |

**Schema**

```json
{
  "title": "ObsidianDetectOptions",
  "type": "object",
  "properties": {
    "candidates": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false,
  "description": "Explicit candidate vault paths for host-neutral vault discovery.",
  "x-since": "1.6.0"
}
```

## `MemoryShareTarget`

**Since:** 1.5.0

Shared ACL scope to which a source memory may be published.

**Type:** `"workspace" \| "user"`

**Schema**

```json
{
  "title": "MemoryShareTarget",
  "type": "string",
  "enum": [
    "workspace",
    "user"
  ],
  "description": "Shared ACL scope to which a source memory may be published.",
  "x-since": "1.5.0"
}
```

## `MemoryCurationAction`

**Since:** a1-pending

Human curation decision on a pending memory record.

**Type:** `"keep" \| "drop"`

**Schema**

```json
{
  "title": "MemoryCurationAction",
  "type": "string",
  "enum": [
    "keep",
    "drop"
  ],
  "description": "Human curation decision on a pending memory record.",
  "x-since": "a1-pending"
}
```

## `EmbedKind`

**Since:** 1.0.0

Embedding purpose, selecting the query or passage prefix.

**Type:** `"query" \| "passage"`

**Schema**

```json
{
  "title": "EmbedKind",
  "type": "string",
  "enum": [
    "query",
    "passage"
  ],
  "description": "Embedding purpose, selecting the query or passage prefix.",
  "x-since": "1.0.0"
}
```

## `RunOptions`

**Since:** 1.0.0

Optional job invocation settings. Cancellation uses the separate Cancel parameter.

**Type:** `{ trigger?: JobTrigger; dryRun?: boolean }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `trigger` | `JobTrigger` | no | 1.0.0 |  |
| `dryRun` | `boolean` | no | 1.0.0 |  |

**Schema**

```json
{
  "title": "RunOptions",
  "type": "object",
  "properties": {
    "trigger": {
      "$ref": "#/$defs/JobTrigger"
    },
    "dryRun": {
      "type": "boolean"
    }
  },
  "additionalProperties": false,
  "description": "Optional job invocation settings. Cancellation uses the separate Cancel parameter.",
  "x-since": "1.0.0"
}
```

## `HistoryFilter`

**Since:** 1.0.0

Optional filters for a per-agent job ledger query.

**Type:** `{ job?: JobName; since?: number; limit?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `job` | `JobName` | no | 1.0.0 |  |
| `since` | `number` | no | 1.0.0 |  |
| `limit` | `number` | no | 1.0.0 | The Node registry caps results only for a positive integer; other numbers mean no cap. |

**Schema**

```json
{
  "title": "HistoryFilter",
  "type": "object",
  "properties": {
    "job": {
      "$ref": "#/$defs/JobName"
    },
    "since": {
      "type": "number"
    },
    "limit": {
      "type": "number",
      "description": "The Node registry caps results only for a positive integer; other numbers mean no cap."
    }
  },
  "additionalProperties": false,
  "description": "Optional filters for a per-agent job ledger query.",
  "x-since": "1.0.0"
}
```

## `EngineEvent`

**Since:** 1.0.0

A named engine event and its event-specific JSON payload.

**Type:** `{ name: EngineEventName; payload: unknown }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `name` | `EngineEventName` | yes | 1.0.0 |  |
| `payload` | `unknown` | yes | 1.0.0 |  |

**Schema**

```json
{
  "title": "EngineEvent",
  "type": "object",
  "properties": {
    "name": {
      "$ref": "#/$defs/EngineEventName"
    },
    "payload": {}
  },
  "required": [
    "name",
    "payload"
  ],
  "additionalProperties": false,
  "description": "A named engine event and its event-specific JSON payload.",
  "x-since": "1.0.0"
}
```

## `MemoryPromoteRequest`

**Since:** a1-pending

A1 foreground promotion request for explicit memory identifiers.

**Type:** `{ ids: Array<string> }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `ids` | `Array<string>` | yes | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryPromoteRequest",
  "type": "object",
  "properties": {
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "ids"
  ],
  "additionalProperties": false,
  "description": "A1 foreground promotion request for explicit memory identifiers.",
  "x-since": "a1-pending"
}
```

## `MemoryCurationListQuery`

**Since:** a1-pending

A1 human curation listing options.

**Type:** `{ limit?: number }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `limit` | `number` | no | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryCurationListQuery",
  "type": "object",
  "properties": {
    "limit": {
      "type": "number"
    }
  },
  "additionalProperties": false,
  "description": "A1 human curation listing options.",
  "x-since": "a1-pending"
}
```

## `MemoryCurationResolveResult`

**Since:** a1-pending

A1 result of keeping or dropping a pending curation record.

**Type:** `{ id: string; ok: boolean; status?: string; reason?: string }`

| Property | Type | Required | Since | Description |
|---|---|---|---|---|
| `id` | `string` | yes | a1-pending |  |
| `ok` | `boolean` | yes | a1-pending |  |
| `status` | `string` | no | a1-pending |  |
| `reason` | `string` | no | a1-pending |  |

**Schema**

```json
{
  "title": "MemoryCurationResolveResult",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "ok": {
      "type": "boolean"
    },
    "status": {
      "type": "string"
    },
    "reason": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "ok"
  ],
  "additionalProperties": false,
  "description": "A1 result of keeping or dropping a pending curation record.",
  "x-since": "a1-pending"
}
```
