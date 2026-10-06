# M1b-2b: MCP client transport and ADR-014 — plan

**Goal.** 2b groundwork (milestones §M1, D17, D19): write ADR-014 (MCP host adapter, trust-routing provenance, status
*Proposed*) and build the MCP **client** in `packages/core/src/mcp/` on `@modelcontextprotocol/sdk` (exact pin), with
stdio and Streamable HTTP, a per-scope server registry, an idle manager, a tool-schema cache, the D19 provenance
envelope, and AbortSignal/timeouts. It is **not** wired into a turn loop (2c/D106); the only outside surface is a
`McpRegistry.list`/`status` introspection. **RULING:** the `mcp.list` / `mcp.status` RPC pair is *not* built here: it needs an RPC 1.6.0 bump across generated types, fixtures and Rust version assertions in files other sessions change too, so it does not "fit cleanly"; it is specified in ADR-014 §7 and left for the 2c wiring or its own change.

**Not in scope.** Turn-loop integration, per-tool approval (D109), OAuth for remote servers (D67), the MCP server
side (M6), MCP Apps rendering (M3), the `mcp-server` extension kind (X2), a CLI command. Each is named in ADR-014 so the
interfaces fit.

## Files

| Path | Purpose |
|---|---|
| `docs/adr/ADR-014-mcp-host-adapter.md` | The decision record (Proposed). |
| `packages/core/src/mcp/types.ts` | Config, scope, status, result and error types. |
| `packages/core/src/mcp/errors.ts` | `McpClientError` with a closed code vocabulary. |
| `packages/core/src/mcp/config.ts` | Validation of a server definition: command allowlist, URL rules, scope. |
| `packages/core/src/mcp/redact.ts` | Secret redaction for stderr, errors and log fields. |
| `packages/core/src/mcp/env.ts` | Child environment: declared keys only, never logged by value. |
| `packages/core/src/mcp/provenance.ts` | D19 envelope and the result wrapper. |
| `packages/core/src/mcp/clock.ts` | Injectable clock (timers) so idle tests need no sleeps. |
| `packages/core/src/mcp/schema-cache.ts` | Tool-schema cache that outlives the process. |
| `packages/core/src/mcp/connection.ts` | One server: connect, list, call, close, kill; stderr capture; timeouts. |
| `packages/core/src/mcp/registry.ts` | Servers per scope, lazy start, idle manager, status. |
| `packages/core/test/mcp/**` | Fixture server (stdio + HTTP) and one test file per unit. |
| `patches/`, `pnpm-workspace.yaml` | A two-line pnpm patch of `eventsource-parser`'s `source` export condition (see the PR). |

## Tasks (test first, one commit each)

1. Plan (this file). 2. Dependency pin + lockfile. 3. ADR-014.
4. Types, errors, config validation, redaction, env, provenance (unit tests).
5. Fixture MCP server (stdio + HTTP) and the connection (list + call over both transports).
6. Negative-capability test on the handshake; Sampling/Roots requests from the server are refused.
7. Schema cache + idle manager + registry on a fake clock.
8. Timeouts, abort, hung server → process reaped.
9. Secret-leak marker test.
10. ~~RPC `mcp.list`/`mcp.status`, config block~~ deferred (see Goal).

## Acceptance → test

| Acceptance | Test |
|---|---|
| A fixture tool is listed and called over both transports | `test/mcp/connection.test.ts`, `registry.test.ts` |
| Sampling/Roots/Logging are not negotiated | `test/mcp/capabilities.test.ts` |
| Provenance envelope attached to results | `test/mcp/provenance.test.ts`, `connection.test.ts` |
| Idle timeout stops the server, schema cache survives (fake clock) | `test/mcp/registry.test.ts` |
| Hanging server → timeout, process cleaned up, no zombie | `test/mcp/timeouts.test.ts` |
| stderr/env leak no secrets into logs | `test/mcp/secrets.test.ts` |
| Introspection (`list`/`status`) never starts a server | `test/mcp/registry.test.ts` |

## Rulings

Taken as `// RULING:` in code and listed in the PR; fail closed where the documents are silent.
