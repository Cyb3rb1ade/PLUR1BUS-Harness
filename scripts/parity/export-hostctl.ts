// Mode V for the TypeScript Hostctl contract. File outcomes come from a fresh fixture tree.
// Native desktop effects are never called. The Rust replay lives in the tools crate.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { createHostctl } from "../../packages/hostctl/src/index.ts";
import { configure, type ConfigInput } from "../../packages/hostctl/src/config.ts";
import { matchMany } from "../../packages/hostctl/src/search.ts";

export async function buildHostctl() {
  const host = createHostctl({ roots: [{ id: "fixture", path: tmpdir() }], audit() {} });
  const tools = host.definitions().map(d => ({
    name: d.name, capability: d.capability, effect: d.effect, risk: d.risk,
    properties: Object.keys(d.inputSchema.properties ?? {}).sort(),
    required: [...d.inputSchema.required as string[]].sort(),
    limits: d.limits,
  }));
  const config: ConfigInput[] = [
    {}, { enabled: false }, { shell: { allowed: true, default: "pwsh" } },
    { exec: { timeoutMs: 0 }, output: { maxBytes: 31 }, search: { maxResults: 0 } },
    { exec: { timeoutMs: 300001 }, output: { maxBytes: 1048577 }, search: { maxResults: 1001 } },
    { env: { allow: ["PATH", "TZ"] }, denyPatterns: ["example"], output: { maxBytes: 96 } },
    { exec: { timeoutMs: 2.5 }, search: { maxResults: 3.5 } },
  ];
  const literal = await Promise.all([
    { texts: ["a.b", "ab", "a-b", "x a.b y"], query: "a.b" },
    { texts: ["a\nb", "ab", "a\r\nb"], query: "\nb" },
    { texts: ["Ab", "aB", "ab", "\0ab"], query: "ab" },
  ].map(async ({ texts, query }) => ({
    texts, query, matches: await matchMany(texts, query, new AbortController().signal),
  })));
  await host.close();
  return { tools, config: config.map(input => ({ input, result: configure(input) })), literal, files: await fileCases() };
}

async function fileCases() {
  const root = await mkdtemp(join(tmpdir(), "hostctl-vectors-"));
  const host = createHostctl({ roots: [{ id: "fixture", path: root }], audit() {} });
  const context = { principal: "fixture-person", agentId: "fixture-agent", sessionId: "fixture-session", signal: new AbortController().signal };
  try {
    await writeFile(join(root, "note"), "alpha note");
    const cases = [
      ["fs.read", { path: "note", offset: 6, length: 4 }, ["content", "bytesRead", "truncated"]],
      ["fs.stat", { path: "note" }, ["type", "size"]],
      ["fs.list", { path: ".", depth: 0 }, ["entries", "truncated"]],
      ["fs.search", { path: ".", query: "alpha", mode: "content" }, ["matches", "truncated", "backend"]],
    ] as const;
    const result = [];
    for (const [operation, input, fields] of cases) {
      const name = `hostctl.${operation}`;
      const answer = await host.invoke(name, input, context);
      if (!answer.ok) throw Error(`Hostctl fixture ${name}: ${answer.error.code}`);
      const output = answer.value as Record<string, unknown>;
      result.push({ name, input, output: Object.fromEntries(fields.map(field => [field, output[field]])) });
    }
    return result;
  } finally {
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await exporterMain({ area: "host", build: async () => ({ hostctl: await buildHostctl() }) }));
}
