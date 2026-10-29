/** C6 source values exist only in bounded private memory, tied to one Owner, immutable plan and preflight ticket. */
import { ImportError } from "./types.ts";
import sourceSecretNames from "./source-secret-names.json" with { type: "json" };
import { checkValue } from "../secrets/types.ts";

const MAX_VALUE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_LEASES = 4;
const MAX_TTL_MS = 300_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
// docs/import.md §5.6 plus the equivalent API-key names of the shipped chat/embedding/rerank providers.
const ALLOWLIST = new Set(sourceSecretNames);
const unavailable = () => new ImportError("E_NOT_AVAILABLE", "source-secret-unavailable",
  "Import source secret lease is unavailable");

export interface ImportSecretBinding {
  ownerId: string;
  planId: string;
  planSha256: string;
  preflightId: string;
}

export interface ImportSourceSecretPreparation extends ImportSecretBinding {
  expiresAt: number;
  /** Ownership transfers to prepare; input buffers are zeroed on success and failure. */
  entries: ReadonlyMap<string, Buffer>;
}

export function isImportSecretName(name: string): boolean {
  return ALLOWLIST.has(name);
}

function validBinding(binding: ImportSecretBinding): boolean {
  return typeof binding.ownerId === "string" && !!binding.ownerId && binding.ownerId.length <= 512
    && UUID.test(binding.planId) && UUID.test(binding.preflightId) && HASH.test(binding.planSha256);
}

/** Private fields are deliberately absent from JSON, Object.keys and util.inspect. Release is idempotent. */
class ImportSourceSecretLease {
  #values: Map<string, Buffer>;
  #expiresAt: number;
  #now: () => number;
  #timer: NodeJS.Timeout;
  #released = false;
  #onRelease: () => void;

  constructor(values: Map<string, Buffer>, expiresAt: number, now: () => number, onRelease: () => void) {
    this.#values = values;
    this.#expiresAt = expiresAt;
    this.#now = now;
    this.#onRelease = onRelease;
    this.#timer = setTimeout(() => this.release(), Math.max(0, expiresAt - now()));
    this.#timer.unref();
  }

  entries(): IterableIterator<[string, Buffer]> {
    if (this.#now() >= this.#expiresAt) this.release();
    return this.#values.entries();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    clearTimeout(this.#timer);
    for (const value of this.#values.values()) value.fill(0);
    this.#values.clear();
    this.#onRelease();
    this.#onRelease = () => {};
  }
}

export type ImportSecretLease = Pick<ImportSourceSecretLease, "entries" | "release">;

/** Called only after a trusted handler has proved a human Owner and completed preflight. It never writes a store. */
export function createImportSourceSecrets(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const prepared = new Map<string, { binding: ImportSecretBinding; lease: ImportSourceSecretLease }>();
  const active = new Set<ImportSourceSecretLease>();
  let closed = false;
  return {
    prepare(input: ImportSourceSecretPreparation): { prepared: true; count: number } {
      const copied = new Map<string, Buffer>();
      let accepted = false;
      try {
        if (closed || !validBinding(input) || !Number.isSafeInteger(input.expiresAt)
          || input.expiresAt <= now() || input.expiresAt > now() + MAX_TTL_MS
          || prepared.has(input.preflightId) || active.size >= MAX_LEASES || input.entries.size > ALLOWLIST.size) {
          throw unavailable();
        }
        let payload = 4096;
        for (const [name, value] of input.entries) {
          if (!isImportSecretName(name) || !Buffer.isBuffer(value) || value.length > MAX_VALUE_BYTES) throw unavailable();
          const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
          checkValue(text);
          payload += Buffer.byteLength(JSON.stringify(name)) + Buffer.byteLength(JSON.stringify(text)) + 2;
          if (payload > MAX_PAYLOAD_BYTES) throw unavailable();
          copied.set(name, Buffer.from(value));
        }
        const binding = { ownerId: input.ownerId, planId: input.planId, planSha256: input.planSha256,
          preflightId: input.preflightId };
        const lease = new ImportSourceSecretLease(copied, input.expiresAt, now, () => {
          active.delete(lease);
          if (prepared.get(input.preflightId)?.lease === lease) prepared.delete(input.preflightId);
        });
        active.add(lease);
        prepared.set(input.preflightId, { binding, lease });
        accepted = true;
        return { prepared: true, count: copied.size };
      } catch {
        throw unavailable();
      } finally {
        for (const value of input.entries.values()) if (Buffer.isBuffer(value)) value.fill(0);
        if (!accepted) for (const value of copied.values()) value.fill(0);
      }
    },
    take(binding: ImportSecretBinding): ImportSecretLease {
      if (closed || !validBinding(binding)) throw unavailable();
      const value = prepared.get(binding.preflightId);
      if (!value || JSON.stringify(value.binding) !== JSON.stringify({ ownerId: binding.ownerId, planId: binding.planId,
        planSha256: binding.planSha256, preflightId: binding.preflightId })) throw unavailable();
      // entries() performs expiry revocation even if an event-loop stall delayed the timer callback.
      value.lease.entries();
      if (!prepared.has(binding.preflightId)) throw unavailable();
      prepared.delete(binding.preflightId);
      return value.lease;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const lease of active) lease.release();
      prepared.clear();
      active.clear();
    },
  };
}

export type ImportSourceSecrets = ReturnType<typeof createImportSourceSecrets>;
