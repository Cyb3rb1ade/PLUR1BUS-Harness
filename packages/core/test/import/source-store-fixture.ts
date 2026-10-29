/** Actual foreign Lance rows and a persisted ordinary model licence; no replacement Engine is used. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { sourceStoreModel } from "../../src/import/source-store-model.ts";
import { LicenceLedger } from "../../src/licences/ledger.ts";
import { memoryModel } from "../../src/licences/memory.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { lanceStore, NANO, write } from "./fixtures.ts";
import { useTempDirs } from "./helpers.ts";
import { CATALOG } from "../../src/import/catalog.ts";

const temp = useTempDirs();
export async function foreignStoreFixture(hot = 0, model = NANO) {
  const home = temp(); const root = temp();
  const config = defaults(); config.embedding.acceptedNcLicence = true;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const licence = memoryModel(NANO);
  const ledger = new LicenceLedger(join(home, "state", "model-licences.sqlite"), memoryAuditSink(), Date.now);
  ledger.confirm("owner", licence.model, licence.licence, licence.revision, "memory"); ledger.close();
  const base = join(root, "memory", "lancedb-namespaced");
  const dimensions = CATALOG[model]!.nativeDimensions!;
  await lanceStore(join(base, "alpha"), dimensions, 3, { agentId: "alpha", scope: "agent-private", status: "active",
    createdAt: 1_760_000_000_000, type: "memory", origin: "dm", category: "other", importance: 0.5,
    ownerUserId: "", summary: "", confirmed: false, updatedAt: 1_760_000_000_000 }, () => hot);
  write(join(base, "_schema.json"), '{"schemaVersion":"1"}');
  mkdirSync(join(root, "workspace"));
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace: "./workspace" }] }, plugins: { entries: {
      "memory-lancedb-namespaced": { enabled: true, config: { embedding: { provider: "local-transformers",
        local: { model, dimensions } } } } } } }));
  const registry = createSourceRegistry({ home });
  const owner = { userId: "owner", role: "owner" as const, kind: "person" as const };
  const detected = await registry.detect({ kind: "path", family: "openclaw", path: root }, owner);
  const source = await registry.get(detected.sourceId, owner);
  const candidate = sourceStoreModel(source.read.report, "agent:alpha");
  return { home, root, config, source, candidate, registry, detected };
}
