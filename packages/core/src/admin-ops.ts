// Admin ops over RPC (B15, E2/E3 surface): the engine's AdminOps.obsidian, AdminOps.migrate and EmbeddingService.probe|
// serve, served by the core as `admin.*`. WebMCP never exposes them (D55: packages/webmcp FORBIDDEN_PREFIX).
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type {
  AdminEmbeddingProbeParams, AdminEmbeddingProbeResult, AdminEmbeddingServeParams, AdminEmbeddingServeResult, AdminMigrateParams, AdminMigrateResult,
  AdminObsidianConfirmParams, AdminObsidianConfirmResult, AdminObsidianDetectParams, AdminObsidianDetectResult, AdminObsidianPrepareParams,
  AdminObsidianPrepareResult, CallerIdentity, IpcAddress,
} from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { mapMemoryOpError, requireAgent } from "./memory-ops.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Handler } from "./rpc/server.ts";

export const ADMIN_METHODS = ["admin.obsidian.detect", "admin.obsidian.prepare", "admin.obsidian.confirm", "admin.migrate",
  "admin.embedding.probe", "admin.embedding.serve"] as const;
export type AdminMethod = (typeof ADMIN_METHODS)[number];

/** The embedding probe has no timeout of its own (engine contract): the core bounds it. */
export const PROBE_TIMEOUT_MS = 30_000;

export interface AdminOpDeps {
  engine: E.Engine; agents: AgentRegistry; logger: HarnessLogger; isStopping: () => boolean;
  /** After an applied migration, before the reply: the core refreshes `core.status.engine.storeSchema`. */
  onMigrated: () => void | Promise<void>;
  /** P17 (H3B-R17): the core's shutdown signal; the probe observes it next to its own timeout. */
  signal: AbortSignal;
}

const coreStopping = () => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

// The wire shapes are closed (rpc.schema.json): every engine object is projected onto exactly the schema's keys.
const projectAddress = (a: E.IpcAddress | null): IpcAddress | null => (a ? { kind: a.kind, address: a.address } : null);
const projectIdentity = (i: E.EmbeddingIdentity) => ({ fingerprintId: i.fingerprintId, provider: i.provider, model: i.model, dimensions: i.dimensions });

export function buildAdminMethods(d: AdminOpDeps): Record<AdminMethod, Handler> {
  /** The refusal of a stopping core, the engine call, and the MemoryOpError mapping every admin method shares. */
  function op<P, R>(method: AdminMethod, fn: (p: P) => Promise<R>): Handler {
    return async (p: P) => {
      if (d.isStopping()) throw coreStopping();
      try {
        return await fn(p);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        const mapped = mapMemoryOpError(e, { stopping: d.isStopping() });
        if (!mapped) throw e; // the server answers E_INTERNAL handler-threw
        d.logger.debug("admin op refused", { method, error: mapped.error, reason: mapped.reason });
        throw mapped;
      }
    };
  }

  /** Principal and agent context exactly as the memory ops; a write never reaches the engine with an inferred principal. */
  function principalFor(p: { caller: CallerIdentity; agentId: string }, write: boolean): E.Principal {
    const workspace = requireAgent(d.agents, p.agentId);
    const { principal, degraded } = callerToPrincipal(p.caller, p.agentId, workspace);
    if (degraded && write) throw new RpcError("E_DENIED", `caller identity is not valid (${degraded.detail ?? "identity"})`, { reason: "principal-invalid" });
    return principal;
  }

  const obsidian = () => d.engine.admin.obsidian;

  return {
    "admin.obsidian.detect": op("admin.obsidian.detect", async (p: AdminObsidianDetectParams): Promise<AdminObsidianDetectResult> => {
      const principal = principalFor(p, false);
      const r = p.candidates !== undefined
        ? await obsidian().detect(principal, AGENT_CONTEXT_CLI, { candidates: [...p.candidates] })
        : await obsidian().detect(principal, AGENT_CONTEXT_CLI);
      return { agentId: r.agentId, vaults: r.vaults.map((v) => ({ path: v.path, isVault: v.isVault, confirmed: v.confirmed, source: v.source })) };
    }),

    "admin.obsidian.prepare": op("admin.obsidian.prepare", async (p: AdminObsidianPrepareParams): Promise<AdminObsidianPrepareResult> => {
      const r = await obsidian().prepare(p.vaultPath, principalFor(p, true), AGENT_CONTEXT_CLI);
      return { nonce: r.nonce, expiresAt: r.expiresAt, vaultPath: r.vaultPath, vaultDigest: r.vaultDigest };
    }),

    "admin.obsidian.confirm": op("admin.obsidian.confirm", async (p: AdminObsidianConfirmParams): Promise<AdminObsidianConfirmResult> => {
      const r = await obsidian().confirm(p.nonce, principalFor(p, true), AGENT_CONTEXT_CLI);
      return { confirmed: true, vaultPath: r.vaultPath, vaultDigest: r.vaultDigest, alreadyConfirmed: r.alreadyConfirmed };
    }),

    "admin.migrate": op("admin.migrate", async (p: AdminMigrateParams): Promise<AdminMigrateResult> => {
      const r = await d.engine.admin.migrate(p.from, p.to);
      d.logger.info("store schema migration", { from: r.from, to: r.to, applied: r.applied });
      if (r.applied) {
        try { await d.onMigrated(); } catch (err) { d.logger.warn("store schema refresh after migration failed", { err }); }
      }
      return { from: r.from, to: r.to, applied: r.applied };
    }),

    "admin.embedding.probe": op("admin.embedding.probe", async (p: AdminEmbeddingProbeParams): Promise<AdminEmbeddingProbeResult> => {
      const signal = AbortSignal.any([d.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const r = await d.engine.embedding.probe({ signal, ...(p.refresh === true ? { refresh: true } : {}) });
      // The core's stop cut it short: that is the core going away, not the provider's answer.
      if (!r.ok && r.error === "aborted" && d.signal.aborted) throw coreStopping();
      return {
        ok: r.ok, ...(r.error !== undefined ? { error: r.error } : {}), cached: r.cached, identity: projectIdentity(r.identity),
        durationMs: r.durationMs, checkedAt: r.checkedAt,
      };
    }),

    "admin.embedding.serve": op("admin.embedding.serve", async (p: AdminEmbeddingServeParams): Promise<AdminEmbeddingServeResult> => {
      // Omitted → the engine's platform default; null → stop serving.
      const r = p.address === undefined ? await d.engine.embedding.serve() : await d.engine.embedding.serve(p.address === null ? null : { kind: p.address.kind, address: p.address.address });
      return {
        address: projectAddress(r.address), tokenPath: r.tokenPath,
        identity: r.identity ? { model: r.identity.model, dimensions: r.identity.dimensions, fingerprintId: r.identity.fingerprintId } : null,
      };
    }),
  };
}
