# @plur1bus/webmcp

Platform-neutral mapping between PLUR1BUS RPC methods and browser WebMCP tools (spec D55). The M3 web
GUI uses it to expose selected RPC methods to browser agents; the browser bridge uses it to offer
page-registered tools to PLUR1BUS agents (D37, D39). It has no Node or DOM imports and no runtime
dependencies.

WebMCP is a W3C Web Machine Learning CG draft (https://webmachinelearning.github.io/webmcp/). This
package targets the Draft CG Report of 2026-09-26, where a page calls
`document.modelContext.registerTool(tool, { signal })` and unregisters a tool by aborting the
signal. It also supports the earlier shape that Chrome 146 ships behind a flag
(`navigator.modelContext`, `unregisterTool`, `provideContext`, and `execute(input, client)` with
`client.requestUserInteraction`). All handling of the two shapes is in `src/adapter.ts`.

## Public API

- Provider: `buildWebMcpTools` creates tools from RPC capabilities and schema;
  `getModelContext` detects browser support, and `registerPlur1busTools` registers the tools and
  returns an idempotent `unregister()` handle.
- Consumer: `pageToolsToMcp` maps page tools to MCP descriptors, `isOriginAllowed` checks origins
  against an allowlist, and `parseWebMcpToolName` parses a descriptor name.
- Adapter helpers: `normalizeExecuteContext` and `normalizePageToolResult` normalize the two browser
  API shapes and page-tool results.

## Provider (web GUI → browser agents)

```ts
import { SCHEMA } from "@plur1bus/rpc-schema";
import { buildWebMcpTools, getModelContext, registerPlur1busTools } from "@plur1bus/webmcp";

const tools = buildWebMcpTools({
  capabilities: hello.capabilities,        // core.auth handshake
  schema: SCHEMA,
  call: (method, params, o) => rpc.call(method, { ...params, caller }, o),  // authenticated client
  confirm: (tool, input) => gui.confirm(tool, input),                      // human approval
  bound: { agentId: currentAgent },        // optional: params the page fixes itself
  include: ["memory.forget"],              // optional: experimental methods to add
});
const reg = registerPlur1busTools(getModelContext(), tools); // no-op without WebMCP
// later: reg.unregister();
```

- One tool per method, named `plur1bus_<method>` with the dots replaced by `_`. The input schema
  is the method's params schema with `$ref`s inlined, and without `caller` or any `bound` params.
- By default the set contains the stable methods and the memory read ops. Experimental methods are
  added only through `include`. Authentication, lifecycle, supervisor, daemon, module, config and
  events methods are never exposed. Methods with `x-server` other than `core` are skipped.
- Human-only admin methods are never exposed either (B15, `docs/rbac.md`): `user.*`, `breakglass.*` and
  `device.*` by prefix; `agent.delete`, `agent.archive`, `agent.unarchive`, `agent.export`,
  `agent.rights.get|set`, `pairing.qr` and `session.list` by exact name. They change who may act for a
  person, or read other people's data (the owner-filtered session overview), and a browser agent has
  no business with either. `agent.pause` and `agent.resume` stay exposed: a person may trigger them
  through an assistant, and RBAC decides who may.
- `readOnlyHint` is true only for read methods. Every other tool waits for `confirm`, run inside
  `requestUserInteraction` when the browser offers it. Without `confirm` the tool refuses. A
  declined or failed confirmation returns `{"error":"E_DENIED","reason":"user-declined"}`.
- A result is returned as JSON text. Keys that look like secrets (`token`, `password`, `apiKey`, …)
  are removed first. An error becomes `isError: true` carrying only `{ error, reason }` (the code,
  plus the reason if it is slug-shaped); the message, detail and ids are dropped. A call cancelled
  through the WebMCP signal returns the local code `E_CANCELLED`.

## Consumer (web pages → PLUR1BUS agents)

- `pageToolsToMcp(origin, pageTools)` turns a page's tools into MCP tool descriptors named
  `webmcp:<origin>/<tool>`. The tool part is limited to `[A-Za-z0-9_.-]` and 128 characters. Each
  descriptor keeps the input schema (copied as plain data) and the `readOnlyHint`, and is always
  marked `untrustedContentHint`.
- `isOriginAllowed(origin, allowlist)` accepts exact origins and a `*.example.com` rule that
  matches strict https subdomains. Only https origins are allowed, except http on localhost.
- `normalizePageToolResult(value)` turns an `executeTool` return value (a JSON string in the
  current draft) into an MCP tool result.

The approval policy (D30) and output sanitising are applied by the bridge, not by this package.

## Scope and limits

- This package maps tool descriptions, schemas, annotations, and calls; it does not provide an RPC
  transport, authenticate callers, or authorize page origins.
- The bridge must check `isOriginAllowed` before offering page tools. It must also apply its own
  approval policy and sanitize results; the provider side should receive an authenticated RPC
  client and a human-confirmation callback for data-changing methods.
- Browser registration is feature-detected. Without a supported `ModelContext`, registration is a
  no-op; this package does not polyfill WebMCP.

## Test

```bash
pnpm gen   # once, for @plur1bus/rpc-schema's generated names
cd packages/webmcp && node ../../scripts/test-package.mjs
```
