import { DesktopAttach } from "../identity/desktop-attach.ts";
import { apiPrincipal } from "@plur1bus/module-api";
import { buildRemoteDeviceServiceSurface } from "./remote-device-service-surface.ts";
import type { TrustNextEvent } from "../../../remote-access/src/trust-rollover.ts";
import { join } from "node:path";
import { DeviceError, DeviceStore, type DeviceStoreOptions } from "../../../remote-access/src/device-store.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";

function failure(error: unknown): never {
  if (error instanceof RpcError) throw error;
  if (error instanceof DeviceError) {
    const code = { invalid: "E_INVALID_PARAMS", "not-found": "E_NOT_FOUND", denied: "E_DENIED", revoked: "E_DENIED", conflict: "E_CONFLICT", storage: "E_STORAGE" } as const;
    throw new RpcError(code[error.code], error.message, { reason: `device-${error.code}` });
  }
  throw new RpcError("E_STORAGE", "device store unavailable", { reason: "device-storage" });
}

/** The central RBAC guard supplies the person and token-scope gate. Resource ownership is read from disk state,
 *  never from params, following identity-surface's second authorization gate. */
export function buildDeviceSurface(store: DeviceStore | (() => DeviceStore), revoked?: (userId:string) => void): Record<string, Handler> {
  const bind = (method: "list" | "revoke" | "rename"): Handler => async (params, ctx) => {
    const principal = authenticatedPrincipal(ctx);
    if (principal.kind !== "person") throw new RpcError("E_DENIED", "people only");
    try {
      const s = typeof store === "function" ? store() : store;
      const privileged = principal.role === "owner" || principal.role === "admin";
      if (method === "list") return { devices: s.list().filter(d => privileged || d.pairedBy === principal.userId) };
      const p = params as { id?: unknown; name?: unknown };
      if (typeof p?.id !== "string" || !/^dev_[a-f0-9-]{36}$/.test(p.id)) throw new DeviceError("invalid");
      const device = s.get(p.id);
      if (device.pairedBy !== principal.userId && (method === "rename" || !privileged)) throw new RpcError("E_DENIED", "own device required", { reason: "device-owner" });
      if (method === "revoke") { const result=s.revoke(p.id, principal.userId); revoked?.(device.pairedBy); return result; }
      if (typeof p.name !== "string") throw new DeviceError("invalid");
      return s.rename(p.id, p.name, principal.userId);
    } catch (error) { return failure(error); }
  };
  return { "device.list": bind("list"), "device.revoke": bind("revoke"), "device.rename": bind("rename") };
}

/** Lazy: a damaged store refuses device RPC without preventing the rest of the core from starting. */
export function createDeviceSurface(options: Omit<DeviceStoreOptions, "file"> & { state: string; signal?: AbortSignal; revoked?: (userId:string) => void; personVersion?: (id: string) => number | null; notifyTrust?: (event: TrustNextEvent, owners: string[]) => void }): Record<string, Handler> {
  let store: DeviceStore | undefined;
  const shared = () => store ??= new DeviceStore({ ...options, file: join(options.state, "devices.json") });
  let attach: DesktopAttach | undefined;
  const desktop = () => {
    if (options.signal?.aborted) throw new RpcError("E_NOT_AVAILABLE", "core stopping");
    return attach ??= new DesktopAttach({ file:join(options.state,"desktop-attach.db"), devices:shared(), now:options.clock, audit:options.audit, securePath:options.securePath, ...(options.personVersion ? {personVersion:options.personVersion} : {}) });
  };
  options.signal?.addEventListener("abort", () => { attach?.close(); attach=undefined; }, {once:true});
  const service = (fn: (p:any) => unknown): Handler => async (p,ctx) => {
    if (apiPrincipal(ctx) !== null) throw new RpcError("E_DENIED", "API service credential required");
    try { return fn(p); } catch(e) { return failure(e); }
  };
  return { ...buildDeviceSurface(shared,options.revoked), ...buildRemoteDeviceServiceSurface(shared,options.notifyTrust),
    "device.pair": async (p,ctx) => {
      const who=authenticatedPrincipal(ctx); if(who.kind!=="person") throw new RpcError("E_DENIED","people only");
      try { return desktop().issue(who.userId,(p as {kind:string}).kind); } catch(e) { return failure(e); }
    },
    "admin.api.desktop.redeem":service(p=>desktop().redeem(p.code,p.kind,p.name,p.publicKey)),
    "admin.api.desktop.token":service(p=>desktop().authenticate(p.token)),
    "admin.api.desktop.resolve":service(p=>desktop().resolve(p.deviceId)),
  };
}
