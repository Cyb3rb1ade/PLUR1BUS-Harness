/** GUI selectors receive factual source metadata and original safe mapping declarations only. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateResult } from "@plur1bus/rpc-schema";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { sourceAgentId } from "../../src/import/source-view.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
it("exposes actual source store IDs and safe original mapping paths without staging or credential paths", async () => {
  const home = temp();
  const root = temp();
  mkdirSync(join(root, "memory", "lancedb-namespaced", "alpha", "memories.lance"), { recursive: true });
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace: "/old/workspace" }, { id: "private", workspace: "/old/credentials/private" }] },
    plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { baseDbPath: "/old/store" } } } } }));
  const result = await createSourceRegistry({ home }).detect({ kind: "path", family: "openclaw", path: root },
    { kind: "person", role: "owner", userId: "owner" });
  assert.equal(validateResult("admin.import.detect", result).ok, true);
  assert.deepEqual(result.stores?.map(({ id, agentId, displayName, kind }) => ({ id, agentId, displayName, kind })),
    [{ id: "agent:alpha", agentId: sourceAgentId("openclaw", "alpha"), displayName: "alpha", kind: "agent" }]);
  assert.ok(result.portability?.unmapped.some(item => item.path === "/old/workspace" && item.kind === "workspace"
    && item.agentId === sourceAgentId("openclaw", "alpha")));
  assert.ok(result.portability?.unmapped.some(item => item.path === "/old/store" && item.kind === "store"));
  assert.ok(!JSON.stringify(result).includes("/old/credentials/private"));
  assert.ok(!JSON.stringify(result.stores).includes(root) && !JSON.stringify(result.stores).includes(home));
  assert.equal(validateResult("admin.import.detect", { ...result, stores: [{ ...result.stores![0], path: "/private/staging" }] }).ok, false);
});
