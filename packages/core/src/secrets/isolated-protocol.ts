import type { SecretErrorCode } from "./types.ts";

/** Private, inherited-process IPC only. Values never enter an argument, environment variable or diagnostic. */
export type BackendDescription = { kind: "keyring"; service: string } | { kind: "file"; dir: string };
export type BackendOperation = "probe" | "get" | "put" | "describe" | "delete" | "list" | "tombstones" | "clearTombstone";
export interface BackendRequest { id: number; backend: BackendDescription; operation: BackendOperation; args: unknown[] }
export interface BackendReply {
  id: number;
  value?: unknown;
  registrations: string[];
  error?: { code: SecretErrorCode; message: string; detail: Record<string, string | number | boolean> };
}
export const SECRET_ERROR_CODES: ReadonlySet<string> = new Set<SecretErrorCode>([
  "denied", "not-found", "invalid-name", "invalid-value", "invalid-description", "invalid-ttl", "no-backend",
  "backend-unavailable", "corrupt", "storage", "audit-unavailable", "lease-invalid",
]);
