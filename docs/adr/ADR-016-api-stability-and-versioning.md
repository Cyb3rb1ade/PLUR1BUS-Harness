# ADR-016: API stability and versioning

**Status:** Accepted (2026-09-25, owner decision D26) · **Date:** 2026-09-25 · **Deciders:** Christian (owner) · **Inputs:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2 (D3, D14, D21, D25), §6.2 · ADR-012 (process model, RPC) · ADR-013 (configuration, migrations) · the engine's contract amendment policy (`types/engine.d.ts:23-31` in `openclaw-plur1bus-memory`).

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
