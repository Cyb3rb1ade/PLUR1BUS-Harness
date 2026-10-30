/** Live planning reuses the full importer's decisions without loading or receiving target mutation authority. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { previewImport } from "../../src/import/preview.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { resolveImportOptions } from "../../src/import/plan-options.ts";
import { fingerprintImportTarget } from "../../src/import/target-fingerprint.ts";
import { layout } from "../../src/paths.ts";
import { useTempDirs } from "./helpers.ts";
import type { SourceType } from "../../src/import/types.ts";
import type { AgentImportReport } from "../../src/import/importers/openclaw-agent-plan.ts";

const temp = useTempDirs();
const OWNER = { kind: "person" as const, role: "owner" as const, userId: "owner" };

for (const family of ["openclaw", "hermes"] as const) for (const conflict of ["skip", "rename", "replace"] as const) {
  it(`shares ${family} file-conflict and card-count decisions with the unchanged full dry-run (${conflict})`, async () => {
    const home = temp(), root = temp();
    const l = layout(home);
    const cfg = defaults();
    const agent = family === "openclaw" ? "main" : "default";
    cfg.agents[agent] = {};
    writeFileSync(l.configPath, JSON.stringify(cfg));
    const sourceWorkspace = family === "openclaw" ? join(root, "workspace") : root;
    mkdirSync(sourceWorkspace, { recursive: true });
    mkdirSync(join(sourceWorkspace, family === "openclaw" ? "memory" : "memories"));
    if (family === "openclaw") writeFileSync(join(root, "openclaw.json"), JSON.stringify({
      meta: { lastTouchedVersion: "2026.9.5" }, agents: { defaults: { workspace: "./workspace" } } }));
    else writeFileSync(join(root, "config.yaml"), "_config_version: 45\n");
    writeFileSync(join(sourceWorkspace, "SOUL.md"), "new source persona");
    writeFileSync(join(sourceWorkspace, family === "openclaw" ? "MEMORY.md" : "memories/MEMORY.md"), "card one\r\n§\r\ncard two");
    writeFileSync(join(sourceWorkspace, family === "openclaw" ? "USER.md" : "memories/USER.md"), "unbound user card");
    mkdirSync(l.workspaceDir(agent), { recursive: true });
    writeFileSync(join(l.workspaceDir(agent), "SOUL.md"), "existing target persona");
    const registry = createSourceRegistry({ home });
    const detected = await registry.detect({ kind: "path", family, path: root }, OWNER);
    const source = await registry.get(detected.sourceId, OWNER);
    const settings = { onConflict: conflict };
    const requests: { dryRun: boolean }[] = [];
    const config = { get: async () => ({ config: cfg, revision: "r" }), set: async (value: { dryRun: boolean }) => {
      requests.push(value); return { revision: "r" };
    } };
    const roots = [{ id: "agents", path: l.agents, kind: "directory" as const },
      { id: "state", path: l.state, kind: "directory" as const }];
    const before = await fingerprintImportTarget(home, roots);
    const planned = await previewImport({ home, source, settings, config });
    const common = { home, source: source.root, reader: source.reader, apply: false, onConflict: conflict,
      configPort: config, ...resolveImportOptions(source, settings) };
    const legacy = family === "openclaw" ? await importOpenclaw(common) : await importHermes(common);
    assert.equal(planned.sourceType, legacy.sourceType as SourceType);
    const project = (agents: readonly (AgentImportReport & { memory?: { totalCards: number } | undefined })[]) => agents.map(item => ({ sourceId: item.sourceId,
      harnessAgentId: item.harnessAgentId, action: item.action, files: item.files, counts: item.counts,
      totalCards: item.memory?.totalCards }));
    assert.deepEqual(project(planned.agents), project(legacy.agents));
    assert.deepEqual(planned.errors, legacy.errors);
    assert.equal(planned.agents[0]?.memory?.totalCards, 3);
    assert.equal(await fingerprintImportTarget(home, roots), before);
    assert.equal(readFileSync(join(l.workspaceDir(agent), "SOUL.md"), "utf8"), "existing target persona");
    assert.ok(requests.every(request => request.dryRun));
  });
}
