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

/** At most this many characters (Unicode code points) of free text per secret. */
export const MAX_DESCRIPTION_CHARS = 200;

export interface SecretMeta { name: string; backend: BackendKind; createdAt: string; updatedAt: string; updatedBy?: string; /** What the secret is for, in the owner's words (<= 200 characters); never a value. */ description?: string }

export type SecretErrorCode =
  | "denied" | "not-found" | "invalid-name" | "invalid-value" | "invalid-description" | "invalid-ttl"
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

/**
 * The description to store: trimmed; `undefined` means "not given" (the caller keeps whatever is stored), the empty string
 * clears it. Free text for the agent and the owner, so it holds no control characters (a newline would let it pose as
 * another line of a prompt or a log) and is at most 200 code points. `value` is the secret being written: a description
 * that contains it is refused (the usual slip is pasting the key into the wrong field), but only for values long enough
 * that a hit is not just a letter that happens to occur in prose.
 */
export function checkDescription(description: unknown, value?: string): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") throw new SecretError("invalid-description", "secret description must be a string");
  const text = description.trim();
  if ([...text].length > MAX_DESCRIPTION_CHARS) throw new SecretError("invalid-description", `secret description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) throw new SecretError("invalid-description", "secret description must be one line of plain text");
  if (value !== undefined && value.length >= 8 && text.includes(value)) throw new SecretError("invalid-description", "secret description must not contain the secret value");
  return text;
}

/** What a backend stores after a write: `given` replaces, `undefined` keeps `old`, an empty string removes it. */
export const nextDescription = (old: string | undefined, given: string | undefined): string | undefined => given === undefined ? old : given === "" ? undefined : given;

/** A backend's answer to "can you serve right now". `reason` is a short code, never a platform message. */
export interface BackendProbe { available: boolean; reason?: string }

export interface SecretBackend {
  readonly kind: BackendKind;
  probe(): Promise<BackendProbe>;
  /** The value, or null when the name is absent. Throws SecretError `corrupt`/`storage`/`backend-unavailable`. */
  get(name: string): Promise<string | null>;
  /** Creates or replaces; keeps `createdAt` of an existing entry, and its description unless one is given (an empty one clears it). */
  put(name: string, value: string, now: Date, updatedBy?: string, description?: string): Promise<SecretMeta>;
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
