# MCP client

The in-process client is exported from `packages/core/src/mcp/index.ts`. It supports
both MCP **2026-07-28** (modern, stateless) and **2025-11-25** (legacy, initialized),
with older legacy revisions negotiated by the pinned official SDK. The supported
revision list is `SUPPORTED_MCP_VERSIONS`. No protocol version is invented or sent
as a list: modern discovery returns `supportedVersions`, while legacy initialize
sends one preferred `protocolVersion` and validates the server's selection.

References: [modern specification](https://modelcontextprotocol.io/specification/2026-07-28),
[modern versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[legacy specification](https://modelcontextprotocol.io/specification/2025-11-25).
The installed `@modelcontextprotocol/sdk@1.32.1` implements the legacy generation;
the modern adapter is implemented locally behind the same `McpProtocol` interface.
The SDK and lockfile are unchanged.

## S1: baseline inventory

This table records `origin/main` at **5685974e**, before this change (including #130).
Paths below are relative to `packages/core` unless prefixed with `docs/`.

| MCP feature (spec) | On main before this PR? | File / test evidence |
| --- | --- | --- |
| Modern `server/discover`, per-request metadata, result types | No | No modern adapter; `src/mcp/connection.ts` used the legacy SDK Client |
| Legacy initialize, version negotiation, initialized notification | Yes, SDK managed; negotiated revision not exposed | `src/mcp/connection.ts`; `test/mcp/capabilities.test.ts` |
| Ping; both capabilities stored/exposed | Partial: SDK stores server capabilities, no public access/ping | `src/mcp/connection.ts` |
| stdio framing, cwd, declared env, stderr redaction | Partial: SDK framing and minimal env; no explicit frame cap or subtree ownership | `src/mcp/env.ts`, `connection.ts`; `test/mcp/redact.test.ts`, `secrets.test.ts` |
| Streamable HTTP JSON/SSE/session/GET/DELETE | Partial: SDK managed; no egress pinning or resumability conformance | `src/mcp/connection.ts`; `test/mcp/connection.test.ts` |
| Tools list, pagination, list_changed, call/content/isError | Yes, bounded pagination/cache/provenance; output validation relied on SDK | `src/mcp/connection.ts`, `schema-cache.ts`, `provenance.ts`; `test/mcp/connection.test.ts`, `registry.test.ts` |
| Resources list/read/templates/subscribe/updated | No | No public resource methods/tests |
| Prompts list/get/list_changed | No | No public prompt methods/tests |
| Roots/sampling/elicitation ports | No; intentionally disabled | `test/mcp/capabilities.test.ts` tests negative capabilities |
| Request deadlines, caller cancellation, cleanup | Yes; no explicit progress port, modern cancellation or state events | `src/mcp/connection.ts`; `test/mcp/timeouts.test.ts` |
| Reconnect/backoff and configurable stdio restart | Partial: next use restarts; SDK handles HTTP SSE retries | `src/mcp/registry.ts`; `test/mcp/registry.test.ts` |
| Remote OAuth discovery, PKCE, secret bearer port | No; only static headers | `src/mcp/config.ts`, `connection.ts`; `test/mcp/secrets.test.ts` |
| Multiple scoped servers, lazy start, idle stop/cache | Yes; no aggregate resource/prompt view or prefixed tools | `src/mcp/registry.ts`; `test/mcp/registry.test.ts` |

## Configuration and ports

Registration remains lazy. Construct `McpRegistry` with a logger, the existing
`Egress` service, the existing core secret store when using `authSecret`, and
optional per-server `ports` / `auth` factories. This PR does not wire these into
`core.ts`, configuration schemas, a UI, or the turn loop.

```ts
const registry = new McpRegistry({
  logger,
  policy: { allowedCommands: ["/absolute/path/to/node"], idleTimeoutMs: 900_000 },
  egress, // existing service; every DNS/connect decision stays under its policy
  secrets, // existing store; auth uses short-lived core leases
  ports: server => hostPortsFor(server.name),
  auth: server => oauthProviderFor(server.name), // optional; no UI/provider adapter here
  onEvent: event => observeMcp(event),
});
registry.register({
  name: "docs",
  scope: { kind: "installation" }, // or { kind: "agent", agentId: "..." }
  transport: { type: "http", url: "https://mcp.example/mcp" },
  authSecret: "mcp/docs/bearer", // optional static bearer through secrets API
  timeouts: { connectMs: 30_000, listMs: 15_000, callMs: 60_000, closeGraceMs: 2_000 },
  reconnect: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5_000 },
});
```

For stdio use `{ type: "stdio", command, args: [...], cwd: "/absolute/workdir",
env: { ... }, fromHost: ["EXPLICIT_VARIABLE"] }`. No shell parses the argument
array. Commands must be allowlisted; loader/interpreter injection environment
variables are refused. Only the OS/SDK minimal environment allowlist and declared
variables reach the child. `fromHost` reads the supplied host environment, and all
copied values are treated as secret. Tokens belong in `authSecret` or an auth port,
not URLs. HTTP static headers remain available for existing callers.

A missing egress port admits only explicitly spelled loopback endpoints, for local
servers and offline tests. Remote targets fail closed. The HTTP adapter calls the
existing `egress.decide` and connects to its returned IP, retaining the hostname
for TLS verification. Redirects are never followed implicitly. OAuth discovery,
metadata requests and token exchange use the same guarded fetch path.

## Protocol selection and transports

A new server is first probed with modern `server/discover`. Modern requests carry
`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, and `clientInfo`
in `params._meta`. A legacy rejection (or a silent stdio probe timeout within the
connect deadline) falls back to the legacy handshake. Recognized modern errors
fail visibly when there is no compatible supported revision. A version rejection
advertising a supported legacy revision can select its legacy handshake.
The registry remembers and displays the selected `protocolVersion` per registered
server; a failed cached legacy assumption is re-probed once after an upgrade.
The connection exposes both sides' capabilities and server identity.

| Behavior | 2026-07-28 | 2025-11-25 / older legacy |
| --- | --- | --- |
| Setup | `server/discover` | `initialize`, `notifications/initialized` |
| Identity/capabilities | Per-request `_meta` and discovery | Initialize exchange |
| HTTP messages | POST JSON or request-scoped SSE | POST JSON/SSE, session header |
| Change notifications | POST `subscriptions/listen`, acknowledged filters, subscription IDs | GET SSE stream; list_changed / resources updated |
| SSE interruption | Fail this request; never automatically replay a tool mutation | SDK resumability with event IDs, `retry`, GET `Last-Event-ID` |
| Session shutdown | Close streams; no session/DELETE | DELETE session, then close |
| Ping API | Re-discover; never send removed `ping` | Wire `ping` |
| Client input | `input_required` → `inputResponses` and opaque `requestState` | Server-initiated JSON-RPC requests |
| Cancellation | stdio notification; HTTP stream abort | SDK cancellation notifications in both directions |
| Roots changes | Roots fetched at next input request | `notifications/roots/list_changed` |

Modern HTTP sends required `Mcp-Method`, `Mcp-Name` and annotated `Mcp-Param-*`
headers. Non-ASCII, control characters, surrounding whitespace and sentinel-like
values use the spec's UTF-8 Base64 sentinel. Invalid, duplicate or unreachable
`x-mcp-header` annotations exclude that tool; missing argument values omit headers.

stdio frames are newline-delimited UTF-8, bounded to **1 MiB** in each direction;
partial oversized frames, malformed messages and incomplete EOF fail closed.
stderr is a separate, redacted, length-capped and rate-limited log source.
Unix servers own a detached process group. Windows uses a suspended native launch
inside a kill-on-close Job Object through the OS PowerShell interop host; script
and batch commands are refused. Closing stdin allows graceful exit, then bounded
termination escalates; descendants are killed even if the direct child exits first.
The reported Windows process ID identifies the job-owning launcher.

## Features and host APIs

`McpConnection` and `McpRegistry` expose tools, resources, resource templates,
resource reads/subscriptions, prompt lists and prompt retrieval. Lists follow
pagination with page/item limits and reject repeated cursors. Tool success results
are validated against `outputSchema`; `isError` remains a normal result. Modern
structured content can be any JSON value. Tool results keep the D19 provenance
envelope; resource/prompt content and descriptors are redacted data as well.

`aggregate(caller)` fetches visible servers concurrently, returning tools with
collision-free `server::localTool` names, resources tagged with their server, and
prefixed prompts. One failed feature/server appears in `errors` without hiding
healthy results. Aggregate names are a future registry binding; call the existing
`callTool(server, localTool, args, caller)` API with the explicit server identity.
Agent-scoped servers remain invisible to other agents.

Modern cache `ttlMs` is honored for tool descriptors, including zero (no reuse).
Schemas survive an idle stop, but expire or become stale through a list_changed
notification or remote disconnect. Resources/prompts are fetched on demand.

`McpClientPorts` has optional `roots.list`, `sampling.createMessage`, and
`elicitation.create`. Each receives `{ server, signal }`. Without a port, no
capability is advertised and the feature is refused. Sampling context/tool-use
capabilities are not advertised; URL elicitation requires explicit `url: true`.
Port inputs/results are validated and deadlines bound even an implementation that
ignores cancellation. Modern input rounds are capped at eight and 32 input
requests per round. The opaque request state is echoed, never interpreted.

`callTool` also accepts `onProgress` at the connection boundary. State events use
`connecting`, `ready`, `degraded`, `failed`; registry notifications use `onEvent`.
Observers cannot crash the client. Modern change notifications require an
acknowledged, matching, opted-in subscription. Logging remains unnegotiated.

## Authorization

`McpAuthProvider` is resource-bound. `SecretBearerAuthProvider` reads a named
secret with `{ kind: "core" }`, uses the lease value, and immediately revokes the
lease. A configured `authSecret` requires a secrets port. No token is read from
an ambient environment variable.

`PkceAuthProvider` accepts a pre-registered public `clientId`, an exact
`redirectUri`, and an `authorize(URL, signal)` host port returning `{ code, state,
issuer? }`. On 401 the client parses `WWW-Authenticate`, discovers protected
resource metadata (RFC 9728) and authorization server metadata (RFC 8414 / OIDC),
validates resource/issuer binding, requires PKCE S256, verifies state and a present
issuer before redeeming the code, and sends the RFC 8707 `resource` parameter.
Token refresh retains issuer/resource binding. Concurrent challenges share one
authorization flow, and a request gets at most one authenticated retry.
Discovery never receives the MCP bearer token. Dynamic client registration,
confidential-client secrets and browser/callback/UI integration are not installed.

Known tokens, bearer values, environment secrets and OAuth verifier/code/state
values are registered for redaction. Ports' and HTTP errors are reduced to fixed
messages without raw causes; tokens are not logged or included in status. The
redactor cannot recover arbitrary transformations deliberately made by a server;
third-party results and stderr remain untrusted.

## Recovery, limits and verification

HTTP session 404 closes the failed connection; the next use initializes a new
session. An interrupted/mutating tool call is never automatically repeated.
HTTP SSE reconnection and modern subscription reopening use bounded backoff.
Registry HTTP transport restarts default to five attempts; stdio background
restart is opt-in through `reconnect` (default off). Successful application use
resets the restart budget. Shutdown/unregister cancel pending restarts and idle
work. Explicit next use can establish a fresh connection after a failure.

Offline fixtures exercise both generations through in-process stdio pipes and
loopback HTTP JSON/SSE. Spawned synthetic stdio fixtures additionally verify env,
cwd, deadlines and native descendant cleanup. No real tokens or external MCP
servers are used. `test/mcp/dual-conformance.test.ts` is the common feature matrix;
the auth, notifications, reconnect, HTTP legacy, robustness and stdio-hardening
suites cover failures and transport-specific rules.

Run with Node 24.21:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
  --test --test-concurrency=1 packages/core/test/mcp/*.test.ts
pnpm typecheck
pnpm lint
```

## ADR differences and follow-ups

ADR-014 stays **Proposed** and is unchanged. This owner-requested expansion differs
from §5 (explicit opt-in Roots/Sampling/Elicitation ports), §2 (configurable
background restart), and §7 (remote OAuth/egress pinning now implemented). ADR-008
and M6 exclude Roots/Sampling; those deprecated modern features remain disabled
by default and are offered only through explicit ports for compatibility.
The modern adapter also departs from SDK-only implementation because the pinned
and latest published SDK implements only the legacy revision.

Separate follow-ups: turn-loop/tool-registry integration; D109 policy/approval and
per-agent enable bindings; provider sampling adapter and usage budgeting;
elicitation UI/callback flows; core configuration/RPC bindings and schema changes;
MCP Apps renderer; persistent schema cache; official tasks/extensions; MCP server
exposure. This client PR changes none of those subsystems.
