import { fileURLToPath } from "node:url";
import { wrapToolResult } from "../../packages/core/src/mcp/provenance.ts";
import { createRedactor } from "../../packages/core/src/mcp/redact.ts";
import { exporterMain } from "./lib.mjs";

export async function recordMcpProvenance() {
  const cases = [
    { name: "untrusted-result", trust: "untrusted", maxBytes: 128, raw: {
      content: [{ type: "text", text: "Résumé" }], structuredContent: { count: 1 },
    } },
    { name: "partial-unicode-scalar", trust: "untrusted", maxBytes: 4, raw: {
      content: [{ type: "text", text: "ab🌿" }, { type: "text", text: "next" }],
      structuredContent: { count: 1 },
    } },
    { name: "redaction-and-truncation", trust: "operator-vetted", maxBytes: 11, raw: {
      content: [
        { type: "resource", resource: { uri: "test://example", text: "sample-marker" } },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ], isError: true,
    } },
    { name: "resource-blob", trust: "untrusted", maxBytes: 2, raw: {
      content: [{ type: "resource", resource: { uri: "test://example", blob: "AAAA" } }],
    } },
  ] as const;
  const caller = { agentId: "fixture-agent", principal: "fixture-person" };
  const redactor = createRedactor(["sample-marker"]);
  return {
    provenance: {
      source: "packages/core/src/mcp/provenance.ts", cases: cases.map(input => {
        const server = "fixture";
        const tool = "summary";
        const observed = wrapToolResult(input.raw, { server, tool, caller, trust: input.trust,
          redactor, maxBytes: input.maxBytes });
        return { input, observed };
      }),
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpProvenance });
}
