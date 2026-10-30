/** Selected-store preflight recognizes pinned local candidates and binds both models to cache/licence proof. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../../src/import/catalog.ts";
import { assembleIdentity, compareIdentity, type IdentityField } from "../../src/import/identity.ts";
import { SOURCE_CATALOG, type SourceReport, type StoreReport } from "../../src/import/types.ts";
import { LicenceLedger } from "../../src/licences/ledger.ts";
import { memoryModel } from "../../src/licences/memory.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";

const E5 = "intfloat/multilingual-e5-small";
const JINA = "jinaai/jina-embeddings-v3";
const NANO = "jinaai/jina-embeddings-v5-text-nano-retrieval";
type Report = Pick<SourceReport, "sourceType" | "plur1bus">;
async function api() {
  const module = await import("../../src/import/source-store-model.ts").catch(() => undefined);
  assert.equal(typeof module?.sourceStoreModel, "function", "selected-store identity must be checked before maintenance");
  assert.equal(typeof module?.assertStoreModelsAvailable, "function", "source and target need independent cache/licence proof");
  return module!;
}
function report(model = E5, pinned = false): Report {
  const profile = CATALOG[model]!;
  const { fields } = assembleIdentity({ config: { provider: "local-transformers", local: {
    model, dimensions: profile.nativeDimensions } }, cache: [], vectorDimension: profile.nativeDimensions!,
  dimensionClaims: [], ...(pinned ? { modelCache: { revisions: [profile.revision],
    quantization: profile.quantization } } : {}) });
  const store: StoreReport = { storeId: "agent:main", kind: "agent", agentId: "main", namespace: null,
    path: "/sealed/source/lancedb/main", rows: 3, identity: { fields, distinctIdentities: pinned ? 1 : 0,
      evidence: [], comparison: compareIdentity(fields, fields), plannedAction: "take-over", reasons: [] } };
  return { sourceType: SOURCE_CATALOG[0]!.id, plur1bus: { installed: true, plugin: null, embeddingCache: null,
    reembedding: null, storeRoot: { present: true, baseDbPath: "/sealed/source/lancedb",
      activeRoot: "/sealed/source/lancedb", layout: "legacy-flat", activeGeneration: null, namespace: null },
    stores: [store] } };
}
const unsupported = { code: "E_NOT_AVAILABLE", reason: "source-store-identity-unsupported" };

it("recognizes legacy local-model candidates without inventing unknown metadata or authorizing adoption", async () => {
  const { sourceStoreModel } = await api();
  for (const model of [E5, JINA, NANO]) {
    for (const pinned of [false, true]) {
      const source = report(model, pinned);
      const before = structuredClone(source);
      assert.deepEqual(sourceStoreModel(source, "agent:main"), {
        model, dimensions: CATALOG[model]!.nativeDimensions, storeId: "agent:main", agentId: "main",
      });
      assert.deepEqual(source, before, "candidate extraction never rewrites source evidence");
    }
  }
});

it("refuses explicit foreign pipeline conflicts, unknown providers/models and non-vector dimensions", async () => {
  const { sourceStoreModel } = await api();
  const conflicts: [IdentityField, unknown][] = [
    ["provider", "remote-provider"], ["model", "https://private.invalid/model"], ["model", "constructor"],
    ["model", "woxpas-ai/bge-reranker-v2-m3-onnx"],
    ["revision", "different-revision"], ["artefactHash", "sha256:" + "a".repeat(64)],
    ["quantization", "q8"], ["dimension", 768], ["prefixSchema", { query: "wrong", passage: "passage: " }],
    ["normalization", { pooling: "mean", normalize: false }], ["tokenCap", 128],
    ["endpoint", "https://private.invalid/resource"],
  ];
  for (const [field, value] of conflicts) {
    const source = report(E5, true);
    source.plur1bus.stores[0]!.identity.fields[field] = { source: "store-metadata", value };
    assert.throws(() => sourceStoreModel(source, "agent:main"), unsupported, field);
  }
  for (const field of ["provider", "model", "dimension"] as const) {
    const source = report();
    source.plur1bus.stores[0]!.identity.fields[field] = { source: "unknown", value: null };
    assert.throws(() => sourceStoreModel(source, "agent:main"), unsupported, field);
  }
  const claimed = report();
  claimed.plur1bus.stores[0]!.identity.fields.dimension.source = "config";
  assert.throws(() => sourceStoreModel(claimed, "agent:main"), unsupported);
});

it("refuses mixed identities and ambiguous or nonflat store selections without exposing paths", async () => {
  const { sourceStoreModel } = await api();
  const changes: ((value: Report) => void)[] = [
    value => { value.plur1bus.stores[0]!.identity.distinctIdentities = 2; },
    value => { value.plur1bus.stores[0]!.identity.reasons.push("dimension-conflict"); },
    value => { value.plur1bus.stores[0]!.kind = "shared"; },
    value => { value.plur1bus.stores[0]!.namespace = "foreign"; },
    value => { value.plur1bus.stores[0]!.path = "/private/mismatched-store"; },
    value => { value.plur1bus.storeRoot!.layout = "named"; },
    value => { value.plur1bus.storeRoot!.present = false; },
    value => { value.plur1bus.storeRoot!.activeGeneration = "generation-one"; },
    value => { value.plur1bus.stores.push(structuredClone(value.plur1bus.stores[0]!)); },
    value => { value.plur1bus.stores = []; },
  ];
  for (const change of changes) {
    const source = report();
    change(source);
    assert.throws(() => sourceStoreModel(source, "agent:main"), error => {
      assert.deepEqual({ code: (error as { code: string }).code, reason: (error as { reason: string }).reason }, unsupported);
      assert.ok(!String(error).includes("/private/") && !String(error).includes("/sealed/"));
      return true;
    });
  }
});

it("binds flat Windows paths to the selected agent and refuses missing schema evidence or an unknown source family", async () => {
  const { sourceStoreModel } = await api();
  const source = report();
  source.plur1bus.storeRoot!.baseDbPath = "C:\\sealed\\lancedb";
  source.plur1bus.storeRoot!.activeRoot = "C:\\sealed\\lancedb";
  source.plur1bus.stores[0]!.path = "C:\\sealed\\lancedb\\main";
  assert.equal(sourceStoreModel(source, "agent:main").model, E5);
  const missing = report();
  Reflect.deleteProperty(missing.plur1bus.stores[0]!.identity.fields, "dimension");
  assert.throws(() => sourceStoreModel(missing, "agent:main"), unsupported);
  const unknown = { ...report(), sourceType: "not-in-the-source-catalog" } as unknown as Report;
  assert.throws(() => sourceStoreModel(unknown, "agent:main"), unsupported);
});

it("requires cached artifacts for both source and target before accepting the preflight", async () => {
  const { sourceStoreModel, assertStoreModelsAvailable } = await api();
  const source = sourceStoreModel(report(), "agent:main");
  for (const missing of [E5, NANO]) {
    const calls: string[] = [];
    await assert.rejects(assertStoreModelsAvailable(source, { model: NANO }, async model => {
      calls.push(model); return { present: model !== missing, licenceAccepted: true };
    }), { code: "E_NOT_AVAILABLE", reason: "embedding-model-unavailable" });
    assert.deepEqual(calls.sort(), [E5, NANO].sort());
  }
  let calls = 0;
  await assert.rejects(assertStoreModelsAvailable(source, { model: "https://private.invalid/model" }, async () => {
    calls++; return { present: true, licenceAccepted: true };
  }), { code: "E_NOT_AVAILABLE", reason: "embedding-model-unavailable" });
  assert.equal(calls, 0, "an unknown model never reaches even the cache-status port");
});

it("does not borrow another person's licence or validate only the requested target model", async () => {
  const { sourceStoreModel, assertStoreModelsAvailable } = await api();
  const source = sourceStoreModel(report(JINA), "agent:main");
  const ledger = new LicenceLedger(":memory:", memoryAuditSink(), () => 1000);
  const status = (person: string) => async (model: string, licenceId?: string) => {
    const selection = memoryModel(model);
    return { present: true, licenceAccepted: (licenceId === undefined || licenceId === selection.licence)
      && ledger.has(person, selection.model, selection.licence, selection.revision) };
  };
  const confirm = (person: string, model: string) => {
    const selection = memoryModel(model);
    ledger.confirm(person, selection.model, selection.licence, selection.revision, "memory");
  };
  try {
    confirm("other-person", JINA); confirm("other-person", NANO);
    await assert.rejects(assertStoreModelsAvailable(source, { model: NANO }, status("owner")),
      { code: "E_DENIED", reason: "model-licence-required" });
    confirm("owner", NANO);
    await assert.rejects(assertStoreModelsAvailable(source, { model: NANO }, status("owner")),
      { code: "E_DENIED", reason: "model-licence-required" });
    confirm("owner", JINA);
    await assertStoreModelsAvailable(source, { model: NANO, licenceId: memoryModel(NANO).licence }, status("owner"));
    await assert.rejects(assertStoreModelsAvailable(source, { model: NANO, licenceId: "unconfirmed" }, status("owner")),
      { code: "E_DENIED", reason: "model-licence-required" });
  } finally { ledger.close(); }
});

it("deduplicates the same cached model without discarding the target licence constraint and hides backend errors", async () => {
  const { sourceStoreModel, assertStoreModelsAvailable } = await api();
  const source = sourceStoreModel(report(JINA), "agent:main");
  const calls: unknown[] = [];
  await assertStoreModelsAvailable(source, { model: JINA, licenceId: "explicit-selection" }, async (model, licence) => {
    calls.push([model, licence]); return { present: true, licenceAccepted: true };
  });
  assert.deepEqual(calls, [[JINA, "explicit-selection"]]);
  await assert.rejects(assertStoreModelsAvailable(source, { model: NANO }, async () => {
    throw Error("PRIVATE-CACHE-PATH-MUST-NOT-ESCAPE");
  }), error => {
    assert.equal((error as { reason: string }).reason, "embedding-model-unavailable");
    assert.ok(!String(error).includes("PRIVATE-CACHE-PATH"));
    return true;
  });
});
