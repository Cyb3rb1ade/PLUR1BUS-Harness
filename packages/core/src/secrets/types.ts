// M2 secret store (ADR-005 §"Secret storage"). Nothing in this directory ever puts a secret value into a message, a log
// line, an audit detail or an error: values travel only as the return value of `reveal` and of a lease.

/** `[A-Za-z0-9]` first, then `[A-Za-z0-9._:/@-]`, at most 128 characters. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export const MAX_VALUE_BYTES = 64 * 1024;

export const isSecretName = (v: unknown): v is string => typeof v === "string" && NAME.test(v);

/** Who is asking. The RPC layer derives it from the connection (a client cannot supply it); `core` is the in-process
 *  engine lease path; `agent` is any agent-side caller. Anything that is not exactly `owner` or `core` is refused. */
export type SecretPrincipal =
  | { kind: "owner"; id?: string }
  | { kind: "core" }
  | { kind: "agent"; agentId?: string };

export type BackendKind = "keyring" | "file" | "memory";

export interface SecretMeta { name: string; backend: BackendKind; createdAt: string; updatedAt: string }

export type SecretErrorCode =
  | "denied" | "not-found" | "invalid-name" | "invalid-value" | "invalid-ttl"
  | "no-backend" | "backend-unavailable" | "corrupt" | "storage" | "audit-unavailable" | "lease-invalid";

/** Messages are fixed text built from codes and secret *names* only (a name is metadata, never a value). */
export class SecretError extends Error {
  readonly code: SecretErrorCode;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  constructor(code: SecretErrorCode, message: string, detail: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = "SecretError";
    this.code = code;
    this.detail = detail;
  }
}

export function checkName(name: unknown): string {
  if (!isSecretName(name)) throw new SecretError("invalid-name", "secret name must match [A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}");
  return name;
}

export function checkValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new SecretError("invalid-value", "secret value must be a non-empty string");
  if (value.includes("\u0000")) throw new SecretError("invalid-value", "secret value must not contain NUL");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new SecretError("invalid-value", `secret value exceeds ${MAX_VALUE_BYTES} bytes`);
  return value;
}

/** A backend's answer to "can you serve right now". `reason` is a short code, never a platform message. */
export interface BackendProbe { available: boolean; reason?: string }

export interface SecretBackend {
  readonly kind: BackendKind;
  probe(): Promise<BackendProbe>;
  /** The value, or null when the name is absent. Throws SecretError `corrupt`/`storage`/`backend-unavailable`. */
  get(name: string): Promise<string | null>;
  /** Creates or replaces; keeps `createdAt` of an existing entry. */
  put(name: string, value: string, now: Date): Promise<SecretMeta>;
  /** True when something was removed. */
  delete(name: string): Promise<boolean>;
  /** Names and metadata; never decrypts. */
  list(): Promise<SecretMeta[]>;
}

/** Reduces anything a backend or the OS threw to a code: platform messages are not forwarded. */
export function backendFailure(err: unknown, what: string): SecretError {
  if (err instanceof SecretError) return err;
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "error";
  return new SecretError("storage", `${what} failed (${code})`, { cause: code });
}
