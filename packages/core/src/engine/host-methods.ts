import type { HostServices, LlmParams, LlmResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError, type Handler } from "@plur1bus/module-api";
import type { Egress } from "../egress/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import { createEngineSecrets } from "../engine-host-ports.ts";
import { isEngineContext } from "./engine-principal.ts";

export interface HostMethodDependencies {
  host: Pick<HostServices, "workspaceDir" | "events" | "capabilities">;
  egress: Pick<Egress, "decide">;
  secrets: SecretStore;
  /** Core composition supplies its provider router, budget admission and D109 policy path. */
  complete?: (params: LlmParams) => Promise<LlmResult>;
}

/** Reverse RPC uses the same services as the Node adapter, including audited, promptly revoked secret leases. */
export function createHostMethods(deps: HostMethodDependencies): Record<string, Handler> {
  const secrets = createEngineSecrets(deps.secrets);
  return {
    "host.llm.complete": async ({ params }, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      if (!deps.complete) throw new RpcError("E_NOT_AVAILABLE", "engine LLM service is unavailable", { reason: "llm-unavailable" });
      return deps.complete({ ...params, signal: ctx.signal });
    },
    "host.egress.decide": async ({ scheme, host, port }, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      // A target is an origin tuple, never a URL with credentials, a path or a fragment smuggled into its host.
      if (!["http", "https"].includes(scheme) || typeof host !== "string" || /[\s/@?#%\\]/u.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new RpcError("E_INVALID_PARAMS", "invalid engine egress target", { reason: "invalid-target" });
      const name = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return deps.egress.decide(`${scheme}://${name}:${port}/`);
    },
    "host.secret.get": async ({ name }, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      return { value: await secrets.resolve(name, "memory-engine") };
    },
    "host.workspaceDir": async ({ agentId }, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      return { path: await deps.host.workspaceDir(agentId) ?? null };
    },
    "host.event": async ({ name, payload }, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      deps.host.events?.emit(name, payload);
      return {};
    },
    "host.journalBacklog": async (_params, ctx) => {
      if (!isEngineContext(ctx)) throw new RpcError("E_DENIED", "engine principal required", { reason: "engine-principal-required" });
      return await deps.host.capabilities?.journalBacklog?.() ?? null;
    },
  };
}

/** Register before constructing the server; it snapshots its method map when the Core wraps it with tracing. */
export function registerHostMethods(methods: Record<string, Handler>, deps: HostMethodDependencies): void {
  Object.assign(methods, createHostMethods(deps));
}
