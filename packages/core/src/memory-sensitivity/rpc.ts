import { RpcError } from "../rpc/errors.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import type { MemorySensitivityService } from "./service.ts";
import { isSensitivityCategory, type SensitivityCategory } from "./types.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { mapMemoryOpError } from "../memory-ops.ts";
import type { AuditSink } from "../rbac/audit.ts";

export interface MemorySensitivityRpcDeps {
  service: MemorySensitivityService;
  isStopping?: () => boolean;
  engine?: { memory: { show: (id: string, principal: any, context?: any) => Promise<any> } };
  audit?: AuditSink;
  clock?: () => number;
}

export function buildMemorySensitivityMethods(deps: MemorySensitivityRpcDeps): Record<string, Handler> {
  const { service, isStopping, engine, audit, clock } = deps;

  const checkStopping = () => {
    if (isStopping?.()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
  };

  const verifyOwnership = async (id: string, ctx: CallContext): Promise<any> => {
    if (!engine?.memory?.show) return undefined;
    let principal: any;
    try {
      principal = authenticatedPrincipal(ctx);
    } catch {
      principal = (ctx as any)?.principal;
    }
    try {
      await engine.memory.show(id, principal, { origin: "user", background: false });
    } catch (e) {
      const mapped = mapMemoryOpError(e, { stopping: isStopping?.() ?? false });
      if (mapped) throw mapped;
      if (e instanceof RpcError) throw e;
      throw e;
    }
    return principal;
  };

  return {
    "memory.sensitivity.get": async (p: unknown, ctx: CallContext) => {
      checkStopping();
      if (!p || typeof p !== "object" || typeof (p as any).id !== "string" || !(p as any).id.trim()) {
        throw new RpcError("E_INVALID_PARAMS", "id is required", { reason: "missing-id" });
      }
      const id = (p as any).id.trim();
      await verifyOwnership(id, ctx);
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

    "memory.sensitivity.set": async (p: unknown, ctx: CallContext) => {
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
      const principal = await verifyOwnership(id, ctx);
      const categories = rawCategories as SensitivityCategory[];
      const updated = service.setSensitivity(id, categories);
      if (audit) {
        const user = principal?.userId || (ctx as any)?.principal?.userId || "anonymous";
        audit.append({
          at: clock ? clock() : Date.now(),
          actor: { user, host: "local" },
          action: "memory.sensitivity.set",
          target: id,
          detail: { categories: updated.categories, source: updated.source },
        });
      }
      return {
        id,
        categories: updated.categories,
        source: updated.source,
        updated: true as const,
      };
    },

    "memory.sensitivity.clear": async (p: unknown, ctx: CallContext) => {
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
      const principal = await verifyOwnership(id, ctx);
      const result = service.clearSensitivity(id, category);
      if (audit) {
        const user = principal?.userId || (ctx as any)?.principal?.userId || "anonymous";
        audit.append({
          at: clock ? clock() : Date.now(),
          actor: { user, host: "local" },
          action: "memory.sensitivity.clear",
          target: id,
          detail: { cleared: result.cleared, remaining: result.remaining, ...(category !== undefined ? { category } : {}) },
        });
      }
      return {
        id,
        cleared: result.cleared,
        remaining: result.remaining,
      };
    },
  };
}
