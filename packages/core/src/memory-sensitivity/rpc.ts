import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import type { MemorySensitivityService } from "./service.ts";
import { isSensitivityCategory, type SensitivityCategory } from "./types.ts";

export interface MemorySensitivityRpcDeps {
  service: MemorySensitivityService;
  isStopping?: () => boolean;
}

export function buildMemorySensitivityMethods(deps: MemorySensitivityRpcDeps): Record<string, Handler> {
  const { service, isStopping } = deps;

  const checkStopping = () => {
    if (isStopping?.()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
  };

  return {
    "memory.sensitivity.get": async (p: unknown) => {
      checkStopping();
      if (!p || typeof p !== "object" || typeof (p as any).id !== "string" || !(p as any).id.trim()) {
        throw new RpcError("E_INVALID_PARAMS", "id is required", { reason: "missing-id" });
      }
      const id = (p as any).id.trim();
      const rec = service.getSensitivity(id);
      if (!rec) {
        return { id, categories: [] };
      }
      return {
        id,
        categories: rec.categories,
        source: rec.source,
        updatedAt: rec.updatedAt,
      };
    },

    "memory.sensitivity.set": async (p: unknown) => {
      checkStopping();
      if (!p || typeof p !== "object" || typeof (p as any).id !== "string" || !(p as any).id.trim()) {
        throw new RpcError("E_INVALID_PARAMS", "id is required", { reason: "missing-id" });
      }
      const id = (p as any).id.trim();
      const rawCategories = (p as any).categories;
      if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
        throw new RpcError("E_INVALID_PARAMS", "categories must be a non-empty array", { reason: "invalid-categories" });
      }
      for (const cat of rawCategories) {
        if (typeof cat !== "string" || !isSensitivityCategory(cat)) {
          throw new RpcError("E_INVALID_PARAMS", `unknown category: ${cat}`, { reason: "unknown-category" });
        }
      }
      const categories = rawCategories as SensitivityCategory[];
      const updated = service.setSensitivity(id, categories);
      return {
        id,
        categories: updated.categories,
        source: updated.source,
        updated: true as const,
      };
    },

    "memory.sensitivity.clear": async (p: unknown) => {
      checkStopping();
      if (!p || typeof p !== "object" || typeof (p as any).id !== "string" || !(p as any).id.trim()) {
        throw new RpcError("E_INVALID_PARAMS", "id is required", { reason: "missing-id" });
      }
      const id = (p as any).id.trim();
      const rawCategory = (p as any).category;
      let category: SensitivityCategory | undefined;
      if (rawCategory !== undefined && rawCategory !== null) {
        if (typeof rawCategory !== "string" || !isSensitivityCategory(rawCategory)) {
          throw new RpcError("E_INVALID_PARAMS", `unknown category: ${rawCategory}`, { reason: "unknown-category" });
        }
        category = rawCategory;
      }
      const result = service.clearSensitivity(id, category);
      return {
        id,
        cleared: result.cleared,
        remaining: result.remaining,
      };
    },
  };
}
