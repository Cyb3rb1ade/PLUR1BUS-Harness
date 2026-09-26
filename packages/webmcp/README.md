# @plur1bus/webmcp

WebMCP mapping in both directions (spec D55). Platform-neutral: no Node or DOM imports, no runtime
dependencies. The M3 web GUI and the browser bridge (D37, D39) both use it.

WebMCP is a W3C Web Machine Learning CG draft (https://webmachinelearning.github.io/webmcp/). This
package targets the Draft CG Report of 2026-09-26, where a page calls
`document.modelContext.registerTool(tool, { signal })` and unregisters a tool by aborting the
signal. It also supports the earlier shape that Chrome 146 ships behind a flag
(`navigator.modelContext`, `unregisterTool`, `provideContext`, and `execute(input, client)` with
`client.requestUserInteraction`). All handling of the two shapes is in `src/adapter.ts`.

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

## Test

```bash
pnpm gen   # once, for @plur1bus/rpc-schema's generated names
cd packages/webmcp && node ../../scripts/test-package.mjs
```
