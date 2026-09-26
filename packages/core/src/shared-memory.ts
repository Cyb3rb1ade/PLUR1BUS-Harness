import type { SharedMemoryStatus } from "@plur1bus/rpc-schema";

/**
 * Whether explicit shared memory (workspace/user copies, D31 proposals) is available on this
 * platform (E4). It projects `EngineStatus.sharedMemory` onto the closed `$defs/SharedMemoryStatus`
 * wire shape, dropping anything the engine adds that the schema does not carry. `null` when the
 * engine has not reported it yet (no cached `EngineStatus`, or an older engine without the field).
 */
export function sharedMemoryStatus(es: unknown): SharedMemoryStatus | null {
  if (!es || typeof es !== "object") return null;
  const s = (es as { sharedMemory?: unknown }).sharedMemory;
  if (!s || typeof s !== "object") return null;
  const supported = (s as { supported?: unknown }).supported;
  const mode = (s as { mode?: unknown }).mode;
  if (typeof supported !== "boolean") return null;
  if (mode !== "fd-capability" && mode !== "verified-path" && mode !== "unavailable") return null;
  const reason = (s as { reason?: unknown }).reason;
  return { supported, mode, ...(typeof reason === "string" ? { reason } : {}) };
}
