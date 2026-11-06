// Real Core/router/dispatcher for the native CLI. Only the model and an optional future K tool are scripted.
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaults } from "@plur1bus/config-schema";
import { silentLogger } from "@plur1bus/module-api";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { LOCAL_OWNER } from "../../src/rbac/guard.ts";
import { CODING_INSTRUCTIONS } from "../../src/coding/profile.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { scriptedAdapter } from "../composition/helpers.ts";

const [home, root, mode] = process.argv.slice(2);
const config = defaults();
config.agents.worker = {};
config.engine = {
  neo: { enabled: false },
  gc: { enabled: false },
  obsidianBridge: { enabled: false },
  merging: { enabled: false },
  dreaming: { enabled: false },
  skillMiner: { enabled: false },
  temporalContext: { enabled: false },
  conversationReactivationRecall: { enabled: false },
  reranker: { enabled: false },
  duplicateThreshold: 1.01,
};
config.tools.sandbox.required = false;
writeFileSync(layout(home).configPath, JSON.stringify(config));
const wire = scriptedAdapter(
  ["approval", "attested"].includes(mode)
    ? [
        {
          calls: [
            {
              id: "blocked-exec",
              name: "exec.run",
              args: {
                program: process.execPath,
                args: ["-e", "require('node:fs').writeFileSync('must-not-run','bad')"],
                cwd: root,
              },
            },
          ],
        },
        { text: mode === "attested" ? "Approved fixture completed." : "approval-required" },
      ]
    : [
        { calls: [{ id: "read-calc", name: "file.read", args: { path: "calc.ts" } }] },
        {
          calls: [
            {
              id: "write-calc",
              name: "file.write",
              args: {
                path: "calc.ts",
                content: "export const add = (a: number, b: number) => a + b;\n",
                overwrite: true,
              },
            },
          ],
        },
        { text: "Calculation fixed. 🧩" },
        { calls: [{ id: "edit-config", name: "file.edit", args: { path: "settings.json" } }] },
        { text: "Configuration fixed." },
      ],
);
function containsCodingInstructions(value) {
  if (typeof value === "string") return value.includes(CODING_INSTRUCTIONS);
  if (Array.isArray(value)) return value.some(containsCodingInstructions);
  return value && typeof value === "object" ? Object.values(value).some(containsCodingInstructions) : false;
}
const connections = new Set();
let edits = 0;
let osConfirmations = 0;
const core = createCore({
  home,
  logger: silentLogger(),
  testInternals: flatTestInternals(),
  discovery: { scheduler: false },
  dreams: { scheduler: false },
  rbac: {
    resolve: (ctx) => {
      connections.add(ctx.connectionId);
      return LOCAL_OWNER;
    },
    // This is an explicit embedder test seam, never a claim that an RPC parameter verifies a real TTY.
    ...(mode === "attested" ? { attest: () => ({ kind: "cli", tty: true, osUserIsOwner: true }) } : {}),
  },
  ...(mode === "folder"
    ? {
        attestation: {
          attester: {
            probe: async () => ({ available: true, method: "touch-id" }),
            attest: async () => {
              osConfirmations++;
              return { ok: true, method: "touch-id", at: Date.now() };
            },
          },
        },
      }
    : {}),
  composition: {
    providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: wire.adapter }] } },
    tools: {
      roots: mode === "folder" ? [] : [{ id: "fixture", path: root }],
      exec: { mode: "allowlist", allowlist: [{ program: process.execPath }] },
      extra: [
        {
          name: "file.edit",
          description: "Fixture of K's future edit tool",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { const: "settings.json" } },
          },
          capability: "fs.write",
          effect: "local-write",
          risk: "low",
          classify: () => ({
            flags: { outsideRoots: false, denyListHit: false },
            targets: [join(root, "settings.json")],
            access: "write",
          }),
          execute: async () => {
            edits++;
            writeFileSync(join(root, "settings.json"), '{"enabled":true}\n');
            return {
              summary: "Enabled the fixture",
              value: {
                diff: '--- a/settings.json\n+++ b/settings.json\n-"enabled": false\n+"enabled": true\n',
                futureEnvelopeField: { preserved: true },
              },
            };
          },
        },
      ],
    },
  },
});
await core.start();
process.stdout.write('{"ready":true}\n');
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line !== "stats") {
    process.stdout.write('{"fixtureError":"unknown control"}\n');
    return;
  }
  const db = new DatabaseSync(join(home, "state", "sessions.sqlite"), { readOnly: true });
  try {
    process.stdout.write(
      JSON.stringify({
        connections: connections.size,
        requests: wire.requests.length,
        edits,
        osConfirmations,
        sessions: db.prepare("SELECT count(*) n FROM sessions").get().n,
        bindings: db.prepare("SELECT count(*) n FROM session_worktrees").get().n,
        codingInstructions: containsCodingInstructions(wire.requests),
        tools: wire.requests[0]?.tools?.map((tool) => tool.name) ?? [],
        calc: readFileSync(join(root, "calc.ts"), "utf8"),
        settings: readFileSync(join(root, "settings.json"), "utf8"),
      }) + "\n",
    );
  } finally {
    db.close();
  }
});
input.on("close", () => {
  void core.stop({ budgetMs: 5000 });
});
