/** Core store previews may inspect scratch copies but must not carry the offline target mutation implementation. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { targetIdentity } from "../../src/import/identity.ts";
import { planHermesStore, planOpenclawStores } from "../../src/import/store-preview.ts";
import { prepareStoreAdopt } from "../../src/import/importers/hermes-stores.ts";
import { prepareOpenclawStores } from "../../src/import/importers/openclaw-stores.ts";
import type { StoreReport } from "../../src/import/types.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();

it("the Core source-store probe graph excludes offline store staging and commit implementations", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../src/import/source-store-transfer.ts", import.meta.url))],
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", write: false, metafile: true });
  const inputs = Object.keys(result.metafile!.inputs).map(path => path.replaceAll("\\", "/"));
  assert.deepEqual(inputs.filter(path => /\/import\/importers\/(?:openclaw|hermes)-stores\.ts$/.test(path)), [],
    "the live Core must reach only the read-only store planner and private scratch probe");
  const output = result.outputFiles![0]!.text;
  for (const marker of ["commitStoreAdopt", "commitOpenclawStores", "abortStoreAdopt", "lancedb.adopt-"]) {
    assert.equal(output.includes(marker), false, `Core store probe includes offline mutation ${marker}`);
  }
});

it("read-only store planners preserve legacy dry-run reports and ignore an ambient apply flag without target writes", async () => {
  const l = layout(temp());
  const source = temp();
  mkdirSync(join(source, "alpha"));
  writeFileSync(join(source, "alpha", "cards"), "source data stays unchanged");
  const probe = async () => ({ verdict: "ok" as const, identitySource: "probe" as const, schemaVersion: "1" });
  const hermes = { sourceStorePath: source, l, runId: "preview", probe, isApply: true };
  const plannedHermes = await planHermesStore(hermes);
  assert.deepEqual(plannedHermes, await prepareStoreAdopt({ ...hermes, isApply: false }));
  assert.equal(plannedHermes.stagingDir, undefined);
  const targetEmbedding = targetIdentity(l.home).embedding;
  const stores = [{ storeId: "agent:alpha", kind: "agent", agentId: "alpha", namespace: null,
    path: join(source, "alpha"), rows: 1,
    identity: { fields: targetEmbedding, plannedAction: "take-over", reasons: [] } }] as unknown as StoreReport[];
  const openclaw = { stores, storeRoot: { baseDbPath: source }, l, runId: "preview", onConflict: "skip" as const,
    targetConfig: {}, targetEmbedding, probe, isApply: true };
  const plannedOpenclaw = await planOpenclawStores(openclaw);
  assert.deepEqual(plannedOpenclaw, await prepareOpenclawStores({ ...openclaw, isApply: false }));
  assert.equal(plannedOpenclaw.adopt, undefined);
  assert.equal(plannedOpenclaw.stores[0]?.action, "preview-ok");
  assert.equal(existsSync(l.state), false, "a preview cannot stage, initialize, commit or abort target storage");
  assert.equal(readFileSync(join(source, "alpha", "cards"), "utf8"), "source data stays unchanged");
});
