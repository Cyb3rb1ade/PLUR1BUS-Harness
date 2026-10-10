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
export function buildDeviceSurface(store: DeviceStore | (() => DeviceStore)): Record<string, Handler> {
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
      if (method === "revoke") return s.revoke(p.id, principal.userId);
      if (typeof p.name !== "string") throw new DeviceError("invalid");
      return s.rename(p.id, p.name, principal.userId);
    } catch (error) { return failure(error); }
  };
  return { "device.list": bind("list"), "device.revoke": bind("revoke"), "device.rename": bind("rename") };
}

/** Lazy: a damaged store refuses device RPC without preventing the rest of the core from starting. */
export function createDeviceSurface(options: Omit<DeviceStoreOptions, "file"> & { state: string }): Record<string, Handler> {
  let store: DeviceStore | undefined;
  return buildDeviceSurface(() => store ??= new DeviceStore({ ...options, file: join(options.state, "devices.json") }));
}
