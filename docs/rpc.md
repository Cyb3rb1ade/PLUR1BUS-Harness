# RPC reference (rpc 1.5.0)

Generated from `packages/rpc-schema/schema/rpc.schema.json` by `scripts/gen-docs.mjs` — do not edit by hand; run `pnpm docs:gen`.
JSON-RPC 2.0, one JSON value per line (NDJSON, max 4 MiB per line), on `run/core.sock` (POSIX) or the per-home named pipe
(Windows). The first call on a connection is `core.auth`; its result carries `contract` (engine contract version) and `rpc`
(this schema's version). Methods served by the supervisor (**Served by:** supervisor) are called on the supervisor's own
endpoint, whose first call is `supervisor.auth`. Methods served by a module (**Served by:** module) are called on that
module's own endpoint (`run/module-<name>.sock`, or the per-home `-module-<name>` pipe), whose first call is
`module.auth`. Design and rationale: `docs/adr/ADR-012-process-model-and-languages.md`.

JSON-RPC 2.0 over NDJSON. Methods are $defs/methods/<name>; notifications are $defs/notifications/<name>. x-server names the process that serves each one: core, supervisor or (methods only, since 1.3.0) module.

## Local endpoint trust

The trust boundary is the current OS user. On POSIX that rests on `run/` (a `0700` directory of the user) holding the sockets, tokens and pid files. Before a client reads a token or connects, it checks `run/`: it must be a real directory (not a symlink), owned by the current uid, and not writable by group or others; the socket must be a socket of the current uid. The Rust and Python clients additionally refuse a server whose peer uid (`SO_PEERCRED` on Linux; `getpeereid` in Rust and the equivalent `LOCAL_PEERCRED` in Python on macOS) is not the current uid, after connecting and before the token is sent; where the OS gives no answer the directory and socket checks are all there is. All three clients (Rust, TypeScript, Python) answer a refusal with `E_UNAUTHORIZED`, send nothing and read no token: reason `run-dir-untrusted` or `socket-untrusted` in all three, and `peer-uid-mismatch` in Rust and Python. **Limitation:** Node cannot ask the kernel for the peer uid of a unix socket, so the TypeScript client has the directory and socket checks only. The Python refusal also carries `data.legacy_code = "E_SERVER_IDENTITY"`, the code releases before this one raised for a bad `run/` (with the reasons `run-dir-owner`, `run-dir-writable-by-others`, `run-dir-not-a-directory`), so a host that classified the old code can still recognise it; `E_SERVER_IDENTITY` itself remains the code of the Python pid checks.

Setups that are refused for this reason:

- `sudo plur1bus …` against another user's home: the directory belongs to a different uid.
- A Docker bind mount of the home whose files belong to a different uid than the process in the container (for example a container running as root over a home owned by the host user).
- A home on WSL under `/mnt/c` (DrvFs), where every entry shows as world-writable.
- A group- or world-writable home or `run/` (for example a sloppy umask or a shared `PLUR1BUS_HOME`), and a `run/` that is a symlink.

On Windows, `run/` is protected by a DACL and the client compares the pipe server's process id with `run/core.pid` (or `run/supervisor.pid`) before it sends the token; a missing pid file is a refusal (`server-pid-unknown`), not a skipped check. The Rust and Python clients ask the OS (`GetNamedPipeServerProcessId`; the Python pid refusals stay `E_SERVER_IDENTITY`). **Limitation:** the TypeScript client (`@plur1bus/module-api`) has no native lookup, so it can only compare `hello.pid` with the recorded pid after `core.auth` was sent: a process that squats the pipe name receives the token and can claim any pid. A host that supplies a native lookup (`serverPidOf`) gets the refusal before the token is sent. Closing this for good needs the server to prove it holds the token (an HMAC over a client nonce) before the client sends it; that is not implemented.

## Error codes

A closed enum; the core puts the code into every error response as `error.data.error`, with optional `reason`, `detail` and `ids` (a map of non-secret ids a caller needs to recover, e.g. after a half-finished shared-copy refresh).

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
- `E_NOT_FOUND`
- `E_DENIED`
- `E_APPROVAL_REQUIRED`
- `E_CONFLICT`
- `E_STORAGE`

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

**Served by:** core

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

**Served by:** core

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
  "$ref": "#/$defs/CoreStatus"
}
```

### `core.shutdown`

**Stability:** stable · since 1.0.0

**Served by:** core

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

### `core.adopt`

**Stability:** experimental · since 1.2.0

**Served by:** core

Called by a supervisor on a running core to adopt it. nonce is the current content of run/supervisor.token; the connection it succeeds on becomes the core's lifeline.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "nonce"
  ],
  "properties": {
    "nonce": {
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
    "status"
  ],
  "properties": {
    "status": {
      "$ref": "#/$defs/CoreStatus"
    }
  }
}
```

### `memory.recall`

**Stability:** stable · since 1.0.0

**Served by:** core

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
          "minimum": 1,
          "description": "advisory: the engine applies its construction-time recall.* values; hardMs is enforced by the core"
        },
        "hardMs": {
          "type": "integer",
          "minimum": 1
        },
        "capChars": {
          "type": "integer",
          "minimum": 1,
          "description": "advisory: the engine applies its construction-time recall.* values; hardMs is enforced by the core"
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

**Served by:** core

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

**Served by:** core

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

**Served by:** core

**params**

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
    "topic": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "since": {
      "type": "integer",
      "minimum": 0
    },
    "until": {
      "type": "integer",
      "minimum": 0
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
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
    "items",
    "truncated"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryCard"
      }
    },
    "truncated": {
      "type": "boolean"
    },
    "degraded": {
      "$ref": "#/$defs/Degraded"
    }
  }
}
```

### `memory.show`

**Stability:** experimental · since 1.0.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "id"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "id": {
      "$ref": "#/$defs/MemoryId"
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
    "card"
  ],
  "properties": {
    "card": {
      "$ref": "#/$defs/MemoryCard"
    },
    "degraded": {
      "$ref": "#/$defs/Degraded"
    }
  }
}
```

### `memory.forget`

**Stability:** experimental · since 1.0.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "id"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "id": {
      "$ref": "#/$defs/MemoryId"
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
    "archived",
    "tombstoneId",
    "alreadyForgotten"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "archived": {
      "type": "boolean"
    },
    "tombstoneId": {
      "type": [
        "string",
        "null"
      ]
    },
    "alreadyForgotten": {
      "type": "boolean"
    }
  }
}
```

### `memory.correct`

**Stability:** experimental · since 1.0.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "id",
    "text"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "id": {
      "$ref": "#/$defs/MemoryId"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000
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
    "archived"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "archived": {
      "const": true
    }
  }
}
```

### `memory.share`

**Stability:** experimental · since 1.0.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "id",
    "target"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "id": {
      "$ref": "#/$defs/MemoryId"
    },
    "target": {
      "enum": [
        "workspace",
        "user"
      ]
    },
    "allowSensitive": {
      "type": "boolean"
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
    "sourceId",
    "sharedId",
    "target"
  ],
  "properties": {
    "sourceId": {
      "type": "string"
    },
    "sharedId": {
      "type": "string"
    },
    "target": {
      "enum": [
        "workspace",
        "user"
      ]
    }
  }
}
```

### `memory.state`

**Stability:** experimental · since 1.0.0

**Served by:** core

**params**

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
    "cards",
    "tombstones",
    "archiveDir"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "cards": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "agentPrivate",
        "workspace",
        "user"
      ],
      "properties": {
        "agentPrivate": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "workspace": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "user": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        }
      }
    },
    "tombstones": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    },
    "archiveDir": {
      "type": "string"
    },
    "degraded": {
      "$ref": "#/$defs/Degraded"
    }
  }
}
```

### `memory.propose`

**Stability:** experimental · since 1.1.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "sharedId",
    "text"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "sharedId": {
      "$ref": "#/$defs/MemoryId"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000
    },
    "note": {
      "type": "string",
      "maxLength": 500
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
    "proposalId",
    "sharedId",
    "sharerAgentId"
  ],
  "properties": {
    "proposalId": {
      "type": "string"
    },
    "sharedId": {
      "type": "string"
    },
    "sharerAgentId": {
      "type": "string"
    }
  }
}
```

### `memory.proposals.list`

**Stability:** experimental · since 1.1.0

**Served by:** core

**params**

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
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
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
    "items",
    "truncated",
    "unreadable"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/MemoryProposal"
      }
    },
    "truncated": {
      "type": "boolean"
    },
    "unreadable": {
      "type": "integer",
      "minimum": 0
    },
    "degraded": {
      "$ref": "#/$defs/Degraded"
    }
  }
}
```

### `memory.proposals.accept`

**Stability:** experimental · since 1.1.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "proposalId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "proposalId": {
      "$ref": "#/$defs/MemoryId"
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
    "proposalId",
    "id",
    "sourceId"
  ],
  "properties": {
    "proposalId": {
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "sourceId": {
      "type": "string"
    }
  }
}
```

### `memory.proposals.reject`

**Stability:** experimental · since 1.1.0

**Served by:** core

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "proposalId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "proposalId": {
      "$ref": "#/$defs/MemoryId"
    },
    "note": {
      "type": "string",
      "maxLength": 500
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
    "proposalId",
    "status"
  ],
  "properties": {
    "proposalId": {
      "type": "string"
    },
    "status": {
      "const": "rejected"
    }
  }
}
```

### `agent.list`

**Stability:** experimental · since 1.0.0

**Served by:** core

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

**Served by:** core

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

**Served by:** core

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

**Served by:** core

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

**Served by:** core

Lists scheduled jobs, optionally filtered by kind.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "kind": {
      "enum": [
        "agent",
        "system",
        "all"
      ],
      "description": "Filter jobs by kind. Defaults to 'agent'."
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
            "type": "string",
            "description": "The job name."
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
          },
          "kind": {
            "enum": [
              "agent",
              "system"
            ],
            "description": "Whether the job is an agent job or a system job."
          },
          "schedule": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "every",
              "jitter"
            ],
            "description": "Cadence information for scheduled runs.",
            "properties": {
              "every": {
                "type": "integer",
                "description": "Nominal interval between runs in milliseconds."
              },
              "jitter": {
                "type": "number",
                "description": "Fractional jitter applied to the interval."
              }
            }
          },
          "nextRunAt": {
            "type": [
              "integer",
              "null"
            ],
            "description": "Epoch timestamp in milliseconds of next scheduled run, or null if unscheduled."
          }
        }
      }
    }
  }
}
```

### `jobs.run`

**Stability:** experimental · since 1.0.0

**Served by:** core

Runs a job immediately. agentId is required for agent jobs and refused for system jobs.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "job"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "description": "Target agent for agent jobs; required for agent jobs and refused for system jobs."
    },
    "job": {
      "type": "string",
      "description": "The job name to run (e.g. consolidate or models.scan)."
    },
    "dryRun": {
      "type": "boolean",
      "description": "If true, simulates the job without side effects."
    },
    "args": {
      "type": "object",
      "description": "Optional job-specific arguments."
    }
  }
}
```

**result**

```json
{
  "oneOf": [
    {
      "$ref": "#/$defs/JobRun"
    },
    {
      "$ref": "#/$defs/SystemJobRun"
    }
  ]
}
```

### `jobs.history`

**Stability:** experimental · since 1.0.0

**Served by:** core

Returns past job execution records. When agentId is omitted, returns system job history; when provided, returns that agent's job history.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId",
      "description": "Target agent ID. Omit to query system jobs."
    },
    "job": {
      "type": "string",
      "description": "Filter by job name."
    },
    "since": {
      "type": "integer",
      "description": "Return runs finished at or after this millisecond epoch timestamp."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000,
      "description": "Maximum number of recent runs to return (newest first)."
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
        "oneOf": [
          {
            "$ref": "#/$defs/JobRun"
          },
          {
            "$ref": "#/$defs/SystemJobRun"
          }
        ]
      }
    }
  }
}
```

### `dreams.status`

**Stability:** experimental · since 1.5.0

**Served by:** core

Dreaming status per agent and phase (ADR-009 Observability): schedule, next and last run from the ledger, breaker, importance accumulator, the diary file, and the scheduler counters. agentId omitted = every registered agent.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
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
    "agents",
    "counters",
    "schemaVersion"
  ],
  "properties": {
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agentId",
          "phases",
          "diary"
        ],
        "properties": {
          "agentId": {
            "$ref": "#/$defs/AgentId"
          },
          "phases": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/DreamPhaseStatus"
            }
          },
          "diary": {
            "oneOf": [
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "path",
                  "exists",
                  "bytes"
                ],
                "properties": {
                  "path": {
                    "type": "string"
                  },
                  "exists": {
                    "type": "boolean"
                  },
                  "bytes": {
                    "type": "integer"
                  }
                }
              }
            ]
          }
        }
      }
    },
    "counters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "runs",
        "skips",
        "triggers",
        "breakerTrips",
        "reconciled"
      ],
      "properties": {
        "runs": {
          "type": "object",
          "additionalProperties": {
            "type": "integer"
          }
        },
        "skips": {
          "type": "object",
          "additionalProperties": {
            "type": "integer"
          }
        },
        "triggers": {
          "type": "object",
          "additionalProperties": {
            "type": "integer"
          }
        },
        "breakerTrips": {
          "type": "integer"
        },
        "reconciled": {
          "type": "integer"
        }
      }
    },
    "schemaVersion": {
      "type": "integer"
    }
  }
}
```

### `dreams.log`

**Stability:** experimental · since 1.5.0

**Served by:** core

Dream run ledger rows, newest first. With runId: that one row plus the text of its per-run log.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
    },
    "runId": {
      "type": "string"
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
        "$ref": "#/$defs/DreamRun"
      }
    },
    "log": {
      "type": "string"
    }
  }
}
```

### `dreams.run`

**Stability:** experimental · since 1.5.0

**Served by:** core

Runs a dreaming phase now, under every guard except the cron gate (a disabled phase still runs on demand). The result is the ledger row, skips included. dryRun evaluates the guards and answers a plan without a ledger row.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "phase"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
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
  "oneOf": [
    {
      "$ref": "#/$defs/DreamRun"
    },
    {
      "$ref": "#/$defs/DreamPlan"
    }
  ]
}
```

### `dreams.schedule.get`

**Stability:** experimental · since 1.5.0

**Served by:** core

The three phase schedules of an agent.

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
    "schedules"
  ],
  "properties": {
    "schedules": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/DreamSchedule"
      }
    }
  }
}
```

### `dreams.schedule.set`

**Stability:** experimental · since 1.5.0

**Served by:** core

Edits one phase schedule: cron (5 fields), IANA timezone, enabled. An invalid cron or timezone is E_INVALID_PARAMS and nothing is written.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "phase"
  ],
  "minProperties": 3,
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
    },
    "cron": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "timezone": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "enabled": {
      "type": "boolean"
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
    "schedule"
  ],
  "properties": {
    "schedule": {
      "$ref": "#/$defs/DreamSchedule"
    }
  }
}
```

### `dreams.enable`

**Stability:** experimental · since 1.5.0

**Served by:** core

Enables one phase schedule (its enable switch is never coupled to another setting).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "phase"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
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
    "schedule"
  ],
  "properties": {
    "schedule": {
      "$ref": "#/$defs/DreamSchedule"
    }
  }
}
```

### `dreams.disable`

**Stability:** experimental · since 1.5.0

**Served by:** core

Disables one phase schedule; cron and importance triggers stop, run-now still works.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "phase"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
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
    "schedule"
  ],
  "properties": {
    "schedule": {
      "$ref": "#/$defs/DreamSchedule"
    }
  }
}
```

### `admin.obsidian.detect`

**Stability:** experimental · since 1.3.0

**Served by:** core

Obsidian vaults the agent may use (engine AdminOps.obsidian.detect, read-only): the configured vaults, the agent workspace and the caller's candidates (a proved principal only). isVault: .obsidian/workspace.json or .obsidian/app.json exists; confirmed: a confirmation receipt for this agent, workspace and vault exists.

**params**

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
    "candidates": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      }
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
    "vaults"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "vaults": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "path",
          "isVault",
          "confirmed",
          "source"
        ],
        "properties": {
          "path": {
            "type": "string"
          },
          "isVault": {
            "type": "boolean"
          },
          "confirmed": {
            "type": "boolean"
          },
          "source": {
            "enum": [
              "config",
              "workspace",
              "candidate"
            ]
          }
        }
      }
    }
  }
}
```

### `admin.obsidian.prepare`

**Stability:** experimental · since 1.3.0

**Served by:** core

First half of the one-time vault confirmation (engine AdminOps.obsidian.prepare): a nonce bound to the caller, the agent and the vault's digest, valid for 10 minutes. Writes nothing to the vault; admin.obsidian.confirm consumes the nonce. Needs a valid caller identity (E_DENIED reason=principal-invalid).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "vaultPath"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "vaultPath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
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
    "nonce",
    "expiresAt",
    "vaultPath",
    "vaultDigest"
  ],
  "properties": {
    "nonce": {
      "type": "string"
    },
    "expiresAt": {
      "type": "number"
    },
    "vaultPath": {
      "type": "string"
    },
    "vaultDigest": {
      "type": "string"
    }
  }
}
```

### `admin.obsidian.confirm`

**Stability:** experimental · since 1.3.0

**Served by:** core

Second half of the vault confirmation (engine AdminOps.obsidian.confirm): consumes the nonce and records the receipt. alreadyConfirmed: a receipt existed before this call. An unknown or expired nonce is E_NOT_FOUND, a malformed one E_INVALID_PARAMS, another identity or a changed vault E_DENIED.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "agentId",
    "nonce"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "nonce": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
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
    "confirmed",
    "vaultPath",
    "vaultDigest",
    "alreadyConfirmed"
  ],
  "properties": {
    "confirmed": {
      "const": true
    },
    "vaultPath": {
      "type": "string"
    },
    "vaultDigest": {
      "type": "string"
    },
    "alreadyConfirmed": {
      "type": "boolean"
    }
  }
}
```

### `admin.migrate`

**Stability:** experimental · since 1.3.0

**Served by:** core

Store schema migration (engine AdminOps.migrate). from and to are decimal strings ("0" = a store written before any marker existed). E_CONFLICT when from is not the store's current version, E_INVALID_PARAMS for an unknown or downgrading to, E_STORAGE when the marker is unreadable. applied is false when from equals to. core.status engine.storeSchema follows a migration.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "from",
    "to"
  ],
  "properties": {
    "from": {
      "type": "string",
      "pattern": "^[0-9]{1,9}$"
    },
    "to": {
      "type": "string",
      "pattern": "^[0-9]{1,9}$"
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
    "from",
    "to",
    "applied"
  ],
  "properties": {
    "from": {
      "type": "string"
    },
    "to": {
      "type": "string"
    },
    "applied": {
      "type": "boolean"
    }
  }
}
```

### `admin.backup.snapshot`

**Stability:** experimental · since 1.5.0

**Served by:** core

Stages the consistent, engine-owned part of a backup (plur1bus backup create): the engine's store snapshot (lib/snapshot/store-snapshot.js: store, memory/_archive, run-state, merge proposals) and every SQLite database under state/ copied with the SQLite backup API, into a new private directory <home>/state/backup-staging/<id> (staging, always inside the home). The caller packs the files and removes the directory; the core never deletes it. files carries a SHA-256 per file, recomputed after the copy. E_STORAGE reason=source-busy when the store kept changing for three tries, reason=insufficient-disk when the copy would not fit, reason=store-outside-home when the configured store lives outside the home.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40,
      "description": "Free text folded into the snapshot id (ASCII, sanitised by the engine)."
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
    "dir",
    "storeTarget",
    "engine",
    "files"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^plur1bus-[A-Za-z0-9._-]+$"
    },
    "dir": {
      "type": "string",
      "description": "Absolute staging directory; entries are relative to it: store/**, memory/**, sqlite/**."
    },
    "storeTarget": {
      "type": "string",
      "description": "The store's path relative to the home, e.g. state/lancedb."
    },
    "engine": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "contract",
        "storeSchema"
      ],
      "properties": {
        "contract": {
          "type": "string"
        },
        "storeSchema": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "path",
          "bytes",
          "sha256"
        ],
        "properties": {
          "path": {
            "type": "string"
          },
          "bytes": {
            "type": "integer",
            "minimum": 0
          },
          "sha256": {
            "type": "string",
            "pattern": "^[0-9a-f]{64}$"
          }
        }
      }
    }
  }
}
```

### `admin.embedding.probe`

**Stability:** experimental · since 1.3.0

**Served by:** core

Exercises the embedding provider once (engine EmbeddingService.probe); a successful result is memoized (cached: true) unless refresh is true. A provider failure is ok: false with error, never an RPC error. Bounded by 30 s and by the core's stop (error aborted).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "refresh": {
      "type": "boolean"
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
    "ok",
    "cached",
    "identity",
    "durationMs",
    "checkedAt"
  ],
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "error": {
      "enum": [
        "aborted",
        "provider-failed",
        "invalid-vector",
        "dimension-mismatch"
      ]
    },
    "cached": {
      "type": "boolean"
    },
    "identity": {
      "$ref": "#/$defs/EmbeddingIdentity"
    },
    "durationMs": {
      "type": "number",
      "minimum": 0
    },
    "checkedAt": {
      "type": "number"
    }
  }
}
```

### `admin.embedding.serve`

**Stability:** experimental · since 1.3.0

**Served by:** core

Starts the engine's scoped-embedding IPC server (engine EmbeddingService.serve): address omitted = the engine's platform default, null = stop serving. Idempotent for the address already served. The token itself is never returned, only tokenPath. E_INVALID_PARAMS for a malformed address or a kind the platform does not use, E_CONFLICT when another address is served or the address is in use, E_STORAGE when the listener fails.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "address": {
      "oneOf": [
        {
          "$ref": "#/$defs/IpcAddress"
        },
        {
          "type": "null"
        }
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
    "address",
    "tokenPath",
    "identity"
  ],
  "properties": {
    "address": {
      "oneOf": [
        {
          "$ref": "#/$defs/IpcAddress"
        },
        {
          "type": "null"
        }
      ]
    },
    "tokenPath": {
      "type": [
        "string",
        "null"
      ]
    },
    "identity": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "model",
            "dimensions",
            "fingerprintId"
          ],
          "properties": {
            "model": {
              "type": "string"
            },
            "dimensions": {
              "type": "integer",
              "minimum": 1
            },
            "fingerprintId": {
              "type": "string"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

### `admin.reembed.plan`

**Stability:** experimental · since 1.5.0

**Served by:** core

M2 re-embedding migration, step 1 (per installation, not per agent). Builds the compatibility probe verdict for the active store against the target model (a pinned local-transformers model) and, when a migration is needed, the engine's plan: row, table, batch and provider-call counts, byte and free-disk estimates, the pause between batches. Nothing is copied. The confirmation token the engine issues stays in the core and is never returned. `plan` is null when the verdict is compatible or incompatible (with `reasons`). E_CONFLICT reason=migration-active while an earlier migration is unfinished; E_INVALID_PARAMS reason=plan-refused when the engine refuses the plan (e.g. not enough free disk).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "model"
  ],
  "properties": {
    "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "dimensions": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65536
    },
    "queryPrefix": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "passagePrefix": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "throttleMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 60000
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
    "probe",
    "plan"
  ],
  "properties": {
    "probe": {
      "$ref": "#/$defs/ReembedProbe"
    },
    "plan": {
      "oneOf": [
        {
          "$ref": "#/$defs/ReembedPlanSummary"
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

### `admin.reembed.run`

**Stability:** experimental · since 1.5.0

**Served by:** core

Starts (or continues, after an abort or a halt) the planned migration in the background and returns at once with the checkpoint; follow it with admin.reembed.status. Copies in throttled batches, validates, and (unless switch is false) switches: one config.set that makes the new generation active at the next core start; the old generation is kept. Recall is answered by the old generation until then. With phase ready-to-switch it performs only the switch. E_NOT_FOUND reason=no-migration, E_CONFLICT reason=migration-running|not-runnable, E_NOT_AVAILABLE reason=switch-unavailable.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "switch": {
      "type": "boolean"
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
    "checkpoint"
  ],
  "properties": {
    "checkpoint": {
      "$ref": "#/$defs/ReembedCheckpoint"
    }
  }
}
```

### `admin.reembed.status`

**Stability:** experimental · since 1.5.0

**Served by:** core

The migration's checkpoint (null when none), the engine's own state for it, whether a run is active in this core, and progress counters.

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
    "checkpoint",
    "engineState",
    "running",
    "progress"
  ],
  "properties": {
    "checkpoint": {
      "oneOf": [
        {
          "$ref": "#/$defs/ReembedCheckpoint"
        },
        {
          "type": "null"
        }
      ]
    },
    "engineState": {
      "type": [
        "string",
        "null"
      ]
    },
    "running": {
      "type": "boolean"
    },
    "progress": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "rows",
        "rowsDone",
        "batches",
        "batchesDone",
        "percent"
      ],
      "properties": {
        "rows": {
          "type": "integer",
          "minimum": 0
        },
        "rowsDone": {
          "type": "integer",
          "minimum": 0
        },
        "batches": {
          "type": "integer",
          "minimum": 0
        },
        "batchesDone": {
          "type": "integer",
          "minimum": 0
        },
        "percent": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      }
    }
  }
}
```

### `admin.reembed.abort`

**Stability:** experimental · since 1.5.0

**Served by:** core

Stops the migration at the next batch boundary (never mid-batch) and answers with the checkpoint, phase aborted. The copied generation stays and admin.reembed.run continues it. E_NOT_FOUND reason=no-migration, E_CONFLICT reason=not-abortable once it is switched or failed.

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
    "checkpoint"
  ],
  "properties": {
    "checkpoint": {
      "$ref": "#/$defs/ReembedCheckpoint"
    }
  }
}
```

### `events.subscribe`

**Stability:** stable · since 1.0.0

**Served by:** core

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

**Served by:** core

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

### `supervisor.auth`

**Stability:** experimental · since 1.2.0

**Served by:** supervisor

The first call on a supervisor connection; token is the content of run/supervisor.token.

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
    "rpc",
    "instanceId",
    "pid"
  ],
  "properties": {
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

### `daemon.status`

**Stability:** experimental · since 1.2.0

**Served by:** supervisor

The supervisor's own state and one entry per supervised child.

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
    "supervisor",
    "children"
  ],
  "properties": {
    "supervisor": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "process",
        "instanceId",
        "pid",
        "uptimeMs"
      ],
      "properties": {
        "process": {
          "$ref": "#/$defs/ProcessState"
        },
        "instanceId": {
          "type": "string"
        },
        "pid": {
          "type": "integer"
        },
        "uptimeMs": {
          "type": "integer"
        }
      }
    },
    "children": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ChildStatus"
      }
    },
    "config": {
      "description": "Experimental (1.3.0). The configuration the supervisor runs (B4): `revision` of the running configuration (null when no valid configuration runs, e.g. config.json was invalid at start) and the last hand edit of config.json it rejected (null once a valid file or a config.set replaced it).",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "revision",
        "rejected"
      ],
      "properties": {
        "revision": {
          "type": [
            "string",
            "null"
          ]
        },
        "rejected": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "at",
                "errors"
              ],
              "properties": {
                "at": {
                  "type": "integer",
                  "description": "Wall time (ms) of the rejection."
                },
                "errors": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              }
            },
            {
              "type": "null"
            }
          ]
        }
      }
    }
  }
}
```

### `daemon.start`

**Stability:** experimental · since 1.2.0

**Served by:** supervisor

Clears a crashed or stopped child's backoff and spawns it.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role": {
      "enum": [
        "core"
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
    "accepted",
    "role"
  ],
  "properties": {
    "accepted": {
      "const": true
    },
    "role": {
      "enum": [
        "core"
      ]
    }
  }
}
```

### `daemon.stop`

**Stability:** experimental · since 1.2.0

**Served by:** supervisor

Replies first, then shuts every child down within budgetMs, removes the supervisor's run files and exits the supervisor.

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

### `config.get`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

The running configuration (spec §6.1, B5): the whole value, one key (dotted path) or one tier (key and tier are exclusive). `restartClass` is `live`, `core` or `module:<name>` for a key, else null; `restart` is the same class without the module name (the CLI's `config.get/1` field). `revision` identifies the running configuration (config.set's ifRevision). E_NOT_AVAILABLE reason=config-unavailable when no valid configuration runs.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "not": {
    "properties": {
      "key": {},
      "tier": {}
    },
    "required": [
      "key",
      "tier"
    ]
  },
  "properties": {
    "key": {
      "type": "string",
      "minLength": 1
    },
    "tier": {
      "enum": [
        "basic",
        "advanced"
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
    "key",
    "tier",
    "value",
    "restartClass",
    "restart",
    "revision"
  ],
  "properties": {
    "key": {
      "type": [
        "string",
        "null"
      ]
    },
    "tier": {
      "oneOf": [
        {
          "enum": [
            "basic",
            "advanced"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "value": {},
    "restartClass": {
      "type": [
        "string",
        "null"
      ]
    },
    "restart": {
      "oneOf": [
        {
          "enum": [
            "live",
            "core",
            "module"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "revision": {
      "type": "string"
    }
  }
}
```

### `config.set`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Validates and applies all changes or none, writes config.json atomically and notifies config.watch subscribers (config.changed, source=set). dryRun only computes the plan. ifRevision refuses a configuration that changed since (E_CONFLICT reason=config-changed, ids.currentRevision). E_CONFIG_INVALID (detail: the joined errors) for a value the schema refuses; E_NOT_AVAILABLE reason=config-unavailable when no valid configuration runs. `restart` is the plan; `restarted` names the units restarted for it.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "changes"
  ],
  "properties": {
    "changes": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "value"
        ],
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          },
          "value": {}
        }
      }
    },
    "dryRun": {
      "type": "boolean"
    },
    "ifRevision": {
      "type": "string",
      "minLength": 1
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
    "applied",
    "dryRun",
    "changed",
    "restart",
    "revision",
    "restarted",
    "durationMs"
  ],
  "properties": {
    "applied": {
      "type": "boolean"
    },
    "dryRun": {
      "type": "boolean"
    },
    "changed": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "restart": {
      "$ref": "#/$defs/RestartPlan"
    },
    "revision": {
      "type": "string",
      "description": "After an apply the new revision; on a dry run the current one."
    },
    "restarted": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "durationMs": {
      "type": "integer",
      "minimum": 0
    },
    "estimates": {
      "type": "object",
      "additionalProperties": {
        "type": [
          "integer",
          "null"
        ]
      },
      "description": "Estimated restart time (ms) per unit, null when unknown."
    }
  }
}
```

### `config.watch`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Returns the running configuration and subscribes this connection to config.changed (B3). E_NOT_AVAILABLE reason=config-unavailable when no valid configuration runs.

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
    "subscriptionId",
    "config",
    "revision"
  ],
  "properties": {
    "subscriptionId": {
      "type": "string"
    },
    "config": {
      "type": "object"
    },
    "revision": {
      "type": "string"
    }
  }
}
```

### `module.watch`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Returns every module child's current state and subscribes this connection to module.state (B3).

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
    "subscriptionId",
    "modules"
  ],
  "properties": {
    "subscriptionId": {
      "type": "string"
    },
    "modules": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModuleState"
      }
    }
  }
}
```

### `module.list`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Every installed module (modules/<name>/module.json) in directory order, with its supervised child (B14).

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
    "modules"
  ],
  "properties": {
    "modules": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModuleListEntry"
      }
    }
  }
}
```

### `module.start`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Clears the module's backoff and starts it (a no-op while it runs); ends a module.stop. E_MODULE_UNKNOWN when no module of that name is installed; E_NOT_AVAILABLE with reason manifest-invalid, api-version-unsupported, scope-agent-unsupported, disabled, needs-unavailable, ext-revoked, ext-tampered or ext-incompatible when it cannot run (the last three: a module installed from a .p1x package is revoked, its installed files changed, or its compat no longer holds).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
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
    "accepted",
    "name"
  ],
  "properties": {
    "accepted": {
      "const": true
    },
    "name": {
      "type": "string"
    }
  }
}
```

### `module.stop`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Stops the module within budgetMs (default 10000); it stays stopped (reason stopped-by-request) until module.start or a supervisor restart. The persistent switch is modules.<name>.enabled (B13). E_MODULE_UNKNOWN when no module of that name is installed; E_NOT_AVAILABLE with reason manifest-invalid, api-version-unsupported, scope-agent-unsupported, disabled or needs-unavailable when it cannot run.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
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
    "accepted",
    "name"
  ],
  "properties": {
    "accepted": {
      "const": true
    },
    "name": {
      "type": "string"
    }
  }
}
```

### `module.restart`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Stops the module within budgetMs (default 10000) and starts it again (a requested restart: it never counts toward the give-up budget). E_MODULE_UNKNOWN when no module of that name is installed; E_NOT_AVAILABLE with reason manifest-invalid, api-version-unsupported, scope-agent-unsupported, disabled, needs-unavailable, ext-revoked, ext-tampered or ext-incompatible when it cannot run (the last three: a module installed from a .p1x package is revoked, its installed files changed, or its compat no longer holds).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
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
    "accepted",
    "name"
  ],
  "properties": {
    "accepted": {
      "const": true
    },
    "name": {
      "type": "string"
    }
  }
}
```

### `module.graph`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

The module dependency graph (spec §6.6).

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
  "$ref": "#/$defs/ModuleGraph"
}
```

### `module.install`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Installs the module directory at path (B14): copied into modules/<name>.tmp-<pid>, then renamed to modules/<name>. Refused (E_INVALID_PARAMS, nothing copied) with reason not-a-directory, manifest-invalid, symlink, entry-outside or reserved-name. A running module of that name is stopped and started again; a new module starts unless modules.<name>.enabled is false. replaced: a module of that name was installed before.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path"
  ],
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1
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
    "name",
    "version",
    "replaced"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "version": {
      "type": "string"
    },
    "replaced": {
      "type": "boolean"
    }
  }
}
```

### `module.uninstall`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

Stops the module and removes modules/<name>; modules.<name> stays in config.json (B14). E_MODULE_UNKNOWN when no module of that name is installed.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
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
    "name",
    "removed"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "removed": {
      "const": true
    }
  }
}
```

### `module.auth`

**Stability:** experimental · since 1.3.0

**Served by:** module

The first call on a module connection; token is the content of run/module-<name>.token.

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
    "rpc",
    "instanceId",
    "pid",
    "module"
  ],
  "properties": {
    "rpc": {
      "type": "string"
    },
    "instanceId": {
      "type": "string"
    },
    "pid": {
      "type": "integer"
    },
    "module": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name",
        "version",
        "apiVersion"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "apiVersion": {
          "type": "string"
        }
      }
    },
    "capabilities": {
      "$ref": "#/$defs/Capabilities"
    }
  }
}
```

### `module.status`

**Stability:** experimental · since 1.3.0

**Served by:** module

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
  "$ref": "#/$defs/ModuleStatus"
}
```

### `module.adopt`

**Stability:** experimental · since 1.3.0

**Served by:** module

Called by a supervisor on a running module to adopt it. nonce is the current content of run/supervisor.token; the connection it succeeds on becomes the module's lifeline. E_UNAUTHORIZED reason=adopt-nonce otherwise.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "nonce"
  ],
  "properties": {
    "nonce": {
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
    "status"
  ],
  "properties": {
    "status": {
      "$ref": "#/$defs/ModuleStatus"
    }
  }
}
```

### `module.shutdown`

**Stability:** experimental · since 1.3.0

**Served by:** module

Asks the module to stop within budgetMs; the process removes its run files and exits 0.

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

### `ext.list`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Lists installed extensions (skills, modules, channels), optionally filtered by kind, plain state and the agent that has them. E_STORAGE reason=state-invalid when extensions/state.json cannot be read; an unreadable skills/index.json lists every skill as not enabled.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "kind": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtKind"
      }
    },
    "state": {
      "type": "array",
      "items": {
        "enum": [
          "installed",
          "enabled"
        ]
      }
    },
    "agent": {
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
    "items"
  ],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtItem"
      }
    }
  }
}
```

### `ext.show`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

One extension in detail. E_NOT_FOUND reason=extension-unknown when nothing of that name is installed. E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/ExtDetail"
}
```

### `ext.inspect`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Audits a package file (.p1x, or a skill folder, .zip or .skill normalised to an unsigned package) in a worker process and keeps it for ten minutes; writes nothing under skills/, modules/ or extensions/. E_INVALID_PARAMS reason=package-invalid|signature-invalid|scripts-mismatch|archive-unsafe-entry|archive-unsupported|download-too-large|digest-mismatch|reserved-name|socket-path-too-long; E_CONFLICT reason=name-taken; E_NOT_AVAILABLE reason=incompatible|kind-unsupported; E_DENIED reason=policy-unsigned-disallowed|revoked; E_INTERNAL reason=worker-failed (the worker crashed or overran its 60 s; what it left is removed)|io; E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read). What a refusal must show is in error.data.ext.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "source"
  ],
  "properties": {
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/ExtInspection"
}
```

### `ext.install`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Installs an inspected package, disabled unless enable is given (which needs acknowledge capabilities). Installing the identical package again is a no-op with replaced false. E_NOT_FOUND reason=inspection-expired; E_APPROVAL_REQUIRED reason=acknowledge-unsigned|acknowledge-unknown-signer|acknowledge-downgrade|acknowledge-capabilities; E_CONFLICT reason=busy|name-taken; E_DENIED reason=revoked|policy-unsigned-disallowed; E_INVALID_PARAMS reason=digest-mismatch|package-invalid|agents-not-supported; E_NOT_AVAILABLE reason=kind-unsupported; E_INTERNAL reason=worker-failed (the staging worker crashed or overran its 300 s; its staging and the inspection are removed, inspect again)|io; E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read); E_LOCKED reason=skills-locked (another writer holds the skills index). What a refusal must show is in error.data.ext.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "inspectionId"
  ],
  "properties": {
    "inspectionId": {
      "type": "string",
      "minLength": 1
    },
    "acknowledge": {
      "type": "array",
      "items": {
        "enum": [
          "unsigned",
          "unknown-signer",
          "downgrade",
          "capabilities"
        ]
      }
    },
    "enable": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "agents"
      ],
      "properties": {
        "agents": {
          "$ref": "#/$defs/ExtAgents"
        }
      }
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
    "name",
    "version",
    "kind",
    "replaced",
    "state"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "version": {
      "type": "string"
    },
    "kind": {
      "$ref": "#/$defs/ExtKind"
    },
    "replaced": {
      "type": "boolean"
    },
    "state": {
      "enum": [
        "installed",
        "enabled"
      ]
    }
  }
}
```

### `ext.uninstall`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Moves an extension into the trash (kept extensions.trashDays days); purge also moves its data. E_NOT_FOUND reason=extension-unknown; E_CONFLICT reason=required-by|busy; E_DENIED reason=bundled (purge of a bundled item). E_LOCKED reason=skills-locked (another writer holds the skills index); E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read); E_INTERNAL reason=io (a file could not be written; the change was rolled back). trashId is null when nothing went into the trash: a bundled skill is hidden, not moved. What a refusal must show is in error.data.ext.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "purge": {
      "type": "boolean"
    },
    "cascade": {
      "type": "boolean"
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
    "name",
    "removed",
    "trashId",
    "purged"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "removed": {
      "const": true
    },
    "trashId": {
      "type": [
        "string",
        "null"
      ],
      "description": "The trash entry to restore from; null for a bundled skill, which is hidden, not moved."
    },
    "purged": {
      "type": "boolean"
    }
  }
}
```

### `ext.restore`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Restores an extension from the trash. E_NOT_FOUND reason=trash-expired; E_CONFLICT reason=name-taken|busy. E_LOCKED reason=skills-locked (another writer holds the skills index); E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read); E_INTERNAL reason=io (a file could not be written; the change was rolled back).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "trashId"
  ],
  "properties": {
    "trashId": {
      "type": "string",
      "minLength": 1
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
    "name",
    "version",
    "state"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "version": {
      "type": "string"
    },
    "state": {
      "enum": [
        "installed",
        "enabled"
      ]
    }
  }
}
```

### `ext.enable`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Enables an extension, for the given agents (skills only) or everywhere; dryRun runs every refusal and reports restart and heldBack without writing. E_NOT_FOUND reason=extension-unknown; E_AGENT_UNKNOWN; E_APPROVAL_REQUIRED reason=acknowledge-capabilities; E_NOT_AVAILABLE reason=needs-setup|incompatible|tampered; E_DENIED reason=revoked; E_INVALID_PARAMS reason=agents-not-supported (modules and channels); E_CONFLICT reason=busy. E_LOCKED reason=skills-locked (another writer holds the skills index); E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read); E_INTERNAL reason=io (a file could not be written; the change was rolled back). What a refusal must show is in error.data.ext.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "agents": {
      "$ref": "#/$defs/ExtAgents"
    },
    "acknowledge": {
      "type": "array",
      "items": {
        "enum": [
          "capabilities"
        ]
      }
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
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "state",
    "restart",
    "heldBack"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "state": {
      "enum": [
        "installed",
        "enabled"
      ]
    },
    "restart": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "modules"
      ],
      "properties": {
        "modules": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "heldBack": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

### `ext.disable`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Disables an extension, for the given agents (skills only) or everywhere; dryRun runs every refusal and reports restart and heldBack without writing. Disabling a module holds back the enabled modules that need it (listed in heldBack); it is never refused for them. E_NOT_FOUND reason=extension-unknown; E_AGENT_UNKNOWN; E_CONFLICT reason=busy; E_INVALID_PARAMS reason=agents-not-supported (modules and channels). E_LOCKED reason=skills-locked (another writer holds the skills index); E_STORAGE reason=state-invalid|index-invalid|index-newer (extensions/state.json or skills/index.json cannot be read); E_INTERNAL reason=io (a file could not be written; the change was rolled back).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "agents": {
      "$ref": "#/$defs/ExtAgents"
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
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "state",
    "restart",
    "heldBack"
  ],
  "properties": {
    "name": {
      "type": "string"
    },
    "state": {
      "enum": [
        "installed",
        "enabled"
      ]
    },
    "restart": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "modules"
      ],
      "properties": {
        "modules": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "heldBack": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

### `ext.watch`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

Returns every installed extension and subscribes this connection to ext.changed. E_STORAGE reason=state-invalid (extensions/state.json cannot be read; nothing is subscribed).

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
    "subscriptionId",
    "items"
  ],
  "properties": {
    "subscriptionId": {
      "type": "string"
    },
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtItem"
      }
    }
  }
}
```

### `models.list`

**Stability:** experimental · since 1.5.0

**Served by:** core

Lists models in the catalog, provider scan states, new model count, and warnings (D112).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "provider": {
      "type": "string"
    },
    "kind": {
      "$ref": "#/$defs/ModelKind"
    },
    "status": {
      "$ref": "#/$defs/CatalogModelStatus"
    },
    "newOnly": {
      "type": "boolean"
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
    "models",
    "providers",
    "newCount",
    "warnings"
  ],
  "properties": {
    "models": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelEntry"
      }
    },
    "providers": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelProviderState"
      }
    },
    "newCount": {
      "type": "integer",
      "minimum": 0
    },
    "warnings": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelScanWarning"
      }
    }
  }
}
```

### `models.scan`

**Stability:** experimental · since 1.5.0

**Served by:** core

Scans configured providers for available models, updating the catalog (D112).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "provider": {
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
    "startedAt",
    "finishedAt",
    "providers"
  ],
  "properties": {
    "startedAt": {
      "type": "string"
    },
    "finishedAt": {
      "type": "string"
    },
    "providers": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelScanProviderResult"
      }
    }
  }
}
```

### `models.setOverride`

**Stability:** experimental · since 1.5.0

**Served by:** core

Sets or clears metadata overrides for a model, or creates a manual model entry (D112).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "id"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "set": {
      "$ref": "#/$defs/ModelOverrides"
    },
    "clear": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "displayName",
              "kind",
              "contextWindow",
              "capabilities",
              "aliases"
            ]
          }
        },
        {
          "type": "string",
          "enum": [
            "all"
          ]
        }
      ]
    },
    "create": {
      "type": "boolean"
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/ModelEntry"
}
```

### `models.removeManual`

**Stability:** experimental · since 1.5.0

**Served by:** core

Removes a manual model entry from the catalog (D112).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "id"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "id": {
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

### `models.acknowledge`

**Stability:** experimental · since 1.5.0

**Served by:** core

Acknowledges newly discovered models, clearing the new-models indicator (D112).

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
    "acknowledgedAt"
  ],
  "properties": {
    "acknowledgedAt": {
      "type": "string"
    }
  }
}
```

### `budget.status`

**Stability:** experimental · since 1.5.0

**Served by:** core

Usage per period (the current local day and month in the configured time zone) and per agent and model, plus every budget limit with its use and state (M2 L8, ADR-010 §4). Counts and ids only; never prompt content.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "agentId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "description": "Only this agent's usage, and the global limits plus this agent's own"
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
    "timeZone",
    "priceVersion",
    "now",
    "periods",
    "limits"
  ],
  "properties": {
    "timeZone": {
      "type": "string"
    },
    "priceVersion": {
      "type": "string",
      "description": "The price table in force now"
    },
    "now": {
      "type": "string",
      "description": "RFC 3339"
    },
    "periods": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "period",
          "key",
          "start",
          "end",
          "total",
          "agents"
        ],
        "properties": {
          "period": {
            "enum": [
              "day",
              "month"
            ]
          },
          "key": {
            "type": "string",
            "description": "YYYY-MM-DD or YYYY-MM, local"
          },
          "start": {
            "type": "string"
          },
          "end": {
            "type": "string"
          },
          "total": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "events",
              "inputTokens",
              "outputTokens",
              "cacheReadTokens",
              "cacheWriteTokens",
              "costMicros",
              "unpricedEvents"
            ],
            "properties": {
              "events": {
                "type": "integer",
                "minimum": 0
              },
              "inputTokens": {
                "type": "integer",
                "minimum": 0
              },
              "outputTokens": {
                "type": "integer",
                "minimum": 0
              },
              "cacheReadTokens": {
                "type": "integer",
                "minimum": 0
              },
              "cacheWriteTokens": {
                "type": "integer",
                "minimum": 0
              },
              "costMicros": {
                "type": "integer",
                "minimum": 0,
                "description": "Micro-USD, summed over priced events only"
              },
              "unpricedEvents": {
                "type": "integer",
                "minimum": 0,
                "description": "Events whose model had no price in the table in force; their tokens count, their cost does not"
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
                "total",
                "models"
              ],
              "properties": {
                "agentId": {
                  "type": "string"
                },
                "total": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "events",
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                    "costMicros",
                    "unpricedEvents"
                  ],
                  "properties": {
                    "events": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "inputTokens": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "outputTokens": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "cacheReadTokens": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "cacheWriteTokens": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "costMicros": {
                      "type": "integer",
                      "minimum": 0,
                      "description": "Micro-USD, summed over priced events only"
                    },
                    "unpricedEvents": {
                      "type": "integer",
                      "minimum": 0,
                      "description": "Events whose model had no price in the table in force; their tokens count, their cost does not"
                    }
                  }
                },
                "models": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "model",
                      "events",
                      "inputTokens",
                      "outputTokens",
                      "cacheReadTokens",
                      "cacheWriteTokens",
                      "costMicros",
                      "unpricedEvents"
                    ],
                    "properties": {
                      "model": {
                        "type": "string"
                      },
                      "events": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "inputTokens": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "outputTokens": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "cacheReadTokens": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "cacheWriteTokens": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "costMicros": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "unpricedEvents": {
                        "type": "integer",
                        "minimum": 0
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "limits": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/BudgetLimitState"
      }
    }
  }
}
```

### `egress.status`

**Stability:** experimental · since 1.5.0

**Served by:** core

The outgoing-network policy in force (B4): normalised host allowlist, ports, loopback switch, configuration errors (a configuration with errors is deny-all) and counters of per-hop decisions by refusal reason. Read-only; never URLs or addresses.

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
    "policy",
    "decisions",
    "since"
  ],
  "properties": {
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "allowHosts",
        "allowPorts",
        "allowLoopback",
        "valid",
        "errors"
      ],
      "properties": {
        "allowHosts": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "allowPorts": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 1,
            "maximum": 65535
          }
        },
        "allowLoopback": {
          "type": "boolean"
        },
        "valid": {
          "type": "boolean"
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "decisions": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "allowed",
        "denied",
        "byReason"
      ],
      "properties": {
        "allowed": {
          "type": "integer",
          "minimum": 0
        },
        "denied": {
          "type": "integer",
          "minimum": 0
        },
        "byReason": {
          "type": "object",
          "additionalProperties": {
            "type": "integer",
            "minimum": 0
          }
        }
      }
    },
    "since": {
      "type": "string",
      "description": "RFC 3339: when the counters started (core start)"
    }
  }
}
```

### `budget.set`

**Stability:** experimental · since 1.5.0

**Served by:** core

Sets, changes or clears a budget limit and/or the time zone budget periods follow (M2 L8). A bound left out stays as it is; null clears it; a limit with no bound left is removed. Cost bounds are micro-USD, token bounds are input + output tokens.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "minProperties": 1,
  "properties": {
    "limit": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "scope",
        "period",
        "metric"
      ],
      "properties": {
        "scope": {
          "enum": [
            "global",
            "agent"
          ]
        },
        "agentId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "description": "Required for scope agent, refused for global"
        },
        "period": {
          "enum": [
            "day",
            "month"
          ]
        },
        "metric": {
          "enum": [
            "cost",
            "tokens"
          ]
        },
        "soft": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "hard": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        }
      }
    },
    "timeZone": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64,
      "description": "An IANA zone name"
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
    "timeZone",
    "limits"
  ],
  "properties": {
    "timeZone": {
      "type": "string"
    },
    "limit": {
      "oneOf": [
        {
          "$ref": "#/$defs/BudgetLimit"
        },
        {
          "type": "null"
        }
      ],
      "description": "The limit as stored after the change; null when it was removed. Absent when only the time zone changed."
    },
    "limits": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/BudgetLimit"
      }
    }
  }
}
```

### `secret.status`

**Stability:** experimental · since 1.5.0

**Served by:** core

Which secret backend is in use (OS keyring first, then the opt-in encrypted file), why, and how many secrets it holds. Owner only (M2, ADR-005).

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
  "$ref": "#/$defs/SecretStatus"
}
```

### `secret.list`

**Stability:** experimental · since 1.5.0

**Served by:** core

Secret names and metadata, never values. Owner only (M2, ADR-005).

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
    "secrets"
  ],
  "properties": {
    "secrets": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/SecretMeta"
      }
    }
  }
}
```

### `secret.set`

**Stability:** experimental · since 1.5.0

**Served by:** core

Creates or replaces a secret; leases on the old value are revoked. The value is write-only: the result carries metadata only. Owner only; every call is audited (M2, ADR-005).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "value"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$"
    },
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/SecretMeta"
}
```

### `secret.get`

**Stability:** experimental · since 1.5.0

**Served by:** core

A secret's metadata; with `reveal: true` also its value, the only RPC that returns one. Owner only; the call is audited before the value is released (M2, ADR-005).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$"
    },
    "reveal": {
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
    "secret"
  ],
  "properties": {
    "secret": {
      "$ref": "#/$defs/SecretMeta"
    },
    "value": {
      "type": "string"
    }
  }
}
```

### `secret.delete`

**Stability:** experimental · since 1.5.0

**Served by:** core

Deletes a secret from every available backend and revokes its leases. Owner only; audited (M2, ADR-005).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$"
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
      "const": true
    }
  }
}
```

### `identity.list`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). Lists humans with their active linked channel identities (revoked ones with includeRevoked) and the pairings that still wait. Owner only: the CLI caller. Never contains a pairing code.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "includeRevoked": {
      "type": "boolean"
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
    "humans",
    "pairings"
  ],
  "properties": {
    "humans": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/IdentityHumanEntry"
      }
    },
    "pairings": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/IdentityPairing"
      }
    }
  }
}
```

### `identity.human.create`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). Creates a human principal (an opaque UUIDv7 id). Owner only. Audited.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "displayName"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/IdentityHuman"
}
```

### `identity.link`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). The owner links a channel identity to a human by hand (proof owner_manual); never inferred. E_CONFLICT when the identity is already linked (N:1: an identity belongs to at most one human). Owner only. Audited.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "humanId",
    "identity"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "humanId": {
      "type": "string",
      "minLength": 1
    },
    "identity": {
      "$ref": "#/$defs/IdentityHandle"
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/IdentityLink"
}
```

### `identity.pair.start`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). Mints a one-time pairing code for a human on a channel: 8 characters, valid 10 minutes, single use, at most 3 pending per human and channel. The code is in this result only, once; it is stored as a salted hash and never logged. Owner only. Audited.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "humanId",
    "channel"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "humanId": {
      "type": "string",
      "minLength": 1
    },
    "channel": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9._-]{0,31}$"
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
    "pairingId",
    "code",
    "channel",
    "expiresAt"
  ],
  "properties": {
    "pairingId": {
      "type": "string"
    },
    "code": {
      "type": "string"
    },
    "channel": {
      "type": "string"
    },
    "expiresAt": {
      "type": "integer"
    }
  }
}
```

### `identity.pair.claim`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). A channel adapter relays a code a person sent from a channel identity. A match consumes the code and parks the claim for the owner (links nothing). A wrong, expired, reused or wrong-channel code is E_DENIED reason invalid-code; failures are rate limited per identity and overall (E_DENIED reason rate-limited, detail retryAfterMs=N). E_CONFLICT when the identity is already linked.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "code",
    "identity"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "identity": {
      "$ref": "#/$defs/IdentityHandle"
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
    "pairingId",
    "state",
    "confirmBy"
  ],
  "properties": {
    "pairingId": {
      "type": "string"
    },
    "state": {
      "const": "awaiting-confirmation"
    },
    "confirmBy": {
      "type": "integer"
    }
  }
}
```

### `identity.pair.confirm`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). The owner approves or declines a claimed pairing. Approving links the identity (proof pairing_code). Owner only. Audited. E_DENIED reason expired when the claim was not confirmed in time; E_CONFLICT when the pairing is not waiting or the identity was linked meanwhile.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "pairingId",
    "approve"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "pairingId": {
      "type": "string",
      "minLength": 1
    },
    "approve": {
      "type": "boolean"
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
    "pairingId",
    "state"
  ],
  "properties": {
    "pairingId": {
      "type": "string"
    },
    "state": {
      "$ref": "#/$defs/IdentityPairingState"
    },
    "link": {
      "$ref": "#/$defs/IdentityLink"
    }
  }
}
```

### `identity.unlink`

**Stability:** experimental · since 1.5.0

**Served by:** core

Experimental (1.5.0, M3). Revokes a link at once: the identity stops resolving to the human and leaves the union of linked principals. The record stays for the audit trail. Rows written under its v1 principal become unreadable to the human until it is linked again (ADR-007). Owner only. Audited.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "linkId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "linkId": {
      "type": "string",
      "minLength": 1
    }
  }
}
```

**result**

```json
{
  "$ref": "#/$defs/IdentityLink"
}
```

### `session.create`

**Stability:** experimental · since 1.5.0

**Served by:** core

Opens a session for the caller (the owner is derived from the caller identity). Only direct and channel sessions are created here; card/project/acp sessions belong to their modules. A channel session needs chatKey and, per D21, at most one is active per chat: a second create is E_CONFLICT unless replaceActive archives the first (/new).

**params**

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
    "kind": {
      "enum": [
        "direct",
        "channel"
      ]
    },
    "title": {
      "type": "string",
      "maxLength": 200
    },
    "memoryMode": {
      "$ref": "#/$defs/MemoryMode"
    },
    "chatKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "replaceActive": {
      "type": "boolean"
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
    "session"
  ],
  "properties": {
    "session": {
      "$ref": "#/$defs/SessionRecord"
    }
  }
}
```

### `session.list`

**Stability:** experimental · since 1.5.0

**Served by:** core

The caller's sessions: pinned first, then by last turn. Archived ones are excluded unless archived is only or any. search is a full-text query over titles and messages (every word must match).

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "kind": {
      "$ref": "#/$defs/SessionKind"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "archived": {
      "enum": [
        "exclude",
        "only",
        "any"
      ]
    },
    "search": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
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
    "sessions",
    "truncated"
  ],
  "properties": {
    "sessions": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/SessionRecord"
      }
    },
    "truncated": {
      "type": "boolean"
    }
  }
}
```

### `session.get`

**Stability:** experimental · since 1.5.0

**Served by:** core

One session of the caller's (archived ones included), with the id of its running turn (if any) and, when messages is given, the last that many messages. Another owner's session is E_NOT_FOUND.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "messages": {
      "type": "integer",
      "minimum": 0,
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
    "session",
    "runningTurnId"
  ],
  "properties": {
    "session": {
      "$ref": "#/$defs/SessionRecord"
    },
    "runningTurnId": {
      "type": [
        "string",
        "null"
      ]
    },
    "messages": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/SessionMessage"
      }
    }
  }
}
```

### `session.resume`

**Stability:** experimental · since 1.5.0

**Served by:** core

Get plus the transcript (the last `limit` messages, default 100) and the last event seq, so a client can continue from the next one. An archived session is E_CONFLICT.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
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
    "session",
    "runningTurnId",
    "messages",
    "lastEventSeq"
  ],
  "properties": {
    "session": {
      "$ref": "#/$defs/SessionRecord"
    },
    "runningTurnId": {
      "type": [
        "string",
        "null"
      ]
    },
    "messages": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/SessionMessage"
      }
    },
    "lastEventSeq": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

### `session.archive`

**Stability:** experimental · since 1.5.0

**Served by:** core

Archives a session (archive-first deletion: nothing is removed; there is no delete over RPC). Idempotent. A session with a running turn is E_CONFLICT.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
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
    "session"
  ],
  "properties": {
    "session": {
      "$ref": "#/$defs/SessionRecord"
    }
  }
}
```

### `session.submit`

**Stability:** experimental · since 1.5.0

**Served by:** core

Submits one user message and starts a turn. Returns at once with state running (events follow as session.event notifications and through session.events), or, with wait, after the turn ended with its state, reply and error. One running turn per session (else E_CONFLICT turn-in-progress); no configured provider is E_NOT_AVAILABLE reason no-provider. Recall and capture happen once per turn inside the core; memory mode is the session's, never a parameter.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId",
    "text"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200000
    },
    "wait": {
      "type": "boolean"
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
    "sessionId",
    "turnId",
    "messageId",
    "state"
  ],
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "turnId": {
      "type": "string"
    },
    "messageId": {
      "type": "string"
    },
    "state": {
      "enum": [
        "running",
        "completed",
        "failed"
      ]
    },
    "reply": {
      "type": "string"
    },
    "error": {
      "type": "string"
    }
  }
}
```

### `session.events`

**Stability:** experimental · since 1.5.0

**Served by:** core

The session's persisted events after afterSeq (default 0), oldest first: the same stream session.event delivers, for replay and catch-up. running tells whether a turn is still producing events.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "afterSeq": {
      "type": "integer",
      "minimum": 0
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2000
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
    "sessionId",
    "events",
    "lastSeq",
    "running"
  ],
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "events": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/SessionEvent"
      }
    },
    "lastSeq": {
      "type": "integer",
      "minimum": 0
    },
    "running": {
      "type": "boolean"
    }
  }
}
```

### `session.cancel`

**Stability:** experimental · since 1.5.0

**Served by:** core

Cancels the session's running turn: it ends failed with error cancelled (what was already streamed stays stored; nothing is captured). Idempotent: with no running turn nothing happens and cancelled is false.

**params**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "caller",
    "sessionId"
  ],
  "properties": {
    "caller": {
      "$ref": "#/$defs/CallerIdentity"
    },
    "sessionId": {
      "$ref": "#/$defs/SessionId"
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
    "sessionId",
    "turnId",
    "cancelled"
  ],
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "turnId": {
      "type": [
        "string",
        "null"
      ]
    },
    "cancelled": {
      "type": "boolean"
    }
  }
}
```

## Notifications

Delivered on the same connection to clients that called `events.subscribe`.

### `core.state`

**Stability:** stable · since 1.0.0

**Served by:** core

```json
{
  "x-stability": "stable",
  "x-since": "1.0.0",
  "x-server": "core",
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

**Served by:** core

```json
{
  "x-stability": "experimental",
  "x-since": "1.0.0",
  "x-server": "core",
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

**Stability:** experimental · since 1.0.0 · **deprecated** since 1.1.0, removal not before 2027-03-26; use harness event notifications: recall.completed, recall.degraded, recall.block-clipped, recall.block-dropped, job.run, memory.proposal (ADR-016 §6)

**Served by:** core

Every engine event forwarded verbatim: name is the EngineEventName, payload as emitted, agentId when the payload carries one. Delivered only to subscriptions that name engine.event in names (opt-in).

```json
{
  "x-stability": "experimental",
  "x-since": "1.0.0",
  "x-server": "core",
  "deprecated": true,
  "x-deprecated": {
    "since": "1.1.0",
    "removeAfter": "2027-03-26",
    "replacement": "harness event notifications: recall.completed, recall.degraded, recall.block-clipped, recall.block-dropped, job.run, memory.proposal (ADR-016 §6)"
  },
  "description": "Every engine event forwarded verbatim: name is the EngineEventName, payload as emitted, agentId when the payload carries one. Delivered only to subscriptions that name engine.event in names (opt-in).",
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

### `recall.completed`

**Stability:** experimental · since 1.1.0

**Served by:** core

One per recall attempt: total wall time and whether it degraded.

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "One per recall attempt: total wall time and whether it degraded.",
  "required": [
    "agentId",
    "totalMs",
    "degraded"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "totalMs": {
      "type": "number"
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
    }
  }
}
```

### `recall.degraded`

**Stability:** experimental · since 1.1.0

**Served by:** core

A recall exited degraded (timeout, abort, pressure, store error, ...).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "A recall exited degraded (timeout, abort, pressure, store error, ...).",
  "required": [
    "agentId",
    "degraded"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "degraded": {
      "$ref": "#/$defs/Degraded"
    }
  }
}
```

### `recall.block-clipped`

**Stability:** experimental · since 1.1.0

**Served by:** core

The inject-budget join clipped a context block from `from` to `to` characters.

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "The inject-budget join clipped a context block from `from` to `to` characters.",
  "required": [
    "agentId",
    "block",
    "from",
    "to",
    "reason"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "block": {
      "type": "string"
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

### `recall.block-dropped`

**Stability:** experimental · since 1.1.0

**Served by:** core

The inject-budget join dropped a context block (`to` is 0).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "The inject-budget join dropped a context block (`to` is 0).",
  "required": [
    "agentId",
    "block",
    "from",
    "to",
    "reason"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "block": {
      "type": "string"
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

### `job.run`

**Stability:** experimental · since 1.1.0

**Served by:** core

One per finished job run (the ledger row without counts, cost and keys).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "One per finished job run (the ledger row without counts, cost and keys).",
  "required": [
    "agentId",
    "runId",
    "job",
    "phase",
    "trigger",
    "outcome",
    "startedAt",
    "finishedAt",
    "durationMs",
    "attempt"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "runId": {
      "type": "string"
    },
    "job": {
      "type": "string"
    },
    "phase": {
      "oneOf": [
        {
          "enum": [
            "light",
            "rem",
            "deep"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "trigger": {
      "$ref": "#/$defs/JobTrigger"
    },
    "outcome": {
      "$ref": "#/$defs/JobOutcome"
    },
    "reason": {
      "type": "string"
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
    "attempt": {
      "type": "integer"
    }
  }
}
```

### `memory.proposal`

**Stability:** experimental · since 1.1.0

**Served by:** core

A change proposal against a shared copy was filed or resolved (D31). agentId is the sharer; delivered to subscriptions filtered to the sharer or the proposer. Agent ids are plain strings: a copy may come from another host's agent.

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "A change proposal against a shared copy was filed or resolved (D31). agentId is the sharer; delivered to subscriptions filtered to the sharer or the proposer. Agent ids are plain strings: a copy may come from another host's agent.",
  "required": [
    "agentId",
    "proposalId",
    "status",
    "sharerAgentId",
    "proposerAgentId",
    "sharedId"
  ],
  "properties": {
    "agentId": {
      "type": "string"
    },
    "proposalId": {
      "type": "string"
    },
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus"
    },
    "sharerAgentId": {
      "type": "string"
    },
    "proposerAgentId": {
      "type": "string"
    },
    "sharedId": {
      "type": "string"
    }
  }
}
```

### `dream.completed`

**Stability:** experimental · since 1.1.0

**Served by:** core

Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).",
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

### `acl.denied`

**Stability:** experimental · since 1.1.0

**Served by:** core

Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

### `embedding.identity.changed`

**Stability:** experimental · since 1.1.0

**Served by:** core

Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).

```json
{
  "x-stability": "experimental",
  "x-since": "1.1.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "Declared by the engine contract but not emitted by the pinned engine; no payload fields beyond agentId (G11).",
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    }
  }
}
```

### `config.changed`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

The running configuration changed (B3), sent on connections that called config.watch. `config` is the full new configuration; `source` is `set` (config.set) or `file` (a hand edit of config.json the watcher applied). `previousRevision` is null when no valid configuration ran before.

```json
{
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "x-server": "supervisor",
  "type": "object",
  "additionalProperties": false,
  "description": "The running configuration changed (B3), sent on connections that called config.watch. `config` is the full new configuration; `source` is `set` (config.set) or `file` (a hand edit of config.json the watcher applied). `previousRevision` is null when no valid configuration ran before.",
  "required": [
    "revision",
    "previousRevision",
    "changed",
    "restart",
    "config",
    "source"
  ],
  "properties": {
    "revision": {
      "type": "string"
    },
    "previousRevision": {
      "type": [
        "string",
        "null"
      ]
    },
    "changed": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "restart": {
      "$ref": "#/$defs/RestartPlan"
    },
    "config": {
      "type": "object"
    },
    "source": {
      "enum": [
        "set",
        "file"
      ]
    }
  }
}
```

### `module.state`

**Stability:** experimental · since 1.3.0

**Served by:** supervisor

A module child's health changed (spawned, ready, degraded, orphaned, stopping, stopped or crashed), sent on connections that called module.watch.

```json
{
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "x-server": "supervisor",
  "description": "A module child's health changed (spawned, ready, degraded, orphaned, stopping, stopped or crashed), sent on connections that called module.watch.",
  "$ref": "#/$defs/ModuleState"
}
```

### `ext.changed`

**Stability:** experimental · since 1.4.0

**Served by:** supervisor

An extension's kind, state, version or overlays changed (install, uninstall, restore, enable, disable, integrity), sent on connections that called ext.watch. `state` is installed or enabled, or removed once the extension was uninstalled (then version is the removed version and overlays is empty).

```json
{
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "x-server": "supervisor",
  "type": "object",
  "additionalProperties": false,
  "description": "An extension's kind, state, version or overlays changed (install, uninstall, restore, enable, disable, integrity), sent on connections that called ext.watch. `state` is installed or enabled, or removed once the extension was uninstalled (then version is the removed version and overlays is empty).",
  "required": [
    "name",
    "kind",
    "state",
    "version",
    "overlays"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "kind": {
      "$ref": "#/$defs/ExtKind"
    },
    "state": {
      "enum": [
        "installed",
        "enabled",
        "removed"
      ]
    },
    "version": {
      "type": "string"
    },
    "overlays": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtOverlay"
      }
    }
  }
}
```

### `models.changed`

**Stability:** experimental · since 1.5.0

**Served by:** core

Emitted when a scan alters available models in the catalog (D112).

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "x-server": "core",
  "description": "Emitted when a scan alters available models in the catalog (D112).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "discovered",
    "reappeared",
    "unavailable",
    "at"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "discovered": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "reappeared": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "unavailable": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "at": {
      "type": "string"
    }
  }
}
```

### `session.event`

**Stability:** experimental · since 1.5.0

**Served by:** core

One event of a session's stream (turn.started, delta, tool.call, tool.result, turn.completed, turn.failed), sent as it is persisted. Delivered only to subscriptions that name session.event in names (opt-in); an agentId filter on the subscription applies. The same events are replayable with session.events.

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "x-server": "core",
  "type": "object",
  "additionalProperties": false,
  "description": "One event of a session's stream (turn.started, delta, tool.call, tool.result, turn.completed, turn.failed), sent as it is persisted. Delivered only to subscriptions that name session.event in names (opt-in); an agentId filter on the subscription applies. The same events are replayable with session.events.",
  "required": [
    "agentId",
    "event"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "event": {
      "$ref": "#/$defs/SessionEvent"
    }
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
    "E_LOCKED",
    "E_NOT_FOUND",
    "E_DENIED",
    "E_APPROVAL_REQUIRED",
    "E_CONFLICT",
    "E_STORAGE"
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
        },
        "ext": {
          "type": "object",
          "description": "Experimental (1.4.0). What an ext.* refusal shows: the capability disclosure of acknowledge-capabilities (name, id, version, kind, trust, capabilities, scripts, authority; an install's acknowledge-* carries the ExtInspection instead, plus authority and previousCapabilities), dependents of required-by, paths of tampered, name, installedKind and installedId of name-taken, disabledDependents of an uninstall that failed after its cascade."
        },
        "ids": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "description": "Non-secret ids a caller needs to recover, e.g. the source and shared copy of a half-finished shared-copy refresh"
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

### `CoreStatus`

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
        "models": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "embedder",
            "reranker"
          ],
          "description": "Per-model readiness (E4, spec §6.3); absent before the engine reports it.",
          "properties": {
            "embedder": {
              "$ref": "#/$defs/ModelStatus"
            },
            "reranker": {
              "$ref": "#/$defs/ModelStatus"
            }
          }
        },
        "sharedMemory": {
          "$ref": "#/$defs/SharedMemoryStatus"
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
      "type": "integer",
      "description": "Complete lines still in state/journal (live and `.replaying-*` files) as the engine's journal status reports them (E4), or the start replay's kept count when the engine reports none."
    },
    "journalReplay": {
      "$ref": "#/$defs/JournalReplayStatus"
    },
    "jobs": {
      "$ref": "#/$defs/JobsStatus"
    },
    "config": {
      "$ref": "#/$defs/CoreConfigStatus"
    },
    "deprecationsUsed": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Deprecated methods/notifications used at least once since start, as `method:<name>`/`notification:<name>`, sorted (ADR-016 §5, S13)."
    }
  }
}
```

### `CoreConfigStatus`

```json
{
  "description": "Experimental (1.3.0). The configuration the core runs (B7): `source` is `supervisor` (its `config.watch` snapshot and every `config.changed` since) or `file` (config.json read at start, when no supervisor answered). `revision` is the supervisor's revision of it, null for the file. `restartPending` is true when it differs from the configuration the core started with in a `core`-class key; the supervisor then restarts the core once. Absent before the core has read its configuration.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "revision",
    "source",
    "restartPending"
  ],
  "properties": {
    "revision": {
      "type": [
        "string",
        "null"
      ]
    },
    "source": {
      "type": "string",
      "enum": [
        "supervisor",
        "file"
      ]
    },
    "restartPending": {
      "type": "boolean"
    }
  }
}
```

### `JournalReplayStatus`

```json
{
  "description": "Experimental (1.3.0). The journal replay a core runs in the background after `ready` (B2): `ready` no longer means the journal is drained. `replayed` counts the lines that left the journal so far; `pendingRemoval` those among them still in the `.replaying-*` file in progress (it is removed when the replay finishes that file, so journal counts include them until then); `kept` is the on-disk count after the last pass and `passes` the number of passes, both set when the replay ends. `aborted` is a stop that left lines unreplayed (they stay for the next start), `failed` a replay that could not read the journal. An empty journal is `done` with zeros at start. Absent before the core is ready.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "state",
    "replayed",
    "pendingRemoval",
    "kept",
    "passes",
    "startedAt",
    "finishedAt"
  ],
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "replaying",
        "done",
        "aborted",
        "failed"
      ]
    },
    "replayed": {
      "type": "integer",
      "minimum": 0
    },
    "pendingRemoval": {
      "type": "integer",
      "minimum": 0
    },
    "kept": {
      "type": "integer",
      "minimum": 0
    },
    "passes": {
      "type": "integer",
      "minimum": 0
    },
    "startedAt": {
      "type": "integer",
      "description": "Wall time (ms) the replay started."
    },
    "finishedAt": {
      "type": [
        "integer",
        "null"
      ],
      "description": "Wall time (ms) the replay ended; null while it runs."
    }
  }
}
```

### `JobsStatus`

```json
{
  "description": "Experimental (1.2.0). Job health as the engine reports it (E4 `EngineStatus.jobs`), flattened on purpose (ruling H3-R6): of the engine's breaker only `open` is kept (as `breakerOpen`; its sweep, session count and limit are dropped), and of each last run only `outcome`, `reason` and `finishedAt` (its runId, trigger, startedAt and attempt are dropped; `jobs.history` has them). Absent before the engine reports it.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "ledger",
    "agents"
  ],
  "properties": {
    "ledger": {
      "enum": [
        "ok",
        "unavailable"
      ]
    },
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agentId",
          "running",
          "breakerOpen",
          "unreadableLines",
          "lastRuns"
        ],
        "properties": {
          "agentId": {
            "$ref": "#/$defs/AgentId"
          },
          "running": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "jobs with a run in flight in this process, sorted"
          },
          "breakerOpen": {
            "type": "boolean",
            "description": "the rem/deep LLM-session breaker is open for the current UTC sweep"
          },
          "unreadableLines": {
            "type": "integer",
            "minimum": 0,
            "description": "job ledger lines that could not be parsed"
          },
          "lastRuns": {
            "type": "object",
            "description": "latest finished run per job name; jobs that never ran are absent",
            "additionalProperties": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "outcome",
                "finishedAt"
              ],
              "properties": {
                "outcome": {
                  "$ref": "#/$defs/JobOutcome"
                },
                "reason": {
                  "type": "string"
                },
                "finishedAt": {
                  "type": "integer"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### `ModelStatus`

```json
{
  "description": "One model's readiness as the engine reports it (E4). `loading` has `checkedAt: null`; after a completed probe the state stays `ready`/`failed` and a running re-probe shows `warming: true`. `error` only when `failed`. `id`: the embedder's model name or the reranker's provider; null when unknown.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "state",
    "warming",
    "checkedAt",
    "id"
  ],
  "properties": {
    "state": {
      "enum": [
        "loading",
        "ready",
        "failed",
        "disabled"
      ]
    },
    "warming": {
      "type": "boolean"
    },
    "checkedAt": {
      "type": [
        "integer",
        "null"
      ],
      "description": "epoch ms of the completed probe that set `state`"
    },
    "error": {
      "type": "string"
    },
    "id": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

### `SharedMemoryStatus`

```json
{
  "description": "Whether explicit shared memory (share/proposals) is available on this platform (E4). \"fd-capability\": the Linux file-descriptor mode; \"verified-path\": the path-verified mode the engine uses on macOS and Windows (since engine E4.2); \"unavailable\": neither works here (`reason` says why).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "supported",
    "mode"
  ],
  "properties": {
    "supported": {
      "type": "boolean"
    },
    "mode": {
      "enum": [
        "fd-capability",
        "verified-path",
        "unavailable"
      ]
    },
    "reason": {
      "type": "string"
    }
  }
}
```

### `CrashReason`

```json
{
  "description": "Experimental (1.3.0). The supervisor's crash-reason vocabulary (ADR-012 §10): `ChildStatus.process.reason` of a crashed child and `ChildStatus.lastExit.reason` take these values. `gave-up`: the child exited five times inside the give-up window and is not restarted on its own (its last exit is in `lastExit`); `manifest-invalid` and `api-version-unsupported` are module-only (B12). Documentation: the fields stay plain strings.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "enum": [
    "lock-held",
    "config-invalid",
    "engine-contract",
    "ready-timeout",
    "adopted-exit",
    "manifest-invalid",
    "api-version-unsupported",
    "gave-up",
    "none"
  ]
}
```

### `ChildStatus`

```json
{
  "description": "One supervised child process as the supervisor sees it. A crashed child's `process.reason` and `lastExit.reason` are $defs/CrashReason values.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "role",
    "process",
    "pid",
    "instanceId",
    "adopted",
    "restarts",
    "lastExit",
    "nextRestartAt"
  ],
  "properties": {
    "role": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
    },
    "process": {
      "$ref": "#/$defs/ProcessState"
    },
    "pid": {
      "type": [
        "integer",
        "null"
      ]
    },
    "instanceId": {
      "type": [
        "string",
        "null"
      ]
    },
    "adopted": {
      "type": "boolean",
      "description": "true when the supervisor adopted a running child instead of spawning it"
    },
    "restarts": {
      "type": "integer",
      "minimum": 0
    },
    "lastExit": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "signal",
            "at",
            "reason"
          ],
          "properties": {
            "code": {
              "type": [
                "integer",
                "null"
              ]
            },
            "signal": {
              "type": [
                "string",
                "null"
              ]
            },
            "at": {
              "type": "integer"
            },
            "reason": {
              "type": [
                "string",
                "null"
              ]
            }
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "nextRestartAt": {
      "type": [
        "integer",
        "null"
      ],
      "description": "epoch ms of the scheduled restart; null when none is scheduled"
    },
    "kind": {
      "enum": [
        "core",
        "module"
      ],
      "description": "Experimental (1.3.0). Whether the child is the core or a module; absent from supervisors before 1.3.0."
    }
  }
}
```

### `ModuleState`

```json
{
  "description": "Experimental (1.3.0). A module child's health as the supervisor sees it (module.watch, module.state): its name, its ChildStatus process state, and its pid and instance id while a process runs.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "process",
    "pid",
    "instanceId"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
    },
    "process": {
      "$ref": "#/$defs/ProcessState"
    },
    "pid": {
      "type": [
        "integer",
        "null"
      ]
    },
    "instanceId": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

### `ModuleStatus`

```json
{
  "description": "Experimental (1.3.0). A module process's own status (module.status, module.adopt): its process state, its manifest identity, and its link to the core.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "process",
    "name",
    "version",
    "apiVersion",
    "instanceId",
    "pid",
    "uptimeMs",
    "core"
  ],
  "properties": {
    "process": {
      "$ref": "#/$defs/ProcessState"
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}$"
    },
    "version": {
      "type": "string"
    },
    "apiVersion": {
      "type": "string"
    },
    "instanceId": {
      "type": "string"
    },
    "pid": {
      "type": "integer"
    },
    "uptimeMs": {
      "type": "integer",
      "minimum": 0
    },
    "core": {
      "enum": [
        "connected",
        "reconnecting",
        "not-needed"
      ],
      "description": "connected or reconnecting when the manifest needs the core; not-needed otherwise"
    },
    "detail": {
      "type": "object",
      "description": "what the module reports about itself (ModuleContext.setDetail)"
    }
  }
}
```

### `ModuleListEntry`

```json
{
  "description": "Experimental (1.3.0). One installed module (module.list, B14): its manifest identity (null fields when the manifest is invalid), whether modules.<name>.enabled lets it run, why it cannot start (manifest errors, a needs-cycle, an unresolved need, an unsupported apiVersion), its child while a supervisor runs it (null without a supervisor or before it has a slot), and the last module.status detail the supervisor polled (null when none).",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "version",
    "apiVersion",
    "priority",
    "band",
    "scope",
    "provides",
    "consumes",
    "needs",
    "enabled",
    "errors",
    "child"
  ],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "version": {
      "type": [
        "string",
        "null"
      ]
    },
    "apiVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "priority": {
      "type": [
        "integer",
        "null"
      ]
    },
    "band": {
      "type": [
        "string",
        "null"
      ]
    },
    "scope": {
      "type": [
        "string",
        "null"
      ]
    },
    "provides": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "consumes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "needs": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "enabled": {
      "type": "boolean"
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "child": {
      "oneOf": [
        {
          "$ref": "#/$defs/ChildStatus"
        },
        {
          "type": "null"
        }
      ]
    },
    "detail": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

### `ModuleGraph`

```json
{
  "description": "Experimental (1.3.0). The module dependency graph (module.graph, spec §6.6): the core node first, then every installed module (valid: false with null fields for an invalid manifest); needs-edges and consumes-edges (with the capability); the needs-cycles (members sorted); and what does not resolve (a needs naming a missing or invalid module, a consumes without a provider).",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "nodes",
    "edges",
    "cycles",
    "unresolved"
  ],
  "properties": {
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "version",
          "priority",
          "band",
          "scope",
          "extensionPoints",
          "valid"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "version": {
            "type": [
              "string",
              "null"
            ]
          },
          "priority": {
            "type": [
              "integer",
              "null"
            ]
          },
          "band": {
            "type": [
              "string",
              "null"
            ]
          },
          "scope": {
            "type": [
              "string",
              "null"
            ]
          },
          "extensionPoints": {
            "type": "object",
            "additionalProperties": {
              "enum": [
                "chain",
                "collect"
              ]
            }
          },
          "valid": {
            "type": "boolean"
          }
        }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "from",
          "to",
          "kind"
        ],
        "properties": {
          "from": {
            "type": "string"
          },
          "to": {
            "type": "string"
          },
          "kind": {
            "enum": [
              "needs",
              "consumes"
            ]
          },
          "capability": {
            "type": "string"
          }
        }
      }
    },
    "cycles": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "unresolved": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "from",
          "kind"
        ],
        "properties": {
          "from": {
            "type": "string"
          },
          "kind": {
            "enum": [
              "needs",
              "consumes"
            ]
          },
          "name": {
            "type": "string"
          },
          "capability": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

### `JobTrigger`

```json
{
  "enum": [
    "cron",
    "manual",
    "harness",
    "capture",
    "unknown"
  ]
}
```

### `JobOutcome`

```json
{
  "enum": [
    "completed",
    "skipped",
    "incomplete",
    "failed",
    "abandoned"
  ]
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
      "$ref": "#/$defs/JobTrigger"
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
      "$ref": "#/$defs/JobOutcome"
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

### `SystemJobRun`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "runId",
    "job",
    "kind",
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
    "kind": {
      "const": "system"
    },
    "trigger": {
      "$ref": "#/$defs/JobTrigger"
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
      "$ref": "#/$defs/JobOutcome"
    },
    "reason": {
      "type": "string"
    },
    "runningRunId": {
      "type": "string"
    },
    "attempt": {
      "type": "integer"
    },
    "args": {
      "type": "object"
    }
  }
}
```

### `DreamPhase`

```json
{
  "enum": [
    "light",
    "rem",
    "deep"
  ]
}
```

### `DreamOutcome`

```json
{
  "enum": [
    "completed",
    "skipped",
    "failed",
    "aborted"
  ]
}
```

### `DreamTrigger`

```json
{
  "enum": [
    "cron",
    "importance",
    "manual",
    "catchup"
  ]
}
```

### `DreamRun`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "description": "One row of the dream run ledger (ADR-009 dream_run). outcome is null while the run is open; every outcome other than completed carries a reason.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "runId",
    "agentId",
    "phase",
    "jobId",
    "idempotencyKey",
    "claimed",
    "trigger",
    "startedAt",
    "outcome",
    "reason",
    "counts"
  ],
  "properties": {
    "runId": {
      "type": "string"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
    },
    "jobId": {
      "type": "string"
    },
    "partition": {
      "type": [
        "string",
        "null"
      ]
    },
    "idempotencyKey": {
      "type": "string"
    },
    "claimed": {
      "type": "boolean",
      "description": "True when this run holds the key that makes a rerun over the same corpus and window an idempotent skip."
    },
    "trigger": {
      "$ref": "#/$defs/DreamTrigger"
    },
    "scheduledFor": {
      "type": [
        "integer",
        "null"
      ]
    },
    "startedAt": {
      "type": "integer"
    },
    "finishedAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "durationMs": {
      "type": [
        "integer",
        "null"
      ]
    },
    "outcome": {
      "oneOf": [
        {
          "$ref": "#/$defs/DreamOutcome"
        },
        {
          "type": "null"
        }
      ]
    },
    "reason": {
      "type": [
        "string",
        "null"
      ]
    },
    "counts": {
      "type": "object",
      "additionalProperties": {
        "type": "integer"
      }
    },
    "tokensIn": {
      "type": [
        "integer",
        "null"
      ]
    },
    "tokensOut": {
      "type": [
        "integer",
        "null"
      ]
    },
    "costMicros": {
      "type": [
        "integer",
        "null"
      ],
      "description": "Null until a price table exists (measured in tokens first, ADR-009 B5/Q1)."
    },
    "logPath": {
      "type": [
        "string",
        "null"
      ]
    },
    "error": {
      "oneOf": [
        {
          "type": "null"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "message"
          ],
          "properties": {
            "message": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        }
      ]
    }
  }
}
```

### `DreamSchedule`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "agentId",
    "phase",
    "cron",
    "timezone",
    "enabled",
    "staggerOffsetS",
    "nextRunAt"
  ],
  "properties": {
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "phase": {
      "$ref": "#/$defs/DreamPhase"
    },
    "cron": {
      "type": "string"
    },
    "timezone": {
      "type": "string",
      "description": "IANA zone, stored explicitly."
    },
    "enabled": {
      "type": "boolean"
    },
    "staggerOffsetS": {
      "type": "integer",
      "minimum": 0
    },
    "nextRunAt": {
      "type": [
        "integer",
        "null"
      ]
    }
  }
}
```

### `DreamPhaseStatus`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "phase",
    "enabled",
    "cron",
    "timezone",
    "staggerOffsetS",
    "nextRunAt",
    "running",
    "lastRun",
    "breaker",
    "importance"
  ],
  "properties": {
    "phase": {
      "$ref": "#/$defs/DreamPhase"
    },
    "enabled": {
      "type": "boolean"
    },
    "cron": {
      "type": "string"
    },
    "timezone": {
      "type": "string"
    },
    "staggerOffsetS": {
      "type": "integer"
    },
    "nextRunAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "running": {
      "type": "boolean"
    },
    "lastRun": {
      "oneOf": [
        {
          "$ref": "#/$defs/DreamRun"
        },
        {
          "type": "null"
        }
      ]
    },
    "breaker": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "state",
        "until",
        "reason",
        "sessionsUsed",
        "limit"
      ],
      "properties": {
        "state": {
          "enum": [
            "closed",
            "open"
          ]
        },
        "until": {
          "type": [
            "integer",
            "null"
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "sessionsUsed": {
          "type": "integer"
        },
        "limit": {
          "type": "integer"
        }
      }
    },
    "importance": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "accumulated",
        "threshold",
        "capturesSinceRun",
        "minCorpus"
      ],
      "properties": {
        "accumulated": {
          "type": "number"
        },
        "threshold": {
          "type": "number"
        },
        "capturesSinceRun": {
          "type": "integer"
        },
        "minCorpus": {
          "type": "integer"
        }
      }
    }
  }
}
```

### `DreamPlan`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "description": "What dreams.run with dryRun answers: the guard chain evaluated without a ledger row or an engine call.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "dryRun",
    "wouldRun",
    "reason",
    "jobs",
    "idempotencyKey",
    "counts"
  ],
  "properties": {
    "dryRun": {
      "const": true
    },
    "wouldRun": {
      "type": "boolean"
    },
    "reason": {
      "type": [
        "string",
        "null"
      ]
    },
    "jobs": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "idempotencyKey": {
      "type": "string"
    },
    "counts": {
      "type": "object",
      "additionalProperties": {
        "type": "integer"
      }
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

### `ExtKind`

```json
{
  "description": "Experimental (1.4.0). The kind of an extension (X1). X2 extends the enum additively (mcp-server, bundle).",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "enum": [
    "skill",
    "module",
    "channel"
  ]
}
```

### `ExtOverlay`

```json
{
  "description": "Experimental (1.4.0). A derived condition shown instead of the plain state; it never changes the configuration: `needs-setup` (a required secret slot is unfilled), `tampered` (installed files differ from state.json), `revoked` (a revocation matches), `incompatible` (compat no longer holds), `error` (an item in an error state, e.g. a module that gave up, spec 6.2).",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "enum": [
    "needs-setup",
    "incompatible",
    "revoked",
    "tampered",
    "error"
  ]
}
```

### `ExtTrustTier`

```json
{
  "description": "Experimental (1.4.0). Where an item stands on trust: release (bundled with a release), first-party (signed by a pinned key), unknown-signer (signed by a key the harness does not trust), unsigned, imported (from a skills import) or dev (a local module directory).",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "enum": [
    "release",
    "first-party",
    "unknown-signer",
    "unsigned",
    "imported",
    "dev"
  ]
}
```

### `ExtAgents`

```json
{
  "description": "Experimental (1.4.0). `\"all\"` or the agents an item is enabled for.",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "oneOf": [
    {
      "const": "all"
    },
    {
      "type": "array",
      "items": {
        "$ref": "#/$defs/AgentId"
      }
    }
  ]
}
```

### `ExtScript`

```json
{
  "description": "Experimental (1.4.0). One executable file of a package: its path inside the package, its size in bytes, and its first line when it starts with a shebang.",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path",
    "size"
  ],
  "properties": {
    "path": {
      "type": "string"
    },
    "size": {
      "type": "integer",
      "minimum": 0
    },
    "firstLine": {
      "type": "string"
    }
  }
}
```

### `ExtTrust`

```json
{
  "description": "Experimental (1.4.0). The trust verdict of a package: the tier, the signing key id when a signature was present, and the label of the trusted key that verified it.",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "tier"
  ],
  "properties": {
    "tier": {
      "$ref": "#/$defs/ExtTrustTier"
    },
    "keyId": {
      "type": "string"
    },
    "label": {
      "type": "string"
    }
  }
}
```

### `ExtItem`

```json
{
  "description": "Experimental (1.4.0). One installed extension (ext.list, ext.watch): name, package id (null without a package), kind, version, source (file, bundled, local, ...), trust tier, plain state, derived overlays, whether it is enabled at all, and the agents that effectively have it (skills; \"all\" for modules and channels).",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "id",
    "kind",
    "version",
    "source",
    "trust",
    "state",
    "overlays",
    "enabled",
    "agents"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
    },
    "id": {
      "type": [
        "string",
        "null"
      ]
    },
    "kind": {
      "$ref": "#/$defs/ExtKind"
    },
    "version": {
      "type": "string"
    },
    "source": {
      "type": "string"
    },
    "trust": {
      "$ref": "#/$defs/ExtTrustTier"
    },
    "state": {
      "enum": [
        "installed",
        "enabled"
      ]
    },
    "overlays": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtOverlay"
      }
    },
    "enabled": {
      "type": "boolean"
    },
    "agents": {
      "$ref": "#/$defs/ExtAgents"
    },
    "integrity": {
      "enum": [
        "ok",
        "tampered",
        "unchecked"
      ]
    }
  }
}
```

### `ExtDetail`

```json
{
  "description": "Experimental (1.4.0). ext.show: the item, its manifest, capabilities and scripts, the trust verdict, a files summary, the extensions that depend on it, and its trash entries.",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "item",
    "manifest",
    "capabilities",
    "scripts",
    "trust",
    "files",
    "dependents",
    "trash"
  ],
  "properties": {
    "item": {
      "$ref": "#/$defs/ExtItem"
    },
    "manifest": {
      "type": [
        "object",
        "null"
      ]
    },
    "capabilities": {
      "type": "object"
    },
    "scripts": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtScript"
      }
    },
    "trust": {
      "$ref": "#/$defs/ExtTrust"
    },
    "files": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "count",
        "bytes"
      ],
      "properties": {
        "count": {
          "type": "integer",
          "minimum": 0
        },
        "bytes": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "dependents": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "trash": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "trashId",
          "version",
          "removedAt"
        ],
        "properties": {
          "trashId": {
            "type": "string"
          },
          "version": {
            "type": "string"
          },
          "removedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  }
}
```

### `ExtInspection`

```json
{
  "description": "Experimental (1.4.0). ext.inspect (spec 10.2): the id to install with and its expiry (RFC 3339 UTC), the package sha256, the manifest, the trust verdict, the checks (pass, warn or fail), the declared capabilities, the executable files, the requirements, and what an install would replace (with the capability changes).",
  "x-stability": "experimental",
  "x-since": "1.4.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "inspectionId",
    "expiresAt",
    "sha256",
    "manifest",
    "trust",
    "checks",
    "capabilities",
    "scripts",
    "requires"
  ],
  "properties": {
    "inspectionId": {
      "type": "string"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time"
    },
    "sha256": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "manifest": {
      "type": "object"
    },
    "trust": {
      "$ref": "#/$defs/ExtTrust"
    },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "status",
          "detail"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "status": {
            "enum": [
              "pass",
              "warn",
              "fail"
            ]
          },
          "detail": {
            "type": "string"
          }
        }
      }
    },
    "capabilities": {
      "type": "object"
    },
    "scripts": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ExtScript"
      }
    },
    "requires": {
      "type": "object"
    },
    "replaces": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "capabilityDiff"
      ],
      "properties": {
        "version": {
          "type": "string"
        },
        "capabilityDiff": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "changed"
          ],
          "properties": {
            "changed": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
}
```

### `BudgetLimit`

```json
{
  "description": "Experimental (1.5.0). A budget limit. Cost bounds are micro-USD; token bounds count input + output tokens.",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "scope",
    "period",
    "metric",
    "soft",
    "hard"
  ],
  "properties": {
    "scope": {
      "enum": [
        "global",
        "agent"
      ]
    },
    "agentId": {
      "type": "string"
    },
    "period": {
      "enum": [
        "day",
        "month"
      ]
    },
    "metric": {
      "enum": [
        "cost",
        "tokens"
      ]
    },
    "soft": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    },
    "hard": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    }
  }
}
```

### `BudgetLimitState`

```json
{
  "description": "Experimental (1.5.0). A budget limit with its use in the current period and where that stands.",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "scope",
    "period",
    "metric",
    "soft",
    "hard",
    "used",
    "state"
  ],
  "properties": {
    "scope": {
      "enum": [
        "global",
        "agent"
      ]
    },
    "agentId": {
      "type": "string"
    },
    "period": {
      "enum": [
        "day",
        "month"
      ]
    },
    "metric": {
      "enum": [
        "cost",
        "tokens"
      ]
    },
    "soft": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    },
    "hard": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    },
    "used": {
      "type": "integer",
      "minimum": 0
    },
    "state": {
      "enum": [
        "ok",
        "soft",
        "hard"
      ]
    }
  }
}
```

### `IdentityHandle`

```json
{
  "description": "Experimental (1.5.0). A channel handle. displayName is a label for people and is never matched on.",
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
      "pattern": "^[a-z][a-z0-9._-]{0,31}$"
    },
    "accountId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "userId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  }
}
```

### `IdentityHuman`

```json
{
  "description": "Experimental (1.5.0). A human principal: an opaque UUIDv7 id, never reused.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "displayName",
    "createdAt"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "displayName": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "description": "ms since the epoch"
    }
  }
}
```

### `IdentityLink`

```json
{
  "description": "Experimental (1.5.0). A channel identity linked to a human, with how it was proved and whether it was revoked. v1Principal is the engine's v1 principal of the handle (the read side of the union recall).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "humanId",
    "channel",
    "accountId",
    "userId",
    "v1Principal",
    "proofMethod",
    "linkedAt",
    "linkedBy",
    "revokedAt",
    "revokedBy"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "humanId": {
      "type": "string"
    },
    "channel": {
      "type": "string"
    },
    "accountId": {
      "type": "string"
    },
    "userId": {
      "type": "string"
    },
    "displayName": {
      "type": "string"
    },
    "v1Principal": {
      "type": "string",
      "pattern": "^user:v1:[a-f0-9]{64}$"
    },
    "proofMethod": {
      "type": "string",
      "enum": [
        "pairing_code",
        "owner_manual",
        "signed_challenge"
      ]
    },
    "linkedAt": {
      "type": "integer"
    },
    "linkedBy": {
      "type": "string"
    },
    "revokedAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "revokedBy": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

### `IdentityHumanEntry`

```json
{
  "description": "Experimental (1.5.0). A human with its linked identities.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "displayName",
    "createdAt",
    "identities"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "displayName": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer"
    },
    "identities": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/IdentityLink"
      }
    }
  }
}
```

### `IdentityPairingState`

```json
{
  "type": "string",
  "enum": [
    "pending",
    "claimed",
    "confirmed",
    "declined",
    "expired"
  ]
}
```

### `IdentityPairing`

```json
{
  "description": "Experimental (1.5.0). A pairing that still waits (a pending code, or a claim waiting for the owner). Never carries the code.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "humanId",
    "channel",
    "state",
    "createdAt",
    "expiresAt"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "humanId": {
      "type": "string"
    },
    "channel": {
      "type": "string"
    },
    "state": {
      "$ref": "#/$defs/IdentityPairingState"
    },
    "createdAt": {
      "type": "integer"
    },
    "expiresAt": {
      "type": "integer"
    },
    "claimedBy": {
      "$ref": "#/$defs/IdentityHandle"
    },
    "confirmBy": {
      "type": "integer"
    }
  }
}
```

### `SessionId`

```json
{
  "type": "string",
  "minLength": 1,
  "maxLength": 128
}
```

### `SessionKind`

```json
{
  "enum": [
    "direct",
    "card",
    "project",
    "channel",
    "acp"
  ]
}
```

### `MemoryMode`

```json
{
  "enum": [
    "remember",
    "incognito"
  ]
}
```

### `SessionRecord`

```json
{
  "description": "One session (M1b-2c, D92 §2.1). kind, agentId, owner scope and chatKey are immutable (I1). The owner principal is never sent: a caller sees only its own sessions.",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "kind",
    "agentId",
    "scope",
    "chatKey",
    "title",
    "pinned",
    "memoryMode",
    "createdAt",
    "updatedAt",
    "lastTurnAt",
    "archivedAt",
    "turnCount"
  ],
  "properties": {
    "id": {
      "$ref": "#/$defs/SessionId"
    },
    "kind": {
      "$ref": "#/$defs/SessionKind"
    },
    "agentId": {
      "$ref": "#/$defs/AgentId"
    },
    "scope": {
      "type": "string"
    },
    "chatKey": {
      "type": [
        "string",
        "null"
      ]
    },
    "title": {
      "type": "string"
    },
    "pinned": {
      "type": "boolean"
    },
    "memoryMode": {
      "$ref": "#/$defs/MemoryMode"
    },
    "createdAt": {
      "type": "integer"
    },
    "updatedAt": {
      "type": "integer"
    },
    "lastTurnAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "archivedAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "turnCount": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

### `SessionMessage`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "seq",
    "role",
    "text",
    "createdAt"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "seq": {
      "type": "integer"
    },
    "turnId": {
      "type": [
        "string",
        "null"
      ]
    },
    "role": {
      "enum": [
        "system",
        "user",
        "assistant",
        "tool"
      ]
    },
    "text": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer"
    }
  }
}
```

### `SessionEventType`

```json
{
  "enum": [
    "turn.started",
    "delta",
    "tool.call",
    "tool.result",
    "turn.completed",
    "turn.failed"
  ]
}
```

### `SessionEvent`

```json
{
  "description": "One event of a session's ordered stream. seq is per session, starts at 1 and has no gaps; data's shape depends on type.",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "sessionId",
    "seq",
    "turnId",
    "type",
    "data",
    "at"
  ],
  "properties": {
    "sessionId": {
      "$ref": "#/$defs/SessionId"
    },
    "seq": {
      "type": "integer",
      "minimum": 1
    },
    "turnId": {
      "type": [
        "string",
        "null"
      ]
    },
    "type": {
      "$ref": "#/$defs/SessionEventType"
    },
    "data": {
      "type": "object"
    },
    "at": {
      "type": "integer"
    }
  }
}
```

### `RestartPlan`

```json
{
  "description": "Experimental (1.3.0). A restart plan (ADR-013 §3): the changed live keys, whether the core restarts, and the modules that restart.",
  "x-stability": "experimental",
  "x-since": "1.3.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "live",
    "core",
    "modules"
  ],
  "properties": {
    "live": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "core": {
      "type": "boolean"
    },
    "modules": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

### `MemoryId`

```json
{
  "type": "string",
  "minLength": 1,
  "maxLength": 256
}
```

### `IpcAddress`

```json
{
  "description": "An IPC endpoint (engine IpcAddress): a Linux abstract socket name, an absolute unix-socket path or a Windows named pipe.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "kind",
    "address"
  ],
  "properties": {
    "kind": {
      "enum": [
        "abstract-socket",
        "unix-socket",
        "named-pipe"
      ]
    },
    "address": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    }
  }
}
```

### `EmbeddingIdentity`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "fingerprintId",
    "provider",
    "model",
    "dimensions"
  ],
  "properties": {
    "fingerprintId": {
      "type": "string"
    },
    "provider": {
      "type": "string"
    },
    "model": {
      "type": "string"
    },
    "dimensions": {
      "type": "integer",
      "minimum": 1
    }
  }
}
```

### `ReembedProbe`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "verdict",
    "reasons",
    "changed",
    "storedId",
    "targetId",
    "message"
  ],
  "properties": {
    "verdict": {
      "enum": [
        "compatible",
        "migration-needed",
        "incompatible"
      ]
    },
    "reasons": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "changed": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "storedId": {
      "type": [
        "string",
        "null"
      ]
    },
    "targetId": {
      "type": [
        "string",
        "null"
      ]
    },
    "message": {
      "type": "string"
    }
  }
}
```

### `ReembedPlanSummary`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "sourceGeneration",
    "targetGeneration",
    "rows",
    "tables",
    "batches",
    "batchSize",
    "providerCalls",
    "sourceBytes",
    "targetBytes",
    "requiredFreeBytes",
    "freeBytes",
    "throttleMs",
    "minDurationMs",
    "probeStatus"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "sourceGeneration": {
      "type": "string"
    },
    "targetGeneration": {
      "type": "string"
    },
    "rows": {
      "type": "integer",
      "minimum": 0
    },
    "tables": {
      "type": "integer",
      "minimum": 0
    },
    "batches": {
      "type": "integer",
      "minimum": 0
    },
    "batchSize": {
      "type": "integer",
      "minimum": 1
    },
    "providerCalls": {
      "type": "integer",
      "minimum": 0
    },
    "sourceBytes": {
      "type": "integer",
      "minimum": 0
    },
    "targetBytes": {
      "type": "integer",
      "minimum": 0
    },
    "requiredFreeBytes": {
      "type": "integer",
      "minimum": 0
    },
    "freeBytes": {
      "type": "integer",
      "minimum": 0
    },
    "throttleMs": {
      "type": "integer",
      "minimum": 0
    },
    "minDurationMs": {
      "type": "integer",
      "minimum": 0
    },
    "probeStatus": {
      "type": "string"
    }
  }
}
```

### `ReembedCheckpoint`

```json
{
  "description": "The migration's Harness checkpoint without the engine's confirmation token. `aborted` is stopped and resumable (by request or after an engine error: see error); `validating` with error engine-validate-unavailable waits for an engine that can validate; `switched` and `failed` are final.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "v",
    "id",
    "planDigest",
    "createdAt",
    "updatedAt",
    "phase",
    "sourceGeneration",
    "targetGeneration",
    "target",
    "counts",
    "throttleMs",
    "abortRequested",
    "error"
  ],
  "properties": {
    "v": {
      "const": 1
    },
    "id": {
      "type": "string"
    },
    "planDigest": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0
    },
    "phase": {
      "enum": [
        "planned",
        "running",
        "aborted",
        "validating",
        "ready-to-switch",
        "switched",
        "failed"
      ]
    },
    "sourceGeneration": {
      "type": "string"
    },
    "targetGeneration": {
      "type": "string"
    },
    "target": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "provider",
        "model",
        "dimensions"
      ],
      "properties": {
        "provider": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "dimensions": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "counts": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "rows",
        "tables",
        "batches",
        "rowsDone",
        "batchesDone"
      ],
      "properties": {
        "rows": {
          "type": "integer",
          "minimum": 0
        },
        "tables": {
          "type": "integer",
          "minimum": 0
        },
        "batches": {
          "type": "integer",
          "minimum": 0
        },
        "rowsDone": {
          "type": "integer",
          "minimum": 0
        },
        "batchesDone": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "throttleMs": {
      "type": "integer",
      "minimum": 0
    },
    "abortRequested": {
      "type": "boolean"
    },
    "error": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "message"
          ],
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

### `MemoryCard`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "scope",
    "text",
    "summary",
    "createdAt",
    "origin",
    "epistemicStatus"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "scope": {
      "enum": [
        "agent-private",
        "workspace",
        "user"
      ]
    },
    "text": {
      "type": "string"
    },
    "summary": {
      "type": "string"
    },
    "createdAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "origin": {
      "type": [
        "string",
        "null"
      ]
    },
    "epistemicStatus": {
      "type": [
        "string",
        "null"
      ]
    },
    "score": {
      "type": "number",
      "description": "present on a topic listing, absent on show"
    },
    "sharedBy": {
      "type": "string",
      "description": "workspace/user copies only: the sharing agent, possibly another host's (never constrained to AgentId)"
    },
    "sourceId": {
      "type": "string",
      "description": "workspace/user copies only: the sharer's original card"
    }
  }
}
```

### `MemoryProposalStatus`

```json
{
  "enum": [
    "pending",
    "accepted",
    "rejected",
    "stale"
  ]
}
```

### `MemoryProposal`

```json
{
  "type": "object",
  "additionalProperties": false,
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
  "properties": {
    "id": {
      "type": "string"
    },
    "sharedId": {
      "type": "string"
    },
    "sourceId": {
      "type": "string"
    },
    "target": {
      "enum": [
        "workspace",
        "user"
      ]
    },
    "sharerAgentId": {
      "type": "string"
    },
    "proposerAgentId": {
      "type": "string"
    },
    "oldText": {
      "type": "string"
    },
    "newText": {
      "type": "string"
    },
    "note": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer"
    },
    "status": {
      "$ref": "#/$defs/MemoryProposalStatus"
    },
    "resolvedAt": {
      "type": [
        "integer",
        "null"
      ]
    },
    "resultId": {
      "type": [
        "string",
        "null"
      ],
      "description": "accepted: the id of the refreshed shared copy"
    },
    "resolutionNote": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

### `ModelKind`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "string",
  "enum": [
    "chat",
    "embedding",
    "tts",
    "asr",
    "image",
    "moderation",
    "rerank",
    "realtime",
    "unknown"
  ]
}
```

### `ModelCapability`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "string",
  "enum": [
    "tools",
    "vision",
    "reasoning",
    "audio_in",
    "audio_out",
    "structured_output",
    "prompt_caching"
  ]
}
```

### `CatalogModelStatus`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "string",
  "enum": [
    "available",
    "unavailable",
    "manual"
  ]
}
```

### `ModelOverrides`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "displayName": {
      "type": "string"
    },
    "kind": {
      "$ref": "#/$defs/ModelKind"
    },
    "contextWindow": {
      "type": "integer",
      "minimum": 1
    },
    "capabilities": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelCapability"
      }
    },
    "aliases": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

### `ModelEntry`

```json
{
  "description": "One model in the harness catalog (D112).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "id",
    "displayName",
    "kind",
    "capabilities",
    "aliases",
    "status",
    "firstSeen",
    "lastSeen",
    "source",
    "overrides"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "displayName": {
      "type": "string"
    },
    "kind": {
      "$ref": "#/$defs/ModelKind"
    },
    "contextWindow": {
      "type": "integer",
      "minimum": 1
    },
    "capabilities": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelCapability"
      }
    },
    "aliases": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "status": {
      "$ref": "#/$defs/CatalogModelStatus"
    },
    "firstSeen": {
      "type": "string"
    },
    "lastSeen": {
      "type": "string"
    },
    "source": {
      "enum": [
        "scan",
        "table",
        "manual"
      ]
    },
    "overrides": {
      "$ref": "#/$defs/ModelOverrides"
    }
  }
}
```

### `ModelScanResultCode`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "string",
  "enum": [
    "ok",
    "failed:auth",
    "failed:network",
    "failed:server",
    "failed:invalid",
    "failed:empty"
  ]
}
```

### `ModelProviderState`

```json
{
  "description": "Scan state of one model provider (D112).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "lastScanAt": {
      "type": "string"
    },
    "lastResult": {
      "$ref": "#/$defs/ModelScanResultCode"
    },
    "nextScanAt": {
      "type": "string"
    },
    "consecutiveFailures": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

### `ModelScanWarning`

```json
{
  "description": "Warning from a model scan or catalog state (D112).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code"
  ],
  "properties": {
    "code": {
      "enum": [
        "role_unavailable",
        "shadowed_by_manual",
        "empty_list"
      ]
    },
    "role": {
      "type": "string"
    },
    "provider": {
      "type": "string"
    },
    "id": {
      "type": "string"
    }
  }
}
```

### `ModelScanOutcomeCode`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "string",
  "enum": [
    "ok",
    "failed:auth",
    "failed:network",
    "failed:server",
    "failed:invalid",
    "failed:empty",
    "already_running",
    "disabled",
    "no-scanner"
  ]
}
```

### `ModelScanErrorInfo`

```json
{
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code",
    "reason",
    "retryable",
    "hint"
  ],
  "properties": {
    "code": {
      "enum": [
        "auth",
        "network",
        "timeout",
        "server",
        "rate-limited",
        "invalid-request"
      ]
    },
    "reason": {
      "type": "string"
    },
    "retryable": {
      "type": "boolean"
    },
    "hint": {
      "type": "string"
    },
    "httpStatus": {
      "type": "integer"
    },
    "retryAfterS": {
      "type": "integer"
    }
  }
}
```

### `ModelScanProviderResult`

```json
{
  "description": "Outcome of scanning one provider (D112).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "result",
    "new",
    "reappeared",
    "unavailable",
    "unchanged",
    "duplicates",
    "warnings",
    "nextScanAt"
  ],
  "properties": {
    "provider": {
      "type": "string"
    },
    "result": {
      "$ref": "#/$defs/ModelScanOutcomeCode"
    },
    "runningRunId": {
      "type": "string"
    },
    "new": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "reappeared": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "unavailable": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "unchanged": {
      "type": "integer",
      "minimum": 0
    },
    "duplicates": {
      "type": "integer",
      "minimum": 0
    },
    "warnings": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/ModelScanWarning"
      }
    },
    "nextScanAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "error": {
      "$ref": "#/$defs/ModelScanErrorInfo"
    }
  }
}
```

### `SecretBackend`

```json
{
  "type": "string",
  "enum": [
    "keyring",
    "file",
    "memory"
  ]
}
```

### `SecretMeta`

```json
{
  "description": "Experimental (1.5.0). A secret's name and timestamps; never its value (M2, ADR-005).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "backend",
    "createdAt",
    "updatedAt"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$"
    },
    "backend": {
      "$ref": "#/$defs/SecretBackend"
    },
    "createdAt": {
      "type": "string"
    },
    "updatedAt": {
      "type": "string"
    }
  }
}
```

### `SecretStatus`

```json
{
  "description": "Experimental (1.5.0). The secret store's state: `backend` is where values go now (`none` when neither the OS keyring nor the enabled encrypted file can serve), `degraded` is true whenever it is not the keyring (M2, ADR-005).",
  "x-stability": "experimental",
  "x-since": "1.5.0",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "backend",
    "degraded",
    "keyring",
    "file",
    "count",
    "activeLeases"
  ],
  "properties": {
    "backend": {
      "type": "string",
      "enum": [
        "keyring",
        "file",
        "memory",
        "none"
      ]
    },
    "degraded": {
      "type": "boolean"
    },
    "keyring": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "available"
      ],
      "properties": {
        "available": {
          "type": "boolean"
        },
        "reason": {
          "type": "string"
        }
      }
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled",
        "available"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "available": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "reason": {
          "type": "string"
        }
      }
    },
    "count": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    },
    "activeLeases": {
      "type": "integer",
      "minimum": 0
    },
    "remedy": {
      "type": "string"
    }
  }
}
```
