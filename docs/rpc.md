# RPC reference (rpc 1.1.0)

Generated from `packages/rpc-schema/schema/rpc.schema.json` by `scripts/gen-docs.mjs` — do not edit by hand; run `pnpm docs:gen`.
JSON-RPC 2.0, one JSON value per line (NDJSON, max 4 MiB per line), on `run/core.sock` (POSIX) or the per-home named pipe
(Windows). The first call on a connection is `core.auth`; its result carries `contract` (engine contract version) and `rpc`
(this schema's version). Design and rationale: `docs/adr/ADR-012-process-model-and-languages.md`.

JSON-RPC 2.0 over NDJSON. Methods are $defs/methods/<name>; notifications are $defs/notifications/<name>.

## Error codes

A closed enum; the core puts the code into every error response as `error.data.error`, with optional `reason` and `detail`.

- `E_UNAUTHORIZED`
- `E_RPC_VERSION`
- `E_NOT_AVAILABLE`
- `E_CORE_UNAVAILABLE`
- `E_INVALID_PARAMS`
- `E_AGENT_UNKNOWN`
- `E_CONFIG_INVALID`
- `E_MODULE_UNKNOWN`
- `E_INTERNAL`
- `E_LOCKED`

## Stability

- `core.auth`
- `core.status`
- `core.shutdown`
- `memory.recall`
- `memory.capture`
- `events.subscribe`
- `events.unsubscribe`
- `core.state` (notification)

Everything else is experimental and may change in any minor release (ADR-016 §4).

## Methods

### `core.auth`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "token"
  ],
  "properties": {
    "token": {
      "type": "string",
      "minLength": 64,
      "maxLength": 64
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "contract",
    "rpc",
    "instanceId",
    "pid"
  ],
  "properties": {
    "contract": {
      "type": "string"
    },
    "rpc": {
      "type": "string"
    },
    "instanceId": {
      "type": "string"
    },
    "pid": {
      "type": "integer"
    },
    "capabilities": {
      "$ref": "#/$defs/Capabilities"
    }
  }
}
```

### `core.status`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "process",
    "contract",
    "rpc",
    "instanceId",
    "pid",
    "uptimeMs",
    "engine",
    "agents"
  ],
  "properties": {
    "process": {
      "$ref": "#/$defs/ProcessState"
    },
    "contract": {
      "type": "string"
    },
    "rpc": {
      "type": "string"
    },
    "instanceId": {
      "type": "string"
    },
    "pid": {
      "type": "integer"
    },
    "uptimeMs": {
      "type": "integer"
    },
    "engine": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "ready",
        "degraded"
      ],
      "properties": {
        "ready": {
          "type": "boolean"
        },
        "degraded": {
          "oneOf": [
            {
              "$ref": "#/$defs/Degraded"
            },
            {
              "type": "null"
            }
          ]
        },
        "storeSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "current",
            "expected"
          ],
          "properties": {
            "current": {
              "oneOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "expected": {
              "type": "string"
            }
          }
        }
      }
    },
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agentId",
          "activity"
        ],
        "properties": {
          "agentId": {
            "$ref": "#/$defs/AgentId"
          },
          "activity": {
            "$ref": "#/$defs/Activity"
          }
        }
      }
    },
    "journalBacklog": {
      "type": "integer"
    }
  }
}
```

### `core.shutdown`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "budgetMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 120000
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "accepted"
  ],
  "properties": {
    "accepted": {
      "const": true
    }
  }
}
```

### `memory.recall`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "query"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "sessionKey": {
      "$ref": "#/$defs/SessionKey"
    },
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "softMs": {
          "type": "integer",
          "minimum": 1
        },
        "hardMs": {
          "type": "integer",
          "minimum": 1
        },
        "capChars": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "joined": {
      "type": "boolean",
      "default": false
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "blocks",
    "capChars",
    "degraded",
    "timing",
    "deferrals"
  ],
  "properties": {
    "blocks": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ContextBlock"
      }
    },
    "capChars": {
      "type": [
        "number",
        "null"
      ],
      "description": "null encodes the engine's Infinity (uncapped join)"
    },
    "degraded": {
      "oneOf": [
        {
          "$ref": "#/$defs/Degraded"
        },
        {
          "type": "null"
        }
      ]
    },
    "trace": {
      "type": "object"
    },
    "timing": {
      "$ref": "#/$defs/RecallTiming"
    },
    "deferrals": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/Deferral"
      }
    },
    "joined": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "text",
        "deferrals"
      ],
      "properties": {
        "text": {
          "type": "string"
        },
        "deferrals": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Deferral"
          }
        }
      }
    }
  }
}
```

### `memory.capture`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "messages"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "sessionKey": {
      "$ref": "#/$defs/SessionKey"
    },
    "runId": {
      "type": "string"
    },
    "messages": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "items": {
        "$ref": "#/$defs/Message"
      }
    },
    "wait": {
      "type": "boolean",
      "default": true,
      "description": "true: await done (bounded by waitMs); false: return the handle id only"
    },
    "waitMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120000,
      "default": 60000
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "acceptedAt"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "acceptedAt": {
      "type": "integer"
    },
    "stored": {
      "type": "integer"
    },
    "skipped": {
      "type": "integer"
    },
    "reason": {
      "type": "string"
    },
    "pending": {
      "type": "boolean"
    }
  }
}
```

### `memory.checkpoint`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "reason"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "reason": {
      "enum": [
        "compaction",
        "session-end",
        "shutdown",
        "manual"
      ]
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "reason",
    "digest",
    "written"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "reason": {
      "type": "string"
    },
    "digest": {
      "type": "string"
    },
    "written": {
      "type": "boolean"
    }
  }
}
```

### `memory.list`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `memory.show`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `memory.forget`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `memory.correct`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `memory.share`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `memory.state`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "$ref": "#/$defs/MemoryOpsParams"
}
```

**result**

```json
{
  "$ref": "#/$defs/MemoryOpsResult"
}
```

### `agent.list`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agents"
  ],
  "properties": {
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agentId",
          "open",
          "activity"
        ],
        "properties": {
          "agentId": {
            "$ref": "#/$defs/AgentId"
          },
          "open": {
            "type": "boolean"
          },
          "activity": {
            "$ref": "#/$defs/Activity"
          }
        }
      }
    }
  }
}
```

### `agent.open`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "open"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "open": {
      "const": true
    }
  }
}
```

### `agent.close`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "open"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "open": {
      "const": false
    }
  }
}
```

### `agent.status`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "open",
    "activity",
    "workspace"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "open": {
      "type": "boolean"
    },
    "activity": {
      "$ref": "#/$defs/Activity"
    },
    "workspace": {
      "type": "string"
    },
    "lastJobs": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/JobRun"
      }
    }
  }
}
```

### `jobs.list`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "jobs"
  ],
  "properties": {
    "jobs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "name",
          "needsLlm",
          "singleton"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "needsLlm": {
            "type": "boolean"
          },
          "singleton": {
            "type": "boolean"
          },
          "phase": {
            "enum": [
              "light",
              "rem",
              "deep"
            ]
          }
        }
      }
    }
  }
}
```

### `jobs.run`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "job"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "job": {
      "type": "string"
    },
    "dryRun": {
      "type": "boolean"
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/JobRun"
}
```

### `jobs.history`

**Stability:** experimental · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "job": {
      "type": "string"
    },
    "since": {
      "type": "integer"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "runs"
  ],
  "properties": {
    "runs": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/JobRun"
      }
    }
  }
}
```

### `events.subscribe`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "names": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "subscriptionId"
  ],
  "properties": {
    "subscriptionId": {
      "type": "string"
    }
  }
}
```

### `events.unsubscribe`

**Stability:** stable · since 1.0.0

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "subscriptionId"
  ],
  "properties": {
    "subscriptionId": {
      "type": "string"
    }
  }
}
```

**result**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "removed"
  ],
  "properties": {
    "removed": {
      "type": "boolean"
    }
  }
}
```

## Notifications

Delivered on the same connection to clients that called `events.subscribe`.

### `core.state`

**Stability:** stable · since 1.0.0

```json
{
  "x-stability": "stable",
  "x-since": "1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "process"
  ],
  "properties": {
    "process": {
      "$ref": "#/$defs/ProcessState"
    }
  }
}
```

### `agent.activity`

**Stability:** experimental · since 1.0.0

```json
{
  "x-stability": "experimental",
  "x-since": "1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "activity"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "activity": {
      "$ref": "#/$defs/Activity"
    }
  }
}
```

### `engine.event`

**Stability:** experimental · since 1.0.0

Every engine event forwarded verbatim: name is the EngineEventName, payload as emitted, agentId when the payload carries one.

```json
{
  "x-stability": "experimental",
  "x-since": "1.0.0",
  "description": "Every engine event forwarded verbatim: name is the EngineEventName, payload as emitted, agentId when the payload carries one.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "payload"
  ],
  "properties": {
    "name": {
      "enum": [
        "dream.completed",
        "job.run",
        "acl.denied",
        "recall.degraded",
        "embedding.identity.changed",
        "recall.block-clipped",
        "recall.block-dropped",
        "recall.completed"
      ]
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "payload": {}
  }
}
```

## Definitions

Shared `$defs` referenced above as `#/$defs/<Name>`.

### `ErrorCode`

```json
{
  "type": "string",
  "enum": [
    "E_UNAUTHORIZED",
    "E_RPC_VERSION",
    "E_NOT_AVAILABLE",
    "E_CORE_UNAVAILABLE",
    "E_INVALID_PARAMS",
    "E_AGENT_UNKNOWN",
    "E_CONFIG_INVALID",
    "E_MODULE_UNKNOWN",
    "E_INTERNAL",
    "E_LOCKED"
  ]
}
```

### `ErrorObject`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code",
    "message"
  ],
  "properties": {
    "code": {
      "type": "integer",
      "description": "JSON-RPC numeric code: -32600 invalid request, -32601 method not found, -32602 invalid params, -32000 application error"
    },
    "message": {
      "type": "string"
    },
    "data": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "error"
      ],
      "properties": {
        "error": {
          "$ref": "#/$defs/ErrorCode"
        },
        "reason": {
          "type": "string"
        },
        "detail": {
          "type": "string"
        }
      }
    }
  }
}
```

### `Id`

```json
{
  "type": [
    "integer",
    "string"
  ]
}
```

### `Request`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "jsonrpc",
    "id",
    "method"
  ],
  "properties": {
    "jsonrpc": {
      "const": "2.0"
    },
    "id": {
      "$ref": "#/$defs/Id"
    },
    "method": {
      "type": "string"
    },
    "params": {
      "type": "object"
    }
  }
}
```

### `Response`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "jsonrpc",
    "id"
  ],
  "properties": {
    "jsonrpc": {
      "const": "2.0"
    },
    "id": {
      "$ref": "#/$defs/Id"
    },
    "result": {},
    "error": {
      "$ref": "#/$defs/ErrorObject"
    }
  }
}
```

### `Notification`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "jsonrpc",
    "method",
    "params"
  ],
  "properties": {
    "jsonrpc": {
      "const": "2.0"
    },
    "method": {
      "type": "string"
    },
    "params": {
      "type": "object"
    }
  }
}
```

### `AgentId`

```json
{
  "type": "string",
  "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$"
}
```

### `SessionKey`

```json
{
  "type": "string",
  "minLength": 1,
  "maxLength": 256
}
```

### `CallerIdentity`

```json
{
  "description": "What the CLI knows about the caller. The core turns it into an engine Principal; a client can never supply trust, origin or incognito.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "channel",
    "accountId",
    "userId"
  ],
  "properties": {
    "channel": {
      "type": "string",
      "enum": [
        "cli"
      ]
    },
    "accountId": {
      "type": "string",
      "minLength": 1
    },
    "userId": {
      "type": "string",
      "minLength": 1
    }
  }
}
```

### `Message`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "role",
    "content"
  ],
  "properties": {
    "role": {
      "enum": [
        "system",
        "user",
        "assistant",
        "tool"
      ]
    },
    "content": {
      "type": "string"
    }
  }
}
```

### `Degraded`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "reason",
    "capability"
  ],
  "properties": {
    "reason": {
      "type": "string"
    },
    "capability": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    }
  }
}
```

### `ContextBlock`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "text",
    "droppable",
    "chars"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "text": {
      "type": "string"
    },
    "droppable": {
      "type": "boolean"
    },
    "chars": {
      "type": "integer"
    },
    "tokensEstimate": {
      "type": "integer"
    }
  }
}
```

### `Deferral`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "block",
    "kind",
    "from",
    "to",
    "reason"
  ],
  "properties": {
    "block": {
      "type": "string"
    },
    "kind": {
      "enum": [
        "clipped",
        "dropped"
      ]
    },
    "from": {
      "type": "integer"
    },
    "to": {
      "type": "integer"
    },
    "reason": {
      "enum": [
        "global-cap",
        "memories-cap"
      ]
    }
  }
}
```

### `RecallTiming`

```json
{
  "type": "object",
  "additionalProperties": true,
  "required": [
    "totalMs"
  ],
  "properties": {
    "totalMs": {
      "type": "number"
    },
    "phases": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

### `Activity`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "state",
    "since"
  ],
  "properties": {
    "state": {
      "enum": [
        "idle",
        "recalling",
        "capturing",
        "checkpointing",
        "dreaming",
        "consolidating",
        "maintenance"
      ]
    },
    "since": {
      "type": "integer"
    },
    "phase": {
      "enum": [
        "light",
        "rem",
        "deep"
      ]
    },
    "job": {
      "type": "string"
    }
  }
}
```

### `ProcessState`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "state"
  ],
  "properties": {
    "state": {
      "enum": [
        "starting",
        "ready",
        "degraded",
        "orphaned",
        "stopping",
        "stopped",
        "crashed"
      ]
    },
    "reason": {
      "type": "string"
    },
    "since": {
      "type": "integer"
    }
  }
}
```

### `JobRun`

```json
{
  "type": "object",
  "additionalProperties": true,
  "required": [
    "runId",
    "job",
    "agentId",
    "trigger",
    "startedAt",
    "finishedAt",
    "durationMs",
    "outcome",
    "attempt"
  ],
  "properties": {
    "runId": {
      "type": "string"
    },
    "job": {
      "type": "string"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "trigger": {
      "enum": [
        "cron",
        "manual",
        "harness",
        "capture",
        "unknown"
      ]
    },
    "startedAt": {
      "type": "integer"
    },
    "finishedAt": {
      "type": "integer"
    },
    "durationMs": {
      "type": "integer"
    },
    "outcome": {
      "enum": [
        "completed",
        "skipped",
        "incomplete",
        "failed",
        "abandoned"
      ]
    },
    "reason": {
      "type": "string"
    },
    "attempt": {
      "type": "integer"
    }
  }
}
```

### `Stability`

```json
{
  "type": "string",
  "enum": [
    "experimental",
    "stable"
  ]
}
```

### `Deprecation`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "since",
    "removeAfter",
    "replacement"
  ],
  "properties": {
    "since": {
      "type": "string"
    },
    "removeAfter": {
      "type": "string",
      "format": "date"
    },
    "replacement": {
      "type": "string"
    }
  }
}
```

### `CapabilityEntry`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "stability",
    "since"
  ],
  "properties": {
    "stability": {
      "$ref": "#/$defs/Stability"
    },
    "since": {
      "type": "string"
    },
    "deprecated": {
      "$ref": "#/$defs/Deprecation"
    }
  }
}
```

### `Capabilities`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "methods",
    "notifications",
    "extensionPoints",
    "features"
  ],
  "properties": {
    "methods": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/CapabilityEntry"
      }
    },
    "notifications": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/CapabilityEntry"
      }
    },
    "extensionPoints": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/CapabilityEntry"
      }
    },
    "features": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "uniqueItems": true
    }
  }
}
```

### `JournalLine`

```json
{
  "description": "One line of state/journal/<agentId>.jsonl, written by the CLI when the core is unavailable, replayed by the core at start.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "v",
    "id",
    "at",
    "agentId",
    "caller",
    "messages"
  ],
  "properties": {
    "v": {
      "const": 1
    },
    "id": {
      "type": "string",
      "format": "uuid"
    },
    "at": {
      "type": "integer"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "sessionKey": {
      "$ref": "#/$defs/SessionKey"
    },
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "messages": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/Message"
      }
    }
  }
}
```

### `MemoryOpsParams`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "id": {
      "type": "string"
    },
    "text": {
      "type": "string"
    },
    "target": {
      "enum": [
        "workspace",
        "user"
      ]
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  }
}
```

### `MemoryOpsResult`

```json
{
  "type": "object",
  "description": "Shape fixed by engine PR E1 (MemoryOps). Until E1 every call answers E_NOT_AVAILABLE reason engine-pr-E1."
}
```
