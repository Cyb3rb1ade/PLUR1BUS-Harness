import { RpcError } from "../rpc/errors.ts";
import type { LicenceLedger } from "./ledger.ts";
// Immutable artifact revisions from the pinned engine catalogue; no engine-private API is imported.
export const NC_MODELS = ["jinaai/jina-embeddings-v3", "jinaai/jina-embeddings-v5-text-nano", "jinaai/jina-embeddings-v5-text-nano-retrieval", "jinaai/jina-reranker-v2-base-multilingual"] as const;
export const NC_LICENCE = "CC BY-NC-4.0";
export function memoryModel(model: string): { model: string; licence: string; revision: string } {
  if (model === "jinaai/jina-embeddings-v5-text-nano") throw new RpcError("E_INVALID_PARAMS", "use the pinned Jina v5 retrieval model");
  if (!(NC_MODELS as readonly string[]).includes(model)) throw new RpcError("E_INVALID_PARAMS", "unknown non-commercial model");
  return { model, licence: NC_LICENCE, revision: model === NC_MODELS[0] ? "68ed94909d564380f954be27ae2e133214c1adc9" : model.includes("v5") ? "ac5d898c8d382b17167c33e5c8af644a3519b47d" : "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9" };
}
export function checkMemorySelection(ledger: LicenceLedger, who: string, changes: readonly { key: string; value: unknown }[], current?: unknown): void {
  const inspect = (v: unknown): void => {
    if (typeof v === "string" && (NC_MODELS as readonly string[]).includes(v)) { const m = memoryModel(v); if (!ledger.has(who,m.model,m.licence,m.revision)) throw new RpcError("E_DENIED", "model licence confirmation required", { reason: "model-licence-required" }); }
    else if (Array.isArray(v)) v.forEach(inspect);
    else if (v && typeof v === "object") Object.values(v).forEach(inspect);
  };
  for (const change of changes) if (/^(engine|embedding|memory|modelRoles|agents)(\.|$)/.test(change.key)) {
    inspect(change.value);
    assertMemoryConfiguration(change.value,ledger.list());
    if (change.key.endsWith(".revision") && current && typeof current === "object") {
      let parent: any = current;
      for (const part of change.key.split(".").slice(0,-1)) parent = parent && typeof parent === "object" && Object.hasOwn(parent,part) ? parent[part] : undefined;
      if (parent && typeof parent.model === "string" && (NC_MODELS as readonly string[]).includes(parent.model)) {
        inspect(parent.model); assertMemoryConfiguration({ ...parent, revision:change.value },ledger.list());
      }
    }
  }
}

export function assertMemoryConfiguration(value: unknown, acceptances: readonly import("./ledger.ts").LicenceAcceptance[]): void {
  const inspect = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string,unknown>;
    if (typeof o.model === "string" && (NC_MODELS as readonly string[]).includes(o.model)) {
      const m = memoryModel(o.model), revision = typeof o.revision === "string" ? o.revision : m.revision;
      if (revision !== m.revision || !acceptances.some(a => a.model === m.model && a.licence === m.licence && a.revision === revision)) throw new RpcError("E_DENIED", "selected model revision lacks persisted licence confirmation", { reason: "model-licence-required" });
    }
    Object.values(o).forEach(inspect);
  };
  inspect(value);
}
