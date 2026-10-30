/** A7: secret commits revoke local MCP authority immediately and queue native maintenance outside the store write. */
import { connect, readRecordedPid, readRunToken, supervisorAddress, supervisorPidPath,
  supervisorTokenPath } from "@plur1bus/module-api";
import type { SecretStore } from "../secrets/store.ts";

interface SecretChangeOptions {
  store: Pick<SecretStore, "onChange">;
  mcp(name: string): Promise<void>;
  native?(name: string): Promise<void>;
  deferred?(name: string): void;
  schedule?(run: () => void, delayMs: number): () => void;
}

/** One coalesced native callback per extension. Busy maintenance locks get eight bounded attempts. */
export function watchExtensionSecretChanges(options: SecretChangeOptions): { retryPending(): void; close(): void } {
  interface Pending { attempt: number; cancel?: () => void; generation: number }
  const pending = new Map<string, Pending>(), deferred = new Set<string>();
  let closed = false;
  const schedule = options.schedule ?? ((run, delayMs) => {
    const timer = setTimeout(run, delayMs); timer.unref();
    return () => clearTimeout(timer);
  });
  const enqueue = (name: string, entry: Pending) => {
    entry.cancel = schedule(() => {
      if (closed || pending.get(name) !== entry) return;
      delete entry.cancel;
      const generation = entry.generation;
      void options.native!(name).then(() => {
        if (!closed && pending.get(name) === entry && entry.generation !== generation) {
          entry.attempt = 0; enqueue(name, entry);
        }
        else pending.delete(name);
      }, error => {
        const busy = error?.error === "E_CONFLICT" && error?.reason === "busy";
        if (closed || pending.get(name) !== entry) return;
        if (entry.generation !== generation) { entry.attempt = 0; enqueue(name, entry); }
        else if (busy && ++entry.attempt < 8) enqueue(name, entry);
        else {
          pending.delete(name);
          if (busy || error?.error === "E_NOT_AVAILABLE" || error?.error === "E_CORE_UNAVAILABLE") {
            deferred.add(name);
            try { options.deferred?.(name); } catch { /* diagnostics cannot retain or restart a failed callback */ }
          }
        }
      });
    }, entry.attempt === 0 ? 0 : Math.min(5000, 250 * 2 ** (entry.attempt - 1)));
  };
  const request = (name: string) => {
    deferred.delete(name);
    const existing = pending.get(name);
    if (existing) { existing.generation++; return; }
    const entry = { attempt: 0, generation: 0 };
    pending.set(name, entry); enqueue(name, entry);
  };
  const unwatch = options.store.onChange(secret => {
    const match = /^ext:([a-z0-9][a-z0-9._-]{0,63}):[A-Za-z][A-Za-z0-9_]{0,63}$/.exec(secret);
    if (closed || !match) return;
    const name = match[1]!;
    void options.mcp(name).catch(() => { /* reconciliation reports its own degraded state */ });
    if (!options.native) return;
    request(name);
  });
  return { retryPending() { if (!closed) for (const name of [...deferred]) request(name); }, close() {
    closed = true; unwatch();
    for (const entry of pending.values()) entry.cancel?.();
    pending.clear();
    deferred.clear();
  } };
}

/** Uses only the actual private supervisor credential; no browser principal or extension input can delegate it. */
export async function reconcileNativeExtension(home: string, name: string): Promise<void> {
  const token = readRunToken(home, supervisorTokenPath(home));
  const pid = readRecordedPid(supervisorPidPath(home));
  const client = await connect({ address: supervisorAddress(home), token, endpoint: "supervisor",
    connectTimeoutMs: 1000, callTimeoutMs: 5000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
  try { await client.call("admin.extensions.runtime.reconcile", { name }); }
  finally { await client.close(); }
}
