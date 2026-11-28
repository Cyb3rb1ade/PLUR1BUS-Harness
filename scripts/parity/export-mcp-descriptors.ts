import { fileURLToPath } from "node:url";
import { systemClock } from "../../packages/core/src/mcp/clock.ts";
import { McpConnection } from "../../packages/core/src/mcp/connection.ts";
import { createRedactor } from "../../packages/core/src/mcp/redact.ts";
import { McpClientError } from "../../packages/core/src/mcp/errors.ts";
import { modernHandler, pipedModern } from "../../packages/core/test/mcp/helpers/dual-fixture.ts";
import { capturingLogger, stdioDef } from "../../packages/core/test/mcp/helpers/util.ts";
import { exporterMain } from "./lib.mjs";

const cases = [
  { name: "ordinary", label: "report.summary", titleUnits: 130, descriptionUnits: 8200 },
  { name: "display-controls", label: "report\u200b.summary", titleUnits: 10, descriptionUnits: 20,
    deviation: "P4D-244" },
  { name: "invalid-name", label: "report\t.summary", titleUnits: 4, descriptionUnits: 8 },
];

async function record(input: typeof cases[number]) {
  const descriptor = {
    name: input.label, title: "t".repeat(input.titleUnits),
    description: "d".repeat(input.descriptionUnits), inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://preview/summary" }, unused: "fixture" },
  };
  const peer = await pipedModern(rpc => {
    const reply = modernHandler(rpc);
    if (rpc.method === "tools/list") {
      const result = reply.result as Record<string, unknown>;
      result.tools = [descriptor];
    }
    return reply;
  });
  const connection = await McpConnection.open({
    def: stdioDef(), knownVersion: "2026-07-28", clock: systemClock, logger: capturingLogger(),
    redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {},
    transportFactory: () => peer.client,
  });
  try {
    const [tool] = await connection.listTools();
    if (!tool) throw new Error("missing descriptor");
    const { title, description, ...rest } = tool;
    return { input, observed: { ...rest, titleUnits: title?.length, descriptionUnits: description?.length } };
  } catch (error) {
    if (!(error instanceof McpClientError)) throw error;
    return { input, observed: { error: error.code } };
  } finally {
    await connection.close("graceful");
    await peer.close();
  }
}

export async function recordMcpDescriptors() {
  const recorded = [];
  for (const input of cases) recorded.push(await record(input));
  return { descriptors: { source: "packages/core/src/mcp/connection.ts", cases: recorded } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpDescriptors });
}
